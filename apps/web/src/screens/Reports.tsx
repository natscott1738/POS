import { useEffect, useState } from 'react';
import { formatCents } from '@pos/shared';
import { api, download } from '../lib/api.js';
import { useAuth, toast } from '../lib/store.js';
import { Field } from '../components/ui.js';

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

export default function Reports() {
  const can = useAuth((s) => s.can);
  const [from, setFrom] = useState(isoDaysAgo(7).slice(0, 10));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [summary, setSummary] = useState<{
    periods: Array<Record<string, number | string>>;
    totals: Record<string, number>;
  } | null>(null);
  const [payments, setPayments] = useState<{
    methods: Array<{ method: string; transactionCount: number; collected: number; refunded: number; net: number; shareBasisPoints: number }>;
    totals: Record<string, number>;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const range = `from=${new Date(`${from}T00:00:00.000Z`).toISOString()}&to=${new Date(`${to}T23:59:59.999Z`).toISOString()}`;

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [s, p] = await Promise.all([
        api.get<typeof summary>(`/reports/sales-summary?${range}&granularity=day`),
        api.get<typeof payments>(`/reports/payments?${range}`),
      ]);
      setSummary(s);
      setPayments(p);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load reports');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Reports</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Field label="From">
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <button className="btn primary" style={{ alignSelf: 'flex-end' }} onClick={() => void load()} disabled={loading}>
            {loading ? 'Loading…' : 'Run'}
          </button>
          <div className="spacer" />
          {can('report:export') && (
            <>
              <button
                className="btn"
                style={{ alignSelf: 'flex-end' }}
                onClick={() => void download(`/reports/sales-summary?${range}&granularity=day&format=csv`, 'sales-summary.csv')}
              >
                CSV
              </button>
              <button
                className="btn"
                style={{ alignSelf: 'flex-end' }}
                onClick={() => void download(`/reports/sales-summary?${range}&granularity=day&format=pdf`, 'sales-summary.pdf')}
              >
                PDF
              </button>
            </>
          )}
        </div>
      </div>

      {summary && (
        <div className="stat-grid" style={{ marginBottom: 16 }}>
          <div className="stat">
            <div className="label">Gross sales</div>
            <div className="value">{formatCents(summary.totals.grossSales ?? 0)}</div>
          </div>
          <div className="stat">
            <div className="label">Transactions</div>
            <div className="value">{summary.totals.saleCount ?? 0}</div>
          </div>
          <div className="stat">
            <div className="label">VAT</div>
            <div className="value">{formatCents(summary.totals.taxTotal ?? 0)}</div>
          </div>
          <div className="stat">
            <div className="label">Refunds</div>
            <div className="value">{formatCents(summary.totals.refundTotal ?? 0)}</div>
          </div>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Daily takings</h2>
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th className="num">Sales</th>
                <th className="num">Gross</th>
                <th className="num">VAT</th>
              </tr>
            </thead>
            <tbody>
              {summary?.periods.map((row) => (
                <tr key={String(row.period)}>
                  <td>{String(row.period).slice(0, 10)}</td>
                  <td className="num">{row.saleCount}</td>
                  <td className="num">{formatCents(Number(row.grossSales))}</td>
                  <td className="num">{formatCents(Number(row.taxTotal))}</td>
                </tr>
              ))}
              {(!summary || summary.periods.length === 0) && (
                <tr><td colSpan={4} className="muted">No sales in this period.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Payment methods</h2>
          <table>
            <thead>
              <tr>
                <th>Method</th>
                <th className="num">Count</th>
                <th className="num">Net</th>
                <th className="num">Share</th>
              </tr>
            </thead>
            <tbody>
              {payments?.methods.map((row) => (
                <tr key={row.method}>
                  <td>{row.method}</td>
                  <td className="num">{row.transactionCount}</td>
                  <td className="num">{formatCents(row.net)}</td>
                  <td className="num">{(row.shareBasisPoints / 100).toFixed(1)}%</td>
                </tr>
              ))}
              {(!payments || payments.methods.length === 0) && (
                <tr><td colSpan={4} className="muted">No payments in this period.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
