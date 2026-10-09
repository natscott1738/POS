import { allocate, applyRate, assertCents, roundHalfUp, sum, taxFromInclusive, type Cents } from './money.js';
import type { DiscountInput } from './schemas/sales.js';

/**
 * The single pricing implementation, shared verbatim by the till and the API.
 * Running identical code both sides is what lets an offline sale be re-priced
 * server-side and still agree to the cent.
 */

export interface PricingLineInput {
  clientLineId: string;
  variantId: string;
  /** Thousandths of a unit: 2000 === 2 items, 250 === 0.25 kg. */
  quantity: number;
  unitPrice: Cents;
  taxRateBasisPoints: number;
  taxCode: 'STANDARD' | 'ZERO_RATED' | 'EXEMPT';
  discount?: DiscountInput | null;
}

export interface PricingOptions {
  /** Kenyan retail convention: shelf prices already contain VAT. */
  pricesIncludeTax: boolean;
  /** Round the final payable to the nearest N cents (cash rounding). 0 disables. */
  cashRoundingIncrement?: number;
}

export interface PricedLine {
  clientLineId: string;
  variantId: string;
  quantity: number;
  unitPrice: Cents;
  /** quantity x unitPrice before any discount. */
  grossSubtotal: Cents;
  lineDiscount: Cents;
  /** Share of the order-level discount carried by this line. */
  allocatedOrderDiscount: Cents;
  /** What the customer pays for this line, tax included. */
  lineTotal: Cents;
  taxAmount: Cents;
  /** lineTotal - taxAmount. */
  netAmount: Cents;
  taxRateBasisPoints: number;
  taxCode: string;
}

export interface PricedSale {
  lines: PricedLine[];
  grossSubtotal: Cents;
  lineDiscountTotal: Cents;
  orderDiscountTotal: Cents;
  discountTotal: Cents;
  /** Sum of net (tax-exclusive) amounts. */
  netTotal: Cents;
  taxTotal: Cents;
  /** Pre-rounding amount owed. */
  subtotal: Cents;
  roundingAdjustment: Cents;
  /** What must be tendered. */
  total: Cents;
  taxBreakdown: Array<{ taxCode: string; rateBasisPoints: number; net: Cents; tax: Cents }>;
}

function discountAmount(base: Cents, discount: DiscountInput | null | undefined): Cents {
  if (!discount || discount.value <= 0) return 0;
  const raw = discount.type === 'PERCENTAGE' ? applyRate(base, discount.value) : discount.value;
  // A discount can never exceed what is being discounted; otherwise it becomes revenue.
  return Math.min(Math.max(raw, 0), base);
}

export function priceSale(
  lines: readonly PricingLineInput[],
  orderDiscount: DiscountInput | null | undefined,
  options: PricingOptions,
): PricedSale {
  const increment = options.cashRoundingIncrement ?? 0;

  const staged = lines.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new RangeError(`line ${line.clientLineId}: quantity must be a positive integer (thousandths)`);
    }
    assertCents(line.unitPrice, 'unitPrice');
    // Quantity is in thousandths, so divide it back out exactly once, with explicit rounding.
    const grossSubtotal = roundHalfUp((line.unitPrice * line.quantity) / 1000);
    const lineDiscount = discountAmount(grossSubtotal, line.discount);
    return { line, grossSubtotal, lineDiscount, afterLineDiscount: grossSubtotal - lineDiscount };
  });

  const grossSubtotal = sum(staged.map((s) => s.grossSubtotal));
  const lineDiscountTotal = sum(staged.map((s) => s.lineDiscount));
  const discountableBase = sum(staged.map((s) => s.afterLineDiscount));
  const orderDiscountTotal = discountAmount(discountableBase, orderDiscount);

  // Spread the order discount across lines by value so every cent lands somewhere
  // and per-line tax stays correct.
  const allocations = allocate(
    orderDiscountTotal,
    staged.map((s) => s.afterLineDiscount),
  );

  const priced: PricedLine[] = staged.map((s, i) => {
    const allocated = allocations[i] ?? 0;
    const lineTotal = s.afterLineDiscount - allocated;
    const rate = s.line.taxCode === 'STANDARD' ? s.line.taxRateBasisPoints : 0;
    const taxAmount = options.pricesIncludeTax ? taxFromInclusive(lineTotal, rate) : applyRate(lineTotal, rate);
    const payable = options.pricesIncludeTax ? lineTotal : lineTotal + taxAmount;
    return {
      clientLineId: s.line.clientLineId,
      variantId: s.line.variantId,
      quantity: s.line.quantity,
      unitPrice: s.line.unitPrice,
      grossSubtotal: s.grossSubtotal,
      lineDiscount: s.lineDiscount,
      allocatedOrderDiscount: allocated,
      lineTotal: payable,
      taxAmount,
      netAmount: payable - taxAmount,
      taxRateBasisPoints: rate,
      taxCode: s.line.taxCode,
    };
  });

  const taxTotal = sum(priced.map((l) => l.taxAmount));
  const netTotal = sum(priced.map((l) => l.netAmount));
  const subtotal = sum(priced.map((l) => l.lineTotal));
  const rounded = increment > 1 ? Math.round(subtotal / increment) * increment : subtotal;
  const roundingAdjustment = rounded - subtotal;

  const byTax = new Map<string, { taxCode: string; rateBasisPoints: number; net: Cents; tax: Cents }>();
  for (const line of priced) {
    const key = `${line.taxCode}:${line.taxRateBasisPoints}`;
    const entry = byTax.get(key) ?? {
      taxCode: line.taxCode,
      rateBasisPoints: line.taxRateBasisPoints,
      net: 0,
      tax: 0,
    };
    entry.net += line.netAmount;
    entry.tax += line.taxAmount;
    byTax.set(key, entry);
  }

  return {
    lines: priced,
    grossSubtotal,
    lineDiscountTotal,
    orderDiscountTotal,
    discountTotal: lineDiscountTotal + orderDiscountTotal,
    netTotal,
    taxTotal,
    subtotal,
    roundingAdjustment,
    total: rounded,
    taxBreakdown: [...byTax.values()].sort((a, b) => a.taxCode.localeCompare(b.taxCode)),
  };
}

/** Change owed to the customer for a cash tender. Negative means still short. */
export function changeDue(total: Cents, tenderedTotal: Cents): Cents {
  return assertCents(tenderedTotal - total);
}
