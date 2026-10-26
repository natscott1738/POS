# Operations

Day-to-day running: setting up a store, connecting integrations, and what to do
when something breaks.

---

## First-time setup

### 0. Create the first administrator

A fresh production database has no users, and the seed refuses to run there.
Create the first administrator from the server:

```bash
make create-admin EMAIL=you@example.com NAME="Your Name"   # optional: STAFF_CODE=ADM001
```

It prints a one-time password (and a till PIN when a staff code is given) that
must be changed at first sign-in. It refuses once any administrator exists;
create every further account through the API as that administrator, so each one
is authenticated and audited against a real person.

### 1. Create the store and tills

```bash
# Sign in as an admin, then:
POST /api/v1/admin/stores
  { "code": "MAIN", "name": "Main Store", "taxPin": "P051234567X",
    "pricesIncludeTax": true }

POST /api/v1/admin/terminals
  { "storeId": "…", "code": "T1", "name": "Front counter", "receiptPrefix": "MAINT1" }
```

`receiptPrefix` must be unique across the estate. Receipt numbers are allocated
per terminal by atomic increment, so two tills can never mint the same number and
a **gap in the sequence is evidence of a failed or deleted transaction**, not a
race. Investigate gaps.

### 2. Register each till as a sync device

```bash
POST /api/v1/sync/devices
  { "deviceId": "<uuid the till generated>", "storeId": "…", "terminalId": "…",
    "label": "Counter tablet" }
```

A till cannot push offline work until it is registered. Revoking a device
(`DELETE /api/v1/sync/devices/:deviceId`) stops a lost tablet from syncing without
disturbing any other till.

### 3. Create staff

Give every cashier a `staffCode` and PIN so they can sign in at the till. Managers
need one too — it is what they use to authorise overrides.

All created accounts have `mustChangePassword` set; the temporary password is
shown once and never stored in the clear.

## Shifts and cash

A cashier opens a shift with the float in the drawer, and closes it with the
counted cash. Expected cash is derived from the payments ledger, never trusted
from the client, and the variance is recorded.

```
expected = openingFloat + (cash in − cash refunded)
variance = counted − expected
```

Persistent negative variance on one cashier is the signal worth watching. The
Z-report (`GET /api/v1/reports/z-report?shiftId=…&format=pdf`) is the end-of-shift
statement.

## Customer credit

Credit accounts are opened for a customer at a specific store. A manager sets the
limit and payment terms under **Credit accounts**. Cashiers can view accounts,
charge eligible sales to account, and record repayments; only managers can open
accounts, change limits, deactivate accounts or post manual adjustments.

- Account sales require a customer, an active account and a live server check.
  The sale is refused if it would exceed the available limit.
- Each account sale is a dated receivable. Repayments are allocated to the oldest
  open invoice first. The activity view shows the original sale date, due date,
  remaining invoice amount, repayment and running balance.
- Record the bank transfer reference or M-PESA confirmation code when collecting
  those tenders. Duplicate references are rejected. Cash collections require an
  open shift so they appear in the drawer close.
- Voiding an account sale reverses its receivable. If a payment or credit has
  already been applied to that invoice, process a refund instead.
- An account refund reduces the original receivable; if the invoice has already
  been settled, the remaining amount becomes customer credit for later purchases.
- Do not use a manual adjustment to record money received. Use **Record payment**
  so the receipt, invoice allocation and shift reconciliation are preserved.

Account sales enqueue a QuickBooks invoice using the account's due date.
Repayments enqueue a QuickBooks customer payment linked to settled invoices.
Prove account sales, partial repayments, multiple-invoice allocation, refunds and
voids in the QuickBooks sandbox with the client's accountant before relying on
that flow; see [docs/QUICKBOOKS.md](QUICKBOOKS.md).

## M-PESA

### Configuration

```
MPESA_ENABLED=true
MPESA_ENVIRONMENT=production   # use sandbox while testing
MPESA_SHORTCODE=            # BusinessShortCode used at Go-Live
MPESA_PARTY_B=              # STK recipient; defaults to MPESA_SHORTCODE
MPESA_PASSKEY=              # from Daraja for this shortcode/product
MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline   # till; PayBill for paybill
MPESA_CALLBACK_TOKEN=       # openssl rand -hex 24
MPESA_ALLOWED_IPS=          # required for live M-PESA on a production server; optional in sandbox
```

