import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, applyTestEnv, runMigrations, type TestDatabase } from './helpers/harness.js';

/**
 * End-to-end tests against a real PostgreSQL and a real Fastify instance.
 *
 * These cover the behaviour that only exists when the database is real:
 * row-level locking, unique-index races, transactional rollback, and the
 * idempotency that makes offline sync safe.
 */

let database: TestDatabase;
let app: Awaited<ReturnType<typeof import('../src/server.js')['buildServer']>>;
let closeDb: () => Promise<void>;

let storeId: string;
let terminalId: string;
let adminToken: string;
let cashierToken: string;
let coffeeVariantId: string;
let deviceId: string;

beforeAll(async () => {
  database = createTestDatabase();
  applyTestEnv(database.url);
  runMigrations(database.url);

  const { buildServer } = await import('../src/server.js');
  const client = await import('../src/db/client.js');
  closeDb = client.closeDb;
  app = await buildServer();
  await app.ready();

  await seed();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  database?.drop();
});

/* ------------------------------- Test fixtures ----------------------------- */

async function seed(): Promise<void> {
  const { db } = await import('../src/db/client.js');
  const schema = await import('../src/db/schema/index.js');
  const { hashPassword, hashPin } = await import('../src/auth/password.js');
  const { applyStockMovement } = await import('../src/modules/inventory/service.js');

  const [store] = await db
    .insert(schema.stores)
    .values({ code: 'TST', name: 'Test Store', currency: 'KES', pricesIncludeTax: true })
    .returning();
  storeId = store!.id;

  const [terminal] = await db
    .insert(schema.terminals)
    .values({ storeId, code: 'T1', name: 'Test till', receiptPrefix: 'TSTT1' })
    .returning();
  terminalId = terminal!.id;

  const password = 'integration-test-password';
  for (const person of [
    { email: 'admin@test.local', role: 'ADMIN' as const, staffCode: 'ADM9', pin: '4321' },
    { email: 'cashier@test.local', role: 'CASHIER' as const, staffCode: 'CSH9', pin: '1234' },
    { email: 'manager@test.local', role: 'MANAGER' as const, staffCode: 'MGR9', pin: '5678' },
  ]) {
    const [user] = await db
      .insert(schema.users)
      .values({
        email: person.email,
        fullName: person.email,
        role: person.role,
        passwordHash: await hashPassword(password),
        staffCode: person.staffCode,
        pinHash: await hashPin(person.pin),
      })
      .returning();
    await db.insert(schema.userStores).values({ userId: user!.id, storeId });
  }

  const [product] = await db
    .insert(schema.products)
    .values({ name: 'Test Coffee', taxCode: 'STANDARD', taxRateBasisPoints: 1600, unitOfMeasure: 'EACH' })
    .returning();

  const [variant] = await db
    .insert(schema.productVariants)
    .values({ productId: product!.id, sku: 'TST-COF', barcode: '1234567890123', unitPrice: 120000, costPrice: 70000, reorderPoint: 5000 })
    .returning();
  coffeeVariantId = variant!.id;

  await db.insert(schema.priceHistory).values({ variantId: coffeeVariantId, unitPrice: 120000, costPrice: 70000 });
  await db.transaction((tx) =>
    applyStockMovement(tx, {
      storeId,
      variantId: coffeeVariantId,
      quantityDelta: 10_000, // 10 units
      reason: 'OPENING_BALANCE',
      allowNegative: true,
    }),
  );

  deviceId = randomUUID();
  await db.insert(schema.syncDevices).values({ deviceId, storeId, terminalId, label: 'Test till' });

  adminToken = await signIn('admin@test.local', password);
  cashierToken = await signIn('cashier@test.local', password);
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  expect(response.statusCode).toBe(200);
  return response.json().accessToken as string;
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function salePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientSaleId: randomUUID(),
    storeId,
    terminalId,
    lines: [{ clientLineId: randomUUID(), variantId: coffeeVariantId, quantity: 1000, unitPrice: 120000 }],
    tenders: [{ method: 'CASH', amount: 120000, tendered: 120000 }],
    declaredTotal: 120000,
    soldAt: new Date().toISOString(),
    loyaltyPointsRedeemed: 0,
    ...overrides,
  };
}

/**
 * Sets stock to an exact figure through the ledger, never by writing the cached
 * balance directly — doing that would silently break the invariant these tests
 * exist to prove.
 */
async function setStock(target: number): Promise<void> {
  const { db } = await import('../src/db/client.js');
  const { applyStockMovement } = await import('../src/modules/inventory/service.js');
  const current = await stockOnHand();
  const delta = target - current;
  if (delta === 0) return;
  await db.transaction((tx) =>
    applyStockMovement(tx, {
      storeId,
      variantId: coffeeVariantId,
      quantityDelta: delta,
      reason: 'STOCK_COUNT',
      note: 'test fixture',
      allowNegative: true,
    }),
  );
}

async function stockOnHand(): Promise<number> {
  const { db } = await import('../src/db/client.js');
  const schema = await import('../src/db/schema/index.js');
  const { eq, and } = await import('drizzle-orm');
  const [level] = await db
    .select()
    .from(schema.stockLevels)
    .where(and(eq(schema.stockLevels.storeId, storeId), eq(schema.stockLevels.variantId, coffeeVariantId)))
    .limit(1);
  return level?.quantityOnHand ?? 0;
}

/* ---------------------------------- Tests ---------------------------------- */

