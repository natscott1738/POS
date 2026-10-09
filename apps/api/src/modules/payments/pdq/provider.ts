import { randomUUID } from 'node:crypto';
import { decryptSecret } from '../../../core/crypto.js';
import { env } from '../../../config/env.js';
import { integrationUnavailable } from '../../../core/errors.js';

/**
 * PDQ terminals differ by acquirer, so the integration is expressed as a small
 * interface. `ECR_HTTP` talks to a bridge running on the till's own loopback
 * address next to the card reader; `SIMULATOR` is for development and tests.
 *
 * Card data never passes through this system: the terminal handles the PAN and
 * returns only a masked value and an auth code, which keeps us out of PCI-DSS
 * scope beyond SAQ-C-VT.
 */

export interface PdqSaleRequest {
  transactionRef: string;
  amountCents: number;
  currency: string;
  reference: string;
}

export interface PdqSaleResponse {
  approved: boolean;
  /** Some terminals answer asynchronously; the result then arrives by callback. */
  pending: boolean;
  authCode?: string;
  maskedPan?: string;
  cardScheme?: string;
  responseCode?: string;
  responseMessage?: string;
  terminalReceipt?: string;
  raw?: unknown;
}

export interface PdqTerminalConfig {
  id: string;
  provider: string;
  endpointUrl: string | null;
  encryptedSecret: string | null;
  deviceSerial: string | null;
}

export interface PdqProvider {
  readonly name: string;
  sale(terminal: PdqTerminalConfig, request: PdqSaleRequest): Promise<PdqSaleResponse>;
  reverse(terminal: PdqTerminalConfig, transactionRef: string): Promise<PdqSaleResponse>;
}

/* ------------------------------ ECR HTTP bridge ----------------------------- */

class EcrHttpProvider implements PdqProvider {
  readonly name = 'ECR_HTTP';

  async sale(terminal: PdqTerminalConfig, request: PdqSaleRequest): Promise<PdqSaleResponse> {
    return this.call(terminal, '/ecr/sale', {
      transactionRef: request.transactionRef,
      // Bridges speak in minor units to avoid any decimal ambiguity on the wire.
      amountMinor: request.amountCents,
      currency: request.currency,
      reference: request.reference,
    });
  }

  async reverse(terminal: PdqTerminalConfig, transactionRef: string): Promise<PdqSaleResponse> {
    return this.call(terminal, '/ecr/reverse', { transactionRef });
  }

  private async call(
    terminal: PdqTerminalConfig,
    path: string,
    body: Record<string, unknown>,
  ): Promise<PdqSaleResponse> {
    if (!terminal.endpointUrl) throw integrationUnavailable('Card terminal (no endpoint configured)');

    const secret = terminal.encryptedSecret
      ? decryptSecret(terminal.encryptedSecret, terminal.id)
      : null;

    const controller = new AbortController();
    // The cardholder is standing at the counter: bound the wait and fail visibly.
    const timer = setTimeout(() => controller.abort(), env.PDQ_TIMEOUT_SECONDS * 1000);

    try {
      const response = await fetch(new URL(path, terminal.endpointUrl).toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify({ ...body, deviceSerial: terminal.deviceSerial }),
        signal: controller.signal,
      });

      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (!response.ok) {
        return {
          approved: false,
          pending: false,
          responseCode: String(payload.responseCode ?? response.status),
          responseMessage: String(payload.responseMessage ?? 'Terminal rejected the request'),
          raw: payload,
        };
      }

      return {
        approved: payload.approved === true,
        pending: payload.pending === true,
        authCode: asString(payload.authCode),
        maskedPan: maskPan(asString(payload.maskedPan)),
        cardScheme: asString(payload.cardScheme),
        responseCode: asString(payload.responseCode),
        responseMessage: asString(payload.responseMessage),
        terminalReceipt: asString(payload.terminalReceipt),
        raw: payload,
      };
    } catch (err) {
      // An aborted call is genuinely ambiguous: the card may or may not have been
      // charged, so it is reported as pending and reconciled, never as declined.
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          approved: false,
          pending: true,
          responseMessage: 'Terminal did not respond in time; awaiting reconciliation',
        };
      }
      throw integrationUnavailable('Card terminal', err);
    } finally {
      clearTimeout(timer);
    }
  }
}

/* -------------------------------- Simulator -------------------------------- */

class SimulatorProvider implements PdqProvider {
  readonly name = 'SIMULATOR';

  async sale(_terminal: PdqTerminalConfig, request: PdqSaleRequest): Promise<PdqSaleResponse> {
    await delay(300);
    // Deterministic decline hook so the decline path is testable end to end:
    // any amount ending in .13 is refused.
    const declined = request.amountCents % 100 === 13;
    if (declined) {
      return {
        approved: false,
        pending: false,
        responseCode: '51',
        responseMessage: 'Insufficient funds',
      };
    }
    return {
      approved: true,
      pending: false,
      authCode: randomUUID().slice(0, 6).toUpperCase(),
      maskedPan: '400000******1234',
      cardScheme: 'VISA',
      responseCode: '00',
      responseMessage: 'Approved',
      terminalReceipt: `SIMULATED APPROVAL\nREF ${request.transactionRef}\nAMOUNT ${(request.amountCents / 100).toFixed(2)}`,
    };
  }

  async reverse(): Promise<PdqSaleResponse> {
    await delay(200);
    return { approved: true, pending: false, responseCode: '00', responseMessage: 'Reversed' };
  }
}

const providers: Record<string, PdqProvider> = {
  ECR_HTTP: new EcrHttpProvider(),
  SIMULATOR: new SimulatorProvider(),
};

export function providerFor(name: string): PdqProvider {
  const provider = providers[name] ?? providers[env.PDQ_PROVIDER];
  if (!provider) throw integrationUnavailable(`Card terminal provider ${name}`);
  return provider;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Defence in depth: even if a bridge misbehaves and returns a full PAN, only the
 * first six and last four digits are ever persisted.
 */
export function maskPan(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 12) return value.slice(0, 24);
  return `${digits.slice(0, 6)}${'*'.repeat(Math.max(0, digits.length - 10))}${digits.slice(-4)}`;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
