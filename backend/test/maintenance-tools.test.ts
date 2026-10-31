import { mkdtemp, utimes, writeFile, mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import S3rver from 's3rver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcile } from '../src/maintenance/reconcile.js';
import { migrateStorage } from '../src/storage/migrate.js';
import { LocalStorage } from '../src/storage/local.js';
import { S3Storage } from '../src/storage/s3.js';
import { authed, createTestEnv, login, multipartBody, type Session, type TestEnv } from './helpers.js';

const freePort = () => new Promise<number>((res) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
});
let server: { close(): Promise<void>; run(): Promise<unknown> };
let s3: S3Storage;
let t: TestEnv;
let seq = 0;

beforeAll(async () => {
  const port = await freePort();
  server = new S3rver({ port, address: '127.0.0.1', silent: true, directory: await mkdtemp(path.join(os.tmpdir(), 's3rver-')), configureBuckets: [{ name: 'test' }] });
  await server.run();
  s3 = new S3Storage({ endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1', bucket: 'test', accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER', forcePathStyle: true, keyPrefix: 'cs' }, { maxAttempts: 1 });
  // the app knows both backends, as a real deployment does while (and after) migrating
  const root = await mkdtemp(path.join(os.tmpdir(), 'cs-mt-'));
  const local = new LocalStorage(path.join(root, 'storage'), path.join(root, 'tmp'));
  t = await createTestEnv({ LOCAL_STORAGE_ROOT: path.join(root, 'storage'), LOCAL_TMP_DIR: path.join(root, 'tmp') }, { storage: local, storages: { local, s3 } });
});
afterAll(async () => { await t.close(); await server.close(); });

const adapterFor = (k: string) => (k === 'local' ? t.storage : k === 's3' ? s3 : undefined);
const user = (): Promise<Session> => { const n = ++seq; return login(t, `mt-${n}`, `mt-${n}@example.com`); };
async function upload(s: Session, name: string, content: Buffer | string): Promise<{ id: string; key: string }> {
  const m = multipartBody(name, content);
  const r = await t.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(s), ...m.headers }, payload: m.body });
  if (r.statusCode !== 201) throw new Error(r.body);
  const id = r.json().id as string;
  return { id, key: (await t.db.query<{ storage_key: string }>(`SELECT storage_key FROM files WHERE id = $1`, [id])).rows[0]!.storage_key };
}
const read = async (a: { get(k: string): Promise<AsyncIterable<unknown>> }, key: string) => { const c: Buffer[] = []; for await (const x of await a.get(key)) c.push(x as Buffer); return Buffer.concat(c); };
const old = async (abs: string) => { const d = new Date(Date.now() - 72 * 3_600_000); await utimes(abs, d, d); };

