import { z } from 'zod';

export const uuid = z.string().uuid();
export const cents = z.number().int().safe();
export const nonNegativeCents = cents.min(0);
export const positiveCents = cents.min(1);
/** Quantities are stored in thousandths so 0.25 kg is exact. */
export const quantityMilli = z.number().int().safe();
export const positiveQuantityMilli = quantityMilli.min(1);

export const basisPoints = z.number().int().min(0).max(100_000);

/** C0/C1 control characters corrupt receipt printers and log files, so reject them outright. */
export function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Free text that will be rendered on receipts / stored: length-capped and control-char free. */
export const safeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !hasControlChars(v), 'contains control characters');

export const optionalSafeText = (max: number) => safeText(max).optional().nullable();

export const isoDate = z.string().datetime({ offset: true });

/** Kenyan MSISDN, normalised to 2547XXXXXXXX / 2541XXXXXXXX. */
export const msisdn = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s()-]/g, ''))
  .refine((v) => /^(?:\+?254|0)?(7|1)\d{8}$/.test(v), 'invalid Kenyan phone number')
  .transform((v) => {
    const digits = v.replace(/^\+?254/, '').replace(/^0/, '');
    return `254${digits}`;
  });

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});

export const dateRangeQuery = z
  .object({
    from: isoDate,
    to: isoDate,
    storeId: uuid.optional(),
  })
  .refine((v) => new Date(v.from) <= new Date(v.to), { message: 'from must be <= to', path: ['from'] });

export type Pagination = z.infer<typeof paginationQuery>;
export type DateRange = z.infer<typeof dateRangeQuery>;
