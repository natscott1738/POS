# Production readiness checklist

Use this as the launch tracker with the client. It separates work in this
repository from decisions and credentials that only the shop, its providers, or
its accountant can supply. Do not treat a green build as approval to accept live
money. Follow [CLIENT_INTEGRATION_RUNBOOK.md](CLIENT_INTEGRATION_RUNBOOK.md)
for the exact sandbox, provider, hardware and on-site sequence.

## Current repo status

- Credit accounts, receivable ledger, invoice due dates, repayment allocation,
  account adjustments, and shift cash reconciliation are implemented in this
  branch. Run the checks below before merging or deploying them.
- The migration preserves old customer credit settings automatically only when
  there is exactly one active store. For a multi-store database, old global
  customer limits/balances need an explicit store-by-store review before accounts
  are opened.
- The checked-in configuration defaults to sandbox/off for M-PESA and off for
  card payments. This checkout has no supplied live M-PESA or PDQ credentials.
- eTIMS is not implemented. The app's VAT totals and receipts are not eTIMS
  invoices.
- QuickBooks, Safaricom Daraja and a production card reader have not been proven
  against the client's live accounts or hardware.
- Offline checkout is cash-only. The till atomically stores its local sale and
  sync operation, claims uploads with a two-minute crash-recovery lease, backs
  off transport retries, and holds rejected operations for staff review. A
  browser E2E now exercises offline cash sale, stale `SENDING` recovery and
  reconnect sync; see `docs/TESTING.md` for the full run.
- Browser-local queue data is not in the server backup. Storage persistence is
  requested where supported, but clearing/replacing the browser profile while
  work is queued can lose sales. The remembered offline session expires after
  14 days.
- `./scripts/verify.sh` passed on 2026-10-23: 83 unit/API integration tests,
  15 production-browser tests, typechecks, migrations, web build, and no
  high/critical dependency audit findings. Live Daraja, QuickBooks and physical
  PDQ/provider flows remain unproven until the client sandbox credentials and
  hardware are available.

## 1. Client decisions and ownership

- [ ] Name the client owner for go-live approval, an engineering contact, and an
  after-hours incident contact.
- [ ] Confirm the production store list, time zone, currency, legal business name,
  receipt details, tax PIN, and invoice footer for each store.
- [ ] Confirm whether each user role may view all customer debt, record payments,
  issue credit, or change limits. Cashiers currently have account read, charge
  and collection permissions; managers administer accounts.
- [ ] Approve the credit policy: who qualifies, limit approval, payment terms,
  treatment of overdue accounts, cash/transfer receipt process, and who may post
  adjustments or refunds.
- [ ] Decide how staff verify the customer's identity before charging an account
  and how they resolve disputes about a sale or repayment.
- [ ] Confirm the product list, SKU/barcode uniqueness, costs, prices, units, and
  tax code for every sellable item.
- [ ] Have the client's accountant confirm the treatment of account sales,
  repayments, refunds, manual credit adjustments, VAT and opening balances.

## 2. Credit data migration and acceptance

- [ ] Back up the production database and rehearse migration `0004` on a restored
  copy before deploying it.
- [ ] For a one-store database, compare migrated account limits/balances against
  the customer records before enabling account sales.
- [ ] For a multi-store database, review every non-zero legacy `customers.creditLimit`
  and `customers.balance`, decide which store owns it, then open accounts with
  manager approval. The migration deliberately does not copy one global limit to
  every store.
- [ ] Reconcile every opening balance to an invoice, statement or signed customer
  acknowledgement. Keep evidence and the person who approved it.
- [ ] Decide how to handle customers with outstanding balances whose profile is
  inactive or erased. Confirm the required retention and privacy treatment before
  importing personal details or contacting them.
- [ ] Test account creation, limit changes, deactivation/reactivation, over-limit
  refusal, split tender, multiple invoices, partial/full repayment, duplicate
  payment reference, adjustment, account refund, sale void, concurrent checkout,
  and retry after a dropped response.
