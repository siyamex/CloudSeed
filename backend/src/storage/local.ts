import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StorageLimitError, type ListedObject, type PutResult, type StorageAdapter } from './types.js';

const KEY_RE = /^[a-z0-9][a-z0-9/_-]{0,199}$/;

export class LocalStorage implements StorageAdapter {
  readonly kind = 'local' as const;
  private readonly root: string;
  private readonly tmp: string;

  constructor(root: string, tmp: string) {
    this.root = path.resolve(root);
    this.tmp = path.resolve(tmp);
  }

  /** Maps a storage key to an absolute path, refusing anything that could escape the root. */
  resolve(key: string): string {
    if (!KEY_RE.test(key) || key.includes('..') || key.includes('//') || key.endsWith('/')) {
      throw new Error('invalid storage key');
    }
    const p = path.resolve(this.root, key);
    if (!p.startsWith(this.root + path.sep)) throw new Error('invalid storage key');
    return p;
  }

  async put(key: string, body: Readable, opts: { maxBytes: number }): Promise<PutResult> {
    const dest = this.resolve(key);
    await mkdir(this.tmp, { recursive: true });
    await mkdir(path.dirname(dest), { recursive: true });
    const tmpPath = path.join(this.tmp, `${randomUUID()}.part`);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > opts.maxBytes) return cb(new StorageLimitError(opts.maxBytes));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(tmpPath, { flags: 'wx' }));
      await rename(tmpPath, dest); // atomic within one filesystem
    } catch (e) {
      await rm(tmpPath, { force: true });
      throw e;
    }
    return { size, sha256: hash.digest('hex') };
  }

  localPath(key: string): string { return this.resolve(key); }

  async get(key: string, range?: { start: number; end: number }): Promise<Readable> {
    return createReadStream(this.resolve(key), range);
  }

  async stat(key: string) {
    try {
      const s = await stat(this.resolve(key));
      return s.isFile() ? { size: s.size } : null;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try { await unlink(this.resolve(key)); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }

  async *list(): AsyncGenerator<ListedObject> {
    const walk = async function* (self: LocalStorage, dir: string, rel: string): AsyncGenerator<ListedObject> {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw e;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (abs === self.tmp) continue; // in-flight uploads live here when the temp dir is inside the root
        const key = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) yield* walk(self, abs, key);
        else if (e.isFile() && KEY_RE.test(key)) {
          const s = await stat(abs);
          yield { key, size: s.size, modifiedAt: s.mtime };
        }
      }
    };
    yield* walk(this, this.root, '');
  }

  async health() {
    try {
      await mkdir(this.root, { recursive: true });
      const s = await statfs(this.root);
      return { ok: true, detail: `${Number(s.bavail) * Number(s.bsize)} bytes free on volume` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
