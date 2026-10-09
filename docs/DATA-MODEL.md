# How products, stock and customers fit together

Written for the shop owner, not a developer.

---

# Products and stock

## The three levels

There are three things, and the difference between them matters:

**Product** — the thing you sell, in general. "Cotton T-Shirt". "Hass Avocado".
"Kenyan AA Coffee 500g".

A product carries the things that are true of all of it: its name, its category,
whether it is standard-rated or zero-rated for VAT, whether it is sold each or by
the kilogram, and whether you track stock for it at all.

**Variant** — the specific thing a customer walks out with. "Cotton T-Shirt,
Navy, Small".

This is the level that has a **barcode**, a **price**, and a **stock figure**. A
t-shirt in three sizes and two colours is one product with six variants.

**Stock level** — how many of a variant you have, *at a particular shop*.

If you run two branches, the same variant has two stock levels: four in Limuru,
none in town.

## Why it is split that way

A t-shirt is not one thing. If you track "Cotton T-Shirt: 40 in stock", you
cannot answer the only question that matters when a customer asks: *do you have
it in medium?*

By splitting it, the Products screen stays readable — one row for the t-shirt —
while stock is counted per size and colour.

For something like coffee, which comes in one form, the product simply has one
variant. You will not notice the distinction.

## Stock is a ledger, not a number

This is the part worth understanding properly, because it is different from a
spreadsheet.

In a spreadsheet, stock is a number you overwrite. It said 40, now it says 38.
What happened to the other two is not recorded anywhere.

Here, **every change writes a dated line** with a reason and a person's name:

| When | What happened | Change | Balance after |
|---|---|---|---|
| Mon 09:14 | Sale, receipt MAIN-000412 | −2 | 38 |
| Mon 11:02 | Delivery, invoice 8891 | +24 | 62 |
| Tue 16:30 | Damaged — pallet dropped (approved by Jane) | −3 | 59 |
| Wed 08:00 | Stock count correction | +1 | 60 |

The current figure of 60 is simply the sum of that list.

**Why this matters:** when the shelf has 55 and the system says 60, a plain
number tells you nothing. This tells you exactly what was recorded, when, and by
whom — so you can work out whether it is theft, breakage that nobody logged, or a
counting error.

The system checks continuously that the running total and the ledger agree. They
cannot drift apart.

## The five ways stock moves

**Sales** take stock off automatically. Nobody has to remember.

**Deliveries** (Stock → Receive stock) put stock on, and also update what the
item costs you. That cost is what the profit and margin figures are based on.

**Adjustments** cover breakage, theft, expiry and correcting a count. **These
need a manager's approval** — deliberately, because adjustments are the main way
stock quietly disappears.

**Stock counts** reconcile what you physically counted against what the system
thought, and record the difference as one adjustment per item.

**Transfers** move stock between branches, taking it off one and putting it on
the other.

## Cost, price and margin

Each variant has two money figures:

- **Selling price** — what the customer pays
- **Cost price** — what you paid for it

The cost is maintained as a **weighted average**. If you have 10 units that cost
100 each and receive 10 more at 120, the average cost becomes 110. That average
is what the margin and stock-valuation figures use.

**Two things to be careful about:**

**Products entered with no cost price will show 100% margin.** The system cannot
know what you paid. If the profit report looks implausibly good, that is usually
why.

**Cost is snapshotted onto each sale.** A sale made last month keeps the cost
that applied last month. A supplier raising their price today does not retroactively
change last month's margin.

## Prices are dated

When you change a price, the old one is not thrown away — it is kept with the
dates it applied.

**Why:** a sale made offline on Monday, when the coffee was 1,200, syncs on
Wednesday after the price has gone to 1,300. That sale is recorded at **1,200** —
what the customer actually paid. This is only possible because the old price was
kept.

## Reorder levels

Each variant can have a **reorder level** — the point at which you want warning.

When stock falls to or below it, the item appears in Stock → Low stock and on the
Today screen.

**Set these from real figures, not guesses.** Launch without them, let a month of
sales accumulate, then set them from what actually sells. Reorder levels invented
on day one produce either constant false alarms or silence until you run out, and
staff quickly learn to ignore both.

## Products you do not count

Some things should not have stock tracked: services, airtime, a cup of tea made
to order. Switch **Track stock** off on the product and it sells without affecting
any stock figure.

---

# Customers

## What a customer record is for

Adding a customer to a sale is **optional**. Most sales in most shops are walk-ins
and should stay that way — do not make cashiers ask every customer for a phone
number.

Attach a customer when there is a reason:

- **Loyalty** — they are collecting points
- **Credit** — a business customer buying on account
- **Receipts** — they want it emailed or texted
- **A VAT invoice** — business customers need their KRA PIN on it
- **Returns** — proving what they bought

## What is stored

Name, phone, email, KRA PIN, address. Then, maintained automatically:

- **Loyalty points** — a running balance
- **Total spent** and **visit count**
- **Last visit**
- **Account balance** and **credit limit**, for customers buying on account

## Loyalty

Points are earned on the net value of a sale and can be spent as money on a later
one.

Like stock, points are a **ledger** — every point earned, spent, clawed back or
expired is a dated line with a reason. A customer disputing their balance can be
shown exactly how it was arrived at.

**Three behaviours worth knowing:**

**Refunds claw points back proportionally.** Otherwise a customer could buy a
large item, collect the points, return it, and keep them.

**Voiding a sale reverses the points entirely**, including any that were spent.

**Points can be set to expire.** If you use that, a nightly job expires them and
writes the reduction to the ledger. Points that never expire are a liability that
only grows — every unexpired point is a discount you have promised.

## Credit accounts

A business customer can have a **credit limit** and buy on account. The sale is
recorded as paid by "on account", their balance increases, and the sale posts to
QuickBooks as an **invoice** rather than a receipt — so it shows correctly in
what you are owed.

## Consent and deletion — two things that matter legally

**Marketing consent is recorded with a date and time.** Not just that the
customer agreed, but when. Texting customers without consent breaches the Data
Protection Act, and "we think they agreed" is not a defence.

**Deleting a customer clears their personal details but keeps the sales.** Their
name, phone, email and address are removed; the sales themselves remain, attached
to a blank customer.

This lets you honour a deletion request — which customers are entitled to make —
without destroying financial records you are legally required to keep.

---

# How it all connects

A single sale ties the whole system together:

```
Sale  "MAIN-000412"  ·  Mon 09:14  ·  cashier Mary  ·  till T1
│
├── Line: Cotton T-Shirt, Navy, Small  ×2  @ 850.00
│      └── reduces that variant's stock at this shop by 2
│      └── writes a dated line to the stock ledger
│      └── records what it cost, for the margin figures
│
├── Line: Hass Avocado  1.5 kg  @ 250.00/kg
│      └── zero-rated, so no VAT on this line
│
├── Payment: Cash 1,000.00
├── Payment: M-PESA 1,075.00  (code SFE4G8H2K1)
│
├── Customer: Jane Wanjiru
│      └── 20 loyalty points added, with a ledger line
│      └── total spent and visit count updated
│
└── Queued for QuickBooks as a sales receipt
```

Every one of those arrows is recorded. Nothing is a number that someone
overwrote.
