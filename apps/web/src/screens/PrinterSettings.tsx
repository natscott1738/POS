import { useEffect, useState } from 'react';
import { toast } from '../lib/store.js';
import { Field } from '../components/ui.js';
import {
  loadPrinterConfig,
  savePrinterConfig,
  pairUsbPrinter,
  printTestPage,
  openCashDrawer,
  usbSupported,
  type PrinterConfig,
  type PrinterTransport,
} from '../lib/printer.js';

export default function PrinterSettings() {
  const [config, setConfig] = useState<PrinterConfig | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadPrinterConfig().then(setConfig);
  }, []);

  if (!config) return <p className="muted">Loading…</p>;

  async function update(patch: Partial<PrinterConfig>): Promise<void> {
    const next = { ...(config as PrinterConfig), ...patch };
    setConfig(next);
    await savePrinterConfig(next);
  }

  return (
    <>
      <Field label="How this till prints">
        <select
          className="input"
          value={config.transport}
          onChange={(e) => void update({ transport: e.target.value as PrinterTransport })}
        >
          <option value="NONE">No printer</option>
          <option value="USB">USB thermal printer</option>
          <option value="NETWORK">Network printer (via bridge)</option>
          <option value="BROWSER">Browser print dialog (fallback)</option>
        </select>
      </Field>

      {config.transport === 'USB' && (
        <>
          {!usbSupported() && (
            <div className="banner warning">
              This browser cannot talk to USB devices. Use Chrome or Edge, or switch to the
              network bridge.
            </div>
          )}
          <div className="row" style={{ marginBottom: 12 }}>
            <button
              className="btn"
              disabled={busy || !usbSupported()}
              onClick={async () => {
                setBusy(true);
                try {
                  const device = await pairUsbPrinter();
                  await update(device);
                  toast.success('Printer paired');
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : 'Pairing cancelled');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {config.vendorId ? 'Re-pair printer' : 'Pair printer'}
            </button>
            {config.vendorId && (
              <span className="muted mono" style={{ fontSize: 12 }}>
                {config.vendorId.toString(16)}:{config.productId?.toString(16)}
              </span>
            )}
          </div>
        </>
      )}

      {config.transport === 'NETWORK' && (
        <Field label="Printer bridge address" hint="A small service on the till forwarding bytes to port 9100.">
          <input
            className="input mono"
            value={config.bridgeUrl ?? ''}
            onChange={(e) => void update({ bridgeUrl: e.target.value })}
            placeholder="http://127.0.0.1:9101"
          />
        </Field>
      )}

      {config.transport === 'BROWSER' && (
        <div className="banner warning">
          The browser print dialog works, but it is not a thermal receipt — no paper cut and
          no cash drawer. Use it only until a proper printer is fitted.
        </div>
      )}

      {config.transport !== 'NONE' && (
        <>
          <label className="row" style={{ fontSize: 14, marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={config.openDrawerOnCashSale}
              onChange={(e) => void update({ openDrawerOnCashSale: e.target.checked })}
            />
            Open the cash drawer on cash sales
          </label>

          <div className="row">
            <button
              className="btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const result = await printTestPage();
                setBusy(false);
                if (result.printed) toast.success('Test receipt sent');
                else toast.error(result.error ?? 'Printing failed');
              }}
            >
              Print test receipt
            </button>
            <button
              className="btn ghost"
              disabled={busy || config.transport === 'BROWSER'}
              onClick={async () => {
                const result = await openCashDrawer();
                if (result.printed) toast.success('Drawer opened');
                else toast.error(result.error ?? 'Could not open the drawer');
              }}
            >
              Test cash drawer
            </button>
          </div>
        </>
      )}
    </>
  );
}
