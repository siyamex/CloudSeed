import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchError, guardedFetch } from '../src/downloads/http.js';
import { BlockedDestinationError, createGuard } from '../src/downloads/ssrf.js';
import {
  JOB_STATES, ACTIVE_STATES, TERMINAL_STATES, backoffMs, canTransition, classifyStatus, deriveFilename,
  filenameFromDisposition, parseRetryAfter, statesAllowedBefore,
} from '../src/downloads/state.js';

describe('SSRF guard: URL validation', () => {
  const g = createGuard();
  it.each([
    'http://127.0.0.1/x', 'http://127.1/x', 'http://2130706433/x', 'http://0x7f.0.0.1/x', 'http://017700000001/x',
    'http://10.0.0.5/x', 'http://172.16.0.1/x', 'http://172.31.255.255/x', 'http://192.168.1.1/x',
    'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/x', 'http://0.0.0.0/x', 'http://224.0.0.1/x',
    'http://[::1]/x', 'http://[::]/x', 'http://[fe80::1]/x', 'http://[fc00::1]/x', 'http://[fd12:3456::1]/x',
    'http://[::ffff:127.0.0.1]/x', 'http://[::ffff:7f00:1]/x', 'http://[::ffff:169.254.169.254]/x',
    'http://[64:ff9b::7f00:1]/x', 'http://[2002:7f00:1::]/x', 'http://[ff02::1]/x',
  ])('blocks %s', (u) => { expect(() => g.assertUrl(u)).toThrow(BlockedDestinationError); });

  it.each(['http://8.8.8.8/x', 'https://1.1.1.1/x', 'http://[2606:4700:4700::1111]/x', 'https://example.com/file.zip', 'http://172.32.0.1/x', 'http://100.128.0.1/x'])(
    'allows %s', (u) => { expect(g.assertUrl(u).href).toBeTruthy(); });

  it.each(['ftp://example.com/x', 'file:///etc/passwd', 'gopher://example.com', 'javascript:alert(1)', 'data:text/plain,hi'])(
    'rejects non-http scheme %s', (u) => { expect(() => g.assertUrl(u)).toThrow(); });

  it('rejects embedded credentials, disallowed ports, and malformed URLs', () => {
    expect(() => g.assertUrl('http://user:pw@example.com/')).toThrow(/credentials/);
    expect(() => g.assertUrl('http://user@example.com/')).toThrow(/credentials/);
    expect(() => g.assertUrl('http://example.com:22/')).toThrow(/Port 22/);
    expect(() => g.assertUrl('http://example.com:6379/')).toThrow(/Port 6379/);
    expect(() => g.assertUrl('not a url')).toThrow();
    expect(g.assertUrl('https://example.com:443/x')).toBeTruthy();
  });

  it('honours an explicit allowlist and custom ports', () => {
    const a = createGuard({ allowedCidrs: '10.1.0.0/16, 192.168.5.5', allowedPorts: '80,443,8080' });
    expect(a.assertUrl('http://10.1.2.3:8080/x')).toBeTruthy();
    expect(a.assertUrl('http://192.168.5.5/x')).toBeTruthy();
    expect(() => a.assertUrl('http://10.2.0.1/x')).toThrow(BlockedDestinationError); // outside the allowed /16
    expect(() => a.assertUrl('http://192.168.5.6/x')).toThrow(BlockedDestinationError);
    expect(() => createGuard({ allowedCidrs: 'nonsense' })).toThrow(/Invalid DOWNLOAD_ALLOWED_CIDRS/);
  });

  it('resolves hostnames and refuses names that point at private space', async () => {
    await expect(g.assertResolvable(new URL('http://localhost/x'))).rejects.toBeInstanceOf(BlockedDestinationError);
  });
});

describe('guardedFetch against a real local server', () => {
  const hits: string[] = [];
  let base = '';
  let server: ReturnType<typeof createServer>;
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url!);
      if (req.url === '/redir-metadata') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); return void res.end(); }
      if (req.url === '/redir-loop') { res.writeHead(302, { location: '/redir-loop' }); return void res.end(); }
      if (req.url === '/redir-ok') { res.writeHead(302, { location: '/final' }); return void res.end(); }
      if (req.url === '/redir-ftp') { res.writeHead(302, { location: 'ftp://example.com/x' }); return void res.end(); }
      res.end('hello');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const opts = (guard: ReturnType<typeof createGuard>) => ({ guard, connectTimeoutMs: 2000, maxRedirects: 3 });

  it('never connects to loopback when it is not allowlisted (literal IP)', async () => {
    const before = hits.length;
    const guard = createGuard({ allowedPorts: new URL(base).port });
    await expect(guardedFetch(`${base}/x`, opts(guard))).rejects.toBeInstanceOf(BlockedDestinationError);
    expect(hits.length).toBe(before);
  });

  it('blocks a hostname that resolves to loopback at connect time (pinned lookup, no connection made)', async () => {
    const before = hits.length;
    const port = new URL(base).port;
    const guard = createGuard({ allowedPorts: port });
    await expect(guardedFetch(`http://localhost:${port}/x`, opts(guard))).rejects.toBeInstanceOf(BlockedDestinationError);
    expect(hits.length).toBe(before);
  });

  it('connects when the destination is explicitly allowlisted, and follows safe redirects', async () => {
    const port = new URL(base).port;
    const guard = createGuard({ allowedCidrs: '127.0.0.0/8', allowedPorts: port });
    const { res } = await guardedFetch(`${base}/redir-ok`, opts(guard));
    expect(res.statusCode).toBe(200);
    res.resume();
    expect(hits).toContain('/final');
  });

  it('re-validates every redirect hop (redirect to cloud metadata is refused)', async () => {
    const port = new URL(base).port;
    const guard = createGuard({ allowedCidrs: '127.0.0.0/8', allowedPorts: port });
    await expect(guardedFetch(`${base}/redir-metadata`, opts(guard))).rejects.toBeInstanceOf(BlockedDestinationError);
  });

  it('refuses redirects to other schemes and caps redirect chains', async () => {
    const port = new URL(base).port;
    const guard = createGuard({ allowedCidrs: '127.0.0.0/8', allowedPorts: port });
    await expect(guardedFetch(`${base}/redir-ftp`, opts(guard))).rejects.toBeInstanceOf(BlockedDestinationError);
    await expect(guardedFetch(`${base}/redir-loop`, opts(guard))).rejects.toMatchObject({ code: 'too_many_redirects' });
  });

  it('reports connection failures as FetchError', async () => {
    const guard = createGuard({ allowedCidrs: '127.0.0.0/8', allowedPorts: '1' });
    await expect(guardedFetch('http://127.0.0.1:1/x', opts(guard))).rejects.toBeInstanceOf(FetchError);
  });
});

