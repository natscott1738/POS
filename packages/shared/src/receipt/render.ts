import { formatCents } from '../money.js';
import { EscPosBuilder, PAPER_WIDTH_CHARS, centre, wrap } from './escpos.js';

/**
 * Receipt layout. Shared between the API (reprints, email) and the till, so a
 * reprint months later is byte-identical to what the customer originally got.
 */

export interface ReceiptStore {
  name: string;
  address?: string | null;
  phone?: string | null;
  taxPin?: string | null;
  receiptHeader?: string | null;
  receiptFooter?: string | null;
  currency?: string;
}

export interface ReceiptLine {
  productName: string;
  variantLabel?: string | null;
  /** Thousandths of a unit. */
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  lineDiscount?: number;
  taxCode?: string;
}

export interface ReceiptPayment {
  method: string;
  amount: number;
  externalReference?: string | null;
  maskedPan?: string | null;
  changeAmount?: number;
}

export interface ReceiptData {
  receiptNumber: string;
  soldAt: Date | string;
  cashierName?: string | null;
  customerName?: string | null;
  lines: ReceiptLine[];
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  roundingAdjustment: number;
  total: number;
  changeGiven: number;
  payments: ReceiptPayment[];
  taxBreakdown?: Array<{ taxCode: string; rateBasisPoints: number; net: number; tax: number }>;
  loyaltyPointsEarned?: number;
  loyaltyBalance?: number | null;
  /** Fiscal signature from eTIMS, once that integration is connected. */
  fiscal?: { invoiceNumber: string; qrData: string; controlCode?: string } | null;
  isReprint?: boolean;
  isRefund?: boolean;
  store: ReceiptStore;
}

function qty(milli: number): string {
  const value = milli / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '');
}

/** Builds the printable byte stream for a thermal printer. */
export function renderEscPos(data: ReceiptData, options: { openDrawer?: boolean; copies?: number } = {}): Uint8Array {
  const currency = data.store.currency ?? 'KES';
  const money = (cents: number) => formatCents(cents, currency).replace(/[^\d.,-]/g, '');
  const builder = new EscPosBuilder().init();

  const when = typeof data.soldAt === 'string' ? new Date(data.soldAt) : data.soldAt;

  /* --------------------------------- Header -------------------------------- */
  builder.align('center').bold(true).size(2, 2).line(data.store.name).size(1, 1).bold(false);

  if (data.store.receiptHeader) for (const l of wrap(data.store.receiptHeader)) builder.line(l);
  if (data.store.address) for (const l of wrap(data.store.address)) builder.line(l);
  if (data.store.phone) builder.line(`Tel: ${data.store.phone}`);
  if (data.store.taxPin) builder.line(`PIN: ${data.store.taxPin}`);

  builder.line();
  if (data.isRefund) builder.bold(true).line('*** REFUND ***').bold(false);
  if (data.isReprint) builder.line('*** REPRINT ***');

  builder.align('left').rule();
  builder.columns(`Receipt: ${data.receiptNumber}`, when.toLocaleDateString('en-GB'));
  builder.columns(data.cashierName ? `Served by: ${data.cashierName}` : '', when.toLocaleTimeString('en-GB'));
  if (data.customerName) builder.line(`Customer: ${data.customerName}`);
  builder.rule();

  /* ---------------------------------- Items -------------------------------- */
  for (const line of data.lines) {
    const label = line.variantLabel ? `${line.productName} (${line.variantLabel})` : line.productName;
    for (const l of wrap(label)) builder.line(l);
    // Quantity x price on the left, line total right-aligned.
    builder.columns(`  ${qty(line.quantity)} x ${money(line.unitPrice)}`, money(line.lineTotal));
    if (line.lineDiscount && line.lineDiscount > 0) {
      builder.columns('  Discount', `-${money(line.lineDiscount)}`);
    }
  }

  builder.rule();

  /* --------------------------------- Totals -------------------------------- */
  builder.columns('Subtotal', money(data.subtotal));
  if (data.discountTotal > 0) builder.columns('Discount', `-${money(data.discountTotal)}`);
  if (data.roundingAdjustment !== 0) builder.columns('Rounding', money(data.roundingAdjustment));

  builder.bold(true).size(2, 2);
  // Double-width halves the usable columns.
  builder.columns('TOTAL', money(data.total), Math.floor(PAPER_WIDTH_CHARS / 2));
  builder.size(1, 1).bold(false);

  /* -------------------------------- Payments ------------------------------- */
  builder.line();
  for (const payment of data.payments) {
    const label = payment.maskedPan ? `${payment.method} ${payment.maskedPan}` : payment.method;
    builder.columns(label, money(payment.amount));
    if (payment.externalReference) builder.line(`  Ref: ${payment.externalReference}`);
  }
  if (data.changeGiven > 0) builder.bold(true).columns('CHANGE', money(data.changeGiven)).bold(false);

  /* ----------------------------------- VAT --------------------------------- */
  if (data.taxBreakdown?.length) {
    builder.line().rule();
    builder.line('VAT summary');
    for (const band of data.taxBreakdown) {
      const rate = band.rateBasisPoints / 100;
      builder.columns(`  ${band.taxCode} @ ${rate}%`, `${money(band.net)} + ${money(band.tax)}`);
    }
    builder.columns('Total VAT', money(data.taxTotal));
  }

  /* --------------------------------- Loyalty ------------------------------- */
  if (data.loyaltyPointsEarned && data.loyaltyPointsEarned > 0) {
    builder.line();
    builder.line(`Points earned: ${data.loyaltyPointsEarned}`);
    if (data.loyaltyBalance !== null && data.loyaltyBalance !== undefined) {
      builder.line(`Points balance: ${data.loyaltyBalance}`);
    }
  }

  /* --------------------------------- Fiscal -------------------------------- */
  // Printed only once eTIMS is connected; absent receipts are not fiscal documents.
  if (data.fiscal) {
    builder.line().rule();
    builder.align('center');
    builder.line(`Invoice: ${data.fiscal.invoiceNumber}`);
    if (data.fiscal.controlCode) builder.line(`Control: ${data.fiscal.controlCode}`);
    builder.qr(data.fiscal.qrData);
    builder.align('left');
  }

  /* --------------------------------- Footer -------------------------------- */
  builder.line().align('center');
  if (data.store.receiptFooter) for (const l of wrap(data.store.receiptFooter)) builder.line(l);
  builder.line('Goods once sold are subject to');
  builder.line('our returns policy.');

  builder.cut();
  if (options.openDrawer) builder.openDrawer();

  const single = builder.build();
  const copies = Math.max(1, options.copies ?? 1);
  if (copies === 1) return single;

  const repeated = new Uint8Array(single.length * copies);
  for (let i = 0; i < copies; i++) repeated.set(single, i * single.length);
  return repeated;
}

