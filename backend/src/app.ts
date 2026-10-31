import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { loadSession, safeEqual, type AuthContext } from './auth/session.js';
import type { OidcConfig } from './auth/oidc.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { HttpError, forbidden, unauthorized } from './errors.js';
import { authRoutes } from './routes/auth.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { downloadRoutes } from './routes/downloads.js';
import type { Guard } from './downloads/ssrf.js';
import { fileRoutes } from './routes/files.js';
import { mediaRoutes } from './routes/media.js';
import { accountRoutes } from './routes/account.js';
import { adminRoutes } from './routes/admin.js';
import { opsRoutes } from './routes/ops.js';
import { HttpMetrics } from './metrics.js';
import { notificationRoutes } from './routes/notifications.js';
import { shareRoutes } from './routes/shares.js';
import { telegramRoutes } from './routes/telegram.js';
import { trashRoutes } from './routes/trash.js';
import { createVault, type Vault } from './crypto.js';
import type { StorageAdapter } from './storage/types.js';

declare module 'fastify' {
  interface FastifyRequest { auth: AuthContext | null }
}

export interface Deps {
  config: Config;
  db: Db;
  /** Adapter used for new writes. */
  storage: StorageAdapter;
  /** Other adapters that may still hold existing files (e.g. after switching backends). */
  storages?: Partial<Record<StorageAdapter['kind'], StorageAdapter>>;
  oidc: OidcConfig | null;
  /** SSRF guard for user-submitted URLs; built from config when omitted. */
  guard?: Guard;
  /** Encrypts stored credentials; built from config when omitted. */
  vault?: Vault;
}

/** Resolves the adapter that holds a file; fails clearly if that backend is not configured. */
export function adapterFor(deps: Pick<Deps, 'storage' | 'storages'>, kind: string): StorageAdapter {
  if (deps.storage.kind === kind) return deps.storage;
  const a = deps.storages?.[kind as StorageAdapter['kind']];
  if (!a) throw new HttpError(503, 'storage_unavailable', `The ${kind} storage backend holding this file is not configured`);
  return a;
}

export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function cookieName(cfg: Config) {
  return cfg.cookieSecure ? '__Host-cs_session' : 'cs_session';
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const { config, db } = deps;
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : {
      level: config.LOG_LEVEL,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'],
    },
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) || randomUUID(),
    trustProxy: config.NODE_ENV === 'production',
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: config.RATE_LIMIT_PER_MIN, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { files: 1, fields: 10, fieldSize: 1024 } });

  app.addHook('onSend', async (req, reply) => {
    // Defaults only: a route that set its own value (e.g. no-referrer on public share pages, caching on thumbnails) keeps it.
    const setDefault = (k: string, v: string) => { if (!reply.hasHeader(k)) reply.header(k, v); };
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    setDefault('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    reply.header('cross-origin-opener-policy', 'same-origin');
    if (config.cookieSecure) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (req.url.startsWith('/api/')) setDefault('cache-control', 'no-store');
  });

  app.decorateRequest('auth', null);
  const metrics = new HttpMetrics();
  app.addHook('onResponse', async (req, reply) => {
    metrics.record(req.method, req.routeOptions?.url ?? 'unmatched', reply.statusCode, reply.elapsedTime / 1000);
  });

  // Resolve the session, then enforce CSRF + Origin on state-changing requests.
  app.addHook('onRequest', async (req) => {
    const tok = req.cookies[cookieName(config)];
    req.auth = tok ? await loadSession(db, tok) : null;

    if (SAFE_METHODS.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin && origin !== new URL(config.PUBLIC_URL).origin) throw forbidden('Cross-origin request rejected');
    if (req.auth) {
      const sent = req.headers['x-csrf-token'];
      if (typeof sent !== 'string' || !safeEqual(sent, req.auth.csrfToken)) throw forbidden('Missing or invalid CSRF token');
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    let status = 500, code = 'internal_error', message = 'Internal server error', details: unknown;
    if (err instanceof HttpError) { status = err.status; code = err.code; message = err.message; details = err.details; }
    else if (err instanceof ZodError) {
      status = 400; code = 'validation_error';
      message = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    } else if (err.statusCode && err.statusCode < 500) {
      status = err.statusCode; code = err.statusCode === 429 ? 'rate_limited' : 'bad_request'; message = err.message;
    } else req.log.error({ err }, 'unhandled error');
    void reply.status(status).send({ error: { code, message, requestId: req.id, ...(details === undefined ? {} : { details }) } });
  });
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({ error: { code: 'not_found', message: 'Route not found', requestId: req.id } });
  });

  app.get('/api/v1/health', async () => {
    await db.query('SELECT 1');
    return { status: 'ok' };
  });

  await app.register(authRoutes(deps), { prefix: '/api/v1/auth' });
  await app.register(fileRoutes(deps), { prefix: '/api/v1' });
  await app.register(trashRoutes(deps), { prefix: '/api/v1' });
  await app.register(shareRoutes(deps), { prefix: '/api/v1' });
  await app.register(mediaRoutes(deps), { prefix: '/api/v1' });
  await app.register(downloadRoutes(deps), { prefix: '/api/v1' });
  await app.register(telegramRoutes({ ...deps, vault: deps.vault ?? createVault(config) }), { prefix: '/api/v1' });
  await app.register(accountRoutes(deps), { prefix: '/api/v1' });
  await app.register(adminRoutes(deps), { prefix: '/api/v1' });
  await app.register(opsRoutes(deps, metrics), { prefix: '/api/v1' });
  await app.register(notificationRoutes(deps), { prefix: '/api/v1' });
  await app.register(dashboardRoutes(deps), { prefix: '/api/v1' });
  return app;
}

export function requireAdmin(req: { auth: AuthContext | null }): AuthContext {
  const a = requireAuth(req);
  if (!a.roles.includes('admin')) throw forbidden('Administrator access required');
  return a;
}

export function requireAuth(req: { auth: AuthContext | null }): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
