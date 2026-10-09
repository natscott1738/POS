import { env } from '../../../config/env.js';
import { integrationUnavailable } from '../../../core/errors.js';

/**
 * Thin Safaricom Daraja client. Keeps the OAuth token cached in memory (Daraja
 * tokens last an hour and the endpoint is rate limited) and never logs the
 * credentials or the raw token.
 */

const BASE_URL =
  env.MPESA_ENVIRONMENT === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  // Refresh a minute early so a token never expires mid-request.
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const credentials = Buffer.from(
    `${env.MPESA_CONSUMER_KEY}:${env.MPESA_CONSUMER_SECRET}`,
  ).toString('base64');

  const response = await fetchWithTimeout(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${credentials}` } },
    10_000,
  );

  if (!response.ok) throw integrationUnavailable('M-PESA');

  const body = (await response.json()) as { access_token?: string; expires_in?: string };
  if (!body.access_token) throw integrationUnavailable('M-PESA');

  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + Number(body.expires_in ?? 3599) * 1000,
  };
  return cachedToken.value;
}

/** Daraja expects the timestamp in Nairobi local time, formatted yyyyMMddHHmmss. */
export function darajaTimestamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}${get('hour')}${get('minute')}${get('second')}`;
}

function stkPassword(timestamp: string): string {
  return Buffer.from(`${env.MPESA_SHORTCODE}${env.MPESA_PASSKEY}${timestamp}`).toString('base64');
}

export interface StkPushResponse {
  MerchantRequestID: string;
  CheckoutRequestID: string;
  ResponseCode: string;
  ResponseDescription: string;
  CustomerMessage: string;
}

/**
 * Sends the payment prompt to the customer's handset. Daraja works in whole
 * shillings, so the cents amount is converted here and validated: a sale whose
 * total is not a whole shilling cannot be pushed without silently losing money.
 */
export async function stkPush(params: {
  amountCents: number;
  phone: string;
  accountReference: string;
  description: string;
  callbackUrl: string;
}): Promise<StkPushResponse> {
  if (params.amountCents % 100 !== 0) {
    throw integrationUnavailable('M-PESA (amount must be a whole shilling)');
  }
  const amount = params.amountCents / 100;
  if (amount < 1) throw integrationUnavailable('M-PESA (minimum amount is KES 1)');

  const timestamp = darajaTimestamp();
  const token = await accessToken();

  const response = await fetchWithTimeout(
    `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: env.MPESA_SHORTCODE,
        Password: stkPassword(timestamp),
        Timestamp: timestamp,
        TransactionType: env.MPESA_TRANSACTION_TYPE,
        Amount: amount,
        PartyA: params.phone,
        PartyB: env.MPESA_SHORTCODE,
        PhoneNumber: params.phone,
        CallBackURL: params.callbackUrl,
        AccountReference: params.accountReference.slice(0, 12),
        TransactionDesc: params.description.slice(0, 60),
      }),
    },
    20_000,
  );

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || body.ResponseCode !== '0') {
    const message = String(body.errorMessage ?? body.ResponseDescription ?? 'STK push rejected');
    throw integrationUnavailable(`M-PESA: ${message}`);
  }
  return body as unknown as StkPushResponse;
}

export interface StkQueryResponse {
  ResponseCode: string;
  ResultCode: string;
  ResultDesc: string;
}

/**
 * Asks Daraja what happened to a push. This is the safety net for the case that
 * matters most: the customer paid but the callback never arrived.
 */
export async function stkQuery(checkoutRequestId: string): Promise<StkQueryResponse> {
  const timestamp = darajaTimestamp();
  const token = await accessToken();

  const response = await fetchWithTimeout(
    `${BASE_URL}/mpesa/stkpushquery/v1/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: env.MPESA_SHORTCODE,
        Password: stkPassword(timestamp),
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId,
      }),
    },
    15_000,
  );

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw integrationUnavailable('M-PESA status query');
  return body as unknown as StkQueryResponse;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  // A hung payment call must not hold a till hostage; always bound the wait.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw integrationUnavailable('M-PESA', err);
  } finally {
    clearTimeout(timer);
  }
}

/** Pulls a named value out of Daraja's flat CallbackMetadata array. */
export function metadataValue(
  items: Array<{ Name: string; Value?: string | number }> | undefined,
  name: string,
): string | number | undefined {
  return items?.find((i) => i.Name === name)?.Value;
}

export function resetTokenCacheForTests(): void {
  cachedToken = null;
}
