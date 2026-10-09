import { and, eq, isNull, lt, sql, desc } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { MpesaStkPushInput, MpesaStkCallback } from '@pos/shared';
import { db } from '../../../db/client.js';
import { mpesaTransactions, mpesaUnmatchedPayments, payments, sales } from '../../../db/schema/index.js';
import { env } from '../../../config/env.js';
import { conflict, notFound, badRequest } from '../../../core/errors.js';
import { writeAudit, writeAuditSafe } from '../../../core/audit.js';
import { metadataValue, stkPush, stkQuery } from './client.js';

/**
 * Starts an M-PESA payment. The local record is written *before* the push so that
 * if Daraja responds slowly, or not at all, there is still a row to reconcile
 * against rather than a payment nobody knows about.
 */
export async function initiateStkPush(
  request: FastifyRequest,
  input: MpesaStkPushInput,
  userId: string,
): Promise<{ transactionId: string; checkoutRequestId: string; customerMessage: string }> {
  const [record] = await db
    .insert(mpesaTransactions)
    .values({
      storeId: input.storeId,
      terminalId: input.terminalId,
      saleId: input.saleId ?? null,
      clientSaleId: input.clientSaleId ?? null,
      kind: 'STK_PUSH',
      status: 'PENDING',
      amount: input.amount,
      phone: input.phone,
      accountReference: input.reference,
      initiatedBy: userId,
      expiresAt: new Date(Date.now() + env.MPESA_STK_TIMEOUT_SECONDS * 1000),
    })
    .returning({ id: mpesaTransactions.id });

  if (!record) throw conflict('Could not start the M-PESA payment');

  try {
    const response = await stkPush({
      amountCents: input.amount,
      phone: input.phone,
      accountReference: input.reference,
      description: input.description ?? `Payment ${input.reference}`,
      callbackUrl: `${env.PUBLIC_BASE_URL}/api/v1/webhooks/mpesa/stk/${env.MPESA_CALLBACK_TOKEN}`,
    });

    await db
      .update(mpesaTransactions)
      .set({
        merchantRequestId: response.MerchantRequestID,
        checkoutRequestId: response.CheckoutRequestID,
        updatedAt: new Date(),
      })
      .where(eq(mpesaTransactions.id, record.id));

    writeAuditSafe(request, {
      action: 'MPESA_STK_INITIATED',
      entityType: 'MPESA_TRANSACTION',
      entityId: record.id,
      storeId: input.storeId,
      terminalId: input.terminalId,
      changes: { amount: input.amount, phone: maskPhone(input.phone) },
    });

    return {
      transactionId: record.id,
      checkoutRequestId: response.CheckoutRequestID,
      customerMessage: response.CustomerMessage,
    };
  } catch (err) {
    await db
      .update(mpesaTransactions)
      .set({
        status: 'FAILED',
        resultDescription: err instanceof Error ? err.message.slice(0, 500) : 'push failed',
        updatedAt: new Date(),
      })
      .where(eq(mpesaTransactions.id, record.id));
    throw err;
  }
}

/**
 * Applies an STK callback. Written to be safe against the two things Safaricom
 * actually does: delivering the same callback more than once, and delivering it
 * out of order with respect to our own status polling.
 */
