# Point of Sale — Client Presentation

A document you can read, understand, and present from. Every feature is
explained in full, with the exact steps to demonstrate it **today, without any
hardware**, and a separate explanation of how each piece of hardware will work
once it is fitted.

---

# Part 0 — Before you present

## You do not need a barcode scanner to demonstrate this

This matters, so it is worth being clear about it up front.

**A USB barcode scanner is not a special device.** The computer treats it as a
keyboard. When a cashier scans a tin of beans, the scanner types the digits
`6001234500024` and then presses Enter. That is the entire mechanism. There is
no driver, no configuration, no software to install.

Which means: **typing the barcode on the keyboard and pressing Enter is
identical to scanning it.** The system cannot tell the difference, because there
is no difference.

So for the demonstration you will type barcodes instead of scanning them, and
everything behaves exactly as it will on the shop floor. When you say *"and the
cashier scans the item"*, you type the number and press Enter.

That is also your answer if the client asks *"but will our scanner work?"* —
almost any USB scanner sold in Nairobi will work the moment it is plugged in,
because they all do this same thing.

## Starting the system

Open a terminal and run:

```bash
cd ~/projects/POS
make demo
```

Wait for the banner. It prints the sign-in details and the barcodes. Then open
**http://127.0.0.1:4173** in Chrome.

Leave that terminal alone — closing it stops the system. Press Ctrl+C when you
are finished.

## Prepare the screen before the client is watching

Three minutes of setup that makes the demonstration look much better:

1. **Open Chrome, press F12, go to Application → Storage → Clear site data, then
   reload.** This clears anything left from earlier testing so you start from a
   clean till.
2. **Sign in** with the Email tab: `admin@tigonigrown.com` /
   `ChangeMe!Admin2024`. Accept the till when it asks.
3. **Put one sale through** — type `6001234500024`, Enter, Take payment, Cash,
   Exact, Complete sale. This is so the Today screen has figures on it rather
   than being empty when you show it.
4. **Set up two quick-key tiles** (explained in Part 2) so they are there when
   you get to that section.
5. **Close DevTools** (F12 again). You will reopen it for the offline
   demonstration.

## The barcodes you will use

These four products are already loaded. Keep this list open.

| Type this | Product | Price | VAT |
|---|---|---|---|
| `6001234500024` | Kenyan AA Coffee 500g | KES 1,200.00 | 16% standard |
| `6001234500017` | Hass Avocado (per kg) | KES 250.00 | Zero rated |
| `6001234500031` | Cotton T-Shirt, Navy, Small | KES 850.00 | 16% standard |
| `6001234500079` | Bottled Water 1L | KES 80.00 | 16% standard |

## The accounts

All four share the password `ChangeMe!Admin2024`.

| Role | Email | Till code | PIN |
|---|---|---|---|
| Admin | admin@tigonigrown.com | ADM001 | 1379 |
| Manager | manager@tigonigrown.com | MGR001 | 2468 |
| Cashier | cashier@tigonigrown.com | CSH001 | 1357 |
| Auditor | auditor@tigonigrown.com | AUD001 | 9753 |

You will need the **manager's code and PIN** (MGR001 / 2468) for the override
demonstration, so keep it to hand.

---

# Part 1 — Opening the presentation

## Start with how the shop runs today

Do not open with features. Open with the situation the client recognises.

Most retail businesses in Kenya run one of three ways:

**A cash book and a calculator.** Takings are added up at the end of the day.
Stock is counted when someone has time, which is rarely. Nobody knows what the
margin on any individual product is, and shrinkage is only noticed when it is
severe.

**An ETR machine plus a spreadsheet.** The ETR handles the tax receipt and
nothing else. Stock lives in a spreadsheet that is updated in the evening, if at
all. M-PESA is reconciled by scrolling the SMS inbox on a phone.

**Imported POS software.** Usually written for a market where cards dominate and
the internet is reliable. M-PESA is bolted on, if present at all. When the
connection drops, the till stops.

From that, three problems follow, and the client will recognise all three:

1. **Stock on the shelf never matches stock on paper.** By the time anyone
   notices, you cannot tell whether it was theft, breakage, or a counting error.
2. **M-PESA reconciliation is manual.** Someone sits with a phone and a
   spreadsheet, matching codes to sales. It takes an hour a day and it is never
   quite right.
3. **An outage stops trading.** Power cut, fibre cut, or Safaricom having a bad
   afternoon, and the shop either stops or goes back to a receipt book — which
   then has to be keyed in later.

This system was built around those three problems specifically. Everything that
follows is in service of one of them.

---

# Part 2 — The till: taking a sale

This is the screen a cashier spends the entire day on, so it gets the most
attention.

## Adding items

**What to do:** type `6001234500024` and press Enter.

The coffee appears in the basket on the right, at KES 1,200.00. The total at the
bottom updates.

**What to explain:** the cursor sits in the scan box permanently, so a cashier
never has to click anything before scanning. On the shop floor they pick up the
item, point the scanner, and it is in the basket.

**Now type the same number again and press Enter.**

The quantity becomes 2 and the total becomes KES 2,400.00. It did **not** create
a second line for the same product.

**Why that matters:** this sounds trivial and it is not. A cashier scanning six
bottles of water wants to see "Water × 6", not six separate lines they have to
read down. Six separate lines is how you end up charging for five or seven.

## Selling several of something at once

**What to do:** type `3*` and press Enter. The scan box changes to say *"3 x —
now scan the item"*. Then type `6001234500079` and press Enter.

Three bottles of water are added at once, at KES 240.00.

**What to explain:** this is standard on retail tills and it saves real time. A
customer with a crate of twelve sodas does not want to watch the cashier scan the
same soda twelve times, and the cashier does not want to count to twelve while
doing it. Type the number, then scan once.

The multiplier is used once and then clears itself, so the next scan is a normal
single item. There is no risk of accidentally selling three of the next thing.

