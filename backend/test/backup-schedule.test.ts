import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackup, restoreBackup } from '../src/backup/backup.js';
import { restoreDrill } from '../src/backup/drill.js';
import { BackupScheduler } from '../src/backup/scheduler.js';
import { loadConfig, type Config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { LocalStorage } from '../src/storage/local.js';
import { authed, createTestDb, createTestEnv, login, MIGRATIONS, multipartBody, type Session, type TestEnv } from './helpers.js';

const PASS = 'scheduled backup passphrase';
let t: TestEnv;
let admin: Session;
let dir: string;
let n = 0;
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cs-sched-'));
  t = await createTestEnv({ BACKUP_INTERVAL_HOURS: '24', BACKUP_PASSPHRASE: PASS, BACKUP_DIR: path.join(dir, 'a'), BACKUP_KEEP: '2' });
  admin = await login(t, 'sched-admin', 'admin@example.com');
  const m = multipartBody('data.txt', 'something worth backing up');
  await t.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(admin), ...m.headers }, payload: m.body });
});
afterAll(async () => { await t.close(); await rm(dir, { recursive: true, force: true }); });

const cfg = (over: Record<string, unknown> = {}) => ({ ...t.config, ...over }) as Config;
const adapterFor = (k: string) => (k === 'local' ? t.storage : undefined);
const scheduler = (over: Record<string, unknown> = {}, id = `w${++n}`) => new BackupScheduler({ db: t.db, config: cfg(over), adapterFor, log: quiet, workerId: id });
const runs = async () => (await t.db.query<any>(`SELECT * FROM backup_runs ORDER BY requested_at, id`)).rows;
const reset = () => t.db.query(`DELETE FROM backup_runs`);
const files = async (sub = 'a') => (await readdir(path.join(dir, sub)).catch(() => [])).sort();
const call = (s: Session, method: string, url: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: authed(s), payload: payload as object });

describe('configuration', () => {
  it('refuses a schedule without a passphrase, and a passphrase that is too short', () => {
    const base = { NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40) } as NodeJS.ProcessEnv;
    expect(() => loadConfig({ ...base, BACKUP_INTERVAL_HOURS: '12' })).toThrow(/BACKUP_PASSPHRASE/);
    expect(() => loadConfig({ ...base, BACKUP_PASSPHRASE: 'short' })).toThrow(/at least 12/);
    expect(loadConfig({ ...base, BACKUP_INTERVAL_HOURS: '12', BACKUP_PASSPHRASE_FILE: '/run/secrets/x' }).BACKUP_INTERVAL_HOURS).toBe(12);
  });
});

describe('the schedule', () => {
  it('makes a verified, encrypted backup when one is due, and not again before the interval has passed', async () => {
    await reset();
    const s = scheduler();
    const id = await s.cycle();
    expect(id).not.toBeNull();
    const [r] = await runs();
    expect(r).toMatchObject({ trigger: 'schedule', status: 'succeeded', verified: true, missing_count: 0, corrupt_count: 0, error: null });
    expect(r.file_name).toMatch(/^cloudseed-\d{8}-\d{6}-[0-9a-f]{6}\.csbk$/);
    expect(r.object_count).toBe(1);
    expect(Number(r.bytes)).toBe((await stat(path.join(dir, 'a', r.file_name))).size);
    expect((await files()).includes(r.file_name)).toBe(true);

    expect(await s.cycle()).toBeNull(); // nothing is due
    expect(await runs()).toHaveLength(1);
    await t.db.query(`UPDATE backup_runs SET requested_at = now() - interval '25 hours'`);
    expect(await s.cycle()).not.toBeNull(); // the interval has passed
    expect(await runs()).toHaveLength(2);
  });

  it('does nothing without a schedule (interval 0) but still serves manual requests', async () => {
    await reset();
    const s = scheduler({ BACKUP_INTERVAL_HOURS: 0 });
    expect(await s.cycle()).toBeNull();
    expect(await runs()).toHaveLength(0);
    await t.db.query(`INSERT INTO backup_runs (trigger) VALUES ('manual')`);
    expect(await s.cycle()).not.toBeNull();
    expect((await runs())[0]).toMatchObject({ trigger: 'manual', status: 'succeeded' });
  });

  it('two workers at once produce exactly one backup', async () => {
    await reset();
    const before = await files();
    const [a, b] = await Promise.all([scheduler().cycle(), scheduler().cycle()]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await runs()).toHaveLength(1);
    const after = await files();
    expect(after.length - before.length).toBe(1); // one new file, not two
    expect(after).toContain((await runs())[0].file_name);
  });

  it('keeps only the newest N verified backups and leaves unrelated files alone', async () => {
    await reset();
    await writeFile(path.join(dir, 'a', 'notes.txt'), 'mine');
    const s = scheduler();
    for (let i = 0; i < 4; i++) {
      await s.cycle();
      await t.db.query(`UPDATE backup_runs SET requested_at = requested_at - interval '30 hours'`); // make the next one due
      await new Promise((r) => setTimeout(r, 1100)); // distinct file names (one-second resolution)
    }
    const all = await runs();
    const kept = all.filter((r) => r.pruned_at === null);
    expect(kept).toHaveLength(2);
    expect(all.filter((r) => r.pruned_at !== null)).toHaveLength(2);
    const onDisk = await files();
    for (const r of kept) expect(onDisk).toContain(r.file_name);
    for (const r of all.filter((x) => x.pruned_at !== null)) expect(onDisk).not.toContain(r.file_name);
    expect(await files()).toContain('notes.txt');
  });
});

