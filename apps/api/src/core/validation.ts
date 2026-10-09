import type { FastifyRequest } from 'fastify';
import { ZodError, type ZodSchema, type z } from 'zod';
import { badRequest } from './errors.js';

/**
 * Every handler parses its input through one of these. Anything not described by
 * a schema is dropped, so unexpected fields cannot reach the database layer.
 */
export function parse<S extends ZodSchema>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw toBadRequest(result.error);
  return result.data;
}

export const parseBody = <S extends ZodSchema>(request: FastifyRequest, schema: S): z.infer<S> =>
  parse(schema, request.body);

export const parseQuery = <S extends ZodSchema>(request: FastifyRequest, schema: S): z.infer<S> =>
  parse(schema, request.query);

export const parseParams = <S extends ZodSchema>(request: FastifyRequest, schema: S): z.infer<S> =>
  parse(schema, request.params);

function toBadRequest(error: ZodError) {
  const details = error.issues.slice(0, 25).map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
  return badRequest('Request validation failed', details);
}
