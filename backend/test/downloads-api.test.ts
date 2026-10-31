import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { DownloadEngine } from '../src/downloads/engine.js';
import { createGuard } from '../src/downloads/ssrf.js';
import { authed, createTestEnv, login, type Session, type TestEnv } from './helpers.js';
import { makeBytes, startOrigin, type Origin } from './origin.js';

let t: TestEnv;
let origin: Origin;
let alice: Session, bob: Session;
const engines: DownloadEngine[] = [];

beforeAll(async () => {
  origin = await startOrigin();
  t = await createTestEnv({ DOWNLOAD_ALLOWED_PORTS: String(origin.port), DOWNLOAD_MAX_ACTIVE_PER_USER: '6' });
  alice = await login(t, 'da-alice', 'da-alice@example.com');
  bob = await login(t, 'da-bob', 'da-bob@example.com');
});
afterEach(async () => { for (const e of engines.splice(0)) await e.stop(); });
afterAll(async () => { await t.close(); await origin.close(); });

const call = (s: Session | null, method: string, url: string, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: s ? authed(s) : {}, payload: payload as object });
const create = (s: Session, body: Record<string, unknown>) => call(s, 'POST', '/downloads', { url: `${origin.url}/file?size=1000`, ...body });
const engine = (o: Partial<Config> = {}) => {
  const config = { ...t.config, ...o } as Config;
  const e = new DownloadEngine({ db: t.db, storage: t.storage, adapterFor: () => t.storage, config,
    guard: createGuard({ allowedCidrs: config.DOWNLOAD_ALLOWED_CIDRS, allowedPorts: config.DOWNLOAD_ALLOWED_PORTS }), log: { info() {}, warn() {}, error() {} } });
  engines.push(e);
  return e;
};
const wait = async <T,>(fn: () => Promise<T | false>, ms = 15000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timed out');
};

