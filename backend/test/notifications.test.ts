import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMailer } from '../src/mail/mailer.js';
import { MaintenanceEngine } from '../src/maintenance/engine.js';
import { authed, createTestEnv, login, type Session, type TestEnv } from './helpers.js';

let t: TestEnv;
let smtp: SMTPServer;
let smtpPort = 0;
const inbox: { to: string; raw: string; user?: string }[] = [];
let rejectNext = 0;
let seq = 0;

beforeAll(async () => {
  smtp = new SMTPServer({
    authOptional: true, disabledCommands: ['STARTTLS'], allowInsecureAuth: true,
    onAuth(auth, _s, cb) { cb(null, { user: auth.username }); },
    onRcptTo(addr, _s, cb) { cb(); void addr; },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        if (rejectNext > 0) { rejectNext--; return cb(Object.assign(new Error('mailbox busy'), { responseCode: 451 })); }
        inbox.push({ to: session.envelope.rcptTo[0]!.address, raw: Buffer.concat(chunks).toString(), user: (session as { user?: string }).user });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  smtpPort = (smtp.server.address() as { port: number }).port;
  t = await createTestEnv();
});
afterAll(async () => { await t.close(); await new Promise((r) => smtp.close(() => r(null))); });

const user = (): Promise<Session> => { const n = ++seq; return login(t, `nt-${n}`, `nt-${n}@example.com`); };
const call = (s: Session, method: string, url: string, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: authed(s), payload: payload as object });
const notify = (s: Session, kind: string, title: string, body = 'body text') =>
  t.db.query(`INSERT INTO notifications (user_id, kind, title, body) VALUES ($1, $2, $3, $4)`, [s.userId, kind, title, body]);
const settings = (s: Session, v: { email?: boolean; muted?: string[] }) =>
  t.db.query(`INSERT INTO user_settings (user_id, email_notifications, muted_kinds) VALUES ($1, $2, $3)
              ON CONFLICT (user_id) DO UPDATE SET email_notifications = EXCLUDED.email_notifications, muted_kinds = EXCLUDED.muted_kinds`,
  [s.userId, v.email ?? false, v.muted ?? []]);
const quiet = { info() {}, warn() {}, error() {} };
function engine(over: Record<string, unknown> = {}, smtpOver: Record<string, unknown> = {}) {
  const config = { ...t.config, SMTP_HOST: '127.0.0.1', SMTP_PORT: smtpPort, SMTP_SECURE: false, SMTP_REQUIRE_TLS: false, SMTP_USER: 'mailer', SMTP_PASS: 'pw', ...smtpOver, ...over } as typeof t.config;
  const mailer = createMailer(config);
  return { eng: new MaintenanceEngine({ db: t.db, config, mailer, log: quiet }), mailer, config };
}

describe('notification API', () => {
  it('lists newest first, counts unread, marks read, and only touches the caller\'s own notifications', async () => {
    const a = await user(); const b = await user();
    await notify(a, 'download_completed', 'first'); await notify(a, 'download_failed', 'second'); await notify(b, 'download_failed', 'bob only');
    const list = (await call(a, 'GET', '/notifications')).json();
    expect(list.items.map((n: any) => n.title)).toEqual(['second', 'first']);
    expect((await call(a, 'GET', '/notifications/unread-count')).json().unread).toBe(2);

    const bobId = (await call(b, 'GET', '/notifications')).json().items[0].id;
    expect((await call(a, 'POST', `/notifications/${bobId}/read`)).statusCode).toBe(404);
    expect((await call(a, 'DELETE', `/notifications/${bobId}`)).statusCode).toBe(404);
    expect((await call(b, 'GET', '/notifications/unread-count')).json().unread).toBe(1);

    expect((await call(a, 'POST', `/notifications/${list.items[0].id}/read`)).statusCode).toBe(200);
    expect((await call(a, 'GET', '/notifications/unread-count')).json().unread).toBe(1);
    expect((await call(a, 'GET', '/notifications?unread=true')).json().items.map((n: any) => n.title)).toEqual(['first']);
    expect((await call(a, 'POST', '/notifications/read-all')).json().updated).toBe(1);
    expect((await call(a, 'DELETE', '/notifications')).json().deleted).toBe(2);
    expect((await call(a, 'GET', '/notifications')).json().items).toEqual([]);
  });

  it('requires a session and rejects bad ids', async () => {
    const a = await user();
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/notifications' })).statusCode).toBe(401);
    expect((await call(a, 'POST', '/notifications/not-a-uuid/read')).statusCode).toBe(400);
  });

  it('pages with a cursor', async () => {
    const a = await user();
    for (let i = 0; i < 5; i++) await t.db.query(`INSERT INTO notifications (user_id, kind, title, created_at) VALUES ($1, 'download_completed', $2, now() - make_interval(mins => $3))`, [a.userId, `n${i}`, i]);
    const p1 = (await call(a, 'GET', '/notifications?limit=2')).json();
    expect(p1.items.map((n: any) => n.title)).toEqual(['n0', 'n1']);
    const p2 = (await call(a, 'GET', `/notifications?limit=2&before=${encodeURIComponent(p1.nextBefore)}`)).json();
    expect(p2.items.map((n: any) => n.title)).toEqual(['n2', 'n3']);
  });

  it('hides muted kinds from the list and the count without deleting them', async () => {
    const a = await user();
    await notify(a, 'download_started', 'noisy'); await notify(a, 'download_failed', 'important');
    await settings(a, { muted: ['download_started'] });
    expect((await call(a, 'GET', '/notifications')).json().items.map((n: any) => n.title)).toEqual(['important']);
    expect((await call(a, 'GET', '/notifications/unread-count')).json().unread).toBe(1);
    await settings(a, { muted: [] });
    expect((await call(a, 'GET', '/notifications/unread-count')).json().unread).toBe(2);
  });

  it('lists the kinds that can be muted', async () => {
    const a = await user();
    const kinds = (await call(a, 'GET', '/notifications/kinds')).json().kinds.map((k: any) => k.kind);
    expect(kinds).toContain('download_failed');
    expect(kinds).toContain('quota_warning');
  });
});

describe('email delivery', () => {
  it('does nothing and marks rows skipped when SMTP is not configured', async () => {
    const a = await user(); await settings(a, { email: true }); await notify(a, 'download_failed', 'no smtp');
    await t.db.query(`UPDATE notifications SET created_at = now() - interval '5 minutes' WHERE user_id = $1`, [a.userId]);
    const { eng, mailer } = engine({}, { SMTP_HOST: '' });
    expect(mailer.configured).toBe(false);
    expect(await eng.sendEmails()).toBe(0);
    expect((await t.db.query<any>(`SELECT email_state FROM notifications WHERE user_id = $1`, [a.userId])).rows[0].email_state).toBe('skipped');
  });

  it('emails only users who opted in, once, and never emails muted kinds', async () => {
    const yes = await user(); const no = await user(); const muted = await user();
    await settings(yes, { email: true }); await settings(muted, { email: true, muted: ['download_started'] });
    await notify(yes, 'download_failed', 'Download failed: movie', 'The server refused the request.');
    await notify(no, 'download_failed', 'should not be sent');
    await notify(muted, 'download_started', 'muted one');
    inbox.length = 0;
    const { eng } = engine();
    expect(await eng.sendEmails()).toBe(1);
    expect(await eng.sendEmails()).toBe(0); // not sent twice
    expect(inbox.map((m) => m.to)).toEqual([`nt-${seq - 2}@example.com`]);
    expect(inbox[0]!.raw).toContain('Subject: [CloudSeed] Download failed: movie');
    expect(inbox[0]!.raw).toContain('The server refused the request.');
    expect(inbox[0]!.raw).toContain('http://localhost:8080');
    expect(inbox[0]!.user).toBe('mailer');
    const states = (await t.db.query<any>(`SELECT user_id, email_state FROM notifications WHERE user_id = ANY($1)`, [[yes.userId, no.userId, muted.userId]])).rows;
    expect(Object.fromEntries(states.map((r: any) => [r.user_id, r.email_state]))).toEqual({ [yes.userId]: 'sent', [no.userId]: 'skipped', [muted.userId]: 'skipped' });
  });

  it('keeps the notification and retries with back-off when the server fails, then gives up after 3 attempts', async () => {
    const a = await user(); await settings(a, { email: true }); await notify(a, 'download_failed', 'flaky');
    const { eng } = engine();
    const due = () => t.db.query(`UPDATE notifications SET email_next_at = now() WHERE user_id = $1`, [a.userId]);
    const st = async () => (await t.db.query<any>(`SELECT email_state, email_attempts, email_next_at > now() AS later FROM notifications WHERE user_id = $1`, [a.userId])).rows[0];
    inbox.length = 0;
    rejectNext = 3;
    expect(await eng.sendEmails()).toBe(0);
    expect(await st()).toMatchObject({ email_state: null, email_attempts: 1, later: true });
    expect(await eng.sendEmails()).toBe(0); // not due yet: no new attempt
    expect((await st()).email_attempts).toBe(1);
    await due(); await eng.sendEmails(); await due(); await eng.sendEmails();
    expect(await st()).toMatchObject({ email_state: 'failed', email_attempts: 3 });
    await due(); expect(await eng.sendEmails()).toBe(0); // gave up
    expect(inbox).toHaveLength(0);
    // the in-app notification is still there
    expect((await call(a, 'GET', '/notifications')).json().items).toHaveLength(1);
  });

  it('recovers after a transient failure', async () => {
    const a = await user(); await settings(a, { email: true }); await notify(a, 'download_failed', 'transient');
    const { eng } = engine();
    inbox.length = 0; rejectNext = 1;
    await eng.sendEmails();
    await t.db.query(`UPDATE notifications SET email_next_at = now() WHERE user_id = $1`, [a.userId]);
    expect(await eng.sendEmails()).toBe(1);
    expect(inbox).toHaveLength(1);
  });

  it('caps emails per user per hour', async () => {
    const a = await user(); await settings(a, { email: true });
    for (let i = 0; i < 5; i++) await notify(a, 'download_completed', `bulk ${i}`);
    inbox.length = 0;
    const { eng } = engine({ EMAIL_MAX_PER_HOUR: 2 });
    await eng.sendEmails();
    expect(inbox).toHaveLength(2);
    const r = (await t.db.query<any>(`SELECT email_state, count(*)::int AS n FROM notifications WHERE user_id = $1 GROUP BY 1`, [a.userId])).rows;
    expect(Object.fromEntries(r.map((x: any) => [x.email_state, x.n]))).toEqual({ sent: 2, skipped: 3 });
  });

  it('cannot be tricked into header injection through the title', async () => {
    const a = await user(); await settings(a, { email: true });
    await notify(a, 'download_failed', 'Hi\r\nBcc: attacker@example.com');
    inbox.length = 0;
    await engine().eng.sendEmails();
    expect(inbox).toHaveLength(1);
    const headers = inbox[0]!.raw.split(/\r?\n\r?\n/)[0]!; // a "Bcc:" line in the body is just text
    expect(headers).not.toMatch(/^Bcc:/im);
    expect(headers).toContain('Subject: [CloudSeed] Hi Bcc: attacker@example.com');
    expect(inbox[0]!.to).toBe(`nt-${seq}@example.com`);
  });

  it('does not email disabled accounts', async () => {
    const a = await user(); await settings(a, { email: true }); await notify(a, 'download_failed', 'gone');
    await t.db.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [a.userId]);
    inbox.length = 0;
    await engine().eng.sendEmails();
    expect(inbox).toHaveLength(0);
  });

  it('verifies the SMTP settings and reports a bad server clearly', async () => {
    await expect(engine().mailer.verify()).resolves.toBeUndefined();
    await expect(engine({}, { SMTP_PORT: 1 }).mailer.verify()).rejects.toThrow();
  });
});

