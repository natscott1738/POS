import { eq, and, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  sales,
  saleLines,
  payments,
  refunds,
  refundLines,
  qbMappings,
  qbEntityLinks,
  customers,
  stores,
  products,
  productVariants,
} from '../../db/schema/index.js';
import { notFound, AppError } from '../../core/errors.js';
import { ERROR_CODES, type QbEntity } from '@pos/shared';

/**
 * Translates POS records into QuickBooks Online payloads.
 *
 * Two rules drive the design:
 *  - Amounts are converted from integer cents to decimals exactly once, here, at
 *    the boundary, because QuickBooks insists on decimal numbers.
 *  - A sale posts as a SalesReceipt (paid immediately) or an Invoice (on account),
 *    which is what keeps the QuickBooks A/R balance truthful.
 */

/** Cents to the 2dp decimal QuickBooks expects. */
function toDecimal(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

export interface MappingConfig {
  incomeAccountId: string;
  undepositedFundsAccountId: string;
  taxCodeIdStandard: string | null;
  taxCodeIdZeroRated: string | null;
  taxCodeIdExempt: string | null;
  discountAccountId: string | null;
  roundingAccountId: string | null;
  paymentAccounts: Record<string, string>;
  defaultCustomerId: string | null;
  postingMode: string;
}

export async function loadMapping(storeId: string): Promise<MappingConfig> {
  const [mapping] = await db.select().from(qbMappings).where(eq(qbMappings.storeId, storeId)).limit(1);
  if (!mapping) {
    // Refusing to post is deliberate: a guessed account corrupts the ledger in a
    // way that is far more expensive to unpick than a blocked queue.
    throw new AppError(
      409,
      ERROR_CODES.CONFLICT,
      'QuickBooks account mapping is not configured for this store',
    );
  }
  return {
    incomeAccountId: mapping.incomeAccountId,
    undepositedFundsAccountId: mapping.undepositedFundsAccountId,
    taxCodeIdStandard: mapping.taxCodeIdStandard,
    taxCodeIdZeroRated: mapping.taxCodeIdZeroRated,
    taxCodeIdExempt: mapping.taxCodeIdExempt,
    discountAccountId: mapping.discountAccountId,
    roundingAccountId: mapping.roundingAccountId,
    paymentAccounts: (mapping.paymentAccounts ?? {}) as Record<string, string>,
    defaultCustomerId: mapping.defaultCustomerId,
    postingMode: mapping.postingMode,
  };
}

function taxCodeRef(mapping: MappingConfig, taxCode: string): string | undefined {
  switch (taxCode) {
    case 'STANDARD':
      return mapping.taxCodeIdStandard ?? undefined;
    case 'ZERO_RATED':
      return mapping.taxCodeIdZeroRated ?? undefined;
    case 'EXEMPT':
      return mapping.taxCodeIdExempt ?? undefined;
    default:
      return undefined;
  }
}

/** Reuses an existing QuickBooks id for a local record, when one is known. */
export async function linkedQbId(
  storeId: string,
  entity: QbEntity,
  localId: string,
): Promise<{ qbId: string; syncToken: string | null } | null> {
  const [link] = await db
    .select({ qbId: qbEntityLinks.qbId, syncToken: qbEntityLinks.syncToken })
    .from(qbEntityLinks)
    .where(
      and(
        eq(qbEntityLinks.storeId, storeId),
        eq(qbEntityLinks.localId, localId),
        eq(qbEntityLinks.entity, entity),
      ),
    )
    .limit(1);
  return link ?? null;
}

export interface SalesReceiptPayload {
  payload: Record<string, unknown>;
  /** INVOICE when the sale was taken on account and money is still owed. */
  documentType: 'SALES_RECEIPT' | 'INVOICE';
}

export async function buildSalesReceipt(saleId: string): Promise<SalesReceiptPayload> {
  const [sale] = await db.select().from(sales).where(eq(sales.id, saleId)).limit(1);
  if (!sale) throw notFound('Sale');

  const mapping = await loadMapping(sale.storeId);
  const [lines, tenders, store] = await Promise.all([
    db.select().from(saleLines).where(eq(saleLines.saleId, saleId)).orderBy(saleLines.lineNumber),
    db.select().from(payments).where(eq(payments.saleId, saleId)),
    db.select().from(stores).where(eq(stores.id, sale.storeId)).limit(1),
  ]);

  const onAccount = tenders.some((t) => t.method === 'ON_ACCOUNT' && t.amount > 0);

  const customerRef = await resolveCustomerRef(sale.customerId, mapping);

  // Resolve every line's QuickBooks item id up front. The worker guarantees these
  // exist by syncing items before the sale that needs them.
  const itemLinks = await itemRefsFor(sale.storeId, lines.map((l) => l.variantId));

  const detailLines = lines.map((line) => ({
    DetailType: 'SalesItemLineDetail',
    Description: `${line.productName}${line.variantLabel ? ` (${line.variantLabel})` : ''}`,
    // QuickBooks totals the line itself, so we send the tax-exclusive amount.
    Amount: toDecimal(line.netAmount),
    SalesItemLineDetail: {
      ...(itemLinks.get(line.variantId) ? { ItemRef: { value: itemLinks.get(line.variantId) } } : {}),
      // Quantity is stored in thousandths; convert back for the ledger.
      Qty: Number((line.quantity / 1000).toFixed(3)),
      UnitPrice: toDecimal(Math.round(line.netAmount / (line.quantity / 1000))),
      ...(taxCodeRef(mapping, line.taxCode) ? { TaxCodeRef: { value: taxCodeRef(mapping, line.taxCode) } } : {}),
      ItemAccountRef: { value: mapping.incomeAccountId },
    },
  }));

  // Rounding is posted explicitly so the QuickBooks total matches the receipt to
  // the cent instead of drifting.
  if (sale.roundingAdjustment !== 0 && mapping.roundingAccountId) {
    detailLines.push({
      DetailType: 'SalesItemLineDetail',
      Description: 'Cash rounding',
      Amount: toDecimal(sale.roundingAdjustment),
      SalesItemLineDetail: {
        ItemAccountRef: { value: mapping.roundingAccountId },
        Qty: 1,
        UnitPrice: toDecimal(sale.roundingAdjustment),
      },
    } as (typeof detailLines)[number]);
  }

  const payload: Record<string, unknown> = {
    DocNumber: sale.receiptNumber.slice(0, 21),
    TxnDate: sale.soldAt.toISOString().slice(0, 10),
    CustomerRef: customerRef,
    Line: detailLines,
    PrivateNote: `POS ${sale.receiptNumber}${sale.createdOffline ? ' (offline)' : ''}`,
    CurrencyRef: { value: store[0]?.currency ?? 'KES' },
    GlobalTaxCalculation: 'TaxExcluded',
    TxnTaxDetail: {
      TotalTax: toDecimal(sale.taxTotal),
    },
  };

  if (onAccount) {
    payload.DueDate = sale.soldAt.toISOString().slice(0, 10);
    return { payload, documentType: 'INVOICE' };
  }

  // Money already banked goes to the deposit account for the dominant tender.
  const primaryTender = [...tenders].sort((a, b) => b.amount - a.amount)[0];
  const depositAccount = primaryTender
    ? mapping.paymentAccounts[primaryTender.method] ?? mapping.undepositedFundsAccountId
    : mapping.undepositedFundsAccountId;

  payload.DepositToAccountRef = { value: depositAccount };
  if (primaryTender) {
    payload.PaymentMethodRef = { name: primaryTender.method };
  }

  return { payload, documentType: 'SALES_RECEIPT' };
}

export async function buildRefundReceipt(refundId: string): Promise<Record<string, unknown>> {
  const [refund] = await db.select().from(refunds).where(eq(refunds.id, refundId)).limit(1);
  if (!refund) throw notFound('Refund');

  const mapping = await loadMapping(refund.storeId);
  const [lines, sale] = await Promise.all([
    db.select().from(refundLines).where(eq(refundLines.refundId, refundId)),
    db.select().from(sales).where(eq(sales.id, refund.saleId)).limit(1),
  ]);

  const saleLineRows = await db.select().from(saleLines).where(eq(saleLines.saleId, refund.saleId));
  const byId = new Map(saleLineRows.map((l) => [l.id, l]));
  const refundItemLinks = await itemRefsFor(refund.storeId, lines.map((l) => l.variantId));

  const customerRef = await resolveCustomerRef(sale[0]?.customerId ?? null, mapping);

  const refundTenders = await db.select().from(payments).where(eq(payments.refundId, refundId));
  const primary = [...refundTenders].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
  const depositAccount = primary
    ? mapping.paymentAccounts[primary.method] ?? mapping.undepositedFundsAccountId
    : mapping.undepositedFundsAccountId;

  return {
    DocNumber: refund.refundNumber.slice(0, 21),
    TxnDate: refund.refundedAt.toISOString().slice(0, 10),
    CustomerRef: customerRef,
    PrivateNote: `Refund of ${sale[0]?.receiptNumber ?? refund.saleId}: ${refund.reason}`.slice(0, 1000),
    DepositToAccountRef: { value: depositAccount },
    GlobalTaxCalculation: 'TaxExcluded',
    TxnTaxDetail: { TotalTax: toDecimal(refund.taxTotal) },
    Line: lines.map((line) => {
      const original = byId.get(line.saleLineId);
      return {
        DetailType: 'SalesItemLineDetail',
        Description: original?.productName ?? 'Refunded item',
        Amount: toDecimal(line.lineTotal - line.taxAmount),
        SalesItemLineDetail: {
          ...(refundItemLinks.get(line.variantId) ? { ItemRef: { value: refundItemLinks.get(line.variantId) } } : {}),
          Qty: Number((line.quantity / 1000).toFixed(3)),
          ItemAccountRef: { value: mapping.incomeAccountId },
          ...(original && taxCodeRef(mapping, original.taxCode)
            ? { TaxCodeRef: { value: taxCodeRef(mapping, original.taxCode) } }
            : {}),
        },
      };
    }),
  };
}

/** Maps variant ids to their QuickBooks item ids, for variants already synced. */
async function itemRefsFor(storeId: string, variantIds: string[]): Promise<Map<string, string>> {
  if (variantIds.length === 0) return new Map();
  const rows = await db
    .select({ localId: qbEntityLinks.localId, qbId: qbEntityLinks.qbId })
    .from(qbEntityLinks)
    .where(
      and(
        eq(qbEntityLinks.storeId, storeId),
        eq(qbEntityLinks.entity, 'ITEM'),
        inArray(qbEntityLinks.localId, variantIds),
      ),
    );
  return new Map(rows.map((r) => [r.localId, r.qbId]));
}

async function resolveCustomerRef(
  customerId: string | null,
  mapping: MappingConfig,
): Promise<{ value: string } | undefined> {
  if (!customerId) {
    return mapping.defaultCustomerId ? { value: mapping.defaultCustomerId } : undefined;
  }
  const [customer] = await db
    .select({ qbCustomerId: customers.qbCustomerId })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);

  if (customer?.qbCustomerId) return { value: customer.qbCustomerId };
  return mapping.defaultCustomerId ? { value: mapping.defaultCustomerId } : undefined;
}

