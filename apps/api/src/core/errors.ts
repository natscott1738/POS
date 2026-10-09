import { ERROR_CODES, type ErrorCode } from '@pos/shared';

export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * The only error type that is allowed to reach the client verbatim. Anything else
 * is logged in full and reported as a generic INTERNAL, so stack traces, SQL and
 * provider payloads never leak to a till.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: ErrorDetail[];
  /** Extra context for the log only; never serialised into a response. */
  readonly context?: Record<string, unknown>;
  readonly expose = true;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    options: { details?: ErrorDetail[]; context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.context = options.context;
  }
}

export const badRequest = (message: string, details?: ErrorDetail[]) =>
  new AppError(400, ERROR_CODES.VALIDATION_FAILED, message, { details });

export const unauthenticated = (message = 'Authentication required') =>
  new AppError(401, ERROR_CODES.UNAUTHENTICATED, message);

export const forbidden = (message = 'You do not have permission to do that') =>
  new AppError(403, ERROR_CODES.FORBIDDEN, message);

export const mfaRequired = (message = 'Multi-factor authentication is required') =>
  new AppError(401, ERROR_CODES.MFA_REQUIRED, message);

export const notFound = (what = 'Resource') =>
  new AppError(404, ERROR_CODES.NOT_FOUND, `${what} not found`);

export const conflict = (message: string, context?: Record<string, unknown>) =>
  new AppError(409, ERROR_CODES.CONFLICT, message, { context });

export const idempotencyMismatch = () =>
  new AppError(
    409,
    ERROR_CODES.IDEMPOTENCY_MISMATCH,
    'This idempotency key was already used with a different request body',
  );

export const insufficientStock = (details: ErrorDetail[]) =>
  new AppError(409, ERROR_CODES.INSUFFICIENT_STOCK, 'Insufficient stock for one or more items', { details });

export const unbalancedSale = (message: string, context?: Record<string, unknown>) =>
  new AppError(400, ERROR_CODES.UNBALANCED_SALE, message, { context });

export const paymentDeclined = (message: string, context?: Record<string, unknown>) =>
  new AppError(402, ERROR_CODES.PAYMENT_DECLINED, message, { context });

export const paymentTimeout = (message = 'The payment timed out') =>
  new AppError(408, ERROR_CODES.PAYMENT_TIMEOUT, message);

export const integrationUnavailable = (name: string, cause?: unknown) =>
  new AppError(503, ERROR_CODES.INTEGRATION_UNAVAILABLE, `${name} is not available right now`, { cause });

export const rateLimited = (message = 'Too many requests') =>
  new AppError(429, ERROR_CODES.RATE_LIMITED, message);

export const shiftRequired = () =>
  new AppError(409, ERROR_CODES.SHIFT_REQUIRED, 'Open a shift before taking payments');

export const periodClosed = (message = 'That accounting period is closed') =>
  new AppError(409, ERROR_CODES.PERIOD_CLOSED, message);

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
