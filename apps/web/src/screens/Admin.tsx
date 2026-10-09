import { useState } from 'react';
import { ROLES, type Role } from '@pos/shared';
import { api } from '../lib/api.js';
import { useApi, useMutation } from '../lib/useApi.js';
import { useAuth, toast } from '../lib/store.js';
import { Modal } from '../components/Modal.js';
import { Page, Field, FormGrid, Empty, Loading, Badge } from '../components/ui.js';

type Tab = 'USERS' | 'STORES' | 'TERMINALS' | 'CARD' | 'AUDIT';

export default function Admin() {
  const can = useAuth((s) => s.can);
  const [tab, setTab] = useState<Tab>('USERS');

  return (
    <Page title="Administration" subtitle="People, stores, tills and the audit trail">
      <div className="tabs" style={{ maxWidth: 620 }}>
        {can('user:read') && <button className={tab === 'USERS' ? 'active' : ''} onClick={() => setTab('USERS')}>Staff</button>}
        {can('store:read') && <button className={tab === 'STORES' ? 'active' : ''} onClick={() => setTab('STORES')}>Stores</button>}
        {can('store:read') && <button className={tab === 'TERMINALS' ? 'active' : ''} onClick={() => setTab('TERMINALS')}>Tills</button>}
        {can('store:read') && <button className={tab === 'CARD' ? 'active' : ''} onClick={() => setTab('CARD')}>Card machines</button>}
        {can('audit:read') && <button className={tab === 'AUDIT' ? 'active' : ''} onClick={() => setTab('AUDIT')}>Audit log</button>}
      </div>

      {tab === 'USERS' && <Users />}
      {tab === 'STORES' && <Stores />}
      {tab === 'TERMINALS' && <Terminals />}
      {tab === 'CARD' && <CardTerminals />}
      {tab === 'AUDIT' && <AuditLog />}
    </Page>
  );
}

/* ---------------------------------- Staff --------------------------------- */

interface User {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  staffCode: string | null;
  isActive: boolean;
  mfaEnabled: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  storeIds: string[];
}

