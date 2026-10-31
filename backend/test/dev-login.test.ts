import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createTestEnv, type TestEnv } from './helpers.js';

let off: TestEnv;
let on: TestEnv;
beforeAll(async () => {
  off = await createTestEnv();
  on = await createTestEnv({ DEV_LOGIN: 'true', DEV_LOGIN_EMAIL: 'Tester@Example.com', ADMIN_EMAILS: 'tester@example.com' });
});
afterAll(async () => { await off.close(); await on.close(); });

const login = (t: TestEnv, remoteAddress: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url: '/api/v1/auth/dev-login', remoteAddress, headers });

describe('dev login (development only)', () => {
  it('does not exist unless it is switched on', async () => {
    expect((await login(off, '127.0.0.1')).statusCode).toBe(404);
    expect((await off.app.inject({ method: 'GET', url: '/api/v1/auth/config' })).json().devLogin).toBe(false);
  });

  it('signs in the test user from this computer, creating the account the first time', async () => {
    const r = await login(on, '127.0.0.1');
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/');
    const cookie = r.cookies[0]!;
    expect(cookie).toMatchObject({ name: expect.stringMatching(/session/), httpOnly: true });
    const me = await on.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: `${cookie.name}=${cookie.value}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ email: 'tester@example.com', roles: expect.arrayContaining(['admin']) });
    const again = await login(on, '::1'); // IPv6 loopback, same account
    expect(again.statusCode).toBe(302);
    expect((await on.db.query(`SELECT 1 FROM users WHERE lower(email) = 'tester@example.com'`)).rowCount).toBe(1);
    expect((await on.db.query(`SELECT 1 FROM audit_logs WHERE action = 'auth.dev_login'`)).rowCount).toBeGreaterThanOrEqual(2);
    expect((await on.app.inject({ method: 'GET', url: '/api/v1/auth/config' })).json().devLogin).toBe(true);
  });

  it('refuses everyone who is not on the same machine, including requests relayed through a proxy', async () => {
    expect((await login(on, '192.168.1.20')).statusCode).toBe(403);
    expect((await login(on, '203.0.113.9')).statusCode).toBe(403);
    expect((await login(on, '127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })).statusCode).toBe(403);
  });

  it('cannot be turned on in production', () => {
    const base = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), PUBLIC_URL: 'https://x.example.com', DEV_LOGIN: 'true' } as NodeJS.ProcessEnv;
    expect(() => loadConfig(base)).toThrow(/DEV_LOGIN must never be enabled in production/);
  });
});
