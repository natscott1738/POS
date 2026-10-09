import { useEffect, useState } from 'react';
import { formatCents } from '@pos/shared';
import { db, getMeta, setMeta, type CachedVariant } from '../lib/db.js';
import { useCart } from '../lib/cart.js';
import { Modal } from '../components/Modal.js';
import { toast } from '../lib/store.js';

/**
 * Quick-select tiles.
 *
 * Plenty of what a Kenyan shop sells has no barcode — loose produce, bread,
 * airtime, a cup of tea. Typing a name into the search box for every one of
 * those is far too slow at a busy counter, so the dozen or so fastest-moving
 * items get a tile that adds them in one tap.
 *
 * Which items appear is chosen per till and stored locally, because the mix
 * differs between a front counter and a butchery scale.
 */

const MAX_KEYS = 12;

export function QuickKeys({ onPick }: { onPick: () => void }) {
  const cart = useCart();
  const [keys, setKeys] = useState<CachedVariant[]>([]);
  const [editing, setEditing] = useState(false);

  async function load(): Promise<void> {
    const ids = await getMeta<string[]>('quickKeys', []);
    if (ids.length === 0) {
      setKeys([]);
      return;
    }
    const rows = await Promise.all(ids.map((id) => db.variants.get(id)));
    // A variant that has since been removed from the catalogue just disappears.
    setKeys(rows.filter((r): r is CachedVariant => Boolean(r)));
  }

  useEffect(() => {
    void load();
  }, []);

  if (keys.length === 0 && !editing) {
    return (
      <div className="card" style={{ padding: 10 }}>
        <div className="row">
          <span className="muted" style={{ fontSize: 13 }}>
            No quick keys yet — set up tiles for items with no barcode.
          </span>
          <div className="spacer" />
          <button className="btn ghost" onClick={() => setEditing(true)}>Set up</button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="quick-keys">
        {keys.map((variant) => (
          <button
            key={variant.variantId}
            className="quick-key"
            onClick={() => {
              cart.addVariant(variant);
              onPick();
            }}
          >
            <span className="quick-key-name">{variant.name}</span>
            {variant.variantLabel && <span className="quick-key-label">{variant.variantLabel}</span>}
            <span className="quick-key-price">{formatCents(variant.unitPrice)}</span>
          </button>
        ))}
        <button className="quick-key quick-key-edit" onClick={() => setEditing(true)} aria-label="Edit quick keys">
          ✎
        </button>
      </div>

      {editing && (
        <EditQuickKeys
          current={keys.map((k) => k.variantId)}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); void load(); }}
        />
      )}
    </>
  );
}

function EditQuickKeys({
  current,
  onClose,
  onSaved,
}: {
  current: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(current);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<CachedVariant[]>([]);

  useEffect(() => {
    let cancelled = false;
    const needle = search.trim().toLowerCase();
    void db.variants
      .limit(400)
      .toArray()
      .then((rows) => {
        if (cancelled) return;
        const filtered = needle
          ? rows.filter((r) => r.name.toLowerCase().includes(needle) || r.sku.toLowerCase().includes(needle))
          : rows;
        setResults(filtered.slice(0, 60));
      });
    return () => {
      cancelled = true;
    };
  }, [search]);

  function toggle(variantId: string): void {
    setSelected((list) => {
      if (list.includes(variantId)) return list.filter((id) => id !== variantId);
      if (list.length >= MAX_KEYS) {
        toast.warning(`Up to ${MAX_KEYS} quick keys — remove one first.`);
        return list;
      }
      return [...list, variantId];
    });
  }

  return (
    <Modal title="Quick keys" onClose={onClose} wide>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        Pick up to {MAX_KEYS} items to show as tiles. Best used for things with no
        barcode: loose produce, bread, airtime.
      </p>
      <input
        className="input"
        placeholder="Search the catalogue"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        autoFocus
        style={{ marginBottom: 12 }}
      />
      <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
        {results.length === 0 ? (
          <p className="muted" style={{ padding: 16 }}>
            Nothing found. The catalogue syncs from the server — check Settings if it looks empty.
          </p>
        ) : (
          results.map((variant) => (
            <label key={variant.variantId} className="result-item" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={selected.includes(variant.variantId)}
                onChange={() => toggle(variant.variantId)}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{variant.name}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {variant.sku}{variant.barcode ? ` · ${variant.barcode}` : ' · no barcode'}
                </div>
              </div>
              <span className="mono">{formatCents(variant.unitPrice)}</span>
            </label>
          ))
        )}
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <span className="muted" style={{ fontSize: 13 }}>{selected.length} of {MAX_KEYS} selected</span>
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          onClick={() => {
            void setMeta('quickKeys', selected).then(onSaved);
          }}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}
