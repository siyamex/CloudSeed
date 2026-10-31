import type { FastifyReply } from 'fastify';
import type { StorageAdapter } from '../storage/types.js';
import { parseRange } from './util.js';

export interface ServeOptions {
  size: number;
  mime: string;
  etag?: string | null;
  /** inline for media/images shown by the browser, attachment for downloads */
  disposition: string;
  rangeHeader: string | undefined;
  cacheControl: string;
}

/**
 * Streams an object straight from storage with HTTP Range support (single range), so seeking works and nothing is
 * buffered. Always sandboxed and non-sniffable: a served file can never run as a page of this origin.
 */
export async function serveObject(reply: FastifyReply, adapter: StorageAdapter, key: string, o: ServeOptions): Promise<FastifyReply> {
  const range = parseRange(o.rangeHeader, o.size);
  if (range === 'invalid') return reply.status(416).header('content-range', `bytes */${o.size}`).send();
  reply.header('accept-ranges', 'bytes')
    .header('content-type', o.mime)
    .header('content-disposition', o.disposition)
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', o.cacheControl);
  if (o.etag) reply.header('etag', `"${o.etag}"`);
  if (range) {
    reply.status(206).header('content-range', `bytes ${range.start}-${range.end}/${o.size}`).header('content-length', range.end - range.start + 1);
    return reply.send(await adapter.get(key, range));
  }
  reply.header('content-length', o.size);
  return reply.send(await adapter.get(key));
}