/**
 * Builds a QuickBooks Item for a variant. Sales reference items by id, so every
 * variant sold must exist in QuickBooks first - referencing one by name that has
 * never been created is rejected, which is what used to break the first sale of
 * any product.
 */
export async function buildItem(variantId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({
      sku: productVariants.sku,
      unitPrice: productVariants.unitPrice,
      costPrice: productVariants.costPrice,
      productName: products.name,
      attributes: productVariants.attributes,
      storeId: sql<string>`NULL`.as('storeId'),
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(productVariants.id, variantId))
    .limit(1);

  if (!row) throw notFound('Variant');

  const label = Object.entries((row.attributes ?? {}) as Record<string, string>)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' / ');

  return {
    // QuickBooks requires Name to be unique within the company; SKU guarantees that.
    Name: row.sku.slice(0, 100),
    Sku: row.sku.slice(0, 100),
    Description: (label ? `${row.productName} (${label})` : row.productName).slice(0, 4000),
    // NonInventory keeps QuickBooks out of stock-keeping: this system is the
    // authority on stock, and letting both track it guarantees divergence.
    Type: 'NonInventory',
    Taxable: true,
    UnitPrice: toDecimal(row.unitPrice),
    PurchaseCost: toDecimal(row.costPrice),
  };
}

export async function buildCustomer(customerId: string): Promise<Record<string, unknown>> {
  const [customer] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1);
  if (!customer) throw notFound('Customer');
  return {
    DisplayName: `${customer.fullName}${customer.phone ? ` (${customer.phone})` : ''}`.slice(0, 100),
    ...(customer.email ? { PrimaryEmailAddr: { Address: customer.email } } : {}),
    ...(customer.phone ? { PrimaryPhone: { FreeFormNumber: customer.phone } } : {}),
    ...(customer.address ? { BillAddr: { Line1: customer.address.slice(0, 500) } } : {}),
  };
}

export { toDecimal };