## Items with no barcode

**What to do:** point at the tiles underneath the scan box and tap one.

**What to explain:** this is the part that most imported software gets wrong.

A great deal of what a Kenyan shop sells has no barcode at all. Loose tomatoes.
Bread from the local bakery. Airtime. A cup of tea. Sugar scooped from a sack.
Repackaged maize flour.

Searching for those by name, every single time, is far too slow at a busy
counter. So the twelve fastest-moving unbarcoded items get a tile. One tap adds
the item.

Which items appear is chosen per till, because a front counter and a butchery
sell different things.

**To set them up** (do this before the presentation): click **Set up** under the
scan box, search the catalogue, tick up to twelve items, Save.

## Keyboard shortcuts

**What to explain:** a cashier's hands are on the scanner and the keyboard, not a
mouse. The four actions they do all day have keys.

- **F2** — take payment
- **F3** — hold the current basket
- **F4** — see held baskets
- **F8** — jump back to the scan box

These are printed underneath the Take payment button, so nobody has to remember
them.

## Correcting mistakes

**What to do:** click the − and + buttons next to a line to change quantity.
Click the ✕ to remove a line. Click **Clear** to abandon the whole basket.

**What to explain:** all of this is free before payment is taken. Nothing is
recorded until the sale is completed, so a cashier fixing a mis-scan leaves no
trace and needs no permission. It is only once money has changed hands that
changes need a manager — which is the next section but one.

---

# Part 3 — Holding a basket

This is the feature shop staff react to most strongly, so give it a moment.

## The situation

A customer reaches the counter with twelve items. The cashier scans them all.
The customer then discovers her purse is in the matatu, or that she has forgotten
the cooking oil, or that she needs to call her husband about the price.

There are four people in the queue behind her.

**Today, in most shops,** you have two options: hold up the queue while she sorts
it out, or scrap the basket entirely and scan all twelve items again when she
comes back. Both are bad, and the second one is where mistakes happen.

## What this does instead

**What to do:** build a basket with two or three items. Click **Hold**. Give it a
name — type "Mrs Wanjiru". Click **Hold basket**.

The till is now empty and ready for the next customer. Notice the **Held · 1**
button has appeared at the top of the basket.

**Now serve someone else** — type a barcode, show it works normally, then click
Clear.

**Now click Held · 1.** Mrs Wanjiru's basket is listed with the time it was held,
the number of items, and the total. Click **Resume**.

The basket comes back exactly as it was.

## What to say about it

Nothing was charged. Nothing was sent anywhere. The basket sits on that till
until someone resumes it or clears it.

It survives a page reload, a browser crash, and a power cut, because it is stored
on the device itself rather than in memory.

You can hold as many baskets as you like at once. In a busy shop with one till,
two or three held baskets at a time is normal.

---

# Part 4 — Payments

## Why split payments matter

**What to explain first:** in Kenya, a single customer routinely pays with more
than one method. They have KES 1,000 in cash, the rest goes on M-PESA. Or the
M-PESA transaction fails and they finish on a card.

Any system that assumes one payment per sale forces the cashier to either refuse
the customer or fake it — usually by recording the whole thing as cash, which
destroys the reconciliation.

Here, every payment method is recorded separately against the sale. That is the
only way the end-of-day figures can be checked against the drawer, the M-PESA
statement, and the card settlement.

## Demonstrating a split payment

**What to do:**

1. Type `6001234500024`, Enter. Type it again, Enter. (Two coffees, KES 2,400.)
2. Click **Take payment**.
3. The payment window shows **TOTAL KES 2,400.00** and **OUTSTANDING KES
   2,400.00**.
4. In the **Cash received** box, type `1000`. Click **Add cash payment**.
5. Notice the outstanding amount has dropped to KES 1,400.00, and the cash
   payment is listed above.
6. Click the **M-PESA** tab.
7. Click the line that says *"Customer already paid — enter code"* to expand it.
8. Type a confirmation code, for example `TEST1234ABC`. Click **Add M-PESA
   payment**.
9. Outstanding is now zero and **Complete sale** has become clickable.
10. Click **Complete sale**.

**What to explain:** the sale is now recorded with two payments against it. In
the reports, KES 1,000 appears under cash and KES 1,400 under M-PESA. At close
of business, the cash figure is what should physically be in the drawer and the
M-PESA figure is what should be in the M-PESA statement.

## Cash

The quick buttons offer 50, 100, 200, 500 and 1,000 — the notes actually in a
Kenyan till. There is also an **Exact** button for when the customer has the
right money.

Change is calculated and shown. If the printer is connected, the change amount
is printed on the receipt and the drawer opens.

## M-PESA — how it will actually work

This needs explaining carefully, because it is the part the client cares most
about and there are two different flows.

### Flow 1 — the till asks for payment (the normal case)

1. The cashier finishes scanning. Total is KES 2,400.
2. The cashier clicks M-PESA and types the customer's phone number.
3. The cashier clicks **Send payment request**.
4. **The customer's phone buzzes within a few seconds** with a prompt showing
   the shop name and KES 2,400. They enter their M-PESA PIN.
5. The till is showing *"Waiting for the customer to enter their PIN…"* and
   checking every three seconds.
6. When the customer confirms, **the till updates by itself** — the payment is
   added with the confirmation code attached. The cashier does not type
   anything.
7. Complete sale.

The cashier never reads out a number, the customer never types an amount, and
nobody keys in a confirmation code. That removes the two most common M-PESA
errors in retail: wrong amount sent, and wrong code written down.

### Flow 2 — the customer has already paid

Some customers pay to the paybill before being asked, especially regulars. For
that case the cashier expands *"Customer already paid"* and keys in the
confirmation code from the customer's SMS.

### What happens when it goes wrong

This is worth covering explicitly, because it is where most systems are weak.

