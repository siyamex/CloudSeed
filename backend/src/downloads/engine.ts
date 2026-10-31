import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { OutgoingHttpHeaders } from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../errors.js';
import { deleteObjects, insertFileRecord, type ObjectRef } from '../files/ops.js';
import { StorageLimitError, type StorageAdapter } from '../storage/types.js';
import { FetchError, guardedFetch } from './http.js';
import { BlockedDestinationError, type Guard } from './ssrf.js';
import {
  ACTIVE_STATES, DownloadError, backoffMs, classifyStatus, deriveFilename, statesAllowedBefore, type JobState,
} from './state.js';

export interface Logger {
  info(o: object, msg?: string): void;
  warn(o: object, msg?: string): void;
  error(o: object, msg?: string): void;
}

export interface JobRow {
  id: string; user_id: string; url: string; folder_id: string | null; filename: string | null;
  on_conflict: 'reject' | 'rename' | 'replace'; state: JobState; priority: number; control: 'pause' | 'cancel' | null;
  bytes_received: number; total_bytes: number | null; expected_sha256: string | null; etag: string | null;
  last_modified: string | null; attempt: number; max_attempts: number;
}

export interface EngineOptions {
  db: Db;
  storage: StorageAdapter;
  /** Adapters for removing objects displaced by `replace`; defaults to the write adapter only. */
  adapterFor?: (kind: string) => StorageAdapter | undefined;
  config: Config;
  guard: Guard;
  log: Logger;
  workerId?: string;
  /** Touched on every poll so a container healthcheck can detect a wedged worker. */
  aliveFile?: string;
}

/** Thrown when this worker no longer owns the job (lease expired and it was recovered elsewhere). */
class LostLease extends Error {}

class Throttle extends Transform {
  private sent = 0;
  private readonly start = Date.now();
  constructor(private readonly bps: number) { super(); }
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void) {
    this.sent += chunk.length;
    const wait = this.start + (this.sent / this.bps) * 1000 - Date.now();
    if (wait > 0) setTimeout(() => cb(null, chunk), wait); else cb(null, chunk);
  }
}

const HEARTBEAT_MS = 500;
const ACTIVE_SQL = ACTIVE_STATES.map((s) => `'${s}'`).join(',');

async function sizeOf(p: string): Promise<number> {
  try { return (await stat(p)).size; } catch { return 0; }
}

export class DownloadEngine {
  private readonly running = new Map<string, AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;
  private stopping = false;
  private ticking = false;
  private tickPromise?: Promise<void>;
  private lastRecover = 0;
  readonly workerId: string;

