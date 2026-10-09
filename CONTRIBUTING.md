# Contributing

## Ground rules

1. **Money is integer cents.** Never a float, never a string in arithmetic. If you
   need a new calculation, add it to `packages/shared/src/money.ts` with a test.
2. **Pricing lives in one place.** `priceSale()` is shared by the till and the
   server so both agree to the cent. Do not compute totals anywhere else.
3. **The sales ledger is append-only.** Voids and refunds are new signed records.
   Never `UPDATE` a sale's amounts.
4. **Stock changes through `applyStockMovement` only.** It locks the row, writes
   the ledger entry and updates the cached balance in one transaction.
5. **Ask for a permission, never a role.** `requirePermissions('sale:void')`, not
   `if (role === 'MANAGER')`.
6. **Validate at the boundary.** Every route parses a Zod schema from
   `@pos/shared`. No schema, no route.
7. **Audit every state change**, inside the transaction it describes.
8. **Money-moving endpoints are idempotent.** Take a client-minted key.

## Workflow

```bash
make install
make migrate && make seed
make dev
```

Before opening a PR:

```bash
make typecheck && make test && make audit
```

### Changing the schema

```bash
make generate     # builds, then regenerates SQL from the Drizzle schema
make migrate
```

Review the generated SQL. Drizzle Kit reads the *compiled* schema, so a build runs
first — `make generate` handles that.

### Adding a permission

Add it to `PERMISSIONS` in `packages/shared/src/permissions.ts` and assign it to
the roles that should hold it. If it needs a manager's approval at the till, add
it to `OVERRIDE_REQUIRED` as well.

## Testing

Unit tests cover the pure, security-critical logic: money, pricing, crypto, TOTP,
CSV escaping, redaction. Add a test whenever you touch any of those.

For anything involving the database, exercise it against a real Postgres — the
concurrency guarantees (`FOR UPDATE`, unique indexes, transactional rollback) are
the point, and a mock proves nothing about them.