**The customer's phone has no signal, or they take too long.** The request
expires after two minutes and the till says so. The cashier can send it again or
take another payment method.

**The customer pays, but Safaricom's confirmation never reaches us.** This
genuinely happens. A background job asks Safaricom directly, once a minute, what
happened to every unanswered request. If Safaricom says it succeeded, the sale is
marked as needing a human to confirm the code — rather than the shop either
losing the money or charging twice.

**The customer pays KES 950 instead of KES 1,000.** The system does not quietly
accept it, and it does not quietly reject it. It records the KES 950, flags that
it does not match, and leaves it for a person to decide: accept the shortfall,
ask for the balance, or refund.

**Someone tries to use the same M-PESA code on two different sales.** This is
impossible. The code is stored with a uniqueness rule in the database, so the
second attempt is rejected outright. This is not a check in the software that
could be bypassed — it is enforced by the database itself.

### What the client needs to provide for M-PESA

- A Safaricom Daraja account (free, self-service)
- Their till number or paybill number, and confirmation of which
- The passkey and keys from the Daraja portal
- A production go-live application, which Safaricom reviews by hand — this takes
  days to weeks and should be submitted early

## Card payments — both scenarios

The client will ask about card machines. There are two possible arrangements and
you should present both honestly, because which one applies depends on their
bank.

### Scenario A — integrated (if their bank allows it)

1. The cashier clicks **Card** and clicks **Send to terminal**.
2. **The amount appears on the card machine automatically.** The cashier does
   not key it in.
3. The customer taps, inserts, or swipes and enters their PIN on the machine.
4. The machine approves, and the till receives the approval code and the last
   four digits of the card.
5. Complete sale.

The advantage is that the amount cannot be keyed in wrongly, and card takings
reconcile automatically against the sale.

### Scenario B — standalone (the fallback, and very common)

1. The cashier reads the total off the screen and keys it into the card machine
   by hand.
2. The customer pays on the machine as normal.
3. The cashier selects **Card** in the till and records the approval code from
   the machine's slip.
4. Complete sale.

This is how a great many Kenyan shops already operate. It works today with no
integration work at all. The cost is that the amount is keyed in twice, and card
takings are reconciled by comparing the POS card total against the machine's
end-of-day report rather than automatically.

### Why this distinction exists

Integration requires the bank's own integration kit, and **some Kenyan banks do
not provide that to smaller merchants.** Equity, KCB, Co-op and the others each
have their own arrangement, and several are Windows-only or refuse access
entirely below a certain turnover.

**Be straight with the client about this.** Our side of the integration is
already built. Whether it can be switched on depends entirely on what their bank
will give them. Ask the bank early; if the answer is no, Scenario B is a
perfectly respectable way to run a shop.

### Card security

Card numbers never reach this system. The machine handles the card; we store only
the last four digits and the approval code. This keeps the business out of the
heavier PCI-DSS obligations.

If the card machine does not answer at all, the till reports the payment as
**pending** — never as declined. The card may already have been charged, and
assuming otherwise is how customers get charged twice.

---

# Part 5 — Offline mode

This is the most important part of the demonstration. Allow three or four
minutes and do not rush it.

## Set up the explanation first

Before you show anything, explain what the client is about to see, because
otherwise the demonstration looks like nothing happened.

Say something like: *"The fibre is cut, or the power is out and we are on a
backup, or Safaricom is having a bad afternoon. In most shops, the till stops. I
am going to disconnect this computer from the internet completely and keep
selling."*

## The demonstration

**Step 1.** Make sure the page has been loaded for at least five seconds. Press
F12 to open DevTools and go to the **Network** tab.

**Step 2.** Find the throttling dropdown — it usually says *No throttling* — and
change it to **Offline**. The browser is now completely disconnected. Nothing can
reach the server.

**Step 3. Reload the page.** Press F5.

**This is the moment.** The till loads normally. You are still signed in. The
badge at the top left now says **Offline**.

Point out explicitly what did *not* happen: no error page, no blank screen, no
"you are not connected" message, no need to sign in again.

**Step 4.** Type `6001234500024`, Enter. The product appears with its correct
name and price, from the catalogue stored on the device.

**Step 5.** Take payment, Cash, Exact, Complete sale.

The sale completes. The badge now says **Offline · 1 queued**.

**Step 6 (optional but convincing).** In DevTools, go to **Application →
IndexedDB → pos-till → queue**. The queued sale is visible, sitting on the
device.

**Step 7.** Set throttling back to **No throttling**.

**Step 8.** Within about twenty seconds the badge returns to **Online** and the
queue clears. You can click the badge to sync immediately rather than waiting.

**Step 9.** Go to **Receipts**. The sale is there with a proper receipt number,
marked as having been created offline.

## What to explain about how it works

There are two separate mechanisms, and most systems that claim to work offline
only have the second one.

**First: the application itself is stored on the device.** The screens, the
layout, the code — all of it is cached locally the first time the till is used.
That is why reloading with no internet still gives you a working till rather than
a browser error. Without this, the sales queue could be perfectly intact and the
cashier would have no way to reach it.

**Second: sales are queued locally and sent up safely.** The product catalogue
and prices are stored on the device, so scanning and pricing need no server at
all. Completed sales go into a queue, and when the connection returns they are
sent up in order.

The important part is what prevents double-charging. Each queued sale carries a
unique identifier created on the till. If the connection drops halfway through
sending and the till tries again, the server recognises the identifier and
returns the original receipt instead of creating a second sale.

**Worth demonstrating if you have time:** go offline, complete a sale, then
hard-reload the page (Ctrl+Shift+R) before it syncs, then go back online. One
sale appears, not two.

## One deliberate decision to mention

If a sale is made offline for an item the system thinks is out of stock, the sale
is **accepted anyway**, and flagged for review.

