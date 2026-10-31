import { access } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, createTestEnv, login, multipartBody, type Session, type TestEnv } from './helpers.js';

let t: TestEnv;
let seq = 0;
beforeAll(async () => { t = await createTestEnv({ DOWNLOAD_USER_CONCURRENCY: '3', SMTP_HOST: '' }); });
afterAll(async () => { await t.close(); });

const user = (extra: Record<string, unknown> = {}): Promise<Session> => { const n = ++seq; return login(t, `acc-${n}`, `acc-${n}@example.com`, extra); };
const emailOf = (n: number) => `acc-${n}@example.com`;
const call = (s: Session, method: string, url: string, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: authed(s), payload: payload as object });
async function upload(s: Session, name: string, content = 'hello'): Promise<string> {
  const m = multipartBody(name, content);
  const r = await t.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(s), ...m.headers }, payload: m.body });
  if (r.statusCode !== 201) throw new Error(r.body);
  return r.json().id;
}
const mkFolder = async (s: Session, name: string) => (await call(s, 'POST', '/folders', { name, parentId: null })).json().id as string;

describe('settings', () => {
  it('has sensible defaults and reports the server limits', async () => {
    const s = await user();
    const r = (await call(s, 'GET', '/account/settings')).json();
    expect(r).toMatchObject({
      theme: 'system', defaultDownloadFolderId: null, downloadConcurrency: null, downloadBandwidthBps: null,
      emailNotifications: false, mutedKinds: [], limits: { downloadConcurrency: 3, emailAvailable: false },
    });
  });

  it('saves each setting and returns the new state', async () => {
    const s = await user();
    const folder = await mkFolder(s, 'Inbox');
    const r = await call(s, 'PATCH', '/account/settings', {
      theme: 'dark', displayName: 'Ada', defaultDownloadFolderId: folder, downloadConcurrency: 1, downloadBandwidthBps: 500_000, mutedKinds: ['download_started', 'download_started'],
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ theme: 'dark', displayName: 'Ada', defaultDownloadFolderId: folder, downloadConcurrency: 1, downloadBandwidthBps: 500_000, mutedKinds: ['download_started'] });
    const me = (await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: s.cookie } })).json();
    expect(me.user).toMatchObject({ theme: 'dark', displayName: 'Ada' });
    // a partial update leaves the rest alone
    const r2 = (await call(s, 'PATCH', '/account/settings', { downloadConcurrency: null })).json();
    expect(r2).toMatchObject({ theme: 'dark', downloadConcurrency: null, downloadBandwidthBps: 500_000 });
    expect((await call(s, 'PATCH', '/account/settings', { downloadBandwidthBps: 0 })).json().downloadBandwidthBps).toBeNull();
  });

  it('refuses limits above the server\'s and unknown fields or kinds', async () => {
    const s = await user();
    expect((await call(s, 'PATCH', '/account/settings', { downloadConcurrency: 4 })).json().error.code).toBe('above_server_limit');
    expect((await call(s, 'PATCH', '/account/settings', { mutedKinds: ['nope'] })).json().error.code).toBe('unknown_kind');
    expect((await call(s, 'PATCH', '/account/settings', { quota: 5 })).statusCode).toBe(400); // cannot sneak in other fields
    expect((await call(s, 'PATCH', '/account/settings', { theme: 'pink' })).statusCode).toBe(400);
  });

  it('refuses email notifications when the server has no SMTP', async () => {
    const s = await user();
    const r = await call(s, 'PATCH', '/account/settings', { emailNotifications: true });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('email_unavailable');
  });

  it('cannot use someone else\'s folder as the default download folder', async () => {
    const a = await user(); const b = await user();
    const theirs = await mkFolder(b, 'private');
    expect((await call(a, 'PATCH', '/account/settings', { defaultDownloadFolderId: theirs })).statusCode).toBe(404);
  });

  it('applies the default folder to new downloads unless one is given', async () => {
    const s = await user();
    const folder = await mkFolder(s, 'Downloads');
    await call(s, 'PATCH', '/account/settings', { defaultDownloadFolderId: folder });
    const create = async (extra: object) => (await call(s, 'POST', '/downloads', { url: 'https://example.com/a.bin', ...extra })).json();
    expect((await create({})).folderId).toBe(folder);
    expect((await create({ folderId: null })).folderId).toBeNull(); // explicit root wins
    // trashing the default folder falls back to the root instead of failing
    expect((await call(s, 'DELETE', `/folders/${folder}`)).statusCode).toBe(204);
    expect((await create({})).folderId).toBeNull();
  });
});