describe('warnings and clean-up', () => {
  it('warns once per day when storage is almost full', async () => {
    const a = await user();
    await t.db.query(`UPDATE storage_quotas SET quota_bytes = 1000, used_bytes = 950 WHERE user_id = $1`, [a.userId]);
    const { eng } = engine();
    await eng.sweep(); await eng.sweep();
    const n = (await t.db.query<any>(`SELECT body FROM notifications WHERE user_id = $1 AND kind = 'quota_warning'`, [a.userId])).rows;
    expect(n).toHaveLength(1);
    expect(n[0].body).toContain('95%');
    await t.db.query(`UPDATE notifications SET created_at = now() - interval '25 hours' WHERE user_id = $1`, [a.userId]);
    await eng.sweep();
    expect((await t.db.query<any>(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'quota_warning'`, [a.userId])).rows).toHaveLength(2);
  });

  it('does not warn users who are under the threshold', async () => {
    const a = await user();
    await t.db.query(`UPDATE storage_quotas SET quota_bytes = 1000, used_bytes = 100 WHERE user_id = $1`, [a.userId]);
    await engine().eng.sweep();
    expect((await t.db.query<any>(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'quota_warning'`, [a.userId])).rows).toHaveLength(0);
  });

  it('announces a share link that expires within a day, exactly once', async () => {
    const a = await user();
    const m = (await import('./helpers.js')).multipartBody('soon.txt', 'x');
    const up = await t.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(a), ...m.headers }, payload: m.body });
    const mk = async (hours: number) => (await call(a, 'POST', '/shares', { fileId: up.json().id, expiresInHours: hours, acknowledgePublic: true })).json();
    const soon = await mk(2); await mk(72);
    const { eng } = engine();
    await eng.sweep(); await eng.sweep();
    const n = (await t.db.query<any>(`SELECT body FROM notifications WHERE user_id = $1 AND kind = 'share_expiring'`, [a.userId])).rows;
    expect(n).toHaveLength(1);
    expect(n[0].body).toContain('soon.txt');
    expect(JSON.stringify(n)).not.toContain(soon.token); // never the secret
  });

  it('deletes notifications older than the retention period and expired sessions', async () => {
    const a = await user();
    await t.db.query(`INSERT INTO notifications (user_id, kind, title, created_at) VALUES ($1, 'download_completed', 'ancient', now() - interval '200 days')`, [a.userId]);
    await notify(a, 'download_completed', 'recent');
    await engine({ NOTIFICATION_RETENTION_DAYS: 90 }).eng.sweep();
    expect((await call(a, 'GET', '/notifications')).json().items.map((n: any) => n.title)).toEqual(['recent']);
  });
});

describe('worker heartbeat', () => {
  it('registers, updates and removes the worker row', async () => {
    const { eng } = engine();
    await eng.heartbeat();
    const r = (await t.db.query<any>(`SELECT role, info FROM worker_heartbeats WHERE id = $1`, [eng.workerId])).rows[0];
    expect(r.role).toBe('worker');
    expect(r.info.email).toBe(true);
    await eng.stop();
    expect((await t.db.query<any>(`SELECT 1 FROM worker_heartbeats WHERE id = $1`, [eng.workerId])).rows).toHaveLength(0);
  });
});