The reasoning: the sale already happened. The customer has the goods and the shop
has the money. Refusing to record it would mean losing real revenue and leaving
the till and the server permanently disagreeing. So it goes through, stock goes
negative, and it appears on the dashboard as something to look at.

## What offline cannot do

Be honest about the limits, because the client will find them otherwise.

**Works offline:** scanning, pricing, discounts, cash payments, M-PESA codes
keyed in by hand, holding baskets, printing receipts.

**Does not work offline:** sending an M-PESA request to a customer's phone
(needs Safaricom), card machine payments (needs the bank), live stock figures
from other tills, and reports.

So an outage means cash sales continue normally and M-PESA continues if the
customer pays to the paybill themselves. That is the realistic position, and it
is far better than stopping.

---

# Part 6 — Hardware: how each device will work

This is the section you said was missing, and it is the one the client will have
the most practical questions about. Each device is covered as: what it is, what
it plugs into, what the cashier experiences, and what needs doing to set it up.

## Barcode scanner

**What to buy.** Any USB barcode scanner. In Nairobi the common ones are the
Zebra (Symbol) LS2208 and DS2208, the Honeywell Voyager 1200g, and various
unbranded Chinese scanners. Any of them work. Prices range widely and the cheap
ones are fine for a shop counter.

**What it plugs into.** A USB port on the till computer. That is all.

**How it works.** The computer sees the scanner as a keyboard. When the trigger
is pulled and a barcode is read, the scanner types the digits and presses Enter,
exactly as if a very fast person had typed them.

**What setup is needed.** None. Plug it in and scan. There is no driver to
install, nothing to configure in the system, and no settings screen for it.

**What the cashier does.** Picks up the item, points, pulls the trigger. The item
appears in the basket. The scan box keeps focus permanently, so they never have
to click first.

**Two things that occasionally need adjusting**, both done by scanning a
configuration barcode from the scanner's own manual:

- If scanning puts the digits on screen but does not add the item, the scanner is
  not sending Enter. Scan the "add CR suffix" barcode from the manual.
- If the counter is noisy, consider turning off the beep on a *failed* read —
  staff stop distinguishing it from the success beep and scan the wrong thing.

**Bluetooth scanners** behave identically once paired, because the operating
system also presents them as keyboards.

**Testing it:** open the till, scan any product. If it appears, you are done.

## Receipt printer

**What to buy.** An 80mm thermal receipt printer that speaks ESC/POS. In practice
that is almost all of them. Specific models worth naming:

- **Epson TM-T20III or TM-T82** — the reliable choice, widely stocked in Nairobi,
  and what I would recommend if the budget allows
- **Xprinter XP-80 series** — the common budget option, works well
- **Star TSP100** — also fine
- Most unbranded 80mm printers, which nearly all speak ESC/POS

**Avoid 58mm printers.** The receipt layout is designed for 80mm paper, which is
42 characters wide. A 58mm printer will wrap and look wrong.

**What it plugs into.** USB on the till computer, plus mains power. Some models
also offer Ethernet, which is useful if one printer is shared between two tills.

**How it connects to the system.** There are three options, chosen in
**Settings → Receipt printer**:

**Option 1 — USB direct.** This is the recommended arrangement. The browser
talks to the printer directly. There is no Windows printer driver involved, no
print queue, and crucially no print dialog for the cashier to click through.

To set it up: choose **USB thermal printer**, click **Pair printer**, and select
it from the list the browser shows. Done once per till.

Requirements: Chrome or Edge (Firefox and Safari cannot do this). On Windows, the
printer must **not** be installed as a Windows printer — if it is, Windows claims
the device and the browser cannot open it. On Linux the user needs device
permission, which is one small configuration file (documented in
`docs/HARDWARE.md`).

**Option 2 — network bridge.** For a shared printer, or where Option 1 is
awkward. A small service runs on the till and forwards print data to the
printer's network port. The address is entered in Settings.

**Option 3 — browser print dialog.** A fallback so a shop with no thermal
printer can still trade. It prints the receipt text to whatever printer the
operating system has. There is no paper cut and no cash drawer. Use it only until
a real printer arrives.

**What the cashier experiences.** Nothing. They click Complete sale and the
receipt comes out. No dialog, no printer selection, no waiting.

**What gets printed:** shop name and address, KRA PIN, receipt number, date and
time, cashier name, every item with quantity and price, discounts, the total, how
the customer paid, the VAT breakdown, and the shop's footer message. Then the
paper is cut automatically.

**An important detail worth mentioning.** Printing happens *after* the sale has
been safely recorded, never before. If the printer jams or runs out of paper, the
cashier gets a warning but the sale stands. Money that has changed hands is never
undone by a paper problem. The receipt can be reprinted from the Receipts screen.

**Testing it:** Settings → Receipt printer → **Print test receipt**. You should
get a correctly formatted receipt with a clean cut.

## Cash drawer

**This is the one that surprises people:** a cash drawer does not connect to the
computer. It connects to the **printer**.

**What to buy.** Any standard POS cash drawer with an RJ11 or RJ12 kick
connector. Make sure it matches the printer's connector type.

**What it plugs into.** A cable from the drawer into the port on the back of the
printer, usually marked **DK** or **DRAWER**. Nothing goes to the computer.

**How it works.** When the system wants the drawer open, it sends a short
electrical pulse instruction to the printer, and the printer fires the solenoid
in the drawer, which pops it open.

**This means a cash drawer requires a working thermal printer.** There is no way
around that short of an unusual USB-serial drawer, which is rare and not
supported.

**What the cashier experiences.** They complete a cash sale and the drawer opens
by itself. They put the money in, take the change out, and push it shut.

**A control worth pointing out to the owner:** the drawer opens on sales
involving cash and **does not open** on a card-only or M-PESA-only sale. A drawer
that stays shut when no cash is involved is itself a small anti-theft measure,
because there is no routine reason for it to be open.

