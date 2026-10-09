/**
 * Money is ALWAYS an integer number of minor units (cents).
 * Floating point currency is a correctness bug in a POS, so it is banned here:
 * every helper takes and returns integers, and `assertCents` is the gate.
 */

export type Cents = number;

export const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

export function assertCents(value: unknown, label = 'amount'): Cents {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer number of cents, received ${String(value)}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} exceeds safe integer range`);
  }
  return value;
}

/** Parse a human-entered decimal string/number ("1234.50") into cents. Never uses float maths. */
export function parseDecimalToCents(input: string | number, exponent = 2): Cents {
  const raw = String(input).trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new TypeError(`Invalid monetary value: ${raw}`);
  const negative = raw.startsWith('-');
  const [whole = '0', fraction = ''] = raw.replace('-', '').split('.');
  const padded = (fraction + '0'.repeat(exponent)).slice(0, exponent);
  const rounded = fraction.length > exponent && Number(fraction[exponent]) >= 5 ? 1 : 0;
  const value = Number(whole) * 10 ** exponent + Number(padded || '0') + rounded;
  return assertCents(negative ? -value : value);
}

export function formatCents(cents: Cents, currency = 'KES', locale = 'en-KE', exponent = 2): string {
  assertCents(cents);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: exponent,
  }).format(cents / 10 ** exponent);
}

export function sum(values: readonly Cents[]): Cents {
  return values.reduce<Cents>((acc, v) => assertCents(acc + assertCents(v)), 0);
}

/** Banker-safe percentage: `basis` in hundredths of a percent (1600 === 16.00%). */
export function applyRate(amount: Cents, basisPoints: number): Cents {
  assertCents(amount);
  if (!Number.isInteger(basisPoints)) throw new TypeError('basisPoints must be an integer');
  return roundHalfUp((amount * basisPoints) / 10_000);
}

/** Extract the tax already contained in a tax-inclusive amount (the Kenyan retail default). */
export function taxFromInclusive(grossAmount: Cents, basisPoints: number): Cents {
  assertCents(grossAmount);
  if (basisPoints === 0) return 0;
  return roundHalfUp((grossAmount * basisPoints) / (10_000 + basisPoints));
}

export function roundHalfUp(value: number): Cents {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/**
 * Distribute `total` across `weights` losing not one cent.
 * Used for order-level discounts, split payments and tax apportionment.
 * Largest-remainder method: the sum of the result is exactly `total`.
 */
export function allocate(total: Cents, weights: readonly number[]): Cents[] {
  assertCents(total);
  if (weights.length === 0) return [];
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  if (weightTotal <= 0) {
    // Degenerate case: spread evenly so money is never silently dropped.
    const base = Math.trunc(total / weights.length);
    const out = weights.map(() => base);
    let remainder = total - base * weights.length;
    for (let i = 0; remainder !== 0; i = (i + 1) % out.length) {
      out[i] = (out[i] as number) + Math.sign(remainder);
      remainder -= Math.sign(remainder);
    }
    return out;
  }
  const exact = weights.map((w) => (total * w) / weightTotal);
  const floored = exact.map((v) => Math.trunc(v));
  let remainder = total - floored.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: Math.abs(v - Math.trunc(v)) }))
    .sort((a, b) => b.frac - a.frac);
  const step = Math.sign(remainder) || 1;
  for (let k = 0; remainder !== 0 && order.length > 0; k++) {
    const idx = (order[k % order.length] as { i: number }).i;
    floored[idx] = (floored[idx] as number) + step;
    remainder -= step;
  }
  return floored;
}
