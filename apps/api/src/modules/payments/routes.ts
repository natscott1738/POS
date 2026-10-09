import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isIP } from 'node:net';
import {
  mpesaStkPushSchema,
  mpesaStkCallbackSchema,
  mpesaC2bConfirmationSchema,
  mpesaManualMatchSchema,
  pdqSaleRequestSchema,
  pdqCallbackSchema,
  pdqReversalSchema,
  uuid,
} from '@pos/shared';
import { env } from '../../config/env.js';
import { parseBody, parseParams, parseQuery } from '../../core/validation.js';
import { requirePermissions, getAuth, assertStoreAccess } from '../../auth/context.js';
import { forbidden, integrationUnavailable, notFound } from '../../core/errors.js';
import { safeEqual } from '../../core/crypto.js';
import {
  initiateStkPush,
  handleStkCallback,
  handleC2bConfirmation,
  matchConfirmationToSale,
  findCandidatePayments,
  claimUnmatchedPayment,
  getTransaction,
  listUnmatched,
  reconcilePendingPushes,
} from './mpesa/service.js';
import {
  initiatePdqSale,
  handlePdqCallback,
  reversePdqTransaction,
  getPdqTransaction,
} from './pdq/service.js';

const idParam = z.object({ id: uuid });

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  /* --------------------------------- M-PESA -------------------------------- */

  app.post('/mpesa/stk-push', { preHandler: requirePermissions('payment:mpesa:initiate') }, async (request) => {
    if (!env.MPESA_ENABLED) throw integrationUnavailable('M-PESA');
    const auth = getAuth(request);
    const input = parseBody(request, mpesaStkPushSchema);
    assertStoreAccess(request, input.storeId);
    return initiateStkPush(request, input, auth.userId);
  });

  /** The till polls this while the customer completes the prompt on their phone. */
  app.get('/mpesa/:id', { preHandler: requirePermissions('payment:mpesa:initiate') }, async (request) => {
    const { id } = parseParams(request, idParam);
    const record = await getTransaction(id);
    assertStoreAccess(request, record.storeId);
    return {
      id: record.id,
      status: record.status,
      amount: record.amount,
      confirmedAmount: record.confirmedAmount,
      confirmationCode: record.confirmationCode,
      resultDescription: record.resultDescription,
      // Surfaced so the till can warn rather than silently accept a short payment.
      amountMismatch:
        record.confirmedAmount !== null && record.confirmedAmount !== record.amount,
    };
  });

  /**
   * Paybill payments waiting to be attached to a sale, best match first.
   *
   * The till polls this while the M-PESA tab is open, so a payment the customer
   * has just sent appears on screen within seconds. The cashier taps it instead
   * of reading a code off the customer's phone and typing it in.
   *
   * Available to any cashier who can take M-PESA, because tapping a payment is
   * part of taking one — reconciling historic payments is a separate permission.
   */
  app.get('/mpesa/candidates', { preHandler: requirePermissions('payment:mpesa:initiate') }, async (request) => {
    const query = parseQuery(
      request,
      z.object({
        storeId: uuid,
        amount: z.coerce.number().int().min(0).optional(),
        phone: z.string().trim().max(20).optional(),
        withinMinutes: z.coerce.number().int().min(1).max(1440).default(30),
      }),
    );
    assertStoreAccess(request, query.storeId);

    const candidates = await findCandidatePayments({
      storeId: query.storeId,
      ...(query.amount !== undefined ? { expectedAmount: query.amount } : {}),
      ...(query.phone ? { phone: query.phone } : {}),
      withinMinutes: query.withinMinutes,
    });

    return {
      candidates,
      // The till auto-selects only when there is exactly one unambiguous match,
      // so it can never quietly attach the wrong customer's payment.
      autoMatch:
        candidates.length === 1 && candidates[0]?.amountMatch === 'EXACT' ? candidates[0] : null,
    };
  });

  /** Attaches a received paybill payment to a sale by id, not by a typed code. */
  app.post('/mpesa/claim', { preHandler: requirePermissions('payment:mpesa:initiate') }, async (request) => {
    const auth = getAuth(request);
    const input = parseBody(
      request,
      z.object({
        unmatchedId: uuid,
        storeId: uuid,
        saleId: uuid.optional(),
        clientSaleId: uuid.optional(),
      }),
    );
    assertStoreAccess(request, input.storeId);
    return claimUnmatchedPayment(request, input, auth.userId);
  });

  app.get('/mpesa/unmatched', { preHandler: requirePermissions('payment:mpesa:reconcile') }, async () => {
    return { payments: await listUnmatched() };
  });

  app.post('/mpesa/match', { preHandler: requirePermissions('payment:mpesa:reconcile') }, async (request) => {
    const auth = getAuth(request);
    const input = parseBody(request, mpesaManualMatchSchema);
    return matchConfirmationToSale(request, input, auth.userId);
  });

  app.post('/mpesa/reconcile', { preHandler: requirePermissions('payment:mpesa:reconcile') }, async () => {
    return reconcilePendingPushes();
  });

  /* ----------------------------------- PDQ --------------------------------- */

  app.post('/pdq/sale', { preHandler: requirePermissions('payment:pdq:initiate') }, async (request) => {
    if (!env.PDQ_ENABLED) throw integrationUnavailable('Card terminal');
    const auth = getAuth(request);
    const input = parseBody(request, pdqSaleRequestSchema);
    assertStoreAccess(request, input.storeId);
    return initiatePdqSale(request, input, auth.userId);
  });

  app.get('/pdq/:id', { preHandler: requirePermissions('payment:pdq:initiate') }, async (request) => {
    const { id } = parseParams(request, idParam);
    const record = await getPdqTransaction(id);
    assertStoreAccess(request, record.storeId);
    return {
      id: record.id,
      status: record.status,
      amount: record.amount,
      authCode: record.authCode,
      maskedPan: record.maskedPan,
      cardScheme: record.cardScheme,
      responseMessage: record.responseMessage,
      terminalReceipt: record.terminalReceipt,
    };
  });

  app.post('/pdq/reverse', { preHandler: requirePermissions('payment:pdq:reconcile') }, async (request) => {
    const input = parseBody(request, pdqReversalSchema);
    return reversePdqTransaction(request, input.pdqTransactionId, input.reason);
  });
}