describe('authentication', () => {
  it('rejects a bad password with a generic message', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin@test.local', password: 'wrong-password-entirely' },
    });
    expect(response.statusCode).toBe(401);
    // Must not reveal whether the account exists.
    expect(response.json().error.message).toBe('Invalid email or password');
  });

  it('rejects an unknown account with the same message', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@test.local', password: 'whatever-password' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toBe('Invalid email or password');
  });

  it('refuses a request with no token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/catalog/products' });
    expect(response.statusCode).toBe(401);
  });

  it('gives a cashier the tills they need without store:read', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/context', headers: auth(cashierToken) });
    expect(response.statusCode).toBe(200);
    expect(response.json().terminals).toHaveLength(1);

    const denied = await app.inject({ method: 'GET', url: '/api/v1/admin/stores', headers: auth(cashierToken) });
    expect(denied.statusCode).toBe(403);
  });
});

describe('password reset', () => {
  /** Stands in for the emailed link: the API never hands a reset token to the caller. */
  async function issueResetToken(email: string): Promise<string> {
    const { db } = await import('../src/db/client.js');
    const { users, passwordResetTokens } = await import('../src/db/schema/index.js');
    const { generateToken, hashToken } = await import('../src/core/crypto.js');
    const { eq } = await import('drizzle-orm');
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    const token = generateToken(32);
    await db.insert(passwordResetTokens).values({
      userId: user!.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    return token;
  }

  // Regression: with no email transport the token came back in this response, so
  // anyone who knew a staff address could reset that account and sign in as them.
  it('never hands the reset token to the caller', async () => {
    const known = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: 'manager@test.local' },
    });
    expect(known.statusCode).toBe(200);
    expect(known.json().token).toBeUndefined();

    // Identical for a real and an unknown address, so it cannot find real staff.
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: 'does-not-exist@test.local' },
    });
    expect(unknown.json()).toEqual(known.json());
  });

  it('issues a single-use token that cannot be replayed', async () => {
    const token = await issueResetToken('manager@test.local');

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { token, newPassword: 'copper-lantern-drift-97' },
    });
    expect(first.statusCode).toBe(200);

    // The same link a second time must fail, even with a valid password.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { token, newPassword: 'another-password-entirely' },
    });
    expect(replay.statusCode).toBe(401);

    await signIn('manager@test.local', 'copper-lantern-drift-97');
  });

  it('rejects a new password built from the account identity', async () => {
    const token = await issueResetToken('cashier@test.local');

    const weak = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      // Contains "cashier", which is the account's own identifier.
      payload: { token, newPassword: 'cashier-password-2026' },
    });
    expect(weak.statusCode).toBe(400);
  });
});

describe('sales', () => {
  it('records a sale and decrements stock in the same transaction', async () => {
    const before = await stockOnHand();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sales',
      headers: auth(adminToken),
      payload: salePayload(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().receiptNumber).toMatch(/^TSTT1-\d{6}$/);
    expect(await stockOnHand()).toBe(before - 1000);
  });

  it('returns the original receipt when the same sale is retried', async () => {
    const payload = salePayload();
    const first = await app.inject({ method: 'POST', url: '/api/v1/sales', headers: auth(adminToken), payload });
    const stockAfterFirst = await stockOnHand();

    const retry = await app.inject({ method: 'POST', url: '/api/v1/sales', headers: auth(adminToken), payload });

    expect(retry.statusCode).toBe(200);
    expect(retry.json().replayed).toBe(true);
    expect(retry.json().receiptNumber).toBe(first.json().receiptNumber);
    // The decisive check: a retry must not move stock a second time.
    expect(await stockOnHand()).toBe(stockAfterFirst);
  });

  it('refuses a sale whose payments do not add up', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sales',
      headers: auth(adminToken),
      payload: salePayload({ tenders: [{ method: 'CASH', amount: 50000, tendered: 50000 }] }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('UNBALANCED_SALE');
  });

  it('refuses a cashier selling below the authoritative price', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sales',
      headers: auth(cashierToken),
      payload: salePayload({
        lines: [{ clientLineId: randomUUID(), variantId: coffeeVariantId, quantity: 1000, unitPrice: 100 }],
        tenders: [{ method: 'CASH', amount: 100, tendered: 100 }],
        declaredTotal: 100,
      }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('UNBALANCED_SALE');
  });

  it('rejects a sale dated in the future', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sales',
      headers: auth(adminToken),
      payload: salePayload({ soldAt: new Date(Date.now() + 3_600_000).toISOString() }),
    });
    expect(response.statusCode).toBe(400);
  });

  it('computes VAT by extraction from a tax-inclusive price', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sales',
      headers: auth(adminToken),
      payload: salePayload(),
    });
    const saleId = response.json().saleId;
    const detail = await app.inject({ method: 'GET', url: `/api/v1/sales/${saleId}`, headers: auth(adminToken) });
    const sale = detail.json().sale;
    // 120000 inclusive of 16% -> 16552 tax, 103448 net.
    expect(sale.taxTotal).toBe(16552);
    expect(sale.netTotal + sale.taxTotal).toBe(sale.total);
  });
});

