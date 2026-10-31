import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cookieName } from '../src/app.js';
import { createSession } from '../src/auth/session.js';
import { createVault } from '../src/crypto.js';
import { authed, createTestEnv, type Session, type TestEnv } from './helpers.js';

const PW = 'correct horse battery staple';
const CLIENT = 'abc123-test.apps.googleusercontent.com';
const SECRET = 'GOCSPX-super-secret-value-1234567890';

async function adminOf(t: TestEnv): Promise<Session> {
  const r = await t.app.inject({ method: 'POST', url: '/api/v1/auth/setup', remoteAddress: '127.0.0.1', headers: { 'content-type': 'application/json' }, payload: { email: 'root@example.com', password: PW } });
  const c = r.cookies.find((x) => /session/.test(x.name))!;
  const m = (await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `${c.name}=${c.value}` } })).json();
  return { cookie: `${c.name}=${c.value}`, csrf: m.csrfToken, userId: m.user.id };
}
async function plainUser(t: TestEnv): Promise<Session> {
  const id = (await t.db.query<{ id: string }>(`INSERT INTO users (email, email_verified) VALUES ('plain@example.com', TRUE) RETURNING id`)).rows[0]!.id;
  await t.db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 1)`, [id]);
  await t.db.query(`INSERT INTO storage_quotas (user_id, quota_bytes) VALUES ($1, 1000000)`, [id]);
  const token = await createSession(t.db, id, 24, {});
  const csrf = (await t.db.query<{ csrf_token: string }>(`SELECT csrf_token FROM sessions WHERE user_id = $1`, [id])).rows[0]!.csrf_token;
  return { cookie: `${cookieName(t.config)}=${token}`, csrf, userId: id };
}
const api = (t: TestEnv, s: Session | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { ...(s ? authed(s) : {}), ...headers }, payload: payload as object, remoteAddress: '127.0.0.1' });
const googleLogin = (t: TestEnv, host?: string) => t.app.inject({ method: 'GET', url: '/api/v1/auth/google/login', remoteAddress: '127.0.0.1', headers: host ? { host } : {} });

describe('Google sign-in set up from the admin panel', () => {
  let t: TestEnv; let admin: Session;
  beforeAll(async () => { t = await createTestEnv({ ADMIN_EMAILS: '', PUBLIC_URL: 'https://cloud.example.com' }, { oidc: null }); admin = await adminOf(t); });
  afterAll(async () => { await t.close(); });

  it('starts with nothing configured and explains how to get started', async () => {
    const v = (await api(t, admin, 'GET', '/admin/auth')).json();
    expect(v.google).toMatchObject({ enabled: false, source: 'none', clientId: '', secretSet: false, redirectUri: 'https://cloud.example.com/api/v1/auth/google/callback' });
    expect(v.local.accounts).toBe(1);
    expect((await googleLogin(t)).statusCode).toBe(503);
    expect((await api(t, null, 'GET', '/auth/config')).json().googleConfigured).toBe(false);
  });

  it('only administrators can see or change it', async () => {
    const u = await plainUser(t);
    for (const [m, url] of [['GET', '/admin/auth'], ['PUT', '/admin/auth/google'], ['DELETE', '/admin/auth/google'], ['PUT', '/admin/auth/public-url'], ['POST', '/admin/auth/google/test']] as const) {
      expect((await api(t, u, m, url, {})).statusCode, `${m} ${url}`).toBe(403);
      expect((await api(t, null, m, url, {})).statusCode, `${m} ${url} anonymous`).toBe(401);
    }
  });

  it('checks what is typed before saving it', async () => {
    const put = (b: unknown) => api(t, admin, 'PUT', '/admin/auth/google', b);
    expect((await put({ clientId: 'not-a-google-id', clientSecret: SECRET, enabled: true })).json().error.code).toBe('invalid_client_id');
    expect((await put({ clientId: CLIENT, clientSecret: 'short', enabled: true })).json().error.code).toBe('invalid_client_secret');
    expect((await put({ clientId: CLIENT, enabled: true })).json().error.code).toBe('incomplete'); // no secret yet
    expect((await put({ clientId: '', clientSecret: SECRET, enabled: true })).json().error.code).toBe('incomplete');
    expect((await put({ clientId: CLIENT, clientSecret: SECRET, enabled: true, extra: 1 })).statusCode).toBe(400);
    expect((await api(t, admin, 'GET', '/admin/auth')).json().google.source).toBe('none'); // nothing was saved
  });

  it('saves the credentials, encrypts the secret, never shows it again, and starts using them at once', async () => {
    const r = await api(t, admin, 'PUT', '/admin/auth/google', { clientId: CLIENT, clientSecret: SECRET, enabled: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().google).toMatchObject({ enabled: true, source: 'database', clientId: CLIENT, secretSet: true });
    expect(r.body).not.toContain(SECRET);
    expect((await api(t, admin, 'GET', '/admin/auth')).body).not.toContain(SECRET);

    const rows = (await t.db.query<{ key: string; value: unknown }>(`SELECT key, value FROM application_settings WHERE key LIKE 'google_%'`)).rows;
    expect(JSON.stringify(rows)).not.toContain(SECRET); // not in the database in the clear
    const enc = rows.find((x) => x.key === 'google_client_secret_enc')!.value as string;
    expect(createVault(t.config).decrypt(Buffer.from(enc, 'base64'), 'setting:google_client_secret')).toBe(SECRET); // but recoverable with the key
    expect(() => createVault(t.config).decrypt(Buffer.from(enc, 'base64'), 'some-other-purpose')).toThrow(); // and bound to this purpose

    const audit = (await t.db.query<any>(`SELECT metadata FROM audit_logs WHERE action = 'admin.google_config' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(audit.metadata).toEqual({ enabled: true, clientId: CLIENT, secretChanged: true });

    expect((await api(t, null, 'GET', '/auth/config')).json().googleConfigured).toBe(true);
    const go = await googleLogin(t);
    expect(go.statusCode).toBe(302);
    const loc = new URL(go.headers.location as string);
    expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(loc.searchParams.get('client_id')).toBe(CLIENT);
    expect(loc.searchParams.get('redirect_uri')).toBe('https://cloud.example.com/api/v1/auth/google/callback');
    expect(loc.searchParams.get('scope')).toBe('openid email profile'); // identity only
    expect(loc.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('keeps the saved secret when only the switch changes, and refuses a new ID without a new secret', async () => {
    const off = await api(t, admin, 'PUT', '/admin/auth/google', { clientId: CLIENT, enabled: false });
    expect(off.json().google).toMatchObject({ enabled: false, secretSet: true, clientId: CLIENT });
    expect((await googleLogin(t)).statusCode).toBe(503);
    expect((await api(t, null, 'GET', '/auth/config')).json().googleConfigured).toBe(false);
    const on = await api(t, admin, 'PUT', '/admin/auth/google', { clientId: CLIENT, enabled: true });
    expect(on.json().google).toMatchObject({ enabled: true, secretSet: true });
    expect((await googleLogin(t)).statusCode).toBe(302);
    const other = await api(t, admin, 'PUT', '/admin/auth/google', { clientId: 'another-app.apps.googleusercontent.com', enabled: true });
    expect(other.statusCode).toBe(422); // the old secret belongs to the old ID
    expect(other.json().error.code).toBe('incomplete');
  });

  it('forgets it all on request', async () => {
    const r = await api(t, admin, 'DELETE', '/admin/auth/google');
    expect(r.json().google).toMatchObject({ enabled: false, source: 'none', secretSet: false });
    expect((await t.db.query(`SELECT 1 FROM application_settings WHERE key LIKE 'google_%'`)).rowCount).toBe(0);
    expect((await googleLogin(t)).statusCode).toBe(503);
  });

  it('can check what it can without signing in', async () => {
    await api(t, admin, 'PUT', '/admin/auth/google', { clientId: CLIENT, clientSecret: SECRET, enabled: true });
    const r = (await api(t, admin, 'POST', '/admin/auth/google/test')).json();
    expect(r.redirectUri).toBe('https://cloud.example.com/api/v1/auth/google/callback');
    expect(typeof r.reachable).toBe('boolean');
    expect(r.problems.filter((p: string) => /client ID|client secret/.test(p))).toEqual([]);
    expect(r.note).toMatch(/only be confirmed by actually signing in/);
  });
});

