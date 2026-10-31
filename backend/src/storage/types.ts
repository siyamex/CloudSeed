import type { Readable } from 'node:stream';

export interface PutResult { size: number; sha256: string }

export class StorageLimitError extends Error {
  constructor(public readonly limit: number) { super(`size limit of ${limit} bytes exceeded`); }
}

export interface ListedObject { key: string; size: number; modifiedAt: Date }

export interface StorageAdapter {
  readonly kind: 'local' | 's3';
  /** Streams `body` into `key`. Rejects with StorageLimitError past `maxBytes`. Atomic: key never holds a partial object. */
  put(key: string, body: Readable, opts: { maxBytes: number }): Promise<PutResult>;
  /** Returns a stream for [start, end] inclusive, or the whole object. */
  get(key: string, range?: { start: number; end: number }): Promise<Readable>;
  stat(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  health(): Promise<{ ok: boolean; detail?: string }>;
  /** Every object this adapter holds (for reconciliation and migration). Only keys that look like CloudSeed keys are returned. */
  list(): AsyncGenerator<ListedObject>;
  /** Local backends only: absolute path of the object, for tools that need random access. */
  localPath?(key: string): string;
  /** Object stores only: a short-lived private GET URL. Must stay inside the server process; never log or return it. */
  presignedGetUrl?(key: string, ttlSeconds: number): Promise<string>;
}
