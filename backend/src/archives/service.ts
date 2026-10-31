import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { StorageAdapter } from '../storage/types.js';
import { list7z, open7zEntry, sevenZipAvailable } from './sevenzip.js';
import { ArchiveError, type ArchiveEntry } from './types.js';
import { listZip, openZipEntry, type ZipEntryInfo } from './zip.js';

export type ArchiveKind = 'zip' | '7z' | 'rar';

export function archiveKind(name: string): ArchiveKind | null {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.zip' || ext === '.cbz') return 'zip';
  if (ext === '.7z') return '7z';
  if (ext === '.rar' || ext === '.cbr') return 'rar';
  return null;
}

export interface ArchiveOpts { sevenZipPath: string; maxEntries: number }

export interface OpenArchive {
  kind: ArchiveKind;
  entries: ArchiveEntry[];
  /** Streams the decompressed bytes of one file entry (never more than `maxBytes`). */
  open(entryPath: string, maxBytes: number): Promise<Readable>;
  close(): Promise<void>;
}

// Listings are cheap for ZIP but slow for big 7z/RAR, so keep recent ones for a few minutes (per process).
const cache = new Map<string, { at: number; entries: ArchiveEntry[]; zip?: Map<string, ZipEntryInfo> }>();
const TTL_MS = 5 * 60_000;

export async function openArchive(
  adapter: StorageAdapter, file: { id: string; name: string; key: string; size: number; sha256: string | null }, opts: ArchiveOpts,
): Promise<OpenArchive> {
  const kind = archiveKind(file.name);
  if (!kind) throw new ArchiveError('unsupported', 'This file type cannot be opened as an archive');
  const cacheKey = `${file.id}:${file.sha256 ?? file.size}`;
  const hit = cache.get(cacheKey);
  const fresh = hit && Date.now() - hit.at < TTL_MS ? hit : undefined;

  if (kind === 'zip') {
    let entries = fresh?.entries; let zip = fresh?.zip;
    if (!entries || !zip) {
      const infos = await listZip(adapter, file.key, file.size, opts.maxEntries);
      zip = new Map(infos.map((i) => [i.path, i])); entries = infos.map(({ method: _m, compressedSize: _c, localOffset: _l, ...e }) => e);
      remember(cacheKey, { at: Date.now(), entries, zip });
    }
    const z = zip;
    return {
      kind, entries,
      async open(p, maxBytes) {
        const info = z.get(p);
        if (!info || info.isDir) throw new ArchiveError('not_found', 'No such file in the archive');
        if (info.isLink) throw new ArchiveError('unsupported', 'Links inside archives are not opened');
        if (info.size > maxBytes) throw new ArchiveError('too_large', 'The entry is larger than allowed');
        return openZipEntry(adapter, file.key, info);
      },
      async close() { /* nothing held */ },
    };
  }

  // 7z / RAR need the 7-Zip program and a real file on disk.
  if (!(await sevenZipAvailable(opts.sevenZipPath))) {
    throw new ArchiveError('no_tool', `Opening ${kind === 'rar' ? 'RAR' : '7Z'} files needs 7-Zip on the server (the Docker image has it; otherwise install it or set SEVENZIP_PATH)`);
  }
  let local: string; let tmp: string | null = null;
  if (adapter.localPath) local = adapter.localPath(file.key);
  else {
    tmp = await mkdtemp(path.join(tmpdir(), 'cloudseed-arc-'));
    local = path.join(tmp, `a.${kind}`);
    try { await pipeline(await adapter.get(file.key), createWriteStream(local, { mode: 0o600 })); }
    catch (e) { await rm(tmp, { recursive: true, force: true }); throw e; }
  }
  const cleanup = async () => { if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined); };
  try {
    let entries = fresh?.entries;
    if (!entries) { entries = await list7z(opts.sevenZipPath, local, opts.maxEntries); remember(cacheKey, { at: Date.now(), entries }); }
    const byPath = new Map(entries.map((e) => [e.path, e]));
    return {
      kind, entries,
      async open(p, maxBytes) {
        const e = byPath.get(p);
        if (!e || e.isDir) throw new ArchiveError('not_found', 'No such file in the archive');
        if (e.isLink) throw new ArchiveError('unsupported', 'Links inside archives are not opened');
        if (e.encrypted) throw new ArchiveError('encrypted', 'This entry is password-protected');
        return open7zEntry(opts.sevenZipPath, local, p, maxBytes);
      },
      close: cleanup,
    };
  } catch (e) { await cleanup(); throw e; }
}

function remember(k: string, v: { at: number; entries: ArchiveEntry[]; zip?: Map<string, ZipEntryInfo> }) {
  if (cache.size >= 50) cache.delete(cache.keys().next().value as string);
  cache.set(k, v);
}
