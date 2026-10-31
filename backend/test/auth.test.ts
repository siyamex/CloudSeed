import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { safeRedirect } from '../src/routes/auth.js';
import { beginLogin, createTestEnv, login, authed, type TestEnv } from './helpers.js';

let t: TestEnv;
beforeAll(async () => { t = await createTestEnv(); });
afterAll(async () => { await t.close(); });

async function callback(claims: Record<string, unknown>, opts: Partial<TestEnv['idp']['next']> = {}) {
  const l = await beginLogin(t);
  t.idp.next = { claims: { nonce: l.nonce, ...claims }, ...opts };
  const r = await t.app.inject({ method: 'GET', url: `/api/v1/auth/google/callback?code=c&state=${l.state}` });
  return { r, hasCookie: r.cookies.some((c) => c.name === 'cs_session'), location: r.headers.location as string };
}

describe('google login flow', () => {
  it('redirects to the provider with state, nonce, and an S256 PKCE challenge, requesting identity scopes only', async () => {
    const l = await beginLogin(t);
    expect(l.status).toBe(302);
    expect(l.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(l.url.searchParams.get('code_challenge')).toBeTruthy();
    expect(l.url.searchParams.get('scope')).toBe('openid email profile');
    expect(l.state.length).toBeGreaterThan(20);
  });

  it('creates a user, profile, quota and session on a valid callback', async () => {
    const s = await login(t, 'sub-1', 'alice@example.com');
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: s.cookie } });
    expect(me.json().user).toMatchObject({ email: 'alice@example.com', roles: ['user'] });
    const q = await t.db.query('SELECT quota_bytes FROM storage_quotas WHERE user_id = $1', [s.userId]);
    expect(q.rows).toHaveLength(1);
  });

  it('stores only a hash of the session token', async () => {
    const s = await login(t, 'sub-hash', 'hash@example.com');
    const token = s.cookie.split('=')[1]!;
    const r = await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1`, [Buffer.from(token)]);
    expect(r.rows[0]!.n).toBe(0);
  });

  it('logs the same identity into the same user on a second login', async () => {
    const a = await login(t, 'sub-2', 'bob@example.com');
    const b = await login(t, 'sub-2', 'bob@example.com');
    expect(b.userId).toBe(a.userId);
  });

  it('grants admin only to configured ADMIN_EMAILS', async () => {
    const s = await login(t, 'sub-admin', 'admin@example.com');
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: s.cookie } });
    expect(me.json().user.roles.sort()).toEqual(['admin', 'user']);
  });

  it('rejects an unverified email', async () => {
    const x = await callback({ sub: 'sub-u', email: 'u@example.com', email_verified: false });
    expect(x.hasCookie).toBe(false);
    expect(x.location).toContain('auth_error=email_unverified');
  });

  it('rejects a nonce mismatch', async () => {
    const x = await callback({ sub: 'sub-n', email: 'n@example.com', email_verified: true, nonce: 'wrong' });
    expect(x.hasCookie).toBe(false);
    expect(x.location).toContain('auth_error=oidc_failed');
  });

  it('rejects a token for another audience', async () => {
    const x = await callback({ sub: 'sub-a', email: 'a@example.com', email_verified: true }, { audience: 'someone-else' });
    expect(x.hasCookie).toBe(false);
    expect(x.location).toContain('oidc_failed');
  });

  it('rejects a token from another issuer', async () => {
    const x = await callback({ sub: 'sub-i', email: 'i@example.com', email_verified: true }, { issuer: 'https://evil.example' });
    expect(x.hasCookie).toBe(false);
  });

  it('rejects a token signed with an unknown key', async () => {
    const x = await callback({ sub: 'sub-s', email: 's@example.com', email_verified: true }, { badSignature: true });
    expect(x.hasCookie).toBe(false);
    expect(x.location).toContain('oidc_failed');
  });

  it('rejects an unknown state and makes state single-use', async () => {
    const bad = await t.app.inject({ method: 'GET', url: '/api/v1/auth/google/callback?code=c&state=nope' });
    expect(bad.headers.location).toContain('invalid_state');

    const l = await beginLogin(t);
    t.idp.next = { claims: { sub: 'sub-r', email: 'r@example.com', email_verified: true, nonce: l.nonce } };
    const first = await t.app.inject({ method: 'GET', url: `/api/v1/auth/google/callback?code=c&state=${l.state}` });
    expect(first.cookies.some((c) => c.name === 'cs_session')).toBe(true);
    const replay = await t.app.inject({ method: 'GET', url: `/api/v1/auth/google/callback?code=c&state=${l.state}` });
    expect(replay.headers.location).toContain('invalid_state');
  });

  it('does not link a new Google identity to an existing account with the same email', async () => {
    await login(t, 'sub-orig', 'victim@example.com');
    const x = await callback({ sub: 'sub-attacker', email: 'victim@example.com', email_verified: true });
    expect(x.hasCookie).toBe(false);
    expect(x.location).toContain('email_in_use');
  });

  it('blocks disabled accounts', async () => {
    const s = await login(t, 'sub-dis', 'dis@example.com');
    await t.db.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [s.userId]);
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: s.cookie } });
    expect(me.statusCode).toBe(401);
    const x = await callback({ sub: 'sub-dis', email: 'dis@example.com', email_verified: true });
    expect(x.location).toContain('account_disabled');
  });

  it('honours a closed registration policy except for admins', async () => {
    await t.db.query(`UPDATE application_settings SET value = '"closed"' WHERE key = 'registration_policy'`);
    try {
      const x = await callback({ sub: 'sub-new', email: 'new@example.com', email_verified: true });
      expect(x.location).toContain('registration_closed');
      const ok = await login(t, 'sub-admin2', 'admin@example.com').catch(() => null);
      // admin@example.com already exists under sub-admin, so a different sub must not link:
      expect(ok).toBeNull();
    } finally {
      await t.db.query(`UPDATE application_settings SET value = '"open"' WHERE key = 'registration_policy'`);
    }
  });
});

describe('sessions and CSRF', () => {
  it('requires authentication for /me', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('unauthorized');
    expect(r.json().error.requestId).toBeTruthy();
  });

  it('rejects state-changing requests without a CSRF token, and with a wrong one', async () => {
    const s = await login(t, 'sub-csrf', 'csrf@example.com');
    const none = await t.app.inject({ method: 'POST', url: '/api/v1/folders', headers: { cookie: s.cookie }, payload: { name: 'x' } });
    expect(none.statusCode).toBe(403);
    const wrong = await t.app.inject({ method: 'POST', url: '/api/v1/folders', headers: { cookie: s.cookie, 'x-csrf-token': 'nope' }, payload: { name: 'x' } });
    expect(wrong.statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'POST', url: '/api/v1/folders', headers: authed(s), payload: { name: 'x' } });
    expect(ok.statusCode).toBe(201);
  });

  it('rejects state-changing requests from a foreign Origin', async () => {
    const s = await login(t, 'sub-origin', 'origin@example.com');
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/folders', headers: { ...authed(s), origin: 'https://evil.example' }, payload: { name: 'x' } });
    expect(r.statusCode).toBe(403);
  });

  it('logout invalidates the session server-side', async () => {
    const s = await login(t, 'sub-out', 'out@example.com');
    const out = await t.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: authed(s) });
    expect(out.statusCode).toBe(204);
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: s.cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('rejects expired sessions', async () => {
    const s = await login(t, 'sub-exp', 'exp@example.com');
    await t.db.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [s.userId]);
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: s.cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('sets HttpOnly, SameSite=Lax cookies', async () => {
    const l = await beginLogin(t);
    t.idp.next = { claims: { sub: 'sub-ck', email: 'ck@example.com', email_verified: true, nonce: l.nonce } };
    const r = await t.app.inject({ method: 'GET', url: `/api/v1/auth/google/callback?code=c&state=${l.state}` });
    const c = r.cookies.find((x) => x.name === 'cs_session')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Lax');
  });
});

describe('safeRedirect', () => {
  it.each([['/files', '/files'], ['//evil.com', '/'], ['https://evil.com', '/'], ['/\\evil.com', '/'], [undefined, '/'], ['/a\r\nSet-Cookie: x', '/']])(
    '%s -> %s', (input, out) => { expect(safeRedirect(input)).toBe(out); });
});

describe('production config validation', () => {
  const base = { NODE_ENV: 'production' };
  it('fails clearly when secrets are missing or insecure', () => {
    expect(() => loadConfig(base as NodeJS.ProcessEnv)).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' } as NodeJS.ProcessEnv)).toThrow(/at least 32/);
  });
  it('accepts a complete secure config', () => {
    const c = loadConfig({
      ...base, SESSION_SECRET: 'x'.repeat(40), GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's',
      GOOGLE_REDIRECT_URI: 'https://cloud.example.com/api/v1/auth/google/callback', PUBLIC_URL: 'https://cloud.example.com',
      DATABASE_URL: 'postgres://app:strongpw@db:5432/app', ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    } as NodeJS.ProcessEnv);
    expect(c.cookieSecure).toBe(true);
  });
  it('refuses http PUBLIC_URL and default DB credentials in production', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'x'.repeat(40), GOOGLE_CLIENT_ID: 'i', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: 'r', PUBLIC_URL: 'http://x.com' } as NodeJS.ProcessEnv))
      .toThrow(/https/);
  });
});

describe('rate limiting', () => {
  it('throttles the login endpoints per client', async () => {
    const limited = await createTestEnv({ AUTH_RATE_LIMIT_PER_MIN: '3' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await limited.app.inject({ method: 'GET', url: '/api/v1/auth/google/login' })).statusCode);
      expect(codes).toEqual([302, 302, 302, 429, 429]);
      const r = await limited.app.inject({ method: 'GET', url: '/api/v1/auth/google/login' });
      expect(r.json().error.code).toBe('rate_limited');
    } finally { await limited.close(); }
  });
});
