import { describe, it, expect } from 'vitest';
import {
  allocate,
  applyRate,
  parseDecimalToCents,
  priceSale,
  sum,
  taxFromInclusive,
  changeDue,
} from '@pos/shared';

describe('parseDecimalToCents', () => {
  it('parses without floating point error', () => {
    expect(parseDecimalToCents('1234.56')).toBe(123456);
    expect(parseDecimalToCents('0.1')).toBe(10);
    // 0.1 + 0.2 in floats is 0.30000000000000004; integers make this exact.
    expect(parseDecimalToCents('0.1') + parseDecimalToCents('0.2')).toBe(30);
    expect(parseDecimalToCents('1199.995')).toBe(120000);
    expect(parseDecimalToCents('-50.25')).toBe(-5025);
  });

  it('rejects anything that is not a plain decimal', () => {
    expect(() => parseDecimalToCents('12.3.4')).toThrow();
    expect(() => parseDecimalToCents('abc')).toThrow();
    expect(() => parseDecimalToCents('1e5')).toThrow();
  });
});

describe('allocate', () => {
  it('never loses or invents a cent', () => {
    // 100 split three ways cannot divide evenly; the total must still be exact.
    const parts = allocate(100, [1, 1, 1]);
    expect(sum(parts)).toBe(100);
    expect(parts).toHaveLength(3);
  });

  it('distributes proportionally by weight', () => {
    const parts = allocate(1000, [700, 300]);
    expect(parts).toEqual([700, 300]);
    expect(sum(parts)).toBe(1000);
  });

  it('is exact across many awkward splits', () => {
    for (let total = 1; total <= 300; total++) {
      for (const weights of [[1, 1, 1], [1, 2, 3], [5, 5, 5, 5, 5, 5, 5], [1, 999]]) {
        expect(sum(allocate(total, weights))).toBe(total);
      }
    }
  });

  it('handles zero weights without dropping money', () => {
    expect(sum(allocate(100, [0, 0, 0]))).toBe(100);
  });
});

describe('VAT', () => {
  it('extracts tax from a tax-inclusive price', () => {
    // KES 1160.00 inclusive of 16% VAT -> 160.00 tax, 1000.00 net.
    expect(taxFromInclusive(116000, 1600)).toBe(16000);
    expect(taxFromInclusive(116000, 1600) + 100000).toBe(116000);
  });

  it('returns zero for zero-rated goods', () => {
    expect(taxFromInclusive(50000, 0)).toBe(0);
  });

  it('applies a rate to a tax-exclusive amount', () => {
    expect(applyRate(100000, 1600)).toBe(16000);
  });
});

describe('priceSale', () => {
  const line = (id: string, price: number, qty: number, taxCode: 'STANDARD' | 'ZERO_RATED' = 'STANDARD') => ({
    clientLineId: id,
    variantId: id,
    quantity: qty,
    unitPrice: price,
    taxRateBasisPoints: taxCode === 'STANDARD' ? 1600 : 0,
    taxCode,
    discount: null,
  });

  const options = { pricesIncludeTax: true, cashRoundingIncrement: 0 };

  it('totals a simple tax-inclusive basket', () => {
    const priced = priceSale([line('a', 120000, 2000)], null, options);
    expect(priced.total).toBe(240000);
    expect(priced.taxTotal).toBe(33103);
    expect(priced.netTotal).toBe(240000 - 33103);
  });

  it('handles fractional quantities for weighed goods', () => {
    // 1.5 kg at KES 250.00/kg = KES 375.00
    const priced = priceSale([line('a', 25000, 1500, 'ZERO_RATED')], null, options);
    expect(priced.total).toBe(37500);
    expect(priced.taxTotal).toBe(0);
  });

  it('keeps the order discount exact across lines', () => {
    const priced = priceSale(
      [line('a', 33333, 1000), line('b', 33333, 1000), line('c', 33334, 1000)],
      { type: 'PERCENTAGE', value: 1000, reason: null, promotionId: null },
      options,
    );
    const allocated = priced.lines.reduce((acc, l) => acc + l.allocatedOrderDiscount, 0);
    expect(allocated).toBe(priced.orderDiscountTotal);
    expect(sum(priced.lines.map((l) => l.lineTotal))).toBe(priced.subtotal);
  });

  it('never lets a discount exceed the line value', () => {
    const priced = priceSale(
      [{ ...line('a', 10000, 1000), discount: { type: 'FIXED_AMOUNT', value: 999999, reason: null, promotionId: null } }],
      null,
      options,
    );
    expect(priced.total).toBe(0);
    expect(priced.lineDiscountTotal).toBe(10000);
  });

  it('splits tax correctly across mixed tax codes', () => {
    const priced = priceSale([line('a', 116000, 1000), line('b', 50000, 1000, 'ZERO_RATED')], null, options);
    expect(priced.taxTotal).toBe(16000);
    expect(priced.taxBreakdown).toHaveLength(2);
    const standard = priced.taxBreakdown.find((b) => b.taxCode === 'STANDARD');
    expect(standard?.tax).toBe(16000);
  });

  it('applies cash rounding without breaking the line sum', () => {
    const priced = priceSale([line('a', 10333, 1000)], null, { pricesIncludeTax: true, cashRoundingIncrement: 50 });
    expect(priced.total % 50).toBe(0);
    expect(priced.total).toBe(priced.subtotal + priced.roundingAdjustment);
  });

  it('rejects a zero or negative quantity', () => {
    expect(() => priceSale([line('a', 1000, 0)], null, options)).toThrow();
    expect(() => priceSale([line('a', 1000, -1000)], null, options)).toThrow();
  });

  it('computes tax-exclusive pricing when the store is configured that way', () => {
    const priced = priceSale([line('a', 100000, 1000)], null, { pricesIncludeTax: false, cashRoundingIncrement: 0 });
    expect(priced.taxTotal).toBe(16000);
    expect(priced.total).toBe(116000);
  });
});

describe('changeDue', () => {
  it('returns the difference, negative when short', () => {
    expect(changeDue(240000, 250000)).toBe(10000);
    expect(changeDue(240000, 200000)).toBe(-40000);
  });
});
