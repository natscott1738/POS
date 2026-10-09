import { formatCents } from '@pos/shared';
import { useApi } from '../lib/useApi.js';
import { useAuth } from '../lib/store.js';
import { Page, Loading, Badge, Empty } from '../components/ui.js';
import { formatQuantity } from '../components/Money.js';

interface DashboardData {
  today: {
    saleCount: number; gross: number; tax: number; discounts: number;
    refunds: number; voids: number; averageBasket: number;
  };
  comparison: { yesterdayGross: number; changeBasisPoints: number | null };
  tenders: Array<{ method: string; total: number }>;
  topSellers: Array<{ sku: string; productName: string; quantity: number; revenue: number }>;
  hourly: Array<{ hour: string; gross: number; count: number }>;
  attention: {
    stockAlerts: number;
    openShifts: Array<{ id: string; cashierName: string | null; openedAt: string; openingFloat: number }>;
    oversoldLast7Days: number;
    repricedLast7Days: number;
    offlineLast7Days: number;
    quickbooksPending: number;
    quickbooksDead: number;
  };
}

export default function Dashboard() {
  const storeId = useAuth((s) => s.storeId);
  const { data, loading, reload } = useApi<DashboardData>(
    storeId ? `/reports/dashboard?storeId=${storeId}` : '/reports/dashboard',
    [storeId],
  );

  if (loading) return <Page title="Today"><Loading /></Page>;
  if (!data) return <Page title="Today"><Empty message="No data yet." /></Page>;

  const change = data.comparison.changeBasisPoints;
  const peak = Math.max(1, ...data.hourly.map((h) => h.gross));

  return (
    <Page
      title="Today"
      subtitle={new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
      actions={<button className="btn ghost" onClick={() => void reload()}>Refresh</button>}
    >
      <div className="stat-grid" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="label">Takings</div>
          <div className="value">{formatCents(data.today.gross)}</div>
          {change !== null && (
            <div className="muted" style={{ fontSize: 12, marginTop: 4, color: change >= 0 ? 'var(--success)' : 'var(--danger)' }}>
              {change >= 0 ? '▲' : '▼'} {Math.abs(change / 100).toFixed(1)}% vs yesterday
            </div>
          )}
        </div>
        <div className="stat">
          <div className="label">Sales</div>
          <div className="value">{data.today.saleCount}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            avg {formatCents(data.today.averageBasket)}
          </div>
        </div>
        <div className="stat">
          <div className="label">VAT collected</div>
          <div className="value">{formatCents(data.today.tax)}</div>
        </div>
        <div className="stat">
          <div className="label">Refunds &amp; voids</div>
          <div className="value">{formatCents(data.today.refunds)}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{data.today.voids} void(s)</div>
        </div>
      </div>

      <NeedsAttention attention={data.attention} />

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: 16 }}>
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Through the day</h2>
          {data.hourly.length === 0 ? (
            <p className="muted">No sales yet today.</p>
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 140, marginTop: 12 }}>
              {data.hourly.map((h) => (
                <div key={h.hour} style={{ flex: 1, textAlign: 'center' }} title={`${h.hour} · ${formatCents(h.gross)}`}>
                  <div
                    style={{
                      // Proportional to the busiest hour, so the shape is readable
                      // regardless of whether the shop takes thousands or millions.
                      height: `${Math.max(3, (h.gross / peak) * 110)}px`,
                      background: 'var(--accent)',
                      borderRadius: '4px 4px 0 0',
                    }}
                  />
                  <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>{h.hour.slice(0, 2)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Payment mix</h2>
          {data.tenders.length === 0 ? (
            <p className="muted">Nothing taken yet today.</p>
          ) : (
            <table>
              <tbody>
                {data.tenders.map((t) => (
                  <tr key={t.method}>
                    <td>{t.method}</td>
                    <td className="num">{formatCents(t.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2 style={{ fontSize: 16, marginTop: 18 }}>Selling best today</h2>
          {data.topSellers.length === 0 ? (
            <p className="muted">Nothing sold yet.</p>
          ) : (
            <table>
              <tbody>
                {data.topSellers.map((t) => (
                  <tr key={t.sku}>
                    <td>{t.productName}</td>
                    <td className="num muted">{formatQuantity(t.quantity)}</td>
                    <td className="num">{formatCents(t.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Page>
  );
}

/** Only rendered when something genuinely needs a person to look at it. */
function NeedsAttention({ attention }: { attention: DashboardData['attention'] }) {
  const items: Array<{ tone: 'warning' | 'danger'; text: string }> = [];

  if (attention.stockAlerts > 0) {
    items.push({ tone: 'warning', text: `${attention.stockAlerts} product(s) at or below reorder point` });
  }
  if (attention.oversoldLast7Days > 0) {
    items.push({ tone: 'danger', text: `${attention.oversoldLast7Days} sale(s) took stock negative in the last 7 days` });
  }
  if (attention.repricedLast7Days > 0) {
    items.push({ tone: 'warning', text: `${attention.repricedLast7Days} offline sale(s) were re-priced on sync` });
  }
  if (attention.quickbooksDead > 0) {
    items.push({ tone: 'danger', text: `${attention.quickbooksDead} accounting entries failed permanently` });
  }
  if (attention.openShifts.length > 0) {
    items.push({
      tone: 'warning',
      text: `${attention.openShifts.length} shift(s) still open: ${attention.openShifts.map((s) => s.cashierName ?? 'unknown').join(', ')}`,
    });
  }

  if (items.length === 0) {
    return (
      <div className="card">
        <div className="row">
          <Badge tone="success">All clear</Badge>
          <span className="muted">Nothing needs attention right now.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0, fontSize: 16 }}>Needs attention</h2>
      {items.map((item, i) => (
        <div key={i} className="row" style={{ padding: '5px 0' }}>
          <Badge tone={item.tone}>{item.tone === 'danger' ? 'action' : 'check'}</Badge>
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  );
}