Register this callback URL with Safaricom:

```
https://<your-domain>/api/v1/webhooks/mpesa/stk/<MPESA_CALLBACK_TOKEN>
```

Treat the token as a secret. Rotating it means re-registering the URL.

### When a payment goes missing

1. The till polls `GET /api/v1/payments/mpesa/:id` while the customer responds.
2. If no callback arrives, a background job queries Daraja every minute and marks
   the record `AUTHORIZED`, `FAILED` or `CANCELLED`.
3. A record left `AUTHORIZED` means Safaricom says it succeeded but the callback
   never landed. Confirm the code with the customer and match it manually:

```bash
POST /api/v1/payments/mpesa/match
  { "saleId": "…", "confirmationCode": "SFE4G8H2K1", "amount": 240000 }
```

The unique index on `confirmation_code` means the same payment can never settle
two sales. If the code is already used, that is a real duplicate — investigate
rather than override.

### Paybill payments made before the till asked

They land in `mpesa_unmatched_payments`. List them with
`GET /api/v1/payments/mpesa/unmatched` and match as above.

### Short payments

If the customer pays less than requested, the record is captured but deliberately
**not** auto-reconciled. A human decides whether to accept it, chase the balance
or refund. The till warns; it does not decide.

## Card terminals (PDQ)

`PDQ_PROVIDER=ECR_HTTP` expects a bridge on the till's own loopback address
speaking:

```
POST /ecr/sale     { transactionRef, amountMinor, currency, reference, deviceSerial }
POST /ecr/reverse  { transactionRef }

→ { approved, pending, authCode?, maskedPan?, cardScheme?,
    responseCode?, responseMessage?, terminalReceipt? }
```

Amounts are in **minor units** on the wire to avoid decimal ambiguity. The bridge
must never return a full PAN; the API re-masks defensively regardless.

Register terminals with `POST /api/v1/admin/pdq-terminals`. The shared secret is
encrypted at rest, bound to the terminal's row id, and never returned by the API.

### A terminal that does not answer

Reported as **pending**, never as declined — the card may have been charged.
Check the card machine's own journal before retrying. Pending authorisations not
attached to a sale expire automatically and can be reversed with
`POST /api/v1/payments/pdq/reverse`.

`SIMULATOR` is for development: any amount ending in `.13` is declined, so the
decline path stays testable end to end.

## QuickBooks

### Connecting

1. `GET /api/v1/quickbooks/connect?storeId=…` returns an authorisation URL.
2. The user consents at Intuit and is redirected back.
3. Configure the account mapping — **nothing syncs until this is complete**.

`GET /api/v1/quickbooks/accounts` and `/tax-codes` populate the mapping screen
from the customer's real chart of accounts, so nothing is typed by hand.

### What posts

| POS record | QuickBooks |
|---|---|
| Sale, paid at the till | SalesReceipt, deposited to the tender's mapped account |
| Sale on account | Invoice |
| Refund | RefundReceipt |
| Void | SalesReceipt voided (document number kept, amounts zeroed) |

Enqueue happens inside the transaction that commits the sale, so accounting
cannot miss a sale that was committed.

### When sync stops

`GET /api/v1/quickbooks/status?storeId=…` reports connection state, whether the
mapping is complete, queue depth, and `reconnectBy`.

- **Queue growing, `lastSyncError` set** — usually a mapping problem. Fix the
  mapping, then `POST /api/v1/quickbooks/queue/retry` to requeue dead letters.
- **`reconnectBy` approaching** — QuickBooks refresh tokens expire after ~100 days
  of disuse. Reconnect before that date or sync stops entirely.
- **Jobs in `DEAD_LETTER`** — permanently rejected (validation, deleted account).
  They never block the queue head; fix the cause and retry.

### Backfilling

```bash
POST /api/v1/quickbooks/sync
  { "storeId": "…", "from": "2026-01-01T00:00:00Z", "to": "2026-03-31T23:59:59Z" }
```

Capped at one year per call.

