import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { authed, createTestEnv, login, multipartBody, type Session, type TestEnv } from './helpers.js';

let t: TestEnv;
let seq = 0;
beforeAll(async () => { t = await createTestEnv({ SHARE_UNLOCK_RATE_PER_MIN: '1000' }); });
afterAll(async () => { await t.close(); });

const user = (n = `s${++seq}`): Promise<Session> => login(t, `share-${n}`, `share-${n}@example.com`);
const call = (s: Session | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { ...(s ? authed(s) : {}), ...headers }, payload: payload as object });
const get = (s: Session | null, url: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { ...(s ? { cookie: s.cookie } : {}), ...headers } });
async function upload(s: Session, name: string, content: Buffer | string): Promise<string> {
  const m = multipartBody(name, content);
  const r = await t.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(s), ...m.headers }, payload: m.body });
  if (r.statusCode !== 201) throw new Error(r.body);
  return r.json().id;
}
const DATA = Buffer.from('0123456789abcdefghij'.repeat(50)); // 1000 bytes
async function share(s: Session, fileId: string, extra: Record<string, unknown> = {}) {
  const r = await call(s, 'POST', '/shares', { fileId, expiresInHours: 24, acknowledgePublic: true, ...extra });
  return { r, body: r.json(), token: r.json().token as string };
}
const pubPath = (token: string, tail = '') => `/public/shares/${token}${tail}`;
const row = async (id: string) => (await t.db.query<any>('SELECT * FROM shared_links WHERE id = $1', [id])).rows[0];

describe('creating and using a link', () => {
  it('returns the link once, stores only its hash, and lets anyone download without signing in', async () => {
    const s = await user();
    const f = await upload(s, 'report.bin', DATA);
    const { r, body, token } = await share(s, f, { label: 'for Bob' });
    expect(r.statusCode).toBe(201);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.url).toBe(`http://localhost:8080/s/${token}`);
    expect(body).toMatchObject({ status: 'active', mode: 'public', passwordProtected: false, downloadCount: 0, label: 'for Bob', fileName: 'report.bin' });

    const stored = await row(body.id);
    expect(Buffer.from(stored.token_hash).equals(createHash('sha256').update(token).digest())).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(token); // the token itself is nowhere in the database
    expect((await get(s, '/shares')).body).not.toContain(token); // nor in later listings

    const info = await get(null, pubPath(token));
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ name: 'report.bin', size: 1000, mode: 'public', passwordRequired: false, downloadsLeft: null });
    for (const leak of ['storage', 'user', 'key', 'sha256', 'fileId']) expect(info.body.toLowerCase()).not.toContain(leak.toLowerCase());
    expect(info.headers['x-robots-tag']).toContain('noindex');
    expect(info.headers['referrer-policy']).toBe('no-referrer');

    const dl = await get(null, pubPath(token, '/download'));
    expect(dl.statusCode).toBe(200);
    expect(Buffer.from(dl.rawPayload).equals(DATA)).toBe(true);
    expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-security-policy']).toContain('sandbox');
    expect(dl.headers['cache-control']).toBe('no-store');
    const after = (await get(s, '/shares')).json().shares[0];
    expect(after).toMatchObject({ downloadCount: 1, accessCount: 1 });
    expect(after.lastAccessedAt).not.toBeNull();
  });

  it('always serves an attachment, and never as a type a browser would render', async () => {
    const s = await user();
    const f = await upload(s, 'page.html', '<script>alert(1)</script>');
    const { token } = await share(s, f);
    const dl = await get(null, pubPath(token, '/download'));
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('requires the owner to acknowledge a public link, and bounds the lifetime', async () => {
    const s = await user();
    const f = await upload(s, 'a.bin', DATA);
    const bad = await call(s, 'POST', '/shares', { fileId: f, expiresInHours: 24 });
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'public_not_acknowledged']);
    for (const hours of [0, -5, 1.5, 365 * 24 + 1]) expect((await call(s, 'POST', '/shares', { fileId: f, expiresInHours: hours, acknowledgePublic: true })).statusCode, String(hours)).toBe(400);
    expect((await call(s, 'POST', '/shares', { fileId: f, expiresInHours: 24, mode: 'private' })).statusCode).toBe(201); // private needs no acknowledgement
    expect((await call(s, 'POST', '/shares', { fileId: f, expiresInHours: 24, acknowledgePublic: true, maxDownloads: 0 })).statusCode).toBe(400);
  });

  it('serves byte ranges; only a download from the start counts, so resuming does not use up the limit', async () => {
    const s = await user();
    const f = await upload(s, 'range.bin', DATA);
    const { token, body } = await share(s, f);
    const mid = await get(null, pubPath(token, '/download'), { range: 'bytes=100-199' });
    expect([mid.statusCode, mid.headers['content-range']]).toEqual([206, 'bytes 100-199/1000']);
    expect(Buffer.from(mid.rawPayload).equals(DATA.subarray(100, 200))).toBe(true);
    expect((await row(body.id)).download_count).toBe(0);
    await get(null, pubPath(token, '/download'), { range: 'bytes=0-9' });
    expect((await row(body.id)).download_count).toBe(1);
    expect((await get(null, pubPath(token, '/download'), { range: 'bytes=5000-' })).statusCode).toBe(416);
  });
});