describe('card payment simulator', () => {
  it('approves normal test amounts and deterministically declines amounts ending in .13', async () => {
    const { db } = await import('../src/db/client.js');
    const { pdqTerminals, pdqTransactions } = await import('../src/db/schema/index.js');
    const [pdqTerminal] = await db
      .insert(pdqTerminals)
      .values({ storeId, terminalId, label: 'Simulated test card machine', provider: 'SIMULATOR' })
      .returning();

    const approved = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/pdq/sale',
      headers: auth(adminToken),
      payload: {
        storeId,
        terminalId,
        pdqTerminalId: pdqTerminal!.id,
        amount: 12_000,
        reference: 'SIM-APPROVED',
      },
    });

    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      status: 'AUTHORIZED',
      approved: true,
      pending: false,
      maskedPan: '400000******1234',
      cardScheme: 'VISA',
    });
    expect(approved.json().authCode).toMatch(/^[A-F0-9]{6}$/);
    const approvedRecord = await db.query.pdqTransactions.findFirst({
      where: (table, { eq }) => eq(table.id, approved.json().transactionId),
    });
    expect(approvedRecord).toMatchObject({ status: 'AUTHORIZED', responseCode: '00' });

    const declined = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/pdq/sale',
      headers: auth(adminToken),
      payload: {
        storeId,
        terminalId,
        pdqTerminalId: pdqTerminal!.id,
        amount: 1_213,
        reference: 'SIM-DECLINED',
      },
    });

    expect(declined.statusCode).toBe(200);
    expect(declined.json()).toMatchObject({
      status: 'FAILED',
      approved: false,
      pending: false,
      message: 'Insufficient funds',
    });
    const declinedRecord = await db.query.pdqTransactions.findFirst({
      where: (table, { eq }) => eq(table.id, declined.json().transactionId),
    });
    expect(declinedRecord).toMatchObject({ status: 'FAILED', responseCode: '51' });

    const reversal = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/pdq/reverse',
      headers: auth(adminToken),
      payload: { pdqTransactionId: approved.json().transactionId, reason: 'simulator test cleanup' },
    });
    expect(reversal.statusCode).toBe(200);
    expect(reversal.json()).toEqual({ reversed: true });
    const reversedRecord = await db.query.pdqTransactions.findFirst({
      where: (table, { eq }) => eq(table.id, approved.json().transactionId),
    });
    expect(reversedRecord?.status).toBe('REVERSED');
  });
});

describe('concurrency', () => {
  it('does not oversell the last unit when two tills race', async () => {
    // Exactly one unit on hand, set through the ledger.
    await setStock(1000);

    const attempts = Array.from({ length: 5 }, () =>
      app.inject({ method: 'POST', url: '/api/v1/sales', headers: auth(adminToken), payload: salePayload() }),
    );
    const results = await Promise.all(attempts);

    const succeeded = results.filter((r) => r.statusCode === 201);
    const refused = results.filter((r) => r.statusCode >= 400);

    // Exactly one sale may take the last unit; the rest are refused.
    expect(succeeded).toHaveLength(1);
    expect(refused).toHaveLength(4);
    expect(await stockOnHand()).toBe(0);
  });

});

describe('refunds and voids', () => {
  it('refuses to refund more than was taken on that tender', async () => {
    await setStock(50_000);

    const sale = await app.inject({
      method: 'POST',
      url: '/api/v1/sales',
      headers: auth(adminToken),
      payload: salePayload(),
    });
    const saleId = sale.json().saleId;
    const detail = await app.inject({ method: 'GET', url: `/api/v1/sales/${saleId}`, headers: auth(adminToken) });
    const lineId = detail.json().lines[0].id;

    const overRefund = await app.inject({
      method: 'POST',
      url: '/api/v1/sales/refunds',
      headers: auth(adminToken),
      payload: {
        clientRefundId: randomUUID(),
        saleId,
        lines: [{ saleLineId: lineId, quantity: 1000, restock: true, reason: 'FAULTY' }],
        refundTenders: [{ method: 'MPESA', amount: 120000 }],
        reason: 'wrong tender',
      },
    });
    expect(overRefund.statusCode).toBe(400);

    const valid = await app.inject({
      method: 'POST',
      url: '/api/v1/sales/refunds',
      headers: auth(adminToken),
      payload: {
        clientRefundId: randomUUID(),
        saleId,
        lines: [{ saleLineId: lineId, quantity: 1000, restock: true, reason: 'FAULTY' }],
        refundTenders: [{ method: 'CASH', amount: 120000 }],
        reason: 'customer returned it',
      },
    });
    expect(valid.statusCode).toBe(201);
    expect(valid.json().saleStatus).toBe('REFUNDED');
  });

  it('requires a manager override for a cashier to void', async () => {
    const sale = await app.inject({
      method: 'POST',
      url: '/api/v1/sales',
      headers: auth(cashierToken),
      payload: salePayload(),
    });
    const saleId = sale.json().saleId;

    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/sales/${saleId}/void`,
      headers: auth(cashierToken),
      payload: { reason: 'mis-keyed' },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'POST',
      url: `/api/v1/sales/${saleId}/void`,
      headers: auth(cashierToken),
      payload: {
        reason: 'mis-keyed',
        override: { staffCode: 'MGR9', pin: '5678', reason: 'approved at counter' },
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().status).toBe('VOIDED');
  });

  it('refuses an override with the wrong PIN', async () => {
    const sale = await app.inject({
      method: 'POST',
      url: '/api/v1/sales',
      headers: auth(cashierToken),
      payload: salePayload(),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/sales/${sale.json().saleId}/void`,
      headers: auth(cashierToken),
      payload: { reason: 'test', override: { staffCode: 'MGR9', pin: '0000', reason: 'nope' } },
    });
    expect(response.statusCode).toBe(403);
  });

  it('returns voided stock to the shelf', async () => {
    const sale = await app.inject({
      method: 'POST',
      url: '/api/v1/sales',
      headers: auth(adminToken),
      payload: salePayload(),
    });
    const afterSale = await stockOnHand();
    await app.inject({
      method: 'POST',
      url: `/api/v1/sales/${sale.json().saleId}/void`,
      headers: auth(adminToken),
      payload: { reason: 'abandoned basket' },
    });
    expect(await stockOnHand()).toBe(afterSale + 1000);
  });
});

