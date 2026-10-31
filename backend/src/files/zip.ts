import { crc32 } from 'node:zlib';
import type { Readable } from 'node:stream';

/**
 * A small streaming ZIP writer: entries are stored (not compressed), so memory use is constant and the archive can start
 * downloading immediately. Sizes are known in advance from the database; CRCs are computed while streaming and written in
 * data descriptors. Limits: classic ZIP only (no ZIP64), so at most 65,535 entries and 4 GiB in total. Callers enforce that.
 */
export const ZIP_MAX_ENTRIES = 65_535;
export const ZIP_MAX_BYTES = 0xffff_ffff - 1024 * 1024; // leaves room for headers

export interface ZipEntry {
  /** Path inside the archive, with "/" separators. */
  name: string;
  size: number;
  modified: Date;
  open(): Promise<Readable>;
}

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

function dos(d: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getUTCFullYear()));
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** Makes one path segment safe to extract: no separators, no traversal, no control characters. */
export const safeSegment = (s: string) => {
  const t = s.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').replace(/^\.+$/, '_').trim();
  return t.length ? t.slice(0, 200) : '_';
};

const FLAGS = 0x0808; // bit 3: sizes/CRC follow the data; bit 11: names are UTF-8

/** Yields the archive as Buffers. Throws if a stored object does not have the size the database promised. */
export async function* zipStream(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  if (entries.length > ZIP_MAX_ENTRIES) throw new Error('too many entries for a ZIP archive');
  let offset = 0;
  const central: Buffer[] = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const { time, date } = dos(e.modified);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(FLAGS), u16(0), u16(time), u16(date), u32(0), u32(0), u32(0), u16(name.length), u16(0), name]);
    const headerOffset = offset;
    yield local; offset += local.length;

    let crc = 0, size = 0;
    const src = await e.open();
    try {
      for await (const chunk of src) {
        const b = chunk as Buffer;
        crc = crc32(b, crc); size += b.length;
        if (size > e.size) throw new Error(`stored object for "${e.name}" is larger than recorded`);
        yield b; offset += b.length;
      }
    } finally { src.destroy(); }
    if (size !== e.size) throw new Error(`stored object for "${e.name}" is smaller than recorded`);

    const desc = Buffer.concat([u32(0x08074b50), u32(crc), u32(size), u32(size)]);
    yield desc; offset += desc.length;
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(FLAGS), u16(0), u16(time), u16(date), u32(crc), u32(size), u32(size),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(headerOffset), name,
    ]));
  }
  const cd = Buffer.concat(central);
  yield cd;
  yield Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(offset), u16(0)]);
}