describe('limits', () => {
  it('stops after the maximum number of downloads', async () => {
    const s = await user();
    const f = await upload(s, 'lim.bin', DATA);
    const { token, body } = await share(s, f, { maxDownloads: 2 });
    expect((await get(null, pubPath(token))).json().downloadsLeft).toBe(2);
    expect((await get(null, pubPath(token, '/download'))).statusCode).toBe(200);
    expect((await get(null, pubPath(token, '/download'))).statusCode).toBe(200);
    const third = await get(null, pubPath(token, '/download'));
    expect([third.statusCode, third.json().error.code]).toEqual([410, 'share_exhausted']);
    expect((await get(null, pubPath(token))).json().error.code).toBe('share_exhausted');
    expect((await get(s, '/shares')).json().shares[0]).toMatchObject({ status: 'exhausted', downloadCount: 2 });
    expect(body.maxDownloads).toBe(2);
  });

  it('is atomic: ten simultaneous downloads of a one-download link succeed exactly once', async () => {
    const s = await user();
    const f = await upload(s, 'race.bin', DATA);
    const { token } = await share(s, f, { maxDownloads: 1 });
    const results = await Promise.all(Array.from({ length: 10 }, () => get(null, pubPath(token, '/download'))));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 410)).toHaveLength(9);
  });

  it('lets an interrupted download continue for a short while after the limit was used up, but not later', async () => {
    const s = await user();
    const f = await upload(s, 'resume.bin', DATA);
    const { token, body } = await share(s, f, { maxDownloads: 1 });
    await get(null, pubPath(token, '/download'));
    const resume = await get(null, pubPath(token, '/download'), { range: 'bytes=500-' });
    expect(resume.statusCode).toBe(206);
    expect(Buffer.from(resume.rawPayload).equals(DATA.subarray(500))).toBe(true);
    expect((await row(body.id)).download_count).toBe(1); // resuming did not count again
    expect((await get(null, pubPath(token, '/download'))).statusCode).toBe(410); // a fresh full download is refused
    await t.db.query(`UPDATE shared_links SET last_download_at = now() - interval '2 hours' WHERE id = $1`, [body.id]);
    expect((await get(null, pubPath(token, '/download'), { range: 'bytes=500-' })).statusCode).toBe(410);
  });

  it('expires, can be extended, and refuses malformed or unknown tokens', async () => {
    const s = await user();
    const f = await upload(s, 'exp.bin', DATA);
    const { token, body } = await share(s, f);
    await t.db.query(`UPDATE shared_links SET expires_at = now() - interval '1 minute' WHERE id = $1`, [body.id]);
    for (const tail of ['', '/download']) expect((await get(null, pubPath(token, tail))).json().error.code).toBe('share_expired');
    expect((await get(s, '/shares')).json().shares[0].status).toBe('expired');
    const ext = await call(s, 'PATCH', `/shares/${body.id}`, { expiresInHours: 48, maxDownloads: 5 });
    expect(ext.json()).toMatchObject({ status: 'active', maxDownloads: 5 });
    expect((await get(null, pubPath(token, '/download'))).statusCode).toBe(200);

    expect((await get(null, pubPath('short'))).statusCode).toBe(404);
    expect((await get(null, pubPath('A'.repeat(43)))).json().error.code).toBe('share_not_found');
    expect((await get(null, pubPath('../../etc/passwd'))).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('caps the number of active links per user, and can be switched off server-wide', async () => {
    const lim = await createTestEnv({ SHARING_MAX_ACTIVE_PER_USER: '2' });
    const off = await createTestEnv({ SHARING_ENABLED: 'false' });
    try {
      for (const [env, name] of [[lim, 'lim'], [off, 'off']] as const) {
        const s = await login(env, `cap-${name}`, `cap-${name}@example.com`);
        const m = multipartBody('x.bin', DATA);
        const up = await env.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(s), ...m.headers }, payload: m.body });
        const mk = () => env.app.inject({ method: 'POST', url: '/api/v1/shares', headers: authed(s), payload: { fileId: up.json().id, expiresInHours: 1, acknowledgePublic: true } });
        if (env === lim) {
          expect([(await mk()).statusCode, (await mk()).statusCode, (await mk()).statusCode]).toEqual([201, 201, 429]);
        } else {
          const r = await mk();
          expect([r.statusCode, r.json().error.code]).toEqual([409, 'sharing_disabled']);
          const pub = await env.app.inject({ method: 'GET', url: `/api/v1/public/shares/${'A'.repeat(43)}` });
          expect(pub.statusCode).toBe(404);
        }
      }
    } finally { await lim.close(); await off.close(); }
  });
});

