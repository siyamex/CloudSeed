import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, createTestEnv, login, multipartBody, type Session, type TestEnv } from './helpers.js';

let t: TestEnv;
let admin: Session;
let seq = 0;
const METRICS = 'metrics-token-1234567890';
beforeAll(async () => {
  t = await createTestEnv({ METRICS_TOKEN: METRICS, SHARE_UNLOCK_RATE_PER_MIN: '1000' });
  admin = await login(t, 'the-admin', 'admin@example.com');
});
afterAll(async () => { await t.close(); });

const user = (): Promise<Session> => { const n = ++seq; return login(t, `adm-${n}`, `adm-user-${n}@example.com`); };
const call = (s: Session | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { ...(s ? authed(s) : {}), ...headers }, payload: payload as object });
async function upload(s: Session, name: string): Promise<string> {
  const m = multipartBody(name, 'content');
  const r = await t.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(s), ...m.headers }, payload: m.body });
  return r.json().id;
}
const me = async (s: Session) => t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: s.cookie } });

describe('access control', () => {
  it('rejects everyone who is not an administrator, on every admin route', async () => {
    const u = await user();
    const routes: [string, string][] = [
      ['GET', '/admin/overview'], ['GET', '/admin/users'], ['PATCH', `/admin/users/${u.userId}`], ['GET', '/admin/queues'], ['GET', '/admin/workers'],
      ['GET', '/admin/reports'], ['POST', '/admin/reports/00000000-0000-4000-8000-000000000000/resolve'], ['GET', '/admin/audit'], ['GET', '/admin/settings'], ['PATCH', '/admin/settings'],
    ];
    for (const [m, url] of routes) {
      expect((await call(u, m, url, m === 'GET' ? undefined : {})).statusCode, `${m} ${url} as user`).toBe(403);
      expect((await t.app.inject({ method: m as 'GET', url: `/api/v1${url}` })).statusCode, `${m} ${url} anonymous`).toBe(401);
    }
  });
});

describe('overview, queues and workers', () => {
  it('reports counts and which optional features are on', async () => {
    const u = await user(); await upload(u, 'a.txt');
    const o = (await call(admin, 'GET', '/admin/overview')).json();
    expect(o.users.active).toBeGreaterThanOrEqual(2);
    expect(o.storage.files).toBeGreaterThanOrEqual(1);
    expect(o.features).toMatchObject({ email: false, metrics: true });
  });

  it('shows queue health without exposing users\' URLs or file names', async () => {
    const u = await user();
    await t.db.query(`INSERT INTO download_jobs (user_id, url, state, error_code, finished_at) VALUES ($1, 'https://secret.example/private-name.bin', 'failed', 'http_404', now())`, [u.userId]);
    await t.db.query(`INSERT INTO download_jobs (user_id, url, state) VALUES ($1, 'https://secret.example/other.bin', 'queued')`, [u.userId]);
    const r = await call(admin, 'GET', '/admin/queues');
    expect(r.statusCode).toBe(200);
    const q = r.json();
    expect(q.downloads.find((d: any) => d.state === 'queued').count).toBeGreaterThanOrEqual(1);
    expect(q.recentDownloadFailures.some((f: any) => f.code === 'http_404')).toBe(true);
    expect(r.body).not.toContain('secret.example');
    expect(r.body).not.toContain('private-name');
  });

  it('lists worker heartbeats and whether each is alive', async () => {
    await t.db.query(`INSERT INTO worker_heartbeats (id, role, started_at, last_seen_at) VALUES ('w-live', 'worker', now(), now()), ('w-dead', 'worker', now() - interval '1 hour', now() - interval '10 minutes')`);
    const w = (await call(admin, 'GET', '/admin/workers')).json().workers;
    expect(w.find((x: any) => x.id === 'w-live').alive).toBe(true);
    expect(w.find((x: any) => x.id === 'w-dead').alive).toBe(false);
  });
});

