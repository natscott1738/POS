import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { qbConnections } from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { decryptSecret, encryptSecret } from '../../core/crypto.js';
import { integrationUnavailable, notFound, AppError } from '../../core/errors.js';
import { ERROR_CODES } from '@pos/shared';

const AUTH_BASE = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

export function apiBase(environment: string): string {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.QB_CLIENT_ID ?? '',
    // accounting scope only: we never request payroll or payments data.
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: env.QB_REDIRECT_URI ?? '',
    response_type: 'code',
    state,
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
}

export async function exchangeCode(code: string): Promise<TokenSet> {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.QB_REDIRECT_URI ?? '',
  });
}

export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const basic = Buffer.from(`${env.QB_CLIENT_ID}:${env.QB_CLIENT_SECRET}`).toString('base64');

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // The refresh token is dead; a human must reconnect. Never retried silently.
    throw new AppError(502, ERROR_CODES.INTEGRATION_UNAVAILABLE, 'QuickBooks rejected the token request', {
      context: { status: response.status, detail: detail.slice(0, 300) },
    });
  }

  const json = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    x_refresh_token_expires_in: number;
  };

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    refreshExpiresIn: json.x_refresh_token_expires_in,
  };
}

export interface ActiveConnection {
  id: string;
  storeId: string;
  realmId: string;
  environment: string;
  accessToken: string;
}

/**
 * Returns a usable connection, refreshing the access token when it is close to
 * expiry. QuickBooks rotates the refresh token on every refresh, so the new one
 * is persisted immediately - losing it means a manual reconnect.
 */
export async function activeConnection(storeId: string): Promise<ActiveConnection> {
  const [connection] = await db
    .select()
    .from(qbConnections)
    .where(eq(qbConnections.storeId, storeId))
    .limit(1);

  if (!connection || !connection.isActive) throw notFound('QuickBooks connection');

  // An old sandbox OAuth connection must never be used just because the process
  // has been switched to production (or vice versa). Reconnect the intended
  // company before any reads or writes continue.
  if (connection.environment !== env.QB_ENVIRONMENT) {
    throw integrationUnavailable('QuickBooks (connection environment mismatch)');
  }

  if (connection.refreshTokenExpiresAt.getTime() < Date.now()) {
    await db
      .update(qbConnections)
      .set({ isActive: false, lastSyncError: 'Refresh token expired; reconnect required' })
      .where(eq(qbConnections.id, connection.id));
    throw integrationUnavailable('QuickBooks (reconnection required)');
  }

  const needsRefresh = connection.accessTokenExpiresAt.getTime() < Date.now() + 120_000;
  if (!needsRefresh) {
    return {
      id: connection.id,
      storeId: connection.storeId,
      realmId: connection.realmId,
      environment: connection.environment,
      accessToken: decryptSecret(connection.accessTokenEncrypted, connection.storeId),
    };
  }

  const refreshed = await refreshTokens(decryptSecret(connection.refreshTokenEncrypted, connection.storeId));

  await db
    .update(qbConnections)
    .set({
      accessTokenEncrypted: encryptSecret(refreshed.accessToken, connection.storeId),
      refreshTokenEncrypted: encryptSecret(refreshed.refreshToken, connection.storeId),
      accessTokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
      refreshTokenExpiresAt: new Date(Date.now() + refreshed.refreshExpiresIn * 1000),
      updatedAt: new Date(),
    })
    .where(eq(qbConnections.id, connection.id));

  return {
    id: connection.id,
    storeId: connection.storeId,
    realmId: connection.realmId,
    environment: connection.environment,
    accessToken: refreshed.accessToken,
  };
}

export class QbApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    /** Permanent errors (validation, bad mapping) must not be retried forever. */
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'QbApiError';
  }
}

/** Issues a request against the QuickBooks Accounting API. */
export async function qbRequest<T>(
  connection: ActiveConnection,
  path: string,
  options: { method?: string; body?: unknown; requestId?: string } = {},
): Promise<T> {
  const url = new URL(`/v3/company/${connection.realmId}${path}`, apiBase(connection.environment));
  url.searchParams.set('minorversion', '70');
  // QuickBooks dedupes writes carrying the same requestid, which is what makes a
  // retried POST safe after a timeout.
  if (options.requestId) url.searchParams.set('requestid', options.requestId);

  const response = await fetch(url.toString(), {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  const json = text ? safeJson(text) : {};

  if (!response.ok) {
    const fault = (json as { Fault?: { Error?: Array<{ Message?: string; Detail?: string; code?: string }> } }).Fault;
    const first = fault?.Error?.[0];
    const message = first?.Detail ?? first?.Message ?? `QuickBooks returned ${response.status}`;
    // 4xx other than 429 means the request itself is wrong; retrying cannot help.
    const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    throw new QbApiError(message.slice(0, 500), response.status, first?.code, permanent);
  }

  return json as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export async function revokeConnection(storeId: string): Promise<void> {
  const [connection] = await db.select().from(qbConnections).where(eq(qbConnections.storeId, storeId)).limit(1);
  if (!connection) return;

  const basic = Buffer.from(`${env.QB_CLIENT_ID}:${env.QB_CLIENT_SECRET}`).toString('base64');
  await fetch(REVOKE_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: decryptSecret(connection.refreshTokenEncrypted, storeId) }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {
    // Revocation is best-effort; the local record is deactivated regardless.
  });

  await db
    .update(qbConnections)
    .set({ isActive: false, disconnectedAt: new Date(), updatedAt: new Date() })
    .where(eq(qbConnections.id, connection.id));
}
