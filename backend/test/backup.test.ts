import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackup, restoreBackup, verifyBackup } from '../src/backup/backup.js';
import { SEEDED_TABLES, describeSchema } from '../src/backup/schema.js';
import { migrate } from '../src/db/migrate.js';
import type { Db } from '../src/db/index.js';
import { LocalStorage } from '../src/storage/local.js';
import { authed, createTestDb, createTestEnv, login, MIGRATIONS, multipartBody, type Session, type TestEnv } from './helpers.js';

const PASS = 'correct horse battery staple';
let t: TestEnv;
let dir: string;
let a: Session, b: Session;
const files: Record<string, string> = {};

const call = (s: Session, method: string, url: string, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: authed(s), payload: payload as object });
async function upload(s: Session, name: string, content: Buffer | string, folderId?: string): Promise<string> {
  const m = multipartBody(name, content);
  const r = await t.app.inject({ method: 'POST', url: `/api/v1/files/upload${folderId ? `?folderId=${folderId}` : ''}`, headers: { ...authed(s), ...m.headers }, payload: m.body });
  if (r.statusCode !== 201) throw new Error(r.body);
  return r.json().id;
}

async function emptyTarget(): Promise<{ db: Db; storage: LocalStorage; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cs-restore-'));
  const db = await createTestDb();
  await migrate(db, MIGRATIONS);
  return { db, storage: new LocalStorage(path.join(root, 'storage'), path.join(root, 'tmp')), root };
}
const adapterOf = (s: LocalStorage) => (k: string) => (k === 'local' ? s : undefined);

/** A fingerprint of every table, independent of row order. */
async function fingerprint(db: Db): Promise<Record<string, string>> {
  const schema = await describeSchema(db);
  const out: Record<string, string> = {};
  for (const tb of schema.tables) {
    out[tb.name] = (await db.query<{ h: string | null }>(`SELECT md5(string_agg(to_json(x)::text, ',' ORDER BY to_json(x)::text)) AS h FROM "${tb.name}" x`)).rows[0]!.h ?? 'empty';
  }
  return out;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'cs-backup-'));
  t = await createTestEnv({ MAX_FILE_SIZE_BYTES: String(8 * 1024 * 1024), DEFAULT_USER_QUOTA_BYTES: String(64 * 1024 * 1024) });
  a = await login(t, 'bk-a', 'bk-a@example.com');
  b = await login(t, 'bk-b', 'bk-b@example.com');
  const top = (await call(a, 'POST', '/folders', { name: 'Projects', parentId: null })).json().id;
  const sub = (await call(a, 'POST', '/folders', { name: 'Deep', parentId: top })).json().id;
  const sub2 = (await call(a, 'POST', '/folders', { name: 'Deeper', parentId: sub })).json().id;
  files.big = await upload(a, 'big.bin', randomBytes(3 * 1024 * 1024 + 123)); // incompressible, so the archive spans several 1 MiB frames
  files.deep = await upload(a, 'deep.txt', 'in the deepest folder', sub2);
  files.trashed = await upload(a, 'trashed.txt', 'in the trash');
  await call(a, 'DELETE', `/files/${files.trashed}`);
  files.b = await upload(b, 'b-file.txt', 'belongs to b');
  await call(a, 'POST', '/shares', { fileId: files.deep, expiresInHours: 24, acknowledgePublic: true, password: 'a-long-password' });
  await t.db.query(`INSERT INTO user_settings (user_id, email_notifications, muted_kinds) VALUES ($1, false, ARRAY['download_started','quota_warning'])`, [a.userId]);
  await t.db.query(`INSERT INTO notifications (user_id, kind, title, body) VALUES ($1, 'download_failed', 'ünïcödé 🚀 title', 'line1\nline2 "quoted" \\ backslash')`, [a.userId]);
  await t.db.query(`INSERT INTO worker_heartbeats (id, role, started_at, info) VALUES ('w1', 'worker', now(), '{"nested":{"a":[1,2,3]},"n":null}')`);
});
afterAll(async () => { await t.close(); await rm(dir, { recursive: true, force: true }); });

