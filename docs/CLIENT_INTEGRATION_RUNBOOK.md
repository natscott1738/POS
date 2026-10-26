# Client setup and integration runbook

Use this with the client owner and their payment providers. It is written for
this repository's current implementation. Complete the sandbox and hardware
acceptance steps before enabling any live provider.

## Current implementation boundaries

- Offline checkout requires a browser profile that has signed in, been bound to
  a store and till, registered by an administrator, and synced its catalogue
  while online. Offline checkout accepts **cash only**. M-PESA, PDQ, and customer
  account tenders need a live server confirmation.
- Queued sales survive reloads and recover after a crashed sync tab. Browser
  persistent storage is requested where supported, but a local browser profile
  is still not a backup. Do not clear/reinstall the profile with queued work.
  The remembered offline session expires 14 days after its last successful
  online sign-in.
- USB receipt printing uses WebUSB. Network receipt printing calls a local print
  bridge; that bridge is a separately installed service. The POS repository
  contains the bridge client, not a printer bridge executable.
- Barcode scanners work as keyboard devices when configured to type the barcode
  and press Enter. No scale or customer-facing display protocol is implemented.
- Integrated card payments use the `ECR_HTTP` bridge interface below. This
  repository does not include a bank/acquirer-specific bridge. The API server
  process makes the bridge request; a cloud API cannot reach `127.0.0.1` on the
  till computer. Before using integrated PDQ, either run the API beside the
  bridge or provide a secured, routable bridge path from the API host. This is a
  deployment gate, not a terminal setting that can be fixed in the browser.
- A standalone card approval cannot currently be entered and recorded as a POS
  card tender. Do not tell cashiers that standalone card transactions are
  recorded by this POS.
- M-PESA credentials and shortcode are deployment-wide environment settings,
  not store-level settings. A client needing different M-PESA shortcodes or
  Daraja apps per store needs a per-store configuration change before rollout.

## 1. What to collect before the visit

Get these from the client and record them in their deployment handover, not in a
Git-tracked file:

1. **People and permissions:** client owner, store manager, accountant, IT
   contact, payment reconciliation owner, incident contact, and which people
   can administer staff, refunds, credit, M-PESA, and QuickBooks.
2. **Store setup:** legal name, store names/codes, address, timezone, currency,
   tax PIN, receipt header/footer, VAT-inclusive setting, rounding rule, and
   opening shift float. Have the accountant approve tax codes and credit opening
   balances.
3. **Catalogue:** final product import with unique SKU/barcode, variant, unit,
   price, tax code, cost, and stock count. Resolve duplicate or missing barcodes
   before arriving.
4. **Each workstation:** make/model, OS version, screen, keyboard, USB ports,
   network connection, browser/profile owner, power supply, and asset/serial
   number. Assign one POS browser profile to one physical till.
5. **Each peripheral:** scanner model and suffix setting; printer model,
   connection and paper width; drawer model and printer drawer port; PDQ make,
   model, serial, acquirer, merchant ID, ECR software/version, bridge owner, and
   the bank's test procedure. Ask whether the shop also expects a scale or
   customer display; those are not currently integrated.
6. **Network and power:** primary/backup internet, Wi-Fi credentials, router
   admin contact, DHCP reservations or static IP plan, printer/bridge addresses,
   power outlets, surge protection/UPS, and who can restore the connection.
7. **Provider accounts:** Daraja app owner and live shortcode administrator;
   Intuit developer app owner and QuickBooks company administrator; PDQ acquirer
   contact and terminal/ECR integration pack. The client should provide secrets
   directly through the deployment secret manager.

Do not put consumer secrets, passkeys, OAuth secrets, callback tokens, terminal
shared secrets, or database credentials in CSVs, browser notes, screenshots,
email, chat, or `.env` committed to source control.

## 2. Daraja / M-PESA: sandbox first

