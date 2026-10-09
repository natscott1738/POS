import { bigint, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Money: always an integer count of minor units. Never numeric/float. */
export const cents = (name: string) => bigint(name, { mode: 'number' });

/** Quantities in thousandths of a unit so 0.25 kg is exact. */
export const qty = (name: string) => bigint(name, { mode: 'number' });

export const pk = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);

export const tsCol = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const createdAt = () => tsCol('created_at').notNull().defaultNow();
export const updatedAt = () => tsCol('updated_at').notNull().defaultNow();
