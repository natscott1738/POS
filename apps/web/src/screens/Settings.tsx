import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth, useNetwork, toast } from '../lib/store.js';
import { resetCatalogue, runSync } from '../lib/sync.js';
import { db, pendingCount } from '../lib/db.js';
import TillSetup from './TillSetup.js';
import PrinterSettings from './PrinterSettings.js';

export default function Settings() {
  const { user, storeId, terminalId, deviceId, can } = useAuth();
  const network = useNetwork();
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState<Array<{ opId: string; lastError?: string; attempts: number }>>([]);
  const [qb, setQb] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    void pendingCount().then(setPending);
    void db.queue.where('status').equals('FAILED').toArray().then(setFailed);
    if (storeId && can('quickbooks:sync')) {
      void api.get<Record<string, unknown>>(`/quickbooks/status?storeId=${storeId}`).then(setQb).catch(() => setQb(null));
    }
  }, [storeId, can, network.lastSyncAt]);

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Settings</h1>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))' }}>
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>This till</h2>
          {(!storeId || !terminalId) && (
            <div className="banner warning">
              This device is not bound to a till yet, so it cannot take payment.
            </div>
          )}
          <dl style={{ margin: 0, fontSize: 14 }}>
            <Row label="Signed in as" value={user?.email ?? '—'} />
            <Row label="Role" value={user?.role ?? '—'} />
            <Row label="Store" value={storeId ?? 'not set'} mono />
            <Row label="Terminal" value={terminalId ?? 'not set'} mono />
            <Row label="Device" value={deviceId ?? 'not set'} mono />
          </dl>
          <details style={{ marginTop: 12 }}>
            <summary className="muted" style={{ cursor: 'pointer' }}>Change till</summary>
            <div style={{ marginTop: 10 }}><TillSetup /></div>
          </details>
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Receipt printer</h2>
          <PrinterSettings />
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Sync</h2>
          <dl style={{ margin: 0, fontSize: 14 }}>
            <Row label="Connection" value={network.serverReachable ? 'Online' : 'Offline'} />
            <Row label="Queued operations" value={String(pending)} />
            <Row
              label="Last sync"
              value={network.lastSyncAt ? new Date(network.lastSyncAt).toLocaleTimeString() : 'never'}
            />
          </dl>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" disabled={network.syncing} onClick={() => void runSync()}>
              {network.syncing ? 'Syncing…' : 'Sync now'}
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                void resetCatalogue().then(() => toast.success('Catalogue refreshed'));
              }}
            >
              Rebuild catalogue
            </button>
          </div>

          {failed.length > 0 && (
            <div className="banner error" style={{ marginTop: 12 }}>
              <strong>{failed.length}</strong> operation{failed.length === 1 ? '' : 's'} rejected by the server.
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }}>
                {failed.slice(0, 5).map((f) => (
                  <li key={f.opId}>{f.lastError ?? 'unknown error'}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {qb && (
          <div className="card">
            <h2 style={{ marginTop: 0, fontSize: 16 }}>QuickBooks</h2>
            <dl style={{ margin: 0, fontSize: 14 }}>
              <Row label="Connected" value={qb.connected ? 'Yes' : 'No'} />
              <Row label="Mapping" value={qb.mappingConfigured ? 'Configured' : 'Not configured'} />
              <Row label="Queue" value={JSON.stringify(qb.queue ?? {})} />
            </dl>
            {!qb.connected && can('quickbooks:connect') && storeId && (
              <button
                className="btn primary"
                style={{ marginTop: 12 }}
                onClick={() => {
                  void api
                    .get<{ authorizeUrl: string }>(`/quickbooks/connect?storeId=${storeId}`)
                    .then((r) => window.location.assign(r.authorizeUrl))
                    .catch((err) => toast.error(err.message));
                }}
              >
                Connect QuickBooks
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="row" style={{ padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
      <dt className="muted" style={{ minWidth: 130 }}>{label}</dt>
      <dd style={{ margin: 0, wordBreak: 'break-all' }} className={mono ? 'mono' : undefined}>{value}</dd>
    </div>
  );
}
