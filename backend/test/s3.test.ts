import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import S3rver from 's3rver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Storage } from '../src/storage/s3.js';
import { StorageLimitError } from '../src/storage/types.js';
import { authed, createTestEnv, login, multipartBody, type TestEnv } from './helpers.js';

const freePort = () => new Promise<number>((res) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
});

let server: { close(): Promise<void>; run(): Promise<unknown> };
let endpoint = '';
const adapter = (over: Partial<ConstructorParameters<typeof S3Storage>[0]> = {}) =>
  new S3Storage({ endpoint, region: 'us-east-1', bucket: 'test', accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER', forcePathStyle: true, ...over },
    { maxAttempts: 1 });

beforeAll(async () => {
  const port = await freePort();
  server = new S3rver({ port, address: '127.0.0.1', silent: true, directory: await mkdtemp(path.join(os.tmpdir(), 's3rver-')), configureBuckets: [{ name: 'test' }] });
  await server.run();
  endpoint = `http://127.0.0.1:${port}`;
});
afterAll(async () => { await server.close(); });

async function read(r: Readable) {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

describe('S3Storage (against an S3-compatible emulator over HTTP)', () => {
  it('round-trips a small object with size and sha256', async () => {
    const s = adapter();
    const r = await s.put('ab/cd/small', Readable.from([Buffer.from('hello '), Buffer.from('s3')]), { maxBytes: 100 });
    expect(r).toEqual({ size: 8, sha256: createHash('sha256').update('hello s3').digest('hex') });
    expect(await s.stat('ab/cd/small')).toEqual({ size: 8 });
    expect((await read(await s.get('ab/cd/small'))).toString()).toBe('hello s3');
  });

  it('streams a multipart upload (> part size) and preserves the bytes', async () => {
    const s = adapter();
    const data = randomBytes(12 * 1024 * 1024 + 123);
    const chunks = Array.from({ length: Math.ceil(data.length / 65536) }, (_, i) => data.subarray(i * 65536, (i + 1) * 65536));
    const r = await s.put('ab/cd/big', Readable.from(chunks), { maxBytes: 50 * 1024 * 1024 });
    expect(r.size).toBe(data.length);
    expect(r.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    expect((await s.stat('ab/cd/big'))?.size).toBe(data.length);
    expect(createHash('sha256').update(await read(await s.get('ab/cd/big'))).digest('hex')).toBe(r.sha256);
  }, 60_000);

  it('serves byte ranges', async () => {
    const s = adapter();
    await s.put('ab/cd/range', Readable.from([Buffer.from('0123456789')]), { maxBytes: 100 });
    expect((await read(await s.get('ab/cd/range', { start: 3, end: 6 }))).toString()).toBe('3456');
  });

  it('aborts past the size limit and leaves no object', async () => {
    const s = adapter();
    await expect(s.put('ab/cd/toobig', Readable.from([Buffer.alloc(60), Buffer.alloc(60)]), { maxBytes: 100 })).rejects.toBeInstanceOf(StorageLimitError);
    expect(await s.stat('ab/cd/toobig')).toBeNull();
  });

  it('leaves no object when the source stream fails midway', async () => {
    const s = adapter();
    const bad = new Readable({ read() { this.push(Buffer.from('partial')); this.destroy(new Error('connection reset')); } });
    await expect(s.put('ab/cd/broken', bad, { maxBytes: 100 })).rejects.toThrow();
    expect(await s.stat('ab/cd/broken')).toBeNull();
  });

  it('delete is idempotent and stat of a missing key is null', async () => {
    const s = adapter();
    await s.put('ab/cd/del', Readable.from([Buffer.from('x')]), { maxBytes: 10 });
    await s.delete('ab/cd/del');
    await s.delete('ab/cd/del');
    expect(await s.stat('ab/cd/del')).toBeNull();
  });

  it('applies the key prefix so adapters with different prefixes are isolated', async () => {
    const a = adapter({ keyPrefix: 'tenant-a' }), b = adapter({ keyPrefix: 'tenant-b' });
    await a.put('ab/cd/p', Readable.from([Buffer.from('a')]), { maxBytes: 10 });
    expect(await a.stat('ab/cd/p')).not.toBeNull();
    expect(await b.stat('ab/cd/p')).toBeNull();
  });

  it.each(['../escape', 'a//b', '/abs', 'A/B', 'a/b/', ''])('refuses unsafe key %j', async (key) => {
    const s = adapter();
    await expect(s.put(key, Readable.from([Buffer.from('x')]), { maxBytes: 10 })).rejects.toThrow('invalid storage key');
    await expect(s.get(key)).rejects.toThrow('invalid storage key');
    await expect(s.delete(key)).rejects.toThrow('invalid storage key');
  });

  // Note: s3rver does not verify request signatures, so bad-credential rejection cannot be tested against it.
  it('reports health, and reports failure with a status for a missing bucket', async () => {
    expect((await adapter().health()).ok).toBe(true);
    const bad = await adapter({ bucket: 'no-such-bucket' }).health();
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/HTTP 404|UnknownError|NoSuchBucket/);
  });
});

describe('API with S3 as the storage backend', () => {
  let t: TestEnv;
  beforeAll(async () => {
    const s3 = adapter({ keyPrefix: 'api' });
    t = await createTestEnv({}, { storage: s3 });
  });
  afterAll(async () => { await t.close(); });

  it('uploads to S3, serves bytes and ranges, enforces quota, and purges objects from S3', async () => {
    const u = await login(t, 's3-u', 's3u@example.com');
    const m = multipartBody('doc.txt', '0123456789');
    const up = await t.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(u), ...m.headers }, payload: m.body });
    expect(up.statusCode).toBe(201);
    const row = (await t.db.query<{ storage_provider_kind: string; storage_key: string }>('SELECT storage_provider_kind, storage_key FROM files WHERE id = $1', [up.json().id])).rows[0]!;
    expect(row.storage_provider_kind).toBe('s3');

    const dl = await t.app.inject({ method: 'GET', url: `/api/v1/files/${up.json().id}/content`, headers: { cookie: u.cookie, range: 'bytes=2-4' } });
    expect(dl.statusCode).toBe(206);
    expect(dl.body).toBe('234');

    const big = multipartBody('big.bin', Buffer.alloc(600 * 1024));
    const tooBig = await t.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(u), ...big.headers }, payload: big.body });
    expect(tooBig.statusCode).toBe(413);

    const direct = adapter({ keyPrefix: 'api' });
    expect(await direct.stat(row.storage_key)).not.toBeNull();
    await t.app.inject({ method: 'DELETE', url: `/api/v1/files/${up.json().id}`, headers: authed(u) });
    await t.app.inject({ method: 'POST', url: '/api/v1/trash/empty', headers: authed(u) });
    expect(await direct.stat(row.storage_key)).toBeNull();
  });

  it('keeps serving files stored on the local backend after switching to S3', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cs-mixed-'));
    const { LocalStorage } = await import('../src/storage/local.js');
    const local = new LocalStorage(path.join(dir, 'root'), path.join(dir, 'tmp'));
    const mixed = await createTestEnv({}, { storage: local });
    const u = await login(mixed, 'mx', 'mx@example.com');
    const m = multipartBody('old.txt', 'stored locally');
    const up = await mixed.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(u), ...m.headers }, payload: m.body });
    const id = up.json().id;
    await mixed.app.close();

    // Same database, new app whose write backend is S3 but which still knows the local adapter.
    const { buildApp } = await import('../src/app.js');
    const app2 = await buildApp({ config: mixed.config, db: mixed.db, storage: adapter({ keyPrefix: 'mixed' }), storages: { local }, oidc: mixed.idp.cfg });
    const dl = await app2.inject({ method: 'GET', url: `/api/v1/files/${id}/content`, headers: { cookie: u.cookie } });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('stored locally');

    // ...and fails clearly (not a crash) if the backend holding a file is not configured.
    const app3 = await buildApp({ config: mixed.config, db: mixed.db, storage: adapter({ keyPrefix: 'mixed' }), oidc: mixed.idp.cfg });
    const gone = await app3.inject({ method: 'GET', url: `/api/v1/files/${id}/content`, headers: { cookie: u.cookie } });
    expect(gone.statusCode).toBe(503);
    expect(gone.json().error.code).toBe('storage_unavailable');
    await app2.close(); await app3.close(); await mixed.idp.close(); await mixed.db.close();
  });
});
