import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useApi, useMutation } from '../lib/useApi.js';
import { useAuth, toast } from '../lib/store.js';
import { Page, Field, FormGrid, Empty, Loading, Badge } from '../components/ui.js';

interface Status {
  connected: boolean;
  connection: { realmId: string; environment: string; lastSyncAt: string | null; lastSyncError: string | null; refreshTokenExpiresAt: string } | null;
  mappingConfigured: boolean;
  queue: { pending: number; failed: number; dead: number };
}

interface Account {
  Id: string;
  Name: string;
  AccountType: string;
  AccountSubType?: string;
}

const PAYMENT_METHODS = ['CASH', 'MPESA', 'PDQ', 'BANK_TRANSFER', 'GIFT_CARD', 'STORE_CREDIT'] as const;

export default function QuickBooks() {
  const { storeId, can } = useAuth();
  const { data: status, loading, reload } = useApi<Status>(storeId ? `/quickbooks/status?storeId=${storeId}` : null, [storeId]);
  const { run, busy } = useMutation();

  // Returning from Intuit's consent screen.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('connected') === '1') {
      toast.success('QuickBooks connected');
      window.history.replaceState({}, '', window.location.pathname);
      void reload();
    }
  }, [reload]);

  if (!storeId) return <Page title="QuickBooks"><div className="card"><Empty message="Set up this device for a till first." /></div></Page>;
  if (loading) return <Page title="QuickBooks"><Loading /></Page>;

  const connected = status?.connected ?? false;

  return (
    <Page
      title="QuickBooks"
      subtitle="Post sales, refunds and tax to your accounts automatically"
      actions={
        connected && can('quickbooks:sync') ? (
          <button
            className="btn"
            disabled={busy}
            onClick={() => void run(() => api.post('/quickbooks/sync', { storeId }), { success: 'Sync run', onDone: reload })}
          >
            Sync now
          </button>
        ) : undefined
      }
    >
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row">
          <div>
            <strong>Connection</strong>
            <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
              {connected
                ? `Company ${status?.connection?.realmId} · ${status?.connection?.environment}`
                : 'Not connected. Sales are still recorded here and will post once connected.'}
            </div>
          </div>
          <div className="spacer" />
          {connected ? <Badge tone="success">connected</Badge> : <Badge tone="warning">not connected</Badge>}
        </div>

        {status?.connection?.lastSyncError && (
          <div className="banner error" style={{ marginTop: 12, marginBottom: 0 }}>
            Last sync error: {status.connection.lastSyncError}
          </div>
        )}

        {connected && status?.connection && (
          <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
            Reconnect before {new Date(status.connection.refreshTokenExpiresAt).toLocaleDateString()} —
            QuickBooks expires the connection after about 100 days of inactivity, and sync stops when it does.
          </p>
        )}

        {!connected && can('quickbooks:connect') && (
          <button
            className="btn primary"
            style={{ marginTop: 12 }}
            disabled={busy}
            onClick={() =>
              void run(
                async () => {
                  const result = await api.get<{ authorizeUrl: string }>(`/quickbooks/connect?storeId=${storeId}`);
                  window.location.assign(result.authorizeUrl);
                },
              )
            }
          >
            Connect to QuickBooks
          </button>
        )}
      </div>

      {connected && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="row">
              <div>
                <strong>Sync queue</strong>
                <div className="muted" style={{ fontSize: 13 }}>
                  {status?.mappingConfigured
                    ? 'Sales are queued and posted in the background.'
                    : 'Nothing will post until the accounts below are mapped.'}
                </div>
              </div>
              <div className="spacer" />
              <span className="muted">{status?.queue.pending ?? 0} pending</span>
              {(status?.queue.dead ?? 0) > 0 && (
                <>
                  <Badge tone="danger">{status?.queue.dead} failed permanently</Badge>
                  <button
                    className="btn ghost"
                    disabled={busy}
                    onClick={() => void run(() => api.post('/quickbooks/queue/retry', { storeId }), { success: 'Requeued', onDone: reload })}
                  >
                    Retry
                  </button>
                </>
              )}
            </div>
          </div>

          <MappingForm storeId={storeId} configured={status?.mappingConfigured ?? false} onSaved={reload} />
        </>
      )}
    </Page>
  );
}

/**
 * Maps POS concepts onto the customer's real chart of accounts. Nothing posts
 * until this is complete — a guessed account is far more expensive to unpick
 * than a blocked queue.
 */
