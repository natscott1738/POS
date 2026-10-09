import { useEffect, useState } from 'react';
import { formatCents } from '@pos/shared';
import { api } from '../lib/api.js';
import { useAuth, toast } from '../lib/store.js';
import { Modal } from '../components/Modal.js';
import { Field } from '../components/ui.js';
import { printReceipt } from '../lib/printer.js';
import type { ReceiptData } from '@pos/shared';

interface SaleRow {
  id: string;
  receiptNumber: string;
  status: string;
  total: number;
  amountRefunded: number;
  cashierName: string | null;
  soldAt: string;
  createdOffline: boolean;
  oversold: boolean;
}

export default function Sales() {
  const can = useAuth((s) => s.can);
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  async function load(): Promise<void> {
    try {
      const query = search.trim() ? `?receiptNumber=${encodeURIComponent(search.trim())}` : '?limit=50';
      const result = await api.get<{ sales: SaleRow[] }>(`/sales${query}`);
      setSales(result.sales);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load sales');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Sales</h1>
      <div className="row" style={{ marginBottom: 14 }}>
        <input
          className="input mono"
          style={{ maxWidth: 320 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void load()}
          placeholder="Receipt number"
        />
        <button className="btn" onClick={() => void load()}>Search</button>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Receipt</th>
              <th>When</th>
              <th>Cashier</th>
              <th>Status</th>
              <th className="num">Total</th>
              <th className="num">Refunded</th>
            </tr>
          </thead>
          <tbody>
            {sales.map((sale) => (
              <tr key={sale.id} onClick={() => setSelected(sale.id)} style={{ cursor: 'pointer' }}>
                <td className="mono">
                  {sale.receiptNumber}
                  {sale.createdOffline && <span className="muted" title="Created offline"> ⏱</span>}
                  {sale.oversold && <span style={{ color: 'var(--warning)' }} title="Took stock negative"> ⚠</span>}
                </td>
                <td>{new Date(sale.soldAt).toLocaleString()}</td>
                <td>{sale.cashierName ?? '—'}</td>
                <td>
                  <span className="pill" style={{ color: sale.status === 'VOIDED' ? 'var(--danger)' : undefined }}>
                    {sale.status}
                  </span>
                </td>
                <td className="num">{formatCents(sale.total)}</td>
                <td className="num">{sale.amountRefunded > 0 ? formatCents(sale.amountRefunded) : '—'}</td>
              </tr>
            ))}
            {sales.length === 0 && (
              <tr><td colSpan={6} className="muted" style={{ padding: 20 }}>No sales found.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && <SaleDetail saleId={selected} onClose={() => { setSelected(null); void load(); }} canVoid={can('sale:read')} />}
    </div>
  );
}

function SaleDetail({ saleId, onClose, canVoid }: { saleId: string; onClose: () => void; canVoid: boolean }) {
  const [data, setData] = useState<Record<string, any> | null>(null);
  const [voiding, setVoiding] = useState(false);

  useEffect(() => {
    void api.get<Record<string, any>>(`/sales/${saleId}`).then(setData).catch(() => setData(null));
  }, [saleId]);

  if (!data) return <Modal title="Sale" onClose={onClose}><p className="muted">Loading…</p></Modal>;

  const sale = data.sale as SaleRow & { taxTotal: number; netTotal: number; voidReason?: string };

  return (
    <Modal title={`Receipt ${sale.receiptNumber}`} onClose={onClose} wide>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="pill">{sale.status}</span>
        <div className="spacer" />
        <strong style={{ fontSize: 20 }}>{formatCents(sale.total)}</strong>
      </div>

      <table style={{ marginBottom: 14 }}>
        <thead>
          <tr><th>Item</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Total</th></tr>
        </thead>
        <tbody>
          {(data.lines as any[]).map((line) => (
            <tr key={line.id}>
              <td>
                {line.productName}
                {line.variantLabel && <div className="muted" style={{ fontSize: 12 }}>{line.variantLabel}</div>}
              </td>
              <td className="num">{line.quantity / 1000}</td>
              <td className="num">{formatCents(line.unitPrice)}</td>
              <td className="num">{formatCents(line.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="card" style={{ marginBottom: 14 }}>
        <strong style={{ fontSize: 13 }}>Payments</strong>
        {(data.payments as any[]).map((p) => (
          <div key={p.id} className="row" style={{ padding: '4px 0' }}>
            <span>{p.method}</span>
            {p.externalReference && <span className="muted mono" style={{ fontSize: 12 }}>{p.externalReference}</span>}
            <div className="spacer" />
            <span className="mono">{formatCents(p.amount)}</span>
          </div>
        ))}
      </div>

      {sale.voidReason && <div className="banner error">Voided: {sale.voidReason}</div>}

      <div className="row">
        <button
          className="btn ghost"
          onClick={async () => {
            const receipt: ReceiptData = {
              receiptNumber: sale.receiptNumber,
              soldAt: sale.soldAt,
              cashierName: data.cashierName ?? null,
              customerName: (data.customer as { fullName?: string } | null)?.fullName ?? null,
              lines: (data.lines as any[]).map((l) => ({
                productName: l.productName,
                variantLabel: l.variantLabel,
                quantity: l.quantity,
                unitPrice: l.unitPrice,
                lineTotal: l.lineTotal,
                lineDiscount: l.lineDiscount + l.allocatedOrderDiscount,
              })),
              subtotal: (sale as any).grossSubtotal,
              discountTotal: (sale as any).lineDiscountTotal + (sale as any).orderDiscountTotal,
              taxTotal: sale.taxTotal,
              roundingAdjustment: (sale as any).roundingAdjustment ?? 0,
              total: sale.total,
              changeGiven: (sale as any).changeGiven ?? 0,
              payments: (data.payments as any[]).map((p) => ({
                method: p.method,
                amount: p.amount,
                externalReference: p.externalReference,
                maskedPan: p.maskedPan,
              })),
              taxBreakdown: (sale as any).taxBreakdown ?? [],
              // Marked so a reprint can never be passed off as an original.
              isReprint: true,
              store: (data.store as any) ?? { name: 'Receipt' },
            };
            const result = await printReceipt(receipt);
            if (!result.printed) toast.error(result.error ?? 'Printing failed');
          }}
        >
          Reprint
        </button>
        <div className="spacer" />
        {canVoid && sale.status === 'COMPLETED' && (
          <button className="btn danger" onClick={() => setVoiding(true)}>Void</button>
        )}
      </div>

      {voiding && <VoidDialog saleId={saleId} onClose={() => setVoiding(false)} onDone={onClose} />}
    </Modal>
  );
}

/**
 * Void requires a reason, and a manager's credentials when the signed-in user
 * lacks the permission. The server enforces both independently.
 */
function VoidDialog({ saleId, onClose, onDone }: { saleId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [staffCode, setStaffCode] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (reason.trim().length < 3) {
      toast.error('A reason is required');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/sales/${saleId}/void`, {
        reason,
        ...(staffCode && pin ? { override: { staffCode: staffCode.toUpperCase(), pin, reason } } : {}),
      });
      toast.success('Sale voided');
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Void failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Void sale" onClose={onClose}>
      <Field label="Reason">
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
      <p className="muted" style={{ fontSize: 13 }}>
        If you are not authorised to void, a manager must approve below.
      </p>
      <div className="row">
        <Field label="Manager code">
          <input className="input" value={staffCode} onChange={(e) => setStaffCode(e.target.value.toUpperCase())} />
        </Field>
        <Field label="PIN">
          <input className="input mono" type="password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        </Field>
      </div>
      <div className="row">
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn danger" disabled={busy} onClick={() => void submit()}>Void sale</button>
      </div>
    </Modal>
  );
}