/** Plain-text rendering, for on-screen preview, email bodies and debugging. */
export function renderText(data: ReceiptData): string {
  const currency = data.store.currency ?? 'KES';
  const money = (cents: number) => formatCents(cents, currency);
  const when = typeof data.soldAt === 'string' ? new Date(data.soldAt) : data.soldAt;
  const out: string[] = [];
  const pad = (left: string, right: string) => {
    const spaces = Math.max(1, PAPER_WIDTH_CHARS - left.length - right.length);
    return `${left}${' '.repeat(spaces)}${right}`;
  };

  out.push(centre(data.store.name));
  if (data.store.address) out.push(centre(data.store.address));
  if (data.store.taxPin) out.push(centre(`PIN: ${data.store.taxPin}`));
  out.push('');
  if (data.isRefund) out.push(centre('*** REFUND ***'));
  if (data.isReprint) out.push(centre('*** REPRINT ***'));
  out.push('-'.repeat(PAPER_WIDTH_CHARS));
  out.push(pad(`Receipt: ${data.receiptNumber}`, when.toLocaleDateString('en-GB')));
  if (data.cashierName) out.push(pad(`Served by: ${data.cashierName}`, when.toLocaleTimeString('en-GB')));
  out.push('-'.repeat(PAPER_WIDTH_CHARS));

  for (const line of data.lines) {
    out.push(line.variantLabel ? `${line.productName} (${line.variantLabel})` : line.productName);
    out.push(pad(`  ${qty(line.quantity)} x ${money(line.unitPrice)}`, money(line.lineTotal)));
  }

  out.push('-'.repeat(PAPER_WIDTH_CHARS));
  out.push(pad('Subtotal', money(data.subtotal)));
  if (data.discountTotal > 0) out.push(pad('Discount', `-${money(data.discountTotal)}`));
  out.push(pad('TOTAL', money(data.total)));
  out.push('');
  for (const payment of data.payments) out.push(pad(payment.method, money(payment.amount)));
  if (data.changeGiven > 0) out.push(pad('CHANGE', money(data.changeGiven)));
  if (data.taxTotal > 0) out.push(pad('Includes VAT', money(data.taxTotal)));
  if (data.store.receiptFooter) {
    out.push('');
    out.push(centre(data.store.receiptFooter));
  }
  return out.join('\n');
}
