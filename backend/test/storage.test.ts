import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { contentDisposition, numberedName, parseRange, sanitizeName, validateName } from '../src/files/util.js';
import { LocalStorage } from '../src/storage/local.js';
import { StorageLimitError } from '../src/storage/types.js';
import { MIGRATIONS, createTestDb } from './helpers.js';

async function store() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cs-store-'));
  return { dir, s: new LocalStorage(path.join(dir, 'root'), path.join(dir, 'tmp')) };
}

describe('LocalStorage', () => {
  it('writes atomically, returns size and sha256, and reads back', async () => {
    const { s } = await store();
    const r = await s.put('ab/cd/file1', Readable.from([Buffer.from('hello '), Buffer.from('world')]), { maxBytes: 100 });
    expect(r.size).toBe(11);
    expect(r.sha256).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    const chunks: Buffer[] = [];
    for await (const c of await s.get('ab/cd/file1')) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello world');
  });

  it('aborts past the size limit and leaves neither the object nor temp files', async () => {
    const { s, dir } = await store();
    await expect(s.put('ab/cd/big', Readable.from([Buffer.alloc(60), Buffer.alloc(60)]), { maxBytes: 100 })).rejects.toBeInstanceOf(StorageLimitError);
    expect(await s.stat('ab/cd/big')).toBeNull();
    expect(await readdir(path.join(dir, 'tmp'))).toEqual([]);
  });

  it('cleans up the temp file when the source stream fails midway', async () => {
    const { s, dir } = await store();
    const bad = new Readable({ read() { this.push(Buffer.from('partial')); this.destroy(new Error('connection reset')); } });
    await expect(s.put('ab/cd/broken', bad, { maxBytes: 100 })).rejects.toThrow();
    expect(await s.stat('ab/cd/broken')).toBeNull();
    expect(await readdir(path.join(dir, 'tmp'))).toEqual([]);
  });

  it('serves a byte range', async () => {
    const { s } = await store();
    await s.put('ab/cd/r', Readable.from([Buffer.from('0123456789')]), { maxBytes: 100 });
    const chunks: Buffer[] = [];
    for await (const c of await s.get('ab/cd/r', { start: 3, end: 6 })) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('3456');
  });

  it('delete is idempotent', async () => {
    const { s } = await store();
    await s.put('ab/cd/d', Readable.from([Buffer.from('x')]), { maxBytes: 10 });
    await s.delete('ab/cd/d');
    await s.delete('ab/cd/d');
    expect(await s.stat('ab/cd/d')).toBeNull();
  });

  it.each(['../escape', 'a/../../escape', '/etc/passwd', 'a//b', 'A/B', 'a/b/', '', '..', 'a\\b', 'a/./b'.replace('.', '..')])(
    'refuses unsafe key %j', async (key) => {
      const { s } = await store();
      await expect(s.put(key, Readable.from([Buffer.from('x')]), { maxBytes: 10 })).rejects.toThrow('invalid storage key');
      await expect(s.get(key)).rejects.toThrow('invalid storage key');
      await expect(s.delete(key)).rejects.toThrow('invalid storage key');
    });

  it('never writes outside its root', async () => {
    const { s, dir } = await store();
    await s.put('ab/cd/ok', Readable.from([Buffer.from('x')]), { maxBytes: 10 });
    const root = await readdir(dir);
    expect(root.sort()).toEqual(['root', 'tmp']);
    expect(await readFile(path.join(dir, 'root/ab/cd/ok'), 'utf8')).toBe('x');
  });

  it('reports health with free space', async () => {
    const { s } = await store();
    expect((await s.health()).ok).toBe(true);
  });
});

describe('file utilities', () => {
  it('sanitizeName strips directories and control characters', () => {
    expect(sanitizeName('../../a/b.txt')).toBe('b.txt');
    expect(sanitizeName('C:\\Users\\x\\doc.pdf')).toBe('doc.pdf');
    expect(sanitizeName('na\u0000me\n.txt')).toBe('name.txt');
    expect(() => sanitizeName('..')).toThrow();
    expect(() => sanitizeName('   ')).toThrow();
    expect(Buffer.byteLength(sanitizeName('é'.repeat(300) + '.mp4'))).toBeLessThanOrEqual(255);
  });
  it('validateName rejects separators', () => {
    expect(validateName(' ok name ')).toBe('ok name');
    expect(() => validateName('a/b')).toThrow();
    expect(() => validateName('a\\b')).toThrow();
  });
  it('numberedName keeps the extension', () => {
    expect(numberedName('r.tar.gz', 2)).toBe('r.tar (2).gz');
    expect(numberedName('noext', 1)).toBe('noext (1)');
  });
  it('parseRange handles the byte-range forms', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('bytes=0-4', 10)).toEqual({ start: 0, end: 4 });
    expect(parseRange('bytes=5-', 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange('bytes=-4', 10)).toEqual({ start: 6, end: 9 });
    expect(parseRange('bytes=5-999', 10)).toEqual({ start: 5, end: 9 });
    for (const bad of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'items=0-1', 'bytes=0-1,3-4']) expect(parseRange(bad, 10), bad).toBe('invalid');
  });
  it('contentDisposition is header-safe', () => {
    const h = contentDisposition('a"b\r\nX: y é.txt');
    expect(h).not.toMatch(/[\r\n]/);
    expect(h).toContain("filename*=UTF-8''");
  });
});

describe('migrations', () => {
  it('apply cleanly, are idempotent, and detect tampering', async () => {
    const db = await createTestDb({ empty: true });
    const first = await migrate(db, MIGRATIONS);
    expect(first.length).toBeGreaterThan(0);
    expect(await migrate(db, MIGRATIONS)).toEqual([]);
    const t = await db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    for (const name of ['users', 'sessions', 'oauth_accounts', 'folders', 'files', 'storage_quotas', 'audit_logs', 'notifications', 'application_settings']) {
      expect(t.rows.map((r) => r.table_name)).toContain(name);
    }
    await db.query(`UPDATE schema_migrations SET checksum = 'tampered'`);
    await expect(migrate(db, MIGRATIONS)).rejects.toThrow(/modified after being applied/);
  });
});
