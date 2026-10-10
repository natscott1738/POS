import { useEffect, useState } from 'react';
import { useApi } from '../lib/useApi.js';
import { useAuth, toast } from '../lib/store.js';
import { Field } from '../components/ui.js';
import { setMeta } from '../lib/db.js';
import { resetCatalogue, runSync } from '../lib/sync.js';

interface Context {
  stores: Array<{
    id: string;
    code: string;
    name: string;
    currency: string;
    pricesIncludeTax: boolean;
    cashRoundingIncrement: number;
    receiptHeader: string | null;
    receiptFooter: string | null;
  }>;
  terminals: Array<{ id: string; storeId: string; code: string; name: string; receiptPrefix: string }>;
}

/**
 * Binds this device to a store and till.
 *
 * Signing in with an email address says who you are, not where you are standing,
 * so a till cannot take payment until this is answered. The choice is stored on
 * the device and survives sign-out, which is what lets cashiers then sign in with
 * just a staff code and PIN.
 */
export default function TillSetup({ onDone }: { onDone?: () => void }) {
  const { storeId, terminalId, setTerminal } = useAuth();
  const { data, loading } = useApi<Context>('/auth/context');
  const [store, setStore] = useState(storeId ?? '');
  const [terminal, setTerminalChoice] = useState(terminalId ?? '');

  useEffect(() => {
    if (!data) return;
    // One store, one till: choose it rather than making someone confirm the obvious.
    if (!store && data.stores.length === 1 && data.stores[0]) setStore(data.stores[0].id);
  }, [data, store]);

  const available = data?.terminals.filter((t) => t.storeId === store) ?? [];

  useEffect(() => {
    if (!terminal && available.length === 1 && available[0]) setTerminalChoice(available[0].id);
  }, [available, terminal]);

  async function save(): Promise<void> {
    if (!store || !terminal) return;

    // Cached so receipts and pricing are correct even with no connection.
    const chosen = data?.stores.find((s) => s.id === store);
    if (chosen) await setMeta('storeProfile', chosen);

    const previousStore = storeId;
    await setTerminal(store, terminal);
    toast.success('This device is now set up for that till');

    // Sync now rather than on the next cycle, so the catalogue is on the device
    // (and the till registered) before the connection can drop. Stock levels
    // belong to a store, so a till moved to another store starts from a fresh
    // snapshot of that store.
    if (previousStore !== store) void resetCatalogue();
    else void runSync();
    onDone?.();
  }

  if (loading) return <p className="muted">Loading…</p>;

  const noStores = (data?.stores.length ?? 0) === 0;
  const noTerminals = Boolean(store) && available.length === 0;

  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>Set up this till</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        Choose where this device is. It is remembered, so you only do this once per till.
      </p>

      {noStores ? (
        <div className="banner warning">
          You are not assigned to any store. An administrator needs to assign you before you can sell.
        </div>
      ) : (
        <>
          <Field label="Store">
            <select className="input" value={store} onChange={(e) => { setStore(e.target.value); setTerminalChoice(''); }}>
              <option value="">Choose a store…</option>
              {data?.stores.map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.code})</option>
              ))}
            </select>
          </Field>

          <Field label="Till" hint={noTerminals ? undefined : 'Receipt numbers are issued per till.'}>
            <select
              className="input"
              value={terminal}
              onChange={(e) => setTerminalChoice(e.target.value)}
              disabled={!store || available.length === 0}
            >
              <option value="">{store ? 'Choose a till…' : 'Choose a store first'}</option>
              {available.map((t) => (
                <option key={t.id} value={t.id}>{t.name} ({t.code} · {t.receiptPrefix})</option>
              ))}
            </select>
          </Field>

          {noTerminals && (
            <div className="banner warning">
              That store has no tills yet. Add one under <strong>Admin → Terminals</strong>.
            </div>
          )}

          <button className="btn primary block lg" disabled={!store || !terminal} onClick={() => void save()}>
            Use this till
          </button>
        </>
      )}
    </div>
  );
}
