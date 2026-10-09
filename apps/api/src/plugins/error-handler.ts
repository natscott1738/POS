import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ERROR_CODES, type ApiErrorBody } from '@pos/shared';
import { AppError, isAppError } from '../core/errors.js';
import { isUniqueViolation } from '../core/idempotency.js';
import { isProduction } from '../config/env.js';

/**
 * Single exit point for every error. Clients see a stable code and a safe message;
 * the full error, including cause and SQL detail, goes only to the server log.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    if (isAppError(error)) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error, ctx: error.context }, error.message);
      } else {
        request.log.info({ code: error.code, ctx: error.context }, error.message);
      }
      return reply.status(error.statusCode).send(body(error.code, error.message, requestId, error.details));
    }

    if (error instanceof ZodError) {
      return reply.status(400).send(
        body(
          ERROR_CODES.VALIDATION_FAILED,
          'Request validation failed',
          requestId,
          error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        ),
      );
    }

    if (isUniqueViolation(error)) {
      request.log.warn({ err: error }, 'unique constraint violation');
      return reply
        .status(409)
        .send(body(ERROR_CODES.CONFLICT, 'That record already exists', requestId));
    }

    const fastifyError = error as { statusCode?: number; code?: string; message?: string };

    // Fastify's own 4xx (bad JSON, payload too large, rate limit) are safe to surface.
    if (typeof fastifyError.statusCode === 'number' && fastifyError.statusCode < 500) {
      const code = fastifyError.statusCode === 429 ? ERROR_CODES.RATE_LIMITED : ERROR_CODES.VALIDATION_FAILED;
      return reply
        .status(fastifyError.statusCode)
        .send(body(code, fastifyError.message ?? 'Request rejected', requestId));
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply
      .status(500)
      .send(
        body(
          ERROR_CODES.INTERNAL,
          isProduction ? 'An unexpected error occurred' : String(fastifyError.message ?? error),
          requestId,
        ),
      );
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send(body(ERROR_CODES.NOT_FOUND, 'Route not found', request.id));
  });
}

function body(
  code: ApiErrorBody['error']['code'],
  message: string,
  requestId: string,
  details?: Array<{ path: string; message: string }>,
): ApiErrorBody {
  return { error: { code, message, requestId, ...(details?.length ? { details } : {}) } };
}

export { AppError };
