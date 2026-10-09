import type { ApiErrorBody, ErrorCode } from '@pos/shared';

/**
 * API client.
 *
 * The access token is held in memory only - never localStorage - so an XSS bug
 * cannot exfiltrate a long-lived credential. Persistence comes from the httpOnly
 * refresh cookie, which script cannot read at all.
 */

const BASE = '/api/v1';

let accessToken: string | null = null;
let csrfToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;

/**
 * Reads the CSRF token from its cookie.
 *
 * The cookie is deliberately not httpOnly so the SPA can echo it in a header.
 * Reading it here matters because the in-memory copy is lost on every page
 * reload — without this, a till that refreshes (a crash, a stray F5, a power
 * blip) could not renew its session and silently dropped the cashier back to
 * the sign-in screen, including when offline.
 */
function csrfFromCookie(): string | null {
  for (const part of document.cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === '__Host-pos_csrf' || name === 'pos_csrf') {
      return decodeURIComponent(rest.join('=')) || null;
    }
  }
  return null;
}

function currentCsrf(): string | null {
  return csrfToken ?? csrfFromCookie();
}

type Listener = (authenticated: boolean) => void;
const listeners = new Set<Listener>();

export function onAuthChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(authenticated: boolean): void {
  for (const listener of listeners) listener(authenticated);
}

export function setSession(token: string | null, csrf: string | null): void {
  accessToken = token;
  csrfToken = csrf;
  announce(Boolean(token));
}

export function currentToken(): string | null {
  return accessToken;
}

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | 'NETWORK',
    message: string,
    readonly status: number,
    readonly details?: Array<{ path: string; message: string }>,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Set for money-moving calls so a retry cannot double-apply. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Internal: prevents an infinite refresh loop. */
  retryOnUnauthorised?: boolean;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { retryOnUnauthorised = true } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const csrf = currentCsrf();
  if (csrf) headers['X-CSRF-Token'] = csrf;

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      // Needed for the refresh cookie to travel.
      credentials: 'same-origin',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch {
    // Distinguish "offline" from "server said no": the till reacts differently.
    throw new ApiError('NETWORK', 'Cannot reach the server', 0);
  }

  // One transparent refresh attempt, then give up and surface the failure.
  if (response.status === 401 && retryOnUnauthorised && path !== '/auth/refresh') {
    const refreshed = await refreshSession();
    if (refreshed) {
      return request<T>(path, { ...options, retryOnUnauthorised: false });
    }
    setSession(null, null);
  }

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    if (!response.ok) throw new ApiError('INTERNAL', `Request failed (${response.status})`, response.status);
    return (await response.blob()) as T;
  }

  const payload = (await response.json()) as unknown;

  if (!response.ok) {
    const body = payload as ApiErrorBody;
    throw new ApiError(
      body.error?.code ?? 'INTERNAL',
      body.error?.message ?? 'Request failed',
      response.status,
      body.error?.details,
      body.error?.requestId,
    );
  }

  return payload as T;
}

/** Rotates the session. Concurrent callers share one in-flight refresh. */
export async function refreshSession(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      // Falls back to the cookie, which is what survives a reload.
      const csrf = currentCsrf();
      if (csrf) headers['X-CSRF-Token'] = csrf;

      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers,
        credentials: 'same-origin',
      });
      if (!response.ok) return false;

      const body = (await response.json()) as { accessToken: string; csrfToken: string };
      setSession(body.accessToken, body.csrfToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/** Downloads a report; used for CSV and PDF export buttons. */
export async function download(path: string, filename: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const response = await fetch(`${BASE}${path}`, { headers, credentials: 'same-origin' });
  if (!response.ok) throw new ApiError('INTERNAL', 'Export failed', response.status);

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Release the object URL once the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, signal ? { signal } : {}),
  post: <T>(path: string, body?: unknown, idempotencyKey?: string) =>
    request<T>(path, { method: 'POST', body, ...(idempotencyKey ? { idempotencyKey } : {}) }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
