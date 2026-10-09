import { useEffect, useRef, useState } from 'react';
import { formatCents, type TenderInput } from '@pos/shared';
import { useCart, type CartLine } from '../lib/cart.js';
import { searchLocal, findByBarcode, enqueue, db, getMeta, parkedCount, type CachedVariant } from '../lib/db.js';
import { api, ApiError } from '../lib/api.js';
import { useAuth, useNetwork, toast } from '../lib/store.js';
import { runSync } from '../lib/sync.js';
import { Modal } from '../components/Modal.js';
import { Field } from '../components/ui.js';
import { Money, formatQuantity } from '../components/Money.js';
import { PaymentPanel } from './Payment.js';
import TillSetup from './TillSetup.js';
import { ShiftBar } from './Shifts.js';
import { QuickKeys } from './QuickKeys.js';
import { ParkedSalesModal, ParkDialog } from './ParkedSales.js';

export default function Checkout() {
  const cart = useCart();
  const { user, storeId, terminalId } = useAuth();
  const online = useNetwork((s) => s.serverReachable);
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<CachedVariant[]>([]);
  const [paying, setPaying] = useState(false);
  const [parking, setParking] = useState(false);
  const [viewingParked, setViewingParked] = useState(false);
  const [heldCount, setHeldCount] = useState(0);
  /**
   * Typing "3*" before scanning sells three of the next item. Standard on retail
   * tills and far faster than scanning the same thing three times.
   */
  const [multiplier, setMultiplier] = useState<number | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  const totals = cart.totals();

  useEffect(() => {
    scanRef.current?.focus();
  }, []);

  const refreshHeld = () => void parkedCount().then(setHeldCount);
  useEffect(refreshHeld, []);

  /**
   * Shop-floor shortcuts. A cashier's hands are on the scanner and the keyboard,
   * not the mouse, so the common actions need keys.
   */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // Never hijack typing in a field other than the scan box.
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' && target !== scanRef.current;
      if (typing || target?.tagName === 'TEXTAREA') return;

      if (event.key === 'F2') { event.preventDefault(); setPaying(true); }
      if (event.key === 'F3') { event.preventDefault(); setParking(true); }
      if (event.key === 'F4') { event.preventDefault(); setViewingParked(true); }
      if (event.key === 'F8') { event.preventDefault(); scanRef.current?.focus(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Apply this store's VAT-inclusive setting and cash rounding to the basket.
  useEffect(() => {
    void getMeta<{ pricesIncludeTax?: boolean; cashRoundingIncrement?: number }>('storeProfile', {}).then(
      (profile) => {
        cart.setStoreConfig(profile.pricesIncludeTax ?? true, profile.cashRoundingIncrement ?? 0);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  useEffect(() => {
    let cancelled = false;
    void searchLocal(term).then((rows) => {
      if (!cancelled) setResults(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [term]);

  /**
   * A hardware barcode scanner types the code then presses Enter. An exact
   * barcode match adds straight to the basket so scanning never needs a tap.
   */
  async function handleScan(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const code = term.trim();
    if (!code) return;

    // "3*" or "3x" sets a quantity for the next scan rather than searching.
    const quantityEntry = /^(\d{1,3})\s*[*xX]$/.exec(code);
    if (quantityEntry?.[1]) {
      setMultiplier(Number(quantityEntry[1]));
      setTerm('');
      scanRef.current?.focus();
      return;
    }

    const quantity = (multiplier ?? 1) * 1000;

    const exact = await findByBarcode(code);
    if (exact) {
      cart.addVariant(exact, quantity);
      setTerm('');
      setMultiplier(null);
      scanRef.current?.focus();
      return;
    }

    const matches = await searchLocal(code);
    if (matches.length === 1 && matches[0]) {
      cart.addVariant(matches[0], quantity);
      setTerm('');
      setMultiplier(null);
    } else if (matches.length === 0) {
      toast.warning(`Nothing found for "${code}"`);
    }
    scanRef.current?.focus();
  }

  function pick(variant: CachedVariant): void {
    cart.addVariant(variant, (multiplier ?? 1) * 1000);
    setTerm('');
    setMultiplier(null);
    scanRef.current?.focus();
  }

  // Without a till, a sale has no store, no receipt sequence and no shift to
  // belong to. Ask once, here, instead of leaving the pay button mysteriously grey.
  if (!storeId || !terminalId) {
    return <TillSetup />;
  }

  return (
    <div className="till">
      <div className="till-left">
        <ShiftBar storeId={storeId} terminalId={terminalId} />
        <form className="scan-row" onSubmit={(e) => void handleScan(e)}>
          <input
            ref={scanRef}
            className="input mono"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder={multiplier ? `${multiplier} x — now scan the item` : 'Scan barcode, or search by name / SKU'}
            autoComplete="off"
            spellCheck={false}
            aria-label="Scan or search"
          />
          {multiplier && (
            <button
              className="btn"
              type="button"
              onClick={() => { setMultiplier(null); scanRef.current?.focus(); }}
              title="Clear the quantity"
            >
              {multiplier}× ✕
            </button>
          )}
          <button className="btn primary" type="submit">Add</button>
        </form>

        <QuickKeys onPick={() => scanRef.current?.focus()} />

        <div className="card results" style={{ padding: 0 }}>
          {results.length === 0 ? (
            <p className="muted" style={{ padding: 16 }}>
              {term ? 'No matching products.' : 'Scan an item to begin.'}
            </p>
          ) : (
            results.map((variant) => (
              <div key={variant.variantId} className="result-item" onClick={() => pick(variant)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{variant.name}</div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {variant.sku}
                    {variant.variantLabel ? ` · ${variant.variantLabel}` : ''}
                    {variant.trackInventory ? ` · ${formatQuantity(variant.quantityOnHand, variant.unitOfMeasure)} in stock` : ''}
                  </div>
                </div>
                <div className="mono" style={{ fontWeight: 600 }}>{formatCents(variant.unitPrice)}</div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="basket">
        <div className="row" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
          <strong>Basket</strong>
          <span className="muted">({cart.lines.length})</span>
          <div className="spacer" />
          {heldCount > 0 && (
            <button className="btn ghost" onClick={() => setViewingParked(true)} title="F4">
              Held · {heldCount}
            </button>
          )}
          {cart.lines.length > 0 && (
            <>
              <button className="btn ghost" onClick={() => setParking(true)} title="F3">Hold</button>
              <button className="btn ghost" onClick={() => cart.clear()}>Clear</button>
            </>
          )}
        </div>

        <div className="basket-lines">
          {cart.lines.length === 0 ? (
            <p className="muted" style={{ padding: 16, textAlign: 'center' }}>Empty</p>
          ) : (
            cart.lines.map((line) => <BasketLine key={line.clientLineId} line={line} />)
          )}
        </div>

        <div className="basket-totals">
          <div className="total-row">
            <span className="muted">Subtotal</span>
            <Money cents={totals.grossSubtotal} />
          </div>
          {totals.discountTotal > 0 && (
            <div className="total-row" style={{ color: 'var(--success)' }}>
              <span>Discount</span>
              <span className="mono">-{formatCents(totals.discountTotal)}</span>
            </div>
          )}
          <div className="total-row">
            <span className="muted">VAT</span>
            <Money cents={totals.taxTotal} />
          </div>
          {totals.roundingAdjustment !== 0 && (
            <div className="total-row">
              <span className="muted">Rounding</span>
              <Money cents={totals.roundingAdjustment} />
            </div>
          )}
          <div className="total-row grand">
            <span>Total</span>
            <Money cents={totals.total} />
          </div>

          {!online && (
            <div className="banner warning" style={{ marginTop: 12, marginBottom: 0 }}>
              Offline — sales are queued and will sync automatically.
            </div>
          )}

          <button
            className="btn success block lg"
            style={{ marginTop: 12 }}
            disabled={cart.lines.length === 0 || !storeId || !terminalId}
            onClick={() => setPaying(true)}
          >
            Take payment · {formatCents(totals.total)}
          </button>
          <div className="muted" style={{ fontSize: 11, textAlign: 'center', marginTop: 6 }}>
            F2 pay · F3 hold · F4 held baskets · F8 back to scanner · type “3*” then scan for 3
          </div>
        </div>
      </div>

      {parking && <ParkDialog onClose={() => setParking(false)} onParked={refreshHeld} />}
      {viewingParked && (
        <ParkedSalesModal
          onClose={() => setViewingParked(false)}
          onResumed={() => { refreshHeld(); scanRef.current?.focus(); }}
        />
      )}

      {paying && storeId && terminalId && user && (
        <PaymentPanel
          storeId={storeId}
          terminalId={terminalId}
          onClose={() => setPaying(false)}
          onComplete={() => {
            setPaying(false);
            refreshHeld();
            scanRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function BasketLine({ line }: { line: CartLine }) {
  const cart = useCart();
  const [editing, setEditing] = useState(false);
  const step = line.variant.unitOfMeasure === 'EACH' || line.variant.unitOfMeasure === 'PACK' ? 1000 : 250;
  const lineTotal = Math.round((line.unitPrice * line.quantity) / 1000);

  return (
    <div className="basket-line">
      <div className="row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{line.variant.name}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {line.variant.sku}
            {line.variant.variantLabel ? ` · ${line.variant.variantLabel}` : ''}
          </div>
        </div>
        <button className="btn ghost" onClick={() => cart.removeLine(line.clientLineId)} aria-label="Remove">✕</button>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <div className="qty-control">
          <button onClick={() => cart.setQuantity(line.clientLineId, line.quantity - step)}>−</button>
          <span className="mono" style={{ minWidth: 46, textAlign: 'center' }}>
            {formatQuantity(line.quantity, line.variant.unitOfMeasure)}
          </span>
          <button onClick={() => cart.setQuantity(line.clientLineId, line.quantity + step)}>+</button>
        </div>
        <div className="spacer" />
        <button className="btn ghost" style={{ minHeight: 30, padding: '4px 8px', fontSize: 12 }} onClick={() => setEditing(true)}>
          Discount
        </button>
        <strong className="mono">{formatCents(lineTotal)}</strong>
      </div>
      {line.discount && (
        <div className="muted" style={{ fontSize: 12, marginTop: 4, color: 'var(--success)' }}>
          {line.discount.type === 'PERCENTAGE'
            ? `${line.discount.value / 100}% off`
            : `${formatCents(line.discount.value)} off`}
          {line.discount.reason ? ` — ${line.discount.reason}` : ''}
        </div>
      )}
      {editing && <DiscountModal line={line} onClose={() => setEditing(false)} />}
    </div>
  );
}

function DiscountModal({ line, onClose }: { line: CartLine; onClose: () => void }) {
  const cart = useCart();
  const [type, setType] = useState<'PERCENTAGE' | 'FIXED_AMOUNT'>('PERCENTAGE');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');

  function apply(): void {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      toast.error('Enter a discount amount');
      return;
    }
    cart.setLineDiscount(line.clientLineId, {
      type,
      // Percentages are held in basis points; amounts in cents.
      value: type === 'PERCENTAGE' ? Math.round(numeric * 100) : Math.round(numeric * 100),
      reason: reason || null,
      promotionId: null,
    });
    onClose();
  }

  return (
    <Modal title={`Discount — ${line.variant.name}`} onClose={onClose}>
      <div className="tabs">
        <button className={type === 'PERCENTAGE' ? 'active' : ''} onClick={() => setType('PERCENTAGE')}>Percent</button>
        <button className={type === 'FIXED_AMOUNT' ? 'active' : ''} onClick={() => setType('FIXED_AMOUNT')}>Amount</button>
      </div>
      <Field label="{type === 'PERCENTAGE' ? 'Percentage off' : 'Amount off (KES)'}">
        <input
          className="input mono"
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))}
          inputMode="decimal"
          autoFocus
        />
      </Field>
      <Field label="Reason">
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Damaged packaging" />
      </Field>
      <div className="row">
        {line.discount && (
          <button className="btn danger" onClick={() => { cart.setLineDiscount(line.clientLineId, null); onClose(); }}>
            Remove
          </button>
        )}
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={apply}>Apply</button>
      </div>
    </Modal>
  );
}