describe('backup, verify and restore', () => {
  it('round-trips the whole database and every stored object into a fresh install', async () => {
    const out = path.join(dir, 'full.csbk');
    const s = await createBackup({ db: t.db, out, passphrase: PASS, includeObjects: true, adapterFor: (k) => (k === 'local' ? t.storage : undefined) });
    expect(s.missing).toEqual([]); expect(s.corrupt).toEqual([]);
    expect(s.objects.included).toBe(4); // big, deep, trashed, b
    expect(s.rows.folders).toBe(3);
    expect((await stat(out)).size).toBe(s.bytes);
    expect(await stat(`${out}.partial`).catch(() => null)).toBeNull();

    const v = await verifyBackup(out, PASS);
    expect(v.totalRows).toBeGreaterThan(20);
    expect(v.objects.count).toBe(4);

    const target = await emptyTarget();
    try {
      const r = await restoreBackup({ db: target.db, file: out, passphrase: PASS, adapterFor: adapterOf(target.storage) });
      expect(r.objects.count).toBe(4);
      expect(r.sequencesReset).toBeGreaterThan(0);
      expect(await fingerprint(target.db)).toEqual(await fingerprint(t.db));

      // every object is byte-identical
      const rows = (await t.db.query<{ storage_key: string }>(`SELECT storage_key FROM files`)).rows;
      for (const row of rows) {
        const read = async (s: LocalStorage) => { const c: Buffer[] = []; for await (const x of await s.get(row.storage_key)) c.push(x as Buffer); return Buffer.concat(c); };
        expect((await read(target.storage)).equals(await read(t.storage))).toBe(true);
      }
      // sequences continue after the highest restored id instead of colliding
      await expect(target.db.query(`INSERT INTO audit_logs (action) VALUES ('after.restore')`)).resolves.toBeDefined();
      // the restored app works: sessions, shares, files
      expect(await target.db.query(`SELECT 1 FROM sessions WHERE user_id = $1`, [a.userId])).toMatchObject({ rowCount: 1 });
    } finally { await target.db.close(); await rm(target.root, { recursive: true, force: true }); }
  });

  it('can back up the database alone, and says so', async () => {
    const out = path.join(dir, 'db-only.csbk');
    const s = await createBackup({ db: t.db, out, passphrase: PASS, includeObjects: false, adapterFor: () => undefined });
    expect(s.objects.included).toBe(0);
    const v = await verifyBackup(out, PASS);
    expect(v.includeObjects).toBe(false);
    const target = await emptyTarget();
    try {
      await restoreBackup({ db: target.db, file: out, passphrase: PASS, adapterFor: () => undefined });
      expect(await fingerprint(target.db)).toEqual(await fingerprint(t.db));
    } finally { await target.db.close(); await rm(target.root, { recursive: true, force: true }); }
  });

  it('encrypts: neither the passphrase nor any content appears in the file', async () => {
    const raw = await readFile(path.join(dir, 'full.csbk'));
    expect(raw.subarray(0, 4).toString()).toBe('CSBK');
    for (const needle of ['bk-a@example.com', 'in the deepest folder', 'Projects', 'cloudseed-backup-v1', 'schema_migrations', 'audit_logs', PASS]) expect(raw.includes(Buffer.from(needle)), needle).toBe(false);
    const a1 = await createBackup({ db: t.db, out: path.join(dir, 'x1.csbk'), passphrase: PASS, includeObjects: false, adapterFor: () => undefined });
    const a2 = await createBackup({ db: t.db, out: path.join(dir, 'x2.csbk'), passphrase: PASS, includeObjects: false, adapterFor: () => undefined });
    expect((await readFile(a1.file)).equals(await readFile(a2.file))).toBe(false); // fresh salt every time
  });

  it('rejects a wrong or too-short passphrase', async () => {
    await expect(verifyBackup(path.join(dir, 'full.csbk'), 'definitely the wrong one')).rejects.toThrow(/wrong passphrase/);
    await expect(verifyBackup(path.join(dir, 'full.csbk'), 'short')).rejects.toThrow(/at least|shorter than 12/);
    await expect(createBackup({ db: t.db, out: path.join(dir, 'no.csbk'), passphrase: '', includeObjects: false, adapterFor: () => undefined })).rejects.toThrow(/passphrase/);
    expect(await stat(path.join(dir, 'no.csbk')).catch(() => null)).toBeNull();
  });

  it('detects tampering, truncation and trailing data anywhere in the file', async () => {
    const good = await readFile(path.join(dir, 'full.csbk'));
    const check = async (name: string, mutate: (b: Buffer) => Buffer, re: RegExp) => {
      const f = path.join(dir, `bad-${name}.csbk`);
      await writeFile(f, mutate(Buffer.from(good)));
      await expect(verifyBackup(f, PASS), name).rejects.toThrow(re);
    };
    await check('flip-middle', (b) => { b[Math.floor(b.length / 2)]! ^= 1; return b; }, /corrupted|modified|checksum|wrong passphrase/);
    await check('flip-tail', (b) => { b[b.length - 20]! ^= 1; return b; }, /corrupted|modified|truncated/);
    await check('truncate', (b) => b.subarray(0, b.length - 100), /truncated|corrupted/);
    await check('truncate-half', (b) => b.subarray(0, Math.floor(b.length / 2)), /truncated|corrupted/);
    await check('append', (b) => Buffer.concat([b, Buffer.from('extra bytes')]), /corrupted|truncated|modified/);
    await check('magic', (b) => { b[0] = 0x58; return b; }, /not a CloudSeed backup/);
    await check('empty', () => Buffer.alloc(0), /empty|truncated/);
    // dropping a whole frame from the middle (frames are length-prefixed, so cut one cleanly)
    await check('drop-frame', (b) => { const off = 22; const len = b.readUInt32BE(off); return Buffer.concat([b.subarray(0, off), b.subarray(off + 4 + len)]); }, /corrupted|modified|wrong passphrase/);
  });
});