describe('sessions', () => {
  it('lists active sessions, marks the current one, and revokes a single other session', async () => {
    const s1 = await user();
    // second session for the same user
    const idpUser = (await t.db.query<any>(`SELECT email FROM users WHERE id = $1`, [s1.userId])).rows[0];
    const s2 = await login(t, `acc-${seq}`, idpUser.email);
    expect(s2.userId).toBe(s1.userId);
    const list = (await call(s1, 'GET', '/account/sessions')).json().sessions;
    expect(list).toHaveLength(2);
    expect(list.filter((x: any) => x.current)).toHaveLength(1);
    const other = list.find((x: any) => !x.current);
    expect(JSON.stringify(list)).not.toMatch(/token|csrf/i);

    expect((await call(s1, 'DELETE', `/account/sessions/${other.id}`)).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: s2.cookie } })).statusCode).toBe(401); // really signed out
    expect((await call(s1, 'DELETE', `/account/sessions/${other.id}`)).statusCode).toBe(404);
  });

  it('revokes every other session but keeps the current one', async () => {
    const s1 = await user();
    const email = (await t.db.query<any>(`SELECT email FROM users WHERE id = $1`, [s1.userId])).rows[0].email;
    const others = [await login(t, `acc-${seq}`, email), await login(t, `acc-${seq}`, email)];
    const r = await call(s1, 'POST', '/account/sessions/revoke-others');
    expect(r.json().revoked).toBe(2);
    for (const o of others) expect((await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: o.cookie } })).statusCode).toBe(401);
    expect((await call(s1, 'GET', '/account/sessions')).json().sessions).toHaveLength(1);
  });

  it('cannot see or revoke another user\'s session', async () => {
    const a = await user(); const b = await user();
    const bobSession = (await call(b, 'GET', '/account/sessions')).json().sessions[0];
    expect((await call(a, 'GET', '/account/sessions')).json().sessions.some((x: any) => x.id === bobSession.id)).toBe(false);
    expect((await call(a, 'DELETE', `/account/sessions/${bobSession.id}`)).statusCode).toBe(404);
    expect((await call(b, 'GET', '/account/sessions')).statusCode).toBe(200);
  });

  it('records when a session was last used', async () => {
    const s = await user();
    await t.db.query(`UPDATE sessions SET last_seen_at = now() - interval '1 hour' WHERE user_id = $1`, [s.userId]);
    await call(s, 'GET', '/account/settings');
    const age = (await t.db.query<any>(`SELECT extract(epoch FROM now() - last_seen_at) AS s FROM sessions WHERE user_id = $1`, [s.userId])).rows[0].s;
    expect(Number(age)).toBeLessThan(30);
  });
});

describe('data export', () => {
  it('contains the user\'s data and no secrets or other users\' data', async () => {
    const a = await user(); const b = await user();
    const fid = await upload(a, 'mine.txt', 'my data');
    await upload(b, 'theirs.txt', 'not mine');
    await call(a, 'POST', '/shares', { fileId: fid, expiresInHours: 24, acknowledgePublic: true, password: 'a-long-password' });
    await t.db.query(`INSERT INTO notifications (user_id, kind, title) VALUES ($1, 'download_failed', 'oops')`, [a.userId]);
    const r = await call(a, 'GET', '/account/export');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toContain('attachment');
    expect(r.headers['cache-control']).toBe('no-store');
    const doc = JSON.parse(r.body);
    expect(doc.format).toBe('cloudseed-export-v1');
    expect(doc.account.email).toBe(emailOf(seq - 1));
    expect(doc.files.map((f: any) => f.name)).toEqual(['mine.txt']);
    expect(doc.shareLinks).toHaveLength(1);
    expect(doc.shareLinks[0].password_protected).toBe(true);
    expect(doc.notifications.some((n: any) => n.title === 'oops')).toBe(true);
    expect(doc.activity.length).toBeGreaterThan(0);
    for (const secret of ['token_hash', 'password_hash', 'storage_key', 'csrf', 'bot_token', 'encrypted', 'theirs.txt', emailOf(seq)]) {
      expect(r.body).not.toContain(secret);
    }
  });
});

