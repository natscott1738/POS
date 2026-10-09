import { and, eq, sql } from 'drizzle-orm';
import {
  priceSale,
  sum,
  type CreateSaleInput,
  type PricingLineInput,
  type Permission,
} from '@pos/shared';
import type { FastifyRequest } from 'fastify';
import { db, type Tx } from '../../db/client.js';
import {
  sales,
  saleLines,
  payments,
  shifts,
  stores,
  customers,
  loyaltyTransactions,
  changeLog,
  mpesaTransactions,
  pdqTransactions,
} from '../../db/schema/index.js';
import { applyStockMovement } from '../inventory/service.js';
import { loadAuthoritativeVariants } from './pricing-guard.js';
import { nextReceiptNumber } from './receipt-number.js';
import { badRequest, conflict, forbidden, notFound, unbalancedSale } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { enqueueQbSync } from '../quickbooks/queue.js';

/** Cents of drift tolerated between a till's total and the server's recomputation. */
const REPRICE_TOLERANCE = 0;

export interface CreateSaleContext {
  request: FastifyRequest;
  cashierId: string;
  permissions: Set<Permission>;
  /** Set when this sale arrived through the offline sync endpoint. */
  offline?: boolean;
  overrideByUserId?: string | null;
}

export interface CreateSaleResult {
  saleId: string;
  receiptNumber: string;
  total: number;
  changeGiven: number;
  status: string;
  oversold: boolean;
  repriced: boolean;
  loyaltyPointsEarned: number;
}

/**
 * Creates a completed sale. Everything happens in one transaction: re-pricing,
 * tender balancing, stock decrement, loyalty and the QuickBooks enqueue. If any
 * step fails the whole sale rolls back, so stock can never move without a sale
 * and a sale can never exist without its payments.
 */