describe('job state machine', () => {
  it('only allows documented transitions', () => {
    expect(canTransition('queued', 'resolving')).toBe(true);
    expect(canTransition('resolving', 'downloading')).toBe(true);
    expect(canTransition('downloading', 'verifying')).toBe(true);
    expect(canTransition('verifying', 'completed')).toBe(true);
    expect(canTransition('downloading', 'paused')).toBe(true);
    expect(canTransition('paused', 'queued')).toBe(true);
    expect(canTransition('failed', 'queued')).toBe(true);
    expect(canTransition('downloading', 'pending')).toBe(true); // retry backoff
  });
  it('forbids skipping and leaving completed', () => {
    expect(canTransition('queued', 'downloading')).toBe(false);
    expect(canTransition('queued', 'completed')).toBe(false);
    expect(canTransition('paused', 'downloading')).toBe(false);
    expect(canTransition('verifying', 'paused')).toBe(false);
    for (const s of JOB_STATES) expect(canTransition('completed', s)).toBe(false);
  });
  it('every non-terminal state can reach a terminal one, and active states can be requeued after a crash', () => {
    for (const s of ACTIVE_STATES) expect(canTransition(s, 'queued')).toBe(true);
    for (const s of JOB_STATES.filter((x) => !TERMINAL_STATES.includes(x) && x !== 'paused')) {
      expect(['failed', 'cancelled', 'completed'].some((t) => canTransition(s, t as never)) || canTransition(s, 'resolving')).toBe(true);
    }
    expect(statesAllowedBefore('completed')).toEqual(['verifying']);
  });
});

describe('retry policy', () => {
  it('backoff grows exponentially with bounded jitter and respects the cap', () => {
    expect(backoffMs(1, 1000, 60000, () => 0.5)).toBe(1000);
    expect(backoffMs(2, 1000, 60000, () => 0.5)).toBe(2000);
    expect(backoffMs(4, 1000, 60000, () => 0.5)).toBe(8000);
    expect(backoffMs(1, 1000, 60000, () => 0)).toBe(500);
    expect(backoffMs(1, 1000, 60000, () => 0.999)).toBeLessThan(1500);
    expect(backoffMs(20, 1000, 60000, () => 0.9)).toBe(60000);
    const samples = Array.from({ length: 200 }, () => backoffMs(3, 1000, 1e9));
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(2000);
    expect(Math.max(...samples)).toBeLessThanOrEqual(6000); // base * 2^2 * 1.5, inclusive: Math.round can land exactly on the bound
    expect(new Set(samples).size).toBeGreaterThan(20); // actually jittered
  });
  it('classifies HTTP statuses', () => {
    for (const s of [500, 502, 503, 504, 408, 425, 429]) expect(classifyStatus(s).permanent, String(s)).toBe(false);
    for (const s of [400, 401, 403, 404, 410, 451]) expect(classifyStatus(s).permanent, String(s)).toBe(true);
    expect(classifyStatus(404).code).toBe('not_found');
    expect(classifyStatus(403).code).toBe('access_denied');
    expect(classifyStatus(429, '7').retryAfterMs).toBe(7000);
  });
  it('parses Retry-After in both forms and caps it', () => {
    expect(parseRetryAfter('30')).toBe(30000);
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
    expect(parseRetryAfter('999999')).toBe(3_600_000);
    expect(parseRetryAfter('garbage')).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('-5')).toBeUndefined();
  });
});

describe('filename derivation', () => {
  it('reads Content-Disposition variants', () => {
    expect(filenameFromDisposition('attachment; filename="a b.zip"')).toBe('a b.zip');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''caf%C3%A9.pdf")).toBe('café.pdf');
    expect(filenameFromDisposition('attachment; filename=plain.txt; size=3')).toBe('plain.txt');
    expect(filenameFromDisposition('inline')).toBeNull();
  });
  it('prefers explicit > disposition > URL path and always sanitises', () => {
    const url = new URL('https://x.test/dir/file%20name.iso?token=1');
    expect(deriveFilename({ explicit: 'mine.bin', disposition: 'attachment; filename="d.bin"', url })).toBe('mine.bin');
    expect(deriveFilename({ disposition: 'attachment; filename="d.bin"', url })).toBe('d.bin');
    expect(deriveFilename({ url })).toBe('file name.iso');
    expect(deriveFilename({ url: new URL('https://x.test/') })).toBe('download');
    expect(deriveFilename({ disposition: 'attachment; filename="../../etc/passwd"', url })).toBe('passwd');
    expect(deriveFilename({ disposition: 'attachment; filename=".."', url })).toBe('file name.iso');
  });
});
