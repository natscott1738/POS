import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  process.env.SKIP_DOTENV = 'true';
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://user:pass@127.0.0.1:5432/test';
  process.env.JWT_SECRET = 'a-test-secret-that-is-at-least-32-characters';
  process.env.ENCRYPTION_KEY = 'b'.repeat(64);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Daraja STK request', () => {
  it("caps TransactionDesc at Daraja's 13-character limit", async () => {
    const responses = [
      new Response(JSON.stringify({ access_token: 'test-token', expires_in: '3600' }), { status: 200 }),
      new Response(
        JSON.stringify({
          ResponseCode: '0',
          ResponseDescription: 'Accepted',
          CheckoutRequestID: 'test-checkout-id',
          MerchantRequestID: 'test-merchant-id',
          CustomerMessage: 'Accepted',
        }),
        { status: 200 },
      ),
    ];
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => responses.shift()!);
    vi.stubGlobal('fetch', fetchMock);

    const { resetTokenCacheForTests, stkPush } = await import('../src/modules/payments/mpesa/client.js');
    resetTokenCacheForTests();

    await stkPush({
      amountCents: 18_000,
      phone: '254708374149',
      accountReference: 'SALE-123456789',
      description: 'Payment sale-123456',
      callbackUrl: 'https://pos.example.invalid/callback',
    });

    const requestOptions = fetchMock.mock.calls[1]?.[1];
    const requestBody = JSON.parse(String(requestOptions?.body)) as Record<string, unknown>;
    expect(requestBody.TransactionDesc).toBe('Payment sale-');
    expect(String(requestBody.TransactionDesc).length).toBeLessThanOrEqual(13);
    expect(String(requestBody.AccountReference).length).toBeLessThanOrEqual(12);

    resetTokenCacheForTests();
  });
});