**Setup:** Settings → Receipt printer → tick **Open the cash drawer on cash
sales**. Test with the **Test cash drawer** button.

## The till computer or tablet

**What to buy.** Anything that runs a current version of Chrome. That includes a
purpose-built POS terminal, a cheap Android tablet, a small desktop PC, or a
repurposed laptop.

**Screen size.** The till layout uses two columns on screens wider than about
1000 pixels and stacks into one column below that. A 10-inch tablet is
comfortable. A phone works but is cramped.

**The interface is built for touch:** all buttons are at least 42 pixels tall,
main actions are 56 pixels, nothing depends on hovering a mouse, and PIN entry
uses a large on-screen keypad.

**Install it as an app.** In Chrome, there is an **Install** option in the
address bar. Once installed, the till opens full-screen with no browser
address bar or tabs. Two benefits: staff cannot navigate away to other websites,
and it still opens when there is no internet.

**One thing to specify:** a UPS on every till and on the server. They are
inexpensive, and a power cut during a database write is the classic way POS
systems lose transactions. The system is built to survive this — a sale either
completes fully or not at all — but not inviting the problem is better than
handling it.

## Weighing scales

**Not integrated directly, and for most shops that is fine.**

**The normal arrangement** is a weigh-and-label scale at the counter. Staff put
the produce on the scale, the scale prints a sticky label with a barcode encoding
the weight and price, and the cashier scans that label like any other barcode.
**This works today with no integration work.**

Products sold by weight are fully supported — set the product to "Sold by:
Kilogram" and quantities carry three decimal places exactly, so 1.250 kg is
1.250 kg and not a rounded approximation.

**Direct integration** — the scale wired to the till so the weight appears
automatically when an item is placed on it — is additional work. It needs a small
service reading the scale's serial output. If the client wants this, we need the
scale's make and model first, because the protocols differ.

## Customer-facing display

**Not currently built.** Two possible approaches if the client wants one:

- A second browser window on a customer-facing monitor showing the basket as it
  is scanned. Moderate work, needs only a monitor.
- A serial pole display — the small two-line screen on a stalk. Needs a bridge
  service like the printer's.

Worth noting that many Kenyan shops operate perfectly well without one.

## A practical starting kit for one till

In order of importance:

1. **Till computer or tablet** — anything running current Chrome
2. **80mm thermal printer** — Epson TM-T20III if budget allows, Xprinter XP-80
   otherwise
3. **USB barcode scanner** — Zebra LS2208 or any keyboard-wedge model
4. **Cash drawer** — matched to the printer's kick connector
5. **UPS** — one small unit per till
6. **Label printer** — only if they want to barcode their own stock

## How we will roll hardware out

Worth saying, because it shows this has been thought through:

1. The client buys or confirms the hardware
2. We confirm the exact printer model **before** connecting anything, because
   ESC/POS has small dialect differences between manufacturers
3. Each till is set up once: pair the printer, test the receipt, test the drawer,
   scan a product
4. That configuration is remembered per device, so it is a one-time job
5. Settings → Receipt printer is used to re-test at any time, which is where to
   start if something stops working

---

# Part 7 — Stock control

## The approach

Stock here is not a number that someone edits. It is a **ledger** — a dated list
of every movement, each with a reason and a person's name against it.

Every one of these writes a line: a sale, a return, a delivery, a breakage, a
theft write-off, an expiry, a stock count correction, a transfer to another
branch.

**Why this matters to an owner.** If the shelf has 8 and the system says 12, a
plain number tells you nothing. A ledger tells you exactly what happened to every
one of the missing four and who recorded it. That is the difference between
knowing you have a shrinkage problem and being able to do something about it.

The running total and the ledger must always agree. That is checked
automatically every time we run the test suite.

## What to demonstrate

**Go to Stock.** Three tabs:

**On hand** — everything in stock, with quantity, average cost, value at cost
and value at retail. The totals at the top are what the stock on the shelves is
worth.

**Low stock** — anything at or below its reorder level, with a suggested order
quantity.

**Movements** — the ledger. Every change, newest first, with the reason and the
running balance after it.

**Click Receive stock.** This is what happens when a delivery arrives: supplier,
invoice number, and the items with quantities and costs. Receiving updates the
average cost, which is what the margin and valuation figures are based on.

**Click Adjust on a row.** This is for breakage, theft, expiry, or correcting a
count. Note that it **requires a manager's authorisation** — a cashier cannot do
this alone. Stock adjustment is the main route by which stock goes missing, so it
is deliberately a two-person action.

## Variants

**What to explain:** a t-shirt is not one product. It is small, medium, large,
navy and white — each with its own barcode and its own stock figure.

The system handles this as one product with several variants, so the Products
screen stays readable, but stock is tracked per variant. You know you have four
medium navy and none large.

---

# Part 8 — Products and getting started

## Loading the catalogue

**Go to Products → Import CSV.**

Every shop arrives with a spreadsheet, and typing several hundred products in by
hand is where go-live timelines collapse.

**Click Download template.** It is a plain CSV with the columns: name, SKU,
barcode, category, variant, price, cost, tax treatment, unit, reorder level, and
opening stock.

**Then upload a file.** The system checks the entire file and shows you what it
found: how many products, how many variants, how many have opening stock — and
every problem it can see, with the row number and the column.

**Deliberately include a mistake when you demonstrate this.** The system refuses
the whole import and lists the problems. Explain that this is intentional: half a
catalogue imported is considerably worse than none, because you then have to work
out which half.

Rows that share a product name become variants of the same product, so the
t-shirt in three sizes is three rows and becomes one product with three variants.

## Prices are dated

**Click Change price on any variant.**

The old price is not overwritten. It is kept with the dates it applied.

**Why this matters, with a concrete example:** a sale is made offline on Monday
when the coffee costs KES 1,200. On Tuesday the price rises to KES 1,300. On
Wednesday the till reconnects and sends Monday's sale up.

