import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cookieName } from '../src/app.js';
import { checkPasswordPolicy } from '../src/auth/local.js';
import { createSession } from '../src/auth/session.js';
import { setupCode } from '../src/auth/setup.js';
import { authed, createTestEnv, type Session, type TestEnv } from './helpers.js';

const PW = 'correct horse battery staple';
const sessionCookie = (r: { cookies: { name: string; value: string }[] }) => r.cookies.find((c) => /session/.test(c.name));

/** A server with nobody on it yet and no Google override: the real first-run situation. */
const fresh = (env: Record<string, string> = {}) => createTestEnv({ ADMIN_EMAILS: '', ...env }, { oidc: null });
const post = (t: TestEnv, url: string, payload: unknown, o: { remoteAddress?: string; headers?: Record<string, string> } = {}) =>
  t.app.inject({ method: 'POST', url: `/api/v1${url}`, payload: payload as object, remoteAddress: o.remoteAddress ?? '127.0.0.1', headers: { 'content-type': 'application/json', ...o.headers } });
const cfgOf = async (t: TestEnv, o: { remoteAddress?: string; headers?: Record<string, string> } = {}) =>
  (await t.app.inject({ method: 'GET', url: '/api/v1/auth/config', remoteAddress: o.remoteAddress ?? '127.0.0.1', headers: o.headers })).json();
