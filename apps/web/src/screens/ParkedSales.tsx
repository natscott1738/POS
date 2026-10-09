import { useEffect, useState } from 'react';
import { formatCents } from '@pos/shared';
import { listParked, type ParkedSale } from '../lib/db.js';
import { useCart } from '../lib/cart.js';
import { Modal } from '../components/Modal.js';
import { toast } from '../lib/store.js';
import { Empty } from '../components/ui.js';

/** Baskets set aside so the till could serve someone else. */
export function ParkedSalesModal({ onClose, onResumed }: { onClose: () => void; onResumed: () => void }) {
  const cart = useCart();
  const [parked, setParked] = useState<ParkedSale[]>([]);

  useEffect(() => {
    void listParked().then(setParked);
  }, []);

  return (
    <Modal title="Held baskets" onClose={onClose} wide>
      {parked.length === 0 ? (
        <Empty message="Nothing is on hold." />
      ) : (
        <table>
          <thead>
            <tr><th>Reference</th><th>Held</th><th>Items</th><th className="num">Total</th><th /></tr>
          </thead>
          <tbody>
            {parked.map((basket) => (
              <tr key={basket.parkedId}>
                <td>
                  <strong>{basket.label}</strong>
                  {basket.customerName && (
                    <div className="muted" style={{ fontSize: 12 }}>{basket.customerName}</div>
                  )}
                </td>
                <td className="muted" style={{ fontSize: 13 }}>
                  {new Date(basket.parkedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                </td>
                <td className="muted">{basket.lines.length}</td>
                <td className="num">{formatCents(basket.total)}</td>
                <td className="right">
                  <button
                    className="btn primary"
                    style={{ minHeight: 32, padding: '4px 12px', fontSize: 13 }}
                    onClick={async () => {
                      const resumed = await cart.resume(basket.parkedId);
                      if (resumed) {
                        toast.success(`Resumed ${basket.label}`);
                        onResumed();
                        onClose();
                      }
                    }}
                  >
                    Resume
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

/** Asks for a reference so the right basket can be found again. */
export function ParkDialog({ onClose, onParked }: { onClose: () => void; onParked: () => void }) {
  const cart = useCart();
  const [label, setLabel] = useState('');
  const total = cart.totals().total;

  // Default to something recognisable so a cashier in a hurry can just confirm.
  useEffect(() => {
    setLabel(cart.customerName ?? new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
  }, [cart.customerName]);

  async function park(): Promise<void> {
    await cart.park(label.trim() || 'Held basket');
    toast.success('Basket held');
    onParked();
    onClose();
  }

  return (
    <Modal title="Hold this basket" onClose={onClose}>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        {cart.lines.length} item(s), {formatCents(total)}. Nothing is charged, and
        the basket stays on this till until you resume it.
      </p>
      <div className="field">
        <label className="label" htmlFor="park-label">Reference</label>
        <input
          id="park-label"
          className="input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Customer name, or anything you will recognise"
          autoFocus
          onKeyDown={(e) => e.key === 'Enter' && void park()}
        />
      </div>
      <div className="row">
        <div className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => void park()}>Hold basket</button>
      </div>
    </Modal>
  );
}