That sale is recorded at **KES 1,200** — the price the customer actually paid —
not at Wednesday's price. This is only possible because the old price was kept
with its dates.

---

# Part 9 — Customers and loyalty

Customer profiles hold contact details, full purchase history, loyalty points,
and a credit limit for business customers who buy on account.

**Go to Customers and open one** to show the purchase history and the loyalty
ledger — every point earned and spent, with the reason.

## Two points worth making to the client

**Marketing consent is recorded with a date and time.** The system knows not just
that a customer agreed to be contacted but when. Texting customers without
consent breaches the Data Protection Act, and "we think they agreed" is not a
defence.

**Deleting a customer clears their personal details but keeps the sales
records.** If a customer asks to be removed — which they are entitled to do —
their name, phone and address are cleared, but the sales themselves remain. This
means you can honour the request without destroying your own financial records,
which you are legally required to keep.

---

# Part 10 — Shifts and cash accountability

## What a shift is

A cashier opens a shift when they start, declaring what is already in the drawer
(the float). They close it at the end, counting what is physically there.

**What to demonstrate:**

1. On the till screen, click **Open shift**. Enter a float of 5000. Open.
2. Put a cash sale through.
3. Click **Close shift**. The window shows the day's figures: how many sales,
   gross takings, and a breakdown by payment method.
4. Enter a counted amount that is deliberately wrong — try 6000 when it expects
   6200.
5. The variance is shown immediately: **short by KES 200.00**.
6. A note is required when there is a variance.
7. Close the shift.

## What to explain

**The expected cash figure is calculated from the payment records, not from
anything the till is told.** The cashier cannot influence what the system expects
to find. They count, and the difference is recorded against their name.

The **Z-report** is the end-of-shift statement, exportable as a PDF for filing.

**The point for an owner:** a single short drawer means nothing — people make
mistakes. One cashier short by 200 bob most days is a pattern, and this is what
makes that pattern visible rather than invisible.

---

# Part 11 — Who can do what

## The four roles

**Cashier** — sell, take payments, hold baskets, open and close their own shift,
look up products and stock levels, add a customer.

**Manager** — everything a cashier can do, plus: void sales, process refunds,
give order-level discounts, override prices, adjust stock, receive deliveries,
see all reports, and view all shifts.

**Admin** — everything, including creating staff, setting up shops and tills, and
seeing the audit log.

**Auditor** — can see everything, change nothing. Intended for an accountant or
an external auditor.

## The demonstration that matters

This is the control that owners care about most, so show it rather than
describing it.

1. **Sign out.** Sign back in as the cashier: Till PIN tab, staff code `CSH001`,
   PIN `1357`.
2. Notice the menu is much shorter. No Reports, no Administration, no Products.
   A cashier sees the till and little else, because that is the entire job and
   ten menu items is ten chances to get lost mid-queue.
3. Go to **Receipts**, open a completed sale, and click **Void**.
4. Enter a reason and click Void sale. **It is refused** — the cashier does not
   have permission.
5. Now enter the manager's code `MGR001` and PIN `2468` in the override boxes,
   and void again. **It goes through.**
6. Sign back in as admin and go to **Administration → Audit log**. The void is
   listed, showing the cashier who did it, the manager who approved it, and the
   reason.

## What to say about it

A cashier can *start* a void, but a manager has to be physically present to
approve it with their own PIN.

The manager is never signed in during this. They walk over, type their code, and
walk away. Their name is recorded on the sale itself and in the audit log.

And **nobody can approve their own override.** A manager cannot void their own
sale by entering their own PIN — the system refuses it, because a two-person
control with one person is not a control.

The same applies to refunds, price overrides, order discounts, and stock
adjustments.

---

# Part 12 — Reports

## Today

**Go to Today.**

Takings so far, compared with yesterday. Number of sales and the average basket.
VAT collected. Refunds and voids. A bar chart of which hours are busy. What is
selling best today. And a **needs attention** panel that surfaces anything
unusual: items below reorder level, sales that took stock negative, offline sales
that were repriced, shifts left open, accounting entries that failed.

This is the screen an owner looks at, not the till.

## The reports themselves

**Go to Reports.** Set a date range and run.

- **Sales summaries** — by hour, day, week or month
- **Payment breakdown** — cash versus M-PESA versus card, with each as a
  percentage of takings
- **VAT report** — net and tax per rate band, including refunds, which is what
  goes on the return
- **Stock reports** — low stock, bestsellers, dead stock (nothing sold in 90
  days, with the capital tied up in it), and total stock valuation
- **Cashier performance** — takings, discounts given, voids and refunds per
  person
- **Z-report** — the end-of-shift statement

**Everything exports to CSV and PDF.** Demonstrate both buttons.

## One security detail worth mentioning

**Exporting is a separate permission from viewing.** A cashier can be allowed to
see today's takings on screen without being able to download the customer list
and walk out with it.

---

# Part 13 — QuickBooks

## What it does

**Go to QuickBooks.**

Sales post to QuickBooks automatically — sales receipts for paid sales, invoices
for account customers, refund receipts for returns, and voids where a sale was
cancelled. Products are created in QuickBooks the first time they sell, so
nobody has to set up the catalogue twice.

## Two things worth explaining

**A sale is queued for accounting in the same step that records the sale.** They
either both happen or neither does. Accounting cannot miss a sale that actually
took place.

**Nothing posts until the accounts are mapped.** The mapping screen reads the
client's real chart of accounts from QuickBooks and asks which account takings
go to, and which account each payment method is banked into. Until that is
answered, the queue simply waits.

That is deliberate. Posting to a guessed account is far more expensive to unpick
six months later than a queue that is waiting for an answer.

**One recommendation to make to the client:** map cash, M-PESA and card to
**separate** deposit accounts. If all three land in one account, bank
reconciliation becomes guesswork, because M-PESA settles on a different schedule
from card and neither matches the cash banked. This is painful to change once
months of entries exist.

