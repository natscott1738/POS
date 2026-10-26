import { useEffect, useState } from 'react';
import { formatCents } from '@pos/shared';
import { api } from '../lib/api.js';
import { useApi, useMutation } from '../lib/useApi.js';
import { useAuth } from '../lib/store.js';
import { Modal } from '../components/Modal.js';
import { Badge, Empty, Field, FormGrid, Loading, Page } from '../components/ui.js';

interface CreditAccount {
  id: string;
  customerId: string;
  storeId: string;
  customerName: string;
  phone: string | null;
  creditLimit: number;
  balance: number;
  available: number;
  overdue: number;
  openInvoices: number;
  termsDays: number;
  isActive: boolean;
}

export default function Credit() {
  const can = useAuth((state) => state.can);
  const storeId = useAuth((state) => state.storeId);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'ALL' | 'OPEN' | 'OVERDUE' | 'CLOSED'>('ALL');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const path = `/credit/accounts?limit=100&status=${status}${storeId ? `&storeId=${storeId}` : ''}${query ? `&q=${encodeURIComponent(query)}` : ''}`;
  const { data, loading, reload } = useApi<{ accounts: CreditAccount[] }>(path, [status, storeId, query]);

  return (
    <Page
      title="Credit accounts"
      subtitle="Customer balances, due dates, repayments and account limits"
      actions={can('credit:manage') && <button className="btn primary" onClick={() => setCreating(true)}>Open account</button>}
    >
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          className="input"
          style={{ maxWidth: 340 }}
          placeholder="Search customer name or phone"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && setQuery(search.trim())}
        />
        <button className="btn" onClick={() => setQuery(search.trim())}>Search</button>
        <select className="input" style={{ maxWidth: 170 }} value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
          <option value="ALL">All accounts</option>
          <option value="OPEN">With a balance</option>
          <option value="OVERDUE">Overdue</option>
          <option value="CLOSED">Inactive</option>
        </select>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 13 }}>{data?.accounts.length ?? 0} accounts</span>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {loading ? <Loading /> : (data?.accounts.length ?? 0) === 0 ? (
          <Empty message={query ? 'No accounts match that search.' : 'No credit accounts yet. Open an account for an approved customer.'} />
        ) : (
          <table>
            <thead><tr><th>Customer</th><th>Phone</th><th className="num">Balance due</th><th className="num">Overdue</th><th className="num">Limit</th><th className="num">Available</th><th className="num">Open invoices</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data?.accounts.map((account) => (
                <tr key={account.id}>
                  <td><strong>{account.customerName}</strong></td>
                  <td className="mono muted">{account.phone ?? '—'}</td>
                  <td className="num" style={{ fontWeight: 700 }}>{formatCents(Math.max(0, account.balance))}</td>
                  <td className="num" style={{ color: account.overdue > 0 ? 'var(--danger)' : undefined }}>
                    {account.overdue > 0 ? formatCents(account.overdue) : '—'}
                  </td>
                  <td className="num">{formatCents(account.creditLimit)}</td>
                  <td className="num">{account.isActive ? formatCents(account.available) : '—'}</td>
                  <td className="num">{account.openInvoices}</td>
                  <td><Badge tone={!account.isActive ? 'danger' : account.overdue > 0 ? 'warning' : 'success'}>{!account.isActive ? 'inactive' : account.overdue > 0 ? 'overdue' : 'active'}</Badge></td>
                  <td className="right"><button className="btn ghost" onClick={() => setSelected(account.id)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {creating && <CreateAccount storeId={storeId} onClose={() => setCreating(false)} onDone={() => { setCreating(false); void reload(); }} />}
      {selected && <AccountDetail accountId={selected} canManage={can('credit:manage')} shiftId={useAuth.getState().shiftId} onClose={() => setSelected(null)} onChanged={() => void reload()} />}
    </Page>
  );
}

function CreateAccount({ storeId, onClose, onDone }: { storeId: string | null; onClose: () => void; onDone: () => void }) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [limit, setLimit] = useState('');
  const [termsDays, setTermsDays] = useState('30');
  const { data, loading } = useApi<{ customers: Array<{ id: string; fullName: string; phone: string | null }> }>(
    query ? `/customers?limit=50&q=${encodeURIComponent(query)}` : null,
    [query],
  );
  const { busy, run } = useMutation();

  return (
    <Modal title="Open credit account" onClose={onClose} wide>
      {!storeId && <div className="banner warning">Choose a store in till setup before opening an account.</div>}
      <Field label="Find a customer" hint="Credit accounts are unique to a customer and store.">
        <div className="row">
          <input className="input" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && setQuery(search.trim())} placeholder="Name, phone or email" />
          <button className="btn" onClick={() => setQuery(search.trim())}>Find</button>
        </div>
      </Field>
      {customerId ? (
        <div className="row card" style={{ padding: 10, margin: '10px 0' }}>
          <strong>{customerName}</strong><div className="spacer" />
          <button className="btn ghost" onClick={() => { setCustomerId(''); setCustomerName(''); }}>Change</button>
        </div>
      ) : loading ? <Loading /> : data && (
        <div className="card" style={{ padding: 0, maxHeight: 220, overflow: 'auto', margin: '10px 0' }}>
          {data.customers.map((customer) => (
            <button key={customer.id} className="btn ghost block" style={{ textAlign: 'left', borderRadius: 0 }} onClick={() => { setCustomerId(customer.id); setCustomerName(customer.fullName); }}>
              {customer.fullName}<span className="muted" style={{ marginLeft: 10 }}>{customer.phone ?? ''}</span>
            </button>
          ))}
          {data.customers.length === 0 && <Empty message="No customers found." />}
        </div>
      )}
      <FormGrid>
        <Field label="Credit limit (KES)">
          <input className="input mono" inputMode="decimal" value={limit} onChange={(event) => setLimit(event.target.value.replace(/[^\d.]/g, ''))} placeholder="e.g. 5000.00" />
        </Field>
        <Field label="Payment terms (days)">
          <input className="input mono" type="number" min="0" max="365" value={termsDays} onChange={(event) => setTermsDays(event.target.value)} />
        </Field>
      </FormGrid>
      <p className="muted" style={{ fontSize: 12 }}>Each account sale becomes a dated invoice. Payments apply to the oldest due invoice first.</p>
      <div className="row"><div className="spacer" /><button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !storeId || !customerId || Number(limit) <= 0} onClick={() => void run(
          () => api.post('/credit/accounts', { customerId, storeId, creditLimit: Math.round(Number(limit) * 100), termsDays: Number(termsDays) }),
          { success: 'Credit account opened', onDone },
        )}>Open account</button>
      </div>
    </Modal>
  );
}