describe('offline sync', () => {
  it('applies a batch once, however many times it is replayed', async () => {
    await setStock(50_000);
    const operation = {
      type: 'SALE_CREATE',
      opId: randomUUID(),
      occurredAt: new Date().toISOString(),
      payload: salePayload(),
    };
    const batch = {
      deviceId,
      storeId,
      terminalId,
      batchSequence: 1,
      // The same operation twice inside one batch, as a flaky till would send.
      operations: [operation, operation],
    };

    const before = await stockOnHand();
    const first = await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: auth(adminToken), payload: batch });
    expect(first.statusCode).toBe(200);

    const statuses = first.json().results.map((r: { status: string }) => r.status);
    expect(statuses).toEqual(['APPLIED', 'DUPLICATE']);
    expect(await stockOnHand()).toBe(before - 1000);

    // Re-push the whole batch, as a till would after a dropped connection.
    const replay = await app.inject({ method: 'POST', url: '/api/v1/sync/push', headers: auth(adminToken), payload: batch });
    expect(replay.statusCode).toBe(200);
    expect(await stockOnHand()).toBe(before - 1000);
  });

  it('replays an online sale safely when its response was lost before queueing', async () => {
    await setStock(50_000);
    const payload = salePayload();
    const before = await stockOnHand();
    const direct = await app.inject({
      method: 'POST', url: '/api/v1/sales', headers: auth(adminToken), payload,
    });
    expect(direct.statusCode).toBe(201);
    expect(await stockOnHand()).toBe(before - 1000);

    // The browser falls back to the offline outbox after a transport timeout.
    // That replay must resolve the original direct-sale idempotency record.
    const replay = await app.inject({
      method: 'POST', url: '/api/v1/sync/push', headers: auth(adminToken),
      payload: {
        deviceId,
        storeId,
        terminalId,
        batchSequence: 4,
        operations: [{
          type: 'SALE_CREATE',
          opId: payload.clientSaleId,
          occurredAt: payload.soldAt,
          payload,
        }],
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().results[0].status).toBe('DUPLICATE');
    expect(replay.json().results[0].receiptNumber).toBe(direct.json().receiptNumber);
    expect(await stockOnHand()).toBe(before - 1000);
  });

  it('accepts an offline sale that takes stock negative, and flags it', async () => {
    await setStock(0);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: auth(adminToken),
      payload: {
        deviceId,
        storeId,
        terminalId,
        batchSequence: 2,
        operations: [
          { type: 'SALE_CREATE', opId: randomUUID(), occurredAt: new Date().toISOString(), payload: salePayload() },
        ],
      },
    });

    expect(response.json().results[0].status).toBe('APPLIED');
    // The sale already happened; refusing it would lose real revenue.
    expect(await stockOnHand()).toBe(-1000);

    const saleId = response.json().results[0].serverId;
    const detail = await app.inject({ method: 'GET', url: `/api/v1/sales/${saleId}`, headers: auth(adminToken) });
    expect(detail.json().sale.oversold).toBe(true);
    expect(detail.json().sale.createdOffline).toBe(true);
  });

  it('reports a rejected operation without failing the whole batch', async () => {
    await setStock(50_000);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/push',
      headers: auth(adminToken),
      payload: {
        deviceId,
        storeId,
        terminalId,
        batchSequence: 3,
        operations: [
          { type: 'SALE_CREATE', opId: randomUUID(), occurredAt: new Date().toISOString(), payload: salePayload() },
          {
            type: 'SALE_CREATE',
            opId: randomUUID(),
            occurredAt: new Date().toISOString(),
            // Unknown variant: this one must fail on its own.
            payload: salePayload({
              lines: [{ clientLineId: randomUUID(), variantId: randomUUID(), quantity: 1000, unitPrice: 120000 }],
            }),
          },
        ],
      },
    });

    const statuses = response.json().results.map((r: { status: string }) => r.status);
    expect(statuses).toEqual(['APPLIED', 'REJECTED']);
  });
});