describe('restore safety', () => {
  it('refuses a target that already has data and leaves it untouched', async () => {
    const target = await emptyTarget();
    try {
      await target.db.query(`INSERT INTO users (email) VALUES ('existing@example.com')`);
      await expect(restoreBackup({ db: target.db, file: path.join(dir, 'db-only.csbk'), passphrase: PASS, adapterFor: () => undefined })).rejects.toThrow(/not empty/);
      expect((await target.db.query(`SELECT 1 FROM users`)).rowCount).toBe(1);
    } finally { await target.db.close(); await rm(target.root, { recursive: true, force: true }); }
  });

  it('refuses a database at a different schema version', async () => {
    const target = await emptyTarget();
    try {
      await target.db.query(`DELETE FROM schema_migrations WHERE name = (SELECT max(name) FROM schema_migrations)`);
      await expect(restoreBackup({ db: target.db, file: path.join(dir, 'db-only.csbk'), passphrase: PASS, adapterFor: () => undefined })).rejects.toThrow(/Schema version mismatch/);
      expect((await target.db.query(`SELECT 1 FROM users`)).rowCount).toBe(0);
    } finally { await target.db.close(); await rm(target.root, { recursive: true, force: true }); }
  });

  it('rolls everything back, objects included, when restoring fails part-way', async () => {
    const target = await emptyTarget();
    try {
      let puts = 0;
      const flaky = new Proxy(target.storage, {
        get(obj, prop, recv) {
          if (prop === 'put') return async (...args: Parameters<LocalStorage['put']>) => { if (++puts === 3) { args[1].resume(); throw new Error('disk full'); } return obj.put(...args); };
          const v = Reflect.get(obj, prop, recv); return typeof v === 'function' ? v.bind(obj) : v;
        },
      });
      await expect(restoreBackup({ db: target.db, file: path.join(dir, 'full.csbk'), passphrase: PASS, adapterFor: (k) => (k === 'local' ? flaky : undefined) })).rejects.toThrow(/disk full/);
      expect((await target.db.query(`SELECT 1 FROM users`)).rowCount).toBe(0);
      expect((await target.db.query(`SELECT 1 FROM files`)).rowCount).toBe(0);
      const left: string[] = []; for await (const o of target.storage.list()) left.push(o.key);
      expect(left).toEqual([]); // no orphaned objects
      // and a retry on the same target works
      await restoreBackup({ db: target.db, file: path.join(dir, 'full.csbk'), passphrase: PASS, adapterFor: adapterOf(target.storage) });
      expect((await target.db.query(`SELECT 1 FROM files`)).rowCount).toBe(4);
    } finally { await target.db.close(); await rm(target.root, { recursive: true, force: true }); }
  });

  it('fails clearly when the needed storage backend is not configured', async () => {
    const target = await emptyTarget();
    try {
      await expect(restoreBackup({ db: target.db, file: path.join(dir, 'full.csbk'), passphrase: PASS, adapterFor: () => undefined })).rejects.toThrow(/"local" storage backend, which is not configured/);
      expect((await target.db.query(`SELECT 1 FROM users`)).rowCount).toBe(0);
    } finally { await target.db.close(); await rm(target.root, { recursive: true, force: true }); }
  });
});

