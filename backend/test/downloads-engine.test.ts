import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { DownloadEngine, type JobRow } from '../src/downloads/engine.js';
import { createGuard } from '../src/downloads/ssrf.js';
import { createTestEnv, login, type Session, type TestEnv } from './helpers.js';
import { makeBytes, startOrigin, type Origin } from './origin.js';

const silent = { info() {}, warn() {}, error() {} };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let t: TestEnv;
let origin: Origin;
let engines: DownloadEngine[] = [];
let seq = 0;

async function setup(env: Record<string, string> = {}) {
  origin = await startOrigin();
  t = await createTestEnv({ DOWNLOAD_ALLOWED_PORTS: String(origin.port), ...env });
}

function makeEngine(overrides: Partial<Config> = {}, guardOpts?: { allowedCidrs?: string }) {
  const config = { ...t.config, ...overrides } as Config;
  const guard = createGuard({ allowedCidrs: guardOpts?.allowedCidrs ?? config.DOWNLOAD_ALLOWED_CIDRS, allowedPorts: config.DOWNLOAD_ALLOWED_PORTS });
  const e = new DownloadEngine({ db: t.db, storage: t.storage, adapterFor: () => t.storage, config, guard, log: silent });
  engines.push(e);
  return e;
}

async function user(name = `u${++seq}`): Promise<Session> { return login(t, `dl-${name}`, `${name}@example.com`); }