interface CreditTransaction {
  id: string;
  saleId: string | null;
  type: string;
  amount: number;
  balanceAfter: number;
  paymentMethod: string | null;
  reference: string | null;
  note: string | null;
  dueAt: string | null;
  createdAt: string;
  openAmount: number;
  unappliedAmount: number;
}

function AccountDetail({ accountId, canManage, shiftId, onClose, onChanged }: {
  accountId: string; canManage: boolean; shiftId: string | null; onClose: () => void; onChanged: () => void;
}) {
  const { data, loading, reload } = useApi<{
    account: CreditAccount;
    customer: { fullName: string; phone: string | null };
    transactions: CreditTransaction[];
  }>(`/credit/accounts/${accountId}`, [accountId]);
  const [paying, setPaying] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [editing, setEditing] = useState(false);

  if (loading || !data) return <Modal title="Credit account" onClose={onClose}><Loading /></Modal>;
  const openInvoices = data.transactions.filter((entry) => entry.amount > 0 && entry.openAmount > 0);
  const overdue = openInvoices.filter((entry) => entry.dueAt && new Date(entry.dueAt).getTime() < Date.now()).reduce((sum, entry) => sum + entry.openAmount, 0);

  return (
    <Modal title={data.customer.fullName} onClose={onClose} wide>
      <div className="row" style={{ marginBottom: 14 }}>
        <span className="muted">{data.customer.phone ?? 'No phone on file'}</span><div className="spacer" />
        <button className="btn primary" disabled={data.account.balance <= 0} onClick={() => setPaying(true)}>Record payment</button>
        {canManage && <button className="btn" onClick={() => setEditing(true)}>Account settings</button>}
        {canManage && <button className="btn ghost" onClick={() => setAdjusting(true)}>Adjust</button>}
      </div>
      <div className="stat-grid" style={{ marginBottom: 16 }}>
        <div className="stat"><div className="label">Balance due</div><div className="value" style={{ fontSize: 20 }}>{formatCents(Math.max(0, data.account.balance))}</div></div>
        <div className="stat"><div className="label">Overdue</div><div className="value" style={{ fontSize: 20, color: overdue > 0 ? 'var(--danger)' : undefined }}>{formatCents(overdue)}</div></div>
        <div className="stat"><div className="label">Credit limit</div><div className="value" style={{ fontSize: 20 }}>{formatCents(data.account.creditLimit)}</div></div>
        <div className="stat"><div className="label">Available credit</div><div className="value" style={{ fontSize: 20 }}>{formatCents(data.account.isActive ? Math.max(0, data.account.creditLimit - data.account.balance) : 0)}</div></div>
      </div>
      {!data.account.isActive && <div className="banner warning">This account is inactive. No new purchases can be charged, but repayments are still accepted.</div>}
      <div className="row" style={{ marginBottom: 6 }}><h3 style={{ fontSize: 14, margin: 0 }}>Account activity</h3><div className="spacer" /><span className="muted" style={{ fontSize: 12 }}>Oldest invoices are paid first</span></div>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>Date</th><th>Entry</th><th>Due date</th><th>Reference / note</th><th className="num">Amount</th><th className="num">Open</th><th className="num">Balance after</th></tr></thead>
          <tbody>
            {data.transactions.map((entry) => (
              <tr key={entry.id}>
                <td className="muted">{new Date(entry.createdAt).toLocaleString()}</td>
                <td><Badge tone={entry.amount > 0 ? (entry.dueAt && new Date(entry.dueAt).getTime() < Date.now() && entry.openAmount > 0 ? 'danger' : undefined) : 'success'}>{entry.type.replace(/_/g, ' ').toLowerCase()}</Badge>{entry.paymentMethod ? <span className="muted" style={{ marginLeft: 6 }}>{entry.paymentMethod}</span> : null}</td>
                <td className="muted">{entry.dueAt ? new Date(entry.dueAt).toLocaleDateString() : '—'}</td>
                <td className="muted">{entry.reference ?? entry.note ?? (entry.saleId ? `Sale ${entry.saleId.slice(0, 8)}` : '—')}</td>
                <td className="num" style={{ color: entry.amount < 0 ? 'var(--success)' : undefined }}>{entry.amount > 0 ? '+' : ''}{formatCents(entry.amount)}</td>
                <td className="num">{entry.amount > 0 ? formatCents(entry.openAmount) : entry.unappliedAmount > 0 ? `${formatCents(entry.unappliedAmount)} credit` : '—'}</td>
                <td className="num">{formatCents(entry.balanceAfter)}</td>
              </tr>
            ))}
            {data.transactions.length === 0 && <tr><td colSpan={7} className="muted">No account activity yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {paying && <PaymentForm accountId={accountId} balance={Math.max(0, data.account.balance)} shiftId={shiftId} onClose={() => setPaying(false)} onDone={() => { setPaying(false); void reload(); onChanged(); }} />}
      {adjusting && <AdjustmentForm accountId={accountId} onClose={() => setAdjusting(false)} onDone={() => { setAdjusting(false); void reload(); onChanged(); }} />}
      {editing && <AccountSettings account={data.account} onClose={() => setEditing(false)} onDone={() => { setEditing(false); void reload(); onChanged(); }} />}
    </Modal>
  );
}

function PaymentForm({ accountId, balance, shiftId, onClose, onDone }: { accountId: string; balance: number; shiftId: string | null; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState((balance / 100).toFixed(2));
  const [method, setMethod] = useState<'CASH' | 'MPESA' | 'BANK_TRANSFER'>('CASH');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [clientPaymentId, setClientPaymentId] = useState(() => crypto.randomUUID());
  const { busy, run } = useMutation();
  const cents = Math.round(Number(amount) * 100);
  // Keep one idempotency key while an unchanged request is retried after a timeout.
  // Editing any part of the payment creates a fresh request identity.
  useEffect(() => { setClientPaymentId(crypto.randomUUID()); }, [amount, method, reference, note, shiftId]);
  return <Modal title="Record customer payment" onClose={onClose}>
    <p className="muted">Outstanding balance: <strong>{formatCents(balance)}</strong>. Payment is allocated to the oldest due invoices.</p>
    <FormGrid>
      <Field label="Amount (KES)"><input className="input mono" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" autoFocus /></Field>
      <Field label="Received by"><select className="input" value={method} onChange={(event) => setMethod(event.target.value as typeof method)}><option value="CASH">Cash</option><option value="MPESA">M-PESA</option><option value="BANK_TRANSFER">Bank transfer</option></select></Field>
      {method !== 'CASH' && <Field label={method === 'MPESA' ? 'M-PESA confirmation code' : 'Bank reference'} wide><input className="input mono" value={reference} onChange={(event) => setReference(event.target.value.toUpperCase())} /></Field>}
      <Field label="Note (optional)" wide><input className="input" value={note} onChange={(event) => setNote(event.target.value)} /></Field>
    </FormGrid>
    {method === 'CASH' && !shiftId && <div className="banner warning">Open a shift before recording cash. This keeps the collection in the drawer close.</div>}
    <div className="row"><div className="spacer" /><button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || cents <= 0 || cents > balance || (method === 'CASH' && !shiftId) || (method === 'MPESA' && !/^[A-Z0-9]{8,15}$/.test(reference)) || (method === 'BANK_TRANSFER' && !reference.trim())} onClick={() => void run(
        () => api.post(`/credit/accounts/${accountId}/payments`, { clientPaymentId, amount: cents, method, reference: reference || undefined, note: note || undefined, shiftId }, clientPaymentId),
        { success: 'Payment recorded', onDone },
      )}>Record payment</button>
    </div>
  </Modal>;
}

function AdjustmentForm({ accountId, onClose, onDone }: { accountId: string; onClose: () => void; onDone: () => void }) {
  const [direction, setDirection] = useState<'CHARGE' | 'CREDIT'>('CREDIT');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const { busy, run } = useMutation();
  return <Modal title="Adjust account" onClose={onClose}>
    <div className="banner warning">Adjustments are audited. Use a payment entry when money was actually received.</div>
    <FormGrid>
      <Field label="Adjustment"><select className="input" value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)}><option value="CREDIT">Reduce amount owed</option><option value="CHARGE">Increase amount owed</option></select></Field>
      <Field label="Amount (KES)"><input className="input mono" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" autoFocus /></Field>
      <Field label="Reason" wide><input className="input" value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
    </FormGrid>
    <div className="row"><div className="spacer" /><button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || Number(amount) <= 0 || reason.trim().length < 3} onClick={() => void run(
        () => api.post(`/credit/accounts/${accountId}/adjustments`, { amount: Math.round(Number(amount) * 100) * (direction === 'CREDIT' ? -1 : 1), reason }),
        { success: 'Account adjusted', onDone },
      )}>Save adjustment</button>
    </div>
  </Modal>;
}

function AccountSettings({ account, onClose, onDone }: { account: CreditAccount; onClose: () => void; onDone: () => void }) {
  const [limit, setLimit] = useState((account.creditLimit / 100).toFixed(2));
  const [terms, setTerms] = useState(String(account.termsDays));
  const [active, setActive] = useState(account.isActive);
  const { busy, run } = useMutation();
  return <Modal title="Credit account settings" onClose={onClose}>
    <FormGrid>
      <Field label="Credit limit (KES)"><input className="input mono" value={limit} onChange={(event) => setLimit(event.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" /></Field>
      <Field label="Payment terms (days)"><input className="input mono" type="number" min="0" max="365" value={terms} onChange={(event) => setTerms(event.target.value)} /></Field>
    </FormGrid>
    <label className="row" style={{ margin: '10px 0 16px' }}><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Allow new account purchases</label>
    <div className="row"><div className="spacer" /><button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || Number(limit) < 0} onClick={() => void run(
        () => api.patch(`/credit/accounts/${account.id}`, { creditLimit: Math.round(Number(limit) * 100), termsDays: Number(terms), isActive: active }),
        { success: 'Account settings saved', onDone },
      )}>Save changes</button>
    </div>
  </Modal>;
}
