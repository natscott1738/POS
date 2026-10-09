import { useMemo, useState } from 'react';
import { formatCents } from '@pos/shared';
import { api } from '../lib/api.js';
import { useApi, useMutation } from '../lib/useApi.js';
import { useAuth } from '../lib/store.js';
import { Modal } from '../components/Modal.js';
import { Page, Field, FormGrid, Empty, Loading, MoneyInput, QuantityInput, Badge } from '../components/ui.js';
import { formatQuantity } from '../components/Money.js';

interface StockRow {
  storeId: string;
  variantId: string;
  sku: string;
  productName: string;
  quantityOnHand: number;
  averageCost: number;
  unitPrice: number;
  costValue: number;
  retailValue: number;
}

interface Movement {
  id: string;
  sku: string;
  productName: string;
  reason: string;
  quantityDelta: number;
  balanceAfter: number;
  note: string | null;
  occurredAt: string;
}

type Tab = 'ON_HAND' | 'LOW' | 'MOVEMENTS';

export default function Inventory() {
  const { storeId, can } = useAuth();
  const [tab, setTab] = useState<Tab>('ON_HAND');
  const [search, setSearch] = useState('');
  const [adjusting, setAdjusting] = useState<StockRow | null>(null);
  const [receiving, setReceiving] = useState(false);

  // Valuation is the only endpoint that returns *everything* on hand, which is
  // what someone means by "inventory" — low stock alone is an empty screen
  // whenever the shop is well stocked.
  const valuation = useApi<{ items: StockRow[]; totals: { costValue: number; retailValue: number } }>(
    tab === 'ON_HAND' ? '/reports/stock?kind=VALUATION&limit=500' : null,
    [tab],
  );
  const low = useApi<{ items: Array<StockRow & { reorderPoint: number; reorderQuantity: number }> }>(
    tab === 'LOW' && storeId ? `/inventory/low-stock?storeId=${storeId}&limit=200` : null,
    [tab, storeId],
  );
  const movements = useApi<{ movements: Movement[] }>(
    tab === 'MOVEMENTS' ? '/inventory/movements?limit=200' : null,
    [tab],
  );
  const alerts = useApi<{ alerts: Array<{ id: string; productName: string; kind: string }> }>('/inventory/alerts');

  const rows = useMemo(() => {
    const items = valuation.data?.items ?? [];
    if (!search) return items;
    const needle = search.toLowerCase();
    return items.filter((r) => r.productName.toLowerCase().includes(needle) || r.sku.toLowerCase().includes(needle));
  }, [valuation.data, search]);

  function reloadAll(): void {
    void valuation.reload();
    void low.reload();
    void movements.reload();
    void alerts.reload();
  }

  return (
    <Page
      title="Inventory"
      subtitle="Stock on hand, movements and reordering"
      actions={
        can('inventory:receive') && (
          <button className="btn primary" onClick={() => setReceiving(true)}>Receive stock</button>
        )
      }
    >
      {(alerts.data?.alerts.length ?? 0) > 0 && (
        <div className="banner warning">
          <strong>{alerts.data?.alerts.length}</strong> open stock alert
          {alerts.data?.alerts.length === 1 ? '' : 's'} —{' '}
          {alerts.data?.alerts.slice(0, 3).map((a) => a.productName).join(', ')}
        </div>
      )}

      <div className="tabs" style={{ maxWidth: 420 }}>
        <button className={tab === 'ON_HAND' ? 'active' : ''} onClick={() => setTab('ON_HAND')}>On hand</button>
        <button className={tab === 'LOW' ? 'active' : ''} onClick={() => setTab('LOW')}>Low stock</button>
        <button className={tab === 'MOVEMENTS' ? 'active' : ''} onClick={() => setTab('MOVEMENTS')}>Movements</button>
      </div>

      {tab === 'ON_HAND' && (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <input
              className="input"
              style={{ maxWidth: 320 }}
              placeholder="Search stock"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="spacer" />
            {valuation.data && (
              <span className="muted" style={{ fontSize: 13 }}>
                At cost <strong>{formatCents(valuation.data.totals.costValue)}</strong> · at retail{' '}
                <strong>{formatCents(valuation.data.totals.retailValue)}</strong>
              </span>
            )}
          </div>

          <div className="card" style={{ padding: 0 }}>
            {valuation.loading ? (
              <Loading />
            ) : rows.length === 0 ? (
              <Empty message={search ? 'Nothing matches that search.' : 'No stock recorded yet. Receive stock to get started.'} />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Product</th>
                    <th className="num">On hand</th>
                    <th className="num">Avg cost</th>
                    <th className="num">Value at cost</th>
                    <th className="num">Price</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.storeId}-${row.variantId}`}>
                      <td className="mono">{row.sku}</td>
                      <td>{row.productName}</td>
                      <td className="num" style={{ color: row.quantityOnHand <= 0 ? 'var(--danger)' : undefined }}>
                        {formatQuantity(row.quantityOnHand)}
                      </td>
                      <td className="num muted">{formatCents(row.averageCost)}</td>
                      <td className="num">{formatCents(row.costValue)}</td>
                      <td className="num muted">{formatCents(row.unitPrice)}</td>
                      <td className="right">
                        {can('inventory:read') && (
                          <button
                            className="btn ghost"
                            style={{ minHeight: 28, padding: '2px 8px', fontSize: 12 }}
                            onClick={() => setAdjusting(row)}
                          >
                            Adjust
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {tab === 'LOW' && (
        <div className="card" style={{ padding: 0 }}>
          {low.loading ? (
            <Loading />
          ) : (low.data?.items.length ?? 0) === 0 ? (
            <Empty message="Nothing is below its reorder point. Set reorder points on a product to be warned before you run out." />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>SKU</th><th>Product</th>
                  <th className="num">On hand</th><th className="num">Reorder at</th><th className="num">Suggested</th>
                </tr>
              </thead>
              <tbody>
                {low.data?.items.map((row) => (
                  <tr key={row.variantId}>
                    <td className="mono">{row.sku}</td>
                    <td>{row.productName}</td>
                    <td className="num" style={{ color: row.quantityOnHand <= 0 ? 'var(--danger)' : 'var(--warning)' }}>
                      {formatQuantity(row.quantityOnHand)}
                    </td>
                    <td className="num">{formatQuantity(row.reorderPoint)}</td>
                    <td className="num">{formatQuantity(row.reorderQuantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'MOVEMENTS' && (
        <div className="card" style={{ padding: 0 }}>
          {movements.loading ? (
            <Loading />
          ) : (movements.data?.movements.length ?? 0) === 0 ? (
            <Empty message="No stock movements recorded yet." />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th><th>SKU</th><th>Product</th><th>Reason</th>
                  <th className="num">Change</th><th className="num">Balance</th><th>Note</th>
                </tr>
              </thead>
              <tbody>
                {movements.data?.movements.map((m) => (
                  <tr key={m.id}>
                    <td className="muted">{new Date(m.occurredAt).toLocaleString()}</td>
                    <td className="mono">{m.sku}</td>
                    <td>{m.productName}</td>
                    <td><Badge>{m.reason.replace(/_/g, ' ').toLowerCase()}</Badge></td>
                    <td className="num" style={{ color: m.quantityDelta < 0 ? 'var(--danger)' : 'var(--success)' }}>
                      {m.quantityDelta > 0 ? '+' : ''}{formatQuantity(m.quantityDelta)}
                    </td>
                    <td className="num">{formatQuantity(m.balanceAfter)}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{m.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {adjusting && storeId && (
        <AdjustStock
          row={adjusting}
          storeId={storeId}
          onClose={() => setAdjusting(null)}
          onDone={() => { setAdjusting(null); reloadAll(); }}
        />
      )}
      {receiving && storeId && (
        <ReceiveStock storeId={storeId} onClose={() => setReceiving(false)} onDone={() => { setReceiving(false); reloadAll(); }} />
      )}
    </Page>
  );
}

const ADJUST_REASONS = [
  ['DAMAGE', 'Damaged'],
  ['THEFT', 'Theft or loss'],
  ['EXPIRY', 'Expired'],
  ['STOCK_COUNT', 'Correcting a count'],
  ['MANUAL_ADJUSTMENT', 'Other adjustment'],
] as const;

/** Adjustments are the main shrinkage route, so the server also demands an override. */
function AdjustStock({
  row,
  storeId,
  onClose,
  onDone,
}: {
  row: StockRow;
  storeId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const can = useAuth((s) => s.can);
  const [delta, setDelta] = useState(0);
  const [reason, setReason] = useState<string>('DAMAGE');
  const [note, setNote] = useState('');
  const [staffCode, setStaffCode] = useState('');
  const [pin, setPin] = useState('');
  const { busy, run } = useMutation();

  const needsOverride = !can('inventory:adjust');

  return (
    <Modal title={`Adjust stock — ${row.sku}`} onClose={onClose}>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        {row.productName} · currently <strong>{formatQuantity(row.quantityOnHand)}</strong> on hand.
      </p>

      <Field label="Change (negative to remove)" hint={`New balance: ${formatQuantity(row.quantityOnHand + delta)}`}>
        <QuantityInput value={delta} onChange={setDelta} autoFocus />
      </Field>
      <Field label="Reason">
        <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
          {ADJUST_REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </Field>
      <Field label="Note">
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened" />
      </Field>

      {needsOverride && (
        <>
          <div className="banner warning">A manager must authorise stock adjustments.</div>
          <FormGrid>
            <Field label="Manager code">
              <input className="input" value={staffCode} onChange={(e) => setStaffCode(e.target.value.toUpperCase())} />
            </Field>
            <Field label="PIN">
              <input className="input mono" type="password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
            </Field>
          </FormGrid>
        </>
      )}

      <div className="row">
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={busy || delta === 0 || note.trim().length < 3 || (needsOverride && (!staffCode || pin.length < 4))}
          onClick={() =>
            void run(
              () =>
                api.post('/inventory/adjust', {
                  storeId,
                  variantId: row.variantId,
                  quantityDelta: delta,
                  reason,
                  note,
                  ...(needsOverride ? { override: { staffCode, pin, reason: note } } : {}),
                }),
              { success: 'Stock adjusted', onDone },
            )
          }
        >
          Apply adjustment
        </button>
      </div>
    </Modal>
  );
}

function ReceiveStock({ storeId, onClose, onDone }: { storeId: string; onClose: () => void; onDone: () => void }) {
  const { data } = useApi<{ products: Array<{ id: string; name: string; variants: Array<{ id: string; sku: string }> }> }>(
    '/catalog/products?limit=200',
  );
  const [supplierName, setSupplier] = useState('');
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<Array<{ variantId: string; quantity: number; unitCost: number }>>([
    { variantId: '', quantity: 0, unitCost: 0 },
  ]);
  const { busy, run } = useMutation();

  const options = (data?.products ?? []).flatMap((p) =>
    p.variants.map((v) => ({ id: v.id, label: `${v.sku} — ${p.name}` })),
  );

  const valid =
    supplierName.trim().length > 1 &&
    reference.trim().length > 0 &&
    lines.some((l) => l.variantId && l.quantity > 0);

  return (
    <Modal title="Receive stock" onClose={onClose} wide>
      <FormGrid>
        <Field label="Supplier">
          <input className="input" value={supplierName} onChange={(e) => setSupplier(e.target.value)} autoFocus />
        </Field>
        <Field label="Delivery note / invoice number">
          <input className="input mono" value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      </FormGrid>

      <table style={{ marginBottom: 10 }}>
        <thead>
          <tr><th>Item</th><th className="num">Quantity</th><th className="num">Unit cost</th><th /></tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={index}>
              <td>
                <select
                  className="input"
                  value={line.variantId}
                  onChange={(e) => setLines((l) => l.map((x, i) => (i === index ? { ...x, variantId: e.target.value } : x)))}
                >
                  <option value="">Choose an item…</option>
                  {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </td>
              <td style={{ width: 120 }}>
                <QuantityInput
                  value={line.quantity}
                  onChange={(milli) => setLines((l) => l.map((x, i) => (i === index ? { ...x, quantity: milli } : x)))}
                />
              </td>
              <td style={{ width: 140 }}>
                <MoneyInput
                  value={line.unitCost}
                  onChange={(cents) => setLines((l) => l.map((x, i) => (i === index ? { ...x, unitCost: cents } : x)))}
                />
              </td>
              <td>
                {lines.length > 1 && (
                  <button className="btn ghost" onClick={() => setLines((l) => l.filter((_, i) => i !== index))}>✕</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button className="btn ghost" onClick={() => setLines((l) => [...l, { variantId: '', quantity: 0, unitCost: 0 }])}>
        Add line
      </button>

      <p className="muted" style={{ fontSize: 13 }}>
        Receiving updates the moving-average cost, which is what stock valuation and
        gross margin are calculated from.
      </p>

      <div className="row">
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={busy || !valid}
          onClick={() =>
            void run(
              () =>
                api.post('/inventory/receipts', {
                  storeId,
                  supplierName,
                  reference,
                  lines: lines.filter((l) => l.variantId && l.quantity > 0),
                }),
              { success: 'Stock received', onDone },
            )
          }
        >
          Receive stock
        </button>
      </div>
    </Modal>
  );
}
