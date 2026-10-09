import { useEffect, useState } from 'react';
import { formatCents } from '@pos/shared';
import { api, download } from '../lib/api.js';
import { useApi, useMutation } from '../lib/useApi.js';
import { useAuth, toast } from '../lib/store.js';
import { Modal } from '../components/Modal.js';
import { Field, MoneyInput, Badge } from '../components/ui.js';

export interface ShiftSummary {
  tenders: Array<{ method: string; total: number; count: number }>;
  cashNet: number;
  saleCount: number;
  voidCount: number;
  grossSales: number;
  taxTotal: number;
  discountTotal: number;
  refundTotal: number;
  changeGiven: number;
}

export interface Shift {
  id: string;
  status: string;
  openingFloat: number;
  countedCash: number | null;
  expectedCash: number | null;
  cashVariance: number | null;
  openedAt: string;
  closedAt: string | null;
}

/**
 * Shift strip above the till. A shift is what makes the drawer reconcilable at
 * the end of the day, so it is surfaced where the cashier already is rather than
 * buried in a menu.
 */
export function ShiftBar({ storeId, terminalId }: { storeId: string; terminalId: string }) {
  const { data, reload } = useApi<{ shift: Shift | null; summary: ShiftSummary | null }>(
    `/shifts/current?terminalId=${terminalId}`,
    [terminalId],
  );
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const setShift = useAuth((s) => s.setShift);

  const shift = data?.shift ?? null;

  // Publish the open shift so the payment panel can attach sales to it.
  useEffect(() => {
    setShift(shift?.id ?? null);
  }, [shift?.id, setShift]);

  return (
    <>
      <div className="card" style={{ padding: '10px 14px' }}>
        <div className="row">
          {shift ? (
            <>
              <Badge tone="success">Shift open</Badge>
              <span className="muted" style={{ fontSize: 13 }}>
                since {new Date(shift.openedAt).toLocaleTimeString()} · float{' '}
                {formatCents(shift.openingFloat)}
              </span>
              {data?.summary && (
                <span className="muted" style={{ fontSize: 13 }}>
                  · {data.summary.saleCount} sale{data.summary.saleCount === 1 ? '' : 's'} ·{' '}
                  {formatCents(data.summary.grossSales)}
                </span>
              )}
              <div className="spacer" />
              <button className="btn ghost" onClick={() => setClosing(true)}>Close shift</button>
            </>
          ) : (
            <>
              <Badge tone="warning">No shift open</Badge>
              <span className="muted" style={{ fontSize: 13 }}>
                Sales still work, but cash cannot be reconciled without one.
              </span>
              <div className="spacer" />
              <button className="btn" onClick={() => setOpening(true)}>Open shift</button>
            </>
          )}
        </div>
      </div>

      {opening && (
        <OpenShift
          storeId={storeId}
          terminalId={terminalId}
          onClose={() => setOpening(false)}
          onDone={() => { setOpening(false); void reload(); }}
        />
      )}
      {closing && shift && data?.summary && (
        <CloseShift
          shift={shift}
          summary={data.summary}
          onClose={() => setClosing(false)}
          onDone={() => { setClosing(false); void reload(); }}
        />
      )}
    </>
  );
}

function OpenShift({
  storeId,
  terminalId,
  onClose,
  onDone,
}: {
  storeId: string;
  terminalId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [openingFloat, setOpeningFloat] = useState(0);
  const [note, setNote] = useState('');
  const { busy, run } = useMutation();

  return (
    <Modal title="Open shift" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        Count the cash already in the drawer. The closing variance is measured against this.
      </p>
      <Field label="Opening float">
        <MoneyInput value={openingFloat} onChange={setOpeningFloat} autoFocus placeholder="0.00" />
      </Field>
      <Field label="Note (optional)">
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="row">
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={busy}
          onClick={() =>
            void run(
              () => api.post('/shifts/open', { storeId, terminalId, openingFloat, note: note || null }),
              { success: 'Shift opened', onDone },
            )
          }
        >
          Open shift
        </button>
      </div>
    </Modal>
  );
}

function CloseShift({
  shift,
  summary,
  onClose,
  onDone,
}: {
  shift: Shift;
  summary: ShiftSummary;
  onClose: () => void;
  onDone: () => void;
}) {
  const [countedCash, setCountedCash] = useState(0);
  const [note, setNote] = useState('');
  const { busy, run } = useMutation();

  // Shown so the cashier can reconcile, but the server recomputes this from the
  // payments ledger and does not trust anything sent from here.
  const expected = shift.openingFloat + summary.cashNet;
  const variance = countedCash - expected;

  return (
    <Modal title="Close shift" onClose={onClose} wide>
      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="label">Sales</div>
          <div className="value" style={{ fontSize: 20 }}>{summary.saleCount}</div>
        </div>
        <div className="stat">
          <div className="label">Gross takings</div>
          <div className="value" style={{ fontSize: 20 }}>{formatCents(summary.grossSales)}</div>
        </div>
        <div className="stat">
          <div className="label">Expected cash</div>
          <div className="value" style={{ fontSize: 20 }}>{formatCents(expected)}</div>
        </div>
      </div>

      <table style={{ marginBottom: 16 }}>
        <thead>
          <tr><th>Tender</th><th className="num">Count</th><th className="num">Total</th></tr>
        </thead>
        <tbody>
          {summary.tenders.map((t) => (
            <tr key={t.method}>
              <td>{t.method}</td>
              <td className="num">{t.count}</td>
              <td className="num">{formatCents(t.total)}</td>
            </tr>
          ))}
          {summary.tenders.length === 0 && (
            <tr><td colSpan={3} className="muted">No payments taken this shift.</td></tr>
          )}
        </tbody>
      </table>

      <Field label="Counted cash in drawer">
        <MoneyInput value={countedCash} onChange={setCountedCash} autoFocus placeholder="0.00" />
      </Field>

      {countedCash > 0 && (
        <div
          className={`banner ${variance === 0 ? '' : Math.abs(variance) > 10_000 ? 'error' : 'warning'}`}
          style={variance === 0 ? { background: 'rgba(16,185,129,.14)', border: '1px solid var(--success)' } : undefined}
        >
          {variance === 0
            ? 'Drawer balances exactly.'
            : `${variance > 0 ? 'Over' : 'Short'} by ${formatCents(Math.abs(variance))}`}
        </div>
      )}

      <Field label="Note (required if there is a variance)">
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>

      <div className="row">
        <button
          className="btn ghost"
          onClick={() => void download(`/reports/z-report?shiftId=${shift.id}&format=pdf`, 'z-report.pdf')}
        >
          Z-report PDF
        </button>
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={busy || (variance !== 0 && note.trim().length < 3)}
          onClick={() =>
            void run(
              () => api.post(`/shifts/${shift.id}/close`, { countedCash, note: note || null }),
              { success: 'Shift closed', onDone },
            )
          }
        >
          Close shift
        </button>
      </div>
    </Modal>
  );
}
