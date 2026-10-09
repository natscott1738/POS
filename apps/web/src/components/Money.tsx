import { formatCents } from '@pos/shared';

export function Money({ cents, currency = 'KES' }: { cents: number; currency?: string }) {
  return <span className="mono">{formatCents(cents, currency)}</span>;
}

/** Quantities are stored in thousandths; show whole numbers without noise. */
export function formatQuantity(milli: number, uom = 'EACH'): string {
  const value = milli / 1000;
  if (uom === 'EACH' || uom === 'PACK') return String(Math.round(value));
  return value.toFixed(3).replace(/\.?0+$/, '');
}
