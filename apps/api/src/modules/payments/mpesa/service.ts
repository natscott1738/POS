import { and, eq, gte, isNull, lt, sql, desc } from 'drizzle-orm';
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

/**
 * Payments that arrived at the paybill or till but have not been attached to a
 * sale yet, ranked by how likely each is to be the one the cashier is waiting for.
 *
 * This exists so a cashier never has to read a confirmation code off a customer's
 * phone and type it in. The payment is already in the system within seconds of
 * the customer sending it; the cashier just taps the right one.
 */
export async function findCandidatePayments(input: {
  storeId: string;
  /** What the till is waiting to be paid, in cents. */
  expectedAmount?: number;
  phone?: string;
  /** How far back to look. Customers sometimes pay before being asked. */
  withinMinutes?: number;
  limit?: number;
}): Promise<
  Array<{
    id: string;
    transactionId: string;
    amount: number;
    phone: string | null;
    payerName: string | null;
    receivedAt: Date;
    /** EXACT when the amount matches to the cent; CLOSE within a shilling. */
    amountMatch: 'EXACT' | 'CLOSE' | 'OVER' | 'UNDER';
    phoneMatch: boolean;
    /** Higher is more likely to be the payment the cashier is waiting for. */
    score: number;
  }>
> {
  const since = new Date(Date.now() - (input.withinMinutes ?? 30) * 60_000);

  const rows = await db
    .select()
    .from(mpesaUnmatchedPayments)
    .where(
      and(
        // Unclaimed, by the same measure the claim itself uses.
        isNull(mpesaUnmatchedPayments.matchedAt),
        gte(mpesaUnmatchedPayments.createdAt, since),
      ),
    )
    .orderBy(desc(mpesaUnmatchedPayments.createdAt))
    .limit(input.limit ?? 25);

  const normalisedPhone = input.phone?.replace(/\D/g, '').slice(-9);

  return rows
    .map((row) => {
      const difference = input.expectedAmount !== undefined ? row.amount - input.expectedAmount : 0;
      const amountMatch: 'EXACT' | 'CLOSE' | 'OVER' | 'UNDER' =
        input.expectedAmount === undefined || difference === 0
          ? 'EXACT'
          : Math.abs(difference) <= 100
            ? 'CLOSE'
            : difference > 0
              ? 'OVER'
              : 'UNDER';

      const rowPhone = row.phone?.replace(/\D/g, '').slice(-9);
      const phoneMatch = Boolean(normalisedPhone && rowPhone && normalisedPhone === rowPhone);

      // Amount is the strongest signal, then the phone, then recency: a payment
      // that arrived ten seconds ago is far more likely than one from an hour back.
      const ageMinutes = (Date.now() - row.createdAt.getTime()) / 60_000;
      const score =
        (amountMatch === 'EXACT' ? 100 : amountMatch === 'CLOSE' ? 40 : 0) +
        (phoneMatch ? 50 : 0) +
        Math.max(0, 30 - ageMinutes);

      return {
        id: row.id,
        transactionId: row.transactionId,
        amount: row.amount,
        phone: row.phone,
        payerName: row.payerName,
        receivedAt: row.createdAt,
        amountMatch,
        phoneMatch,
        score: Math.round(score),
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Attaches an already-received paybill payment to a sale by its database id,
 * rather than by a code someone typed. Used by the tap-to-confirm flow.
 */
export async function claimUnmatchedPayment(
  request: FastifyRequest,
  input: { unmatchedId: string; storeId: string; saleId?: string; clientSaleId?: string },
  userId: string,
): Promise<{ transactionId: string; confirmationCode: string; amount: number }> {
  return db.transaction(async (tx) => {
    const [unmatched] = await tx
      .select()
      .from(mpesaUnmatchedPayments)
      .where(eq(mpesaUnmatchedPayments.id, input.unmatchedId))
      .limit(1)
      .for('update');

    if (!unmatched) throw notFound('M-PESA payment');
    // Two cashiers tapping the same payment at once: the row lock means the
    // second one is told it is already taken rather than both succeeding.
    //
    // Keyed on matchedAt rather than matchedSaleId, because a payment claimed
    // while the sale is still being built has no sale id yet — checking the sale
    // id alone would let the same payment be claimed twice.
    if (unmatched.matchedAt) {
      throw conflict('That M-PESA payment has already been applied to a sale');
    }

    const [sale] = input.saleId
      ? await tx.select().from(sales).where(eq(sales.id, input.saleId)).limit(1)
      : [undefined];

    const [created] = await tx
      .insert(mpesaTransactions)
      .values({
        // A paybill payment carries no store of its own, so the till tells us.
        storeId: sale?.storeId ?? input.storeId,
        saleId: input.saleId ?? null,
        clientSaleId: input.clientSaleId ?? null,
        kind: 'PAYBILL_CLAIM',
        status: 'CAPTURED',
        amount: unmatched.amount,
        confirmedAmount: unmatched.amount,
        phone: unmatched.phone ?? '',
        accountReference: unmatched.billReference ?? '',
        confirmationCode: unmatched.transactionId,
        payerName: unmatched.payerName,
        transactionDate: unmatched.transactionTime,
        reconciledAt: new Date(),
        reconciledBy: userId,
        initiatedBy: userId,
      })
      .returning({ id: mpesaTransactions.id });

    if (!created) throw conflict('Could not record the M-PESA payment');

    await tx
      .update(mpesaUnmatchedPayments)
      .set({
        matchedSaleId: input.saleId ?? null,
        matchedAt: new Date(),
        matchedBy: userId,
      })
      .where(eq(mpesaUnmatchedPayments.id, unmatched.id));

    await writeAudit(tx, request, {
      action: 'MPESA_PAYBILL_CLAIMED',
      entityType: 'MPESA_TRANSACTION',
      entityId: created.id,
      changes: { code: unmatched.transactionId, amount: unmatched.amount },
    });

    return {
      transactionId: created.id,
      confirmationCode: unmatched.transactionId,
      amount: unmatched.amount,
    };
  });
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
