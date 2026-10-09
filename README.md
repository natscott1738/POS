# Backyard POS

Retail point of sale for Kenyan trading: fast checkout, M-PESA and card (PDQ)
payments, inventory with variants, QuickBooks Online posting, and tills that keep
selling when the internet does not.

Built security-first. The reasoning behind each control is in
[docs/SECURITY.md](docs/SECURITY.md).

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| API | Fastify 5 + TypeScript | Fast, small surface, schema-first validation |
| Database | PostgreSQL 16 + Drizzle ORM | Typed SQL, real migrations, no string-built queries |
| Money | `BIGINT` minor units | Floating-point currency is a correctness bug |
| Auth | Argon2id, 15-min JWT, rotating refresh cookies, TOTP | Short-lived tokens, replay detection |
| Till | React 18 + Vite + Dexie + service worker | Genuinely offline: the app loads with no network at all |
| Receipts | ESC/POS over WebUSB or a local bridge | Real 80mm thermal output and a cash-drawer kick |
| Sync | Append-only outbox + idempotency keys | A sale can never be lost or double-applied |

## Quick start

```bash
make install

cp .env.example .env
make keys                    # prints the secrets; paste them into .env

createdb pos                 # or point DATABASE_URL at any Postgres 14+
make migrate
make seed                    # development accounts; prints the credentials

make dev                     # API on :4000, till on :5173
```

Open <http://localhost:5173>. The till proxies `/api` to the API on the same
origin, so cookies behave in development exactly as they will in production.

`.env` is read automatically from the repo root — real environment variables
always take precedence, so the file can never silently override what your
platform already set. Set `SKIP_DOTENV=true` to ignore it entirely (the Docker
images do this; config comes from the orchestrator).

`make seed` prints the store id, terminal id and sign-in details. Paste the
terminal id into the till's sign-in screen once; it is remembered per device.

### Docker

```bash
cp .env.example .env && make keys   # fill in .env
make up                             # db + api + web
```

Terminate TLS in front of the `web` container. `COOKIE_SECURE=true` and the
`__Host-` cookie prefix both require HTTPS, and the API refuses to start in
production without them.

## Layout

```
packages/shared/     Validation schemas, permission matrix, money + pricing engine
                     (imported by BOTH sides, so till and server agree to the cent)
apps/api/
  src/config/        Environment validation; the process will not boot if it is wrong
  src/core/          Crypto, errors, audit, idempotency, validation
  src/auth/          Passwords, TOTP, token rotation, RBAC, manager override
  src/db/            Drizzle schema, migrations, seed
  src/modules/       auth, catalog, inventory, customers, sales, payments,
                     quickbooks, reports, sync, admin, health
  src/jobs/          Encrypted backups, scheduler
apps/web/
  src/lib/           Offline database, API client, sync engine, cart
  src/screens/       Till, payment, sales, inventory, reports, settings
infra/               nginx config for the production image
```

## How the moving parts fit together

### Money

Every amount is an integer count of cents. `packages/shared/src/money.ts` is the
only place arithmetic happens, and `allocate()` uses largest-remainder
distribution so splitting a discount across lines never loses or invents a cent.

Prices are VAT-inclusive by default (the Kenyan retail norm); tax is *extracted*
rather than added. A store can switch to tax-exclusive pricing per outlet.

### Pricing is computed twice

The till prices the basket locally so it works offline. The server then re-prices
from its own catalogue using `priceSale()` — the same function — and compares the
result to the total the till declared. They must agree exactly.

A client that sends a tampered price is refused (`UNBALANCED_SALE`) unless the
actor holds `sale:price:override`, in which case the override is recorded as its
own audit event.

### Offline

Two halves, and both matter:

1. **The app loads without a network.** A service worker precaches the shell, so
   a cashier who reloads during an outage gets the till, not a blank page. Tested
   in a real browser with the network fully cut.
2. **Work is queued and replayed safely.** Tills cache the catalogue in IndexedDB
   and queue sales locally. On reconnect the queue is pushed as an ordered batch;
   each operation carries a client-minted UUID that the server records in
   `idempotency_keys`. Replaying a batch after a dropped connection returns the
   original receipt numbers and changes nothing.

App updates are never applied mid-sale: a new version waits until the basket is
empty and the person running the till agrees.

Offline sales are accepted even when they take stock negative — the sale already
happened, and refusing it would lose revenue — but they are flagged `oversold`
for review.

### Payments

- **M-PESA** — STK push via Daraja. The local record is written *before* the push,
  so a payment with no callback is still reconcilable. A poller queries Daraja for
  anything unanswered, and unmatched paybill receipts are held for manual matching.
  A unique index on the confirmation code makes it impossible to settle two sales
  with one payment.
- **PDQ** — pluggable provider interface. `ECR_HTTP` talks to a bridge on the
  till's own loopback next to the card reader; `SIMULATOR` is for development.
  Card data never reaches this system: only a masked PAN and an auth code are
  stored. A terminal timeout is reported as *pending*, never as declined, because
  the card may well have been charged.

### QuickBooks