The POS currently uses **M-PESA Express/STK Push**, polls the transaction while
the customer enters their PIN, processes asynchronous callbacks, and can show
unmatched C2B/Paybill notifications when the C2B callback URLs have been
registered. Safaricom documents the sandbox app, simulator, request fields,
callbacks, and Go-Live process in the [M-PESA Express documentation](https://developer.safaricom.co.ke/apis/MpesaExpressSimulate).

### Sandbox setup

1. The client or authorized developer signs into the [Safaricom Daraja portal](https://developer.safaricom.co.ke/).
2. Create a **sandbox** app and add the **M-PESA Express / Lipa na M-PESA
   Online** product. Copy that app's sandbox consumer key and secret from its
   keys page. Use the portal's sandbox test data for the shortcode, passkey and
   test phone; do not substitute a live customer's phone or shortcode.
3. Deploy a staging API at a stable public HTTPS hostname. Set
   `PUBLIC_BASE_URL` to the API origin with no trailing slash. Create a random
   callback token, for example with `openssl rand -hex 24`, and put all values
   into the staging secret manager:

   ```dotenv
   MPESA_ENABLED=true
   MPESA_ENVIRONMENT=sandbox
   MPESA_CONSUMER_KEY=<sandbox consumer key>
   MPESA_CONSUMER_SECRET=<sandbox consumer secret>
   MPESA_SHORTCODE=<BusinessShortCode issued for the app>
   MPESA_PARTY_B=<STK recipient; defaults to MPESA_SHORTCODE>
   MPESA_PASSKEY=<sandbox passkey>
   MPESA_TRANSACTION_TYPE=CustomerPayBillOnline
   MPESA_CALLBACK_TOKEN=<random secret, at least 24 characters>
   MPESA_STK_TIMEOUT_SECONDS=120
   ```

   Use `CustomerPayBillOnline` for Paybill and `CustomerBuyGoodsOnline` for a
   Till. Safaricom's Till instructions distinguish the Go-Live
   `BusinessShortCode` from the Till `PartyB`; this code now supports that with
   `MPESA_SHORTCODE` and `MPESA_PARTY_B`. Confirm the exact values Safaricom
   assigned to this account. For Paybill where both are the same, leave
   `MPESA_PARTY_B` blank.
4. The STK callback is built from the API origin and token; Safaricom must be
   able to POST to it from outside the client's network:

   ```text
   https://api.<client-domain>/api/v1/webhooks/mpesa/stk/<MPESA_CALLBACK_TOKEN>
   ```

   Keep the callback token secret. In production, populate `MPESA_ALLOWED_IPS`
   from Safaricom's current official callback source ranges. The checked-in
   sample intentionally contains no IP list because provider ranges can change.
5. Restart the API and confirm health reports M-PESA `sandbox`, then use the
   till's M-PESA tab to test: accepted prompt, successful callback, customer
   cancellation, timeout/no callback, duplicate callback, short amount, and
   manual reconciliation. Check that captured payment amount and receipt code
   match the simulator result. Do not consider an HTTP request accepted as a
   payment; wait for a terminal captured/failed/cancelled result.
6. If the client wants customers to pay a Paybill before checkout, register
   these separate C2B URLs using Safaricom's currently supported URL
   registration process and validate both callbacks in sandbox. URL
   registration is not performed by this POS UI:

   ```text
   https://api.<client-domain>/api/v1/webhooks/mpesa/c2b/validation/<TOKEN>
   https://api.<client-domain>/api/v1/webhooks/mpesa/c2b/confirmation/<TOKEN>
   ```

   C2B registration is optional for STK Push. Safaricom states sandbox URLs
   need to be registered for each simulation and production URLs re-registered
   after deletion; see the [Customer to Business instructions](https://developer.safaricom.co.ke/apis/CustomerToBusiness).

### Production cutover

1. The client obtains and activates the live Paybill/Till and appoints a
   Business Administrator or Business Manager on the M-PESA organization
   account. That authorized person completes Daraja **Go Live** with the exact
   organization name, shortcode, and operator username; completes the OTP and
   enables the M-PESA Express product.
2. Obtain the production consumer key/secret and production passkey from the
   approved Daraja app. Confirm shortcode, PartyB, transaction type, callback
   hostname, settlement account, and Safaricom support contact with the client.
3. Keep the sandbox values saved securely for rollback, then set production
   values in the production secret manager: `MPESA_ENVIRONMENT=production`,
   production keys/passkey, correct shortcode/PartyB/type, `MPESA_ENABLED=true`,
   random callback token, and Safaricom's current callback IP list. In the
   normal release window, keep the feature disabled until the owner approves
   the first real payment.
4. From a real phone approved by the client, make one low-value payment. Confirm
   the callback is captured in POS, the M-PESA receipt code and amount match
   the handset SMS and M-PESA organization statement, and the payment is in the
   expected settlement account. Then reconcile one settlement before opening
   the feature to all cashiers.
5. Agree who checks unmatched, missing, duplicated, or amount-mismatched
   payments each trading day. The till must not retry an ambiguous payment
   until the M-PESA transaction record is checked.

## 3. QuickBooks Online: sandbox first

The integration uses Intuit OAuth 2.0 with the Accounting scope only. Intuit
separates Development/Sandbox and Production credentials; its [OAuth guide](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0)
describes consent, callback, token exchange and refresh behavior.

### Sandbox setup

1. Create/sign into an [Intuit Developer account](https://developer.intuit.com/),
   create a QuickBooks Online app, and enable the **Accounting** scope. Use its
   **Development** keys for a sandbox company. Create or choose a sandbox
   company and have the client's accountant build/confirm a representative
   chart of accounts and tax codes.
2. Deploy the API and web app at their final staging HTTPS hostnames. In the
   Intuit app's **Keys & OAuth** settings, register this exact redirect URI
   (including scheme, host, path and port):

   ```text
   https://api.<client-domain>/api/v1/quickbooks/callback
   ```

3. In the staging secret manager set:

   ```dotenv
   QB_ENABLED=true
   QB_ENVIRONMENT=sandbox
   QB_CLIENT_ID=<Development client ID>
   QB_CLIENT_SECRET=<Development client secret>
   QB_REDIRECT_URI=https://api.<client-domain>/api/v1/quickbooks/callback
   QB_SYNC_INTERVAL_SECONDS=300
   ```

   Configure `CORS_ORIGINS` with the web app origin first because the OAuth
   callback redirects the user back to that origin. Restart and check API
   health reports QuickBooks `sandbox`.
4. Sign in to POS as a user with `quickbooks:connect`; open **QuickBooks** and
   choose **Connect to QuickBooks**. The client company admin approves access
   and chooses the sandbox company. Confirm the displayed realm ID/company and
   sandbox environment.
5. Ask the accountant to map each store in the QuickBooks screen:

   - sales income account;
   - default deposit/undeposited-funds account;
   - standard, zero-rated and exempt VAT codes when used by the catalogue;
   - cash rounding income account if the till uses cash rounding;
   - separate cash, M-PESA, PDQ, bank transfer, gift card and store-credit
     deposit accounts as applicable;
   - the currently supported per-sale posting behavior.

   Keep tax code mappings aligned to the QuickBooks company's country/region and
   the accountant-approved Kenyan VAT treatment. This POS does not make a tax
   or eTIMS compliance determination.
6. Sync sandbox examples for cash, M-PESA, split tenders, credit invoice,
   repayment, refund, void, VAT categories, rounding and an offline-synced sale.
   Inspect each resulting QBO document, A/R, tax and deposit account with the
   accountant. Fix mappings and retry failed/dead-letter jobs before proceeding.
7. Record sandbox signoff and the app assessment/production release requirements
   shown by Intuit. Production access and any assessment requirements are
   controlled by Intuit and can change; follow the app's current Developer
   Dashboard prompts.

### Production cutover

1. Use the Intuit app's **Production** client ID and secret after the app has
   production access. Confirm the production QuickBooks company and admin user.
2. Set `QB_ENVIRONMENT=production`, production credentials, exact production
   `QB_REDIRECT_URI`, and `QB_ENABLED=true` through the production secret
   manager. Restart; verify health reports production.
3. The QuickBooks admin reconnects to the client's production company and the
   accountant rechecks its realm/company and account mappings. Do not assume
   sandbox account IDs apply in production.
4. Make one owner-approved test sale/refund, inspect the actual company ledger,
   and confirm the worker's status/queue before allowing normal trading. Set an
   owner for reconnecting before the displayed refresh-token expiry and for
   resolving dead-letter jobs.

## 4. PDQ / bank card terminal setup

“PDQ” is not a universal protocol. The client must select an acquirer and exact
terminal model first. Ask the bank/acquirer for its **ECR integration kit**,
supported bridge software, test credentials/cards, terminal configuration
instructions, receipt rules, reversal behavior, timeout rules, and settlement
report format. Do not assume a USB cable alone makes a terminal compatible.

### What this POS expects

An `ECR_HTTP` terminal record stores store/till, label, acquirer, serial, bridge
URL and an optional shared secret. The API sends:

```text
POST <endpoint>/ecr/sale
{ transactionRef, amountMinor, currency, reference, deviceSerial }

POST <endpoint>/ecr/reverse
{ transactionRef }
```

The bridge responds with `approved`, `pending`, optional `authCode`, `maskedPan`,
`cardScheme`, response code/message and terminal receipt. If it completes
asynchronously, it posts the final result to:

```text
https://api.<client-domain>/api/v1/webhooks/pdq/<PDQ_CALLBACK_TOKEN>
{ transactionRef, approved, authCode?, maskedPan?, cardScheme?,
  responseCode?, responseMessage?, terminalReceipt? }
```

Only the masked PAN, scheme, approval and receipt are stored. Never return or
log full PAN, CVV, PIN block or track data. `SIMULATOR` is for development; it
does not charge a card.

### Installation and acceptance

1. Confirm the API-to-bridge network path before installing the terminal. The
   admin form defaults to `http://127.0.0.1:9110`, which means the API process's
   own loopback. If the API runs in cloud/container hosting, that address does
   **not** point to the client's computer. Agree on a local API deployment or a
   secured bridge/network design reachable by the API host, then prove it with
   a connectivity test from that host.
2. The acquirer installs/activates the terminal and bridge, pairs the correct
   serial, sets its test/live merchant account, and supplies a test approval and
   decline method. Reserve the bridge machine's network address. Restrict it to
   the required API host and port; do not expose an unauthenticated bridge to
   the Internet. Use TLS where traffic crosses an untrusted network and a long
   random bridge secret.
3. Set `PDQ_ENABLED=true`, `PDQ_PROVIDER=ECR_HTTP`, `PDQ_TIMEOUT_SECONDS` to the
   agreed ECR response window, and a random `PDQ_CALLBACK_TOKEN` in the API
   secret manager. Configure any bridge callback to the public HTTPS URL above.
4. In POS, sign in as an administrator, open **Administration → Card
   machines → Add card machine**, select **Real machine, connected to the till**,
   and enter store, label, acquirer, terminal serial, reachable bridge base URL
   and the shared secret. Confirm the created machine appears active and is
   selectable at checkout.
5. In staging, test approved, declined, customer cancel, bridge offline,
   timeout/ambiguous pending, delayed callback, duplicate callback, sale attach,
   reversal before sale completion and refund after a completed sale. Current
   checkout warns on a pending result but does not poll it or offer a pending
   transaction reconciliation screen. Require a final synchronous bridge result
   for production, or implement and test that workflow before enabling an
   asynchronous acquirer. For every pending result, read the terminal's own
   journal before trying again.
6. Reconcile terminal settlement totals against POS PDQ totals and the bank's
   settlement report. Have the acquirer/client confirm PCI responsibilities
   and applicable merchant validation before live use.
7. Switch the bridge merchant profile to production with the acquirer present.
   Make one low-value owner-approved live purchase, check the POS auth code and
   terminal receipt, then verify settlement. Do not change the provider or
   bridge software during the first trading shift.

If the acquirer does not supply a bridge that matches this contract, implement
and test a vendor-specific adapter. Until then, card checkout through this POS
is not ready for the client's terminal.

## 5. Workstation and hardware install: on-site sequence

Do these steps for **each physical till**, keeping the store/till/device IDs and
peripheral serials in the handover sheet.

### Before plugging in hardware

1. Confirm production HTTPS URL opens on the client's network and API health is
   healthy. Verify system time/timezone, DNS, internet failover, router/DHCP
   reservations, Wi-Fi coverage at the till, and UPS/surge protection.
2. Install operating-system updates and current stable Chrome or Edge. Use a
   dedicated POS browser profile for this till. Do not use guest/private mode,
   browser cleaners, or a profile that is routinely reset.
3. Connect the monitor, keyboard and mouse; disable sleep during store hours and
   configure automatic updates/restarts outside trading hours. Keep a supported
   admin account for maintenance and a normal staff account for daily use.
4. Install the app over HTTPS and install it as a browser app/PWA from the
   browser's install option. Launch once, sign in as the POS administrator,
   select **Store** and **Till**, and choose **Use this till**. This online
   registration and first catalogue sync are mandatory before offline use.
5. Wait for the connection badge to show online and the initial catalogue sync
   to finish. Check representative products, variants, prices, barcodes, tax,
   stock, store settings and an open shift. Do not disconnect before this point.

### Barcode scanner

1. Connect USB or pair the scanner over Bluetooth using the manufacturer's
   setup sheet. Configure it as HID keyboard/keyboard wedge, with the barcode
   followed by **Enter/CR** and no extra prefix/suffix.
2. Open checkout, focus **Scan or search**, scan several real items, then scan
   the same item twice. Confirm correct product/variant, quantity and total.
3. Test barcode not found, scanner reconnect, focus recovery after payment, and
   fast consecutive scans. The scanner only types data; it does not query stock
   or price by itself.

### Receipt printer and cash drawer

1. Choose a supported ESC/POS thermal printer and confirm paper width/roll and
   cutter/drawer-port support. Connect USB directly to the till or connect the
   printer to the shop LAN with a DHCP reservation and port 9100 enabled.
2. **USB path:** use current Chrome/Edge on the HTTPS POS page. In **This till →
   Receipt printer**, choose USB and **Pair printer** (the browser requires a
   direct user click to grant USB access). Pair separately in every browser
   profile/till. Print a test receipt and verify width, readability, tax,
   discounts, item quantities, footer, cut and paper feed.
3. **Network path:** install the separately supplied print bridge on the till
   computer, configure it to listen on loopback only, allow only the POS origin,
   and forward to the printer's reserved IP/9100. Enter the bridge's local URL
   in Printer settings, save, and print the same test receipt. If there is no
   bridge available, use USB or browser fallback; the fallback has no automatic
   cutter or drawer kick.
4. Plug the cash drawer's RJ-style lead into the printer's drawer-kick port,
   not the workstation. Enable **Open the drawer on cash sales**, use **Test cash
   drawer**, and verify the correct drawer opens. Never test by opening during a
   customer's sale.
5. Sell one test cash item, verify one receipt and one drawer kick, then sell a
   non-cash test transaction and confirm the drawer does not open. Printing is
   attempted after sale persistence; a paper jam must not lead staff to charge
   the customer again.

WebUSB requires a secure browser context and a user gesture for pairing; see
[Chrome's WebUSB documentation](https://developer.chrome.com/docs/capabilities/usb/).

### PDQ terminal

Follow the ECR setup in section 4. Also test terminal power/network recovery,
correct till/merchant selection, displayed amount and currency, approval code,
merchant receipt, cancellation, pending inquiry and settlement batch close. Keep
the terminal's normal customer-facing display and PIN entry under the acquirer's
control; staff must not type or photograph card PIN/CVV data.

### Scales and other peripherals

There is currently no scale protocol or customer-display integration. If the
shop sells weighed goods, staff can enter quantity using the POS quantity field
or scan multiplier shortcut, but the scale does not send weight into checkout.
Do not sign off scale integration until a model/protocol is selected and a
separate adapter is delivered and tested.

## 6. Outage, recovery and staff handover

Run this once on every till before pilot signoff:

1. With the till online, open a shift and confirm the product catalogue is
   synced. Make one small cash sale and confirm receipt printing/drawer behavior.
2. Disconnect WAN (leave power on), reload the PWA, and confirm the remembered
   cashier, checkout, cached barcode lookup and local price still work. A known
   product should still scan. Confirm M-PESA/card/credit methods are disabled.
3. Make one small cash sale. Confirm the receipt is labeled `OFFLINE-…`, the
   top status shows queued work, and Settings shows a queued operation. Do not
   clear the profile or close/replace the till browser.
4. Restore network, open **This till → Sync now**, and wait until queue depth is
   zero. Verify the server sale has a receipt number, appears in sales/shift
   totals, and the offline local record becomes synced. Review repricing or
   oversold flags and reconcile against the cash drawer.
5. Simulate a till restart only after confirming the queue is still present.
   Repeat one outage sale and reconnect. Record the steps and escalation contact
   for a queue rejection, printer failure, pending card charge, or missing
   payment callback.

Tell staff: when connection drops, take **cash only** and issue the offline
receipt; never mark a typed M-PESA code or an unconfirmed card payment as paid.
After reconnection, wait for the queued count to clear and match offline receipts
against cash before closing the shift. Do not sign out, clear browser data, move
the till to another store, replace the browser profile, or reset the computer
while a queue is pending. Store catalogue/stock may be stale while offline and
online replay may flag price changes or overselling for manager review.

## 7. Acceptance record to leave at the shop

For each station, have the client sign off these recorded values/results:

- POS URL, store/till codes, device ID, workstation/browser profile and asset
  serial;
- scanner, printer, drawer and PDQ model/serial, network addresses, bridge
  software owner/version, and tested connection path;
- Daraja environment/shortcode type and last successful callback (never the
  secret values);
- QuickBooks environment/company/realm and accountant-approved mapping;
- test receipt number, test sale result, offline receipt number, replayed server
  receipt, PDQ test reference and settlement check;
- staff training, daily reconciliation owner, support contact, backup/restore
  contact, recovery steps and client owner approval.

Link this signed acceptance record to the release ticket and the
[production-readiness checklist](PRODUCTION_READINESS.md).
