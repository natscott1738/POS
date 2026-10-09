import { useState } from 'react';
import { formatCents } from '@pos/shared';
import { api } from '../lib/api.js';
import { useApi, useMutation } from '../lib/useApi.js';
import { useAuth } from '../lib/store.js';
import { Modal } from '../components/Modal.js';
import { Page, Field, FormGrid, Empty, Loading, Badge } from '../components/ui.js';

interface Customer {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  loyaltyPoints: number;
  totalSpent: number;
  visitCount: number;
  lastVisitAt: string | null;
  balance: number;
  creditLimit: number;
  isActive: boolean;
}

export default function Customers() {
  const can = useAuth((s) => s.can);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const { data, loading, reload } = useApi<{ customers: Customer[] }>(
    `/customers?limit=100${query ? `&q=${encodeURIComponent(query)}` : ''}`,
    [query],
  );
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  return (
    <Page
      title="Customers"
      subtitle="Profiles, loyalty and account balances"
      actions={can('customer:write') && <button className="btn primary" onClick={() => setEditing('new')}>Add customer</button>}
    >
      <div className="row" style={{ marginBottom: 12 }}>
        <input
          className="input"
          style={{ maxWidth: 340 }}
          placeholder="Search by name, phone or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && setQuery(search)}
        />
        <button className="btn" onClick={() => setQuery(search)}>Search</button>
        {query && <button className="btn ghost" onClick={() => { setSearch(''); setQuery(''); }}>Clear</button>}
      </div>

      <div className="card" style={{ padding: 0 }}>
        {loading ? <Loading /> : (data?.customers.length ?? 0) === 0 ? (
          <Empty message={query ? 'No customers match that search.' : 'No customers yet.'} />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Phone</th><th className="num">Points</th>
                <th className="num">Total spent</th><th className="num">Visits</th><th>Last visit</th><th />
              </tr>
            </thead>
            <tbody>
              {data?.customers.map((customer) => (
                <tr key={customer.id} style={{ cursor: 'pointer' }} onClick={() => setViewing(customer.id)}>
                  <td>
                    {customer.fullName}
                    {!customer.isActive && <span style={{ marginLeft: 6 }}><Badge tone="danger">inactive</Badge></span>}
                  </td>
                  <td className="mono muted">{customer.phone ?? '—'}</td>
                  <td className="num">{customer.loyaltyPoints}</td>
                  <td className="num">{formatCents(customer.totalSpent)}</td>
                  <td className="num muted">{customer.visitCount}</td>
                  <td className="muted" style={{ fontSize: 13 }}>
                    {customer.lastVisitAt ? new Date(customer.lastVisitAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="right">
                    {can('customer:write') && (
                      <button
                        className="btn ghost"
                        style={{ minHeight: 28, padding: '2px 8px', fontSize: 12 }}
                        onClick={(e) => { e.stopPropagation(); setEditing(customer); }}
                      >
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <CustomerForm
          customer={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); void reload(); }}
        />
      )}
      {viewing && <CustomerDetail customerId={viewing} onClose={() => setViewing(null)} />}
    </Page>
  );
}

function CustomerForm({ customer, onClose, onDone }: { customer: Customer | null; onClose: () => void; onDone: () => void }) {
  const [fullName, setFullName] = useState(customer?.fullName ?? '');
  const [phone, setPhone] = useState(customer?.phone ?? '');
  const [email, setEmail] = useState(customer?.email ?? '');
  const [taxPin, setTaxPin] = useState('');
  const [marketingConsent, setConsent] = useState(false);
  const { busy, run } = useMutation();

  const editing = customer !== null;

  return (
    <Modal title={editing ? `Edit ${customer.fullName}` : 'Add customer'} onClose={onClose}>
      <FormGrid>
        <Field label="Full name" wide>
          <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus />
        </Field>
        <Field label="Phone" hint="Kenyan mobile; used for M-PESA and receipts">
          <input className="input mono" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07XX XXX XXX" />
        </Field>
        <Field label="Email">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        {!editing && (
          <Field label="KRA PIN" hint="Needed on VAT invoices for business customers">
            <input className="input mono" value={taxPin} onChange={(e) => setTaxPin(e.target.value.toUpperCase())} />
          </Field>
        )}
      </FormGrid>

      <label className="row" style={{ fontSize: 14 }}>
        <input type="checkbox" checked={marketingConsent} onChange={(e) => setConsent(e.target.checked)} />
        Customer agreed to marketing contact
      </label>
      <p className="muted" style={{ fontSize: 12 }}>
        Consent is recorded with a timestamp. Contacting customers without it is a
        data-protection breach, so only tick this if they actually said yes.
      </p>

      <div className="row">
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={busy || fullName.trim().length < 2}
          onClick={() =>
            void run(
              () =>
                editing
                  ? api.patch(`/customers/${customer.id}`, {
                      fullName,
                      phone: phone || null,
                      email: email || null,
                      marketingConsent,
                    })
                  : api.post('/customers', {
                      fullName,
                      marketingConsent,
                      ...(phone ? { phone } : {}),
                      ...(email ? { email } : {}),
                      ...(taxPin ? { taxPin } : {}),
                    }),
              { success: editing ? 'Customer updated' : 'Customer added', onDone },
            )
          }
        >
          {editing ? 'Save changes' : 'Add customer'}
        </button>
      </div>
    </Modal>
  );
}

function CustomerDetail({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const { data, loading } = useApi<{
    customer: Customer;
    recentSales: Array<{ id: string; receiptNumber: string; total: number; status: string; soldAt: string }>;
    loyaltyHistory: Array<{ id: string; points: number; balanceAfter: number; kind: string; reason: string | null; createdAt: string }>;
  }>(`/customers/${customerId}`, [customerId]);

  if (loading || !data) return <Modal title="Customer" onClose={onClose}><Loading /></Modal>;

  return (
    <Modal title={data.customer.fullName} onClose={onClose} wide>
      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="label">Loyalty points</div>
          <div className="value" style={{ fontSize: 20 }}>{data.customer.loyaltyPoints}</div>
        </div>
        <div className="stat">
          <div className="label">Total spent</div>
          <div className="value" style={{ fontSize: 20 }}>{formatCents(data.customer.totalSpent)}</div>
        </div>
        <div className="stat">
          <div className="label">Visits</div>
          <div className="value" style={{ fontSize: 20 }}>{data.customer.visitCount}</div>
        </div>
      </div>

      <h3 style={{ fontSize: 14, marginBottom: 6 }}>Recent purchases</h3>
      <table style={{ marginBottom: 16 }}>
        <thead><tr><th>Receipt</th><th>When</th><th>Status</th><th className="num">Total</th></tr></thead>
        <tbody>
          {data.recentSales.map((sale) => (
            <tr key={sale.id}>
              <td className="mono">{sale.receiptNumber}</td>
              <td className="muted">{new Date(sale.soldAt).toLocaleString()}</td>
              <td><Badge tone={sale.status === 'VOIDED' ? 'danger' : undefined}>{sale.status}</Badge></td>
              <td className="num">{formatCents(sale.total)}</td>
            </tr>
          ))}
          {data.recentSales.length === 0 && <tr><td colSpan={4} className="muted">No purchases yet.</td></tr>}
        </tbody>
      </table>

      <h3 style={{ fontSize: 14, marginBottom: 6 }}>Loyalty history</h3>
      <table>
        <thead><tr><th>When</th><th>Type</th><th className="num">Points</th><th className="num">Balance</th></tr></thead>
        <tbody>
          {data.loyaltyHistory.map((entry) => (
            <tr key={entry.id}>
              <td className="muted">{new Date(entry.createdAt).toLocaleDateString()}</td>
              <td className="muted">{entry.kind.replace(/_/g, ' ').toLowerCase()}</td>
              <td className="num" style={{ color: entry.points < 0 ? 'var(--danger)' : 'var(--success)' }}>
                {entry.points > 0 ? '+' : ''}{entry.points}
              </td>
              <td className="num">{entry.balanceAfter}</td>
            </tr>
          ))}
          {data.loyaltyHistory.length === 0 && <tr><td colSpan={4} className="muted">No loyalty activity.</td></tr>}
        </tbody>
      </table>
    </Modal>
  );
}