describe('the environment still works, and the admin panel overrides it', () => {
  let t: TestEnv; let admin: Session;
  beforeAll(async () => {
    t = await createTestEnv({ ADMIN_EMAILS: '', PUBLIC_URL: 'https://cloud.example.com', GOOGLE_CLIENT_ID: 'from-env.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'env-secret-value-123456' }, { oidc: null });
    admin = await adminOf(t);
  });
  afterAll(async () => { await t.close(); });
  const clientOf = async () => new URL((await googleLogin(t)).headers.location as string).searchParams.get('client_id');

  it('uses the environment until something is saved, then the saved values, and falls back when cleared or switched off', async () => {
    expect((await api(t, admin, 'GET', '/admin/auth')).json().google).toMatchObject({ source: 'environment', enabled: true, clientId: 'from-env.apps.googleusercontent.com', secretSet: true });
    expect(await clientOf()).toBe('from-env.apps.googleusercontent.com');
    await api(t, admin, 'PUT', '/admin/auth/google', { clientId: CLIENT, clientSecret: SECRET, enabled: true });
    expect(await clientOf()).toBe(CLIENT);
    await api(t, admin, 'PUT', '/admin/auth/google', { clientId: CLIENT, enabled: false });
    expect((await googleLogin(t)).statusCode).toBe(503); // an explicit "off" wins over the environment
    await api(t, admin, 'DELETE', '/admin/auth/google');
    expect(await clientOf()).toBe('from-env.apps.googleusercontent.com');
  });
});

describe('the public address', () => {
  let t: TestEnv; let admin: Session;
  beforeAll(async () => { t = await createTestEnv({ ADMIN_EMAILS: '', PUBLIC_URL: '', ALLOW_INSECURE_HTTP: 'true' }, { oidc: null }); admin = await adminOf(t); });
  afterAll(async () => { await t.close(); });
  const put = (url: string) => api(t, admin, 'PUT', '/admin/auth/public-url', { url });

  it('follows the address the page was opened on until an administrator sets one', async () => {
    expect(t.config.publicUrlConfigured).toBe(false);
    const v = (await api(t, admin, 'GET', '/admin/auth', undefined, { host: 'pi.local:8080' })).json();
    expect(v.publicUrl).toMatchObject({ value: null, inUse: 'http://pi.local:8080', secure: false });
    expect(v.google.redirectUri).toBe('http://pi.local:8080/api/v1/auth/google/callback');
  });

  it('accepts only an address, not a path or something else', async () => {
    for (const bad of ['nonsense', 'ftp://x.example.com', 'https://x.example.com/some/path', 'https://x.example.com/?a=1', 'https://user:pw@x.example.com']) {
      expect((await put(bad)).json().error.code, bad).toBe('invalid_url');
    }
  });

  it('applies a new address at once: links, the Google redirect and the cookie setting', async () => {
    const r = await put('https://cloud.example.com/');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().publicUrl).toMatchObject({ value: 'https://cloud.example.com', secure: true });
    expect(t.config.PUBLIC_URL).toBe('https://cloud.example.com');
    expect(t.config.cookieSecure).toBe(true);
    expect(r.json().google.redirectUri).toBe('https://cloud.example.com/api/v1/auth/google/callback');
    expect((await t.db.query<any>(`SELECT metadata FROM audit_logs WHERE action = 'admin.public_url'`)).rowCount).toBe(1);
  });

  it('goes back to the original behaviour when cleared', async () => {
    const r = await put('');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().publicUrl.value).toBeNull();
    expect(t.config.publicUrlConfigured).toBe(false);
    expect(t.config.cookieSecure).toBe(false);
  });
});