describe('M-PESA paybill matching', () => {
  /**
   * The cashier should never have to type a confirmation code. Safaricom tells
   * us about the payment within seconds; these tests cover the till finding it
   * and claiming it safely.
   */
  async function recordPaybillPayment(amount: number, phone: string): Promise<string> {
    const { db } = await import('../src/db/client.js');
    const schema = await import('../src/db/schema/index.js');
    const code = `TST${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
    const [row] = await db
      .insert(schema.mpesaUnmatchedPayments)
      .values({
        transactionId: code,
        amount,
        phone,
        payerName: 'Test Payer',
        raw: { source: 'integration-test' },
      })
      .returning({ id: schema.mpesaUnmatchedPayments.id });
    return row!.id;
  }

  it('ranks an exact-amount payment above the others', async () => {
    await recordPaybillPayment(55_000, '254700111222');
    await recordPaybillPayment(120_000, '254700333444');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/payments/mpesa/candidates?storeId=${storeId}&amount=120000`,
      headers: auth(cashierToken),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.candidates.length).toBeGreaterThanOrEqual(2);
    // Best match first, so the cashier's eye lands on the right row.
    expect(body.candidates[0].amount).toBe(120_000);
    expect(body.candidates[0].amountMatch).toBe('EXACT');
  });

  it('auto-matches only when exactly one payment is unambiguous', async () => {
    const { db } = await import('../src/db/client.js');
    const schema = await import('../src/db/schema/index.js');
    // Clear the field so there is precisely one candidate.
    await db.delete(schema.mpesaUnmatchedPayments);
    await recordPaybillPayment(77_000, '254700555666');

    const single = await app.inject({
      method: 'GET',
      url: `/api/v1/payments/mpesa/candidates?storeId=${storeId}&amount=77000`,
      headers: auth(cashierToken),
    });
    expect(single.json().autoMatch).not.toBeNull();

    // A second payment for the same amount makes it ambiguous, so the till must
    // not choose for the cashier.
    await recordPaybillPayment(77_000, '254700777888');
    const ambiguous = await app.inject({
      method: 'GET',
      url: `/api/v1/payments/mpesa/candidates?storeId=${storeId}&amount=77000`,
      headers: auth(cashierToken),
    });
    expect(ambiguous.json().autoMatch).toBeNull();
  });

  it('claims a payment without anyone typing a code, and only once', async () => {
    const unmatchedId = await recordPaybillPayment(99_000, '254700999000');

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/mpesa/claim',
      headers: auth(cashierToken),
      payload: { unmatchedId, storeId },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().amount).toBe(99_000);
    expect(first.json().confirmationCode).toBeTruthy();

    // Two cashiers tapping the same payment: the second must be refused.
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/mpesa/claim',
      headers: auth(cashierToken),
      payload: { unmatchedId, storeId },
    });
    expect(second.statusCode).toBe(409);
  });

  it('lets a cashier see candidates without the reconcile permission', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/payments/mpesa/candidates?storeId=${storeId}`,
      headers: auth(cashierToken),
    });
    expect(response.statusCode).toBe(200);

    // Reviewing historic unmatched payments stays a manager's job.
    const restricted = await app.inject({
      method: 'GET',
      url: '/api/v1/payments/mpesa/unmatched',
      headers: auth(cashierToken),
    });
    expect(restricted.statusCode).toBe(403);
  });
});

describe('expanded reports', () => {
  it('reports profit and margin by category', async () => {
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/profit?from=${from}&to=${to}`,
      headers: auth(adminToken),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.totals.revenue).toBeGreaterThan(0);
    // Gross profit must be revenue less cost, not an independent figure.
    expect(body.totals.grossProfit).toBe(body.totals.revenue - body.totals.cost);
  });

  it('compares a period against the one before it', async () => {
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date().toISOString();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/comparison?from=${from}&to=${to}`,
      headers: auth(adminToken),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().current).toBeDefined();
    expect(response.json().previousPeriod).toBeDefined();
  });

  it('breaks activity down per cashier', async () => {
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/exceptions?from=${from}&to=${to}`,
      headers: auth(adminToken),
    });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json().cashiers)).toBe(true);
  });
});

describe('shifts', () => {
  it('computes cash variance from the ledger, not from the client', async () => {
    // The previous block deliberately drives stock negative; this one sells.
    await setStock(50_000);
    const opened = await app.inject({
      method: 'POST',
      url: '/api/v1/shifts/open',
      headers: auth(adminToken),
      payload: { storeId, terminalId, openingFloat: 500000 },
    });
    expect(opened.statusCode).toBe(201);
    const shiftId = opened.json().shift.id;

    await app.inject({
      method: 'POST',
      url: '/api/v1/sales',
      headers: auth(adminToken),
      payload: salePayload({ shiftId }),
    });

    const closed = await app.inject({
      method: 'POST',
      url: `/api/v1/shifts/${shiftId}/close`,
      headers: auth(adminToken),
      payload: { countedCash: 615000, note: 'five thousand short' },
    });

    expect(closed.statusCode).toBe(200);
    const shift = closed.json().shift;
    expect(shift.expectedCash).toBe(620000);
    expect(shift.cashVariance).toBe(-5000);
  });

  it('allows only one open shift per till', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/shifts/open',
      headers: auth(adminToken),
      payload: { storeId, terminalId, openingFloat: 0 },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/shifts/open',
      headers: auth(adminToken),
      payload: { storeId, terminalId, openingFloat: 0 },
    });
    expect(second.statusCode).toBe(409);
  });
});