## If QuickBooks is unavailable

The queue builds up and drains when it comes back. The till never slows down
waiting for accounting.

## What the client needs to provide

- A QuickBooks Online subscription
- An Intuit developer account and app, which gives us the keys
- The domain and HTTPS set up first, because Intuit will not accept an insecure
  return address
- Production approval from Intuit, which they review by hand over days to weeks
- Their accountant's time to agree the account mapping and check the first few
  entries in the sandbox

Full detail is in `docs/QUICKBOOKS.md`.

---

# Part 14 — Security

Most of the development effort went here. The threats are not exotic — they are
the ordinary ways a shop loses money.

## Price tampering

**The threat:** a cashier opens the browser's developer tools and changes a price
before completing a sale, then pockets the difference.

**The control:** the till displays a price, but when the sale is submitted the
server works the total out again from its own records and refuses anything that
does not match. A modified browser cannot sell at its own price.

This is the one worth spending a moment on, because it is the difference between
a system that trusts the till and one that does not.

## Voiding sales to take the cash

**The threat:** a cashier completes a sale, takes the money, then voids the sale
so no record remains.

**The control:** voiding requires a manager's code and PIN entered at the till.
The manager's name goes on the sale and in the audit log. A void more than 24
hours after the sale is refused entirely — it must be processed as a refund,
which leaves a clearer trail.

## Refunds routed to the wrong place

**The threat:** a cashier processes a refund for a cash sale but sends the money
to their own M-PESA number.

**The control:** a refund can only go back to a payment method that actually paid
for that sale, and never for more than was collected.

## A stolen laptop or database copy

**The control:** passwords are hashed with Argon2id, which is designed to be slow
and expensive to attack. QuickBooks tokens, staff PINs and the card terminal
credentials are encrypted. Backups are encrypted before they leave the machine.

## Forged M-PESA confirmations

**The threat:** someone works out the address Safaricom sends confirmations to
and sends fake ones, creating payments that never happened.

**The control:** the address includes a secret that is not guessable, only
Safaricom's published IP addresses are accepted, the message format is checked
strictly, and sending the same confirmation twice changes nothing.

## Double-charging on a retry

**The threat:** the connection drops just as a sale is submitted. The cashier
tries again. The customer is charged twice.

**The control:** every sale carries a unique identifier created on the till. A
retry returns the original receipt instead of creating a second sale.

## Two tills selling the last item

**The threat:** one unit left, two cashiers sell it at the same moment, and both
sales go through.

**The control:** the database locks the stock record. Exactly one sale wins; the
other is told there is no stock.

## The audit log

Every change writes one line: who did it, what they did, when, from which till,
which manager approved it, and why.

Passwords, PINs and card details are stripped out before anything is written, so
the audit log — which an accountant may be allowed to read — never becomes a
second place credentials are stored.

**Show Administration → Audit log** and point out the void from Part 11, with the
manager's approval recorded against it.

---

# Part 15 — Backups

**Go to Administration → Backups.**

Every night at 2:15am, the entire database is copied, compressed, **encrypted**,
checksummed, and sent to off-site storage.

## Why each of those steps is there

**Encrypted** — the backup contains every customer's name and phone number,
every transaction, and staff records. An unencrypted copy on a shop computer is a
data breach waiting to be copied onto a USB stick.

**Checksummed** — each backup records a fingerprint that can be re-checked
later. This catches a disk quietly corrupting the file, which is the usual reason
a restore fails at the exact moment you need it.

**Off-site** — this is the important one. A backup on the same machine as the
database **is not a backup**. One fire, one flood, one theft, and the data and
every copy of it leave the building together. These go to cloud storage,
encrypted before they leave, so the storage provider never holds readable
customer data.

**And someone is told when it fails.** If no good backup has completed in 36
hours, an alert is sent. Backups that fail silently are the ones you discover you
needed too late.

## What to say about restoring

The restore procedure is documented, and it should be **practised before it is
needed**, into a spare database. A backup nobody has ever restored is a hope, not
a plan.

---

# Part 16 — How we know it works

**Run `make verify` in a terminal.**

It takes about three minutes and produces a list of green ticks.

- **65 automated checks** on the calculations and against a real database
- **14 further checks** that drive the actual screens in a real browser,
  including the offline test with the network genuinely disconnected
- **No known serious vulnerabilities** in anything the system depends on

## What to say about it

These are not checks that the code runs. They are checks on the things that cost
money if they are wrong:

- That two tills cannot sell the same last item
- That a retried sale does not charge the customer twice
- That VAT comes out correct to the cent
- That the stock ledger always agrees with the running total
- That a cashier cannot sell at their own price
- That the application genuinely loads with the network disconnected

**Five real faults were found this way during development.** The most serious: a
stolen login would have continued working while the logs claimed it had been
cancelled. Another: the till would silently sign the cashier out after any page
reload, which would have been discovered on the shop floor rather than in
testing.

That is the argument for the test suite. It is not about tidiness; it is about
finding these before a customer does.

---

# Part 17 — What is not finished

Say this openly, and say it before anyone asks. A client who discovers eTIMS
later will trust nothing else in the presentation.

## eTIMS — the one real blocker

KRA requires VAT-registered businesses to send every sale through **eTIMS**,
their electronic tax invoice system. The sale is signed by a control unit and the
receipt carries a fiscal number and QR code.

**This system produces correct receipts and a correct VAT report, but they are
not fiscal receipts.** The receipt layout already has the space reserved for the
fiscal number and the QR code, so the printing side is ready.

The work itself is two to three weeks. It cannot start until KRA onboarding is
complete, and that runs on KRA's timetable.

**The first question to settle is whether the business is VAT-registered at
all.** If turnover is under the five-million-shilling threshold and they are not
registered, this item disappears entirely and the timeline roughly halves.

