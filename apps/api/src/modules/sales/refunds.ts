import { and, eq, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { sum, type CreateRefundInput } from '@pos/shared';
import { db, type Tx } from '../../db/client.js';
import {
  sales,
  saleLines,
  payments,
  refunds,
  refundLines,
  customers,
  loyaltyTransactions,
  changeLog,
} from '../../db/schema/index.js';
import { applyStockMovement } from '../inventory/service.js';
import { nextReceiptNumber } from './receipt-number.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { enqueueQbSync } from '../quickbooks/queue.js';

export interface RefundContext {
  request: FastifyRequest;
  processedBy: string;
  overrideByUserId?: string | null;
  offline?: boolean;
}

export interface RefundResult {
  refundId: string;
  refundNumber: string;
  total: number;
  saleStatus: string;
}

/**
 * Refunds are new, signed records rather than edits to the original sale: the sales
 * ledger stays immutable, so a receipt reprinted a year later still shows what the
 * customer was originally charged.
 */
export async function createRefund(
  tx: Tx,
  input: CreateRefundInput,
  ctx: RefundContext,
): Promise<RefundResult> {
  const [sale] = await tx.select().from(sales).where(eq(sales.id, input.saleId)).limit(1).for('update');
  if (!sale) throw notFound('Sale');
  if (sale.status === 'VOIDED') throw conflict('That sale was voided and cannot be refunded');

  const lines = await tx.select().from(saleLines).where(eq(saleLines.saleId, sale.id));
  const byId = new Map(lines.map((l) => [l.id, l]));

  let subtotal = 0;
  let taxTotal = 0;
  const prepared: Array<{
    saleLineId: string;
    variantId: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    taxAmount: number;
    restock: boolean;
    reason: string;
  }> = [];

  for (const line of input.lines) {
    const original = byId.get(line.saleLineId);
    if (!original) throw badRequest(`Line ${line.saleLineId} is not part of this sale`);

    const remaining = original.quantity - original.quantityRefunded;
    if (line.quantity > remaining) {
      throw conflict('Refund quantity exceeds what remains on that line', {
        saleLineId: line.saleLineId,
        remaining,
        requested: line.quantity,
      });
    }

    // Refund value is apportioned from what was actually charged, so discounts and
    // rounding carry through instead of refunding more than was collected.
    const ratio = line.quantity / original.quantity;
    const lineTotal = Math.round(original.lineTotal * ratio);
    const taxAmount = Math.round(original.taxAmount * ratio);

    subtotal += lineTotal - taxAmount;
    taxTotal += taxAmount;

    prepared.push({
      saleLineId: line.saleLineId,
      variantId: original.variantId,
      quantity: line.quantity,
      unitPrice: original.unitPrice,
      lineTotal,
      taxAmount,
      restock: line.restock,
      reason: line.reason,
    });
  }

  const total = subtotal + taxTotal;
  const refundTenderTotal = sum(input.refundTenders.map((t) => t.amount));
  if (refundTenderTotal !== total) {
    throw badRequest('Refund payments do not add up to the refund total', [
      { path: 'refundTenders', message: `expected ${total}, received ${refundTenderTotal}` },
    ]);
  }

  // A customer cannot be refunded more than was ever collected on the sale.
  if (sale.amountRefunded + total > sale.total) {
    throw conflict('Refund would exceed the original sale total', {
      alreadyRefunded: sale.amountRefunded,
      requested: total,
      saleTotal: sale.total,
    });
  }

  // Each tender method can only give back what it took in.
  const captured = await tx
    .select({ method: payments.method, amount: sql<number>`sum(${payments.amount})`.as('amount') })
    .from(payments)
    .where(eq(payments.saleId, sale.id))
    .groupBy(payments.method);
  const capturedByMethod = new Map(captured.map((c) => [c.method, Number(c.amount)]));

  for (const tender of input.refundTenders) {
    const available = capturedByMethod.get(tender.method) ?? 0;
    // STORE_CREDIT is always allowed as a refund destination even if unused originally.
    if (tender.method !== 'STORE_CREDIT' && tender.amount > available) {
      throw badRequest(`Cannot refund ${tender.amount} to ${tender.method}; only ${available} was taken`, [
        { path: 'refundTenders', message: `${tender.method} over-refund` },
      ]);
    }
  }

  const refundNumber = await nextReceiptNumber(tx, sale.terminalId, 'R');

  const [refund] = await tx
    .insert(refunds)
    .values({
      clientRefundId: input.clientRefundId,
      refundNumber,
      saleId: sale.id,
      storeId: sale.storeId,
      terminalId: sale.terminalId,
      shiftId: sale.shiftId,
      processedBy: ctx.processedBy,
      overrideByUserId: ctx.overrideByUserId ?? null,
      subtotal,
      taxTotal,
      total,
      reason: input.reason,
      createdOffline: ctx.offline ?? false,
    })
    .returning({ id: refunds.id });

  if (!refund) throw conflict('Could not create refund');

  for (const line of prepared) {
    await tx.insert(refundLines).values({
      refundId: refund.id,
      saleLineId: line.saleLineId,
      variantId: line.variantId,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      taxAmount: line.taxAmount,
      restocked: line.restock,
      reason: line.reason,
    });

    await tx
      .update(saleLines)
      .set({ quantityRefunded: sql`${saleLines.quantityRefunded} + ${line.quantity}` })
      .where(eq(saleLines.id, line.saleLineId));

    // Faulty or expired goods go back to the supplier, not back on the shelf.
    if (line.restock) {
      await applyStockMovement(tx, {
        storeId: sale.storeId,
        variantId: line.variantId,
        quantityDelta: line.quantity,
        reason: 'REFUND',
        referenceType: 'REFUND',
        referenceId: refund.id,
        performedBy: ctx.processedBy,
        allowNegative: true,
      });
    }
  }

  // Refund payments are negative rows on the same ledger, so summing `amount`
  // over any period always yields net takings without a special case.
  for (const tender of input.refundTenders) {
    await tx.insert(payments).values({
      saleId: sale.id,
      refundId: refund.id,
      storeId: sale.storeId,
      method: tender.method,
      status: 'CAPTURED',
      amount: -tender.amount,
      externalReference: tender.reference ?? null,
      capturedAt: new Date(),
    });
  }

  const totalRefunded = sale.amountRefunded + total;
  const newStatus = totalRefunded >= sale.total ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  await tx
    .update(sales)
    .set({ amountRefunded: totalRefunded, status: newStatus, updatedAt: new Date() })
    .where(eq(sales.id, sale.id));

  // Claw back loyalty proportionally so a refund cannot be used to farm points.
  if (sale.customerId && sale.loyaltyPointsEarned > 0) {
    const clawback = Math.floor(sale.loyaltyPointsEarned * (total / sale.total));
    if (clawback > 0) {
      const [updated] = await tx
        .update(customers)
        .set({
          loyaltyPoints: sql`GREATEST(0, ${customers.loyaltyPoints} - ${clawback})`,
          totalSpent: sql`GREATEST(0, ${customers.totalSpent} - ${total})`,
        })
        .where(eq(customers.id, sale.customerId))
        .returning({ balance: customers.loyaltyPoints });
      await tx.insert(loyaltyTransactions).values({
        customerId: sale.customerId,
        saleId: sale.id,
        points: -clawback,
        balanceAfter: updated?.balance ?? 0,
        kind: 'REFUND_CLAWBACK',
        reason: `Refund ${refundNumber}`,
        performedBy: ctx.processedBy,
      });
    }
  }

  await enqueueQbSync(tx, {
    storeId: sale.storeId,
    entity: 'REFUND_RECEIPT',
    localId: refund.id,
    operation: 'CREATE',
  });

  await tx.insert(changeLog).values({
    storeId: sale.storeId,
    entityType: 'REFUND',
    entityId: refund.id,
    operation: 'CREATE',
    payload: { refundNumber, total },
  });

  await writeAudit(tx, ctx.request, {
    action: 'SALE_REFUNDED',
    entityType: 'SALE',
    entityId: sale.id,
    storeId: sale.storeId,
    terminalId: sale.terminalId,
    overrideByUserId: ctx.overrideByUserId ?? null,
    reason: input.reason,
    changes: { refundId: refund.id, refundNumber, total, lines: prepared.length },
  });

  return { refundId: refund.id, refundNumber, total, saleStatus: newStatus };
}

/**
 * Voids an entire sale. Distinct from a refund: a void cancels a transaction that
 * should never have been recorded (mis-key, abandoned basket) and reverses stock
 * completely, rather than recording a return of goods.
 */
export async function voidSale(
  tx: Tx,
  saleId: string,
  reason: string,
  ctx: RefundContext,
): Promise<{ saleId: string; status: string }> {
  const [sale] = await tx.select().from(sales).where(eq(sales.id, saleId)).limit(1).for('update');
  if (!sale) throw notFound('Sale');
  if (sale.status === 'VOIDED') throw conflict('That sale is already voided');
  if (sale.amountRefunded > 0) throw conflict('Refund the sale instead; it has already been partly refunded');

  // Same-day only: voiding an older sale would silently restate a closed period.
  const ageHours = (Date.now() - sale.soldAt.getTime()) / 3_600_000;
  if (ageHours > 24 && !ctx.offline) {
    throw conflict('Sales older than 24 hours must be refunded, not voided');
  }

  const lines = await tx.select().from(saleLines).where(eq(saleLines.saleId, sale.id));
  for (const line of lines) {
    await applyStockMovement(tx, {
      storeId: sale.storeId,
      variantId: line.variantId,
      quantityDelta: line.quantity,
      reason: 'SALE_VOID',
      referenceType: 'SALE_VOID',
      referenceId: sale.id,
      performedBy: ctx.processedBy,
      allowNegative: true,
    });
  }

  await tx
    .update(payments)
    .set({ status: 'REVERSED', reversedAt: new Date(), reversalReason: reason })
    .where(eq(payments.saleId, sale.id));

  await tx
    .update(sales)
    .set({
      status: 'VOIDED',
      voidedAt: new Date(),
      voidedBy: ctx.processedBy,
      voidReason: reason,
      overrideByUserId: ctx.overrideByUserId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(sales.id, sale.id));

  if (sale.customerId) {
    const [updated] = await tx
      .update(customers)
      .set({
        loyaltyPoints: sql`GREATEST(0, ${customers.loyaltyPoints} - ${sale.loyaltyPointsEarned} + ${sale.loyaltyPointsRedeemed})`,
        totalSpent: sql`GREATEST(0, ${customers.totalSpent} - ${sale.total})`,
        visitCount: sql`GREATEST(0, ${customers.visitCount} - 1)`,
      })
      .where(eq(customers.id, sale.customerId))
      .returning({ balance: customers.loyaltyPoints });
    await tx.insert(loyaltyTransactions).values({
      customerId: sale.customerId,
      saleId: sale.id,
      points: sale.loyaltyPointsRedeemed - sale.loyaltyPointsEarned,
      balanceAfter: updated?.balance ?? 0,
      kind: 'VOID_REVERSAL',
      reason: `Void of ${sale.receiptNumber}`,
      performedBy: ctx.processedBy,
    });
  }

  await enqueueQbSync(tx, {
    storeId: sale.storeId,
    entity: 'SALES_RECEIPT',
    localId: sale.id,
    operation: 'VOID',
  });

  await tx.insert(changeLog).values({
    storeId: sale.storeId,
    entityType: 'SALE',
    entityId: sale.id,
    operation: 'VOID',
    payload: { receiptNumber: sale.receiptNumber },
  });

  await writeAudit(tx, ctx.request, {
    action: 'SALE_VOIDED',
    entityType: 'SALE',
    entityId: sale.id,
    storeId: sale.storeId,
    terminalId: sale.terminalId,
    overrideByUserId: ctx.overrideByUserId ?? null,
    reason,
    changes: { receiptNumber: sale.receiptNumber, total: sale.total },
  });

  return { saleId: sale.id, status: 'VOIDED' };
}

export const createRefundStandalone = (input: CreateRefundInput, ctx: RefundContext) =>
  db.transaction((tx) => createRefund(tx, input, ctx));

export const voidSaleStandalone = (saleId: string, reason: string, ctx: RefundContext) =>
  db.transaction((tx) => voidSale(tx, saleId, reason, ctx));