describe('failures', () => {
  it('records the reason, removes partial files, alerts administrators and retries only after an hour', async () => {
    await reset();
    await t.db.query(`DELETE FROM notifications`);
    const bad = scheduler({ BACKUP_PASSPHRASE: '', BACKUP_PASSPHRASE_FILE: path.join(dir, 'does-not-exist') }, 'wbad');
    expect(await bad.cycle()).not.toBeNull();
    const [r] = await runs();
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/ENOENT|no such file/i);
    expect(r.file_name).toBeNull();
    expect((await files()).filter((f) => f.endsWith('.partial'))).toEqual([]);
    const note = (await t.db.query<any>(`SELECT title, body FROM notifications WHERE kind = 'backup_failed'`)).rows;
    expect(note.length).toBeGreaterThanOrEqual(1); // every administrator
    expect(JSON.stringify(note)).not.toContain(PASS);

    expect(await scheduler().cycle()).toBeNull(); // too soon after a failure
    await t.db.query(`UPDATE backup_runs SET requested_at = now() - interval '61 minutes'`);
    expect(await scheduler().cycle()).not.toBeNull();
    expect((await runs()).at(-1)!.status).toBe('succeeded');
  });

  it('reports stored files that were missing as a warning, not as a silent success', async () => {
    await reset();
    await t.db.query(`DELETE FROM notifications`);
    const f = (await t.db.query<any>(`SELECT id, storage_key FROM files LIMIT 1`)).rows[0];
    await t.storage.delete(f.storage_key);
    await scheduler().cycle();
    const [r] = await runs();
    expect(r).toMatchObject({ status: 'succeeded', missing_count: 1, verified: true });
    expect((await t.db.query<any>(`SELECT 1 FROM notifications WHERE kind = 'backup_warning'`)).rowCount).toBeGreaterThanOrEqual(1);
    // put it back for the other tests
    await t.storage.put(f.storage_key, (await import('node:stream')).Readable.from([Buffer.from('something worth backing up')]), { maxBytes: 1000 });
  });

  it('closes a run whose worker vanished, so it cannot block the schedule forever', async () => {
    await reset();
    await t.db.query(`INSERT INTO backup_runs (trigger, status, started_at, requested_at) VALUES ('schedule', 'running', now() - interval '13 hours', now() - interval '13 hours')`);
    await scheduler().cycle();
    const all = await runs();
    expect(all[0]).toMatchObject({ status: 'failed' });
    expect(all[0].error).toMatch(/Interrupted/);
    expect(all.at(-1)!.status).toBe('succeeded');
  });
});

