import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** Deterministic pseudo-random bytes (xorshift32), so a mis-spliced resume cannot accidentally look correct. */
export function makeBytes(size: number, seed = 1): Buffer {
  const b = Buffer.alloc(size);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < size; i += 4) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    for (let k = 0; k < 4 && i + k < size; k++) b[i + k] = (x >>> (k * 8)) & 255;
  }
  return b;
}

export interface OriginRequest { path: string; search: string; range?: string; ifRange?: string }

export interface Origin {
  url: string;
  port: number;
  /** Every request received, in order. */
  log: OriginRequest[];
  count(pathAndSearch: string): number;
  close(): Promise<void>;
}

/**
 * Configurable download origin. Behaviour is selected by query parameters on /file:
 *   size, seed        body size / content
 *   noetag=1          send no ETag / Last-Modified
 *   norange=1         ignore Range requests (always 200, full body)
 *   chunked=1         no Content-Length (chunked transfer), ignores Range
 *   dropAfter=N       for the first `dropTimes` (default 1) requests, send N body bytes then kill the connection
 *   stallAfter=N      on the first request, send N body bytes then hang
 *   status=S&failTimes=K   respond with status S (optionally Retry-After via retryAfter=secs) for the first K requests
 *   changeAfter=K     after K requests the object changes (new ETag and content)
 *   slow=BPS          pace the body at roughly this many bytes per second
 *   disp=NAME         Content-Disposition: attachment; filename="NAME"
 * /redir-private redirects to the cloud metadata address.
 */
export async function startOrigin(): Promise<Origin> {
  const log: OriginRequest[] = [];
  const counts = new Map<string, number>();
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => void handle(req, res));
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url!, 'http://origin');
    const key = u.pathname + u.search;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    log.push({ path: u.pathname, search: u.search, range: req.headers.range, ifRange: req.headers['if-range'] as string | undefined });
    const q = u.searchParams;
    const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);

    if (u.pathname === '/redir-private') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); return void res.end(); }
    if (u.pathname === '/redir-file') { res.writeHead(302, { location: `/file${u.search}` }); return void res.end(); }
    if (req.method === 'HEAD' && q.has('nohead')) { res.writeHead(405); return void res.end(); }
    if (u.pathname !== '/file') { res.writeHead(404); return void res.end('nope'); }

    const failTimes = num('failTimes', 0);
    if (q.has('status') && n <= failTimes) {
      const h: Record<string, string> = {};
      if (q.has('retryAfter')) h['retry-after'] = q.get('retryAfter')!;
      res.writeHead(num('status', 500), h);
      return void res.end('error');
    }
    if (q.has('status') && failTimes === 0) { res.writeHead(num('status', 500)); return void res.end('error'); }

    const changed = q.has('changeAfter') && n > num('changeAfter', 0);
    const size = num('size', 300_000);
    const seed = num('seed', 1) + (changed ? 100 : 0);
    const body = makeBytes(size, seed);
    const etag = `"e-${seed}-${size}"`;
    const headers: Record<string, string | number> = { 'content-type': 'application/octet-stream' };
    if (!q.has('noetag')) { headers.etag = etag; headers['last-modified'] = 'Wed, 01 Jan 2025 00:00:00 GMT'; }
    if (!q.has('norange') && !q.has('chunked')) headers['accept-ranges'] = 'bytes';
    if (q.has('disp')) headers['content-disposition'] = `attachment; filename="${q.get('disp')}"`;

    let start = 0;
    let status = 200;
    const range = req.headers.range;
    const ifRange = req.headers['if-range'];
    const rangeOk = !q.has('norange') && !q.has('chunked') && range && (!ifRange || ifRange === etag);
    if (rangeOk) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range!);
      if (m) {
        start = Number(m[1]);
        if (start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return void res.end(); }
        status = 206;
        headers['content-range'] = `bytes ${start}-${size - 1}/${size}`;
      }
    }
    const out = body.subarray(start);
    if (!q.has('chunked')) headers['content-length'] = out.length;
    res.writeHead(status, headers);

    const dropAfter = q.has('dropAfter') && n <= num('dropTimes', 1) ? num('dropAfter', 0) : -1;
    const stallAfter = q.has('stallAfter') && n === 1 ? num('stallAfter', 0) : -1;
    const bps = num('slow', 0);
    const chunk = bps > 0 ? Math.max(1024, Math.floor(bps / 10)) : 16 * 1024;
    let sent = 0;
    while (sent < out.length) {
      if (res.destroyed) return;
      const limit = dropAfter >= 0 ? dropAfter : stallAfter >= 0 ? stallAfter : out.length;
      if (sent >= limit) break;
      const end = Math.min(sent + chunk, out.length, limit);
      const len = end - sent;
      if (!res.write(out.subarray(sent, end))) await new Promise<void>((r) => res.once('drain', r));
      sent = end;
      if (bps > 0) await new Promise((r) => setTimeout(r, (1000 * len) / bps));
    }
    if (dropAfter >= 0 && sent < out.length) { setTimeout(() => res.socket?.destroy(), 20); return; }
    if (stallAfter >= 0 && sent < out.length) return; // hang until the client gives up
    res.end();
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    log,
    count: (k) => counts.get(k) ?? 0,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}
