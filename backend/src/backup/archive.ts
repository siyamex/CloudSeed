import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { PassThrough, Transform, pipeline as pipelineCb, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

/**
 * Backup archive format "CSBK" v1.
 *
 *   file    = header, then frames until the end
 *   header  = "CSBK" | version (1 byte) | scrypt log2(N) (1 byte) | salt (16 bytes)
 *   frame   = ciphertext length (u32 BE) | AES-256-GCM(ciphertext + 16-byte tag) of up to 1 MiB of the gzip stream
 *   nonce   = 4 zero bytes | frame counter (u64 BE)      -> frames cannot be reordered or replayed
 *   AAD     = header | 1 byte "this is the last frame"    -> the header and a cut-off file are detected
 *
 * The decrypted stream is gzip; inside it is a sequence of records: type (u8) | length (u32 BE) | payload.
 */
const MAGIC = Buffer.from('CSBK');
const VERSION = 1;
const FRAME_PLAIN = 1024 * 1024;
const TAG = 16;
const KDF_LOG2_N = 15;
const MAX_RECORD = 128 * 1024 * 1024;

export const enum Rec { Header = 1, Rows = 2, ObjectBegin = 3, ObjectData = 4, ObjectEnd = 5, Footer = 6 }

export const MIN_PASSPHRASE = 12;

function deriveKey(passphrase: string, salt: Buffer, log2n: number): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 2 ** log2n, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
}
const nonce = (counter: number) => { const n = Buffer.alloc(12); n.writeBigUInt64BE(BigInt(counter), 4); return n; };

class Encrypt extends Transform {
  private pending: Buffer[] = [];
  private pendingLen = 0;
  private held: Buffer | null = null;
  private counter = 0;
  constructor(private readonly key: Buffer, private readonly header: Buffer) { super(); this.push(header); }

  private seal(plain: Buffer, last: boolean) {
    const c = createCipheriv('aes-256-gcm', this.key, nonce(this.counter++));
    c.setAAD(Buffer.concat([this.header, Buffer.from([last ? 1 : 0])]));
    const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    const len = Buffer.alloc(4); len.writeUInt32BE(ct.length);
    this.push(Buffer.concat([len, ct]));
  }
  private takeBytes(n: number): Buffer {
    const all = Buffer.concat(this.pending);
    this.pending = all.length > n ? [all.subarray(n)] : [];
    this.pendingLen = all.length - Math.min(n, all.length);
    return all.subarray(0, n);
  }
  _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback) {
    this.pending.push(chunk); this.pendingLen += chunk.length;
    while (this.pendingLen >= FRAME_PLAIN) {
      // a frame is only sealed once we know it is not the last one
      if (this.held) this.seal(this.held, false);
      this.held = this.takeBytes(FRAME_PLAIN);
    }
    cb();
  }
  _flush(cb: TransformCallback) {
    if (this.held) this.seal(this.held, false);
    this.seal(Buffer.concat(this.pending), true);
    cb();
  }
}

class Decrypt extends Transform {
  private buf = Buffer.alloc(0);
  private header: Buffer | null = null;
  private key: Buffer | null = null;
  private counter = 0;
  private sawLast = false;
  constructor(private readonly passphrase: string) { super(); }

