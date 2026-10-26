# Testing

Two commands. One proves the system is correct; the other lets you use it.

```bash
make verify      # every automated check, about 5–7 minutes
make demo        # start it up and click through it yourself
```

---

## `make verify` — the automated pass

Run this after any change. It is the same set of checks CI runs, and it starts
whatever it needs (PostgreSQL included) and stops what it started.

It covers, in order:

| Stage | What it proves |
|---|---|
| Typecheck | No type errors anywhere in the monorepo |
| Unit tests | Money, VAT, discounts, crypto, TOTP, CSV escaping, redaction |
| Integration tests | Real PostgreSQL: oversell locking, idempotency, rollback, RBAC |
| Production build | The app compiles and the service worker precaches correctly |
| Browser tests | The real UI, end to end, **including offline with the network cut** |
| Dependency audit | No high or critical vulnerabilities |

A green run currently means 83 unit/integration tests and 15 browser tests
passed. Credit ledger posting and reconciliation are checked at the API layer,
and account list/detail access is checked in the production browser build.

If something fails it prints the failing assertion and keeps the logs, telling
you where.

### Running one part on its own

```bash
make test        # unit + integration only (fastest feedback while coding)
make typecheck   # types only
make e2e         # browser tests — needs `make demo` running in another terminal
make audit       # dependency vulnerabilities
```

---

## `make demo` — testing it by hand

This builds for production and serves it, which matters: **the service worker
only exists in a production build, so `make dev` cannot be used to test offline.**

```bash
make demo
```

Then open <http://127.0.0.1:4173>. The banner prints the sign-in details and the
barcodes you can scan. Press Ctrl+C to stop everything.

### Sign in

Choose **Email**, then `admin@tigonigrown.com` / `ChangeMe!Admin2024`.

Other seeded accounts share that password:

| Role | Email | Staff code | PIN |
|---|---|---|---|
| Manager | manager@tigonigrown.com | MGR001 | 2468 |
| Cashier | cashier@tigonigrown.com | CSH001 | 1357 |
| Auditor | auditor@tigonigrown.com | AUD001 | 9753 |

### Barcodes to scan

Type into the scan box and press Enter — exactly what a hardware scanner does.

| Barcode | Item | Price | VAT |
|---|---|---|---|
| `6001234500024` | Kenyan AA Coffee 500g | 1,200.00 | standard |
| `6001234500017` | Hass Avocado (per kg) | 250.00 | **zero rated** |
| `6001234500031` | Cotton T-Shirt Navy S | 850.00 | standard |
| `6001234500079` | Bottled Water 1L | 80.00 | standard |

---

## Testing offline for real

The part worth seeing with your own eyes.

1. **Load and sign in as an administrator**, bind this browser profile to one
   store/till, open a shift, and wait until catalogue sync completes. This is
   required before the till can operate offline. Wait for the service worker to
   finish caching. (Check: DevTools → Application → Service Workers shows one
   *activated and running*.)

2. **Go offline.** DevTools (F12) → Network tab → throttling dropdown → **Offline**.
   Or genuinely turn off your wifi — both work.

3. **Reload the page.** It still loads. This is the thing that was broken before:
   without a service worker you would get a browser error page and the shop stops.

4. **Sell something.** Scan a cached item, take a cash payment, complete the
   sale. Electronic and customer-account tenders are disabled offline. The
   receipt is labeled `OFFLINE-…` and the badge shows **Offline · 1 queued**.

5. **Go back online.** Set throttling to *No throttling*. Within about twenty
   seconds the badge returns to **Online** and the queue empties. You can click
   the badge to sync immediately.

6. **Check it arrived.** Go to **Sales** — the sale is there with a real receipt
   number, marked as created offline. Confirm the local queued count is zero.

Do not clear the browser profile or reinstall/reset this till while the queued
count is nonzero. Browser storage persistence is requested where supported, but
local browser data is not part of the server backup.

### The thing worth trying twice

While offline, sell the same basket twice. Both are queued. When they sync, you
get **two** sales — correct, because they were two real sales.

Now try the other case: complete a sale, then reload the page before sync
finishes, and let it sync. You get **one** sale, not two. That is the idempotency
key doing its job — the automated tests cover this, but it is satisfying to watch.

---

## What the automated tests deliberately do not cover

Be aware of these when judging readiness:

- **Thermal printing.** Needs a physical printer. Configure it under
  Settings → Receipt printer, then use *Print test receipt*. The browser fallback
  works without hardware but is not a real receipt.
- **Cash drawer.** Fires through the printer, so it needs one.
- **PDQ hardware.** Needs the client's acquirer terminal and a compatible ECR
  bridge. The simulator is not a live payment. Current checkout does not resolve
  asynchronous pending terminal results.
- **Scales and customer displays.** No hardware protocol is implemented.
- **M-PESA.** No Daraja credentials, so the live path has never run. The code is
  written to the documented API and the callback handling is covered by tests,
  but it has not spoken to Safaricom.
- **QuickBooks.** Same: the mapping, queue and item creation are built and
  unit-tested, never run against a real company file.
- **eTIMS.** Not built. Needs KRA onboarding first.

---

## Poking at it directly

The database is a normal PostgreSQL on port 5433:

```bash
psql -h 127.0.0.1 -p 5433 -U pos -d pos
```

Two queries worth knowing:

```sql
-- The core invariant: the stock ledger and the cached balance must agree.
-- This must return zero rows, always.
SELECT sl.store_id, sl.variant_id, sl.quantity_on_hand, COALESCE(m.total, 0) AS ledger
  FROM stock_levels sl
  LEFT JOIN (SELECT store_id, variant_id, SUM(quantity_delta) AS total
               FROM stock_movements GROUP BY store_id, variant_id) m
    ON m.store_id = sl.store_id AND m.variant_id = sl.variant_id
 WHERE sl.quantity_on_hand <> COALESCE(m.total, 0);

-- Takings must equal what the payments ledger says was collected.
SELECT (SELECT COALESCE(SUM(total), 0) - COALESCE(SUM(amount_refunded), 0)
          FROM sales WHERE status <> 'VOIDED') AS net_sales,
       (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
          JOIN sales s ON s.id = p.sale_id
         WHERE s.status <> 'VOIDED' AND p.status <> 'REVERSED') AS net_payments;
```

### Starting fresh

```bash
dropdb -h 127.0.0.1 -p 5433 -U pos pos && createdb -h 127.0.0.1 -p 5433 -U pos pos
make migrate && make seed
```

In the browser, clear the till's local data with DevTools → Application →
Storage → *Clear site data*. That forgets the till binding and cached catalogue,
so you can test first-run setup again.