describe('revoking and per-file control', () => {
  it('revoking turns the link off immediately and permanently', async () => {
    const s = await user();
    const f = await upload(s, 'rev.bin', DATA);
    const { token, body } = await share(s, f);
    const rv = await call(s, 'POST', `/shares/${body.id}/revoke`);
    expect(rv.json()).toMatchObject({ status: 'revoked' });
    expect((await get(null, pubPath(token, '/download'))).json().error.code).toBe('share_revoked');
    expect((await call(s, 'PATCH', `/shares/${body.id}`, { expiresInHours: 5 })).statusCode).toBe(409);
    expect((await call(s, 'DELETE', `/shares/${body.id}`)).statusCode).toBe(204);
    expect((await get(null, pubPath(token))).json().error.code).toBe('share_not_found'); // gone entirely
  });

  it('turning sharing off for a file revokes its links and blocks new ones until re-enabled', async () => {
    const s = await user();
    const f = await upload(s, 'off.bin', DATA);
    const { token } = await share(s, f);
    const p = await call(s, 'PATCH', `/files/${f}`, { sharingDisabled: true });
    expect(p.json().sharingDisabled).toBe(true);
    expect((await get(null, pubPath(token, '/download'))).statusCode).toBe(410);
    const blocked = await call(s, 'POST', '/shares', { fileId: f, expiresInHours: 1, acknowledgePublic: true });
    expect([blocked.statusCode, blocked.json().error.code]).toEqual([409, 'file_sharing_disabled']);
    expect((await get(s, '/files')).json().files.find((x: any) => x.id === f).sharingDisabled).toBe(true);
    await call(s, 'PATCH', `/files/${f}`, { sharingDisabled: false });
    expect((await share(s, f)).r.statusCode).toBe(201);
    expect((await get(null, pubPath(token, '/download'))).statusCode).toBe(410); // the old link stays revoked
  });

  it('a file in the trash cannot be downloaded through its link, and works again once restored; purging removes the link', async () => {
    const s = await user();
    const f = await upload(s, 'trash.bin', DATA);
    const { token, body } = await share(s, f);
    await call(s, 'DELETE', `/files/${f}`);
    expect((await get(null, pubPath(token, '/download'))).json().error.code).toBe('file_unavailable');
    expect((await get(s, '/shares')).json().shares[0].fileInTrash).toBe(true);
    await call(s, 'POST', '/trash/restore', { fileIds: [f] });
    expect((await get(null, pubPath(token, '/download'))).statusCode).toBe(200);
    await call(s, 'DELETE', `/files/${f}`);
    await call(s, 'POST', '/trash/empty');
    expect(await row(body.id)).toBeUndefined();
    expect((await get(null, pubPath(token))).statusCode).toBe(404);
  });
});