describe('customer credit', () => {
  async function createCreditAccount(creditLimit = 200_000): Promise<{ customerId: string; accountId: string }> {
    const phone = `2547${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`;
    const customer = await app.inject({
      method: 'POST', url: '/api/v1/customers', headers: auth(adminToken),
      payload: { fullName: `Credit Test ${randomUUID().slice(0, 8)}`, phone, marketingConsent: false },
    });
    expect(customer.statusCode).toBe(201);
    const customerId = customer.json().customer.id as string;
    const account = await app.inject({
      method: 'POST', url: '/api/v1/credit/accounts', headers: auth(adminToken),
      payload: { customerId, storeId, creditLimit, termsDays: 14 },
    });
    expect(account.statusCode).toBe(201);
    return { customerId, accountId: account.json().account.id as string };
  }

  it('records dated account sales, enforces the limit, and allocates repeat-safe repayments', async () => {
    await setStock(10_000);
    const { customerId, accountId } = await createCreditAccount(150_000);
    const charge = await app.inject({
      method: 'POST', url: '/api/v1/sales', headers: auth(cashierToken),
      payload: salePayload({
        customerId,
        tenders: [{ method: 'ON_ACCOUNT', amount: 120_000, customerId }],
      }),
    });
    expect(charge.statusCode).toBe(201);

    const overLimit = await app.inject({
      method: 'POST', url: '/api/v1/sales', headers: auth(cashierToken),
      payload: salePayload({
        customerId,
        tenders: [{ method: 'ON_ACCOUNT', amount: 120_000, customerId }],
      }),
    });
    expect(overLimit.statusCode).toBe(409);

    const beforePayment = await app.inject({ method: 'GET', url: `/api/v1/credit/accounts/${accountId}`, headers: auth(adminToken) });
    expect(beforePayment.statusCode).toBe(200);
    expect(beforePayment.json().account.balance).toBe(120_000);
    const invoice = beforePayment.json().transactions.find((entry: { type: string }) => entry.type === 'CHARGE');
    expect(invoice.openAmount).toBe(120_000);
    expect(new Date(invoice.dueAt).getTime()).toBeGreaterThan(Date.now());

    const clientPaymentId = randomUUID();
    const reference = `BANK${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
    const paymentPayload = { clientPaymentId, amount: 50_000, method: 'BANK_TRANSFER', reference };
    const first = await app.inject({
      method: 'POST', url: `/api/v1/credit/accounts/${accountId}/payments`, headers: auth(cashierToken), payload: paymentPayload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().balance).toBe(70_000);

    const replay = await app.inject({
      method: 'POST', url: `/api/v1/credit/accounts/${accountId}/payments`, headers: auth(cashierToken), payload: paymentPayload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(replay.json().transactionId).toBe(first.json().transactionId);

    const duplicateReference = await app.inject({
      method: 'POST', url: `/api/v1/credit/accounts/${accountId}/payments`, headers: auth(cashierToken),
      payload: { clientPaymentId: randomUUID(), amount: 10_000, method: 'BANK_TRANSFER', reference },
    });
    expect(duplicateReference.statusCode).toBe(409);

    const finalPayment = await app.inject({
      method: 'POST', url: `/api/v1/credit/accounts/${accountId}/payments`, headers: auth(cashierToken),
      payload: { clientPaymentId: randomUUID(), amount: 70_000, method: 'CASH', shiftId: null },
    });
    expect(finalPayment.statusCode).toBe(409);
    expect(finalPayment.json().error.message).toMatch(/shift/i);

    const settled = await app.inject({
      method: 'POST', url: `/api/v1/credit/accounts/${accountId}/payments`, headers: auth(cashierToken),
      payload: { clientPaymentId: randomUUID(), amount: 70_000, method: 'BANK_TRANSFER', reference: `BANK${randomUUID().slice(0, 8).toUpperCase()}` },
    });
    expect(settled.statusCode).toBe(201);
    expect(settled.json().balance).toBe(0);

    const afterPayment = await app.inject({ method: 'GET', url: `/api/v1/credit/accounts/${accountId}`, headers: auth(adminToken) });
    const settledInvoice = afterPayment.json().transactions.find((entry: { type: string }) => entry.type === 'CHARGE');
    expect(settledInvoice.openAmount).toBe(0);
    expect(afterPayment.json().account.balance).toBe(0);

    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const paymentReport = await app.inject({
      method: 'GET', url: `/api/v1/reports/payments?from=${from}&to=${to}`, headers: auth(adminToken),
    });
    expect(paymentReport.statusCode).toBe(200);
    expect(paymentReport.json().totals.creditSales).toBeGreaterThanOrEqual(120_000);
    expect(paymentReport.json().totals.creditCollections).toBeGreaterThanOrEqual(120_000);

    const cashierList = await app.inject({ method: 'GET', url: '/api/v1/credit/accounts', headers: auth(cashierToken) });
    expect(cashierList.statusCode).toBe(200);
    const deniedManagement = await app.inject({
      method: 'POST', url: '/api/v1/credit/accounts', headers: auth(cashierToken),
      payload: { customerId, storeId, creditLimit: 200_000, termsDays: 30 },
    });
    expect(deniedManagement.statusCode).toBe(403);
  });

  it('reverses an account charge on void and reduces debt on an account refund', async () => {
    await setStock(10_000);
    const voidAccount = await createCreditAccount();
    const voidedSale = await app.inject({
      method: 'POST', url: '/api/v1/sales', headers: auth(adminToken),
      payload: salePayload({ customerId: voidAccount.customerId, tenders: [{ method: 'ON_ACCOUNT', amount: 120_000, customerId: voidAccount.customerId }] }),
    });
    expect(voidedSale.statusCode).toBe(201);
    const voidResponse = await app.inject({
      method: 'POST', url: `/api/v1/sales/${voidedSale.json().saleId}/void`, headers: auth(adminToken), payload: { reason: 'duplicate entry' },
    });
    expect(voidResponse.statusCode).toBe(200);
    const voidAccountState = await app.inject({ method: 'GET', url: `/api/v1/credit/accounts/${voidAccount.accountId}`, headers: auth(adminToken) });
    expect(voidAccountState.json().account.balance).toBe(0);
    expect(voidAccountState.json().transactions.some((entry: { type: string }) => entry.type === 'VOID_REVERSAL')).toBe(true);

    const refundAccount = await createCreditAccount();
    const sale = await app.inject({
      method: 'POST', url: '/api/v1/sales', headers: auth(adminToken),
      payload: salePayload({ customerId: refundAccount.customerId, tenders: [{ method: 'ON_ACCOUNT', amount: 120_000, customerId: refundAccount.customerId }] }),
    });
    expect(sale.statusCode).toBe(201);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/sales/${sale.json().saleId}`, headers: auth(adminToken) });
    const refund = await app.inject({
      method: 'POST', url: '/api/v1/sales/refunds', headers: auth(adminToken),
      payload: {
        clientRefundId: randomUUID(), saleId: sale.json().saleId,
        lines: [{ saleLineId: detail.json().lines[0].id, quantity: 1000, restock: true, reason: 'FAULTY' }],
        refundTenders: [{ method: 'ON_ACCOUNT', amount: 120_000 }], reason: 'return to account',
      },
    });
    expect(refund.statusCode).toBe(201);
    const refundAccountState = await app.inject({ method: 'GET', url: `/api/v1/credit/accounts/${refundAccount.accountId}`, headers: auth(adminToken) });
    expect(refundAccountState.json().account.balance).toBe(0);
    expect(refundAccountState.json().transactions.some((entry: { type: string }) => entry.type === 'REFUND')).toBe(true);
  });

  it('includes cash account collections in the shift drawer close', async () => {
    await setStock(10_000);
    const { db } = await import('../src/db/client.js');
    const { terminals } = await import('../src/db/schema/index.js');
    const [terminal] = await db.insert(terminals).values({ storeId, code: `CR${randomUUID().slice(0, 4)}`, name: 'Credit till', receiptPrefix: `CR${randomUUID().slice(0, 6)}` }).returning();
    const shift = await app.inject({ method: 'POST', url: '/api/v1/shifts/open', headers: auth(adminToken), payload: { storeId, terminalId: terminal!.id, openingFloat: 0 } });
    const { customerId, accountId } = await createCreditAccount();
    const sale = await app.inject({
      method: 'POST', url: '/api/v1/sales', headers: auth(adminToken),
      payload: salePayload({ terminalId: terminal!.id, shiftId: shift.json().shift.id, customerId, tenders: [{ method: 'ON_ACCOUNT', amount: 120_000, customerId }] }),
    });
    expect(sale.statusCode).toBe(201);
    const received = await app.inject({
      method: 'POST', url: `/api/v1/credit/accounts/${accountId}/payments`, headers: auth(adminToken),
      payload: { clientPaymentId: randomUUID(), amount: 120_000, method: 'CASH', shiftId: shift.json().shift.id },
    });
    expect(received.statusCode).toBe(201);
    const closed = await app.inject({
      method: 'POST', url: `/api/v1/shifts/${shift.json().shift.id}/close`, headers: auth(adminToken), payload: { countedCash: 120_000 },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().shift.expectedCash).toBe(120_000);
  });

  it('keeps account and customer balance caches in agreement with the ledger', async () => {
    const { sql } = await import('../src/db/client.js');
    const accountDrift = await sql`
      SELECT a.id, a.balance, COALESCE(SUM(t.amount), 0) AS ledger
      FROM credit_accounts a
      LEFT JOIN credit_transactions t ON t.account_id = a.id
      GROUP BY a.id
      HAVING a.balance <> COALESCE(SUM(t.amount), 0)
    `;
    expect(accountDrift).toHaveLength(0);

    const customerDrift = await sql`
      SELECT c.id, c.balance, COALESCE(SUM(a.balance), 0) AS accounts
      FROM customers c
      LEFT JOIN credit_accounts a ON a.customer_id = c.id
      GROUP BY c.id
      HAVING c.balance <> COALESCE(SUM(a.balance), 0)
    `;
    expect(customerDrift).toHaveLength(0);
  });
});

