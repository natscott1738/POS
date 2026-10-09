import type { FastifyInstance, FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import cors, { type FastifyCorsOptions } from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import underPressure from '@fastify/under-pressure';
import { env, isProduction } from '../config/env.js';
import { forbidden, rateLimited } from '../core/errors.js';
import { safeEqual } from '../core/crypto.js';

/**
 * The `__Host-` prefix is the strongest cookie binding available (origin-locked,
 * path=/, Secure, no Domain) but the browser rejects it without Secure or with a
 * Domain set. Names therefore track the deployment: strict in production, plain
 * over http in local development.
 */
const HOST_PREFIXED = env.COOKIE_SECURE && !env.COOKIE_DOMAIN;
export const REFRESH_COOKIE = HOST_PREFIXED ? '__Host-pos_rt' : 'pos_rt';
export const CSRF_COOKIE = HOST_PREFIXED ? '__Host-pos_csrf' : 'pos_csrf';
const CSRF_HEADER = 'x-csrf-token';

export async function registerSecurity(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    // The API serves JSON only, so the strictest possible policy applies.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    hsts: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    xFrameOptions: { action: 'deny' },
    noSniff: true,
    // Hide the framework so version-specific probes get nothing useful.
    hidePoweredBy: true,
  });

  /**
   * CORS is delegated per request so the request's own Host is available.
   *
   * A same-origin request still carries an Origin header on POST, so checking
   * the allowlist alone would reject the app talking to its own API whenever
   * CORS_ORIGINS was not set to the deployed hostname — a confusing, total
   * outage caused by a config value that should not matter in a same-origin
   * deployment. Same-origin is therefore recognised and allowed on its own merit.
   */
  await app.register(cors, (instance: FastifyInstance) => (request: FastifyRequest, callback: (err: Error | null, options: FastifyCorsOptions) => void) => {
    const origin = request.headers.origin;
    const host = request.headers.host;

    const sameOrigin = (() => {
      if (!origin || !host) return false;
      try {
        return new URL(origin).host === host;
      } catch {
        return false;
      }
    })();

    const allowed = !origin || sameOrigin || env.CORS_ORIGINS.includes(origin);
    if (!allowed) {
      instance.log.warn({ origin, host }, 'blocked cross-origin request');
    }

    callback(null, {
      // A disallowed origin gets no CORS headers, so the browser blocks the
      // response. The request is not rejected outright, which keeps behaviour
      // standard and avoids breaking non-browser clients.
      origin: allowed ? (origin ?? true) : false,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', CSRF_HEADER, 'Idempotency-Key', 'X-Device-Id'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    });
  });

  await app.register(cookie, {
    // Cookies are signed so tampering is detected before any lookup happens.
    secret: env.JWT_SECRET,
    parseOptions: {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: 'strict',
      path: '/',
    },
  });

  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    // Rate limit per authenticated user when we know them, otherwise per IP.
    keyGenerator: (request: FastifyRequest) => request.auth?.userId ?? request.ip,
    errorResponseBuilder: () => {
      throw rateLimited();
    },
    // A till that is merely busy should not be throttled with the public internet.
    allowList: (request) => request.url === '/health' || request.url === '/health/ready',
  });

  // Shed load rather than collapse: a POS must fail fast and visibly, not hang.
  await app.register(underPressure, {
    maxEventLoopDelay: 2000,
    maxHeapUsedBytes: 1_024 * 1_024 * 900,
    maxEventLoopUtilization: 0.98,
    message: 'Server is under heavy load',
    retryAfter: 15,
  });
}

/**
 * Double-submit CSRF check for the cookie-authenticated refresh endpoint.
 * Bearer-token routes are not vulnerable (a browser will not attach the header
 * automatically), so only cookie-bearing requests need this.
 */
export function verifyCsrf(request: FastifyRequest): void {
  const cookieToken = request.cookies[CSRF_COOKIE];
  const headerToken = request.headers[CSRF_HEADER];
  if (typeof cookieToken !== 'string' || typeof headerToken !== 'string') {
    throw forbidden('Missing CSRF token');
  }
  if (!safeEqual(cookieToken, headerToken)) throw forbidden('Invalid CSRF token');
}

export function setAuthCookies(
  reply: { setCookie: (name: string, value: string, opts: Record<string, unknown>) => unknown },
  refreshToken: string,
  csrfToken: string,
  expiresAt: Date,
): void {
  const base = {
    path: '/',
    secure: env.COOKIE_SECURE,
    sameSite: 'strict' as const,
    expires: expiresAt,
    // A Domain attribute is incompatible with the __Host- prefix.
    ...(env.COOKIE_DOMAIN && !HOST_PREFIXED ? { domain: env.COOKIE_DOMAIN } : {}),
  };
  // Refresh token: never readable by scripts.
  reply.setCookie(REFRESH_COOKIE, refreshToken, { ...base, httpOnly: true });
  // CSRF token: deliberately readable so the SPA can echo it in a header.
  reply.setCookie(CSRF_COOKIE, csrfToken, { ...base, httpOnly: false });
}

export function clearAuthCookies(reply: {
  clearCookie: (name: string, opts: Record<string, unknown>) => unknown;
}): void {
  const base = {
    path: '/',
    ...(env.COOKIE_DOMAIN && !HOST_PREFIXED ? { domain: env.COOKIE_DOMAIN } : {}),
  };
  reply.clearCookie(REFRESH_COOKIE, base);
  reply.clearCookie(CSRF_COOKIE, base);
}
