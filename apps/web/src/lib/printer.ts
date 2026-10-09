import { renderEscPos, renderText, type ReceiptData } from '@pos/shared';
import { getMeta, setMeta } from './db.js';

/**
 * Receipt printing.
 *
 * Three transports, tried in the order that matches how shops actually wire
 * tills up:
 *
 *  - USB     — WebUSB straight to the printer. No driver, no print dialog.
 *  - NETWORK — raw TCP port 9100 via a small local bridge, for shared printers.
 *  - BROWSER — fallback that renders the text receipt and opens the print
 *              dialog, so a shop with no thermal printer can still trade.
 *
 * The transport is remembered per device, because a till's printer does not
 * change from one sale to the next.
 */

export type PrinterTransport = 'USB' | 'NETWORK' | 'BROWSER' | 'NONE';

export interface PrinterConfig {
  transport: PrinterTransport;
  /** For NETWORK: the bridge that forwards bytes to port 9100. */
  bridgeUrl?: string;
  /** For USB: remembered so we can silently re-open the same device. */
  vendorId?: number;
  productId?: number;
  openDrawerOnCashSale: boolean;
}

const DEFAULT_CONFIG: PrinterConfig = { transport: 'NONE', openDrawerOnCashSale: true };

export async function loadPrinterConfig(): Promise<PrinterConfig> {
  return getMeta<PrinterConfig>('printerConfig', DEFAULT_CONFIG);
}

export async function savePrinterConfig(config: PrinterConfig): Promise<void> {
  await setMeta('printerConfig', config);
}

/* ----------------------------------- USB ---------------------------------- */

interface UsbDeviceLike {
  vendorId: number;
  productId: number;
  opened: boolean;
  open(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(value: number): Promise<void>;
  transferOut(endpoint: number, data: BufferSource): Promise<{ status: string }>;
  configuration?: { interfaces: Array<{ interfaceNumber: number; alternate: { endpoints: Array<{ direction: string; endpointNumber: number }> } }> } | null;
}

/**
 * Copies into a standalone ArrayBuffer. TypeScript's DOM types reject a
 * Uint8Array whose backing buffer could be shared, and the copy is trivial at
 * receipt sizes.
 */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function usb(): { requestDevice(options: unknown): Promise<UsbDeviceLike>; getDevices(): Promise<UsbDeviceLike[]> } | null {
  return (navigator as unknown as { usb?: ReturnType<typeof usb> }).usb ?? null;
}

export function usbSupported(): boolean {
  return usb() !== null;
}

/** Prompts for a printer. Must be called from a user gesture — browsers require it. */
export async function pairUsbPrinter(): Promise<{ vendorId: number; productId: number }> {
  const bridge = usb();
  if (!bridge) throw new Error('This browser does not support USB printing. Use Chrome or Edge.');
  // Class 7 is the USB printer class; filtering avoids showing every device.
  const device = await bridge.requestDevice({ filters: [{ classCode: 7 }] });
  return { vendorId: device.vendorId, productId: device.productId };
}

async function printUsb(bytes: Uint8Array, config: PrinterConfig): Promise<void> {
  const bridge = usb();
  if (!bridge) throw new Error('USB printing is not available in this browser');

  const devices = await bridge.getDevices();
  const device =
    devices.find((d) => d.vendorId === config.vendorId && d.productId === config.productId) ?? devices[0];

  if (!device) throw new Error('Printer not paired. Pair it in Settings.');

  if (!device.opened) await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);

  // Find the bulk OUT endpoint rather than assuming endpoint 1, which varies.
  const iface = device.configuration?.interfaces?.[0];
  const endpoint = iface?.alternate.endpoints.find((e) => e.direction === 'out');
  if (!iface || !endpoint) throw new Error('Could not find a printer endpoint');

  await device.claimInterface(iface.interfaceNumber);
  const result = await device.transferOut(endpoint.endpointNumber, toBuffer(bytes));
  if (result.status !== 'ok') throw new Error(`Printer returned ${result.status}`);
}

/* --------------------------------- Network -------------------------------- */