describe('authentication and validation', () => {
  it('requires a session and CSRF for every endpoint', async () => {
    expect((await call(null, 'GET', '/downloads')).statusCode).toBe(401);
    expect((await call(null, 'POST', '/downloads', { url: 'http://x.test/a' })).statusCode).toBe(401);
    expect((await call(null, 'POST', '/downloads/preview', { url: 'http://x.test/a' })).statusCode).toBe(401);
    expect((await call(null, 'GET', '/downloads/events')).statusCode).toBe(401);
    const noCsrf = await t.app.inject({ method: 'POST', url: '/api/v1/downloads', headers: { cookie: alice.cookie }, payload: { url: `${origin.url}/file` } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it.each([
    ['not a url', 'invalid_url'], ['ftp://example.com/x', 'blocked_destination'], ['file:///etc/passwd', 'blocked_destination'],
    ['http://user:pw@example.com/x', 'blocked_destination'], ['http://169.254.169.254/latest/meta-data/', 'blocked_destination'],
    ['http://10.0.0.1/x', 'blocked_destination'], ['http://[::1]:80/x', 'blocked_destination'], ['http://example.com:22/x', 'blocked_destination'],
  ])('rejects %s', async (url, code) => {
    const r = await call(alice, 'POST', '/downloads', { url });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe(code);
    const p = await call(alice, 'POST', '/downloads/preview', { url });
    expect(p.statusCode).toBe(400);
  });

  it('rejects private destinations when the allowlist is empty (default production posture)', async () => {
    const strict = await createTestEnv({ DOWNLOAD_ALLOWED_CIDRS: '', DOWNLOAD_ALLOWED_PORTS: String(origin.port) });
    try {
      const s = await login(strict, 'strict', 'strict@example.com');
      const r = await strict.app.inject({ method: 'POST', url: '/api/v1/downloads', headers: authed(s), payload: { url: `${origin.url}/file` } });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('blocked_destination');
      const r2 = await strict.app.inject({ method: 'POST', url: '/api/v1/downloads', headers: authed(s), payload: { url: `http://localhost:${origin.port}/file` } });
      expect(r2.json().error.code).toBe('blocked_destination');
    } finally { await strict.close(); }
  });

  it('validates optional fields', async () => {
    expect((await create(alice, { sha256: 'abc' })).statusCode).toBe(400);
    expect((await create(alice, { priority: 'urgent' })).statusCode).toBe(400);
    expect((await create(alice, { filename: 'a/b' })).statusCode).toBe(400);
    expect((await create(alice, { folderId: 'nope' })).statusCode).toBe(400);
    expect((await create(alice, { onConflict: 'overwrite' })).statusCode).toBe(400);
    expect((await call(alice, 'POST', '/downloads', {})).statusCode).toBe(400);
  });

  it("will not target another user's folder", async () => {
    const f = (await t.db.query<{ id: string }>(`INSERT INTO folders (user_id, name) VALUES ($1, 'bobs') RETURNING id`, [bob.userId])).rows[0]!.id;
    expect((await create(alice, { folderId: f })).statusCode).toBe(404);
  });
});

describe('preview', () => {
  it('reports name, size, content type and resumability from headers', async () => {
    const r = await call(alice, 'POST', '/downloads/preview', { url: `${origin.url}/file?size=12345&disp=movie.mkv` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ filename: 'movie.mkv', size: 12345, contentType: 'application/octet-stream', acceptsRanges: true, resumable: true, warnings: [] });
  });

  it('falls back to a ranged GET when HEAD is rejected', async () => {
    const r = await call(alice, 'POST', '/downloads/preview', { url: `${origin.url}/file?size=777&nohead=1` });
    expect(r.statusCode).toBe(200);
    expect(r.json().size).toBe(777);
    expect(origin.log.some((q) => q.path === '/file' && q.range === 'bytes=0-0')).toBe(true);
  });

  it('says when resuming is not possible and when size is unknown or too large', async () => {
    expect((await call(alice, 'POST', '/downloads/preview', { url: `${origin.url}/file?size=1000&norange=1` })).json()).toMatchObject({ acceptsRanges: false, resumable: false });
    expect((await call(alice, 'POST', '/downloads/preview', { url: `${origin.url}/file?size=1000&noetag=1` })).json()).toMatchObject({ acceptsRanges: true, resumable: false });
    const big = (await call(alice, 'POST', '/downloads/preview', { url: `${origin.url}/file?size=600000` })).json();
    expect(big.warnings.map((w: { code: string }) => w.code)).toEqual(['file_too_large']);
    const unk = (await call(alice, 'POST', '/downloads/preview', { url: `${origin.url}/file?size=1000&chunked=1` })).json();
    expect(unk.size).toBeNull();
    expect(unk.warnings.map((w: { code: string }) => w.code)).toContain('unknown_size');
  });

  it('reports remote errors without leaking internals', async () => {
    const r = await call(alice, 'POST', '/downloads/preview', { url: `${origin.url}/missing` });
    expect(r.statusCode).toBe(502);
    expect(r.json().error.code).toBe('source_error');
    const down = await call(alice, 'POST', '/downloads/preview', { url: `http://127.0.0.1:${origin.port === 80 ? 443 : 80}/x` });
    expect(down.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('job lifecycle through the API', () => {
  it('creates a queued job with defaults, lists it, and returns it by id', async () => {
    const r = await create(alice, {});
    expect(r.statusCode).toBe(201);
    const j = r.json();
    expect(j).toMatchObject({ state: 'queued', priority: 'normal', bytesReceived: 0, totalBytes: null, percent: null, attempt: 0, error: null, fileId: null });
    const list = (await call(alice, 'GET', '/downloads')).json();
    expect(list.jobs.map((x: { id: string }) => x.id)).toContain(j.id);
    const one = (await call(alice, 'GET', `/downloads/${j.id}`)).json();
    expect(one.events.map((e: { kind: string }) => e.kind)).toEqual(['created']);
  });

  it('runs end to end: worker completes the job, the file is downloadable, progress fields are sane', async () => {
    const s = await login(t, 'da-e2e', 'da-e2e@example.com');
    const j = (await create(s, { url: `${origin.url}/file?size=200000&seed=77&disp=e2e.bin`, priority: 'high' })).json();
    engine().start();
    const done = await wait(async () => { const x = (await call(s, 'GET', `/downloads/${j.id}`)).json(); return x.state === 'completed' || x.state === 'failed' ? x : false; });
    expect(done).toMatchObject({ state: 'completed', percent: 100, bytesReceived: 200000, totalBytes: 200000, filename: 'e2e.bin', speedBps: 0, etaSeconds: null, priority: 'high' });
    expect(done.elapsedSeconds).toBeGreaterThanOrEqual(0);
    const file = await t.app.inject({ method: 'GET', url: `/api/v1/files/${done.fileId}/content`, headers: { cookie: s.cookie } });
    expect(file.statusCode).toBe(200);
    expect(Buffer.from(file.rawPayload)).toEqual(makeBytes(200000, 77));

    const dash = (await call(s, 'GET', '/dashboard')).json();
    expect(dash.downloads).toMatchObject({ active: 0, completed: 1, failed: 0 });
    expect(dash.storage.usedBytes).toBe(200000);
  });

  it('reports a failed job with a machine-readable code and message', async () => {
    const s = await login(t, 'da-fail', 'da-fail@example.com');
    const j = (await create(s, { url: `${origin.url}/missing` })).json();
    engine().start();
    const done = await wait(async () => { const x = (await call(s, 'GET', `/downloads/${j.id}`)).json(); return x.state === 'failed' ? x : false; });
    expect(done.error).toEqual({ code: 'not_found', message: 'File not found (HTTP 404)' });
    expect(done.events.some((e: { kind: string }) => e.kind === 'error')).toBe(true);
  });

  it('pause / resume / cancel / retry / priority / delete follow the state rules', async () => {
    const s = await login(t, 'da-ctl', 'da-ctl@example.com');
    const id = (await create(s, {})).json().id;

    expect((await call(s, 'POST', `/downloads/${id}/resume`)).statusCode).toBe(409); // not paused
    expect((await call(s, 'POST', `/downloads/${id}/retry`)).statusCode).toBe(409);  // not failed
    expect((await call(s, 'DELETE', `/downloads/${id}`)).statusCode).toBe(409);      // not finished

    expect((await call(s, 'PATCH', `/downloads/${id}`, { priority: 'low' })).json().priority).toBe('low');
    expect((await call(s, 'PATCH', `/downloads/${id}`, { priority: 'urgent' })).statusCode).toBe(400);

    expect((await call(s, 'POST', `/downloads/${id}/pause`)).json().state).toBe('paused');
    expect((await call(s, 'POST', `/downloads/${id}/pause`)).statusCode).toBe(409);
    expect((await call(s, 'POST', `/downloads/${id}/resume`)).json().state).toBe('queued');
    expect((await call(s, 'POST', `/downloads/${id}/cancel`)).json().state).toBe('cancelled');
    expect((await call(s, 'POST', `/downloads/${id}/cancel`)).statusCode).toBe(409);
    expect((await call(s, 'PATCH', `/downloads/${id}`, { priority: 'high' })).statusCode).toBe(409); // terminal
    expect((await call(s, 'POST', `/downloads/${id}/retry`)).json()).toMatchObject({ state: 'queued', attempt: 0, error: null });
    await call(s, 'POST', `/downloads/${id}/cancel`);
    expect((await call(s, 'DELETE', `/downloads/${id}`)).statusCode).toBe(204);
    expect((await call(s, 'GET', `/downloads/${id}`)).statusCode).toBe(404);
  });

  it('asks the worker to pause/cancel a running job (control flag) and refuses to pause during verification', async () => {
    const s = await login(t, 'da-run', 'da-run@example.com');
    const mk = async (state: string) => (await t.db.query<{ id: string }>(
      `INSERT INTO download_jobs (user_id, url, state, worker_id, lease_expires_at) VALUES ($1, 'http://x.test/a', $2, 'w', now() + interval '1 hour') RETURNING id`, [s.userId, state])).rows[0]!.id;
    const running = await mk('downloading');
    const pj = (await call(s, 'POST', `/downloads/${running}/pause`)).json();
    expect(pj).toMatchObject({ state: 'downloading', pendingControl: 'pause' });
    expect((await call(s, 'POST', `/downloads/${running}/pause`)).statusCode).toBe(409); // already requested
    expect((await call(s, 'POST', `/downloads/${running}/cancel`)).json().pendingControl).toBe('cancel');

    const verifying = await mk('verifying');
    const v = await call(s, 'POST', `/downloads/${verifying}/pause`);
    expect(v.statusCode).toBe(409);
    expect(v.json().error.message).toMatch(/finalised/);
    expect((await call(s, 'POST', `/downloads/${verifying}/cancel`)).json().pendingControl).toBe('cancel');
  });

  it('applies backpressure: refuses new downloads past the per-user limit of unfinished jobs', async () => {
    const s = await login(t, 'da-limit', 'da-limit@example.com');
    for (let i = 0; i < 6; i++) expect((await create(s, {})).statusCode).toBe(201);
    const r = await create(s, {});
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe('too_many_downloads');
  });

  it('paginates the job list and filters by state', async () => {
    const s = await login(t, 'da-page', 'da-page@example.com');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await create(s, {})).json().id);
    await call(s, 'POST', `/downloads/${ids[0]}/cancel`);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = (await call(s, 'GET', `/downloads?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).json();
      seen.push(...r.jobs.map((j: { id: string }) => j.id));
      cursor = r.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(5);
    expect(seen.length).toBe(5);
    expect((await call(s, 'GET', '/downloads?state=cancelled')).json().jobs).toHaveLength(1);
    expect((await call(s, 'GET', '/downloads?state=waiting')).json().jobs).toHaveLength(4);
    expect((await call(s, 'GET', '/downloads?cursor=garbage')).statusCode).toBe(400);
  });
});

describe('authorization isolation (IDOR)', () => {
  it("never exposes or lets one user control another user's downloads", async () => {
    const id = (await create(alice, {})).json().id;
    for (const [m, u, body] of [
      ['GET', `/downloads/${id}`], ['POST', `/downloads/${id}/pause`], ['POST', `/downloads/${id}/resume`], ['POST', `/downloads/${id}/cancel`],
      ['POST', `/downloads/${id}/retry`], ['PATCH', `/downloads/${id}`, { priority: 'high' }], ['DELETE', `/downloads/${id}`],
    ] as [string, string, unknown?][]) {
      const r = await call(bob, m, u, body);
      expect(r.statusCode, `${m} ${u}`).toBe(404);
    }
    expect((await call(bob, 'GET', '/downloads')).json().jobs.map((j: { id: string }) => j.id)).not.toContain(id);
    const still = (await call(alice, 'GET', `/downloads/${id}`)).json();
    expect(still.state).toBe('queued');
    expect(still.priority).toBe('normal');
  });
});

describe('live progress (SSE)', () => {
  it('streams only the authenticated user\'s job updates, through to completion', async () => {
    const s = await login(t, 'da-sse', 'da-sse@example.com');
    const other = await login(t, 'da-sse2', 'da-sse2@example.com');
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as { port: number }).port;

    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/downloads/events`, { headers: { cookie: s.cookie }, signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const events: { event: string; data: any }[] = [];
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.+)$/m.exec(block)?.[1];
            if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
          }
        }
      } catch { /* aborted */ }
    })();

    try {
    await wait(async () => events.some((e) => e.event === 'ready'), 5000);
    const mine = (await create(s, { url: `${origin.url}/file?size=150000&seed=5&slow=40000` })).json();
    const theirs = (await create(other, { url: `${origin.url}/file?size=1000` })).json();
    engine().start();

    await wait(async () => events.some((e) => e.event === 'job' && e.data.id === mine.id && e.data.state === 'completed'), 20000);
    const states = events.filter((e) => e.event === 'job' && e.data.id === mine.id).map((e) => e.data.state);
    expect(states).toContain('downloading');
    expect(states[states.length - 1]).toBe('completed');
    const progress = events.filter((e) => e.data?.id === mine.id && e.data.state === 'downloading').map((e) => e.data.bytesReceived);
    expect(progress.some((b: number) => b > 0 && b < 150000)).toBe(true); // intermediate progress was streamed
    expect(events.some((e) => e.data?.id === theirs.id)).toBe(false);     // never another user's job
    } finally {
      ac.abort();
      await pump;
    }
  }, 40000);

  it('limits concurrent streams per user', async () => {
    const s = await login(t, 'da-sse3', 'da-sse3@example.com');
    const port = (t.app.server.address() as { port: number }).port;
    const acs: AbortController[] = [];
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const ac = new AbortController(); acs.push(ac);
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/downloads/events`, { headers: { cookie: s.cookie }, signal: ac.signal });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    acs.forEach((a) => a.abort());
  });
});
