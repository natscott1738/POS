import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sql, closeDb } from './client.js';

/**
 * Applies pending migrations. Run this before starting the API; the server does
 * not migrate on boot, because several instances starting at once would race.
 */
async function main(): Promise<void> {
  // pgcrypto provides gen_random_uuid(), which every table's primary key uses.
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  // Trigram index support for fast product name search.
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;

  await migrate(db, { migrationsFolder: './drizzle' });

  // Indexes that Drizzle cannot express declaratively but the till depends on.
  await sql`
    CREATE INDEX IF NOT EXISTS products_name_trgm_idx
    ON products USING gin (name gin_trgm_ops)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS variants_sku_trgm_idx
    ON product_variants USING gin (sku gin_trgm_ops)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS customers_name_trgm_idx
    ON customers USING gin (full_name gin_trgm_ops)
  `;

  // eslint-disable-next-line no-console
  console.log('migrations applied');
  await closeDb();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error('migration failed', err);
  await closeDb().catch(() => {});
  process.exit(1);
});