/** An ordinary account that exists without any sign-in flow (this server has no Google behind it). */
async function plainUser(t: TestEnv, email: string): Promise<Session> {
  const id = (await t.db.query<{ id: string }>(`INSERT INTO users (email, email_verified) VALUES ($1, TRUE) RETURNING id`, [email])).rows[0]!.id;
  await t.db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 1)`, [id]);
  await t.db.query(`INSERT INTO storage_quotas (user_id, quota_bytes) VALUES ($1, 1000000)`, [id]);
  const token = await createSession(t.db, id, 24, {});
  const csrf = (await t.db.query<{ csrf_token: string }>(`SELECT csrf_token FROM sessions WHERE user_id = $1`, [id])).rows[0]!.csrf_token;
  return { cookie: `${cookieName(t.config)}=${token}`, csrf, userId: id };
}
const me = (t: TestEnv, cookie: string) => t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });

describe('password rules', () => {
  it.each([
    ['short', 'abc123XYZ', /at least 10/], ['repetitive', 'aaaaaaaaaaaa', /repetitive/], ['common', 'my-password-is-fine', /too easy/], ['contains the email name', 'ada.lovelace!!99', /email/],
  ])('rejects a %s password', (_n, pw, re) => expect(checkPasswordPolicy(pw, 'ada.lovelace@example.com')).toMatch(re));
  it('accepts a long passphrase', () => expect(checkPasswordPolicy(PW, 'x@example.com')).toBeNull());
});

describe('first-run setup', () => {
  let t: TestEnv;
  beforeAll(async () => { t = await fresh(); });
  afterAll(async () => { await t.close(); });

  it('tells the page that setup is needed, and whether this visitor must type a code', async () => {
    for (const ip of ['127.0.0.1', '192.168.1.40', '10.0.0.7', '172.18.0.5']) expect(await cfgOf(t, { remoteAddress: ip })).toMatchObject({ needsSetup: true, setupCodeRequired: false, localLogin: false });
    expect(await cfgOf(t, { remoteAddress: '93.184.216.34' })).toMatchObject({ needsSetup: true, setupCodeRequired: true });
    // a tunnel or proxy on the private network that forwards a public visitor's address counts as public
    expect((await cfgOf(t, { remoteAddress: '172.18.0.5', headers: { 'x-forwarded-for': '8.8.4.4' } })).setupCodeRequired).toBe(true);
    expect((await cfgOf(t, { remoteAddress: '172.18.0.5', headers: { 'cf-connecting-ip': '8.8.4.4' } })).setupCodeRequired).toBe(true);
    expect((await cfgOf(t, { remoteAddress: '172.18.0.5', headers: { forwarded: 'for=8.8.4.4;proto=https' } })).setupCodeRequired).toBe(true);
    expect((await cfgOf(t, { remoteAddress: '172.18.0.5', headers: { 'x-forwarded-for': '192.168.1.20, 10.0.0.2' } })).setupCodeRequired).toBe(false);
    expect((await cfgOf(t, { remoteAddress: '172.18.0.5', headers: { 'x-forwarded-for': 'unknown' } })).setupCodeRequired).toBe(true); // unreadable = could be anywhere
  });

  it('refuses a stranger without the code, and lets anyone with the right code finish', async () => {
    const body = { email: 'owner@example.com', password: PW };
    const stranger = { remoteAddress: '93.184.216.50' };
    const none = await post(t, '/auth/setup', body, stranger);
    expect(none.statusCode).toBe(403);
    expect(none.json().error.code).toBe('setup_code_required');
    expect((await post(t, '/auth/setup', { ...body, setupCode: 'AAAA-AAAA' }, stranger)).statusCode).toBe(403);
    expect((await post(t, '/auth/setup', { ...body, setupCode: 'x'.repeat(30) }, stranger)).statusCode).toBe(403);
    expect((await cfgOf(t)).needsSetup).toBe(true); // nothing was created
    expect(setupCode()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('rejects weak passwords and bad emails without creating anything', async () => {
    expect((await post(t, '/auth/setup', { email: 'owner@example.com', password: 'short' })).json().error.code).toBe('weak_password');
    expect((await post(t, '/auth/setup', { email: 'not-an-email', password: PW })).statusCode).toBe(400);
    expect((await cfgOf(t)).needsSetup).toBe(true);
  });

  it('creates the administrator once, signs them in, and then closes for good', async () => {
    const r = await post(t, '/auth/setup', { email: 'Owner@Example.com', password: PW, displayName: 'The Owner' });
    expect(r.statusCode, r.body).toBe(201);
    const c = sessionCookie(r)!;
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
    const who = (await me(t, `${c.name}=${c.value}`)).json();
    expect(who.user).toMatchObject({ email: 'owner@example.com', displayName: 'The Owner', hasPassword: true });
    expect(who.user.roles.sort()).toEqual(['admin', 'user']);
    expect((await t.db.query<any>(`SELECT quota_bytes FROM storage_quotas WHERE user_id = $1`, [who.user.id])).rowCount).toBe(1);
    const stored = (await t.db.query<any>(`SELECT password_hash FROM local_credentials WHERE user_id = $1`, [who.user.id])).rows[0].password_hash;
    expect(stored).toMatch(/^scrypt\$/);
    expect(stored).not.toContain(PW);
    expect((await t.db.query(`SELECT 1 FROM audit_logs WHERE action = 'admin.setup'`)).rowCount).toBe(1);
    expect(await cfgOf(t)).toMatchObject({ needsSetup: false, setupCodeRequired: false, localLogin: true });

    const again = await post(t, '/auth/setup', { email: 'intruder@example.com', password: PW });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('setup_done');
    expect((await t.db.query(`SELECT 1 FROM users`)).rowCount).toBe(1);
  });
});

describe('two people finishing setup at the same moment', () => {
  it('only one becomes the administrator', async () => {
    const t = await fresh();
    try {
      const rs = await Promise.all([1, 2, 3].map((i) => post(t, '/auth/setup', { email: `racer${i}@example.com`, password: `${PW} ${i}` })));
      expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
      expect((await t.db.query(`SELECT 1 FROM users`)).rowCount).toBe(1);
      expect((await t.db.query(`SELECT 1 FROM user_roles WHERE role_id = 2`)).rowCount).toBe(1);
    } finally { await t.close(); }
  });

  it('with the right code, a remote visitor can finish setup', async () => {
    const t = await fresh();
    try {
      const r = await post(t, '/auth/setup', { email: 'remote@example.com', password: PW, setupCode: setupCode().toLowerCase() }, { remoteAddress: '93.184.216.9' });
      expect(r.statusCode, r.body).toBe(201);
    } finally { await t.close(); }
  });
});

describe('signing in with a password', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await fresh();
    expect((await post(t, '/auth/setup', { email: 'admin@example.com', password: PW })).statusCode).toBe(201);
  });
  afterAll(async () => { await t.close(); });
  afterEach(async () => { await t.db.query(`UPDATE local_credentials SET failed_attempts = 0, locked_until = NULL`); });

  it('signs in with the right password, whatever the case of the email', async () => {
    const r = await post(t, '/auth/login', { email: 'ADMIN@example.com', password: PW });
    expect(r.statusCode).toBe(200);
    const c = sessionCookie(r)!;
    expect((await me(t, `${c.name}=${c.value}`)).json().user.email).toBe('admin@example.com');
    expect((await t.db.query(`SELECT 1 FROM audit_logs WHERE action = 'auth.login_password'`)).rowCount).toBeGreaterThanOrEqual(2);
  });

  it('gives the same answer for a wrong password and for an account that does not exist', async () => {
    const wrong = await post(t, '/auth/login', { email: 'admin@example.com', password: 'not the password' });
    const unknown = await post(t, '/auth/login', { email: 'nobody@example.com', password: 'not the password' });
    expect([wrong.statusCode, unknown.statusCode]).toEqual([401, 401]);
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
    expect(wrong.json().error.code).toBe('invalid_credentials');
    expect(sessionCookie(wrong)).toBeUndefined();
    expect((await post(t, '/auth/login', { email: 'admin@example.com' })).statusCode).toBe(400);
  });

  it('locks after five wrong tries, even for the right password, and says how long', async () => {
    for (let i = 0; i < 5; i++) expect((await post(t, '/auth/login', { email: 'admin@example.com', password: `wrong ${i}` })).statusCode).toBe(401);
    const locked = await post(t, '/auth/login', { email: 'admin@example.com', password: PW });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('too_many_attempts');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(800);
    expect(Number(locked.headers['retry-after'])).toBeLessThanOrEqual(15 * 60);
    await t.db.query(`UPDATE local_credentials SET locked_until = now() - interval '1 second'`); // the lock runs out
    expect((await post(t, '/auth/login', { email: 'admin@example.com', password: PW })).statusCode).toBe(200);
    expect((await t.db.query<any>(`SELECT failed_attempts FROM local_credentials`)).rows[0].failed_attempts).toBe(0);
  });

  it('locks an unknown email the same way, so guessing reveals nothing about which accounts exist', async () => {
    for (let i = 0; i < 5; i++) await post(t, '/auth/login', { email: 'ghost@example.com', password: `x${i}` });
    const r = await post(t, '/auth/login', { email: 'ghost@example.com', password: 'anything' });
    expect(r.statusCode).toBe(429);
  });

  it('records failures without ever storing a password', async () => {
    await post(t, '/auth/login', { email: 'admin@example.com', password: 'a-very-distinctive-wrong-password' });
    const log = (await t.db.query<any>(`SELECT * FROM audit_logs WHERE action = 'auth.login_failed' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(JSON.stringify(log)).not.toContain('distinctive');
    expect(log.metadata).toEqual({ reason: 'invalid' });
  });

  it('refuses a disabled account only after the right password', async () => {
    const other = await plainUser(t, 'user1@example.com');
    await t.db.query(`INSERT INTO local_credentials (user_id, password_hash) SELECT $1, password_hash FROM local_credentials LIMIT 1`, [other.userId]);
    await t.db.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [other.userId]);
    expect((await post(t, '/auth/login', { email: 'user1@example.com', password: 'wrong wrong wrong' })).json().error.code).toBe('invalid_credentials');
    const r = await post(t, '/auth/login', { email: 'user1@example.com', password: PW });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('account_disabled');
    expect(sessionCookie(r)).toBeUndefined();
  });

  it('accepts a request from the page at the server\'s own address, and rejects one from another site', async () => {
    const mine = await post(t, '/auth/login', { email: 'admin@example.com', password: PW }, { headers: { origin: 'http://192.168.1.50:8080', host: '192.168.1.50:8080' } });
    expect(mine.statusCode).toBe(200);
    const evil = await post(t, '/auth/login', { email: 'admin@example.com', password: PW }, { headers: { origin: 'https://evil.example.net', host: '192.168.1.50:8080' } });
    expect(evil.statusCode).toBe(403);
  });
});