describe('passwords and private links', () => {
  it('hashes passwords with scrypt and verifies them', async () => {
    const h = await hashPassword('correct horse');
    expect(h).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(h).not.toContain('correct horse');
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('correct horsf', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await hashPassword('correct horse')).not.toBe(h); // fresh salt every time
  });

  it('keeps the file locked until the right password is given, then grants a short-lived, link-specific cookie', async () => {
    const s = await user();
    const f = await upload(s, 'locked.bin', DATA);
    const { token, body } = await share(s, f, { password: 'open sesame' });
    expect((await row(body.id)).password_hash).toMatch(/^scrypt\$/);
    expect((await row(body.id)).password_hash).not.toContain('open sesame');
    expect(body.passwordProtected).toBe(true);
    expect((await call(s, 'POST', '/shares', { fileId: f, expiresInHours: 1, acknowledgePublic: true, password: 'short' })).statusCode).toBe(400);

    expect(await get(null, pubPath(token))).toMatchObject({ statusCode: 200 });
    expect((await get(null, pubPath(token))).json()).toMatchObject({ passwordRequired: true, unlocked: false });
    const locked = await get(null, pubPath(token, '/download'));
    expect([locked.statusCode, locked.json().error.code]).toEqual([403, 'password_required']);

    const wrong = await call(null, 'POST', pubPath(token, '/unlock'), { password: 'open sesame!' });
    expect([wrong.statusCode, wrong.json().error.code]).toEqual([403, 'wrong_password']);
    expect(wrong.cookies).toHaveLength(0);

    const ok = await call(null, 'POST', pubPath(token, '/unlock'), { password: 'open sesame' });
    expect(ok.statusCode).toBe(200);
    const c = ok.cookies.find((x) => x.name === 'cs_sg')!;
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: `/api/v1/public/shares/${token}` });
    expect((await get(null, pubPath(token), { cookie: `cs_sg=${c.value}` })).json().unlocked).toBe(true);
    const dl = await get(null, pubPath(token, '/download'), { cookie: `cs_sg=${c.value}` });
    expect([dl.statusCode, Buffer.from(dl.rawPayload).equals(DATA)]).toEqual([200, true]);

    // the grant is bound to this link, signed, and not forgeable
    const f2 = await upload(s, 'other.bin', DATA);
    const other = await share(s, f2, { password: 'another one' });
    expect((await get(null, pubPath(other.token, '/download'), { cookie: `cs_sg=${c.value}` })).statusCode).toBe(403);
    const [id, exp] = c.value.split('.');
    for (const forged of [`${id}.${exp}.AAAA`, `${id}.${Number(exp) + 99999}.${c.value.split('.')[2]}`, `${body.id}.1.${c.value.split('.')[2]}`, 'x']) {
      expect((await get(null, pubPath(token, '/download'), { cookie: `cs_sg=${forged}` })).statusCode, forged).toBe(403);
    }
    await t.db.query(`UPDATE shared_links SET password_hash = NULL WHERE id = $1`, [other.body.id]); // (sanity: a link without a password needs no grant)
    expect((await get(null, pubPath(other.token, '/download'))).statusCode).toBe(200);
  });

  it('slows down password guessing per link and address', async () => {
    const env = await createTestEnv({ SHARE_UNLOCK_RATE_PER_MIN: '3' });
    try {
      const s = await login(env, 'rl-owner', 'rl-owner@example.com');
      const m = multipartBody('x.bin', DATA);
      const up = await env.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(s), ...m.headers }, payload: m.body });
      const sh = await env.app.inject({ method: 'POST', url: '/api/v1/shares', headers: authed(s), payload: { fileId: up.json().id, expiresInHours: 1, acknowledgePublic: true, password: 'the password' } });
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await env.app.inject({ method: 'POST', url: `/api/v1/public/shares/${sh.json().token}/unlock`, payload: { password: `guess ${i}` } })).statusCode);
      expect(codes).toEqual([403, 403, 403, 429, 429, 429]);
    } finally { await env.close(); }
  });

  it('private links need a signed-in CloudSeed account, and reveal nothing to anonymous visitors', async () => {
    const owner = await user(); const other = await user();
    const f = await upload(owner, 'private.bin', DATA);
    const r = await call(owner, 'POST', '/shares', { fileId: f, expiresInHours: 24, mode: 'private' });
    const token = r.json().token;
    for (const tail of ['', '/download']) {
      const anon = await get(null, pubPath(token, tail));
      expect([anon.statusCode, anon.json().error.code]).toEqual([401, 'login_required']);
      expect(anon.body).not.toContain('private.bin');
    }
    expect((await get(other, pubPath(token))).json()).toMatchObject({ name: 'private.bin', mode: 'private' });
    expect((await get(other, pubPath(token, '/download'))).statusCode).toBe(200);
  });

  it('refuses cross-origin password attempts', async () => {
    const s = await user();
    const f = await upload(s, 'o.bin', DATA);
    const { token } = await share(s, f, { password: 'password one' });
    const r = await t.app.inject({ method: 'POST', url: `/api/v1/public/shares${'/' + token}/unlock`, headers: { origin: 'https://evil.example' }, payload: { password: 'password one' } });
    expect(r.statusCode).toBe(403);
  });
});