function MappingForm({ storeId, configured, onSaved }: { storeId: string; configured: boolean; onSaved: () => void }) {
  const accounts = useApi<{ accounts: Account[] }>(`/quickbooks/accounts?storeId=${storeId}`, [storeId]);
  const taxCodes = useApi<{ taxCodes: Array<{ Id: string; Name: string }> }>(`/quickbooks/tax-codes?storeId=${storeId}`, [storeId]);
  const existing = useApi<{ mapping: Record<string, any> | null }>(`/quickbooks/mapping?storeId=${storeId}`, [storeId]);
  const { busy, run } = useMutation();

  const [incomeAccountId, setIncome] = useState('');
  const [undepositedFundsAccountId, setUndeposited] = useState('');
  const [taxCodeIdStandard, setTaxStandard] = useState('');
  const [paymentAccounts, setPaymentAccounts] = useState<Record<string, string>>({});
  const [postingMode, setPostingMode] = useState('PER_SALE');

  useEffect(() => {
    const mapping = existing.data?.mapping;
    if (!mapping) return;
    setIncome(mapping.incomeAccountId ?? '');
    setUndeposited(mapping.undepositedFundsAccountId ?? '');
    setTaxStandard(mapping.taxCodeIdStandard ?? '');
    setPaymentAccounts((mapping.paymentAccounts ?? {}) as Record<string, string>);
    setPostingMode(mapping.postingMode ?? 'PER_SALE');
  }, [existing.data]);

  if (accounts.loading || existing.loading) return <div className="card"><Loading /></div>;

  if (accounts.error) {
    return (
      <div className="card">
        <div className="banner error" style={{ marginBottom: 0 }}>
          Could not read your chart of accounts: {accounts.error}
        </div>
      </div>
    );
  }

  const income = accounts.data?.accounts.filter((a) => a.AccountType === 'Income') ?? [];
  const assets = accounts.data?.accounts.filter((a) => a.AccountType === 'Bank' || a.AccountType === 'Other Current Asset') ?? [];

  const incomeName = income.find((a) => a.Id === incomeAccountId)?.Name ?? '';
  const valid = Boolean(incomeAccountId && undepositedFundsAccountId);

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <strong>Account mapping</strong>
        <div className="spacer" />
        {configured ? <Badge tone="success">configured</Badge> : <Badge tone="warning">required</Badge>}
      </div>

      <FormGrid>
        <Field label="Sales income account" hint="Where takings are recorded">
          <select className="input" value={incomeAccountId} onChange={(e) => setIncome(e.target.value)}>
            <option value="">Choose…</option>
            {income.map((a) => <option key={a.Id} value={a.Id}>{a.Name}</option>)}
          </select>
        </Field>
        <Field label="Default deposit account" hint="Used when a tender has no specific account below">
          <select className="input" value={undepositedFundsAccountId} onChange={(e) => setUndeposited(e.target.value)}>
            <option value="">Choose…</option>
            {assets.map((a) => <option key={a.Id} value={a.Id}>{a.Name}</option>)}
          </select>
        </Field>
        <Field label="Standard VAT code">
          <select className="input" value={taxCodeIdStandard} onChange={(e) => setTaxStandard(e.target.value)}>
            <option value="">None</option>
            {taxCodes.data?.taxCodes.map((t) => <option key={t.Id} value={t.Id}>{t.Name}</option>)}
          </select>
        </Field>
        <Field label="Posting mode">
          <select className="input" value={postingMode} onChange={(e) => setPostingMode(e.target.value)}>
            <option value="PER_SALE">One entry per sale</option>
            <option value="DAILY_SUMMARY">One summary per day</option>
          </select>
        </Field>
      </FormGrid>

      <p className="label" style={{ marginTop: 8 }}>Where each payment method is banked</p>
      <FormGrid columns={3}>
        {PAYMENT_METHODS.map((method) => (
          <Field key={method} label={method.replace('_', ' ')}>
            <select
              className="input"
              value={paymentAccounts[method] ?? ''}
              onChange={(e) => setPaymentAccounts((p) => ({ ...p, [method]: e.target.value }))}
            >
              <option value="">Use default</option>
              {assets.map((a) => <option key={a.Id} value={a.Id}>{a.Name}</option>)}
            </select>
          </Field>
        ))}
      </FormGrid>

      <div className="row">
        <div className="spacer" />
        <button
          className="btn primary"
          disabled={busy || !valid}
          onClick={() =>
            void run(
              () =>
                api.put('/quickbooks/mapping', {
                  storeId,
                  incomeAccountId,
                  incomeAccountName: incomeName,
                  undepositedFundsAccountId,
                  taxCodeIdStandard: taxCodeIdStandard || null,
                  paymentAccounts: Object.fromEntries(Object.entries(paymentAccounts).filter(([, v]) => v)),
                  postingMode,
                  autoSyncEnabled: true,
                }),
              { success: 'Mapping saved', onDone: onSaved },
            )
          }
        >
          Save mapping
        </button>
      </div>
    </div>
  );
}
