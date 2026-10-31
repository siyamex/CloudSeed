import { PGlite } from '@electric-sql/pglite';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type Deps } from '../src/app.js';
import type { OidcConfig } from '../src/auth/oidc.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPgDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { LocalStorage } from '../src/storage/local.js';
import type { StorageAdapter } from '../src/storage/types.js';

export const MIGRATIONS = path.resolve(import.meta.dirname, '../../migrations');

/** In-process Postgres (PGlite) behind the same Db interface the app uses with `pg`. */
export function createPgliteDb(pg = new PGlite()): Db {
  const wrap = (c: Pick<PGlite, 'query' | 'exec'>, root: boolean): Db => ({
    async query<T>(text: string, params?: unknown[]) {
      if (!params || params.length === 0) {
        const rs = await c.exec(text); // supports multi-statement scripts (migrations)
        const last = rs[rs.length - 1];
        return { rows: (last?.rows ?? []) as T[], rowCount: last?.rows.length || last?.affectedRows || 0 };
      }
      const r = await c.query<T>(text, params);
      return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
    },
    async tx<R>(fn: (db: Db) => Promise<R>) {
      if (!root) return fn(this);
      return pg.transaction((t) => fn(wrap(t as unknown as PGlite, false)));
    },
    async close() { if (root) await pg.close(); },
  });
  return wrap(pg, true);
}

/**
 * A fresh, empty database per call. Defaults to in-process PGlite; with TEST_DB=postgres (see `npm run test:pg`)
 * each call creates its own database on a real PostgreSQL server instead.
 */
export async function createTestDb(opts: { empty?: boolean } = {}): Promise<Db> {
  const adminUrl = process.env.TEST_PG_ADMIN_URL;
  if (!adminUrl) return createPgliteDb();
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const tpl = opts.empty ? undefined : process.env.TEST_PG_TEMPLATE; // `empty` = a bare database, e.g. to test migrations themselves.
  // migrated once by the global setup; cloning is far cheaper than migrating each time
  await admin.query(`CREATE DATABASE ${name}${tpl ? ` TEMPLATE ${tpl}` : ''}`);
  await admin.end();
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const db = createPgDb(u.toString(), 4);
  return {
    query: db.query.bind(db), tx: db.tx.bind(db),
    async close() {
      await db.close();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
      await a.end();
    },
  };
}

export interface FakeIdp {
  server: Server;
  cfg: OidcConfig;
  /** Describe the id_token the next token-endpoint call will return. */
  next: { claims: Record<string, unknown>; audience?: string; issuer?: string; badSignature?: boolean };
  close(): Promise<void>;
}

/** A real HTTP token + JWKS endpoint signing RS256 tokens, so jose verification is exercised end-to-end. */
export async function startFakeIdp(clientId = 'test-client'): Promise<FakeIdp> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const idp = { next: { claims: {} } } as FakeIdp;

  idp.server = createServer(async (req, res) => {
    if (req.url === '/jwks') {
      res.setHeader('content-type', 'application/json');
      return void res.end(JSON.stringify({ keys: [jwk] }));
    }
    if (req.url === '/token' && req.method === 'POST') {
      req.resume();
      const n = idp.next;
      const jwt = new SignJWT(n.claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuedAt().setExpirationTime('5m')
        .setIssuer(n.issuer ?? 'https://accounts.google.com').setAudience(n.audience ?? clientId);
      const id_token = await jwt.sign(n.badSignature ? other.privateKey : privateKey);
      res.setHeader('content-type', 'application/json');
      return void res.end(JSON.stringify({ id_token, access_token: 'unused' }));
    }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => idp.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(idp.server.address() as AddressInfo).port}`;
  idp.cfg = {
    clientId, clientSecret: 'secret', redirectUri: 'http://localhost:8080/api/v1/auth/google/callback',
    authEndpoint: `${base}/auth`, tokenEndpoint: `${base}/token`, jwksUri: `${base}/jwks`,
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
  };
  idp.close = () => new Promise((r) => idp.server.close(() => r()));
  return idp;
}

export interface TestEnv {
  app: FastifyInstance;
  db: Db;
  config: Config;
  idp: FakeIdp;
  storage: LocalStorage;
  close(): Promise<void>;
}

export async function createTestEnv(
  env: Record<string, string> = {},
  over: { storage?: StorageAdapter; storages?: Deps['storages'] } = {},
): Promise<TestEnv> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudseed-'));
  const config = loadConfig({
    NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:8080', SESSION_SECRET: 'x'.repeat(40),
    LOCAL_STORAGE_ROOT: path.join(dir, 'storage'), LOCAL_TMP_DIR: path.join(dir, 'tmp'),
    DEFAULT_USER_QUOTA_BYTES: String(1024 * 1024), MAX_FILE_SIZE_BYTES: String(512 * 1024),
    ADMIN_EMAILS: 'admin@example.com', AUTH_RATE_LIMIT_PER_MIN: '10000', RATE_LIMIT_PER_MIN: '1000000',
    DOWNLOAD_WORKDIR: path.join(dir, 'downloads'), DOWNLOAD_ALLOWED_CIDRS: '127.0.0.0/8', DOWNLOAD_ALLOWED_PORTS: '80,443',
    WORKER_POLL_MS: '20', DOWNLOAD_BACKOFF_BASE_MS: '30', DOWNLOAD_BACKOFF_MAX_MS: '200', DOWNLOAD_IDLE_TIMEOUT_MS: '1000',
    DOWNLOAD_CONNECT_TIMEOUT_MS: '2000', ...env,
  } as NodeJS.ProcessEnv);
  const db = await createTestDb();
  await migrate(db, MIGRATIONS);
  const idp = await startFakeIdp();
  const storage = new LocalStorage(config.LOCAL_STORAGE_ROOT, config.LOCAL_TMP_DIR);
  const app = await buildApp({ config, db, storage: over.storage ?? storage, storages: over.storages ?? { local: storage }, oidc: idp.cfg });
  return {
    app, db, config, idp, storage,
    close: async () => { await app.close(); await idp.close(); await db.close(); },
  };
}

export interface Session { cookie: string; csrf: string; userId: string }

/** Drives the real login + callback flow against the fake IdP and returns the resulting session. */
export async function login(t: TestEnv, sub: string, email: string, extra: Record<string, unknown> = {}): Promise<Session> {
  const loc = await beginLogin(t);
  t.idp.next = { claims: { sub, email, email_verified: true, name: email.split('@')[0], nonce: loc.nonce, ...extra } };
  const cb = await t.app.inject({ method: 'GET', url: `/api/v1/auth/google/callback?code=abc&state=${loc.state}` });
  const set = cb.cookies.find((c) => c.name === 'cs_session');
  if (!set) throw new Error(`login failed: ${cb.headers.location}`);
  const cookie = `cs_session=${set.value}`;
  const me = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
  const body = me.json();
  return { cookie, csrf: body.csrfToken, userId: body.user.id };
}

export async function beginLogin(t: TestEnv) {
  const r = await t.app.inject({ method: 'GET', url: '/api/v1/auth/google/login' });
  const u = new URL(r.headers.location as string);
  return { status: r.statusCode, url: u, state: u.searchParams.get('state')!, nonce: u.searchParams.get('nonce')! };
}

export const authed = (s: Session) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf });

export function multipartBody(filename: string, content: Buffer | string) {
  const boundary = '----cstest' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