describe('catalogue import', () => {
  it('refuses a file with problems rather than importing half of it', async () => {
    const csv = [
      'name,sku,barcode,price,cost,tax,unit,reorder_point,opening_stock',
      'Good Product,IMP-001,,100.00,50.00,STANDARD,EACH,5,10',
      'Bad Product,,,not-a-price,50.00,STANDARD,EACH,5,10',
    ].join('\n');

    const validate = await app.inject({
      method: 'POST',
      url: '/api/v1/catalog/import/validate',
      headers: auth(adminToken),
      payload: { csv },
    });
    expect(validate.json().issues.length).toBeGreaterThan(0);

    const apply = await app.inject({
      method: 'POST',
      url: '/api/v1/catalog/import/apply',
      headers: auth(adminToken),
      payload: { storeId, csv },
    });
    expect(apply.statusCode).toBe(400);

    // Nothing from the good row may have been written.
    const search = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/products/search?q=Good Product',
      headers: auth(adminToken),
    });
    expect(search.json().results).toHaveLength(0);
  });

  it('imports a clean file, grouping variants and setting opening stock', async () => {
    const csv = [
      'name,sku,barcode,category,variant,price,cost,tax,unit,reorder_point,opening_stock',
      'Imported Shirt,IMP-SH-S,7001000000011,Apparel,Small,850.00,420.00,STANDARD,EACH,5,12',
      'Imported Shirt,IMP-SH-M,7001000000028,Apparel,Medium,850.00,420.00,STANDARD,EACH,5,8',
      'Imported Flour,IMP-FLR,7001000000035,Groceries,,180.00,140.00,ZERO_RATED,EACH,24,40',
    ].join('\n');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/catalog/import/apply',
      headers: auth(adminToken),
      payload: { storeId, csv },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().productsCreated).toBe(2);
    expect(response.json().variantsCreated).toBe(3);

    const scan = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/products/barcode/7001000000035',
      headers: auth(adminToken),
    });
    expect(scan.statusCode).toBe(200);
    // Zero-rated goods must not pick up the standard 16%.
    expect(scan.json().taxCode).toBe('ZERO_RATED');
    expect(scan.json().taxRateBasisPoints).toBe(0);
  });
});

