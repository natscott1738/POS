import type { Config } from 'drizzle-kit';

export default {
  // drizzle-kit bundles with CJS and cannot resolve the ".js" import specifiers
  // that NodeNext requires in the TypeScript sources, so it reads the compiled
  // schema instead. Run `npm run build` before `db:generate`.
  schema: './dist/db/schema/index.js',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
} satisfies Config;