function Users() {
  const can = useAuth((s) => s.can);
  const { data, loading, reload } = useApi<{ users: User[] }>('/admin/users');
  const stores = useApi<{ stores: Array<{ id: string; name: string }> }>('/admin/stores');
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  const { run } = useMutation();

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="spacer" />
        {can('user:write') && <button className="btn primary" onClick={() => setEditing('new')}>Add staff</button>}
      </div>

      <div className="card" style={{ padding: 0 }}>
        {loading ? <Loading /> : (data?.users.length ?? 0) === 0 ? <Empty message="No staff yet." /> : (
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Email</th><th>Role</th><th>Till code</th>
                <th>Status</th><th>Last seen</th><th />
              </tr>
            </thead>
            <tbody>
              {data?.users.map((user) => (
                <tr key={user.id}>
                  <td>{user.fullName}</td>
                  <td className="muted">{user.email}</td>
                  <td><Badge>{user.role}</Badge></td>
                  <td className="mono">{user.staffCode ?? '—'}</td>
                  <td>
                    {!user.isActive ? <Badge tone="danger">disabled</Badge>
                      : user.lockedUntil && new Date(user.lockedUntil) > new Date() ? <Badge tone="warning">locked</Badge>
                      : <Badge tone="success">active</Badge>}
                    {user.mfaEnabled && <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>MFA</span>}
                  </td>
                  <td className="muted" style={{ fontSize: 13 }}>
                    {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : 'never'}
                  </td>
                  <td className="right">
                    {can('user:write') && (
                      <>
                        <button className="btn ghost" style={btnSmall} onClick={() => setEditing(user)}>Edit</button>
                        {user.lockedUntil && new Date(user.lockedUntil) > new Date() && (
                          <button
                            className="btn ghost"
                            style={btnSmall}
                            onClick={() => void run(() => api.post(`/admin/users/${user.id}/unlock`), { success: 'Unlocked', onDone: reload })}
                          >
                            Unlock
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <UserForm
          user={editing === 'new' ? null : editing}
          stores={stores.data?.stores ?? []}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); void reload(); }}
        />
      )}
    </>
  );
}

const btnSmall = { minHeight: 28, padding: '2px 8px', fontSize: 12 } as const;

function UserForm({
  user,
  stores,
  onClose,
  onDone,
}: {
  user: User | null;
  stores: Array<{ id: string; name: string }>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'CASHIER');
  const [password, setPassword] = useState('');
  const [staffCode, setStaffCode] = useState(user?.staffCode ?? '');
  const [pin, setPin] = useState('');
  const [storeIds, setStoreIds] = useState<string[]>(user?.storeIds ?? stores.map((s) => s.id).slice(0, 1));
  const [isActive, setIsActive] = useState(user?.isActive ?? true);
  const { busy, run } = useMutation();

  const editing = user !== null;
  const valid =
    fullName.trim().length > 1 &&
    /\S+@\S+\.\S+/.test(email) &&
    storeIds.length > 0 &&
    (editing || password.length >= 12) &&
    (!staffCode || editing || pin.length >= 4);

  return (
    <Modal title={editing ? `Edit ${user.fullName}` : 'Add staff'} onClose={onClose} wide>
      <FormGrid>
        <Field label="Full name">
          <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus />
        </Field>
        <Field label="Email">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Role">
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>
        {!editing && (
          <Field label="Temporary password" hint="At least 12 characters. They must change it on first sign-in.">
            <input className="input" type="text" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        )}
        <Field label="Till staff code" hint="Short code used at the till, e.g. CSH002">
          <input className="input mono" value={staffCode} onChange={(e) => setStaffCode(e.target.value.toUpperCase())} />
        </Field>
        <Field label={editing ? 'New PIN (leave blank to keep)' : 'Till PIN'}>
          <input className="input mono" type="password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        </Field>
      </FormGrid>

      <Field label="Stores this person may work in">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {stores.map((store) => (
            <label key={store.id} className="row" style={{ fontSize: 14, gap: 6 }}>
              <input
                type="checkbox"
                checked={storeIds.includes(store.id)}
                onChange={(e) =>
                  setStoreIds((ids) => (e.target.checked ? [...ids, store.id] : ids.filter((id) => id !== store.id)))
                }
              />
              {store.name}
            </label>
          ))}
        </div>
      </Field>

      {editing && (
        <label className="row" style={{ fontSize: 14 }}>
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Account is active
        </label>
      )}

      <p className="muted" style={{ fontSize: 13 }}>
        Changing a role, stores or disabling an account signs that person out of
        every device immediately.
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
                editing
                  ? api.patch(`/admin/users/${user.id}`, {
                      fullName, email, role, storeIds, isActive,
                      staffCode: staffCode || null,
                      ...(pin ? { pin } : {}),
                    })
                  : api.post('/admin/users', {
                      fullName, email, role, password, storeIds,
                      ...(staffCode ? { staffCode, pin } : {}),
                    }),
              { success: editing ? 'Staff updated' : 'Staff added', onDone },
            )
          }
        >
          {editing ? 'Save changes' : 'Add staff'}
        </button>
      </div>
    </Modal>
  );
}

/* --------------------------------- Stores --------------------------------- */

function Stores() {
  const can = useAuth((s) => s.can);
  const { data, loading, reload } = useApi<{ stores: Array<Record<string, any>> }>('/admin/stores');
  const [adding, setAdding] = useState(false);

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="spacer" />
        {can('store:write') && <button className="btn primary" onClick={() => setAdding(true)}>Add store</button>}
      </div>
      <div className="card" style={{ padding: 0 }}>
        {loading ? <Loading /> : (data?.stores.length ?? 0) === 0 ? <Empty message="No stores yet." /> : (
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>KRA PIN</th><th>Currency</th><th>Pricing</th></tr></thead>
            <tbody>
              {data?.stores.map((store) => (
                <tr key={store.id}>
                  <td className="mono">{store.code}</td>
                  <td>{store.name}</td>
                  <td className="mono muted">{store.taxPin ?? '—'}</td>
                  <td>{store.currency}</td>
                  <td className="muted">{store.pricesIncludeTax ? 'VAT inclusive' : 'VAT exclusive'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adding && <StoreForm onClose={() => setAdding(false)} onDone={() => { setAdding(false); void reload(); }} />}
    </>
  );
}

function StoreForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [taxPin, setTaxPin] = useState('');
  const [address, setAddress] = useState('');
  const [pricesIncludeTax, setInclusive] = useState(true);
  const { busy, run } = useMutation();

  return (
    <Modal title="Add store" onClose={onClose}>
      <FormGrid>
        <Field label="Code" hint="Short, uppercase — e.g. MAIN">
          <input className="input mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoFocus />
        </Field>
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="KRA PIN" hint="Printed on VAT invoices">
          <input className="input mono" value={taxPin} onChange={(e) => setTaxPin(e.target.value.toUpperCase())} />
        </Field>
        <Field label="Address">
          <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
      </FormGrid>
      <label className="row" style={{ fontSize: 14 }}>
        <input type="checkbox" checked={pricesIncludeTax} onChange={(e) => setInclusive(e.target.checked)} />
        Shelf prices include VAT (normal for Kenyan retail)
      </label>
      <div className="row" style={{ marginTop: 12 }}>
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={busy || !/^[A-Z0-9-]{2,12}$/.test(code) || name.trim().length < 2}
          onClick={() =>
            void run(
              () => api.post('/admin/stores', {
                code, name, pricesIncludeTax,
                ...(taxPin ? { taxPin } : {}),
                ...(address ? { address } : {}),
              }),
              { success: 'Store created', onDone },
            )
          }
        >
          Create store
        </button>
      </div>
    </Modal>
  );
}

/* --------------------------------- Tills ---------------------------------- */

function Terminals() {
  const can = useAuth((s) => s.can);
  const stores = useApi<{ stores: Array<{ id: string; name: string; code: string }> }>('/admin/stores');
  const { data, loading, reload } = useApi<{ terminals: Array<Record<string, any>> }>('/admin/terminals');
  const [adding, setAdding] = useState(false);

  const storeName = (id: string) => stores.data?.stores.find((s) => s.id === id)?.name ?? id;

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 13 }}>
          Each till issues its own receipt sequence, so numbers never collide between tills.
        </span>
        <div className="spacer" />
        {can('store:write') && <button className="btn primary" onClick={() => setAdding(true)}>Add till</button>}
      </div>
      <div className="card" style={{ padding: 0 }}>
        {loading ? <Loading /> : (data?.terminals.length ?? 0) === 0 ? (
          <Empty
            message="No tills yet. A till is needed before anyone can take payment."
            action={can('store:write') ? <button className="btn primary" onClick={() => setAdding(true)}>Add the first till</button> : undefined}
          />
        ) : (
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Store</th><th>Receipt prefix</th><th className="num">Last receipt</th><th>Last seen</th></tr></thead>
            <tbody>
              {data?.terminals.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{t.code}</td>
                  <td>{t.name}</td>
                  <td className="muted">{storeName(t.storeId)}</td>
                  <td className="mono">{t.receiptPrefix}</td>
                  <td className="num muted">{t.lastReceiptSequence}</td>
                  <td className="muted" style={{ fontSize: 13 }}>
                    {t.lastSeenAt ? new Date(t.lastSeenAt).toLocaleString() : 'never'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adding && (
        <TerminalForm
          stores={stores.data?.stores ?? []}
          onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); void reload(); }}
        />
      )}
    </>
  );
}

function TerminalForm({
  stores,
  onClose,
  onDone,
}: {
  stores: Array<{ id: string; name: string; code: string }>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [storeId, setStoreId] = useState(stores[0]?.id ?? '');
  const [code, setCode] = useState('T1');
  const [name, setName] = useState('');
  const { busy, run } = useMutation();

  const store = stores.find((s) => s.id === storeId);
  // Derived, not typed: a prefix that matches the store and till is easier to
  // read on a receipt and impossible to get accidentally duplicated.
  const receiptPrefix = store ? `${store.code}${code}`.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) : '';

  return (
    <Modal title="Add till" onClose={onClose}>
      <FormGrid>
        <Field label="Store">
          <select className="input" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Till code">
          <input className="input mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </Field>
        <Field label="Name" wide>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Front counter" autoFocus />
        </Field>
      </FormGrid>
      <p className="muted" style={{ fontSize: 13 }}>
        Receipts will be numbered <span className="mono">{receiptPrefix || '…'}-000001</span> onwards.
      </p>
      <div className="row">
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={busy || !storeId || !receiptPrefix || name.trim().length < 2}
          onClick={() =>
            void run(
              () => api.post('/admin/terminals', { storeId, code, name, receiptPrefix }),
              { success: 'Till created', onDone },
            )
          }
        >
          Create till
        </button>
      </div>
    </Modal>
  );
}

/* ----------------------------- Card terminals ----------------------------- */

function CardTerminals() {
  const { storeId, can } = useAuth();
  const { data, loading, reload } = useApi<{ terminals: Array<Record<string, any>> }>(
    storeId ? `/admin/pdq-terminals?storeId=${storeId}` : null,
    [storeId],
  );
  const [adding, setAdding] = useState(false);

  if (!storeId) return <div className="card"><Empty message="Set up this device for a till first." /></div>;

  return (
    <>
      {/* Most shops do not need this screen at all, and an owner should be able
          to tell that in ten seconds rather than wondering what they are missing. */}
      <div className="card" style={{ marginBottom: 14 }}>
        <strong style={{ fontSize: 15 }}>Do you need this?</strong>
        <p className="muted" style={{ fontSize: 13, margin: '6px 0 10px' }}>
          Only if your bank lets the till send the amount to the card machine
          automatically. Most shops keep the card machine separate: the cashier reads
          the total off the screen, keys it into the machine, and records the approval
          code. <strong>That works today and needs nothing on this screen.</strong>
        </p>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          Set a machine up here only once your bank has given you their integration
          details. Ask them for &ldquo;ECR integration&rdquo; or &ldquo;POS integration&rdquo;.
        </p>
      </div>

      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 13 }}>
          Card numbers never reach this system — only the last four digits and the approval code.
        </span>
        <div className="spacer" />
        {can('store:write') && <button className="btn primary" onClick={() => setAdding(true)}>Add card machine</button>}
      </div>
      <div className="card" style={{ padding: 0 }}>
        {loading ? <Loading /> : (data?.terminals.length ?? 0) === 0 ? (
          <Empty message="No card machine connected. Cashiers can still take card payments on a standalone machine and record the approval code." />
        ) : (
          <table>
            <thead><tr><th>Label</th><th>Type</th><th>Acquirer</th><th>Endpoint</th><th>Secret</th><th>Status</th></tr></thead>
            <tbody>
              {data?.terminals.map((t) => (
                <tr key={t.id}>
                  <td>{t.label}</td>
                  <td><Badge>{t.provider}</Badge></td>
                  <td className="muted">{t.acquirer ?? '—'}</td>
                  <td className="mono muted" style={{ fontSize: 12 }}>{t.endpointUrl ?? '—'}</td>
                  <td>{t.hasSecret ? <Badge tone="success">set</Badge> : <span className="muted">none</span>}</td>
                  <td>{t.isActive ? <Badge tone="success">active</Badge> : <Badge tone="danger">inactive</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adding && (
        <CardTerminalForm storeId={storeId} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void reload(); }} />
      )}
    </>
  );
}

function CardTerminalForm({ storeId, onClose, onDone }: { storeId: string; onClose: () => void; onDone: () => void }) {
  const [label, setLabel] = useState('');
  const [provider, setProvider] = useState<'SIMULATOR' | 'ECR_HTTP'>('ECR_HTTP');
  const [acquirer, setAcquirer] = useState('');
  const [endpointUrl, setEndpoint] = useState('http://127.0.0.1:9110');
  const [deviceSerial, setSerial] = useState('');
  const [secret, setSecret] = useState('');
  const { busy, run } = useMutation();

  return (
    <Modal title="Add card machine" onClose={onClose}>
      <FormGrid>
        <Field label="Label">
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Counter card machine" autoFocus />
        </Field>
        <Field label="Type" hint="Use the simulator to try the flow without real hardware.">
          <select className="input" value={provider} onChange={(e) => setProvider(e.target.value as 'SIMULATOR' | 'ECR_HTTP')}>
            <option value="ECR_HTTP">Real machine, connected to the till</option>
            <option value="SIMULATOR">Simulator — testing only</option>
          </select>
        </Field>
        <Field label="Acquirer">
          <input className="input" value={acquirer} onChange={(e) => setAcquirer(e.target.value)} placeholder="Equity, KCB, Co-op…" />
        </Field>
        <Field label="Device serial">
          <input className="input mono" value={deviceSerial} onChange={(e) => setSerial(e.target.value)} />
        </Field>
      </FormGrid>

      {provider === 'ECR_HTTP' && (
        <>
          <Field label="Bridge address" hint="The ECR bridge running next to the card reader, usually on this machine.">
            <input className="input mono" value={endpointUrl} onChange={(e) => setEndpoint(e.target.value)} />
          </Field>
          <Field label="Shared secret" hint="Stored encrypted and never shown again.">
            <input className="input mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </Field>
        </>
      )}

      <div className="row">
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={busy || label.trim().length < 2}
          onClick={() =>
            void run(
              () =>
                api.post('/admin/pdq-terminals', {
                  storeId, label, provider,
                  ...(acquirer ? { acquirer } : {}),
                  ...(deviceSerial ? { deviceSerial } : {}),
                  ...(provider === 'ECR_HTTP' ? { endpointUrl } : {}),
                  ...(secret ? { secret } : {}),
                }),
              { success: 'Card terminal added', onDone },
            )
          }
        >
          Add terminal
        </button>
      </div>
    </Modal>
  );
}

/* -------------------------------- Audit log ------------------------------- */

function AuditLog() {
  const { data, loading } = useApi<{ logs: Array<Record<string, any>> }>('/admin/audit?limit=200');

  return (
    <div className="card" style={{ padding: 0 }}>
      {loading ? <Loading /> : (data?.logs.length ?? 0) === 0 ? <Empty message="Nothing recorded yet." /> : (
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Approved by</th><th>Reason</th></tr></thead>
          <tbody>
            {data?.logs.map((log) => (
              <tr key={log.id}>
                <td className="muted" style={{ fontSize: 13 }}>{new Date(log.createdAt).toLocaleString()}</td>
                <td>{log.actorEmail ?? '—'}</td>
                <td><Badge>{log.action.replace(/_/g, ' ').toLowerCase()}</Badge></td>
                <td className="muted" style={{ fontSize: 12 }}>{log.entityType}</td>
                <td>{log.overrideByUserId ? <Badge tone="warning">override</Badge> : '—'}</td>
                <td className="muted" style={{ fontSize: 12 }}>{log.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