describe('honest reporting', () => {
  it('lists objects that are missing from storage instead of pretending they were saved', async () => {
    const env = await createTestEnv();
    try {
      const s = await login(env, 'miss', 'miss@example.com');
      const m1 = multipartBody('keep.txt', 'keep'), m2 = multipartBody('lost.txt', 'lost');
      for (const m of [m1, m2]) await env.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(s), ...m.headers }, payload: m.body });
      const lost = (await env.db.query<{ storage_key: string }>(`SELECT storage_key FROM files WHERE name = 'lost.txt'`)).rows[0]!.storage_key;
      await env.storage.delete(lost);
      const sum = await createBackup({ db: env.db, out: path.join(dir, 'missing.csbk'), passphrase: PASS, includeObjects: true, adapterFor: (k) => (k === 'local' ? env.storage : undefined) });
      expect(sum.objects.included).toBe(1);
      expect(sum.missing).toEqual([{ key: lost, kind: 'local', what: 'file' }]);
      expect((await verifyBackup(sum.file, PASS)).missing).toHaveLength(1); // recorded in the archive itself
    } finally { await env.close(); }
  });

  it('flags an object whose content no longer matches its recorded SHA-256', async () => {
    const env = await createTestEnv();
    try {
      const s = await login(env, 'rot', 'rot@example.com');
      const m = multipartBody('rot.txt', 'original');
      await env.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(s), ...m.headers }, payload: m.body });
      const key = (await env.db.query<{ storage_key: string }>(`SELECT storage_key FROM files`)).rows[0]!.storage_key;
      await writeFile(env.storage.localPath(key), 'ORIGINAL'); // same size, different bytes: silent corruption
      const sum = await createBackup({ db: env.db, out: path.join(dir, 'rot.csbk'), passphrase: PASS, includeObjects: true, adapterFor: (k) => (k === 'local' ? env.storage : undefined) });
      expect(sum.corrupt).toEqual([{ key, kind: 'local', reason: expect.stringContaining('SHA-256') }]);
    } finally { await env.close(); }
  });
});

describe('snapshot consistency', () => {
  // PGlite has a single connection, so a second writer cannot run while the backup's transaction is open; this needs real PostgreSQL (npm run test:pg).
  it.skipIf(!process.env.TEST_PG_ADMIN_URL)('captures one moment in time even while data changes during the backup', async () => {
    const env = await createTestEnv();
    try {
      const s = await login(env, 'snap', 'snap@example.com');
      const before = (await env.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs`)).rows[0]!.n;
      let injected = false;
      // a storage adapter that, on the first object read, changes the database from "another connection"
      const m = multipartBody('x.txt', 'x');
      await env.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(s), ...m.headers }, payload: m.body });
      const hooked = new Proxy(env.storage, {
        get(obj, prop, recv) {
          if (prop === 'get') return async (...args: Parameters<LocalStorage['get']>) => {
            if (!injected) { injected = true; await env.db.query(`INSERT INTO audit_logs (action) VALUES ('during.backup')`); await env.db.query(`DELETE FROM notifications`); }
            return obj.get(...args);
          };
          const v = Reflect.get(obj, prop, recv); return typeof v === 'function' ? v.bind(obj) : v;
        },
      });
      const out = path.join(dir, 'snap.csbk');
      const sum = await createBackup({ db: env.db, out, passphrase: PASS, includeObjects: true, adapterFor: (k) => (k === 'local' ? hooked : undefined) });
      expect(injected).toBe(true);
      const now = (await env.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs`)).rows[0]!.n;
      expect(now).toBe(before + 1 + 0); // the live database did get the new row...
      expect(sum.rows.audit_logs).toBe(before); // ...but the backup holds the state from when it started
    } finally { await env.close(); }
  });
});

describe('schema introspection', () => {
  it('lists exactly the tables the migrations seed, so restore knows which to replace', async () => {
    const fresh = await emptyTarget();
    try {
      const sc = await describeSchema(fresh.db);
      const seeded: string[] = [];
      for (const tb of sc.tables) if ((await fresh.db.query(`SELECT 1 FROM "${tb.name}" LIMIT 1`)).rowCount) seeded.push(tb.name);
      expect(seeded.sort()).toEqual([...SEEDED_TABLES].sort());
    } finally { await fresh.db.close(); await rm(fresh.root, { recursive: true, force: true }); }
  });

  it('orders tables so parents come first, with no cycles, and finds the sequences', async () => {
    const sc = await describeSchema(t.db);
    const idx = (n: string) => sc.tables.findIndex((x) => x.name === n);
    expect(idx('users')).toBeLessThan(idx('files'));
    expect(idx('files')).toBeLessThan(idx('shared_links'));
    expect(idx('shared_links')).toBeLessThan(idx('telegram_transfer_files'));
    expect(sc.tables.find((x) => x.name === 'folders')!.selfRef).toBe('parent_id');
    expect(sc.serials.map((s) => `${s.table}.${s.column}`)).toContain('audit_logs.id');
    expect(sc.tables.every((x) => x.name !== 'schema_migrations')).toBe(true);
  });
});