export async function createSale(
  tx: Tx,
  input: CreateSaleInput,
  ctx: CreateSaleContext,
): Promise<CreateSaleResult> {
  const soldAt = new Date(input.soldAt);
  if (Number.isNaN(soldAt.getTime())) throw badRequest('soldAt is not a valid timestamp');
  // A till with a badly wrong clock must not be able to post future-dated revenue.
  if (soldAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw badRequest('soldAt is in the future; check the terminal clock');
  }

  const [store] = await tx.select().from(stores).where(eq(stores.id, input.storeId)).limit(1);
  if (!store || !store.isActive) throw notFound('Store');

  /* --------------------- Re-price from authoritative data -------------------- */

  const variantIds = [...new Set(input.lines.map((l) => l.variantId))];
  const catalogue = await loadAuthoritativeVariants(tx, variantIds, soldAt);

  const inactive = variantIds.filter((id) => !catalogue.get(id)?.isActive);
  if (inactive.length > 0 && !ctx.offline) {
    throw badRequest(
      'One or more items are no longer available for sale',
      inactive.map((id) => ({ path: `variantId:${id}`, message: 'item is inactive' })),
    );
  }

  const canOverridePrice = ctx.permissions.has('sale:price:override');
  let repriced = false;
  /** Lines where a privileged actor deliberately sold at a non-list price. */
  const priceOverrides: Array<{ variantId: string; listPrice: number; soldAt: number }> = [];

  const pricingLines: PricingLineInput[] = input.lines.map((line) => {
    const variant = catalogue.get(line.variantId);
    if (!variant) throw badRequest(`Unknown variant ${line.variantId}`);

    // The till's price is only honoured when the actor may override prices.
    // Otherwise the authoritative price wins and the sale is flagged as repriced,
    // which is what stops a tampered client from selling at an arbitrary price.
    let unitPrice = variant.unitPrice;
    if (line.unitPrice !== variant.unitPrice) {
      if (canOverridePrice) {
        unitPrice = line.unitPrice;
        priceOverrides.push({
          variantId: line.variantId,
          listPrice: variant.unitPrice,
          soldAt: line.unitPrice,
        });
      } else {
        repriced = true;
      }
    }

    return {
      clientLineId: line.clientLineId,
      variantId: line.variantId,
      quantity: line.quantity,
      unitPrice,
      taxRateBasisPoints: variant.taxRateBasisPoints,
      taxCode: variant.taxCode,
      discount: line.discount ?? null,
    };
  });

  // Discount permissions are enforced server-side; the client prompt is only a hint.
  if (input.lines.some((l) => l.discount && l.discount.value > 0) && !ctx.permissions.has('sale:discount:line')) {
    throw forbidden('You may not apply line discounts');
  }
  if (input.orderDiscount && input.orderDiscount.value > 0 && !ctx.permissions.has('sale:discount:order')) {
    throw forbidden('An order discount needs a manager override');
  }

  const priced = priceSale(pricingLines, input.orderDiscount ?? null, {
    pricesIncludeTax: store.pricesIncludeTax,
    cashRoundingIncrement: store.cashRoundingIncrement,
  });

  if (Math.abs(priced.total - input.declaredTotal) > REPRICE_TOLERANCE) {
    if (!ctx.offline) {
      throw unbalancedSale('The till total does not match the server total; refresh prices and retry', {
        declared: input.declaredTotal,
        computed: priced.total,
      });
    }
    // Offline sales are accepted at the recomputed total and flagged for review,
    // because refusing them would mean losing a sale that already happened.
    repriced = true;
  }

  /* ------------------------------ Balance tenders ---------------------------- */

  const tenderTotal = sum(input.tenders.map((t) => t.amount));
  const cashTendered = sum(
    input.tenders.filter((t) => t.method === 'CASH').map((t) => (t as { tendered: number }).tendered),
  );
  const nonCashTotal = sum(input.tenders.filter((t) => t.method !== 'CASH').map((t) => t.amount));

  if (tenderTotal !== priced.total) {
    throw unbalancedSale('Payments do not add up to the sale total', {
      tendered: tenderTotal,
      total: priced.total,
    });
  }
  // Only cash can produce change; over-tendering a card or M-PESA is a data error.
  if (nonCashTotal > priced.total) {
    throw unbalancedSale('Non-cash payments exceed the sale total');
  }
  const cashPortion = tenderTotal - nonCashTotal;
  const changeGiven = Math.max(0, cashTendered - cashPortion);

  /* -------------------------------- Shift check ------------------------------ */

  let shiftId = input.shiftId ?? null;
  if (shiftId) {
    const [shift] = await tx.select().from(shifts).where(eq(shifts.id, shiftId)).limit(1);
    if (!shift) throw notFound('Shift');
    if (shift.status !== 'OPEN' && !ctx.offline) throw conflict('That shift is already closed');
    if (shift.terminalId !== input.terminalId) throw badRequest('Shift belongs to another terminal');
  }

  /* ------------------------------ Loyalty redemption ------------------------- */

  let loyaltyPointsEarned = 0;
  if (input.customerId) {
    const [customer] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1)
      .for('update');
    if (!customer) throw notFound('Customer');

    if (input.loyaltyPointsRedeemed > 0 && customer.loyaltyPoints < input.loyaltyPointsRedeemed) {
      throw conflict('Customer does not have enough loyalty points', {
        available: customer.loyaltyPoints,
        requested: input.loyaltyPointsRedeemed,
      });
    }
    // One point per whole unit of net spend, ignoring tax.
    loyaltyPointsEarned = Math.floor(priced.netTotal / 100);
  }

  /* --------------------------------- Persist --------------------------------- */

  const receiptNumber = await nextReceiptNumber(tx, input.terminalId);

  const [sale] = await tx
    .insert(sales)
    .values({
      clientSaleId: input.clientSaleId,
      receiptNumber,
      storeId: input.storeId,
      terminalId: input.terminalId,
      shiftId,
      cashierId: ctx.cashierId,
      customerId: input.customerId ?? null,
      status: 'COMPLETED',
      grossSubtotal: priced.grossSubtotal,
      lineDiscountTotal: priced.lineDiscountTotal,
      orderDiscountTotal: priced.orderDiscountTotal,
      netTotal: priced.netTotal,
      taxTotal: priced.taxTotal,
      roundingAdjustment: priced.roundingAdjustment,
      total: priced.total,
      changeGiven,
      orderDiscountType: input.orderDiscount?.type ?? null,
      orderDiscountValue: input.orderDiscount?.value ?? null,
      orderDiscountReason: input.orderDiscount?.reason ?? null,
      taxBreakdown: priced.taxBreakdown,
      currency: store.currency,
      note: input.note ?? null,
      receiptEmail: input.receiptEmail ?? null,
      receiptPhone: input.receiptPhone ?? null,
      loyaltyPointsEarned,
      loyaltyPointsRedeemed: input.loyaltyPointsRedeemed,
      createdOffline: ctx.offline ?? false,
      repricedOnSync: repriced,
      overrideByUserId: ctx.overrideByUserId ?? null,
      soldAt,
      syncedAt: new Date(),
    })
    .returning({ id: sales.id });

  if (!sale) throw conflict('Could not create sale');

  let oversold = false;

  for (const [index, line] of priced.lines.entries()) {
    const variant = catalogue.get(line.variantId);
    if (!variant) continue;
    const source = input.lines[index];

    await tx.insert(saleLines).values({
      saleId: sale.id,
      clientLineId: line.clientLineId,
      variantId: line.variantId,
      lineNumber: index + 1,
      productName: variant.productName,
      variantSku: variant.sku,
      variantLabel: variant.variantLabel,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      unitCost: variant.costPrice,
      grossSubtotal: line.grossSubtotal,
      lineDiscount: line.lineDiscount,
      allocatedOrderDiscount: line.allocatedOrderDiscount,
      lineTotal: line.lineTotal,
      taxAmount: line.taxAmount,
      netAmount: line.netAmount,
      taxRateBasisPoints: line.taxRateBasisPoints,
      taxCode: line.taxCode,
      discountType: source?.discount?.type ?? null,
      discountValue: source?.discount?.value ?? null,
      discountReason: source?.discount?.reason ?? null,
      note: source?.note ?? null,
    });

    if (variant.trackInventory) {
      const movement = await applyStockMovement(tx, {
        storeId: input.storeId,
        variantId: line.variantId,
        quantityDelta: -line.quantity,
        reason: 'SALE',
        referenceType: 'SALE',
        referenceId: sale.id,
        unitCost: variant.costPrice,
        performedBy: ctx.cashierId,
        occurredAt: soldAt,
        // An offline sale already happened; refusing it now would lose revenue and
        // leave the till and the server permanently disagreeing.
        allowNegative: ctx.offline === true,
      });
      if (movement.wentNegative) oversold = true;
    }
  }

  if (oversold) {
    await tx.update(sales).set({ oversold: true }).where(eq(sales.id, sale.id));
  }

  for (const tender of input.tenders) {
    await tx.insert(payments).values({
      saleId: sale.id,
      storeId: input.storeId,
      method: tender.method,
      status: 'CAPTURED',
      amount: tender.amount,
      tenderedAmount: tender.method === 'CASH' ? tender.tendered : tender.amount,
      changeAmount: tender.method === 'CASH' ? Math.max(0, tender.tendered - tender.amount) : 0,
      externalReference: externalReferenceFor(tender),
      maskedPan: tender.method === 'PDQ' ? (tender.maskedPan ?? null) : null,
      cardScheme: tender.method === 'PDQ' ? (tender.cardScheme ?? null) : null,
      giftCardCode: tender.method === 'GIFT_CARD' ? tender.cardCode : null,
      loyaltyPoints: tender.method === 'LOYALTY_POINTS' ? tender.points : null,
      mpesaTransactionId: tender.method === 'MPESA' ? (tender.mpesaTransactionId ?? null) : null,
      pdqTransactionId: tender.method === 'PDQ' ? (tender.pdqTransactionId ?? null) : null,
      capturedAt: soldAt,
    });

    // Bind the provider record to this sale so reconciliation has both sides.
    if (tender.method === 'MPESA' && tender.mpesaTransactionId) {
      await tx
        .update(mpesaTransactions)
        .set({ saleId: sale.id, reconciledAt: new Date() })
        .where(eq(mpesaTransactions.id, tender.mpesaTransactionId));
    }
    if (tender.method === 'PDQ' && tender.pdqTransactionId) {
      await tx
        .update(pdqTransactions)
        .set({ saleId: sale.id, reconciledAt: new Date() })
        .where(eq(pdqTransactions.id, tender.pdqTransactionId));
    }
  }

  /* ---------------------------- Customer + loyalty ---------------------------- */

  if (input.customerId) {
    if (input.loyaltyPointsRedeemed > 0) {
      const [updated] = await tx
        .update(customers)
        .set({ loyaltyPoints: sql`${customers.loyaltyPoints} - ${input.loyaltyPointsRedeemed}` })
        .where(eq(customers.id, input.customerId))
        .returning({ balance: customers.loyaltyPoints });
      await tx.insert(loyaltyTransactions).values({
        customerId: input.customerId,
        saleId: sale.id,
        points: -input.loyaltyPointsRedeemed,
        balanceAfter: updated?.balance ?? 0,
        kind: 'REDEEM',
        reason: `Redeemed on ${receiptNumber}`,
        performedBy: ctx.cashierId,
      });
    }
    if (loyaltyPointsEarned > 0) {
      const [updated] = await tx
        .update(customers)
        .set({ loyaltyPoints: sql`${customers.loyaltyPoints} + ${loyaltyPointsEarned}` })
        .where(eq(customers.id, input.customerId))
        .returning({ balance: customers.loyaltyPoints });
      await tx.insert(loyaltyTransactions).values({
        customerId: input.customerId,
        saleId: sale.id,
        points: loyaltyPointsEarned,
        balanceAfter: updated?.balance ?? 0,
        kind: 'EARN',
        reason: `Earned on ${receiptNumber}`,
        performedBy: ctx.cashierId,
      });
    }
    await tx
      .update(customers)
      .set({
        totalSpent: sql`${customers.totalSpent} + ${priced.total}`,
        visitCount: sql`${customers.visitCount} + 1`,
        lastVisitAt: soldAt,
      })
      .where(eq(customers.id, input.customerId));
  }

  /* --------------------------- Downstream propagation ------------------------ */

  await enqueueQbSync(tx, {
    storeId: input.storeId,
    entity: 'SALES_RECEIPT',
    localId: sale.id,
    operation: 'CREATE',
  });

  await tx.insert(changeLog).values({
    storeId: input.storeId,
    entityType: 'SALE',
    entityId: sale.id,
    operation: 'CREATE',
    payload: { receiptNumber, total: priced.total },
  });

  await writeAudit(tx, ctx.request, {
    action: 'SALE_CREATED',
    entityType: 'SALE',
    entityId: sale.id,
    storeId: input.storeId,
    terminalId: input.terminalId,
    overrideByUserId: ctx.overrideByUserId ?? null,
    changes: {
      receiptNumber,
      total: priced.total,
      lineCount: priced.lines.length,
      tenders: input.tenders.map((t) => ({ method: t.method, amount: t.amount })),
      offline: ctx.offline ?? false,
      repriced,
      oversold,
      // Selling off list price is a control point: record exactly what changed.
      ...(priceOverrides.length > 0 ? { priceOverrides } : {}),
    },
  });

  if (priceOverrides.length > 0) {
    await writeAudit(tx, ctx.request, {
      action: 'SALE_PRICE_OVERRIDDEN',
      entityType: 'SALE',
      entityId: sale.id,
      storeId: input.storeId,
      terminalId: input.terminalId,
      overrideByUserId: ctx.overrideByUserId ?? null,
      changes: { receiptNumber, priceOverrides },
    });
  }

  return {
    saleId: sale.id,
    receiptNumber,
    total: priced.total,
    changeGiven,
    status: 'COMPLETED',
    oversold,
    repriced,
    loyaltyPointsEarned,
  };
}

function externalReferenceFor(tender: CreateSaleInput['tenders'][number]): string | null {
  switch (tender.method) {
    case 'MPESA':
      return tender.confirmationCode ?? null;
    case 'PDQ':
      return tender.authCode ?? null;
    case 'BANK_TRANSFER':
      return tender.reference;
    default:
      return null;
  }
}

/** Convenience wrapper for the online path, which owns its own transaction. */
export function createSaleStandalone(input: CreateSaleInput, ctx: CreateSaleContext) {
  return db.transaction((tx) => createSale(tx, input, ctx));
}