/**
 * Public webhook endpoints. These are unauthenticated by necessity, so they are
 * defended in layers: an unguessable path token, a source-IP allowlist, a strict
 * schema, a small body cap, and idempotent handlers.
 *
 * They are mounted outside the authenticated API prefix and never reveal whether
 * a given transaction exists.
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/mpesa/stk/:token',
    {
      config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      assertCallbackToken(request, env.MPESA_CALLBACK_TOKEN);
      assertSourceAllowed(request, env.MPESA_ALLOWED_IPS);

      const parsed = mpesaStkCallbackSchema.safeParse(request.body);
      if (!parsed.success) {
        request.log.warn({ issues: parsed.error.issues }, 'malformed M-PESA STK callback');
        // Safaricom retries on non-2xx; a malformed body will never become valid,
        // so acknowledge it and move on rather than invite an infinite retry loop.
        return reply.send({ ResultCode: 0, ResultDesc: 'Accepted' });
      }

      try {
        await handleStkCallback(parsed.data);
      } catch (err) {
        request.log.error({ err }, 'failed to apply M-PESA callback');
        // Signal failure so Safaricom retries a genuinely transient error.
        return reply.status(500).send({ ResultCode: 1, ResultDesc: 'Retry' });
      }

      return reply.send({ ResultCode: 0, ResultDesc: 'Accepted' });
    },
  );

  app.post('/mpesa/c2b/confirmation/:token', async (request, reply) => {
    assertCallbackToken(request, env.MPESA_CALLBACK_TOKEN);
    assertSourceAllowed(request, env.MPESA_ALLOWED_IPS);

    const parsed = mpesaC2bConfirmationSchema.safeParse(request.body);
    if (parsed.success) {
      await handleC2bConfirmation(parsed.data).catch((err) => {
        request.log.error({ err }, 'failed to record C2B confirmation');
      });
    }
    return reply.send({ ResultCode: 0, ResultDesc: 'Accepted' });
  });

  /** M-PESA validation hook: accept everything, then reconcile. */
  app.post('/mpesa/c2b/validation/:token', async (request, reply) => {
    assertCallbackToken(request, env.MPESA_CALLBACK_TOKEN);
    return reply.send({ ResultCode: 0, ResultDesc: 'Accepted' });
  });

  app.post('/pdq/:token', async (request, reply) => {
    assertCallbackToken(request, env.PDQ_CALLBACK_TOKEN);

    const parsed = pdqCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.warn({ issues: parsed.error.issues }, 'malformed PDQ callback');
      return reply.status(400).send({ ok: false });
    }

    await handlePdqCallback(parsed.data);
    return reply.send({ ok: true });
  });
}

/** Constant-time comparison of the secret path segment. */
function assertCallbackToken(request: FastifyRequest, expected: string | undefined): void {
  const { token } = request.params as { token?: string };
  if (!expected || !token || !safeEqual(token, expected)) {
    request.log.warn({ ip: request.ip, url: request.url }, 'webhook called with a bad token');
    throw forbidden('Not authorised');
  }
}

/**
 * Restricts callbacks to the provider's published egress ranges. Supports bare
 * addresses and CIDR blocks; an empty list disables the check for local development.
 */
function assertSourceAllowed(request: FastifyRequest, allowed: string[]): void {
  if (allowed.length === 0) return;
  const ip = request.ip;
  const permitted = allowed.some((entry) => (entry.includes('/') ? ipInCidr(ip, entry) : entry === ip));
  if (!permitted) {
    request.log.warn({ ip }, 'webhook from a disallowed source address');
    throw forbidden('Not authorised');
  }
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split('/');
  if (!range || isIP(ip) !== 4 || isIP(range) !== 4) return false;
  const bits = Number(bitsRaw ?? 32);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(range) & mask);
}

function toInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
}
