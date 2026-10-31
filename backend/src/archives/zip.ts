import { createInflateRaw } from 'node:zlib';
import { Transform, type Readable } from 'node:stream';
import type { StorageAdapter } from '../storage/types.js';
import type { ArchiveEntry } from './types.js';
import { ArchiveError } from './types.js';

/**
 * Reads a ZIP's table of contents with a few ranged reads (the end of the file, then the central directory), so a
 * multi-gigabyte archive is listed without being downloaded or unpacked. Supports ZIP64, UTF-8 names, stored and
 * deflated entries. Anything else is listed but reported as not extractable.
 */

const EOCD_SIG = 0x06054b50, EOCD64_LOC_SIG = 0x07064b50, EOCD64_SIG = 0x06064b50, CEN_SIG = 0x02014b50, LOC_SIG = 0x04034b50;

async function readRange(a: StorageAdapter, key: string, start: number, end: number): Promise<Buffer> {
  if (end < start) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const c of await a.get(key, { start, end })) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export interface ZipEntryInfo extends ArchiveEntry { method: number; compressedSize: number; localOffset: number }

export async function listZip(a: StorageAdapter, key: string, size: number, maxEntries: number): Promise<ZipEntryInfo[]> {
  if (size < 22) throw new ArchiveError('not_an_archive', 'This is not a valid ZIP file');
  const tailLen = Math.min(size, 65_557 + 22);
  const tail = await readRange(a, key, size - tailLen, size - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  if (eocd < 0) throw new ArchiveError('not_an_archive', 'This is not a valid ZIP file (no central directory)');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locAt = eocd - 20;
    if (locAt < 0 || tail.readUInt32LE(locAt) !== EOCD64_LOC_SIG) throw new ArchiveError('not_an_archive', 'Unreadable ZIP64 directory');
    const off64 = Number(tail.readBigUInt64LE(locAt + 8));
    const rec = await readRange(a, key, off64, off64 + 55);
    if (rec.length < 56 || rec.readUInt32LE(0) !== EOCD64_SIG) throw new ArchiveError('not_an_archive', 'Unreadable ZIP64 directory');
    count = Number(rec.readBigUInt64LE(32)); cdSize = Number(rec.readBigUInt64LE(40)); cdOffset = Number(rec.readBigUInt64LE(48));
  }
  if (count > maxEntries) throw new ArchiveError('too_many_entries', `This archive has ${count} entries; the limit is ${maxEntries}`);
  if (cdSize > 64 * 1024 * 1024 || cdOffset + cdSize > size) throw new ArchiveError('not_an_archive', 'The ZIP directory is damaged');
  const cd = await readRange(a, key, cdOffset, cdOffset + cdSize - 1);
  const out: ZipEntryInfo[] = [];
  let p = 0;
  while (p + 46 <= cd.length && out.length < count) {
    if (cd.readUInt32LE(p) !== CEN_SIG) throw new ArchiveError('not_an_archive', 'The ZIP directory is damaged');
    const madeBy = cd.readUInt16LE(p + 4), flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
    const mod = cd.readUInt16LE(p + 12), day = cd.readUInt16LE(p + 14);
    let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
    const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
    const ext = cd.readUInt32LE(p + 38);
    let loff = cd.readUInt32LE(p + 42);
    if (p + 46 + nlen + xlen + clen > cd.length) throw new ArchiveError('not_an_archive', 'The ZIP directory is damaged');
    const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nlen);
    // ZIP64 extra field: the values that did not fit in 32 bits, in order
    for (let x = p + 46 + nlen, xe = x + xlen; x + 4 <= xe;) {
      const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
      if (id === 1) {
        let o = x + 4;
        if (usize === 0xffffffff && o + 8 <= xe) { usize = Number(cd.readBigUInt64LE(o)); o += 8; }
        if (csize === 0xffffffff && o + 8 <= xe) { csize = Number(cd.readBigUInt64LE(o)); o += 8; }
        if (loff === 0xffffffff && o + 8 <= xe) { loff = Number(cd.readBigUInt64LE(o)); }
      }
      x += 4 + len;
    }
    const unixMode = (madeBy >> 8) === 3 ? (ext >>> 16) : 0;
    const isDir = name.endsWith('/') || (ext & 0x10) !== 0;
    out.push({
      path: name, size: usize, isDir, encrypted: (flags & 1) !== 0, isLink: (unixMode & 0o170000) === 0o120000,
      modifiedAt: dosDate(day, mod), method, compressedSize: csize, localOffset: loff,
    });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

function dosDate(date: number, time: number): string | null {
  const y = 1980 + (date >> 9), mo = ((date >> 5) & 15), d = date & 31;
  if (!mo || !d) return null;
  return new Date(Date.UTC(y, mo - 1, d, time >> 11, (time >> 5) & 63, (time & 31) * 2)).toISOString();
}

/** Streams one entry's bytes. Never produces more than the size the directory declared, so a lying entry cannot flood us. */
export async function openZipEntry(a: StorageAdapter, key: string, e: ZipEntryInfo): Promise<Readable> {
  if (e.encrypted) throw new ArchiveError('encrypted', 'This entry is password-protected');
  if (e.method !== 0 && e.method !== 8) throw new ArchiveError('unsupported', 'This entry uses a compression method that is not supported');
  const head = await readRange(a, key, e.localOffset, e.localOffset + 29);
  if (head.length < 30 || head.readUInt32LE(0) !== LOC_SIG) throw new ArchiveError('not_an_archive', 'The ZIP entry is damaged');
  const start = e.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  if (e.compressedSize === 0) return emptyStream();
  const raw = await a.get(key, { start, end: start + e.compressedSize - 1 });
  const capped = capBytes(e.size);
  if (e.method === 0) return raw.pipe(capped);
  const inflate = createInflateRaw();
  raw.on('error', (err) => inflate.destroy(err));
  return raw.pipe(inflate).pipe(capped);
}

function emptyStream(): Readable {
  const t = new Transform({ transform(_c, _e, cb) { cb(); } });
  t.end();
  return t;
}

export function capBytes(limit: number): Transform {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > limit) return cb(new ArchiveError('too_large', 'The entry is larger than the archive says it is'));
      cb(null, chunk);
    },
  });
}
