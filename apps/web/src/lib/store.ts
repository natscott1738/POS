import { create } from 'zustand';
import type { Permission, Role } from '@pos/shared';
import { api, setSession, onAuthChange, refreshSessionOutcome } from './api.js';
import { clearLocalData, getMeta, setMeta } from './db.js';

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  storeIds: string[];
  permissions: Permission[];
  mustChangePassword: boolean;
  mfaEnabled: boolean;
}

interface AuthState {
  user: SessionUser | null;
  storeId: string | null;
  terminalId: string | null;
  deviceId: string | null;
  /** The open shift on this till, if any; sales are attached to it. */
  shiftId: string | null;
  ready: boolean;
  signIn: (payload: { accessToken: string; csrfToken: string; user: SessionUser }, terminalId?: string) => Promise<void>;
  signOut: () => Promise<void>;
  restore: () => Promise<void>;
  can: (permission: Permission) => boolean;
  setStore: (storeId: string) => void;
  setShift: (shiftId: string | null) => void;
  /** Binds this device to a till. Persisted, so it survives sign-out and reload. */
  setTerminal: (storeId: string, terminalId: string) => Promise<void>;
}

/**
 * The last confirmed signed-in user, kept on the device so a till that reloads
 * while offline stays usable as that cashier. It holds no credentials: the
 * server still authorises everything once the till is back online. It is cleared
 * on sign-out and whenever the server rejects the session, and goes stale with
 * the refresh token's lifetime.
 */
const OFFLINE_SESSION_KEY = 'offlineSession';
const OFFLINE_SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

interface OfflineSession {
  user: SessionUser;
  confirmedAt: number;
}

async function rememberSession(user: SessionUser): Promise<void> {
  await setMeta(OFFLINE_SESSION_KEY, { user, confirmedAt: Date.now() } satisfies OfflineSession);
}

async function rememberedSession(): Promise<SessionUser | null> {
  const saved = await getMeta<OfflineSession | null>(OFFLINE_SESSION_KEY, null);
  if (!saved || Date.now() - saved.confirmedAt > OFFLINE_SESSION_MAX_AGE_MS) return null;
  return saved.user;
}

async function ensureDeviceId(): Promise<string> {
  let deviceId = await getMeta<string | null>('deviceId', null);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await setMeta('deviceId', deviceId);
  }
  return deviceId;
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  storeId: null,
  terminalId: null,
  deviceId: null,
  shiftId: null,
  ready: false,

  async signIn(payload, terminalId) {
    setSession(payload.accessToken, payload.csrfToken);
    const storeId = (await getMeta<string | null>('storeId', null)) ?? payload.user.storeIds[0] ?? null;
    if (storeId) await setMeta('storeId', storeId);
    if (terminalId) await setMeta('terminalId', terminalId);

    // A stable per-install id so the server can attribute offline batches.
    const deviceId = await ensureDeviceId();
    await rememberSession(payload.user);

    set({
      user: payload.user,
      storeId,
      terminalId: terminalId ?? (await getMeta<string | null>('terminalId', null)),
      deviceId,
      ready: true,
    });
  },

  async signOut() {
    await api.post('/auth/logout').catch(() => {});
    setSession(null, null);
    // Cached catalogue is cleared, but the queue is deliberately kept: unsynced
    // sales must survive a sign-out or the shop loses money.
    await clearLocalData();
    set({ user: null, ready: true });
  },

  /** Re-establishes a session from the refresh cookie on page load. */
  async restore() {
    // Offline, or the server is down: carry on as the cashier last signed in on
    // this till. Sales queue as usual, and the session renews once it is back.
    const resumeOffline = async () => {
      const user = await rememberedSession();
      if (!user) {
        set({ ready: true });
        return;
      }
      useNetwork.getState().setServerReachable(false);
      set({
        user,
        storeId: (await getMeta<string | null>('storeId', null)) ?? user.storeIds[0] ?? null,
        terminalId: await getMeta<string | null>('terminalId', null),
        deviceId: await ensureDeviceId(),
        ready: true,
      });
    };

    try {
      const outcome = await refreshSessionOutcome();
      if (outcome === 'unreachable') {
        await resumeOffline();
        return;
      }
      if (outcome === 'rejected') {
        // Expired or revoked: it must not come back the next time the till is offline.
        await setMeta(OFFLINE_SESSION_KEY, null);
        set({ ready: true });
        return;
      }
      const me = await api.get<{ user: SessionUser; terminalId?: string }>('/auth/me');
      const storeId = (await getMeta<string | null>('storeId', null)) ?? me.user.storeIds[0] ?? null;
      await rememberSession(me.user);
      set({
        user: me.user,
        storeId,
        terminalId: me.terminalId ?? (await getMeta<string | null>('terminalId', null)),
        deviceId: await ensureDeviceId(),
        ready: true,
      });
    } catch {
      // The refresh worked but the follow-up did not reach the server.
      await resumeOffline();
    }
  },

  can(permission) {
    return get().user?.permissions.includes(permission) ?? false;
  },

  setStore(storeId) {
    void setMeta('storeId', storeId);
    set({ storeId });
  },

  setShift(shiftId) {
    set({ shiftId });
  },

  async setTerminal(storeId, terminalId) {
    await setMeta('storeId', storeId);
    await setMeta('terminalId', terminalId);
    set({ storeId, terminalId });
  },
}));

// Clear the user when the API reports the session is gone, including the copy
// kept for offline reloads: a session the server ended must not come back.
onAuthChange((authenticated) => {
  if (!authenticated) {
    useAuth.setState({ user: null });
    void setMeta(OFFLINE_SESSION_KEY, null);
  }
});

/* ------------------------------ Connectivity ------------------------------ */

interface NetworkState {
  online: boolean;
  /** Distinct from `online`: the browser may be on a LAN with no server behind it. */
  serverReachable: boolean;
  pending: number;
  syncing: boolean;
  lastSyncAt: number | null;
  setOnline: (online: boolean) => void;
  setServerReachable: (reachable: boolean) => void;
  setPending: (pending: number) => void;
  setSyncing: (syncing: boolean) => void;
  markSynced: () => void;
}

export const useNetwork = create<NetworkState>((set) => ({
  online: navigator.onLine,
  serverReachable: navigator.onLine,
  pending: 0,
  syncing: false,
  lastSyncAt: null,
  setOnline: (online) => set({ online }),
  setServerReachable: (serverReachable) => set({ serverReachable }),
  setPending: (pending) => set({ pending }),
  setSyncing: (syncing) => set({ syncing }),
  markSynced: () => set({ lastSyncAt: Date.now(), syncing: false }),
}));

window.addEventListener('online', () => useNetwork.getState().setOnline(true));
window.addEventListener('offline', () => {
  useNetwork.getState().setOnline(false);
  useNetwork.getState().setServerReachable(false);
});

/* --------------------------------- Toasts --------------------------------- */

export interface Toast {
  id: string;
  kind: 'success' | 'error' | 'info' | 'warning';
  message: string;
}

interface ToastState {
  toasts: Toast[];
  push: (kind: Toast['kind'], message: string) => void;
  dismiss: (id: string) => void;
}

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message) => {
    const id = crypto.randomUUID();
    set((state) => ({ toasts: [...state.toasts, { id, kind, message }] }));
    setTimeout(() => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })), 6000);
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  success: (message: string) => useToasts.getState().push('success', message),
  error: (message: string) => useToasts.getState().push('error', message),
  info: (message: string) => useToasts.getState().push('info', message),
  warning: (message: string) => useToasts.getState().push('warning', message),
};
