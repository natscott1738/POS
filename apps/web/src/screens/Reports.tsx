import { useState } from 'react';
import { formatCents } from '@pos/shared';
import { download } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { useAuth } from '../lib/store.js';
import { Page, Field, Empty, Loading, Badge } from '../components/ui.js';
import { formatQuantity } from '../components/Money.js';

type Tab = 'OVERVIEW' | 'PROFIT' | 'PRODUCTS' | 'PAYMENTS' | 'TAX' | 'STAFF' | 'CUSTOMERS' | 'RETURNS' | 'PATTERN';

function startOfDay(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

/** Basis points to a readable percentage, e.g. 3250 -> "32.5%". */
function pct(basisPoints: number | null | undefined): string {
  if (basisPoints === null || basisPoints === undefined) return '—';
  return `${(basisPoints / 100).toFixed(1)}%`;
}

function Change({ basisPoints }: { basisPoints: number | null }) {
  if (basisPoints === null) return <span className="muted">—</span>;
  const up = basisPoints >= 0;
  return (
    <span style={{ color: up ? 'var(--success)' : 'var(--danger)', fontSize: 12, fontWeight: 600 }}>
      {up ? '▲' : '▼'} {pct(Math.abs(basisPoints))}
    </span>
  );
}

export default function Reports() {
  const can = useAuth((s) => s.can);
  const storeId = useAuth((s) => s.storeId);
  const [tab, setTab] = useState<Tab>('OVERVIEW');
  const [from, setFrom] = useState(startOfDay(7));
  const [to, setTo] = useState(startOfDay(0));

  const range = `from=${new Date(`${from}T00:00:00.000Z`).toISOString()}&to=${new Date(`${to}T23:59:59.999Z`).toISOString()}${storeId ? `&storeId=${storeId}` : ''}`;

  return (
    <Page title="Reports" subtitle="Figures for a period you choose">
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="From">
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <div className="row" style={{ paddingBottom: 14 }}>
            <button className="btn ghost" onClick={() => { setFrom(startOfDay(0)); setTo(startOfDay(0)); }}>Today</button>
            <button className="btn ghost" onClick={() => { setFrom(startOfDay(7)); setTo(startOfDay(0)); }}>7 days</button>
            <button className="btn ghost" onClick={() => { setFrom(startOfDay(30)); setTo(startOfDay(0)); }}>30 days</button>
          </div>
        </div>
      </div>

      <div className="report-tabs">
        {([
          ['OVERVIEW', 'Overview'],
          ['PROFIT', 'Profit'],
          ['PRODUCTS', 'Products'],
          ['PAYMENTS', 'Payments'],
          ['TAX', 'VAT'],
          ['STAFF', 'Staff'],
          ['CUSTOMERS', 'Customers'],
          ['RETURNS', 'Returns'],
          ['PATTERN', 'Busy times'],
        ] as Array<[Tab, string]>).map(([value, label]) => (
          <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'OVERVIEW' && <Overview range={range} canExport={can('report:export')} from={from} to={to} />}
      {tab === 'PROFIT' && <Profit range={range} canExport={can('report:export')} />}
      {tab === 'PRODUCTS' && <ProductsReport range={range} canExport={can('report:export')} />}
      {tab === 'PAYMENTS' && <Payments range={range} canExport={can('report:export')} />}
      {tab === 'TAX' && <Tax range={range} canExport={can('report:export')} />}
      {tab === 'STAFF' && <Staff range={range} canExport={can('report:export')} />}
      {tab === 'CUSTOMERS' && <CustomersReport range={range} />}
      {tab === 'RETURNS' && <Returns range={range} />}
      {tab === 'PATTERN' && <Pattern range={range} />}
    </Page>
  );
}

/* --------------------------------- Overview -------------------------------- */

function Overview({ range, canExport, from, to }: { range: string; canExport: boolean; from: string; to: string }) {
  const comparison = useApi<{
    current: { sales: number; revenue: number; grossProfit: number; averageBasket: number };
    previous: { sales: number; revenue: number; grossProfit: number; averageBasket: number };
    previousPeriod: { from: string; to: string };
    changeBasisPoints: { revenue: number | null; sales: number | null; grossProfit: number | null; averageBasket: number | null };
  }>(`/reports/comparison?${range}`, [range]);

  const summary = useApi<{ periods: Array<Record<string, number | string>>; totals: Record<string, number> }>(
    `/reports/sales-summary?${range}&granularity=day`,
    [range],
  );

  if (comparison.loading) return <Loading />;
  const c = comparison.data;

  return (
    <>
      {c && (
        <div className="stat-grid" style={{ marginBottom: 16 }}>
          <div className="stat">
            <div className="label">Takings</div>
            <div className="value">{formatCents(c.current.revenue)}</div>
            <div style={{ marginTop: 4 }}>
              <Change basisPoints={c.changeBasisPoints.revenue} />
              <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>vs previous period</span>
            </div>
          </div>
          <div className="stat">
            <div className="label">Gross profit</div>
            <div className="value">{formatCents(c.current.grossProfit)}</div>
            <div style={{ marginTop: 4 }}><Change basisPoints={c.changeBasisPoints.grossProfit} /></div>
          </div>
          <div className="stat">
            <div className="label">Sales</div>
            <div className="value">{c.current.sales}</div>
            <div style={{ marginTop: 4 }}><Change basisPoints={c.changeBasisPoints.sales} /></div>
          </div>
          <div className="stat">
            <div className="label">Average basket</div>
            <div className="value">{formatCents(c.current.averageBasket)}</div>
            <div style={{ marginTop: 4 }}><Change basisPoints={c.changeBasisPoints.averageBasket} /></div>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ padding: '12px 14px' }}>
          <strong style={{ fontSize: 15 }}>Day by day</strong>
          <div className="spacer" />
          {canExport && (
            <>
              <button className="btn ghost" onClick={() => void download(`/reports/sales-summary?${range}&granularity=day&format=csv`, `sales-${from}-to-${to}.csv`)}>CSV</button>
              <button className="btn ghost" onClick={() => void download(`/reports/sales-summary?${range}&granularity=day&format=pdf`, `sales-${from}-to-${to}.pdf`)}>PDF</button>
            </>
          )}
        </div>
        <table>
          <thead>
            <tr><th>Day</th><th className="num">Sales</th><th className="num">Gross</th><th className="num">Discounts</th><th className="num">VAT</th><th className="num">Refunds</th></tr>
          </thead>
          <tbody>
            {summary.data?.periods.map((row) => (
              <tr key={String(row.period)}>
                <td>{new Date(String(row.period)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                <td className="num">{row.saleCount}</td>
                <td className="num">{formatCents(Number(row.grossSales))}</td>
                <td className="num muted">{formatCents(Number(row.discountTotal))}</td>
                <td className="num muted">{formatCents(Number(row.taxTotal))}</td>
                <td className="num muted">{formatCents(Number(row.refundTotal))}</td>
              </tr>
            ))}
            {(!summary.data || summary.data.periods.length === 0) && (
              <tr><td colSpan={6}><Empty message="No sales in this period." /></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------------------------------- Profit --------------------------------- */

function Profit({ range, canExport }: { range: string; canExport: boolean }) {
  const { data, loading } = useApi<{
    totals: { revenue: number; cost: number; grossProfit: number; marginBasisPoints: number; tax: number; discountGiven: number; unitsSold: number };
    byCategory: Array<{ categoryName: string; revenue: number; cost: number; grossProfit: number; marginBasisPoints: number; unitsSold: number; shareBasisPoints: number }>;
  }>(`/reports/profit?${range}`, [range]);

  if (loading) return <Loading />;
  if (!data) return <Empty message="No data." />;

  return (
    <>
      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="label">Revenue (excl. VAT)</div>
          <div className="value">{formatCents(data.totals.revenue)}</div>
        </div>
        <div className="stat">
          <div className="label">Cost of goods</div>
          <div className="value">{formatCents(data.totals.cost)}</div>
        </div>
        <div className="stat">
          <div className="label">Gross profit</div>
          <div className="value" style={{ color: 'var(--success)' }}>{formatCents(data.totals.grossProfit)}</div>
        </div>
        <div className="stat">
          <div className="label">Margin</div>
          <div className="value">{pct(data.totals.marginBasisPoints)}</div>
        </div>
      </div>

      <div className="banner warning" style={{ fontSize: 13 }}>
        Cost comes from what each item cost when it was sold, not today&rsquo;s cost — so a
        supplier price rise this month does not change last month&rsquo;s margin.
        Products entered with no cost price will show 100% margin.
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ padding: '12px 14px' }}>
          <strong style={{ fontSize: 15 }}>By category</strong>
          <div className="spacer" />
          {canExport && (
            <button className="btn ghost" onClick={() => void download(`/reports/profit?${range}&format=csv`, 'profit-by-category.csv')}>CSV</button>
          )}
        </div>
        <table>
          <thead>
            <tr><th>Category</th><th className="num">Units</th><th className="num">Revenue</th><th className="num">Cost</th><th className="num">Profit</th><th className="num">Margin</th><th className="num">Share</th></tr>
          </thead>
          <tbody>
            {data.byCategory.map((row) => (
              <tr key={row.categoryName}>
                <td>{row.categoryName}</td>
                <td className="num muted">{formatQuantity(row.unitsSold)}</td>
                <td className="num">{formatCents(row.revenue)}</td>
                <td className="num muted">{formatCents(row.cost)}</td>
                <td className="num" style={{ color: 'var(--success)' }}>{formatCents(row.grossProfit)}</td>
                <td className="num">{pct(row.marginBasisPoints)}</td>
                <td className="num muted">{pct(row.shareBasisPoints)}</td>
              </tr>
            ))}
            {data.byCategory.length === 0 && <tr><td colSpan={7}><Empty message="No sales in this period." /></td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* --------------------------------- Products -------------------------------- */

function ProductsReport({ range, canExport }: { range: string; canExport: boolean }) {
  const [sort, setSort] = useState<'revenue' | 'profit' | 'units' | 'margin'>('revenue');
  const { data, loading } = useApi<{
    products: Array<{
      variantId: string; sku: string; productName: string; variantLabel: string | null;
      unitsSold: number; revenue: number; cost: number; grossProfit: number;
      marginBasisPoints: number; discountGiven: number; transactions: number; refundedUnits: number;
    }>;
  }>(`/reports/products?${range}&limit=200`, [range]);

  if (loading) return <Loading />;

  const rows = [...(data?.products ?? [])].sort((a, b) => {
    if (sort === 'profit') return b.grossProfit - a.grossProfit;
    if (sort === 'units') return b.unitsSold - a.unitsSold;
    if (sort === 'margin') return b.marginBasisPoints - a.marginBasisPoints;
    return b.revenue - a.revenue;
  });

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="row" style={{ padding: '12px 14px', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 15 }}>Product performance</strong>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>sort by</span>
        <select className="input" style={{ maxWidth: 150, minHeight: 34 }} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="revenue">Revenue</option>
          <option value="profit">Profit</option>
          <option value="units">Units sold</option>
          <option value="margin">Margin %</option>
        </select>
        {canExport && (
          <button className="btn ghost" onClick={() => void download(`/reports/products?${range}&limit=500&format=csv`, 'product-performance.csv')}>CSV</button>
        )}
      </div>
      <table>
        <thead>
          <tr><th>SKU</th><th>Product</th><th className="num">Units</th><th className="num">Revenue</th><th className="num">Profit</th><th className="num">Margin</th><th className="num">Discounted</th><th className="num">Returned</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.variantId}>
              <td className="mono">{row.sku}</td>
              <td>
                {row.productName}
                {row.variantLabel && <div className="muted" style={{ fontSize: 11 }}>{row.variantLabel}</div>}
              </td>
              <td className="num">{formatQuantity(row.unitsSold)}</td>
              <td className="num">{formatCents(row.revenue)}</td>
              <td className="num" style={{ color: row.grossProfit >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                {formatCents(row.grossProfit)}
              </td>
              <td className="num">{pct(row.marginBasisPoints)}</td>
              <td className="num muted">{row.discountGiven > 0 ? formatCents(row.discountGiven) : '—'}</td>
              <td className="num muted">{row.refundedUnits > 0 ? formatQuantity(row.refundedUnits) : '—'}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={8}><Empty message="Nothing sold in this period." /></td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------- Payments -------------------------------- */

function Payments({ range, canExport }: { range: string; canExport: boolean }) {
  const { data, loading } = useApi<{
    methods: Array<{ method: string; transactionCount: number; collected: number; refunded: number; net: number; shareBasisPoints: number }>;
    totals: { collected: number; refunded: number; net: number };
  }>(`/reports/payments?${range}`, [range]);

  if (loading) return <Loading />;
  if (!data) return <Empty message="No data." />;

  return (
    <>
      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <div className="stat"><div className="label">Collected</div><div className="value">{formatCents(data.totals.collected)}</div></div>
        <div className="stat"><div className="label">Refunded</div><div className="value">{formatCents(data.totals.refunded)}</div></div>
        <div className="stat"><div className="label">Net takings</div><div className="value">{formatCents(data.totals.net)}</div></div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ padding: '12px 14px' }}>
          <strong style={{ fontSize: 15 }}>By payment method</strong>
          <span className="muted" style={{ fontSize: 12 }}>what should be in the drawer, the M-PESA statement, and the card settlement</span>
          <div className="spacer" />
          {canExport && (
            <>
              <button className="btn ghost" onClick={() => void download(`/reports/payments?${range}&format=csv`, 'payments.csv')}>CSV</button>
              <button className="btn ghost" onClick={() => void download(`/reports/payments?${range}&format=pdf`, 'payments.pdf')}>PDF</button>
            </>
          )}
        </div>
        <table>
          <thead><tr><th>Method</th><th className="num">Count</th><th className="num">Collected</th><th className="num">Refunded</th><th className="num">Net</th><th className="num">Share</th></tr></thead>
          <tbody>
            {data.methods.map((row) => (
              <tr key={row.method}>
                <td><strong>{row.method}</strong></td>
                <td className="num">{row.transactionCount}</td>
                <td className="num">{formatCents(row.collected)}</td>
                <td className="num muted">{row.refunded > 0 ? formatCents(row.refunded) : '—'}</td>
                <td className="num">{formatCents(row.net)}</td>
                <td className="num muted">{pct(row.shareBasisPoints)}</td>
              </tr>
            ))}
            {data.methods.length === 0 && <tr><td colSpan={6}><Empty message="No payments in this period." /></td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ----------------------------------- VAT ----------------------------------- */

function Tax({ range, canExport }: { range: string; canExport: boolean }) {
  const { data, loading } = useApi<{
    bands: Array<{ taxCode: string; rateBasisPoints: number; net: number; tax: number; gross: number; lineCount: number }>;
    refunds: { net: number; tax: number };
    totals: { net: number; tax: number };
  }>(`/reports/tax?${range}`, [range]);

  if (loading) return <Loading />;
  if (!data) return <Empty message="No data." />;

  return (
    <>
      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <div className="stat"><div className="label">Net of VAT</div><div className="value">{formatCents(data.totals.net)}</div></div>
        <div className="stat"><div className="label">VAT due</div><div className="value">{formatCents(data.totals.tax)}</div></div>
      </div>

      <div className="banner warning" style={{ fontSize: 13 }}>
        These are figures for your return, not a fiscal record. KRA requires VAT-registered
        businesses to file through eTIMS, which is not yet connected.
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ padding: '12px 14px' }}>
          <strong style={{ fontSize: 15 }}>Output tax by band</strong>
          <div className="spacer" />
          {canExport && (
            <>
              <button className="btn ghost" onClick={() => void download(`/reports/tax?${range}&format=csv`, 'vat.csv')}>CSV</button>
              <button className="btn ghost" onClick={() => void download(`/reports/tax?${range}&format=pdf`, 'vat.pdf')}>PDF</button>
            </>
          )}
        </div>
        <table>
          <thead><tr><th>Treatment</th><th className="num">Rate</th><th className="num">Lines</th><th className="num">Net</th><th className="num">VAT</th><th className="num">Gross</th></tr></thead>
          <tbody>
            {data.bands.map((band) => (
              <tr key={`${band.taxCode}-${band.rateBasisPoints}`}>
                <td>{band.taxCode.replace(/_/g, ' ').toLowerCase()}</td>
                <td className="num">{pct(band.rateBasisPoints)}</td>
                <td className="num muted">{band.lineCount}</td>
                <td className="num">{formatCents(band.net)}</td>
                <td className="num">{formatCents(band.tax)}</td>
                <td className="num muted">{formatCents(band.gross)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={3}><em>Less refunds</em></td>
              <td className="num muted">−{formatCents(data.refunds.net)}</td>
              <td className="num muted">−{formatCents(data.refunds.tax)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------------------------------- Staff ---------------------------------- */

function Staff({ range, canExport }: { range: string; canExport: boolean }) {
  const { data, loading } = useApi<{
    cashiers: Array<{
      cashierId: string; cashierName: string; saleCount: number; grossSales: number;
      discountGiven: number; discountRateBasisPoints: number; discountedSales: number;
      voidCount: number; voidValue: number; refundValue: number; overrides: number; averageBasket: number;
    }>;
  }>(`/reports/exceptions?${range}`, [range]);

  if (loading) return <Loading />;

  const rows = data?.cashiers ?? [];
  // Flag anyone discounting at more than twice the shop's own average.
  const averageDiscountRate = rows.length > 0
    ? rows.reduce((a, r) => a + r.discountRateBasisPoints, 0) / rows.length
    : 0;

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="row" style={{ padding: '12px 14px' }}>
        <strong style={{ fontSize: 15 }}>Staff activity</strong>
        <span className="muted" style={{ fontSize: 12 }}>discounts, voids and refunds per person</span>
        <div className="spacer" />
        {canExport && (
          <button className="btn ghost" onClick={() => void download(`/reports/exceptions?${range}&format=csv`, 'staff-activity.csv')}>CSV</button>
        )}
      </div>
      <table>
        <thead>
          <tr><th>Cashier</th><th className="num">Sales</th><th className="num">Takings</th><th className="num">Avg basket</th><th className="num">Discounts</th><th className="num">Rate</th><th className="num">Voids</th><th className="num">Refunds</th><th className="num">Overrides</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const highDiscount = averageDiscountRate > 0 && row.discountRateBasisPoints > averageDiscountRate * 2;
            return (
              <tr key={row.cashierId}>
                <td>
                  {row.cashierName}
                  {highDiscount && <span style={{ marginLeft: 6 }}><Badge tone="warning">high</Badge></span>}
                </td>
                <td className="num">{row.saleCount}</td>
                <td className="num">{formatCents(row.grossSales)}</td>
                <td className="num muted">{formatCents(row.averageBasket)}</td>
                <td className="num">{row.discountGiven > 0 ? formatCents(row.discountGiven) : '—'}</td>
                <td className="num" style={highDiscount ? { color: 'var(--warning)' } : undefined}>{pct(row.discountRateBasisPoints)}</td>
                <td className="num">{row.voidCount > 0 ? `${row.voidCount} · ${formatCents(row.voidValue)}` : '—'}</td>
                <td className="num muted">{row.refundValue > 0 ? formatCents(row.refundValue) : '—'}</td>
                <td className="num muted">{row.overrides > 0 ? row.overrides : '—'}</td>
              </tr>
            );
          })}
          {rows.length === 0 && <tr><td colSpan={9}><Empty message="No activity in this period." /></td></tr>}
        </tbody>
      </table>
      {rows.length > 1 && (
        <p className="muted" style={{ padding: '10px 14px', fontSize: 12, margin: 0 }}>
          A single void or discount means nothing. A cashier consistently well above the
          others is the pattern worth asking about.
        </p>
      )}
    </div>
  );
}

/* -------------------------------- Customers -------------------------------- */

function CustomersReport({ range }: { range: string }) {
  const { data, loading } = useApi<{
    topCustomers: Array<{ customerId: string; fullName: string; phone: string | null; visits: number; spend: number; averageBasket: number; lastVisit: string; loyaltyPoints: number }>;
    identified: { sales: number; revenue: number };
    anonymous: { sales: number; revenue: number };
  }>(`/reports/customers?${range}`, [range]);

  if (loading) return <Loading />;
  if (!data) return <Empty message="No data." />;

  const totalSales = data.identified.sales + data.anonymous.sales;
  const identifiedShare = totalSales > 0 ? Math.round((data.identified.sales / totalSales) * 10_000) : 0;

  return (
    <>
      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="label">Sales with a customer</div>
          <div className="value">{pct(identifiedShare)}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {data.identified.sales} of {totalSales}
          </div>
        </div>
        <div className="stat">
          <div className="label">Known-customer takings</div>
          <div className="value">{formatCents(data.identified.revenue)}</div>
        </div>
        <div className="stat">
          <div className="label">Walk-in takings</div>
          <div className="value">{formatCents(data.anonymous.revenue)}</div>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ padding: '12px 14px' }}>
          <strong style={{ fontSize: 15 }}>Best customers</strong>
          <span className="muted" style={{ fontSize: 12 }}>by spend in this period</span>
        </div>
        <table>
          <thead><tr><th>Customer</th><th>Phone</th><th className="num">Visits</th><th className="num">Spend</th><th className="num">Avg basket</th><th className="num">Points</th><th>Last seen</th></tr></thead>
          <tbody>
            {data.topCustomers.map((row) => (
              <tr key={row.customerId}>
                <td>{row.fullName}</td>
                <td className="mono muted">{row.phone ?? '—'}</td>
                <td className="num">{row.visits}</td>
                <td className="num">{formatCents(row.spend)}</td>
                <td className="num muted">{formatCents(row.averageBasket)}</td>
                <td className="num muted">{row.loyaltyPoints}</td>
                <td className="muted" style={{ fontSize: 13 }}>{new Date(row.lastVisit).toLocaleDateString('en-GB')}</td>
              </tr>
            ))}
            {data.topCustomers.length === 0 && (
              <tr><td colSpan={7}><Empty message="No sales were linked to a customer in this period." /></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* --------------------------------- Returns --------------------------------- */

function Returns({ range }: { range: string }) {
  const { data, loading } = useApi<{
    byReason: Array<{ reason: string; count: number; value: number; units: number }>;
    worstProducts: Array<{ sku: string; productName: string; refundedUnits: number; refundedValue: number }>;
  }>(`/reports/refund-analysis?${range}`, [range]);

  if (loading) return <Loading />;
  if (!data) return <Empty message="No data." />;

  return (
    <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ padding: '12px 14px' }}><strong style={{ fontSize: 15 }}>Why things come back</strong></div>
        <table>
          <thead><tr><th>Reason</th><th className="num">Times</th><th className="num">Units</th><th className="num">Value</th></tr></thead>
          <tbody>
            {data.byReason.map((row) => (
              <tr key={row.reason}>
                <td>{row.reason.replace(/_/g, ' ').toLowerCase()}</td>
                <td className="num">{row.count}</td>
                <td className="num muted">{formatQuantity(row.units)}</td>
                <td className="num">{formatCents(row.value)}</td>
              </tr>
            ))}
            {data.byReason.length === 0 && <tr><td colSpan={4}><Empty message="Nothing was returned." /></td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ padding: '12px 14px' }}>
          <strong style={{ fontSize: 15 }}>Most returned</strong>
          <span className="muted" style={{ fontSize: 12 }}>a supplier or quality problem</span>
        </div>
        <table>
          <thead><tr><th>SKU</th><th>Product</th><th className="num">Units</th><th className="num">Value</th></tr></thead>
          <tbody>
            {data.worstProducts.map((row) => (
              <tr key={row.sku}>
                <td className="mono">{row.sku}</td>
                <td>{row.productName}</td>
                <td className="num">{formatQuantity(row.refundedUnits)}</td>
                <td className="num">{formatCents(row.refundedValue)}</td>
              </tr>
            ))}
            {data.worstProducts.length === 0 && <tr><td colSpan={4}><Empty message="Nothing was returned." /></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------- Busy times -------------------------------- */

function Pattern({ range }: { range: string }) {
  const { data, loading } = useApi<{
    byHour: Array<{ hour: number; sales: number; revenue: number }>;
    byWeekday: Array<{ weekday: number; name: string; sales: number; revenue: number }>;
  }>(`/reports/trading-pattern?${range}`, [range]);

  if (loading) return <Loading />;
  if (!data) return <Empty message="No data." />;

  const peakHour = Math.max(1, ...data.byHour.map((h) => h.revenue));
  const peakDay = Math.max(1, ...data.byWeekday.map((d) => d.revenue));

  return (
    <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
      <div className="card">
        <strong style={{ fontSize: 15 }}>By hour</strong>
        <p className="muted" style={{ fontSize: 12, marginTop: 2 }}>When to put extra staff on the counter.</p>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 160, marginTop: 14 }}>
          {data.byHour.map((h) => (
            <div key={h.hour} style={{ flex: 1, textAlign: 'center' }} title={`${h.hour}:00 — ${formatCents(h.revenue)} from ${h.sales} sales`}>
              <div style={{ height: `${Math.max(3, (h.revenue / peakHour) * 130)}px`, background: 'var(--accent)', borderRadius: '4px 4px 0 0' }} />
              <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>{h.hour}</div>
            </div>
          ))}
          {data.byHour.length === 0 && <Empty message="No sales in this period." />}
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="row" style={{ padding: '12px 14px' }}><strong style={{ fontSize: 15 }}>By day of week</strong></div>
        <table>
          <thead><tr><th>Day</th><th className="num">Sales</th><th className="num">Takings</th><th /></tr></thead>
          <tbody>
            {data.byWeekday.map((d) => (
              <tr key={d.weekday}>
                <td>{d.name}</td>
                <td className="num">{d.sales}</td>
                <td className="num">{formatCents(d.revenue)}</td>
                <td style={{ width: '35%' }}>
                  <div style={{ height: 8, borderRadius: 4, background: 'var(--accent)', width: `${(d.revenue / peakDay) * 100}%`, minWidth: 2 }} />
                </td>
              </tr>
            ))}
            {data.byWeekday.length === 0 && <tr><td colSpan={4}><Empty message="No sales." /></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