- [ ] Confirm cash repayment appears in the shift summary and expected drawer
  amount; confirm M-PESA and bank-transfer repayments do not inflate drawer cash.
- [ ] Confirm the account list's overdue amount and invoice due dates against a
  manually calculated sample statement.
- [ ] Decide whether the client needs downloadable statements, 30/60/90-day aging,
  automated reminders, payment receipts by SMS/email, or collections notes. These
  are not part of the current credit screen.
- [ ] Decide how credit repayments via M-PESA will be initiated and reconciled.
  The current account collection form records a staff-entered confirmation code;
  it does not start an STK push for an existing debt.
- [ ] Confirm whether cashier access to the creditor list is acceptable for every
  store, or tighten the role before launch.

## 3. Hosting, transport and secrets

- [ ] Choose and configure production API, PostgreSQL, and web hosting. Document
  region, data residency, support access, maintenance window and restore owner.
- [ ] Put the till behind HTTPS and terminate TLS with current certificates.
  Configure `PUBLIC_BASE_URL`, `CORS_ORIGINS`, secure cookies and the API proxy
  with the final production hostnames.
- [ ] Set `NODE_ENV=production`, `ENABLE_DEV_ROUTES=false`, `COOKIE_SECURE=true`,
  and production-only callback URLs. Confirm the API refuses unsafe values at
  startup.
- [ ] Generate unique secrets for JWT, encryption, backup encryption, callback
  tokens and provider credentials. Store them in the hosting provider's secret
  manager; never commit or paste them into issue trackers or chat.
- [ ] Set a documented rotation owner and recovery procedure for each secret,
  including the M-PESA callback token and encryption key rotation.
- [ ] Use a PostgreSQL role with only the DML rights required by the API. Keep
  migrations on a separate deployment identity; require TLS to managed databases.
- [ ] Set and verify pool limits, connection timeouts, statement timeouts,
  database storage alerts and capacity thresholds for expected till count.
- [ ] Configure the public health/readiness checks, reverse proxy timeouts,
  request-size limits, allowed origins, rate limits and trusted proxy settings.
- [ ] Define deployment order: maintenance/backup, migration, API rollout, web
  rollout, smoke tests, and rollback. Test the rollback path in staging.
- [ ] Verify the service worker update flow with the production domain and the
  deployed proxy; make sure a till does not update mid-sale.

## 4. Safaricom M-PESA production

- [ ] The client completes Daraja onboarding and enables the production product
  for its own business account. Safaricom's [Daraja portal](https://developer.safaricom.co.ke/)
  documents sandbox testing and production setup.
