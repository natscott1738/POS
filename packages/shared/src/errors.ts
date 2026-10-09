/** Stable, machine-readable error codes shared by API and client. */
export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  MFA_REQUIRED: 'MFA_REQUIRED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  IDEMPOTENCY_MISMATCH: 'IDEMPOTENCY_MISMATCH',
  RATE_LIMITED: 'RATE_LIMITED',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  PAYMENT_DECLINED: 'PAYMENT_DECLINED',
  PAYMENT_TIMEOUT: 'PAYMENT_TIMEOUT',
  PAYMENT_ALREADY_SETTLED: 'PAYMENT_ALREADY_SETTLED',
  UNBALANCED_SALE: 'UNBALANCED_SALE',
  SHIFT_REQUIRED: 'SHIFT_REQUIRED',
  PERIOD_CLOSED: 'PERIOD_CLOSED',
  INTEGRATION_UNAVAILABLE: 'INTEGRATION_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Field-level detail; never contains secrets or internal identifiers. */
    details?: Array<{ path: string; message: string }>;
    requestId: string;
  };
}
