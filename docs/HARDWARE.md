# Hardware

What works today, what it needs, and how to set it up.

---

## Summary

| Device | Status | How it connects |
|---|---|---|
| **Barcode scanner** | ✅ Works now, no setup | USB keyboard-wedge — the scanner types the code and presses Enter |
| **Thermal receipt printer** | ✅ Built, needs your printer to confirm | WebUSB direct, or a local bridge on port 9100 |
| **Cash drawer** | ✅ Built | Fires through the printer (standard RJ11/RJ12 kick) |
| **Touch screen** | ✅ Works now | Large hit areas, 42px minimum; designed touch-first |
| **Customer display** | ❌ Not supported | Would need a second window or serial pole display |
| **Weighing scale** | ❌ Not integrated | Weigh-and-label scales work: they print a barcode you scan |
| **Card terminal (PDQ)** | ⚠️ POS side built | Needs the acquirer's ECR bridge — see OPERATIONS.md |

---

## Barcode scanners — nothing to configure

Almost every USB barcode scanner sold in Kenya is a **keyboard wedge**: the
computer sees it as a keyboard, and scanning types the digits then presses Enter.
That is exactly what the scan box expects, so any of these work out of the box:

- Zebra / Symbol LS2208, DS2208 (the most common in Kenyan retail)
- Honeywell Voyager 1200g / 1250g
- Datalogic QuickScan
- Generic no-brand USB scanners

**Setup:** plug it in, click into the scan box, scan. Nothing else.

**Test it:** open the till and scan any item. If digits appear but nothing is
added, the scanner is not sending Enter — scan the "Add CR suffix" barcode in
your scanner's manual.

**Bluetooth scanners** work identically once paired, as the OS presents them as
keyboards too.

### Scanner configuration worth doing once

Most scanners ship ready to use. Two settings sometimes need changing, both via
barcodes in the scanner's manual:

- **Add a carriage-return suffix** if scanning does not submit.
- **Disable the beep on a bad read** if the counter is noisy — staff stop hearing
  the difference and scan the wrong thing.

---

## Receipt printers

### Which to buy

Any **80mm ESC/POS thermal printer**. Tested design targets:

- Epson TM-T20III, TM-T82 — the reliable choice, widely available in Nairobi
- Xprinter XP-80 series — the common budget option
- Star TSP100 series
- Most no-brand 80mm printers, which almost all speak ESC/POS

Avoid 58mm printers: the receipt layout assumes 42 characters, which is 80mm.

### How to connect it

Three transports, chosen under **Settings → Receipt printer**:

**1. USB direct (recommended).** The browser talks to the printer over WebUSB —
no driver, no print dialog, no OS printer queue.

- Requires Chrome or Edge (Firefox and Safari have no WebUSB)
- Click **Pair printer**, choose it from the browser prompt
- On Linux, the user needs permission for the device; add a udev rule:
  ```
  # /etc/udev/rules.d/99-escpos.rules  (replace the ids with your printer's)
  SUBSYSTEM=="usb", ATTRS{idVendor}=="04b8", MODE="0666", GROUP="plugdev"
  ```
  Then `sudo udevadm control --reload-rules && sudo udevadm trigger`.
- On Windows, the printer must **not** be installed as a Windows printer, or
  Windows claims the device and WebUSB cannot open it. Uninstall the driver, or
  use the bridge below instead.

**2. Network bridge.** For a printer shared between tills, or where WebUSB is
awkward. Needs a small service on the till that accepts bytes and forwards them
to the printer's port 9100. Set its address in Settings.

**3. Browser print dialog.** A fallback so a shop with no thermal printer can
still trade. It prints the receipt text to whatever printer the OS has. No paper
cut, no cash drawer. Use it only until a real printer is fitted.

### Test it

**Settings → Receipt printer → Print test receipt.** You should get a receipt
with a header, two lines, a total, a VAT summary, and a clean cut.

If the text is garbled, the printer is probably not in ESC/POS mode — check its
manual for a self-test print, which usually shows the current emulation.

---

## Cash drawers

Cash drawers do not connect to the computer. They plug into the **printer** with
an RJ11/RJ12 cable, and the printer fires the solenoid when told to.

So: a cash drawer needs a working thermal printer. There is no way around this
short of a USB-serial drawer, which is rare and not supported.

- Plug the drawer into the printer's **DK** port
- Settings → Receipt printer → tick **Open the cash drawer on cash sales**
- Test with **Test cash drawer**

The drawer opens automatically on any sale with a cash component, and not on a
card- or M-PESA-only sale — which is the behaviour you want, since the drawer
staying shut is itself a control.

---

## Touch screens and terminals

The interface is built touch-first: minimum 42px targets, 54px for primary
actions, no hover-only affordances, and a numeric keypad for PIN entry.

**What to buy:** anything running a current Chrome. An all-in-one POS terminal,
a cheap Android tablet, or a repurposed laptop all work.

**Screen size:** the till layout is two columns above 1000px and stacks to one
below. A 10-inch tablet is comfortable; a phone works but is cramped.

**Install it as an app:** in Chrome, *Install POS* in the address bar. It then
opens full-screen with no browser chrome, which stops staff navigating away, and
the service worker means it still opens with no internet.

---

## Weighing scales

Not integrated directly, and for most shops that is fine.

**The usual arrangement** is a weigh-and-label scale at the counter: staff weigh
the produce, the scale prints a barcode label encoding the weight and price, and
the cashier scans it like any other item. That works today with no integration.

**If you need direct integration** — the scale wired to the till so weight
appears automatically — that is additional work: a serial bridge reading the
scale's protocol (usually a simple ASCII stream) and feeding it into the line
quantity. Tell me the scale model and I can build it.

Products sold by weight are already supported: set **Sold by: Kilogram** on the
product and quantities carry three decimal places exactly.

---

## Customer-facing display

Not supported. Two options if you need one:

- A **second browser window** on a customer-facing screen showing the basket —
  moderate work, no hardware beyond a monitor.
- A **serial pole display** (the small two-line VFD on a stalk) — needs a bridge
  like the printer's.

Neither is built. Worth knowing many Kenyan shops run without one.

---

## A practical starting kit

For one till, in rough order of importance:

1. **Terminal** — any device running current Chrome
2. **80mm thermal printer** — Epson TM-T20III if budget allows, Xprinter XP-80 otherwise
3. **USB barcode scanner** — Zebra LS2208 or any keyboard-wedge
4. **Cash drawer** — must match the printer's kick port
5. **UPS** — small one per till; power cuts during a write are how POS systems lose transactions
6. Label printer, only if you need to barcode your own stock

---

## Checking what works on a given machine

**Settings → Receipt printer** reports what the browser supports and lets you
test each device. Run that on every till before go-live rather than discovering
a WebUSB problem on the first busy morning.