describe('administrator controls', () => {
  it('lets an administrator request a backup, once at a time, and shows its history', async () => {
    await reset();
    const r = await call(admin, 'POST', '/admin/backups/run');
    expect(r.statusCode).toBe(202);
    expect((await call(admin, 'POST', '/admin/backups/run')).json().error.code).toBe('backup_in_progress');
    await scheduler({ BACKUP_INTERVAL_HOURS: 0 }).cycle();
    const list = (await call(admin, 'GET', '/admin/backups')).json();
    expect(list.config).toMatchObject({ enabled: true, intervalHours: 24, keep: 2, passphraseConfigured: true });
    expect(list.runs[0]).toMatchObject({ trigger: 'manual', status: 'succeeded', verified: true });
    expect(JSON.stringify(list)).not.toContain(PASS);
    expect((await t.db.query<any>(`SELECT 1 FROM audit_logs WHERE action = 'admin.backup_requested'`)).rowCount).toBeGreaterThanOrEqual(1);
  });

  it('is for administrators only', async () => {
    const u = await login(t, 'plain', 'plain@example.com');
    expect((await call(u, 'POST', '/admin/backups/run')).statusCode).toBe(403);
    expect((await call(u, 'GET', '/admin/backups')).statusCode).toBe(403);
  });

  it('explains when no passphrase is configured instead of queueing a request that cannot run', async () => {
    const env = await createTestEnv();
    try {
      const a = await login(env, 'x', 'admin@example.com');
      const r = await env.app.inject({ method: 'POST', url: '/api/v1/admin/backups/run', headers: authed(a) });
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('backup_not_configured');
    } finally { await env.close(); }
  });

  it('shows the last successful backup on the overview', async () => {
    const o = (await call(admin, 'GET', '/admin/overview')).json();
    expect(o.backup).toMatchObject({ enabled: true, passphraseConfigured: true, lastVerified: true });
    expect(o.backup.lastSuccessAt).toBeTruthy();
  });
});

describe('restoring', () => {
  it('does not bring back a backup run that was only "in progress" when the backup was made', async () => {
    await reset();
    await t.db.query(`INSERT INTO backup_runs (trigger, status, started_at) VALUES ('manual', 'running', now())`);
    const file = path.join(dir, 'with-running.csbk');
    await createBackup({ db: t.db, out: file, passphrase: PASS, includeObjects: false, adapterFor: () => undefined });
    const target = await createTestDb(); await migrate(target, MIGRATIONS);
    try {
      await restoreBackup({ db: target, file, passphrase: PASS, adapterFor: () => undefined });
      const r = (await target.query<any>(`SELECT status, error FROM backup_runs`)).rows[0];
      expect(r.status).toBe('failed');
      expect(r.error).toMatch(/Restored from a backup/);
    } finally { await target.close(); }
  });

  // CREATE DATABASE needs a real PostgreSQL server: run with `npm run test:pg`
  it.skipIf(!process.env.TEST_PG_ADMIN_URL)('restore drill proves a backup restores, never touches the live data, and cleans up', async () => {
    await reset();
    const file = path.join(dir, 'drill.csbk');
    await createBackup({ db: t.db, out: file, passphrase: PASS, includeObjects: true, adapterFor });
    const before = (await t.db.query<any>(`SELECT count(*)::int AS n FROM files`)).rows[0].n;
    const url = new URL(process.env.TEST_PG_ADMIN_URL!);
    const dbName = (await t.db.query<any>(`SELECT current_database() AS d`)).rows[0].d;
    url.pathname = `/${dbName}`;
    const r = await restoreDrill({ databaseUrl: url.toString(), migrationsDir: MIGRATIONS, file, passphrase: PASS });
    expect(r.ok).toBe(true);
    expect(r.rowMismatches).toEqual([]);
    expect(r.reconcile.missing).toEqual([]);
    expect((await t.db.query<any>(`SELECT count(*)::int AS n FROM files`)).rows[0].n).toBe(before); // live data untouched
    expect((await t.db.query<any>(`SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'cloudseed_drill_%'`)).rows[0].n).toBe(0);
    await expect(restoreDrill({ databaseUrl: url.toString(), migrationsDir: MIGRATIONS, file, passphrase: 'wrong passphrase!!' })).rejects.toThrow(/wrong passphrase/);
    expect((await t.db.query<any>(`SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'cloudseed_drill_%'`)).rows[0].n).toBe(0);
  });
});