describe('reports', () => {
  it('produces a dashboard without error', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/dashboard?storeId=${storeId}`,
      headers: auth(adminToken),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().today).toBeDefined();
    expect(response.json().attention).toBeDefined();
  });

  it('gates CSV export behind its own permission', async () => {
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date().toISOString();

    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/sales-summary?from=${from}&to=${to}&format=csv`,
      headers: auth(cashierToken),
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/sales-summary?from=${from}&to=${to}&format=csv`,
      headers: auth(adminToken),
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['content-type']).toContain('text/csv');
  });

  it('balances the payments ledger against sales takings', async () => {
    const { sql } = await import('../src/db/client.js');
    const [row] = await sql`
      SELECT
        (SELECT COALESCE(SUM(total), 0) - COALESCE(SUM(amount_refunded), 0)
           FROM sales WHERE status <> 'VOIDED') AS net_sales,
        (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
           JOIN sales s ON s.id = p.sale_id
          WHERE s.status <> 'VOIDED' AND p.status <> 'REVERSED') AS net_payments
    `;
    expect(Number(row?.net_sales)).toBe(Number(row?.net_payments));
  });
});

describe('webhooks', () => {
  it('refuses an M-PESA callback with a wrong token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/mpesa/stk/not-the-right-token',
      payload: { Body: { stkCallback: { MerchantRequestID: 'x', CheckoutRequestID: 'y', ResultCode: 0 } } },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a PDQ callback with a wrong token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/pdq/wrong-token',
      payload: { transactionRef: 'x', approved: true },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('ledger invariant', () => {
  it('keeps the movement ledger and the cached balance in agreement', async () => {
    const { sql } = await import('../src/db/client.js');
    // Checked across every variant and store, not just the one under test.
    const rows = await sql`
      SELECT sl.store_id, sl.variant_id, sl.quantity_on_hand AS cached,
             COALESCE(m.total, 0) AS ledger
        FROM stock_levels sl
        LEFT JOIN (
          SELECT store_id, variant_id, SUM(quantity_delta) AS total
            FROM stock_movements GROUP BY store_id, variant_id
        ) m ON m.store_id = sl.store_id AND m.variant_id = sl.variant_id
       WHERE sl.quantity_on_hand <> COALESCE(m.total, 0)
    `;
    expect(rows).toHaveLength(0);
  });
});

describe('multi-store isolation', () => {
  it('stops a manager reading a store they are not assigned to', async () => {
    const { db } = await import('../src/db/client.js');
    const schema = await import('../src/db/schema/index.js');

    const [otherStore] = await db
      .insert(schema.stores)
      .values({ code: 'OTH', name: 'Other Store' })
      .returning();

    const managerToken = await signIn('manager@test.local', 'copper-lantern-drift-97');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/inventory/levels?storeId=${otherStore!.id}`,
      headers: auth(managerToken),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('owner account', () => {
  // Regression: any administrator could reset the owner's password and read the
  // temporary one, taking over the account the deployment was bootstrapped with.
  it('hides the owner from other administrators and refuses their changes', async () => {
    const { db } = await import('../src/db/client.js');
    const { users } = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const [owner] = await db
      .update(users)
      .set({ isOwner: true })
      .where(eq(users.email, 'admin@test.local'))
      .returning({ id: users.id, fullName: users.fullName });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: auth(adminToken),
      payload: {
        email: 'second.admin@test.local',
        fullName: 'Second Admin',
        role: 'ADMIN',
        password: 'quartz-meadow-signal-42',
        storeIds: [storeId],
      },
    });
    expect(created.statusCode).toBe(201);
    const otherAdmin = await signIn('second.admin@test.local', 'quartz-meadow-signal-42');

    const attempts = [
      { method: 'PATCH', url: `/api/v1/admin/users/${owner!.id}`, payload: { fullName: 'Taken Over' } },
      { method: 'POST', url: `/api/v1/admin/users/${owner!.id}/reset-password` },
      { method: 'POST', url: `/api/v1/admin/users/${owner!.id}/unlock` },
      { method: 'DELETE', url: `/api/v1/admin/users/${owner!.id}` },
    ] as const;
    for (const attempt of attempts) {
      const response = await app.inject({ ...attempt, headers: auth(otherAdmin) });
      expect(response.statusCode, `${attempt.method} ${attempt.url}`).toBe(403);
    }

    // Nor can they see it: the owner is left out of everyone else's staff list.
    const othersView = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: auth(otherAdmin) });
    expect(othersView.json().users.map((u: { id: string }) => u.id)).not.toContain(owner!.id);
    const ownView = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: auth(adminToken) });
    expect(ownView.json().users.map((u: { id: string }) => u.id)).toContain(owner!.id);

    // The owner can still change their own account.
    const own = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${owner!.id}`,
      headers: auth(adminToken),
      payload: { fullName: owner!.fullName },
    });
    expect(own.statusCode).toBe(200);
  });
});

describe('sync device registration', () => {
  it('lets an administrator register a till, and re-registering moves it', async () => {
    const { db } = await import('../src/db/client.js');
    const schema = await import('../src/db/schema/index.js');
    const { eq } = await import('drizzle-orm');
    const newDevice = randomUUID();

    // Cashiers cannot enrol devices: a revoked tablet must not re-enrol itself.
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/devices',
      headers: auth(cashierToken),
      payload: { deviceId: newDevice, storeId, terminalId },
    });
    expect(denied.statusCode).toBe(403);

    const registered = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/devices',
      headers: auth(adminToken),
      payload: { deviceId: newDevice, storeId, terminalId, label: 'Till app on Android' },
    });
    expect(registered.statusCode).toBe(201);

    // Regression: re-registering only cleared the revoked flag, so a till moved
    // to another terminal kept its old binding.
    const [otherTerminal] = await db
      .insert(schema.terminals)
      .values({ storeId, code: 'T2', name: 'Second till', receiptPrefix: 'TSTT2' })
      .returning();
    await db.update(schema.syncDevices).set({ revokedAt: new Date() }).where(eq(schema.syncDevices.deviceId, newDevice));
    const moved = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/devices',
      headers: auth(adminToken),
      payload: { deviceId: newDevice, storeId, terminalId: otherTerminal!.id },
    });
    expect(moved.statusCode).toBe(201);
    const [device] = await db.select().from(schema.syncDevices).where(eq(schema.syncDevices.deviceId, newDevice));
    expect(device!.terminalId).toBe(otherTerminal!.id);
    expect(device!.revokedAt).toBeNull();
  });
});