describe('reconcile', () => {
  it('reports missing objects, size mismatches, orphans and quota drift, and changes nothing by default', async () => {
    const s = await user();
    const ok = await upload(s, 'fine.txt', 'fine');
    const gone = await upload(s, 'gone.txt', 'will vanish');
    const short = await upload(s, 'short.txt', 'will be cut');
    await t.storage.delete(gone.key);
    await writeFile(t.storage.localPath(short.key), 'cut');
    await mkdir(path.dirname(t.storage.localPath('zz/orphan-one')), { recursive: true });
    await writeFile(t.storage.localPath('zz/orphan-one'), 'nobody owns me');
    await old(t.storage.localPath('zz/orphan-one'));
    await t.db.query(`UPDATE storage_quotas SET used_bytes = used_bytes + 999 WHERE user_id = $1`, [s.userId]);

    const r = await reconcile({ db: t.db, adapterFor, kinds: ['local'] });
    expect(r.missing.map((m) => m.id)).toEqual([gone.id]);
    expect(r.sizeMismatch).toEqual([expect.objectContaining({ id: short.id, recorded: 11, stored: 3 })]);
    expect(r.orphans.map((o) => o.key)).toContain('zz/orphan-one');
    expect(r.orphans.find((o) => o.key === 'zz/orphan-one')).toMatchObject({ deleted: false });
    expect(r.quotaDrift.find((d) => d.userId === s.userId)).toMatchObject({ recorded: expect.any(Number), fixed: false });
    expect(r.orphans.some((o) => o.key === ok.key)).toBe(false);
    expect(await t.storage.stat('zz/orphan-one')).not.toBeNull(); // untouched
  });

  it('spares recent objects (an upload may be mid-flight) and deletes old orphans only when asked', async () => {
    await mkdir(path.dirname(t.storage.localPath('yy/fresh')), { recursive: true });
    await writeFile(t.storage.localPath('yy/fresh'), 'just written');
    await writeFile(t.storage.localPath('yy/stale'), 'long forgotten');
    await old(t.storage.localPath('yy/stale'));
    const dry = await reconcile({ db: t.db, adapterFor, kinds: ['local'] });
    expect(dry.orphans.map((o) => o.key)).toContain('yy/stale');
    expect(dry.orphans.map((o) => o.key)).not.toContain('yy/fresh');

    const r = await reconcile({ db: t.db, adapterFor, kinds: ['local'], deleteOrphans: true });
    expect(r.orphans.find((o) => o.key === 'yy/stale')).toMatchObject({ deleted: true });
    expect(await t.storage.stat('yy/stale')).toBeNull();
    expect(await t.storage.stat('yy/fresh')).not.toBeNull();
    expect(await t.storage.stat('zz/orphan-one')).toBeNull();
  });

  it('corrects quota arithmetic only with the fix flag, counting trashed files and media', async () => {
    const s = await user();
    const f = await upload(s, 'count-me.txt', 'twelve bytes');
    await t.app.inject({ method: 'DELETE', url: `/api/v1/files/${f.id}`, headers: authed(s) }); // trash still counts
    await t.db.query(`UPDATE storage_quotas SET used_bytes = 5 WHERE user_id = $1`, [s.userId]);
    const check = await reconcile({ db: t.db, adapterFor, kinds: [] });
    expect(check.quotaDrift.find((d) => d.userId === s.userId)).toMatchObject({ recorded: 5, actual: 12, fixed: false });
    const fix = await reconcile({ db: t.db, adapterFor, kinds: [], fixQuotas: true });
    expect(fix.quotaDrift.find((d) => d.userId === s.userId)!.fixed).toBe(true);
    expect((await reconcile({ db: t.db, adapterFor, kinds: [] })).quotaDrift.filter((d) => d.userId === s.userId)).toEqual([]);
  });

  it('reports a clean system as clean', async () => {
    const env = await createTestEnv();
    try {
      const s = await login(env, 'clean', 'clean@example.com');
      const m = multipartBody('a.txt', 'abc');
      await env.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(s), ...m.headers }, payload: m.body });
      const r = await reconcile({ db: env.db, adapterFor: (k) => (k === 'local' ? env.storage : undefined) });
      expect(r).toMatchObject({ missing: [], sizeMismatch: [], orphans: [], quotaDrift: [], checked: { rows: 1, objects: 1 } });
    } finally { await env.close(); }
  });
});

