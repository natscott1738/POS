import { useEffect, useState } from 'react';
import { onUpdateAvailable, installUpdate } from '../lib/pwa.js';
import { toast } from '../lib/store.js';

/** Offers a waiting app update; never applies one mid-sale. */
export function UpdatePrompt() {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => onUpdateAvailable(setAvailable), []);

  if (!available) return null;

  return (
    <div
      className="card"
      style={{ position: 'fixed', bottom: 16, left: 16, zIndex: 90, maxWidth: 320, boxShadow: '0 8px 30px rgba(0,0,0,.5)' }}
    >
      <strong style={{ fontSize: 14 }}>Update ready</strong>
      <p className="muted" style={{ fontSize: 13, margin: '6px 0 10px' }}>
        A new version is installed. It starts automatically as soon as the basket
        is empty — finish the sale in front of you first.
      </p>
      <div className="row">
        <button className="btn ghost" onClick={() => setAvailable(false)}>Later</button>
        <div className="spacer" />
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const result = await installUpdate();
            if (!result.applied) {
              toast.warning(result.reason ?? 'Could not update now');
              setBusy(false);
            }
          }}
        >
          Restart now
        </button>
      </div>
    </div>
  );
}
