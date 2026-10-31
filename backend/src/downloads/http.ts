import http, { type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';
import { BlockedDestinationError, type Guard } from './ssrf.js';

export class FetchError extends Error {
  constructor(public readonly code: string, message: string, public readonly cause2?: unknown) { super(message); }
}

export interface FetchOptions {
  guard: Guard;
  method?: 'GET' | 'HEAD';
  headers?: OutgoingHttpHeaders;
  connectTimeoutMs: number;
  maxRedirects: number;
  signal?: AbortSignal;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Performs a request without following redirects implicitly: every hop is re-validated by the guard
 * (scheme, port, literal IP) and every connection resolves through the guard's pinned lookup.
 * Resolves as soon as response headers arrive; the caller owns the body stream.
 */
export async function guardedFetch(rawUrl: string, o: FetchOptions): Promise<{ res: IncomingMessage; url: URL }> {
  let url = o.guard.assertUrl(rawUrl);
  for (let hop = 0; ; hop++) {
    const res = await once(url, o);
    const loc = res.headers.location;
    if (REDIRECTS.has(res.statusCode ?? 0) && loc) {
      res.resume();
      if (hop >= o.maxRedirects) throw new FetchError('too_many_redirects', `More than ${o.maxRedirects} redirects`);
      let next: URL;
      try { next = new URL(loc, url); } catch { throw new FetchError('bad_redirect', 'Invalid redirect location'); }
      url = o.guard.assertUrl(next); // re-validate each hop
      continue;
    }
    return { res, url };
  }
}

function once(url: URL, o: FetchOptions): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: o.method ?? 'GET',
      headers: { 'user-agent': 'CloudSeed/1.0', accept: '*/*', 'accept-encoding': 'identity', ...o.headers },
      lookup: o.guard.lookup,
      timeout: o.connectTimeoutMs,
      signal: o.signal,
    });
    req.on('timeout', () => req.destroy(new FetchError('timeout', 'Connection timed out')));
    req.on('response', (res) => { req.setTimeout(0); resolve(res); });
    req.on('error', (e) => {
      const err = e as NodeJS.ErrnoException & { cause?: unknown };
      if (e instanceof BlockedDestinationError || err.cause instanceof BlockedDestinationError) return reject(err.cause ?? e);
      if (e instanceof FetchError || e.name === 'AbortError') return reject(e);
      reject(new FetchError(err.code === 'ENOTFOUND' ? 'dns_failed' : 'network_error', err.code ?? e.message, e));
    });
    req.end();
  });
}