## Offline operation

Tills cache the catalogue locally and queue sales. The status pill in the top bar
shows connection state and queue depth.

**What works offline:** scanning, cached pricing, discounts, cash payments and
configured local printing.

**What does not:** M-PESA (including typing a confirmation code), card and credit
payments, live stock levels, reports. Only cash tenders can be finalized offline.
An already-added electronic tender cannot be completed after the server becomes
unreachable; reconnect and confirm it with the provider first.

The till requests persistent browser storage where supported. This is best effort:
do not clear the browser profile or reinstall/reset the till until the queued count
is zero. The offline session is valid for up to 14 days from the last successful
online sign-in. Rejected queued operations stay in Settings for staff review and
are not retried automatically. An operation stuck in `SENDING` is reclaimed after
its two-minute lease expires.

### When a queued sale is rejected

Rejected operations stay on the till, marked `FAILED`, and appear in Settings.
They are *not* retried forever, because a rejection will not fix itself. The
usual causes:

- A product was deleted while the till was offline — reinstate it, then re-sync.
- Stock went negative — the sale is accepted and flagged `oversold`; correct the
  count.
- Prices changed — the sale is re-priced against the price effective at `soldAt`
  and flagged `repricedOnSync`.

Sales flagged `oversold` or `repricedOnSync` deserve a daily review:

```sql
SELECT receipt_number, sold_at, total, oversold, repriced_on_sync
FROM sales
WHERE (oversold OR repriced_on_sync) AND sold_at > now() - interval '7 days'
ORDER BY sold_at DESC;
```

### Clock drift

A till with a badly wrong clock cannot post future-dated revenue — sales more
than 5 minutes ahead are refused. `GET /api/v1/sync/time` lets a till detect drift.

## Backups

Nightly at 02:15 Africa/Nairobi, encrypted, checksummed, retained 30 days.

```bash
GET  /api/v1/admin/backups               # history + health
POST /api/v1/admin/backups/run           # on demand
POST /api/v1/admin/backups/:id/verify    # re-check the checksum
```

`health.healthy` is false if no successful backup completed in 36 hours. **Alert
on this.**

### Restoring

```bash
# Decrypt: [12-byte IV][16-byte GCM tag][ciphertext]
python3 - <<'PY'
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import sys, gzip
key = bytes.fromhex(open('backup.key').read().strip())
blob = open('pos-daily-….sql.gz.enc','rb').read()
iv, tag, data = blob[:12], blob[12:28], blob[28:]
open('restore.sql','wb').write(gzip.decompress(AESGCM(key).decrypt(iv, data + tag, None)))
PY

createdb pos_restore_test
psql pos_restore_test < restore.sql
```

Always restore into a **scratch** database first. Practise this before you need it.

## Monitoring

| Signal | Where | Alert when |
|---|---|---|
| Readiness | `GET /health/ready` | non-200 |
| Backup health | `GET /api/v1/admin/backups` | `healthy: false` |
| QuickBooks queue | `GET /api/v1/quickbooks/status` | dead letters > 0, or pending climbing |
| Failed logins | `login_attempts` | spike per identifier or IP |
| Oversold sales | `sales.oversold` | any, daily |
| Cash variance | `shifts.cash_variance` | repeated negatives per cashier |
| Unmatched M-PESA | `mpesa_unmatched_payments` | older than a day |

The API logs structured JSON with a request id echoed as `X-Request-Id`; when a
cashier reports a problem, that id finds the exact request.

## Common problems

**"Session was revoked for security reasons"** — a refresh token was replayed.
Either the cookie leaked, or two tabs raced. If it recurs for one user,
investigate. The user simply signs in again.

**"The till total does not match the server total"** — the till's cached prices
are stale. Rebuild the catalogue from Settings. If it persists, someone is
tampering with the client; check the audit log.

**"This action needs a manager override"** — working as designed. A manager
enters their staff code and PIN at the till.

**Terminal already has an open shift** — a shift was left open. A manager can
close it; one open shift per terminal keeps cash accountability unambiguous.

**Receipt numbers have a gap** — a transaction was allocated a number and then
rolled back, or a record was deleted. Check the audit log for that window.
