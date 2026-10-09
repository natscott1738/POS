# Security

What this system defends against, how, and what it deliberately does not do.

A POS handles money, staff accountability and customer data on hardware sitting
on a shop floor where the public can reach it. The threats are mostly mundane:
a cashier discounting their friend's basket, a stolen laptop, a tampered client,
a replayed webhook. The controls below target those, not exotic attacks.

---

## Threat model

| Threat | Control |
|---|---|
| Cashier alters prices in the client | Server re-prices from its own catalogue and compares to the declared total; mismatch is refused |
| Cashier voids sales to pocket cash | `sale:void` needs a manager's code + PIN; the approver is recorded on the sale and in the audit log |
| Cashier refunds to their own M-PESA | A refund can only return to a method that was actually tendered, and never more than was collected |
| Stolen session cookie | Refresh tokens rotate on every use; a replayed token revokes the entire session family |
| Stolen laptop / database dump | Argon2id passwords; QuickBooks tokens, TOTP seeds and PDQ secrets AES-256-GCM encrypted; backups encrypted |
| Forged M-PESA callback | Unguessable path token (constant-time compared) + source-IP allowlist + strict schema + idempotent handler |
| Double-charging on a retry | Client-minted idempotency key per sale; a retry returns the original receipt |
| Two tills selling the last unit | `SELECT … FOR UPDATE` on the stock row serialises the decrement |
| Cross-store data access | Every store-scoped route calls `assertStoreAccess`; a manager at one outlet cannot read another |
| Privilege escalation | Only an ADMIN can create or promote to ADMIN; no self-promotion or self-disable |
| Exported CSV attacking the opener | Cells starting `= + - @` are prefixed, defeating formula injection |
| Brute force | Per-IP rate limit, per-identifier throttle, account lockout, uniform error messages and timing |

## Identity