export async function handleStkCallback(payload: MpesaStkCallback): Promise<{ applied: boolean }> {
  const callback = payload.Body.stkCallback;
  const items = callback.CallbackMetadata?.Item;

  return db.transaction(async (tx) => {
    const [record] = await tx
      .select()
      .from(mpesaTransactions)
      .where(eq(mpesaTransactions.checkoutRequestId, callback.CheckoutRequestID))
      .limit(1)
      .for('update');

    if (!record) {
      // Unknown checkout id: keep it rather than discard it, so it can be matched later.
      await tx
        .insert(mpesaUnmatchedPayments)
        .values({
          transactionId: callback.CheckoutRequestID,
          amount: Math.round(Number(metadataValue(items, 'Amount') ?? 0) * 100),
          phone: String(metadataValue(items, 'PhoneNumber') ?? ''),
          billReference: String(metadataValue(items, 'MpesaReceiptNumber') ?? ''),
          raw: payload as never,
        })
        .onConflictDoNothing();
      return { applied: false };
    }

    // Terminal states are final; a replayed callback must not resurrect or alter them.
    if (record.status === 'CAPTURED' || record.status === 'FAILED') {
      return { applied: false };
    }

    if (callback.ResultCode === 0) {
      const receipt = String(metadataValue(items, 'MpesaReceiptNumber') ?? '');
      const amountShillings = Number(metadataValue(items, 'Amount') ?? 0);
      const confirmedAmount = Math.round(amountShillings * 100);
      const phone = String(metadataValue(items, 'PhoneNumber') ?? record.phone);
      const rawDate = metadataValue(items, 'TransactionDate');

      await tx
        .update(mpesaTransactions)
        .set({
          status: 'CAPTURED',
          confirmationCode: receipt || null,
          confirmedAmount,
          payerName: String(metadataValue(items, 'FirstName') ?? '') || null,
          phone,
          resultCode: 0,
          resultDescription: callback.ResultDesc,
          transactionDate: parseDarajaDate(rawDate),
          rawCallback: payload as never,
          updatedAt: new Date(),
        })
        .where(eq(mpesaTransactions.id, record.id));

      // A short payment is captured but deliberately not auto-reconciled: a human
      // decides whether to accept it, chase the balance, or refund.
      if (confirmedAmount !== record.amount) {
        return { applied: true };
      }

      if (record.saleId) {
        await tx
          .update(payments)
          .set({ status: 'CAPTURED', externalReference: receipt })
          .where(and(eq(payments.mpesaTransactionId, record.id), eq(payments.saleId, record.saleId)));
        await tx
          .update(mpesaTransactions)
          .set({ reconciledAt: new Date() })
          .where(eq(mpesaTransactions.id, record.id));
      }
    } else {
      await tx
        .update(mpesaTransactions)
        .set({
          // ResultCode 1032 is the customer cancelling on their handset.
          status: callback.ResultCode === 1032 ? 'CANCELLED' : 'FAILED',
          resultCode: callback.ResultCode,
          resultDescription: callback.ResultDesc,
          rawCallback: payload as never,
          updatedAt: new Date(),
        })
        .where(eq(mpesaTransactions.id, record.id));
    }

    return { applied: true };
  });
}

/** Records a customer-initiated paybill payment for later matching. */
export async function handleC2bConfirmation(payload: {
  TransID: string;
  TransAmount: string | number;
  MSISDN?: string;
  BillRefNumber?: string;
  FirstName?: string;
  TransTime?: string;
}): Promise<void> {
  await db
    .insert(mpesaUnmatchedPayments)
    .values({
      transactionId: payload.TransID,
      amount: Math.round(Number(payload.TransAmount) * 100),
      phone: payload.MSISDN ?? null,
      payerName: payload.FirstName ?? null,
      billReference: payload.BillRefNumber ?? null,
      transactionTime: parseDarajaDate(payload.TransTime),
      raw: payload as never,
    })
    .onConflictDoNothing();
}

/** Polls Daraja for pushes that never produced a callback. */
export async function reconcilePendingPushes(limit = 25): Promise<{ checked: number; resolved: number }> {
  const stale = new Date(Date.now() - 45_000);
  const candidates = await db
    .select()
    .from(mpesaTransactions)
    .where(
      and(
        eq(mpesaTransactions.status, 'PENDING'),
        lt(mpesaTransactions.createdAt, stale),
        lt(mpesaTransactions.pollAttempts, 10),
        sql`${mpesaTransactions.checkoutRequestId} IS NOT NULL`,
      ),
    )
    .orderBy(mpesaTransactions.createdAt)
    .limit(limit);

  let resolved = 0;
  for (const record of candidates) {
    if (!record.checkoutRequestId) continue;
    try {
      const result = await stkQuery(record.checkoutRequestId);
      const resultCode = Number(result.ResultCode);

      if (Number.isFinite(resultCode) && resultCode !== 0) {
        await db
          .update(mpesaTransactions)
          .set({
            status: resultCode === 1032 ? 'CANCELLED' : 'FAILED',
            resultCode,
            resultDescription: result.ResultDesc,
            lastPolledAt: new Date(),
            pollAttempts: sql`${mpesaTransactions.pollAttempts} + 1`,
          })
          .where(eq(mpesaTransactions.id, record.id));
        resolved++;
      } else if (resultCode === 0) {
        // Daraja says it succeeded but the callback has not landed. Mark it
        // authorized so a human can confirm the code rather than double-charging.
        await db
          .update(mpesaTransactions)
          .set({
            status: 'AUTHORIZED',
            resultCode: 0,
            resultDescription: result.ResultDesc,
            lastPolledAt: new Date(),
            pollAttempts: sql`${mpesaTransactions.pollAttempts} + 1`,
          })
          .where(eq(mpesaTransactions.id, record.id));
        resolved++;
      } else {
        await db
          .update(mpesaTransactions)
          .set({ lastPolledAt: new Date(), pollAttempts: sql`${mpesaTransactions.pollAttempts} + 1` })
          .where(eq(mpesaTransactions.id, record.id));
      }
    } catch {
      await db
        .update(mpesaTransactions)
        .set({ lastPolledAt: new Date(), pollAttempts: sql`${mpesaTransactions.pollAttempts} + 1` })
        .where(eq(mpesaTransactions.id, record.id));
    }
  }

  // Anything past its window with no answer is expired, not pending forever.
  await db
    .update(mpesaTransactions)
    .set({ status: 'EXPIRED', updatedAt: new Date() })
    .where(and(eq(mpesaTransactions.status, 'PENDING'), lt(mpesaTransactions.expiresAt, new Date())));

  return { checked: candidates.length, resolved };
}