  _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback) {
    try {
      this.buf = Buffer.concat([this.buf, chunk]);
      if (!this.header) {
        if (this.buf.length < 22) return cb();
        const h = this.buf.subarray(0, 22);
        if (!h.subarray(0, 4).equals(MAGIC)) throw new Error('not a CloudSeed backup file');
        if (h[4] !== VERSION) throw new Error(`unsupported backup format version ${h[4]}`);
        this.header = Buffer.from(h);
        this.key = deriveKey(this.passphrase, h.subarray(6, 22), h[5]!);
        this.buf = this.buf.subarray(22);
      }
      for (;;) {
        if (this.buf.length < 4) break;
        const len = this.buf.readUInt32BE(0);
        if (len < TAG || len > FRAME_PLAIN + TAG) throw new Error('backup file is corrupted (bad frame size)');
        if (this.buf.length < 4 + len) break;
        const frame = this.buf.subarray(4, 4 + len);
        this.buf = this.buf.subarray(4 + len);
        if (this.sawLast) throw new Error('backup file is corrupted (data after the end)');
        this.push(this.open(frame));
      }
      cb();
    } catch (e) { cb(e as Error); }
  }
  private open(frame: Buffer): Buffer {
    const ct = frame.subarray(0, frame.length - TAG), tag = frame.subarray(frame.length - TAG);
    for (const last of [false, true]) {
      const d = createDecipheriv('aes-256-gcm', this.key!, nonce(this.counter));
      d.setAAD(Buffer.concat([this.header!, Buffer.from([last ? 1 : 0])]));
      d.setAuthTag(tag);
      try {
        const plain = Buffer.concat([d.update(ct), d.final()]);
        this.counter++; this.sawLast = last;
        return plain;
      } catch { /* try the other flag */ }
    }
    throw new Error(this.counter === 0 ? 'wrong passphrase, or the file is not a CloudSeed backup (or is corrupted)' : 'backup file is corrupted or has been modified');
  }
  _flush(cb: TransformCallback) {
    if (!this.header) return cb(new Error('backup file is empty or truncated'));
    if (!this.sawLast || this.buf.length) return cb(new Error('backup file is truncated'));
    cb();
  }
}

export class ArchiveWriter {
  private readonly input = new PassThrough();
  private readonly done: Promise<void>;
  private closed = false;

  constructor(file: string, passphrase: string) {
    const salt = randomBytes(16);
    const header = Buffer.concat([MAGIC, Buffer.from([VERSION, KDF_LOG2_N]), salt]);
    this.done = pipeline(this.input, createGzip({ level: 6 }), new Encrypt(deriveKey(passphrase, salt, KDF_LOG2_N), header), createWriteStream(file, { mode: 0o600 }));
    this.done.catch(() => undefined); // surfaced by write()/end()
  }

  async write(type: Rec, payload: Buffer | object = Buffer.alloc(0)): Promise<void> {
    if (this.closed) throw new Error('archive is closed');
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
    if (body.length > MAX_RECORD) throw new Error('record too large');
    const head = Buffer.alloc(5); head[0] = type; head.writeUInt32BE(body.length, 1);
    if (!this.input.write(Buffer.concat([head, body]))) {
      await Promise.race([new Promise<void>((r) => this.input.once('drain', r)), this.done]);
    }
  }

  async end(): Promise<void> {
    this.closed = true;
    this.input.end();
    await this.done;
  }

  abort(err: Error) { this.closed = true; this.input.destroy(err); }
}

export interface Record_ { type: Rec; payload: Buffer }

/** Decrypts and parses an archive. Throws on a wrong passphrase, any modification, or truncation. */
export async function* readArchive(file: string, passphrase: string): AsyncGenerator<Record_> {
  // stream.pipeline (callback form) hands back the last stream and destroys it with the first error from any stage
  const plain = pipelineCb(createReadStream(file), new Decrypt(passphrase), createGunzip(), () => undefined);
  let buf: Buffer = Buffer.alloc(0);
  for await (const chunk of plain as AsyncIterable<Buffer>) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 5) break;
      const len = buf.readUInt32BE(1);
      if (len > MAX_RECORD) throw new Error('backup file is corrupted (bad record size)');
      if (buf.length < 5 + len) break;
      yield { type: buf[0] as Rec, payload: Buffer.from(buf.subarray(5, 5 + len)) };
      buf = buf.subarray(5 + len);
    }
  }
  if (buf.length) throw new Error('backup file is truncated (partial record)');
}

export async function restrictFile(file: string) { await chmod(file, 0o600).catch(() => undefined); }