**Passwords** — Argon2id, 19 MiB / t=2 / p=1 (OWASP). Parameters live inside the
digest, so raising them later re-hashes on next sign-in rather than locking anyone
out. Policy follows NIST SP 800-63B: length over composition rules, with a
structural screen for weak *shapes* (common base words with digits bolted on,
keyboard runs, the user's own identifiers).

**Till PIN** — Cashiers sign in with a staff code and a 4–8 digit PIN, but only
from a terminal already registered to their store. A PIN alone is not a
credential; it is only meaningful with physical access to a known till. PINs are
Argon2id-hashed like passwords.

**MFA** — TOTP (RFC 6238), implemented directly rather than pulled in as a
dependency: it is ~50 lines of well-specified HMAC guarding administrative access,
and a smaller supply chain is worth more than the saved code. Secrets are stored
encrypted and enrolment only completes once the user proves a valid code.
Recovery codes are stored hashed.

**Sessions** — 15-minute access tokens (HS256) carrying role, stores and a
`tokenVersion`. The version is re-checked against the database on every request,
so disabling an account or forcing a logout takes effect immediately rather than
at token expiry.

Refresh tokens are opaque, 48 bytes, stored **hashed**, and rotate on every use.
Presenting an already-rotated token means the cookie leaked, so the whole family
is revoked — the OAuth 2.1 reuse-detection pattern.

> The revocation is committed in its own transaction. Doing it inside the
> transaction that then throws would roll the revocation straight back, leaving
> the stolen family alive — a bug this codebase had and now has a test for.

**Cookies** — `__Host-` prefix (origin-locked, `Secure`, `Path=/`, no `Domain`)
when the deployment supports it, falling back to plain names over http in local
development. `HttpOnly` and `SameSite=Strict`. The access token is held in memory
on the client only, never in `localStorage`, so an XSS bug cannot exfiltrate a
long-lived credential.

**CSRF** — The refresh endpoint authenticates from a cookie, so it uses a
double-submit token compared in constant time. Bearer-token routes need no CSRF
check, because a browser will not attach the header on its own.

## Authorisation

Capability-based. Roles bundle permissions; code always asks for a *permission*,
never a role, so re-scoping a role never means touching a route handler.

```
ADMIN    every permission
MANAGER  cashier + voids, refunds, order discounts, price override,
         stock adjustments, reports, QuickBooks sync
CASHIER  create sales, read products and stock, initiate payments, own shift
AUDITOR  read-only across sales, stock, reports and the audit log
```

Privileged actions at the till use **manager override**: the cashier initiates,
a supervisor authorises in person with their staff code and PIN. The approver is
never signed in; their identity is recorded on the record and in the audit trail.
Self-approval is rejected — it would defeat the purpose of a two-person control.

## Money integrity

Amounts are integer cents everywhere: database (`BIGINT`), API, and client.
`parseDecimalToCents` refuses anything that is not a plain decimal. `allocate()`
distributes by largest remainder so the parts always sum to the whole.

Quantities are thousandths of a unit, so 0.25 kg is exact.

The sales ledger is **append-only**. A void or refund is a new signed record, not
an edit. Refund payments are negative rows on the same `payments` table, so
summing `amount` over any period yields net takings with no special case, and a
receipt reprinted a year later still shows what was originally charged.

Stock has the same shape: `stock_movements` is the ledger and `stock_levels` is a
cache updated in the same transaction. The two are checked against each other in
testing and can be reconciled at any time by summing the ledger.

## Input handling

Every route parses through a Zod schema from `@pos/shared`. Anything not
described by a schema is dropped before it reaches the database layer. Text
fields are length-capped and reject C0/C1 control characters, which otherwise
corrupt receipt printers and log files.

All SQL goes through Drizzle's parameterised builder. The few raw fragments are
tagged templates with bound parameters, never string concatenation.

## Webhooks

`/api/v1/webhooks/*` is unauthenticated by necessity and defended in layers:

1. Unguessable path segment, compared in constant time
2. Source-IP allowlist (CIDR-aware); **required in production** for M-PESA
3. Strict schema validation
4. Idempotent handlers — a terminal state is never re-opened by a replay
5. Its own rate limit

A *malformed* callback is acknowledged rather than retried, because it will never
become valid and Safaricom would otherwise retry it forever. A *transient
failure* returns 500 so the retry is genuinely useful.

## Secrets

`ENCRYPTION_KEY` (AES-256-GCM) protects QuickBooks tokens, TOTP seeds and PDQ
bridge credentials. Ciphertext is versioned (`v1.iv.tag.data`) and
`ENCRYPTION_KEY_PREVIOUS` allows rotation without a flag day.

Where a secret belongs to a specific row, the row id is bound in as additional
authenticated data, so a valid blob cannot be moved to another row and still
decrypt.

Configuration is validated at boot and the process **exits** if anything required
is missing or weak. There are no fallback secrets: a POS that boots with a default
signing key has already been compromised. Production additionally refuses
`ENABLE_DEV_ROUTES=true`, `COOKIE_SECURE=false`, an `http://` public URL, M-PESA
without an IP allowlist, backups without an encryption key, and
`ENCRYPTION_KEY == JWT_SECRET`.

## Card data

The card terminal handles the PAN. This system stores only a masked value and an
auth code, and `maskPan()` re-masks defensively even if a bridge misbehaves. No
PAN, track data or CVV is ever accepted, logged or persisted, which keeps the
deployment out of PCI-DSS scope beyond SAQ-C-VT. Confirm the scope with your
acquirer.

## Audit

Every state-changing request writes one append-only row: actor, override approver,
store, terminal, action, entity, redacted diff, reason, IP, user agent, request id.
Audit rows are written inside the transaction they describe, so an audit trail
that disagrees with the data is not possible.

A redaction pass strips passwords, PINs, tokens, secrets and card fields before
anything is stored — the audit log is queryable by auditors and must not become a
second home for credentials. The same redaction applies to request logs.

## Data protection

Customer marketing consent is explicit and timestamped. Deleting a customer
clears their identifiers but keeps the sales ledger intact, satisfying erasure
without destroying financial records. Phone numbers are masked in logs.

## Backups

`pg_dump → gzip → AES-256-GCM`, with the IV and auth tag in the file header.
Directory `0700`, files `0600`. A partial file from a failed run is deleted so it
can never be mistaken for a usable backup. Each run records a SHA-256 checksum
that `verifyBackup` re-checks to catch silent disk corruption.

**Restore-test your backups.** Nothing here proves a dump restores; only a restore
does.

## What this does not do

- **No HTTPS termination.** Run it behind a reverse proxy or load balancer.
- **No secrets manager.** Configuration comes from the environment. Use your
  platform's secret store; do not commit `.env`.
- **No WAF or DDoS protection.** Rate limiting blunts brute force, not volumetric
  attacks.
- **No key management service.** `ENCRYPTION_KEY` is an environment variable. A
  KMS or HSM would be better for a large estate.
- **No intrusion detection.** The audit log supports investigation; it does not
  alert.
- **Not penetration tested.** Commission one before handling real money.

## Reporting a vulnerability

Do not open a public issue. Contact the maintainer directly with reproduction
steps and an assessment of impact.
