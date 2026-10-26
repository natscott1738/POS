# QuickBooks — going live

Everything is built and unit-tested. What remains is credentials, a mapping, and
a sandbox proving run. Budget **half a day of your time plus an hour of your
accountant's**, spread over a few days while the sandbox runs.

---

## What you need from Intuit

### 1. A QuickBooks Online subscription

The client's own company file. Note which **region** — QuickBooks Kenya uses the
global edition, and VAT handling differs from the US edition.

### 2. An Intuit Developer account and app

1. Sign up at <https://developer.intuit.com> (free)
2. **Create an app** for QuickBooks Online and select the **Accounting** scope.
   This POS requests accounting access only; it does not request the QuickBooks
   Payments scope.
3. Under **Keys & credentials** you get two sets:
   - **Development keys** — for the sandbox, available immediately
   - **Production keys** — released after Intuit reviews the app

You need these three values:

```
QB_CLIENT_ID=
QB_CLIENT_SECRET=
QB_REDIRECT_URI=https://your-domain/api/v1/quickbooks/callback
```

### 3. Register the redirect URI

In the app's settings, add the exact callback URL to **Redirect URIs**. It must
match `QB_REDIRECT_URI` character for character, including `https` and any
trailing path. A mismatch is the single most common reason the connect flow fails.

**This means you need the domain and TLS sorted first** — Intuit will not accept
an `http://` redirect for production.

### 4. Production approval

Intuit reviews the app before releasing production keys. They check the OAuth
flow behaves, tokens are handled properly, and the app does what it claims.
Allow **a few days to a couple of weeks**. Start in the sandbox meanwhile; the
only thing that changes afterwards is the credentials and `QB_ENVIRONMENT`.

---

## Configuration

```bash
QB_ENABLED=true
QB_ENVIRONMENT=sandbox          # then: production
QB_CLIENT_ID=<from Intuit>
QB_CLIENT_SECRET=<from Intuit>
QB_REDIRECT_URI=https://your-domain/api/v1/quickbooks/callback
QB_SYNC_INTERVAL_SECONDS=300
```

The API refuses to start with `QB_ENABLED=true` and any of these missing — a
half-configured integration failing at boot is far better than failing mid-trade.

---

## Connecting

1. Sign in as an admin → **QuickBooks** in the sidebar
2. **Connect to QuickBooks** → consent at Intuit → you land back on the page
3. Fill in the **account mapping** (below)

Tokens are stored AES-256-GCM encrypted, bound to the store's row id. The
plaintext exists only in memory during a request.

---

## The mapping — the part that needs your accountant

**Nothing posts until this is complete.** That is deliberate: a guessed account
is far more expensive to unpick than a blocked queue.

The screen reads your real chart of accounts from QuickBooks, so these are
dropdowns, not free text.

| Field | What to choose | Why it matters |
|---|---|---|
| **Sales income account** | The income account takings belong to | Where revenue lands |
| **Default deposit account** | Fallback for any tender with no specific account | Catch-all |
| **Standard VAT code** | The accountant-approved standard rate code | Drives the VAT posting |
| **Zero-rated / exempt VAT codes** | Map each code used in the POS catalogue | Prevents taxable items falling into the wrong category |
| **Cash rounding account** | Income account, if the till uses cash rounding | Keeps rounded receipt totals aligned |
| **Payment method accounts** | **One per tender** | See below |

This integration currently posts one document per sale. Daily summary posting is
not implemented; do not configure the stored legacy `DAILY_SUMMARY` value as if
it changes the worker's behavior.

### Map each tender to its own account

The one recommendation I would push hard:

```
CASH   → Cash on hand / Undeposited funds
MPESA  → M-PESA settlement account
PDQ    → Card settlement account
```

If all three land in one account, **bank reconciliation becomes guesswork** —
M-PESA settles on a different schedule from card, and neither matches the cash
banked. Separating them is painful to retrofit once months of entries exist.

---

## What posts, and when

| POS event | QuickBooks document |
|---|---|
| Sale paid at the till | **SalesReceipt**, deposited to that tender's account |
| Sale on account | **Invoice** (so it shows in A/R) |
| Refund | **RefundReceipt** |
| Void | SalesReceipt voided — number kept, amounts zeroed |
| First sale of a product | **Item** created automatically |

### Items are created automatically

QuickBooks rejects a sale referencing an item that does not exist. Before posting
a sale, any variant not yet in QuickBooks is created as a **NonInventory** item
named by its SKU.

NonInventory is deliberate: this system is the authority on stock levels. Letting
QuickBooks track them too guarantees the two disagree within a week.

If an item already exists in QuickBooks with that name, it is adopted rather than
duplicated.

### Enqueue is transactional

A sale enqueues for QuickBooks **inside the same transaction that commits it**.
Accounting cannot miss a sale that was recorded. If QuickBooks is down, the queue
grows and drains later; the till never slows down.

---

## Proving it in the sandbox

Do this before touching the live company file.

1. Connect to the **sandbox** company
2. Complete the mapping
3. Put through, on the till: a cash sale, an M-PESA sale, a split-payment sale,
   a partial refund, and a void
4. **QuickBooks → Sync now**
5. Open the sandbox company and check each document
6. **Have the accountant look at them** and confirm the postings are what they
   expect — this is the step that catches mapping mistakes while they are free

Then switch `QB_ENVIRONMENT=production`, swap the credentials, and reconnect.

---

## Deferring it (and why that is safe)

You can go live with `QB_ENABLED=false` and lose nothing.

Sales enqueue **regardless** of whether the integration is on; the worker simply
skips. Every sale from day one sits in the queue as `PENDING`. The day you flip
the flag, the backlog drains on its own. No backfill, no gap.

Two caveats:

- Defer by **months, not a year** — draining a year at once hits QuickBooks API
  rate limits, and a year is a long time to discover the mapping was wrong.
- If you backfill a date range deliberately, `POST /quickbooks/sync` with
  `from`/`to` is capped at one year per call.

---

## When sync stops

**QuickBooks → status** shows connection state, whether the mapping is complete,
queue depth, and `reconnectBy`.

| Symptom | Cause | Fix |
|---|---|---|
| Queue growing, `lastSyncError` set | Usually a mapping problem | Fix the mapping, then **Retry** |
| `reconnectBy` approaching | QuickBooks expires refresh tokens after ~100 days of disuse | Reconnect before that date |
| Jobs in `DEAD_LETTER` | Permanently rejected — validation, deleted account | Fix the cause, then **Retry** |
| Nothing posting at all | Mapping incomplete | Finish the mapping screen |

Dead-lettered jobs never block the queue head, so one bad record cannot stop
accounting.

---

## Checklist

- [ ] QuickBooks Online subscription, region confirmed
- [ ] Intuit Developer account and app created
- [ ] Development keys obtained
- [ ] Domain and TLS live (needed for the redirect URI)
- [ ] Redirect URI registered, matching exactly
- [ ] Production approval requested
- [ ] `QB_*` configured, API restarts cleanly
- [ ] Connected to the sandbox
- [ ] Mapping complete, each tender on its own deposit account
- [ ] Five test transactions posted and checked
- [ ] **Accountant has signed off on the postings**
- [ ] Production keys received, `QB_ENVIRONMENT=production`, reconnected
