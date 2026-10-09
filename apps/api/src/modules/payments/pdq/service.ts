import { and, eq, lt, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { PdqSaleRequestInput, PdqCallback } from '@pos/shared';
import { db } from '../../../db/client.js';
import { pdqTransactions, pdqTerminals, payments, stores } from '../../../db/schema/index.js';
import { env } from '../../../config/env.js';
import { conflict, notFound } from '../../../core/errors.js';
import { writeAuditSafe } from '../../../core/audit.js';
import { providerFor, maskPan, type PdqTerminalConfig } from './provider.js';
import { randomUUID } from '../../../core/crypto.js';

/**
 * Pushes an amount to the card terminal and records the outcome. The local record
 * is created first, so a terminal that approves but fails to answer still leaves
 * a row that reconciliation can resolve rather than a silent loss.
 */
export async function initiatePdqSale(
  request: FastifyRequest,
  input: PdqSaleRequestInput,
  userId: string,
): Promise<{
  transactionId: string;
  status: string;
  approved: boolean;
  pending: boolean;
  authCode?: string;
  maskedPan?: string;
  cardScheme?: string;
  message?: string;
  terminalReceipt?: string;
}> {
  const [terminal] = await db
    .select()
    .from(pdqTerminals)
    .where(eq(pdqTerminals.id, input.pdqTerminalId))
    .limit(1);

  if (!terminal || !terminal.isActive) throw notFound('Card terminal');
  if (terminal.storeId !== input.storeId) throw conflict('That card terminal belongs to another store');

  const [store] = await db.select().from(stores).where(eq(stores.id, input.storeId)).limit(1);
  if (!store) throw notFound('Store');

  const transactionRef = `${store.code}-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8)}`;

  const [record] = await db
    .insert(pdqTransactions)
    .values({
      storeId: input.storeId,
      terminalId: input.terminalId,
      pdqTerminalId: terminal.id,
      saleId: input.saleId ?? null,
      clientSaleId: input.clientSaleId ?? null,
      transactionRef,
      kind: 'PURCHASE',
      status: 'PENDING',
      amount: input.amount,
      initiatedBy: userId,
      expiresAt: new Date(Date.now() + env.PDQ_TIMEOUT_SECONDS * 1000),
    })
    .returning({ id: pdqTransactions.id });

  if (!record) throw conflict('Could not start the card payment');

  const config: PdqTerminalConfig = {
    id: terminal.id,
    provider: terminal.provider,
    endpointUrl: terminal.endpointUrl,
    encryptedSecret: terminal.encryptedSecret,
    deviceSerial: terminal.deviceSerial,
  };

  try {
    const response = await providerFor(terminal.provider).sale(config, {
      transactionRef,
      amountCents: input.amount,
      currency: store.currency,
      reference: input.reference,
    });

    const status = response.approved ? 'AUTHORIZED' : response.pending ? 'PENDING' : 'FAILED';

    await db
      .update(pdqTransactions)
      .set({
        status,
        authCode: response.authCode ?? null,
        maskedPan: maskPan(response.maskedPan) ?? null,
        cardScheme: response.cardScheme ?? null,
        responseCode: response.responseCode ?? null,
        responseMessage: response.responseMessage ?? null,
        terminalReceipt: response.terminalReceipt ?? null,
        rawResponse: (response.raw ?? null) as never,
        updatedAt: new Date(),
      })
      .where(eq(pdqTransactions.id, record.id));

    writeAuditSafe(request, {
      action: response.approved ? 'PDQ_APPROVED' : 'PDQ_NOT_APPROVED',
      entityType: 'PDQ_TRANSACTION',
      entityId: record.id,
      storeId: input.storeId,
      terminalId: input.terminalId,
      changes: { amount: input.amount, responseCode: response.responseCode, pending: response.pending },
    });

    return {
      transactionId: record.id,
      status,
      approved: response.approved,
      pending: response.pending,
      ...(response.authCode ? { authCode: response.authCode } : {}),
      ...(response.maskedPan ? { maskedPan: maskPan(response.maskedPan) } : {}),
      ...(response.cardScheme ? { cardScheme: response.cardScheme } : {}),
      ...(response.responseMessage ? { message: response.responseMessage } : {}),
      ...(response.terminalReceipt ? { terminalReceipt: response.terminalReceipt } : {}),
    };
  } catch (err) {
    await db
      .update(pdqTransactions)
      .set({
        status: 'FAILED',
        responseMessage: err instanceof Error ? err.message.slice(0, 200) : 'terminal error',
        updatedAt: new Date(),
      })
      .where(eq(pdqTransactions.id, record.id));
    throw err;
  }
}

/**
 * Async result from the terminal bridge. Idempotent: terminals retry callbacks,
 * and a settled transaction is never re-opened by a duplicate delivery.
 */
export async function handlePdqCallback(payload: PdqCallback): Promise<{ applied: boolean }> {
  return db.transaction(async (tx) => {
    const [record] = await tx
      .select()
      .from(pdqTransactions)
      .where(eq(pdqTransactions.transactionRef, payload.transactionRef))
      .limit(1)
      .for('update');

    if (!record) return { applied: false };
    if (record.status === 'CAPTURED' || record.status === 'AUTHORIZED' || record.status === 'FAILED') {
      return { applied: false };
    }

    await tx
      .update(pdqTransactions)
      .set({
        status: payload.approved ? 'AUTHORIZED' : 'FAILED',
        authCode: payload.authCode ?? record.authCode,
        maskedPan: maskPan(payload.maskedPan) ?? record.maskedPan,
        cardScheme: payload.cardScheme ?? record.cardScheme,
        responseCode: payload.responseCode ?? record.responseCode,
        responseMessage: payload.responseMessage ?? record.responseMessage,
        terminalReceipt: payload.terminalReceipt ?? record.terminalReceipt,
        rawResponse: payload as never,
        updatedAt: new Date(),
      })
      .where(eq(pdqTransactions.id, record.id));

    if (payload.approved && record.saleId) {
      await tx
        .update(payments)
        .set({ status: 'CAPTURED', externalReference: payload.authCode ?? null })
        .where(and(eq(payments.pdqTransactionId, record.id), eq(payments.saleId, record.saleId)));
    }

    return { applied: true };
  });
}

/** Reverses an authorisation that was never attached to a completed sale. */
export async function reversePdqTransaction(
  request: FastifyRequest,
  pdqTransactionId: string,
  reason: string,
): Promise<{ reversed: boolean }> {
  const [record] = await db
    .select()
    .from(pdqTransactions)
    .where(eq(pdqTransactions.id, pdqTransactionId))
    .limit(1);

  if (!record) throw notFound('Card transaction');
  if (record.saleId) throw conflict('That payment belongs to a completed sale; refund it instead');
  if (record.reversedAt) return { reversed: true };

  const [terminal] = await db
    .select()
    .from(pdqTerminals)
    .where(eq(pdqTerminals.id, record.pdqTerminalId ?? ''))
    .limit(1);

  if (!terminal) throw notFound('Card terminal');

  const response = await providerFor(terminal.provider).reverse(
    {
      id: terminal.id,
      provider: terminal.provider,
      endpointUrl: terminal.endpointUrl,
      encryptedSecret: terminal.encryptedSecret,
      deviceSerial: terminal.deviceSerial,
    },
    record.transactionRef,
  );

  await db
    .update(pdqTransactions)
    .set({
      status: response.approved ? 'REVERSED' : record.status,
      reversedAt: response.approved ? new Date() : null,
      reversalReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(pdqTransactions.id, record.id));

  writeAuditSafe(request, {
    action: 'PDQ_REVERSED',
    entityType: 'PDQ_TRANSACTION',
    entityId: record.id,
    storeId: record.storeId,
    reason,
    changes: { approved: response.approved },
  });

  return { reversed: response.approved };
}

/** Expires authorisations the terminal never resolved, so they stop looking live. */
export async function expireStalePdqTransactions(): Promise<number> {
  const result = await db
    .update(pdqTransactions)
    .set({ status: 'EXPIRED', updatedAt: new Date() })
    .where(and(eq(pdqTransactions.status, 'PENDING'), lt(pdqTransactions.expiresAt, new Date())));
  return (result as unknown as { count?: number }).count ?? 0;
}

export async function getPdqTransaction(id: string) {
  const [record] = await db.select().from(pdqTransactions).where(eq(pdqTransactions.id, id)).limit(1);
  if (!record) throw notFound('Card transaction');
  return record;
}