describe('migrate-storage (local -> S3-compatible)', () => {
  // the reconcile tests above damaged these on purpose; a migration would (rightly) refuse to move them
  beforeAll(async () => { await t.db.query(`DELETE FROM files WHERE name IN ('gone.txt', 'short.txt')`); });

  it('copies, verifies, re-points rows, keeps originals by default, and downloads keep working', async () => {
    const s = await user();
    const big = Buffer.alloc(300_000, 42);
    const a = await upload(s, 'a.bin', big), b = await upload(s, 'b.txt', 'small one');

    const dry = await migrateStorage({ db: t.db, from: t.storage, to: s3, dryRun: true });
    expect(dry.moved).toBeGreaterThanOrEqual(2);
    expect(await s3.stat(a.key)).toBeNull(); // a dry run copies nothing
    expect((await t.db.query<{ k: string }>(`SELECT storage_provider_kind AS k FROM files WHERE id = $1`, [a.id])).rows[0]!.k).toBe('local');

    const r = await migrateStorage({ db: t.db, from: t.storage, to: s3 });
    expect(r.failed).toEqual([]);
    for (const f of [a, b]) {
      expect((await t.db.query<{ k: string }>(`SELECT storage_provider_kind AS k FROM files WHERE id = $1`, [f.id])).rows[0]!.k).toBe('s3');
      expect(await t.storage.stat(f.key)).not.toBeNull(); // original kept
    }
    expect((await read(s3, a.key)).equals(big)).toBe(true);
    // the app now serves them from S3 (adapterFor in the test app knows both)
    const dl = await t.app.inject({ method: 'GET', url: `/api/v1/files/${b.id}/content`, headers: { cookie: s.cookie } });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('small one');
    // a second run has nothing left to do
    const again = await migrateStorage({ db: t.db, from: t.storage, to: s3 });
    expect(again.moved).toBe(0);
  });

  it('deletes the originals only when told to, after each file is verified and switched', async () => {
    const s = await user();
    const f = await upload(s, 'delete-original.txt', 'move and remove');
    const r = await migrateStorage({ db: t.db, from: t.storage, to: s3, deleteOriginals: true });
    expect(r.originalsDeleted).toBeGreaterThanOrEqual(1);
    expect(await t.storage.stat(f.key)).toBeNull();
    expect((await read(s3, f.key)).toString()).toBe('move and remove');
  });

  it('resumes after an interruption and never switches a row whose copy failed', async () => {
    const s = await user();
    const x = await upload(s, 'x.txt', 'first'), y = await upload(s, 'y.txt', 'second'), z = await upload(s, 'z.txt', 'third');
    // simulate an earlier run that copied x but died before switching its row
    await s3.put(x.key, (await t.storage.get(x.key)) as never, { maxBytes: 1000 });
    // y's source object is damaged: the copy cannot match the recorded checksum
    await writeFile(t.storage.localPath(y.key), 'SECOND');
    const flaky = new Proxy(s3, { get(o, p, r) { const v = Reflect.get(o, p, r); return typeof v === 'function' ? v.bind(o) : v; } });
    const r = await migrateStorage({ db: t.db, from: t.storage, to: flaky });
    const kind = async (id: string) => (await t.db.query<{ k: string }>(`SELECT storage_provider_kind AS k FROM files WHERE id = $1`, [id])).rows[0]!.k;
    expect(await kind(x.id)).toBe('s3');
    expect(await kind(z.id)).toBe('s3');
    expect(r.alreadyThere).toBeGreaterThanOrEqual(1);
    expect(r.failed).toEqual([expect.objectContaining({ id: y.id, reason: expect.stringContaining('SHA-256') })]);
    expect(await kind(y.id)).toBe('local'); // still served from the old place
    expect(await s3.stat(y.key)).toBeNull(); // the bad copy was removed
  });

  it('does not resurrect a file the user deleted while it was being moved', async () => {
    const s = await user();
    const f = await upload(s, 'race.txt', 'deleted during migration');
    const racing = new Proxy(s3, {
      get(o, p, r) {
        if (p === 'put') return async (...args: Parameters<S3Storage['put']>) => {
          const res = await o.put(...args);
          await t.db.query(`DELETE FROM files WHERE id = $1`, [f.id]); // purged right after the copy
          return res;
        };
        const v = Reflect.get(o, p, r); return typeof v === 'function' ? v.bind(o) : v;
      },
    });
    const r = await migrateStorage({ db: t.db, from: t.storage, to: racing });
    expect(r.skippedGone).toBe(1);
    expect(await s3.stat(f.key)).toBeNull(); // the copy was cleaned up
  });

  it('refuses to "move" between two backends of the same kind', async () => {
    await expect(migrateStorage({ db: t.db, from: t.storage, to: t.storage })).rejects.toThrow(/same kind/);
  });

  it('reconcile understands S3 too (listing under the configured prefix)', async () => {
    const r = await reconcile({ db: t.db, adapterFor, kinds: ['s3'] });
    expect(r.missing).toEqual([]);
    expect(r.checked.objects).toBeGreaterThan(0);
  });
});