/**
 * Links a confirmation code the customer read out to a sale. The unique index on
 * `confirmationCode` is what prevents one M-PESA payment settling two sales.
 */
export async function matchConfirmationToSale(
  request: FastifyRequest,
  input: { saleId: string; confirmationCode: string; amount: number; phone?: string },
  userId: string,
): Promise<{ transactionId: string }> {
  return db.transaction(async (tx) => {
    const [sale] = await tx.select().from(sales).where(eq(sales.id, input.saleId)).limit(1);
    if (!sale) throw notFound('Sale');

    const code = input.confirmationCode.toUpperCase();

    const [existing] = await tx
      .select()
      .from(mpesaTransactions)
      .where(eq(mpesaTransactions.confirmationCode, code))
      .limit(1)
      .for('update');

    if (existing && existing.saleId && existing.saleId !== input.saleId) {
      throw conflict('That M-PESA code is already applied to another sale', {
        receiptNumber: sale.receiptNumber,
      });
    }

    let transactionId: string;
    if (existing) {
      if (existing.confirmedAmount && existing.confirmedAmount !== input.amount) {
        throw badRequest('The amount does not match that M-PESA payment', [
          { path: 'amount', message: `expected ${existing.confirmedAmount}` },
        ]);
      }
      await tx
        .update(mpesaTransactions)
        .set({ saleId: input.saleId, reconciledAt: new Date(), reconciledBy: userId })
        .where(eq(mpesaTransactions.id, existing.id));
      transactionId = existing.id;
    } else {
      const [created] = await tx
        .insert(mpesaTransactions)
        .values({
          storeId: sale.storeId,
          terminalId: sale.terminalId,
          saleId: sale.id,
          kind: 'MANUAL_MATCH',
          status: 'CAPTURED',
          amount: input.amount,
          confirmedAmount: input.amount,
          phone: input.phone ?? '',
          accountReference: sale.receiptNumber,
          confirmationCode: code,
          reconciledAt: new Date(),
          reconciledBy: userId,
          initiatedBy: userId,
        })
        .returning({ id: mpesaTransactions.id });
      if (!created) throw conflict('Could not record the M-PESA payment');
      transactionId = created.id;
    }

    // Close out any unmatched paybill receipt carrying the same code.
    await tx
      .update(mpesaUnmatchedPayments)
      .set({ matchedSaleId: sale.id, matchedAt: new Date(), matchedBy: userId })
      .where(and(eq(mpesaUnmatchedPayments.transactionId, code), isNull(mpesaUnmatchedPayments.matchedSaleId)));

    await writeAudit(tx, request, {
      action: 'MPESA_MANUALLY_MATCHED',
      entityType: 'SALE',
      entityId: sale.id,
      storeId: sale.storeId,
      changes: { confirmationCode: code, amount: input.amount },
    });

    return { transactionId };
  });
}

export async function getTransaction(id: string) {
  const [record] = await db.select().from(mpesaTransactions).where(eq(mpesaTransactions.id, id)).limit(1);
  if (!record) throw notFound('M-PESA transaction');
  return record;
}

export async function listUnmatched(limit = 50) {
  return db
    .select()
    .from(mpesaUnmatchedPayments)
    .where(isNull(mpesaUnmatchedPayments.matchedSaleId))
    .orderBy(desc(mpesaUnmatchedPayments.createdAt))
    .limit(limit);
}

/** Daraja returns 20240115143022 in Nairobi local time. */
function parseDarajaDate(value: unknown): Date | null {
  const raw = String(value ?? '');
  if (!/^\d{14}$/.test(raw)) return null;
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}+03:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Phone numbers in logs are masked; the full value stays in the database only. */
export function maskPhone(phone: string): string {
  return phone.length <= 6 ? '***' : `${phone.slice(0, 6)}***${phone.slice(-2)}`;
}
