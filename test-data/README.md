# Test data

A demo store is already loaded on the live system, so the app can be tried
without touching the real shop.

| File | What it is |
|---|---|
| [products.csv](products.csv) | 29 products (35 variants) in the till's import format. This is what the demo store was loaded from; **Products → Import CSV** accepts it, and re-importing skips SKUs that already exist. |
| this file | What the demo store contains, and a checklist of things to try. |

> **Products and customers are shared by every store.** Only stock, tills, sales
> and staff access belong to a store. The demo products and customers therefore
> also appear in the real store's catalogue (with no stock there). Deactivate them
> under Products and Customers when you no longer want them.

## The demo store

| | |
|---|---|
| Store | `DEMO` · Backyard Demo Store · Limuru Road, Tigoni, Kiambu · KRA PIN `P051234567X` (made up) |
| Prices | Include VAT, no cash rounding |
| Receipts | Header `BACKYARD POS - DEMO STORE`, footer `DEMO RECEIPT - NOT A TAX INVOICE` |
| Tills | `T1` Front counter (receipts `BYD1-…`) · `T2` Back counter (receipts `BYD2-…`) |
| Products | All 29 from `products.csv`, with opening stock in this store only |
| Customers | The five below |
| Sales | 10 cash sales on `T1`, receipts `BYD1-000001` to `BYD1-000010`, KES 15,801 in total |

To sell there, open the till and choose **Backyard Demo Store** and a till. The
choice is remembered on that device only.

## Demo staff

All use the `@backyardpos.test` domain, which is reserved for testing and can
never receive mail. Passwords and PINs were given out separately; they are not
kept in the repository.

| Account | Role | Store access |
|---|---|---|
| `demo.admin@backyardpos.test` | Administrator | Every store |
| `demo.manager@backyardpos.test` | Manager | Backyard Demo Store |
| `demo.cashier@backyardpos.test` | Cashier | Backyard Demo Store |
| `demo.auditor@backyardpos.test` | Auditor (read-only) | Backyard Demo Store |

The owner account cannot be changed by any of these, including `demo.admin`.

## Customers

Phone numbers and KRA PINs are made up. Don't send live M-PESA prompts to them.

| Name | Phone | Email | Tests |
|---|---|---|---|
| Jane Wanjiru | `0712 345 678` | `jane.wanjiru@example.com` | A regular customer: search by phone |
| Limuru Hotel Supplies Ltd | `0722 000 111` | `accounts@limuru-hotel.example.com` | Business customer with KRA PIN `P051000001K` |
| Brian Otieno | `0110 000 222` | | Newer `01..` number format; birthday `1990-05-14` |
| Amina Hassan | | `amina.hassan@example.com` | Email only, no phone: emailed receipt |
| Daraja Sandbox | `0708 374 149` | | Safaricom's M-PESA **sandbox** test number, for when M-PESA is enabled in sandbox mode |

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
| Low-stock warnings | **Eggs Tray of 30** (2 left after the demo sales, reorder at 5), **Cotton T-Shirt Navy / L** (2 in stock) |
| Out of stock | **Natural Yoghurt 500ml**, **Gumboots Size 44** (0 in stock) |
| Cents in a price | **Instant Coffee 100g** (KES 389.50) |
| A high-value sale | **Solar Lamp** (KES 4,500) |

## Things to try

- [ ] Sign in as `demo.manager@` and open **Today** and **Reports** for the demo sales.
- [ ] Open a shift on `T2` with a float of KES 5,000, then close it and count the cash. Check the variance and the Z-report.
- [ ] Ring up the VAT-split basket above. Check each rate on the receipt.
- [ ] Sell 0.750 kg of avocado and 2.5 m of kitenge.
- [ ] Give a discount as the cashier, then approve it with the manager's staff code and PIN.
- [ ] Void a sale, then refund part of another.
- [ ] Sell the last two Eggs trays, then try to sell an out-of-stock item.
- [ ] Attach Limuru Hotel Supplies to a sale.
- [ ] Go offline (turn off the network), make two sales, come back online, and check both sync.
- [ ] Sign in as `demo.auditor@` and confirm it can read reports but not sell or edit.
- [ ] Sign in as `demo.admin@` and confirm the owner's row in **Administration** can't be edited.

Payments: only **cash** works for now. M-PESA and card terminals are switched off on
the server until their credentials are configured.