  constructor(private readonly o: EngineOptions) {
    this.workerId = o.workerId ?? `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  }

  private get db() { return this.o.db; }
  private get cfg() { return this.o.config; }
  private partPath(id: string) { return path.join(this.cfg.DOWNLOAD_WORKDIR, `${id}.part`); }

  start() {
    this.timer = setInterval(() => void this.tick(), this.cfg.WORKER_POLL_MS);
    this.sweepTimer = setInterval(() => void this.sweep().catch((err) => this.o.log.error({ err }, 'sweep failed')), 3_600_000);
    this.timer.unref(); this.sweepTimer.unref();
    void this.tick();
    void this.sweep().catch((err) => this.o.log.error({ err }, 'sweep failed'));
  }

  /** Graceful shutdown: running jobs are interrupted, keep their partial data, and return to the queue. */
  async stop() {
    this.stopping = true;
    clearInterval(this.timer); clearInterval(this.sweepTimer);
    for (const ac of this.running.values()) ac.abort('shutdown');
    // A tick may be mid-claim; wait for it so it cannot start a job after we collected the running set.
    await this.tickPromise?.catch(() => undefined);
    for (const ac of this.running.values()) ac.abort('shutdown');
    await Promise.allSettled([...this.tasks]);
  }

  /** Resolves when no job is currently running in this process (test helper). */
  async idle() { while (this.tasks.size) await Promise.allSettled([...this.tasks]); }

  async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    const p = this.doTick().finally(() => { this.ticking = false; });
    this.tickPromise = p;
    await p;
  }

  private async doTick() {
    try {
      if (this.o.aliveFile) await writeFile(this.o.aliveFile, String(Date.now())).catch(() => undefined);
      if (Date.now() - this.lastRecover > 5_000) { this.lastRecover = Date.now(); await this.recoverStale(); }
      while (!this.stopping && this.running.size < this.cfg.WORKER_CONCURRENCY) {
        const job = await this.claim();
        if (!job) break;
        if (this.stopping) { // claimed while shutting down: hand it straight back, untouched
          await this.move(job.id, 'queued', { worker_id: null, lease_expires_at: null, control: null });
          break;
        }
        const t: Promise<void> = this.runJob(job).catch((err) => this.o.log.error({ err, jobId: job.id }, 'job runner crashed')).finally(() => this.tasks.delete(t));
        this.tasks.add(t);
      }
    } catch (err) {
      this.o.log.error({ err }, 'worker tick failed');
    }
  }

  // ---- queue ----

  /** Picks the highest-priority ready job, honouring global and per-user concurrency. */
  async claim(): Promise<JobRow | null> {
    return this.db.tx(async (t) => {
      await t.query('SELECT pg_advisory_xact_lock(7301)'); // serialises claimers so the limits below are exact
      const active = (await t.query<{ n: number }>(`SELECT count(*)::int AS n FROM download_jobs WHERE state IN (${ACTIVE_SQL})`)).rows[0]!.n;
      if (active >= this.cfg.DOWNLOAD_GLOBAL_CONCURRENCY) return null;
      const r = await t.query<JobRow>(
        `UPDATE download_jobs SET state = 'resolving', worker_id = $1, control = NULL, error_code = NULL, error_message = NULL,
                lease_expires_at = now() + make_interval(secs => $2), started_at = COALESCE(started_at, now()), updated_at = now()
          WHERE id = (
            SELECT j.id FROM download_jobs j
             WHERE j.state IN ('queued','pending') AND j.next_attempt_at <= now()
               AND (SELECT count(*) FROM download_jobs a WHERE a.user_id = j.user_id AND a.state IN (${ACTIVE_SQL}))
                   < LEAST($3::int, COALESCE((SELECT us.download_concurrency FROM user_settings us WHERE us.user_id = j.user_id), $3::int))
             ORDER BY j.priority DESC, j.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
        [this.workerId, this.cfg.DOWNLOAD_LEASE_SECONDS, this.cfg.DOWNLOAD_USER_CONCURRENCY]);
      const job = r.rows[0];
      if (!job) return null;
      await t.query(`INSERT INTO download_job_events (job_id, kind, message) VALUES ($1, 'state', 'resolving')`, [job.id]);
      return job;
    });
  }

  /** Requeues jobs whose worker vanished (expired lease). Counts as an attempt so a poison job cannot loop forever. */
  async recoverStale(): Promise<number> {
    const r = await this.db.query<{ id: string; state: string; user_id: string }>(
      `UPDATE download_jobs SET attempt = attempt + 1, worker_id = NULL, lease_expires_at = NULL, control = NULL, updated_at = now(),
              state = CASE WHEN attempt + 1 >= max_attempts THEN 'failed' ELSE 'queued' END,
              error_code = CASE WHEN attempt + 1 >= max_attempts THEN 'worker_lost' ELSE error_code END,
              error_message = CASE WHEN attempt + 1 >= max_attempts THEN 'The worker stopped responding repeatedly' ELSE error_message END,
              finished_at = CASE WHEN attempt + 1 >= max_attempts THEN now() ELSE finished_at END
        WHERE state IN (${ACTIVE_SQL}) AND lease_expires_at < now()
        RETURNING id, state, user_id`);
    for (const j of r.rows) {
      await this.event(j.id, 'recovered', 'Worker lease expired; job returned to the queue');
      if (j.state === 'failed') await this.notify(j.user_id, 'download_failed', 'Download failed', 'The worker stopped responding repeatedly.');
    }
    if (r.rowCount) this.o.log.warn({ recovered: r.rowCount }, 'recovered stale download jobs');
    return r.rowCount;
  }

  /** Removes finished job records past retention and workspace files that nothing can resume. */
  async sweep() {
    const days = this.cfg.DOWNLOAD_JOB_RETENTION_DAYS;
    if (days > 0) {
      await this.db.query(
        `DELETE FROM download_jobs WHERE state IN ('completed','failed','cancelled') AND finished_at < now() - make_interval(days => $1)`, [days]);
    }
    let names: string[] = [];
    try { names = await readdir(this.cfg.DOWNLOAD_WORKDIR); } catch { return; }
    const cutoff = Date.now() - this.cfg.DOWNLOAD_TMP_RETENTION_HOURS * 3_600_000;
    for (const n of names.filter((x) => /^[0-9a-f-]{36}\.part$/.test(x))) {
      const id = n.slice(0, 36);
      const row = (await this.db.query<{ state: string }>(`SELECT state FROM download_jobs WHERE id = $1`, [id])).rows[0];
      const p = path.join(this.cfg.DOWNLOAD_WORKDIR, n);
      const old = (await stat(p).catch(() => null))?.mtimeMs ?? 0;
      if (!row || row.state === 'completed' || row.state === 'cancelled' || (row.state === 'failed' && old < cutoff)) await rm(p, { force: true });
    }
  }

  // ---- state / audit helpers ----

  private async move(id: string, to: JobState, sets: Record<string, unknown> = {}, raw: Record<string, string> = {}, owner = true): Promise<boolean> {
    const cols = Object.keys(sets);
    const assigns = [`state = $2`, `updated_at = now()`, ...cols.map((c, i) => `${c} = $${i + 3}`), ...Object.entries(raw).map(([c, e]) => `${c} = ${e}`)];
    const params: unknown[] = [id, to, ...cols.map((c) => sets[c]), statesAllowedBefore(to)];
    let sql = `UPDATE download_jobs SET ${assigns.join(', ')} WHERE id = $1 AND state = ANY($${params.length}::text[])`;
    if (owner) { params.push(this.workerId); sql += ` AND worker_id = $${params.length}`; }
    return (await this.db.query(sql, params)).rowCount > 0;
  }

  private async event(jobId: string, kind: string, message: string) {
    await this.db.query(`INSERT INTO download_job_events (job_id, kind, message) VALUES ($1, $2, $3)`, [jobId, kind, message.slice(0, 500)]).catch(() => undefined);
  }

  private async notify(userId: string, kind: string, title: string, body: string) {
    await this.db.query(`INSERT INTO notifications (user_id, kind, title, body) VALUES ($1, $2, $3, $4)`, [userId, kind, title, body.slice(0, 500)]).catch(() => undefined);
  }

  // ---- execution ----

  private async runJob(job: JobRow) {
    const ac = new AbortController();
    this.running.set(job.id, ac);
    const progress = { bytes: job.bytes_received, lastBytes: job.bytes_received, lastAt: Date.now(), speed: 0 };
    let beating = false;
    const hb = setInterval(() => {
      if (beating) return;
      beating = true;
      void this.heartbeat(job.id, progress, ac).finally(() => { beating = false; });
    }, HEARTBEAT_MS);
    try {
      if (job.attempt === 0 && job.bytes_received === 0) {
        await this.notify(job.user_id, 'download_started', 'Download started', this.hostOf(job.url));
      }
      const dl = await this.download(job, ac, progress);
      await this.finalize(job, dl, ac);
    } catch (e) {
      await this.onError(job, e, ac).catch((err) => this.o.log.error({ err, jobId: job.id }, 'failed to record job outcome'));
    } finally {
      clearInterval(hb);
      this.running.delete(job.id);
    }
  }

  private hostOf(url: string) { try { return new URL(url).host; } catch { return 'unknown host'; } }

  private async heartbeat(id: string, p: { bytes: number; lastBytes: number; lastAt: number; speed: number }, ac: AbortController) {
    try {
      const now = Date.now();
      const dt = (now - p.lastAt) / 1000;
      const inst = dt > 0 ? (p.bytes - p.lastBytes) / dt : 0;
      p.speed = p.speed ? 0.6 * p.speed + 0.4 * inst : inst;
      p.lastBytes = p.bytes; p.lastAt = now;
      const r = await this.db.query<{ control: 'pause' | 'cancel' | null }>(
        `UPDATE download_jobs SET bytes_received = $2, speed_bps = $3, updated_at = now(), lease_expires_at = now() + make_interval(secs => $4)
          WHERE id = $1 AND worker_id = $5 AND state IN (${ACTIVE_SQL}) RETURNING control`,
        [id, p.bytes, Math.max(0, Math.round(p.speed)), this.cfg.DOWNLOAD_LEASE_SECONDS, this.workerId]);
      if (r.rowCount === 0) ac.abort('lost');
      else if (r.rows[0]!.control && !ac.signal.aborted) ac.abort(r.rows[0]!.control);
    } catch (err) {
      this.o.log.warn({ err, jobId: id }, 'heartbeat failed');
    }
  }

  private async sizeLimit(userId: string): Promise<{ limit: number; quotaBound: boolean }> {
    const q = (await this.db.query<{ quota_bytes: number; used_bytes: number }>(
      `SELECT quota_bytes, used_bytes FROM storage_quotas WHERE user_id = $1`, [userId])).rows[0];
    const free = Math.max(0, (q?.quota_bytes ?? 0) - (q?.used_bytes ?? 0));
    if (free <= 0) throw new DownloadError('quota_exceeded', 'Your storage quota is full', true);
    return { limit: Math.min(this.cfg.MAX_FILE_SIZE_BYTES, free), quotaBound: free < this.cfg.MAX_FILE_SIZE_BYTES };
  }

  /** The server-wide limit, lowered (never raised) by the user's own preference. 0 means unlimited. */
  private async bandwidthFor(userId: string): Promise<number> {
    const server = this.cfg.DOWNLOAD_BANDWIDTH_LIMIT_BPS;
    const r = await this.db.query<{ b: string | null }>(`SELECT download_bandwidth_bps AS b FROM user_settings WHERE user_id = $1`, [userId]);
    const own = Number(r.rows[0]?.b ?? 0);
    if (own <= 0) return server;
    return server > 0 ? Math.min(server, own) : own;
  }

  private async download(job: JobRow, ac: AbortController, progress: { bytes: number }) {
    const file = this.partPath(job.id);
    await mkdir(this.cfg.DOWNLOAD_WORKDIR, { recursive: true });
    const { limit, quotaBound } = await this.sizeLimit(job.user_id);
    const tooBig = () => new DownloadError(quotaBound ? 'quota_exceeded' : 'file_too_large',
      quotaBound ? 'Not enough free storage for this file' : 'File exceeds the maximum allowed size', true);

    const validator = job.etag && !job.etag.startsWith('W/') ? job.etag : job.last_modified; // If-Range needs a strong validator
    let offset = await sizeOf(file);
    if (offset > 0 && !validator) {
      await rm(file, { force: true }); offset = 0;
      await this.event(job.id, 'restart', 'No validator from the server; restarting from the beginning');
    }

    for (let pass = 0; ; pass++) {
      const headers: OutgoingHttpHeaders = {};
      if (offset > 0) { headers.range = `bytes=${offset}-`; headers['if-range'] = validator!; }
      const { res, url: finalUrl } = await guardedFetch(job.url, {
        guard: this.o.guard, headers, connectTimeoutMs: this.cfg.DOWNLOAD_CONNECT_TIMEOUT_MS,
        maxRedirects: this.cfg.DOWNLOAD_MAX_REDIRECTS, signal: ac.signal,
      });
      const status = res.statusCode ?? 0;

      if (status === 416 && offset > 0 && pass === 0) { // our partial no longer matches the remote object
        res.resume(); await rm(file, { force: true }); offset = 0;
        await this.event(job.id, 'restart', 'Server rejected the resume range; restarting from the beginning');
        continue;
      }
      if (status !== 200 && status !== 206) { res.resume(); throw classifyStatus(status, res.headers['retry-after'] as string | undefined); }

      let total: number | null = null;
      let append = false;
      if (status === 206) {
        const m = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(String(res.headers['content-range'] ?? ''));
        if (!m || Number(m[1]) !== offset) {
          res.resume(); await rm(file, { force: true });
          throw new DownloadError('range_mismatch', 'Server returned an unexpected byte range', false);
        }
        total = m[2] === '*' ? null : Number(m[2]);
        append = true;
      } else {
        const cl = res.headers['content-length'];
        total = cl !== undefined && Number.isFinite(Number(cl)) ? Number(cl) : null;
        if (offset > 0) await this.event(job.id, 'restart', 'Server does not support resuming; restarting from the beginning');
        offset = 0;
      }
      if (total !== null && total > limit) { res.resume(); throw tooBig(); }

      const etag = status === 206 ? job.etag : (res.headers.etag as string | undefined) ?? null;
      const lastModified = status === 206 ? job.last_modified : (res.headers['last-modified'] as string | undefined) ?? null;
      const filename = job.filename ?? deriveFilename({ disposition: res.headers['content-disposition'] as string | undefined, url: finalUrl });
      const moved = await this.move(job.id, 'downloading', {
        total_bytes: total, etag, last_modified: lastModified, filename,
        accepts_ranges: status === 206 || String(res.headers['accept-ranges'] ?? '').toLowerCase() === 'bytes',
        bytes_received: offset,
      });
      if (!moved) { res.destroy(); throw new LostLease(); }

      const base = offset;
      let received = 0;
      progress.bytes = base;
      const counter = new Transform({
        transform(chunk: Buffer, _e, cb) {
          received += chunk.length;
          progress.bytes = base + received;
          if (base + received > limit) return cb(tooBig());
          cb(null, chunk);
        },
      });
      // Stall watchdog. Unlike a socket timeout it ignores time spent paused by our own backpressure
      // (bandwidth throttle, slow disk/storage): it only fires when we are reading and nothing arrives.
      const idleMs = this.cfg.DOWNLOAD_IDLE_TIMEOUT_MS;
      let lastRead = res.socket?.bytesRead ?? 0;
      let lastChange = Date.now();
      const watchdog = setInterval(() => {
        const br = res.socket?.bytesRead ?? 0;
        if (br !== lastRead || res.isPaused() || res.readableFlowing === false) { lastRead = br; lastChange = Date.now(); return; }
        if (Date.now() - lastChange > idleMs) res.destroy(new DownloadError('timeout', 'Download stalled (no data received)', false));
      }, Math.min(1000, Math.max(50, Math.floor(idleMs / 4))));
      const bps = await this.bandwidthFor(job.user_id);
      try {
        await pipeline([res, ...(bps > 0 ? [new Throttle(bps)] : []), counter, createWriteStream(file, { flags: append ? 'a' : 'w' })] as never, { signal: ac.signal });
      } finally {
        clearInterval(watchdog);
      }

      const size = await sizeOf(file);
      if (total !== null && size !== total) {
        if (size > total) await rm(file, { force: true });
        throw new DownloadError('incomplete', `Received ${size} of ${total} bytes`, false);
      }
      return { file, size, filename };
    }
  }

  private async finalize(job: JobRow, dl: { file: string; size: number; filename: string }, ac: AbortController) {
    if (!(await this.move(job.id, 'verifying', { bytes_received: dl.size }))) throw new LostLease();
    const expected = job.expected_sha256;
    const mismatch = () => new DownloadError('checksum_mismatch', 'Downloaded file does not match the expected SHA-256', true);

    if (expected) {
      const h = createHash('sha256');
      await pipeline(createReadStream(dl.file), async function* (src) { for await (const c of src) { h.update(c as Buffer); yield c; } }, devNull(), { signal: ac.signal });
      if (h.digest('hex') !== expected) { await rm(dl.file, { force: true }); throw mismatch(); }
    }

    const { limit } = await this.sizeLimit(job.user_id);
    const fileId = randomUUID();
    const key = `${fileId.slice(0, 2)}/${fileId.slice(2, 4)}/${fileId}`;
    const rs = createReadStream(dl.file);
    const onAbort = () => rs.destroy(new Error('aborted'));
    ac.signal.addEventListener('abort', onAbort, { once: true });
    let put;
    try { put = await this.o.storage.put(key, rs, { maxBytes: limit }); }
    finally { ac.signal.removeEventListener('abort', onAbort); }
    if (expected && put.sha256 !== expected) { await this.o.storage.delete(key).catch(() => undefined); throw mismatch(); }

    const live = job.folder_id
      ? (await this.db.query(`SELECT 1 FROM folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [job.folder_id, job.user_id])).rowCount > 0 : false;
    let replaced: ObjectRef[];
    try {
      replaced = await this.db.tx(async (t) => {
        const r = await insertFileRecord(t, {
          id: fileId, userId: job.user_id, folderId: live ? job.folder_id : null, name: dl.filename, onConflict: job.on_conflict,
          size: put.size, sha256: put.sha256, key, kind: this.o.storage.kind,
        });
        const upd = await t.query(
          `UPDATE download_jobs SET state = 'completed', file_id = $2, bytes_received = $3, total_bytes = COALESCE(total_bytes, $3),
                  finished_at = now(), updated_at = now(), worker_id = NULL, lease_expires_at = NULL, control = NULL, speed_bps = 0,
                  error_code = NULL, error_message = NULL
            WHERE id = $1 AND worker_id = $4 AND state = 'verifying'`, [job.id, fileId, put.size, this.workerId]);
        if (upd.rowCount === 0) throw new LostLease();
        return r.replaced;
      });
    } catch (e) {
      await this.o.storage.delete(key).catch(() => undefined); // never leave an object without a row
      throw e;
    }
    await rm(dl.file, { force: true });
    await deleteObjects(replaced, this.o.adapterFor ?? ((k) => (k === this.o.storage.kind ? this.o.storage : undefined)), (err, k) => this.o.log.error({ err, key: k }, 'object delete failed'));
    await this.event(job.id, 'completed', `${put.size} bytes`);
    await this.notify(job.user_id, 'download_completed', 'Download completed', dl.filename);
  }

  private toError(e: unknown): DownloadError {
    if (e instanceof DownloadError) return e;
    if (e instanceof BlockedDestinationError) return new DownloadError('blocked_destination', e.message, true);
    if (e instanceof FetchError) {
      return new DownloadError(e.code, e.message, e.code === 'too_many_redirects' || e.code === 'bad_redirect');
    }
    if (e instanceof StorageLimitError) return new DownloadError('file_too_large', 'File exceeds the allowed size', true);
    if (e instanceof HttpError) {
      if (e.status === 413) return new DownloadError('quota_exceeded', e.message, true);
      if (e.status === 409) return new DownloadError('name_conflict', e.message, true);
    }
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOSPC') return new DownloadError('disk_full', 'The server is out of disk space', false);
    if (code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'UND_ERR_SOCKET') {
      return new DownloadError('network_error', `Connection error (${code})`, false);
    }
    this.o.log.error({ err: e }, 'unexpected download error');
    return new DownloadError('internal_error', 'Unexpected error while downloading', false);
  }

  private async onError(job: JobRow, e: unknown, ac: AbortController) {
    const reason = ac.signal.aborted ? String(ac.signal.reason) : undefined;
    if (e instanceof LostLease || reason === 'lost') return; // another worker owns the job now
    const release = { worker_id: null, lease_expires_at: null, control: null, speed_bps: 0 };

    if (reason === 'pause') { if (await this.move(job.id, 'paused', release)) await this.event(job.id, 'state', 'paused'); return; }
    if (reason === 'cancel') {
      await rm(this.partPath(job.id), { force: true });
      if (await this.move(job.id, 'cancelled', release, { finished_at: 'now()' })) await this.event(job.id, 'state', 'cancelled');
      return;
    }
    if (reason === 'shutdown') { await this.move(job.id, 'queued', release); await this.event(job.id, 'state', 'requeued for shutdown'); return; }

    const err = this.toError(e);
    const attempt = job.attempt + 1;
    this.o.log.warn({ jobId: job.id, host: this.hostOf(job.url), code: err.code, attempt }, 'download attempt failed');

    if (err.permanent || attempt >= job.max_attempts) {
      if (err.permanent) await rm(this.partPath(job.id), { force: true }); // exhausted retries keep the partial for a manual retry
      await this.move(job.id, 'failed', { ...release, attempt, error_code: err.code, error_message: err.message }, { finished_at: 'now()' });
      await this.event(job.id, 'error', `${err.code}: ${err.message}`);
      await this.notify(job.user_id, 'download_failed', 'Download failed', `${this.hostOf(job.url)}: ${err.message}`);
      return;
    }
    const delay = Math.max(backoffMs(attempt, this.cfg.DOWNLOAD_BACKOFF_BASE_MS, this.cfg.DOWNLOAD_BACKOFF_MAX_MS), err.retryAfterMs ?? 0);
    await this.move(job.id, 'pending', { ...release, attempt, error_code: err.code, error_message: err.message },
      { next_attempt_at: `now() + make_interval(secs => ${(delay / 1000).toFixed(3)})` });
    await this.event(job.id, 'retry', `${err.code}: ${err.message}; retry ${attempt}/${job.max_attempts - 1} in ${Math.round(delay / 1000)}s`);
  }
}

function devNull() {
  return new (class extends Transform { override _transform(_c: unknown, _e: unknown, cb: () => void) { cb(); } })();
}