describe('account deletion', () => {
  it('requires the exact email address', async () => {
    const s = await user();
    const r = await call(s, 'POST', '/account/delete', { confirmEmail: 'someone-else@example.com' });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('confirmation_mismatch');
    expect((await call(s, 'GET', '/account/settings')).statusCode).toBe(200);
  });

  it('removes the account, its data, its sessions, its share links and its stored objects, and nothing of anyone else', async () => {
    const a = await user(); const b = await user();
    const email = (await t.db.query<any>(`SELECT email FROM users WHERE id = $1`, [a.userId])).rows[0].email;
    const fid = await upload(a, 'gone.txt', 'bye');
    const keep = await upload(b, 'stays.txt', 'still here');
    const share = (await call(a, 'POST', '/shares', { fileId: fid, expiresInHours: 24, acknowledgePublic: true })).json();
    const key = (await t.db.query<any>(`SELECT storage_key FROM files WHERE id = $1`, [fid])).rows[0].storage_key;
    const keepKey = (await t.db.query<any>(`SELECT storage_key FROM files WHERE id = $1`, [keep])).rows[0].storage_key;
    const onDisk = (k: string) => access(path.join(t.config.LOCAL_STORAGE_ROOT, k)).then(() => true, () => false);
    expect(await onDisk(key)).toBe(true);

    const r = await call(a, 'POST', '/account/delete', { confirmEmail: email.toUpperCase() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ deleted: true, objectsRemoved: 1 });

    expect((await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: a.cookie } })).statusCode).toBe(401);
    expect(await onDisk(key)).toBe(false);
    expect(await onDisk(keepKey)).toBe(true);
    for (const table of ['files', 'folders', 'sessions', 'shared_links', 'storage_quotas', 'user_profiles', 'oauth_accounts']) {
      expect((await t.db.query<any>(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [a.userId])).rows[0].n, table).toBe(0);
    }
    expect((await t.db.query<any>(`SELECT 1 FROM users WHERE id = $1`, [a.userId])).rows).toHaveLength(0);
    // the old public link is dead
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/public/shares/${share.token}` })).statusCode).toBe(404);
    // the other user is untouched
    expect((await call(b, 'GET', '/files')).statusCode).toBe(200);
    // the deletion is on record, without the email address
    const log = (await t.db.query<any>(`SELECT * FROM audit_logs WHERE action = 'account.deleted' AND target = $1`, [`user:${a.userId}`])).rows;
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log)).not.toContain(email);
  });

  it('can be repeated by signing in again, as a brand-new account', async () => {
    const a = await user();
    const email = (await t.db.query<any>(`SELECT email FROM users WHERE id = $1`, [a.userId])).rows[0].email;
    await call(a, 'POST', '/account/delete', { confirmEmail: email });
    const again = await login(t, `acc-${seq}`, email);
    expect(again.userId).not.toBe(a.userId);
  });

  it('will not delete the only administrator, but allows it once another exists', async () => {
    // admins come from ADMIN_EMAILS; a fresh environment keeps this independent of the other users
    const env = await createTestEnv();
    try {
      const admin = await login(env, 'root', 'admin@example.com'); // ADMIN_EMAILS in the test config
      expect((await env.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: admin.cookie } })).json().user.roles).toContain('admin');
      const del = (s: Session) => env.app.inject({ method: 'POST', url: '/api/v1/account/delete', headers: authed(s), payload: { confirmEmail: 'admin@example.com' } });
      const blocked = await del(admin);
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error.code).toBe('last_admin');
      const other = await login(env, 'second', 'second@example.com');
      await env.db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 2)`, [other.userId]);
      expect((await del(admin)).statusCode).toBe(200);
    } finally { await env.close(); }
  });
});
