import {
  DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, S3Client, type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import { PassThrough, Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StorageLimitError, type ListedObject, type PutResult, type StorageAdapter } from './types.js';

export interface S3Options {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Required by MinIO and several other providers; DigitalOcean Spaces works with virtual-host style. */
  forcePathStyle?: boolean;
  keyPrefix?: string;
  /** Multipart part size in bytes (S3 minimum is 5 MiB). */
  partSize?: number;
}

const KEY_RE = /^[a-z0-9][a-z0-9/_-]{0,199}$/;

/**
 * S3-compatible adapter. Uses only the object API (no filesystem semantics assumed):
 * uploads are streamed as multipart with bounded memory (partSize x queueSize) and an object
 * only becomes visible once the upload completes, so a key never holds a partial object.
 */
export class S3Storage implements StorageAdapter {
  readonly kind = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly partSize: number;

  constructor(opts: S3Options, clientOverrides: Partial<S3ClientConfig> = {}) {
    this.bucket = opts.bucket;
    this.prefix = opts.keyPrefix ? opts.keyPrefix.replace(/^\/+|\/+$/g, '') + '/' : '';
    this.partSize = Math.max(5 * 1024 * 1024, opts.partSize ?? 8 * 1024 * 1024);
    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint || undefined,
      forcePathStyle: opts.forcePathStyle,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      maxAttempts: 5, // SDK retries throttling/5xx with exponential backoff and jitter
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...clientOverrides,
    });
  }

  private objectKey(key: string): string {
    if (!KEY_RE.test(key) || key.includes('..') || key.includes('//') || key.endsWith('/')) throw new Error('invalid storage key');
    return this.prefix + key;
  }

  async put(key: string, body: Readable, opts: { maxBytes: number }): Promise<PutResult> {
    const Key = this.objectKey(key);
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
    const out = new PassThrough();
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key, Body: out },
      partSize: this.partSize,
      queueSize: 2, // at most ~2 parts buffered in memory
      leavePartsOnError: false, // aborts the multipart upload so no orphaned parts accrue cost
    });
    const uploading = upload.done();
    uploading.catch(() => undefined); // surfaced below; avoid an unhandled rejection if the source fails first
    try {
      await pipeline(body, meter, out);
      await uploading;
    } catch (e) {
      await upload.abort().catch(() => undefined);
      await uploading.catch(() => undefined);
      // The object never completed, but be defensive about a race with completion.
      await this.delete(key).catch(() => undefined);
      throw e;
    }
    return { size, sha256: hash.digest('hex') };
  }

  async get(key: string, range?: { start: number; end: number }): Promise<Readable> {
    const r = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket, Key: this.objectKey(key), Range: range ? `bytes=${range.start}-${range.end}` : undefined,
    }));
    return r.Body as Readable;
  }

  async presignedGetUrl(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }), { expiresIn: ttlSeconds });
  }

  async stat(key: string) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
      return { size: Number(r.ContentLength ?? 0) };
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (e as Error).name === 'NotFound') return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    // S3 DeleteObject succeeds for missing keys, so this is idempotent by nature.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
  }

  async *list(): AsyncGenerator<ListedObject> {
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.prefix || undefined, ContinuationToken: token }));
      for (const o of r.Contents ?? []) {
        const key = o.Key!.slice(this.prefix.length);
        if (KEY_RE.test(key)) yield { key, size: Number(o.Size ?? 0), modifiedAt: o.LastModified ?? new Date(0) };
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  }

  async health() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      // Total bucket capacity is not exposed by S3-compatible APIs, so none is reported.
      return { ok: true, detail: 'bucket reachable (provider capacity is not measurable)' };
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      return { ok: false, detail: `${(e as Error).name}${status ? ` (HTTP ${status})` : ''}` };
    }
  }
}