describe('isolation and abuse reports', () => {
  it("never lets one user see or change another user's links, or share their files", async () => {
    const a = await user(); const b = await user();
    const f = await upload(a, 'mine.bin', DATA);
    const { body } = await share(a, f);
    expect((await get(b, '/shares')).json().shares).toEqual([]);
    for (const [m, u, p] of [['PATCH', `/shares/${body.id}`, { expiresInHours: 2 }], ['POST', `/shares/${body.id}/revoke`], ['DELETE', `/shares/${body.id}`]] as [string, string, unknown?][]) {
      expect((await call(b, m, u, p)).statusCode, `${m} ${u}`).toBe(404);
    }
    expect((await call(b, 'POST', '/shares', { fileId: f, expiresInHours: 1, acknowledgePublic: true })).statusCode).toBe(404);
    expect((await call(b, 'PATCH', `/files/${f}`, { sharingDisabled: true })).statusCode).toBe(404);
    expect((await call(null, 'POST', '/shares', { fileId: f, expiresInHours: 1, acknowledgePublic: true })).statusCode).toBe(401);
    expect((await get(a, '/shares')).json().shares[0].status).toBe('active');
  });

  it('accepts abuse reports from anyone, rate limited, without storing the reporter address', async () => {
    const s = await user();
    const f = await upload(s, 'bad.bin', DATA);
    const { token, body } = await share(s, f);
    const r = await call(null, 'POST', pubPath(token, '/report'), { reason: 'malware', details: 'contains a virus' });
    expect([r.statusCode, r.json()]).toEqual([201, { received: true }]);
    const rep = (await t.db.query<any>('SELECT * FROM abuse_reports WHERE share_id = $1', [body.id])).rows[0];
    expect(rep).toMatchObject({ reason: 'malware', status: 'open', file_name: 'bad.bin', owner_id: s.userId });
    expect(JSON.stringify(rep)).not.toContain('127.0.0.1');
    expect((await call(null, 'POST', pubPath(token, '/report'), { reason: 'nonsense' })).statusCode).toBe(400);
    expect((await call(null, 'POST', pubPath('A'.repeat(43), '/report'), { reason: 'other' })).statusCode).toBe(404);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await call(null, 'POST', pubPath(token, '/report'), { reason: 'other' })).statusCode);
    expect(codes.slice(-2)).toEqual([429, 429]);
  });

  it('an administrator-disabled link cannot be revived by its owner', async () => {
    const s = await user();
    const f = await upload(s, 'dis.bin', DATA);
    const { token, body } = await share(s, f);
    await t.db.query('UPDATE shared_links SET disabled_by_admin = TRUE WHERE id = $1', [body.id]);
    expect((await get(null, pubPath(token, '/download'))).json().error.code).toBe('share_disabled');
    expect((await call(s, 'PATCH', `/shares/${body.id}`, { expiresInHours: 99 })).statusCode).toBe(409);
    expect((await get(s, '/shares')).json().shares[0].status).toBe('disabled');
  });
});
