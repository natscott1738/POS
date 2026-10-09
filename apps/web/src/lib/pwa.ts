import { registerSW } from 'virtual:pwa-register';
import { useCart } from './cart.js';

/**
 * Service worker lifecycle.
 *
 * Updates are never applied automatically. Swapping the application out from
 * under a cashier mid-sale would lose the basket, so a new version waits until
 * the till is idle and the person running it agrees.
 */

type UpdateListener = (available: boolean) => void;
let listeners = new Set<UpdateListener>();
let applyUpdate: ((reload?: boolean) => Promise<void>) | null = null;
let offlineReady = false;

export function initPwa(): void {
  // Vite injects this only in a production build; dev has no service worker.
  if (!('serviceWorker' in navigator)) return;

  applyUpdate = registerSW({
    immediate: true,
    onNeedRefresh() {
      for (const listener of listeners) listener(true);
      // Reload as soon as the till is idle. Waiting for someone to click a
      // prompt means a till can run old code for weeks without anyone noticing.
      scheduleIdleReload();
    },
    onOfflineReady() {
      offlineReady = true;
    },
    onRegistered(registration) {
      // Check hourly. A till is often left open for days, and a deploy should
      // reach it without someone remembering to refresh.
      if (registration) {
        setInterval(() => void registration.update().catch(() => {}), 60 * 60 * 1000);
      }
    },
    onRegisterError(error) {
      console.error('service worker registration failed', error);
    },
  });
}

let idleTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Reloads once nothing is in progress. A basket mid-sale is the one thing worth
 * blocking an update for, so this waits for it to clear rather than discarding it.
 */
function scheduleIdleReload(): void {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    if (useCart.getState().lines.length > 0) return;
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
    window.location.reload();
  }, 5000);
}

export function onUpdateAvailable(listener: UpdateListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isOfflineReady(): boolean {
  return offlineReady;
}

/**
 * Applies a waiting update. Refuses while a basket is open: finishing the sale
 * in front of you matters more than running the newest build.
 */
export async function installUpdate(): Promise<{ applied: boolean; reason?: string }> {
  if (!applyUpdate) return { applied: false, reason: 'No update is waiting' };
  if (useCart.getState().lines.length > 0) {
    return { applied: false, reason: 'Finish or clear the current sale first' };
  }
  await applyUpdate(true);
  return { applied: true };
}