OAuth tokens are stored AES-256-GCM encrypted. Sales enqueue inside the same
transaction that commits them, so accounting cannot miss a sale. A worker drains
the queue with exponential backoff; permanent failures land in `DEAD_LETTER`
rather than blocking the queue head. Nothing posts until the account mapping is
complete — a guessed account is far more expensive to unpick than a blocked queue.

### Receipts

ESC/POS bytes built directly, not a browser print dialog: correct 80mm layout,
VAT breakdown, paper cut and cash-drawer kick. Three transports — WebUSB straight
to the printer, a local bridge for network printers, and a browser fallback for a
shop with no thermal printer yet. Printing happens *after* the sale is recorded,
so a printer fault warns rather than undoing money that has changed hands.

### Backups

`pg_dump → gzip → AES-256-GCM → disk → off-site`, nightly at 02:15 Africa/Nairobi.
Every run is recorded with a SHA-256 checksum that `POST /admin/backups/:id/verify`
re-checks, then copied to S3-compatible storage (AWS, Backblaze, Wasabi, MinIO).
Production refuses to start without both an encryption key and a bucket — a backup
on the same disk as the database is not a backup.

### Alerting

A health sweep every 15 minutes posts to a webhook (Slack, Teams, anything taking
JSON) when a backup goes stale, the off-site copy stops arriving, or a scheduled
job fails. Production will not start without somewhere to send them.

## Commands

```bash
make dev         # API (:4000) + till (:5173), hot reload
make dev-api     # API only
make dev-web     # till only
make e2e         # browser + offline tests (needs a production build)
make test        # unit tests
make typecheck   # all workspaces
make migrate     # apply migrations
make generate    # regenerate SQL after a schema change (builds first)
make audit       # dependency vulnerability check
make keys        # generate secrets
```

## API surface

All routes are under `/api/v1`. Webhooks live at `/api/v1/webhooks/*` and are
deliberately outside the authenticated surface.

| Area | Routes |
|---|---|
| Auth | `login`, `pin-login`, `refresh`, `logout`, `me`, `change-password`, `mfa/*` |
| Catalog | `catalog/products*`, `catalog/products/barcode/:barcode`, `catalog/categories` |
| Inventory | `inventory/levels`, `low-stock`, `alerts`, `movements`, `adjust`, `receipts`, `counts`, `transfers` |
| Sales | `sales`, `sales/:id`, `sales/:id/void`, `sales/refunds`, `sales/by-receipt/:n` |
| Shifts | `shifts/open`, `shifts/current`, `shifts/:id/close` |
| Payments | `payments/mpesa/*`, `payments/pdq/*` |
| Reports | `reports/sales-summary`, `payments`, `tax`, `stock`, `cashiers`, `z-report` |
| QuickBooks | `quickbooks/connect`, `callback`, `status`, `mapping`, `queue`, `sync` |
| Sync | `sync/push`, `sync/pull`, `sync/bootstrap`, `sync/devices`, `sync/time` |
| Admin | `admin/users`, `stores`, `terminals`, `pdq-terminals`, `audit`, `backups`, `settings` |
| Import | `catalog/import/template`, `import/validate`, `import/apply` |

Reports accept `format=json|csv|pdf`. Export is a separate permission from viewing.

## Testing

```bash
make test        # 65 unit + integration tests against a real PostgreSQL
make e2e         # 9 browser tests, including offline with the network cut
```

Integration tests create and drop their own database per run, so they can run in
any order and never see each other's data. They cover the guarantees that only
exist against a real database: the row lock that stops two tills overselling the
last unit, idempotent sync replay, transactional rollback, and cross-store
isolation. Mocking those would prove nothing.

## Before going live

1. `make keys` — never reuse the example values, and keep `ENCRYPTION_KEY`
   distinct from `JWT_SECRET`.
2. Set `MPESA_ALLOWED_IPS` to Safaricom's published egress ranges. The API
   refuses to start in production without it when M-PESA is enabled.
3. Terminate TLS; set `COOKIE_SECURE=true` and an `https://` `PUBLIC_BASE_URL`.
4. Set `ENABLE_DEV_ROUTES=false` (the default; production rejects `true`).
5. Skip `make seed` (it refuses to run in production) and create the first
   administrator with `make create-admin EMAIL=you@example.com`. It prints a
   one-time password that must be changed at first sign-in, and refuses once any
   administrator exists.
6. Give the API a database role with `DML` rights only — not `SUPERUSER`.
7. Restore a backup into a scratch database and confirm it works. An unverified
   backup is not a backup.
8. Run `make audit` in CI and fail on high-severity findings.

### Hosting the till on Vercel

[vercel.json](vercel.json) builds the till from the repository root and proxies
`/api/*` to the API host, so the browser sees one origin and the `SameSite=Strict`
refresh cookie keeps working. When the API moves, change the rewrite destination,
and add the Vercel production URL to the API's `CORS_ORIGINS`: the proxy forwards
the browser's `Origin`, which the API checks.

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model and control detail,
and [docs/OPERATIONS.md](docs/OPERATIONS.md) for day-to-day running.