## Card machine integration

Our side is built and tested. Switching it on needs the bank's integration kit,
and some Kenyan banks will not provide that to smaller merchants.

Until then, the standalone arrangement described in Part 4 works today.

**Request this from the bank early** — the answer determines which of the two
card flows the shop will use.

## M-PESA and QuickBooks live

Both are fully built. Neither has yet run against the real service, because that
requires the client's own credentials and, for M-PESA, Safaricom's production
approval.

The code is written to the published specifications and the failure handling is
tested, but there will be a sandbox testing period before either goes live.

## Not built at all

- Weighing scales wired directly to the till (the label-printing arrangement
  works today)
- A customer-facing display
- An independent security audit, which I would recommend commissioning before
  significant money flows through the system. I wrote this code, so I am not the
  right person to certify it.

---

# Part 18 — Timeline and what we need

## Timeline

**If the business is not VAT-registered:** four to six weeks.

**If it is VAT-registered and needs eTIMS:** ten to fourteen weeks.

**Most of that is waiting, not building.** KRA's eTIMS approval, Safaricom's
production sign-off, and the bank's integration documentation are all outside our
control, and they are what will set the date. All three should be requested this
week; the engineering work runs in parallel.

## It can be shorter

Launch with two things deliberately switched off and it is roughly **five
weeks**:

**QuickBooks off at launch.** Sales still queue for accounting from the first
day, and post the moment it is switched on. Nothing is lost and nothing is
re-entered later.

**Card machine standalone.** Removes the bank dependency entirely.

Both can be turned on later with no rework. This is the sequencing I would
recommend.

## What we need from the client

**1. Is the business VAT-registered?** One answer, and it reshapes the whole
timeline.

**2. Start three requests this week:** eTIMS onboarding with KRA, Safaricom
Daraja production approval, and the bank's card integration documentation. These
are the critical path.

**3. The product list, with the VAT treatment of every item.** This is the piece
of homework that cannot be rushed. Unpacked maize flour, bread and milk are
zero-rated; most other things are standard-rated; a few are exempt. Getting it
wrong does not show up as an error anywhere — it quietly misstates the VAT return
every month until KRA notices, and that is the client's liability.

**4. Hardware decisions**, particularly the exact printer model, confirmed before
the printing work is finalised.

**5. A decision on the sequencing** — whether to launch with QuickBooks and card
integration held back.

---

# Part 19 — Closing

Three things to leave them with:

**The money is right.** Every amount is handled as whole cents, never as a
decimal that can drift. VAT is extracted correctly from inclusive prices.
Discounts split across lines without losing a shilling. The server checks every
total independently rather than trusting the till.

**The shop keeps selling when the internet does not.** Not partially, not in a
degraded mode — the till loads, prices correctly, takes cash, prints receipts,
and catches up afterwards without double-charging anyone.

**Every privileged action has a name against it.** Voids, refunds, discounts and
stock adjustments all require a manager standing at the till, and all of them are
recorded with both names and a reason.

What remains is mostly waiting on third parties, and we know exactly who, what
for, and how long.

---

# Appendix A — Demo running order

Twelve minutes, in this order. Each step references the part above.

| Time | Step | Part |
|---|---|---|
| 1 min | Scan two items, show quantity increment, `3*` multiplier | 2 |
| 30 s | Tap a quick-key tile | 2 |
| 1 min | Hold a basket, serve someone else, resume it | 3 |
| 2 min | Split payment — cash plus M-PESA code | 4 |
| **3 min** | **Offline: disconnect, reload, sell, reconnect, watch it sync** | **5** |
| 1.5 min | Cashier tries to void, refused, manager approves | 11 |
| 1.5 min | Today screen, VAT report, PDF export | 12 |
| 1 min | `make verify` — the tests passing | 16 |
| 30 s | Name the eTIMS gap and make the ask | 17, 18 |

If you have more time, add: stock movements ledger (Part 7), CSV import with a
deliberate error (Part 8), and the audit log (Part 14).

---

# Appendix B — Questions the client will ask

**"What happens if the computer dies?"**
The data is in a database on the server, not on the till. Replace the computer,
open the browser, sign in, set the till up once, and carry on. Anything queued on
a dead till is the only thing at risk, which is why the UPS matters.

**"What if the server dies?"**
Tills continue selling offline and queue their sales. Restore the server from the
nightly off-site backup and the tills sync into it. This is why the backup being
off-site and tested matters.

**"Can staff fiddle with it?"**
Not usefully. A cashier cannot change prices, cannot void without a manager,
cannot adjust stock, and cannot export data. Everything they do is logged with
their name.

**"Does it work on a phone?"**
Yes, but it is cramped. A 10-inch tablet or larger is much better.

**"How many tills can it handle?"**
Several per shop comfortably. The locking that prevents two tills overselling the
same item is tested. Load testing at larger scale has not been done, and I would
do that before a multi-branch rollout.

**"Can we have more than one shop?"**
Yes — the system is built for multiple shops, with staff assigned to specific
ones and a manager at one shop unable to see another's data. Stock transfers
between shops are supported. Only a single shop has been tested so far.

**"What happens to our existing data?"**
The product catalogue imports from a CSV. Opening stock is entered as a count.
Historical sales are not migrated — that would mean reconstructing records we
cannot verify. The old system's records stay as the historical archive.

**"How long until staff can use it?"**
About half a day of training per cashier. The till screen is deliberately simple:
scan, take payment, done. Managers need a separate session on overrides, shifts
and reports.

**"What does it cost to run?"**
A server (a modest VPS is sufficient), a domain name, cloud storage for backups
(a few hundred shillings a month), and the hardware per till. QuickBooks is their
existing subscription. M-PESA charges are Safaricom's standard transaction fees.

**"Who owns the code?"**
A commercial question for you, not a technical one — but worth having an answer
ready, because it will be asked.