describe('changing the password', () => {
  let t: TestEnv;
  let admin: Session;
  beforeAll(async () => {
    t = await fresh();
    const r = await post(t, '/auth/setup', { email: 'boss@example.com', password: PW });
    const c = sessionCookie(r)!;
    const m = (await me(t, `${c.name}=${c.value}`)).json();
    admin = { cookie: `${c.name}=${c.value}`, csrf: m.csrfToken, userId: m.user.id };
  });
  afterAll(async () => { await t.close(); });
  const change = (s: Session, body: unknown) => t.app.inject({ method: 'POST', url: '/api/v1/account/password', headers: authed(s), payload: body as object });

  it('needs the current password, a strong new one, and a different one', async () => {
    expect((await change(admin, { currentPassword: 'nope nope nope', newPassword: `${PW} 2` })).json().error.code).toBe('wrong_password');
    expect((await change(admin, { currentPassword: PW, newPassword: 'short' })).json().error.code).toBe('weak_password');
    expect((await change(admin, { currentPassword: PW, newPassword: PW })).json().error.code).toBe('same_password');
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/account/password', payload: {} })).statusCode).toBe(401);
  });

  it('switches to the new password and signs every other session out', async () => {
    const second = await post(t, '/auth/login', { email: 'boss@example.com', password: PW });
    const c2 = sessionCookie(second)!;
    const r = await change(admin, { currentPassword: PW, newPassword: 'a brand new passphrase 77' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().otherSessionsEnded).toBeGreaterThanOrEqual(1);
    expect((await me(t, `${c2.name}=${c2.value}`)).statusCode).toBe(401); // the other browser is signed out
    expect((await me(t, admin.cookie)).statusCode).toBe(200); // this one stays
    expect((await post(t, '/auth/login', { email: 'boss@example.com', password: PW })).statusCode).toBe(401);
    expect((await post(t, '/auth/login', { email: 'boss@example.com', password: 'a brand new passphrase 77' })).statusCode).toBe(200);
    expect((await t.db.query(`SELECT 1 FROM audit_logs WHERE action = 'account.password_changed'`)).rowCount).toBe(1);
  });

  it('is not available to accounts that sign in with Google', async () => {
    const g = await plainUser(t, 'goog@example.com');
    const r = await change(g, { currentPassword: 'whatever it is', newPassword: `${PW} 3` });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('no_password');
  });
});