- [ ] Obtain and verify the production consumer key/secret, shortcode, transaction
  type, passkey, and support contact directly with Safaricom. A passkey is needed
  for M-PESA Express/STK push; use the exact product/shortcode approved for this
  merchant ([Safaricom STK documentation](https://developer.safaricom.co.ke/apis/MpesaExpressSimulate)).
- [ ] Confirm that the shortcode is a Buy Goods till or PayBill and set
  `MPESA_TRANSACTION_TYPE` to the matching value. Set `MPESA_SHORTCODE` to the
  Daraja BusinessShortCode and `MPESA_PARTY_B` to the STK recipient when
  Safaricom assigns different values. M-PESA credentials/shortcode are currently
  deployment-wide; clients with different shortcode/app per store need
  per-store configuration first. Test the account reference and settlement
  account.
- [ ] Set `MPESA_ENABLED=true` and `MPESA_ENVIRONMENT=production` only after the
  staging checklist passes. Configure the production callback URL, random
  `MPESA_CALLBACK_TOKEN`, and current Safaricom callback egress IP allowlist.
  Re-check provider-published ranges at launch; do not assume the sample list is
  current.
- [ ] Verify the callback URL is reachable from outside the hosting network over
  HTTPS, the source-IP restriction works, and callback requests are not blocked
  by the web proxy or WAF.
- [ ] In sandbox, test success, customer cancellation, timeout, duplicate and
  out-of-order callbacks, missing callback polling, short payment, unmatched
  paybill receipt, manual match, duplicate confirmation code and reversal review.
- [ ] In production, run an owner-approved low-value payment from a real test
  phone. Confirm the till status, callback, receipt/reference, merchant statement
  and settlement report before opening the till to customers.
- [ ] Assign a person and schedule to reconcile Daraja transactions against POS
  receipts and bank settlement. Document how to handle a charged payment with no
  callback, amount mismatch, duplicate or unmatched receipt.
- [ ] Confirm no test customer or demo phone number is used for live prompts.

## 5. Card terminal / PDQ

- [ ] Choose the bank/acquirer, merchant account, card terminal model, settlement
  account and support contact. Get the acquirer's ECR/protocol kit and written
  deployment requirements.
- [ ] Supply and configure the production bridge/provider. `ECR_HTTP` expects a
  local bridge on the till; `SIMULATOR` is development-only. Verify the bridge
  endpoint, terminal binding, shared secret, certificate and network policy.
- [ ] Verify the API host can actually reach the bridge. The configured default
  `127.0.0.1:9110` is the API process's loopback, not a remote till's loopback.
  Current checkout warns on asynchronous pending card results but does not poll
  them or provide a pending-transaction reconciliation screen. Use only a
  provider/bridge that returns a final synchronous result until that operator
  workflow is implemented.
- [ ] Standalone card approvals are not recorded as POS tenders today. The
  acquirer must supply a compatible ECR bridge or this integration needs a
  vendor adapter before PDQ is enabled.
- [ ] Test approved, declined, customer-cancelled, timeout/pending, reversal,
  duplicate retry and disconnected bridge paths with the actual terminal.
- [ ] Compare terminal totals and masked card references against acquirer
  settlement reports. Define how staff investigate a pending payment before
  retrying it.
- [ ] Confirm the system never receives full PAN, CVV or track data in logs,
  browser storage, bridge responses, support bundles or backups.
- [ ] Confirm the acquirer/provider's PCI DSS responsibilities and the merchant's
  validation scope. PCI SSC says outsourcing does not remove the merchant's
  responsibility to validate compliance; agree scope with the acquirer and use
  the [PCI SSC merchant guidance](https://www.pcisecuritystandards.org/faqs/does-pci-dss-apply-to-merchants-who-outsource-all-payment-processing-operations-and-never-store-process-or-transmit-cardholder-data/).

## 6. eTIMS and Kenyan tax receipts

- [ ] Ask the client's accountant to confirm the business's eTIMS obligations and
  the right onboarding/integration path. KRA's [eTIMS guidance](https://www.kra.go.ke/online-services/etims)
  describes onboarding and system-to-system integration options.
- [ ] If eTIMS is required, complete taxpayer onboarding, obtain test/production
  credentials and technical specifications, select an approved integration path,
  and implement fiscal invoice number/QR, retries, offline handling and status
  reconciliation in this POS.
- [ ] Test fiscal receipts and invoice corrections/refunds with KRA's current
  process before calling a POS receipt a tax invoice. Until that integration is
  complete, use the client's approved eTIMS process alongside the POS.
- [ ] Reconcile product tax codes and store VAT settings to the accountant's
  approved product master and KRA requirements.

## 7. QuickBooks Online

- [ ] Complete Intuit app review, production credentials, redirect URL and company
  consent. Connect to the client's actual company file only after sandbox signoff.
- [ ] Use the QuickBooks Online Accounting scope. Development keys belong to the
  sandbox; use the Intuit Production keys and exact `/api/v1/quickbooks/callback`
  redirect for the live company. Per-sale posting is supported; daily-summary
  posting is not implemented.
- [ ] Have the accountant approve income, VAT, payment, undeposited-funds,
  receivables, refund and rounding mappings for each store.
- [ ] Test normal, split-tender, account, partial account repayment, refund,
  account refund, void and offline-synced sales. Verify invoices, payment
  allocations, deposit account, A/R and tax in the QBO company.
- [ ] Resolve how manual credit adjustments and refunds to account post to QBO.
  The current customer-payment mapper expects allocations to POS sales invoices;
  positive manual adjustments do not create a QBO invoice, and account refunds
  need accountant review to ensure A/R is reduced correctly.
- [ ] Monitor pending/failed/dead-letter queue counts and rehearse retry after a
  permanent mapping/API error. Keep QuickBooks off until mappings and sandbox
  postings are approved.

## 8. Privacy, identity and permissions

- [ ] Confirm controller/processor roles, lawful basis, retention, data-subject
  request handling, staff access, customer notices and cross-border hosting with
  the client's privacy lead. The [ODPC FAQ](https://www.odpc.go.ke/faqs/) explains
  its registration position; confirm the client's exact registration obligations
  with ODPC or qualified counsel.
- [ ] Review customer collection fields and remove fields the business does not
  need. Limit access to date of birth, address, tax PIN, notes and account history.
- [ ] Confirm marketing consent is separate from debt collection and that opt-out
  changes are honoured by any future SMS/email integration.
- [ ] Verify admin MFA enrollment, password reset delivery, account lockout,
  manager overrides, cashier permissions, auditor read-only access and staff
  offboarding.
- [ ] Review audit events for account opening, limit changes, charges, payment
  references, adjustments, refunds and customer erasure. Confirm support staff
  cannot alter the append-only ledger directly.
- [ ] Set an approved customer erasure/retention process for customers with unpaid
  balances and retained financial records.

## 9. Backups, monitoring and support

- [ ] Set production backup encryption key, off-site bucket, region, access policy,
  retention and alert destination. Verify a successful encrypted backup is copied
  off-host.
- [ ] Restore a recent backup to an isolated database, run migrations if needed,
  sign in, inspect a sale, customer, credit statement, payment and audit trail, and
  record elapsed recovery time.
- [ ] Confirm alert delivery for stale/failed backup, failed off-site copy, job
  failure, QuickBooks dead letters, API unavailability and database saturation.
- [ ] Define log retention and access; confirm passwords, tokens, payment
  references, personal data and provider payloads are redacted as intended.
- [ ] Write incident runbooks for database outage, missing M-PESA callback,
  duplicate/unknown payment, PDQ pending charge, till loss, suspected account
  takeover, data exposure and restore.
- [ ] Train the named support person on receipt reprints, cash close, credit
  collection, account limit refusal, refund/void process and offline queue review.

## 10. Verification and pilot

- [ ] Run `make verify`, `npm run build`, `npm run typecheck` and the dependency
  audit on the exact commit intended for release; attach the results to the release.
  The 2026-10-23 check reports no high or critical findings after non-breaking
  updates. Four moderate findings remain in the development-only
  `drizzle-kit`/`@esbuild-kit` chain; review its exposure and upgrade path before
  release rather than accepting a breaking downgrade from the audit suggestion.
- [ ] Run production-like staging tests with multiple tills, simultaneous last-unit
  sales, account-limit races, concurrent repayments, dropped HTTP responses and
  offline replay.
- [ ] Complete a physical till check for receipt printer, cash drawer, scanner,
  terminal hardware, Wi-Fi loss and power recovery. Scales and customer displays
  have no protocol integration; standalone card approvals are not recorded.
- [ ] Run a staffed pilot with a limited number of tills and approved test
  customers. Reconcile sales, cash, M-PESA, card settlement, customer balances,
  shifts, VAT and QuickBooks daily.
- [ ] Agree launch acceptance criteria, rollback trigger, freeze window and the
  person empowered to stop trading on the new system.
- [ ] After pilot signoff, enable production payments one integration at a time;
  record the change, smoke-test it and monitor its first settlement.

## Go-live approval

- [ ] Client owner signs off on sales, refunds, cash close, credit policy, fiscal
  receipt approach and support contacts.
- [ ] Accountant signs off on tax and QuickBooks postings.
- [ ] Provider tests and settlement reconciliation are signed off by the payment
  owner.
- [ ] Engineering signs off on migration, backup restore, alerts, permissions,
  rollback and release test results.