async function addJob(s: Session, pathAndQuery: string, o: Partial<{ state: string; priority: number; sha256: string; filename: string; maxAttempts: number; onConflict: string; folderId: string }> = {}) {
  const r = await t.db.query<{ id: string }>(
    `INSERT INTO download_jobs (user_id, url, state, priority, expected_sha256, filename, max_attempts, on_conflict, folder_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [s.userId, `${origin.url}${pathAndQuery}`, o.state ?? 'queued', o.priority ?? 1, o.sha256 ?? null, o.filename ?? null, o.maxAttempts ?? 5, o.onConflict ?? 'rename', o.folderId ?? null]);
  return r.rows[0]!.id;
}

const job = async (id: string) => (await t.db.query<JobRow & Record<string, any>>(`SELECT * FROM download_jobs WHERE id = $1`, [id])).rows[0]!;
const events = async (id: string) => (await t.db.query<{ kind: string; message: string }>(`SELECT kind, message FROM download_job_events WHERE job_id = $1 ORDER BY id`, [id])).rows;

async function waitFor<T>(fn: () => Promise<T | false | undefined>, ms = 15_000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`timed out waiting for ${what}`);
}
const waitState = (id: string, ...states: string[]) => waitFor(async () => { const j = await job(id); return states.includes(j.state) ? j : false; }, 15_000, `job ${id.slice(0, 8)} -> ${states.join('|')}`);
const storedBytes = async (fileId: string) => {
  const key = (await t.db.query<{ storage_key: string }>(`SELECT storage_key FROM files WHERE id = $1`, [fileId])).rows[0]!.storage_key;
  const chunks: Buffer[] = [];
  for await (const c of await t.storage.get(key)) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};
const used = async (s: Session) => (await t.db.query<{ used_bytes: number }>('SELECT used_bytes FROM storage_quotas WHERE user_id = $1', [s.userId])).rows[0]!.used_bytes;
const partFiles = async () => (existsSync(t.config.DOWNLOAD_WORKDIR) ? (await readdir(t.config.DOWNLOAD_WORKDIR)).filter((f) => f.endsWith('.part')) : []);

beforeEach(async () => { engines = []; await setup(); });
afterEach(async () => { for (const e of engines) await e.stop(); await t.close(); await origin.close(); });

describe('happy path', () => {
  it('downloads a file into storage, charges quota, records events and notifications', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=300000&seed=7');
    makeEngine().start();
    const j = await waitState(id, 'completed', 'failed');
    expect(j.state).toBe('completed');
    expect(Number(j.bytes_received)).toBe(300000);
    expect(Number(j.total_bytes)).toBe(300000);
    expect(j.filename).toBe('file');
    expect(await storedBytes(j.file_id)).toEqual(makeBytes(300000, 7));
    expect(await used(s)).toBe(300000);
    expect(await partFiles()).toEqual([]); // workspace cleaned
    const row = (await t.db.query<{ sha256: string; name: string }>('SELECT sha256, name FROM files WHERE id = $1', [j.file_id])).rows[0]!;
    expect(row.sha256).toBe(sha(makeBytes(300000, 7)));
    expect((await events(id)).map((e) => e.kind)).toEqual(expect.arrayContaining(['state', 'completed']));
    const kinds = (await t.db.query<{ kind: string }>('SELECT kind FROM notifications WHERE user_id = $1 ORDER BY created_at', [s.userId])).rows.map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['download_started', 'download_completed']));
  });

  it('names the file from Content-Disposition and resolves conflicts per policy', async () => {
    const s = await user();
    const a = await addJob(s, '/file?size=1000&seed=1&disp=report.pdf');
    const b = await addJob(s, '/file?size=2000&seed=2&disp=report.pdf');
    makeEngine({ DOWNLOAD_USER_CONCURRENCY: 1 }).start();
    await waitState(a, 'completed'); await waitState(b, 'completed');
    const names = (await t.db.query<{ name: string }>('SELECT name FROM files WHERE user_id = $1 ORDER BY name', [s.userId])).rows.map((r) => r.name);
    expect(names).toEqual(['report (1).pdf', 'report.pdf']);

    const c = await addJob(s, '/file?size=500&seed=3&disp=report.pdf', { onConflict: 'reject' });
    await waitState(c, 'failed');
    expect((await job(c)).error_code).toBe('name_conflict');
  });

  it('uses the explicit filename and the requested folder, falling back to root if the folder was trashed', async () => {
    const s = await user();
    const f = (await t.db.query<{ id: string }>(`INSERT INTO folders (user_id, name) VALUES ($1, 'dl') RETURNING id`, [s.userId])).rows[0]!.id;
    const gone = (await t.db.query<{ id: string }>(`INSERT INTO folders (user_id, name, deleted_at) VALUES ($1, 'old', now()) RETURNING id`, [s.userId])).rows[0]!.id;
    const a = await addJob(s, '/file?size=100', { filename: 'mine.bin', folderId: f });
    const b = await addJob(s, '/file?size=100&seed=2', { filename: 'other.bin', folderId: gone });
    makeEngine().start();
    await waitState(a, 'completed'); await waitState(b, 'completed');
    const rows = (await t.db.query<{ name: string; folder_id: string | null }>('SELECT name, folder_id FROM files WHERE user_id = $1', [s.userId])).rows;
    expect(rows.find((r) => r.name === 'mine.bin')!.folder_id).toBe(f);
    expect(rows.find((r) => r.name === 'other.bin')!.folder_id).toBeNull();
  });

  it('streams without a Content-Length (chunked) and reports unknown total', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=150000&seed=4&chunked=1');
    makeEngine().start();
    const j = await waitState(id, 'completed', 'failed');
    expect(j.state).toBe('completed');
    expect(await storedBytes(j.file_id)).toEqual(makeBytes(150000, 4));
  });
});

describe('resume, restart and integrity', () => {
  it('resumes a dropped connection with Range + If-Range and produces identical bytes', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=400000&seed=9&dropAfter=120000');
    makeEngine().start();
    const j = await waitState(id, 'completed', 'failed');
    expect(j.state).toBe('completed');
    expect(await storedBytes(j.file_id)).toEqual(makeBytes(400000, 9));
    const reqs = origin.log.filter((r) => r.path === '/file');
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.range).toBeUndefined();
    const m = /^bytes=(\d+)-$/.exec(reqs[1]!.range!);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(Number(m![1])).toBeLessThanOrEqual(120000);
    expect(reqs[1]!.ifRange).toBe('"e-9-400000"');
    expect(Number(j.attempt)).toBe(1);
    expect((await events(id)).some((e) => e.kind === 'retry')).toBe(true);
  });

  it('restarts safely when the server ignores Range (200 instead of 206)', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=300000&seed=5&dropAfter=100000&norange=1');
    makeEngine().start();
    const j = await waitState(id, 'completed', 'failed');
    expect(j.state).toBe('completed');
    expect(await storedBytes(j.file_id)).toEqual(makeBytes(300000, 5));
    // A restart is only reported if a resume was attempted, i.e. some bytes had reached the disk before the drop. Under load
    // none may have, in which case the retry correctly starts from scratch without a Range request.
    const tried = origin.log.some((r) => r.path === '/file' && r.range !== undefined);
    expect((await events(id)).some((e) => e.kind === 'restart' && /does not support resuming/.test(e.message))).toBe(tried);
  });

  it('never splices when the remote object changed: If-Range mismatch yields a clean full download', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=300000&seed=1&dropAfter=100000&changeAfter=1');
    makeEngine().start();
    const j = await waitState(id, 'completed', 'failed');
    expect(j.state).toBe('completed');
    const final = await storedBytes(j.file_id);
    expect(final).toEqual(makeBytes(300000, 101)); // the new content in full, not old-prefix + new-suffix
    expect(final.subarray(0, 1000)).not.toEqual(makeBytes(300000, 1).subarray(0, 1000));
  });

  it('does not resume without a validator (no ETag/Last-Modified): restarts from byte 0', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=300000&seed=6&dropAfter=100000&noetag=1');
    makeEngine().start();
    const j = await waitState(id, 'completed', 'failed');
    expect(j.state).toBe('completed');
    expect(await storedBytes(j.file_id)).toEqual(makeBytes(300000, 6));
    const reqs = origin.log.filter((r) => r.path === '/file');
    expect(reqs.every((r) => r.range === undefined)).toBe(true);
    expect((await events(id)).some((e) => /No validator/.test(e.message))).toBe(true);
  });

  it('verifies a matching SHA-256 and rejects a mismatch permanently without storing anything', async () => {
    const s = await user();
    const data = makeBytes(120000, 11);
    const ok = await addJob(s, '/file?size=120000&seed=11', { sha256: sha(data) });
    const bad = await addJob(s, '/file?size=120000&seed=12', { sha256: sha(data) });
    makeEngine({ DOWNLOAD_USER_CONCURRENCY: 1 }).start();
    expect((await waitState(ok, 'completed', 'failed')).state).toBe('completed');
    const b = await waitState(bad, 'completed', 'failed');
    expect(b.state).toBe('failed');
    expect(b.error_code).toBe('checksum_mismatch');
    expect(b.file_id).toBeNull();
    expect(Number(b.attempt)).toBe(1); // permanent: no retries
    expect(await used(s)).toBe(120000);
    expect(await partFiles()).toEqual([]);
    expect((await t.db.query('SELECT 1 FROM files WHERE user_id = $1', [s.userId])).rowCount).toBe(1);
  });

  it('recovers after an idle stall by timing out and resuming', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=200000&seed=13&stallAfter=50000');
    makeEngine({ DOWNLOAD_IDLE_TIMEOUT_MS: 300 }).start();
    const j = await waitState(id, 'completed', 'failed');
    expect(j.state).toBe('completed');
    expect(await storedBytes(j.file_id)).toEqual(makeBytes(200000, 13));
    expect((await events(id)).some((e) => e.kind === 'retry' && /timeout/.test(e.message))).toBe(true);
  });
});

describe('limits and failures', () => {
  it('rejects files over MAX_FILE_SIZE up front (Content-Length) and while streaming (chunked)', async () => {
    const s = await user();
    const a = await addJob(s, '/file?size=600000');           // limit is 512 KiB in the test env
    const b = await addJob(s, '/file?size=600000&chunked=1');
    makeEngine().start();
    for (const id of [a, b]) {
      const j = await waitState(id, 'failed', 'completed');
      expect(j.state).toBe('failed');
      expect(j.error_code).toBe('file_too_large');
    }
    expect(await used(s)).toBe(0);
    expect(await partFiles()).toEqual([]);
  });

  it('fails with quota_exceeded when the user has no room', async () => {
    const s = await user();
    await t.db.query('UPDATE storage_quotas SET used_bytes = quota_bytes - 1000 WHERE user_id = $1', [s.userId]);
    const id = await addJob(s, '/file?size=5000');
    makeEngine().start();
    const j = await waitState(id, 'failed', 'completed');
    expect(j.error_code).toBe('quota_exceeded');
  });

  it('treats HTTP 404/403 as permanent (one attempt) and says why', async () => {
    const s = await user();
    const a = await addJob(s, '/missing');
    const b = await addJob(s, '/file?status=403');
    makeEngine().start();
    const ja = await waitState(a, 'failed'); const jb = await waitState(b, 'failed');
    expect([ja.error_code, jb.error_code]).toEqual(['not_found', 'access_denied']);
    expect([Number(ja.attempt), Number(jb.attempt)]).toEqual([1, 1]);
    expect(origin.count('/missing')).toBe(1);
  });

  it('retries transient 5xx with backoff, then succeeds', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=50000&status=503&failTimes=2');
    makeEngine().start();
    const j = await waitState(id, 'completed', 'failed');
    expect(j.state).toBe('completed');
    expect(Number(j.attempt)).toBe(2);
    expect(origin.count('/file?size=50000&status=503&failTimes=2')).toBe(3);
    expect((await events(id)).filter((e) => e.kind === 'retry')).toHaveLength(2);
  });

  it('gives up after max attempts and keeps the job failed with the last error', async () => {
    const s = await user();
    const id = await addJob(s, '/file?status=500', { maxAttempts: 3 });
    makeEngine().start();
    const j = await waitState(id, 'failed', 'completed');
    expect(j.state).toBe('failed');
    expect(j.error_code).toBe('http_error');
    expect(Number(j.attempt)).toBe(3);
    expect(origin.count('/file?status=500')).toBe(3);
    // The job turns 'failed' a moment before its notification is written, so wait for it instead of reading in between.
    await waitFor(async () => (await t.db.query('SELECT 1 FROM notifications WHERE user_id = $1 AND kind = $2', [s.userId, 'download_failed'])).rowCount > 0, 5000, 'failure notification');
  });

  it('honours Retry-After on 429 by scheduling the retry in the future', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=1000&status=429&failTimes=1&retryAfter=2');
    makeEngine().start();
    const j = await waitState(id, 'pending');
    expect(j.error_code).toBe('rate_limited');
    const wait = (await t.db.query<{ s: number }>(`SELECT extract(epoch FROM (next_attempt_at - now()))::float AS s FROM download_jobs WHERE id = $1`, [id])).rows[0]!.s;
    expect(wait).toBeGreaterThan(1.0);
    expect(origin.count('/file?size=1000&status=429&failTimes=1&retryAfter=2')).toBe(1); // not hammered
  });
});

describe('SSRF protection inside the engine', () => {
  it('never contacts a private destination that is not allowlisted', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=1000');
    makeEngine({}, { allowedCidrs: '' }).start(); // loopback NOT allowlisted
    const j = await waitState(id, 'failed');
    expect(j.error_code).toBe('blocked_destination');
    expect(Number(j.attempt)).toBe(1);
    expect(origin.log).toHaveLength(0);
  });

  it('blocks a redirect from an allowed host into cloud-metadata space', async () => {
    const s = await user();
    const id = await addJob(s, '/redir-private');
    makeEngine().start();
    const j = await waitState(id, 'failed');
    expect(j.error_code).toBe('blocked_destination');
  });

  it('follows a safe redirect', async () => {
    const s = await user();
    const id = await addJob(s, '/redir-file?size=2000&seed=3');
    makeEngine().start();
    expect((await waitState(id, 'completed', 'failed')).state).toBe('completed');
  });
});

describe('control: pause, resume, cancel', () => {
  it('pauses a running job keeping its partial data, then resumes with a Range request', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=400000&seed=21&slow=250000');
    makeEngine().start();
    await waitFor(async () => (await job(id)).state === 'downloading' && Number((await job(id)).bytes_received) > 20000, 10000, 'some progress');
    await t.db.query(`UPDATE download_jobs SET control = 'pause' WHERE id = $1`, [id]);
    const p = await waitState(id, 'paused');
    expect(p.worker_id).toBeNull();
    expect(Number(p.bytes_received)).toBeGreaterThan(0);
    expect(await partFiles()).toEqual([`${id}.part`]);
    await new Promise((r) => setTimeout(r, 300));
    expect((await job(id)).state).toBe('paused'); // stays paused, nothing picks it up

    await t.db.query(`UPDATE download_jobs SET state = 'queued' WHERE id = $1`, [id]);
    const j = await waitState(id, 'completed', 'failed');
    expect(j.state).toBe('completed');
    expect(await storedBytes(j.file_id)).toEqual(makeBytes(400000, 21));
    expect(origin.log.filter((r) => r.path === '/file').some((r) => /^bytes=\d+-$/.test(r.range ?? ''))).toBe(true);
  });

  it('cancels a running job, discards the partial file and stores nothing', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=400000&seed=22&slow=250000');
    makeEngine().start();
    await waitFor(async () => Number((await job(id)).bytes_received) > 20000, 10000, 'some progress');
    await t.db.query(`UPDATE download_jobs SET control = 'cancel' WHERE id = $1`, [id]);
    const j = await waitState(id, 'cancelled');
    expect(j.finished_at).not.toBeNull();
    expect(await partFiles()).toEqual([]);
    expect(await used(s)).toBe(0);
    expect((await t.db.query('SELECT 1 FROM files WHERE user_id = $1', [s.userId])).rowCount).toBe(0);
  });

  it('a manual retry of a cancelled job starts clean and completes', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=100000&seed=23', { state: 'cancelled' });
    const e = makeEngine(); e.start();
    await new Promise((r) => setTimeout(r, 200));
    expect((await job(id)).state).toBe('cancelled'); // not picked up
    await t.db.query(`UPDATE download_jobs SET state = 'queued', attempt = 0 WHERE id = $1`, [id]);
    expect((await waitState(id, 'completed', 'failed')).state).toBe('completed');
  });
});

describe('queue: priority, concurrency, recovery, shutdown', () => {
  it('runs higher priority first and honours the per-user concurrency limit', async () => {
    const s = await user();
    const low = await addJob(s, '/file?size=60000&seed=1&slow=300000', { priority: 0 });
    const normal = await addJob(s, '/file?size=60000&seed=2&slow=300000', { priority: 1 });
    const high = await addJob(s, '/file?size=60000&seed=3&slow=300000', { priority: 2 });
    makeEngine({ DOWNLOAD_USER_CONCURRENCY: 1, DOWNLOAD_GLOBAL_CONCURRENCY: 5, WORKER_CONCURRENCY: 5 }).start();

    let maxActive = 0;
    await waitFor(async () => {
      const n = (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM download_jobs WHERE user_id = $1 AND state IN ('resolving','downloading','verifying')`, [s.userId])).rows[0]!.n;
      maxActive = Math.max(maxActive, n);
      return (await t.db.query(`SELECT 1 FROM download_jobs WHERE user_id = $1 AND state <> 'completed'`, [s.userId])).rowCount === 0;
    }, 20000, 'all complete');
    expect(maxActive).toBe(1);
    const order = (await t.db.query<{ id: string }>(`SELECT id FROM download_jobs WHERE user_id = $1 ORDER BY started_at`, [s.userId])).rows.map((r) => r.id);
    expect(order).toEqual([high, normal, low]);
  });

  it('honours the global concurrency limit across users', async () => {
    const users = [await user(), await user(), await user()];
    for (const u of users) await addJob(u, '/file?size=60000&slow=300000');
    makeEngine({ DOWNLOAD_GLOBAL_CONCURRENCY: 2, DOWNLOAD_USER_CONCURRENCY: 2, WORKER_CONCURRENCY: 5 }).start();
    let maxActive = 0;
    await waitFor(async () => {
      const n = (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM download_jobs WHERE state IN ('resolving','downloading','verifying')`)).rows[0]!.n;
      maxActive = Math.max(maxActive, n);
      return (await t.db.query(`SELECT 1 FROM download_jobs WHERE state <> 'completed'`)).rowCount === 0;
    }, 20000, 'all complete');
    expect(maxActive).toBe(2);
  });

  it('does not start jobs scheduled for the future (retry backoff) until due', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=1000', { state: 'pending' });
    await t.db.query(`UPDATE download_jobs SET next_attempt_at = now() + interval '1 hour' WHERE id = $1`, [id]);
    makeEngine().start();
    await new Promise((r) => setTimeout(r, 300));
    expect((await job(id)).state).toBe('pending');
    expect(origin.log).toHaveLength(0);
  });

  it('recovers a job whose worker died: expired lease -> requeued -> resumed from the partial file', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=300000&seed=31');
    const full = makeBytes(300000, 31);
    await mkdir(t.config.DOWNLOAD_WORKDIR, { recursive: true });
    await writeFile(path.join(t.config.DOWNLOAD_WORKDIR, `${id}.part`), full.subarray(0, 90000));
    await t.db.query(
      `UPDATE download_jobs SET state = 'downloading', worker_id = 'dead-worker', lease_expires_at = now() - interval '1 minute',
              etag = '"e-31-300000"', last_modified = 'Wed, 01 Jan 2025 00:00:00 GMT', bytes_received = 90000, total_bytes = 300000, started_at = now() WHERE id = $1`, [id]);
    makeEngine().start();
    const j = await waitState(id, 'completed', 'failed');
    expect(j.state).toBe('completed');
    expect(await storedBytes(j.file_id)).toEqual(full);
    expect(origin.log.find((r) => r.path === '/file')!.range).toBe('bytes=90000-'); // continued, not restarted
    expect((await events(id)).some((e) => e.kind === 'recovered')).toBe(true);
    expect(Number(j.attempt)).toBe(1);
  });

  it('a repeatedly crashing job is eventually failed instead of looping forever', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=1000', { state: 'downloading', maxAttempts: 2 });
    await t.db.query(`UPDATE download_jobs SET worker_id = 'dead', lease_expires_at = now() - interval '1 minute', attempt = 1 WHERE id = $1`, [id]);
    const n = await makeEngine().recoverStale();
    expect(n).toBe(1);
    const j = await job(id);
    expect(j.state).toBe('failed');
    expect(j.error_code).toBe('worker_lost');
  });

  it('does not recover jobs whose lease is still valid', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=1000', { state: 'downloading' });
    await t.db.query(`UPDATE download_jobs SET worker_id = 'alive', lease_expires_at = now() + interval '1 minute' WHERE id = $1`, [id]);
    expect(await makeEngine().recoverStale()).toBe(0);
    expect((await job(id)).state).toBe('downloading');
  });

  it('graceful shutdown returns the running job to the queue with its partial data, and a new worker finishes it', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=400000&seed=41&slow=250000');
    const first = makeEngine(); first.start();
    await waitFor(async () => Number((await job(id)).bytes_received) > 30000, 10000, 'some progress');
    await first.stop();
    const mid = await job(id);
    expect(mid.state).toBe('queued');
    expect(mid.worker_id).toBeNull();
    expect(await partFiles()).toEqual([`${id}.part`]);

    makeEngine().start();
    const j = await waitState(id, 'completed', 'failed');
    expect(j.state).toBe('completed');
    expect(await storedBytes(j.file_id)).toEqual(makeBytes(400000, 41));
    expect(origin.log.filter((r) => r.path === '/file').some((r) => /^bytes=\d+-$/.test(r.range ?? ''))).toBe(true);
  });

  it('a job claimed while shutdown is in progress is handed straight back and never started', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=1000');
    const e = makeEngine();
    // Hold the claim in flight so stop() is guaranteed to be called while a claim is pending.
    const real = e.claim.bind(e);
    e.claim = async () => { await new Promise((r) => setTimeout(r, 300)); return real(); };
    e.start();
    await new Promise((r) => setTimeout(r, 60));
    await e.stop();
    await new Promise((r) => setTimeout(r, 700)); // outlive the delayed claim: any late start would show up now
    const j = await job(id);
    expect(j.state).toBe('queued');
    expect(j.worker_id).toBeNull();
    expect(Number(j.attempt)).toBe(0);
    expect(origin.log).toHaveLength(0);
    expect(await partFiles()).toEqual([]);
  });

  it('abandons a job silently if its lease was taken over (no clobbering the new owner)', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=400000&seed=51&slow=250000');
    makeEngine().start();
    await waitFor(async () => Number((await job(id)).bytes_received) > 20000, 10000, 'some progress');
    await t.db.query(`UPDATE download_jobs SET worker_id = 'someone-else' WHERE id = $1`, [id]);
    await new Promise((r) => setTimeout(r, 1500));
    const j = await job(id);
    expect(j.worker_id).toBe('someone-else');
    expect(j.state).toBe('downloading');
    expect(j.file_id).toBeNull();
  });
});

describe('bandwidth limit and housekeeping', () => {
  it('throttles to the configured per-job rate', async () => {
    const s = await user();
    const id = await addJob(s, '/file?size=100000&seed=61');
    const t0 = Date.now();
    makeEngine({ DOWNLOAD_BANDWIDTH_LIMIT_BPS: 50_000 }).start();
    const j = await waitState(id, 'completed', 'failed');
    expect(j.state).toBe('completed');
    expect(Date.now() - t0).toBeGreaterThan(1500); // 100 KB at 50 KB/s
  });

  it("applies the user's own bandwidth limit when the server has none", async () => {
    const s = await user();
    await t.db.query(`INSERT INTO user_settings (user_id, download_bandwidth_bps) VALUES ($1, 50000)`, [s.userId]);
    const id = await addJob(s, '/file?size=100000&seed=62');
    const t0 = Date.now();
    makeEngine({ DOWNLOAD_BANDWIDTH_LIMIT_BPS: 0 }).start();
    expect((await waitState(id, 'completed', 'failed')).state).toBe('completed');
    expect(Date.now() - t0).toBeGreaterThan(1500);
  });

  it("never lets a user's own limit exceed the server limit", async () => {
    const s = await user();
    await t.db.query(`INSERT INTO user_settings (user_id, download_bandwidth_bps) VALUES ($1, 500000000)`, [s.userId]);
    const id = await addJob(s, '/file?size=100000&seed=63');
    const t0 = Date.now();
    makeEngine({ DOWNLOAD_BANDWIDTH_LIMIT_BPS: 50_000 }).start();
    expect((await waitState(id, 'completed', 'failed')).state).toBe('completed');
    expect(Date.now() - t0).toBeGreaterThan(1500); // still throttled by the server's 50 KB/s
  });

  it("starts no more simultaneous downloads for a user than the user's own setting allows", async () => {
    const s = await user(); const other = await user();
    await t.db.query(`INSERT INTO user_settings (user_id, download_concurrency) VALUES ($1, 1)`, [s.userId]);
    await addJob(s, '/file?size=1000&seed=1'); await addJob(s, '/file?size=1000&seed=2'); const o = await addJob(other, '/file?size=1000&seed=3');
    const e = makeEngine({ DOWNLOAD_GLOBAL_CONCURRENCY: 10, DOWNLOAD_USER_CONCURRENCY: 5 });
    const first = await e.claim();
    expect(first!.user_id).toBe(s.userId);
    const second = await e.claim(); // the user's second job must wait, so the other user's job is next
    expect(second!.id).toBe(o);
    expect(await e.claim()).toBeNull();
  });

  it('sweep removes orphaned and cancelled workspace files, keeps resumable ones, and expires old job records', async () => {
    const s = await user();
    await mkdir(t.config.DOWNLOAD_WORKDIR, { recursive: true });
    const orphan = '00000000-0000-4000-8000-000000000001';
    const cancelled = await addJob(s, '/file', { state: 'cancelled' });
    const paused = await addJob(s, '/file', { state: 'paused' });
    for (const n of [orphan, cancelled, paused]) await writeFile(path.join(t.config.DOWNLOAD_WORKDIR, `${n}.part`), 'x');
    await writeFile(path.join(t.config.DOWNLOAD_WORKDIR, 'notes.txt'), 'keep');
    const old = await addJob(s, '/file', { state: 'failed' });
    await t.db.query(`UPDATE download_jobs SET finished_at = now() - interval '30 days' WHERE id = $1`, [old]);
    const fresh = await addJob(s, '/file', { state: 'failed' });
    await t.db.query(`UPDATE download_jobs SET finished_at = now() WHERE id = $1`, [fresh]);

    await makeEngine().sweep();
    expect((await readdir(t.config.DOWNLOAD_WORKDIR)).sort()).toEqual([`${paused}.part`, 'notes.txt'].sort());
    expect((await t.db.query('SELECT 1 FROM download_jobs WHERE id = $1', [old])).rowCount).toBe(0);
    expect((await t.db.query('SELECT 1 FROM download_jobs WHERE id = $1', [fresh])).rowCount).toBe(1);
  });
});
