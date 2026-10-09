# Test data

Data for trying the POS by hand. Nothing here is loaded automatically: you enter it
through the app, the same way a real shop would.

| File | What it is |
|---|---|
| [products.csv](products.csv) | 29 products (35 variants) in the till's import format. Upload it under **Products → Import CSV**. |
| this file | Store, till and customer details to type in, and a checklist of things to try. |

> **This goes into the live database.** Test sales, receipts and stock movements stay
> in the reports and audit trail. Keep everything under the test store below, so it
> can be told apart from real trading and deactivated later.

## Setup order

1. **Store**: Admin → Add store (details below).
2. **Tills**: Admin → Terminals, add the two below.
3. **Staff**: Admin → Edit each demo account (`demo.manager@`, `demo.cashier@`,
   `demo.auditor@tigonigrown.com`) and assign it to the test store. Admins see every
   store already.
4. **Register a till**: open the till on the device you'll sell from. It asks you to
   choose the store and terminal.
5. **Products**: Products → Import CSV → choose `products.csv` → check the preview →
   import into the test store. Opening stock is loaded with the products.
6. **Customers**: Customers → Add customer (details below).

## Store

| Field | Value |
|---|---|
| Code | `TEST01` |
| Name | `Tigoni Grown - Test Store` |
| Address | `Limuru Road, Tigoni, Kiambu` |
| Phone | `0700 000 000` |
| KRA PIN | `P051234567X` (made up) |
| Currency | `KES` |
| Prices include tax | Yes (every price in the CSV includes VAT) |
| Cash rounding | `0` (no rounding, so totals are exact while testing) |
| Receipt header | `TIGONI GROWN LIMITED - TEST STORE` |
| Receipt footer | `TEST RECEIPT - NOT A TAX INVOICE` |

## Tills (terminals)

| Code | Name | Receipt prefix |
|---|---|---|
| `T1` | `Front counter` | `TST1` |
| `T2` | `Back counter` | `TST2` |

Receipt prefixes must be unique across every store, so keep `TST` for test tills.

## Customers

Phone numbers and KRA PINs are made up. Don't send live M-PESA prompts to them.

| Name | Phone | Email | KRA PIN | Credit limit | Marketing | Tests |
|---|---|---|---|---|---|---|
| Jane Wanjiru | `0712 345 678` | `jane.wanjiru@example.com` | | 0 | Yes | A regular customer: search by phone, loyalty |
| Limuru Hotel Supplies Ltd | `0722 000 111` | `accounts@limuru-hotel.example.com` | `P051000001K` | 50,000 | No | Business customer with a KRA PIN; selling on account (credit) |
| Brian Otieno | `0110 000 222` | | | 0 | No | Newer `01..` number format; birthday `1990-05-14` |
| Amina Hassan | | `amina.hassan@example.com` | | 0 | Yes | Email only, no phone: emailed receipt |
| Daraja Sandbox | `0708 374 149` | | | 0 | No | Safaricom's M-PESA **sandbox** test number, for when M-PESA is enabled in sandbox mode |

## What the products cover

| To test | Use |
|---|---|
| Scanning | Any product with a 13-digit barcode. They start with `200`, which is reserved for in-store codes, so they never clash with real products. Print labels from any free EAN-13 generator. |
| VAT split on a receipt | One basket with **Sugar 1kg** (16%), **Maize Flour 2kg** (zero-rated) and **Pishori Rice 1kg** (exempt) |
| Selling by weight | **Hass Avocado**, **Bananas**, **Tomatoes**, **Potatoes**, priced per kg. Key the short codes `4046`, `4011`, `4087`, `4072` and enter a weight such as `0.750` |
| Selling by litre / metre | **Fresh Milk Dispenser (per litre)**, **Kitenge Fabric (per metre)** |
| Pack unit | **Toilet Paper 10 Pack** |
| Variants | **Cotton T-Shirt** (Navy S/M/L, White M/L), **Gumboots** (sizes 40/42/44) |
| Search by name (no barcode) | **Sukuma Wiki (bunch)**, **Fresh Milk Dispenser** |
| Low-stock warnings | **Eggs Tray of 30** (3 in stock, reorder at 5), **Cotton T-Shirt Navy / L** (2 in stock) |
| Out of stock | **Natural Yoghurt 500ml**, **Gumboots Size 44** (0 in stock) |
| Cents in a price | **Instant Coffee 100g** (KES 389.50) |
| A high-value sale | **Solar Lamp** (KES 4,500) |

## Things to try

- [ ] Open a shift with a float of KES 5,000, then close it and count the cash. Check the variance and the Z-report.
- [ ] Ring up the VAT-split basket above. Check each rate on the receipt.
- [ ] Sell 0.750 kg of avocado and 2.5 m of kitenge.
- [ ] Give a discount as the cashier, then approve it with the manager's staff code and PIN.
- [ ] Void a sale, then refund part of another.
- [ ] Sell the last Eggs tray, then try to sell an out-of-stock item.
- [ ] Attach Limuru Hotel Supplies to a sale and pay **on account**. Check it counts against the KES 50,000 credit limit.
- [ ] Go offline (turn off the network), make two sales, come back online, and check both sync.
- [ ] Sign in as `demo.auditor@` and confirm it can read reports but not sell or edit.

Payments: only **cash** works for now. M-PESA and card terminals are switched off on
the server until their credentials are configured.