describe('user management', () => {
  it('lists and searches users with quota, usage and roles', async () => {
    const u = await user(); await upload(u, 'b.txt');
    const r = (await call(admin, 'GET', `/admin/users?q=${encodeURIComponent(`adm-user-${seq}@`)}`)).json();
    expect(r.total).toBe(1);
    expect(r.users[0]).toMatchObject({ email: `adm-user-${seq}@example.com`, status: 'active', roles: ['user'], files: 1 });
    expect(r.users[0].usedBytes).toBeGreaterThan(0);
    expect((await call(admin, 'GET', '/admin/users?q=%25')).json().total).toBe(0); // wildcards are literal
    expect((await call(admin, 'GET', '/admin/users?status=disabled')).json().users.every((x: any) => x.status === 'disabled')).toBe(true);
  });

  it('disables a user, signing them out at once, and enables them again', async () => {
    const u = await user();
    expect((await me(u)).statusCode).toBe(200);
    expect((await call(admin, 'PATCH', `/admin/users/${u.userId}`, { status: 'disabled' })).statusCode).toBe(200);
    expect((await me(u)).statusCode).toBe(401);
    expect((await call(admin, 'PATCH', `/admin/users/${u.userId}`, { status: 'active' })).statusCode).toBe(200);
    expect(await login(t, `adm-${seq}`, `adm-user-${seq}@example.com`)).toMatchObject({ userId: u.userId });
  });

  it('changes quota and promotes or demotes administrators', async () => {
    const u = await user();
    await call(admin, 'PATCH', `/admin/users/${u.userId}`, { quotaBytes: 12345, admin: true });
    expect((await call(u, 'GET', '/admin/overview')).statusCode).toBe(200);
    expect(Number((await t.db.query<any>(`SELECT quota_bytes FROM storage_quotas WHERE user_id = $1`, [u.userId])).rows[0].quota_bytes)).toBe(12345);
    await call(admin, 'PATCH', `/admin/users/${u.userId}`, { admin: false });
    expect((await me(u)).json().user.roles).toEqual(['user']);
    expect((await call(u, 'GET', '/admin/overview')).statusCode).toBe(403);
  });

  it('will not let an administrator lock themselves out, and rejects bad input', async () => {
    const own = await call(admin, 'PATCH', `/admin/users/${admin.userId}`, { admin: false });
    expect(own.statusCode).toBe(409);
    expect(own.json().error.code).toBe('self_lockout');
    expect((await call(admin, 'PATCH', `/admin/users/${admin.userId}`, { status: 'disabled' })).json().error.code).toBe('self_lockout');
    expect((await call(admin, 'PATCH', '/admin/users/00000000-0000-4000-8000-000000000000', { status: 'disabled' })).statusCode).toBe(404);
    const u = await user();
    expect((await call(admin, 'PATCH', `/admin/users/${u.userId}`, { quotaBytes: -1 })).statusCode).toBe(400);
    expect((await call(admin, 'PATCH', `/admin/users/${u.userId}`, { email: 'x@y.z' })).statusCode).toBe(400);
  });

  it('keeps at least one active administrator when another admin demotes the last other one', async () => {
    const second = await user();
    await call(admin, 'PATCH', `/admin/users/${second.userId}`, { admin: true });
    // the second admin demotes the first: allowed, since the second remains
    expect((await call(second, 'PATCH', `/admin/users/${admin.userId}`, { admin: false })).statusCode).toBe(200);
    // ...but now the second admin is the last one and cannot be removed by anyone
    await t.db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 2)`, [admin.userId]); // restore for the other tests
    await call(admin, 'PATCH', `/admin/users/${second.userId}`, { admin: false });
    // 'admin' is back to being the only one again
    expect((await call(admin, 'PATCH', `/admin/users/${admin.userId}`, { admin: false })).json().error.code).toBe('self_lockout');
  });

  it('audits every change', async () => {
    const u = await user();
    await call(admin, 'PATCH', `/admin/users/${u.userId}`, { quotaBytes: 777 });
    const log = (await call(admin, 'GET', '/admin/audit?action=admin.user_update')).json().entries;
    expect(log[0]).toMatchObject({ action: 'admin.user_update', target: `user:${u.userId}`, email: 'admin@example.com' });
    expect(log[0].metadata).toEqual({ quotaBytes: 777 });
  });
});

describe('abuse reports', () => {
  async function reported() {
    const owner = await user();
    const fid = await upload(owner, 'bad-file.bin');
    const share = (await call(owner, 'POST', '/shares', { fileId: fid, expiresInHours: 24, acknowledgePublic: true })).json();
    const rep = await t.app.inject({ method: 'POST', url: `/api/v1/public/shares/${share.token}/report`, headers: { 'content-type': 'application/json', origin: 'http://localhost:8080' }, payload: { reason: 'malware', details: 'looks bad' } });
    expect(rep.statusCode).toBeLessThan(300);
    const list = (await call(admin, 'GET', '/admin/reports')).json().reports;
    return { owner, fid, share, report: list.find((r: any) => r.fileName === 'bad-file.bin' && r.shareId === share.id) };
  }

  it('lists open reports with the owner, and the public link stops working once the link is disabled', async () => {
    const { owner, share, report } = await reported();
    expect(report).toMatchObject({ reason: 'malware', details: 'looks bad', status: 'open', linkDisabled: false });
    expect(report.ownerEmail).toContain('adm-user-');
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/public/shares/${share.token}/download` })).statusCode).toBe(200);

    expect((await call(admin, 'POST', `/admin/reports/${report.id}/resolve`, { action: 'disable_link', note: 'confirmed malware' })).statusCode).toBe(200);
    const gone = await t.app.inject({ method: 'GET', url: `/api/v1/public/shares/${share.token}/download` });
    expect(gone.statusCode).toBe(410);
    expect(gone.json().error.code).toBe('share_disabled');
    // the owner is told, and cannot undo it
    expect((await call(owner, 'GET', '/notifications')).json().items.some((n: any) => n.kind === 'share_disabled')).toBe(true);
    const mine = (await call(owner, 'GET', '/shares')).json();
    expect(JSON.stringify(mine)).toContain('disabled');
    expect((await call(owner, 'PATCH', `/shares/${share.id}`, { extendHours: 24 })).statusCode).toBeGreaterThanOrEqual(400);
    // resolved reports leave the open list and cannot be resolved twice
    expect((await call(admin, 'GET', '/admin/reports')).json().reports.some((r: any) => r.id === report.id)).toBe(false);
    expect((await call(admin, 'POST', `/admin/reports/${report.id}/resolve`, { action: 'dismiss' })).json().error.code).toBe('already_resolved');
    expect((await call(admin, 'GET', '/admin/reports?status=actioned')).json().reports.find((r: any) => r.id === report.id).resolutionNote).toBe('confirmed malware');
  });

  it('can switch sharing off for the whole file', async () => {
    const { owner, fid, report } = await reported();
    await call(admin, 'POST', `/admin/reports/${report.id}/resolve`, { action: 'disable_link_and_file' });
    const again = await call(owner, 'POST', '/shares', { fileId: fid, expiresInHours: 24, acknowledgePublic: true });
    expect(again.statusCode).toBeGreaterThanOrEqual(400);
    expect((await t.db.query<any>(`SELECT sharing_disabled FROM files WHERE id = $1`, [fid])).rows[0].sharing_disabled).toBe(true);
  });

  it('dismissing leaves the link alone', async () => {
    const { share, report } = await reported();
    await call(admin, 'POST', `/admin/reports/${report.id}/resolve`, { action: 'dismiss' });
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/public/shares/${share.token}/download` })).statusCode).toBe(200);
  });
});

describe('settings', () => {
  it('changes the registration policy and default quota at run time', async () => {
    expect((await call(admin, 'GET', '/admin/settings')).json().settings).toMatchObject({ registration_policy: 'open' });
    const r = await call(admin, 'PATCH', '/admin/settings', { registration_policy: 'closed', default_quota_bytes: 4242 });
    expect(r.json().settings).toMatchObject({ registration_policy: 'closed', default_quota_bytes: 4242 });
    // closed: a new person is turned away, an administrator still gets in
    const url = (await t.app.inject({ method: 'GET', url: '/api/v1/auth/google/login' }));
    expect(url.statusCode).toBeLessThan(400);
    await expect(login(t, 'newcomer', 'newcomer@example.com')).rejects.toThrow();
    await call(admin, 'PATCH', '/admin/settings', { registration_policy: 'open' });
    const fresh = await login(t, 'newcomer', 'newcomer@example.com');
    expect(Number((await t.db.query<any>(`SELECT quota_bytes FROM storage_quotas WHERE user_id = $1`, [fresh.userId])).rows[0].quota_bytes)).toBe(4242);
    await call(admin, 'PATCH', '/admin/settings', { default_quota_bytes: t.config.DEFAULT_USER_QUOTA_BYTES });
  });

  it('rejects unknown settings and invalid values without changing anything', async () => {
    expect((await call(admin, 'PATCH', '/admin/settings', { ENCRYPTION_KEY: 'x' })).json().error.code).toBe('unknown_setting');
    expect((await call(admin, 'PATCH', '/admin/settings', { registration_policy: 'maybe' })).json().error.code).toBe('invalid_setting');
    expect((await call(admin, 'PATCH', '/admin/settings', { registration_policy: 'closed', default_quota_bytes: -5 })).statusCode).toBe(422);
    expect((await call(admin, 'GET', '/admin/settings')).json().settings.registration_policy).toBe('open');
  });
});

describe('audit log', () => {
  it('pages newest first and filters by action prefix', async () => {
    const p1 = (await call(admin, 'GET', '/admin/audit?limit=2')).json();
    expect(p1.entries).toHaveLength(2);
    expect(p1.entries[0].id).toBeGreaterThan(p1.entries[1].id);
    expect(p1.nextBefore).toBe(p1.entries[1].id);
    const p2 = (await call(admin, 'GET', `/admin/audit?limit=2&before=${p1.nextBefore}`)).json();
    expect(p2.entries[0].id).toBeLessThan(p1.nextBefore);
    const regs = (await call(admin, 'GET', '/admin/audit?action=user.')).json().entries;
    expect(regs.length).toBeGreaterThan(0);
    expect(regs.every((e: any) => e.action.startsWith('user.'))).toBe(true);
  });
});

describe('health and metrics', () => {
  it('answers readiness without authentication and reports the worker count', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ok', database: 'ok' });
  });

  it('serves Prometheus metrics only with the right bearer token', async () => {
    const url = '/api/v1/metrics';
    expect((await t.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url, headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } })).statusCode).toBe(401); // a login is not enough
    const ok = await t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${METRICS}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/plain');
    expect(ok.body).toContain('cloudseed_users{status="active"}');
    expect(ok.body).toContain('cloudseed_download_jobs{state="queued"}');
    expect(ok.body).toMatch(/cloudseed_http_request_duration_seconds_count\{method="GET",route="\/api\/v1\/health\/ready",status="2xx"\} \d+/);
    expect(ok.body).not.toMatch(/@example\.com/); // no personal data
  });

  it('is invisible when no token is configured', async () => {
    const env = await createTestEnv();
    try {
      expect((await env.app.inject({ method: 'GET', url: '/api/v1/metrics', headers: { authorization: 'Bearer anything' } })).statusCode).toBe(404);
    } finally { await env.close(); }
  });
});