async function printNetwork(bytes: Uint8Array, config: PrinterConfig): Promise<void> {
  if (!config.bridgeUrl) throw new Error('No printer bridge configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(new URL('/print', config.bridgeUrl).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Blob([toBuffer(bytes)], { type: 'application/octet-stream' }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Printer bridge returned ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------- Browser -------------------------------- */

/** Last resort: a monospace page in the print dialog. Not a thermal receipt. */
function printBrowser(data: ReceiptData): void {
  const text = renderText(data);
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);

  const doc = frame.contentDocument;
  if (!doc) return;

  doc.open();
  doc.write(`<!doctype html><html><head><title>Receipt</title><style>
    @page { size: 80mm auto; margin: 3mm; }
    body { font-family: ui-monospace, "Courier New", monospace; font-size: 11px; white-space: pre; margin: 0; }
  </style></head><body>${text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] ?? c)}</body></html>`);
  doc.close();

  frame.contentWindow?.focus();
  frame.contentWindow?.print();
  // Leave time for the dialog before tearing the frame down.
  setTimeout(() => frame.remove(), 30_000);
}

/* ---------------------------------- Public -------------------------------- */

export interface PrintResult {
  printed: boolean;
  transport: PrinterTransport;
  error?: string;
}

/**
 * Prints a receipt. Never throws: a printer failure must not roll back a sale
 * that has already been taken, so the caller gets a result and shows a warning.
 */
export async function printReceipt(
  data: ReceiptData,
  options: { openDrawer?: boolean; copies?: number } = {},
): Promise<PrintResult> {
  const config = await loadPrinterConfig();
  if (config.transport === 'NONE') return { printed: false, transport: 'NONE', error: 'No printer configured' };

  try {
    if (config.transport === 'BROWSER') {
      printBrowser(data);
      return { printed: true, transport: 'BROWSER' };
    }

    const bytes = renderEscPos(data, {
      openDrawer: options.openDrawer ?? false,
      copies: options.copies ?? 1,
    });

    if (config.transport === 'USB') await printUsb(bytes, config);
    else await printNetwork(bytes, config);

    return { printed: true, transport: config.transport };
  } catch (err) {
    return {
      printed: false,
      transport: config.transport,
      error: err instanceof Error ? err.message : 'Printing failed',
    };
  }
}

/** Kicks the cash drawer without printing anything. */
export async function openCashDrawer(): Promise<PrintResult> {
  const config = await loadPrinterConfig();
  if (config.transport === 'NONE' || config.transport === 'BROWSER') {
    return { printed: false, transport: config.transport, error: 'Drawer needs a thermal printer' };
  }
  try {
    // ESC p 0 25 250 — the standard drawer-kick pulse.
    const bytes = new Uint8Array([0x1b, 0x70, 0x00, 0x19, 0xfa]);
    if (config.transport === 'USB') await printUsb(bytes, config);
    else await printNetwork(bytes, config);
    return { printed: true, transport: config.transport };
  } catch (err) {
    return { printed: false, transport: config.transport, error: err instanceof Error ? err.message : 'Failed' };
  }
}

export async function printTestPage(): Promise<PrintResult> {
  return printReceipt(
    {
      receiptNumber: 'TEST-000000',
      soldAt: new Date(),
      cashierName: 'Printer test',
      lines: [
        { productName: 'Test item', quantity: 1000, unitPrice: 10000, lineTotal: 10000 },
        { productName: 'Weighed item', variantLabel: 'per kg', quantity: 1500, unitPrice: 20000, lineTotal: 30000 },
      ],
      subtotal: 40000,
      discountTotal: 0,
      taxTotal: 5517,
      roundingAdjustment: 0,
      total: 40000,
      changeGiven: 10000,
      payments: [{ method: 'CASH', amount: 40000 }],
      taxBreakdown: [{ taxCode: 'STANDARD', rateBasisPoints: 1600, net: 34483, tax: 5517 }],
      store: { name: 'Printer Test', receiptFooter: 'If you can read this, printing works.' },
    },
    { openDrawer: false },
  );
}
