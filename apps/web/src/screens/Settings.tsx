import { useEffect, useState } from 'react';
import { formatCents } from '@pos/shared';
import { api } from '../lib/api.js';
import { useAuth, useNetwork, toast } from '../lib/store.js';
import { OFFLINE_CATALOGUE_STALE_AFTER_MS, resetCatalogue, runSync } from '../lib/sync.js';
import { db, listOfflineSales, offlineQueueCounts, retryOfflineSale, type OfflineSaleReview } from '../lib/db.js';
import { readPwaReadiness, type PwaReadiness } from '../lib/pwa.js';
import TillSetup from './TillSetup.js';
import PrinterSettings from './PrinterSettings.js';

export default function Settings() {
  const { user, storeId, terminalId, deviceId, can } = useAuth();
  const network = useNetwork();
  const [queueCounts, setQueueCounts] = useState({ pending: 0, sending: 0, failed: 0 });
  const [offlineSales, setOfflineSales] = useState<OfflineSaleReview[]>([]);
  const [visibleOfflineSalesCount, setVisibleOfflineSalesCount] = useState(30);
  const [catalogueCount, setCatalogueCount] = useState(0);
  const [pwaReadiness, setPwaReadiness] = useState<PwaReadiness | null>(null);
  const [qb, setQb] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    void Promise.all([offlineQueueCounts(), listOfflineSales(), db.variants.count()]).then(
      ([counts, sales, variants]) => {
        setQueueCounts(counts);
        setOfflineSales(sales);
        setCatalogueCount(variants);
      },
    );
  }, [network.lastSyncAt, network.pending, network.syncing]);

  useEffect(() => {
    void readPwaReadiness().then(setPwaReadiness);
  }, []);

  useEffect(() => {
    if (storeId && can('quickbooks:sync')) {
      void api.get<Record<string, unknown>>(`/quickbooks/status?storeId=${storeId}`).then(setQb).catch(() => setQb(null));
    }
  }, [storeId, can]);

  const catalogueIsStale = !network.lastCatalogueSyncAt ||
    Date.now() - network.lastCatalogueSyncAt > OFFLINE_CATALOGUE_STALE_AFTER_MS;
  const catalogueLastSynced = network.lastCatalogueSyncAt
    ? new Date(network.lastCatalogueSyncAt).toLocaleString()
    : 'never on this device';

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

        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Sync</h2>
          <dl style={{ margin: 0, fontSize: 14 }}>
            <Row label="Connection" value={network.serverReachable ? 'Online' : 'Offline'} />
            <Row label="App mode" value={pwaReadiness?.installed ? 'Installed app' : 'Browser tab'} />
            <Row
              label="Offline app shell"
              value={pwaReadiness?.appShellAvailable ? 'Ready on this device' : 'Not cached in this browser'}
            />
            <Row
              label="Local storage protection"
              value={pwaReadiness?.persistentStorage === true
                ? 'Persistent storage granted'
                : pwaReadiness?.persistentStorage === false
                  ? 'Browser may clear local data'
                  : 'Not reported by this browser'}
            />
            <Row label="Cached products" value={`${catalogueCount}`} />
            <Row label="Catalogue last synced" value={catalogueLastSynced} />
            <Row label="Last successful sync" value={network.lastSyncAt ? new Date(network.lastSyncAt).toLocaleString() : 'never'} />
            <Row label="Waiting to upload" value={String(queueCounts.pending)} />
            <Row label="Currently uploading" value={String(queueCounts.sending)} />
            <Row label="Rejected; review needed" value={String(queueCounts.failed)} />
          </dl>
          {catalogueIsStale && (
            <div className="banner warning" style={{ marginTop: 12 }}>
              The catalogue on this till has not synced in the last 24 hours. Reconnect and sync before relying on offline prices or stock.
            </div>
          )}
          {!pwaReadiness?.appShellAvailable && (
            <div className="banner warning" style={{ marginTop: 12 }}>
              This browser has no active offline app cache. Open the production POS while online in a supported browser and let it finish loading before relying on offline checkout.
            </div>
          )}
          <p className="muted" style={{ fontSize: 13, margin: '10px 0 0' }}>
            During an outage, checkout can finalize cash sales only. M‑Pesa, card/PDQ, and customer-account payments require the server.
          </p>
          {queueCounts.failed > 0 && (
            <div className="banner error" style={{ marginTop: 12 }}>
              Rejected sales stay saved on this till and are not retried automatically. Review the reason below before retrying an upload.
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" disabled={network.syncing || !network.serverReachable} onClick={() => void runSync()}>
              {network.syncing ? 'Syncing…' : 'Sync now'}
            </button>
            <button
              className="btn ghost"
              disabled={!network.serverReachable || network.syncing}
              onClick={() => {
                void resetCatalogue().then(() => toast.info('Catalogue refresh requested'));
              }}
            >
              Rebuild catalogue
            </button>
          </div>
          {offlineSales.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div className="row" style={{ marginBottom: 8 }}>
                <strong>Unconfirmed local sales</strong>
                <span className="muted">{offlineSales.length}</span>
              </div>
              <p className="muted" style={{ fontSize: 13 }}>
                Retrying uploads the saved sale again; it does not take payment again. If the cause is unresolved, the server may reject it again.
              </p>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))' }}>
                {offlineSales.slice(0, visibleOfflineSalesCount).map((sale) => (
                  <div className="card" key={sale.clientSaleId} style={{ padding: 12 }}>
                    <div className="row">
                      <strong className="mono" style={{ fontSize: 13 }}>
                        {sale.receiptNumber ?? `OFFLINE-${sale.clientSaleId.slice(0, 8).toUpperCase()}`}
                      </strong>
                      <div className="spacer" />
                      <span className="pill" style={{ color: sale.queueStatus === 'FAILED' ? 'var(--danger)' : 'var(--warning)' }}>
                        {sale.queueStatus === 'FAILED' ? 'Rejected' : sale.queueStatus === 'SENDING' ? 'Uploading' : 'Queued'}
                      </span>
                    </div>
                    <div className="row" style={{ marginTop: 6 }}>
                      <span className="muted" style={{ fontSize: 12 }}>{new Date(sale.soldAt).toLocaleString()}</span>
                      <div className="spacer" />
                      <strong className="mono">{formatCents(sale.total)}</strong>
                    </div>
                    {sale.lastError && <div className="banner error" style={{ marginTop: 8, marginBottom: 0 }}>{sale.lastError}</div>}
                    {sale.queueStatus === 'FAILED' && (
                      <button
                        className="btn ghost"
                        style={{ marginTop: 8 }}
                        disabled={!network.serverReachable || network.syncing}
                        onClick={async () => {
                          const retried = await retryOfflineSale(sale.clientSaleId);
                          if (!retried) {
                            toast.warning('This sale is no longer waiting for retry. Refresh the page and check its status.');
                            return;
                          }
                          const [counts, remaining] = await Promise.all([offlineQueueCounts(), listOfflineSales()]);
                          setQueueCounts(counts);
                          setOfflineSales(remaining);
                          await runSync();
                          const [updatedCounts, updatedSales] = await Promise.all([offlineQueueCounts(), listOfflineSales()]);
                          setQueueCounts(updatedCounts);
                          setOfflineSales(updatedSales);
                        }}
                      >
                        Retry upload
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {offlineSales.length > visibleOfflineSalesCount && (
                <button
                  className="btn ghost"
                  style={{ marginTop: 8 }}
                  onClick={() => setVisibleOfflineSalesCount((count) => count + 30)}
                >
                  Show 30 older sales
                </button>
              )}
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
