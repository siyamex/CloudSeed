import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, realpath, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../errors.js';
import { freeName, insertFileRecord } from '../files/ops.js';
import { StorageLimitError, type StorageAdapter } from '../storage/types.js';
import { torrentsEnabled } from './enabled.js';
import { checkSelection as checkSel } from './selection.js';
import { describeFiles, parseTorrentInput, peerFilter, safeSegment, safeTrackers, type ParsedTorrent, type TorrentFileInfo } from './policy.js';

// ---- the small part of WebTorrent's API that is used (the library ships no type definitions) ----
export interface WtFile { path: string; length: number; progress: number; select(): void; deselect(): void }
export interface WtTorrent {
  infoHash: string; name: string; path: string; files: WtFile[]; torrentFile?: Uint8Array; numPeers: number;
  downloadSpeed: number; uploadSpeed: number; destroyed: boolean;
  on(ev: string, fn: (...a: never[]) => void): unknown;
  once(ev: string, fn: (...a: never[]) => void): unknown;
  destroy(opts?: { destroyStore?: boolean }, cb?: () => void): void;
}
export interface WtClient {
  add(id: unknown, opts: Record<string, unknown>): WtTorrent;
  destroy(cb?: (err?: Error) => void): void;
  on(ev: string, fn: (...a: never[]) => void): unknown;
  blocked?: { contains(ip: string): boolean };
}

interface Logger { info(o: object, msg?: string): void; warn(o: object, msg?: string): void; error(o: object, msg?: string): void }

export interface TorrentEngineOptions {
  db: Db; config: Config; storage: StorageAdapter; log: Logger;
  adapterFor?: (kind: string) => StorageAdapter | undefined;
  workerId?: string; aliveFile?: string;
  /** Test hook: build the client yourself. */
  createClient?: () => Promise<WtClient>;
}

export interface TorrentRow {
  id: string; user_id: string; source: 'magnet' | 'file'; magnet: string | null; metainfo: Buffer | null; info_hash: string; name: string | null;
  state: string; folder_id: string | null; result_folder_id: string | null; files: TorrentFileInfo[]; total_bytes: number | null; selected_bytes: number | null;
  auto_start: boolean; attempt: number;
}

class TorrentFailure extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
class LostLease extends Error {}
class Interrupted extends Error { constructor(public readonly why: 'pause' | 'cancel' | 'shutdown' | 'lost') { super(why); } }

const LEASE_SECONDS = 60;
const MIN_FREE_MARGIN = 64 * 1024 * 1024;

/** Creates the real client with every network feature that could reach into a private network switched off. */
export async function createSafeClient(cfg: Config): Promise<WtClient> {
  const mod = (await import('webtorrent')) as unknown as { default: new (o: Record<string, unknown>) => WtClient };
  const client = new mod.default({
    dht: cfg.TORRENT_DHT,
    tracker: true,
    lsd: false, // local-network peer discovery would find machines on your LAN
    natUpnp: false, natPmp: false, // never reconfigure the router
    webSeeds: false, // HTTP servers named inside a torrent are attacker-chosen URLs
    utp: false, // TCP only: one less native module and protocol to trust
    torrentPort: cfg.TORRENT_PORT,
    maxConns: cfg.TORRENT_MAX_CONNS,
    uploadLimit: cfg.TORRENT_UPLOAD_LIMIT_BPS > 0 ? cfg.TORRENT_UPLOAD_LIMIT_BPS : -1,
    downloadLimit: cfg.TORRENT_DOWNLOAD_LIMIT_BPS > 0 ? cfg.TORRENT_DOWNLOAD_LIMIT_BPS : -1,
  });
  client.blocked = peerFilter(cfg.TORRENT_ALLOWED_CIDRS); // peers on private or reserved ranges are never contacted
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Destroys a torrent and waits until it has really let go of its files (matters on Windows, where open files cannot be deleted). */
async function closeTorrent(t: WtTorrent): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5000);
    try { t.destroy({ destroyStore: false }, () => { clearTimeout(timer); resolve(); }); } catch { clearTimeout(timer); resolve(); }
  });
}

export class TorrentEngine {
  private readonly running = new Map<string, AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private ticking = false;
  private lastRecover = 0;
  private wt?: Promise<WtClient>;
  readonly workerId: string;

  constructor(private readonly o: TorrentEngineOptions) {
    this.workerId = o.workerId ?? `torrent-${process.pid}-${randomUUID().slice(0, 8)}`;
  }
  private get db() { return this.o.db; }
  private get cfg() { return this.o.config; }
  readonly baseDir = () => this.cfg.TORRENT_WORKDIR || path.join(this.cfg.DOWNLOAD_WORKDIR, 'torrents');
  private dir(id: string) { return path.join(this.baseDir(), id); }

  start() {
    this.timer = setInterval(() => void this.tick(), this.cfg.WORKER_POLL_MS);
    this.timer.unref();
    void this.tick();
    void this.sweep().catch((err) => this.o.log.error({ err }, 'torrent sweep failed'));
    setInterval(() => void this.sweep().catch(() => undefined), 3_600_000).unref();
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const ac of this.running.values()) ac.abort(new Interrupted('shutdown'));
    await Promise.allSettled([...this.tasks]);
    if (this.wt) await this.wt.then((c) => new Promise<void>((r) => c.destroy(() => r()))).catch(() => undefined);
  }

  async idle() { while (this.tasks.size) await Promise.allSettled([...this.tasks]); }

  private client(): Promise<WtClient> {
    this.wt ??= (this.o.createClient ?? (() => createSafeClient(this.cfg)))().catch((err: Error) => {
      this.o.log.error({ err: err.message }, 'the BitTorrent library could not start');
      throw new TorrentFailure('client_unavailable', 'The BitTorrent library could not start on this server (a native component may be missing for this platform). Torrents are unavailable here.');
    }).then((c) => {
      c.on('error', ((err: Error) => this.o.log.error({ err: err.message }, 'torrent client error')) as never);
      return c;
    });
    this.wt.catch(() => { this.wt = undefined; }); // try again next time
    return this.wt;
  }

  async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      if (this.o.aliveFile) await writeFile(this.o.aliveFile, String(Date.now())).catch(() => undefined);
      if (Date.now() - this.lastRecover > 5_000) { this.lastRecover = Date.now(); await this.recoverStale(); }
      const on = await torrentsEnabled(this.db, this.cfg);
      while (on && !this.stopping && this.running.size < this.cfg.TORRENT_CONCURRENCY) {
        const job = await this.claim();
        if (!job) break;
        const ac = new AbortController();
        this.running.set(job.id, ac);
        const t: Promise<void> = this.run(job, ac).catch((err) => this.o.log.error({ err, jobId: job.id }, 'torrent runner crashed'))
          .finally(() => { this.running.delete(job.id); this.tasks.delete(t); });
        this.tasks.add(t);
      }
    } catch (err) { this.o.log.error({ err }, 'torrent tick failed'); }
    finally { this.ticking = false; }
  }

  // ---------------------------------------------------------------- queue
  async claim(): Promise<TorrentRow | null> {
    return this.db.tx(async (t) => {
      await t.query('SELECT pg_advisory_xact_lock(7303)'); // one claimer at a time so the concurrency limit is exact across workers
      const active = (await t.query<{ n: number }>(`SELECT count(*)::int AS n FROM torrent_jobs WHERE state IN ('metadata', 'downloading', 'importing') AND lease_expires_at > now()`)).rows[0]!.n;
      if (active >= this.cfg.TORRENT_CONCURRENCY) return null;
      const r = await t.query<TorrentRow>(
        `UPDATE torrent_jobs SET state = CASE WHEN state = 'pending' THEN 'metadata' ELSE 'downloading' END, worker_id = $1, control = NULL,
                lease_expires_at = now() + make_interval(secs => $2), started_at = COALESCE(started_at, now()), error_code = NULL, error_message = NULL, updated_at = now()
          WHERE id = (SELECT id FROM torrent_jobs WHERE state IN ('pending', 'queued') AND next_attempt_at <= now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, user_id, source, magnet, metainfo, info_hash, name, state, folder_id, result_folder_id, files, total_bytes, selected_bytes, auto_start, attempt`,
        [this.workerId, LEASE_SECONDS]);
      return r.rows[0] ?? null;
    });
  }

  /** Jobs whose worker vanished go back to the queue; a job that keeps killing its worker is failed instead of looping. */
  async recoverStale(): Promise<number> {
    const r = await this.db.query<{ id: string; user_id: string; failed: boolean }>(
      `UPDATE torrent_jobs SET attempt = attempt + 1, worker_id = NULL, lease_expires_at = NULL, updated_at = now(),
              state = CASE WHEN attempt + 1 >= $1 THEN 'failed' WHEN state = 'metadata' THEN 'pending' ELSE 'queued' END,
              error_code = CASE WHEN attempt + 1 >= $1 THEN 'worker_lost' ELSE error_code END,
              error_message = CASE WHEN attempt + 1 >= $1 THEN 'The worker stopped several times while handling this torrent.' ELSE error_message END,
              finished_at = CASE WHEN attempt + 1 >= $1 THEN now() ELSE finished_at END
        WHERE state IN ('metadata', 'downloading', 'importing') AND lease_expires_at < now()
        RETURNING id, user_id, (state = 'failed') AS failed`, [this.cfg.TORRENT_MAX_ATTEMPTS]);
    for (const j of r.rows.filter((x) => x.failed)) await this.cleanup(j.id);
    return r.rowCount;
  }

  /** Removes scratch folders that no live job owns (left by crashes, cancelled or finished jobs). */
  async sweep() {
    let names: string[];
    try { names = await readdir(this.baseDir()); } catch { return; }
    if (!names.length) return;
    const live = new Set((await this.db.query<{ id: string }>(
      `SELECT id FROM torrent_jobs WHERE state IN ('metadata', 'queued', 'downloading', 'paused', 'importing') OR (state = 'awaiting_selection' AND false)`)).rows.map((r) => r.id));
    for (const n of names) if (!live.has(n) && /^[0-9a-f-]{36}$/.test(n)) await rm(path.join(this.baseDir(), n), { recursive: true, force: true }).catch(() => undefined);
  }

  private async cleanup(id: string) { await rm(this.dir(id), { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }).catch(() => undefined); }

  // ---------------------------------------------------------------- one job
  private async run(job: TorrentRow, ac: AbortController) {
    let released = false;
    const lease = setInterval(() => {
      void this.db.query(`UPDATE torrent_jobs SET lease_expires_at = now() + make_interval(secs => $2) WHERE id = $1 AND worker_id = $3 AND state IN ('metadata', 'downloading', 'importing')`,
        [job.id, LEASE_SECONDS, this.workerId]).then((r) => { if (r.rowCount === 0 && !released) ac.abort(new Interrupted('lost')); }).catch(() => undefined);
    }, 15_000);
    lease.unref();
    try {
      if (job.state === 'metadata') await this.fetchMetadata(job, ac);
      else {
        await this.download(job, ac);
        await this.importFiles(job, ac);
      }
    } catch (e) { await this.onError(job, e, ac); }
    finally { released = true; clearInterval(lease); }
  }

  private async onError(job: TorrentRow, e: unknown, ac: AbortController) {
    const why = e instanceof Interrupted ? e.why : ac.signal.aborted && ac.signal.reason instanceof Interrupted ? ac.signal.reason.why : null;
    if (e instanceof LostLease || why === 'lost') return; // someone else owns the job now
    if (why === 'shutdown') { // keep partial data; the next worker resumes
      await this.db.query(`UPDATE torrent_jobs SET state = CASE WHEN state = 'metadata' THEN 'pending' ELSE 'queued' END, worker_id = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND worker_id = $2`, [job.id, this.workerId]);
      return;
    }
    if (why === 'pause') {
      await this.db.query(`UPDATE torrent_jobs SET state = 'paused', worker_id = NULL, lease_expires_at = NULL, control = NULL, down_bps = 0, up_bps = 0, peers = 0, updated_at = now() WHERE id = $1 AND worker_id = $2`, [job.id, this.workerId]);
      return;
    }
    if (why === 'cancel') {
      await this.db.query(`UPDATE torrent_jobs SET state = 'cancelled', worker_id = NULL, lease_expires_at = NULL, control = NULL, finished_at = now(), down_bps = 0, up_bps = 0, peers = 0, updated_at = now() WHERE id = $1 AND worker_id = $2`, [job.id, this.workerId]);
      await this.cleanup(job.id);
      return;
    }
    const f = this.toFailure(e);
    await this.db.query(
      `UPDATE torrent_jobs SET state = 'failed', error_code = $3, error_message = $4, worker_id = NULL, lease_expires_at = NULL, control = NULL, finished_at = now(),
              down_bps = 0, up_bps = 0, peers = 0, updated_at = now() WHERE id = $1 AND worker_id = $2`, [job.id, this.workerId, f.code, f.message]);
    await this.cleanup(job.id);
    await this.notify(job.user_id, 'torrent_failed', 'A torrent failed', `${job.name ?? 'A torrent'}: ${f.message}`);
  }

  private toFailure(e: unknown): TorrentFailure {
    if (e instanceof TorrentFailure) return e;
    if (e instanceof StorageLimitError) return new TorrentFailure('file_too_large', 'A file in this torrent is larger than the allowed size.');
    if (e instanceof HttpError) return new TorrentFailure(e.status === 413 ? 'quota_exceeded' : 'internal_error', e.message);
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOSPC') return new TorrentFailure('disk_full', 'The server is out of disk space.');
    this.o.log.error({ err: e }, 'unexpected torrent error');
    return new TorrentFailure('internal_error', 'Unexpected error while handling this torrent.');
  }

  private async notify(userId: string, kind: string, title: string, body: string) {
    await this.db.query(`INSERT INTO notifications (user_id, kind, title, body) VALUES ($1, $2, $3, $4)`, [userId, kind, title, body.slice(0, 500)]).catch(() => undefined);
  }

  /** The job as it stands in the database; true if it still belongs to this worker. */
  private async control(job: TorrentRow): Promise<'pause' | 'cancel' | null> {
    const r = await this.db.query<{ control: 'pause' | 'cancel' | null; worker_id: string | null }>(`SELECT control, worker_id FROM torrent_jobs WHERE id = $1`, [job.id]);
    if (!r.rows[0] || r.rows[0].worker_id !== this.workerId) throw new LostLease();
    return r.rows[0].control;
  }

  /** A torrent object for this job, with the safety rules applied. Everything the torrent file asks for beyond data is filtered here. */
  private async open(parsed: ParsedTorrent, dir: string, ac: AbortController): Promise<WtTorrent> {
    const { kept, dropped } = await safeTrackers(parsed.announce, this.cfg.TORRENT_ALLOWED_CIDRS);
    if (dropped.length) this.o.log.info({ dropped: dropped.length, kept: kept.length }, 'torrent trackers filtered');
    const client = await this.client();
    await mkdir(dir, { recursive: true });
    // the tracker list lives ONLY in the parsed object (WebTorrent would add anything passed in opts on top of it); web seeds are emptied
    const t = client.add({ ...parsed, announce: kept, urlList: [] }, { path: dir, deselect: true, announce: [], urlList: [] });
    t.on('error', ((err: Error) => { this.o.log.warn({ err: err.message }, 'torrent error'); }) as never);
    ac.signal.addEventListener('abort', () => { void closeTorrent(t); }, { once: true });
    return t;
  }

  // ---------------------------------------------------------------- 1. metadata (magnet links)
  private async fetchMetadata(job: TorrentRow, ac: AbortController) {
    const parsed = await parseTorrentInput(job.magnet!).catch((e) => { throw new TorrentFailure('invalid_magnet', (e as Error).message); });
    const dir = this.dir(job.id);
    const t = await this.open(parsed, dir, ac);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new TorrentFailure('metadata_timeout', 'No peers could be found for this magnet link, so its file list could not be read. It may be dead, or this server cannot reach the swarm.')), this.cfg.TORRENT_METADATA_TIMEOUT_MS);
        const stop = (err: unknown) => { clearTimeout(timer); reject(err); };
        t.once('ready', (() => { clearTimeout(timer); resolve(); }) as never);
        t.once('error', ((err: Error) => stop(new TorrentFailure('torrent_error', err.message))) as never);
        ac.signal.addEventListener('abort', () => stop(ac.signal.reason instanceof Interrupted ? ac.signal.reason : new Interrupted('shutdown')), { once: true });
        const poll = setInterval(() => { this.control(job).then((c) => { if (c) { clearInterval(poll); stop(new Interrupted(c)); } }).catch((e) => { clearInterval(poll); stop(e); }); }, 2000);
        poll.unref();
        ac.signal.addEventListener('abort', () => clearInterval(poll), { once: true });
        timer.unref?.();
      });
      const metainfo = t.torrentFile ? Buffer.from(t.torrentFile) : null;
      const files = describeFiles(t.files.map((f) => ({ path: f.path, length: f.length })));
      await this.storeMetadata(job, t.name, files, metainfo);
    } finally {
      await closeTorrent(t);
      await this.cleanup(job.id);
    }
  }

  /** Saves the file list and moves the job to "choose files", or straight on to the queue when the user asked for everything. */
  private async storeMetadata(job: TorrentRow, name: string, files: TorrentFileInfo[], metainfo: Buffer | null) {
    const total = files.reduce((n, f) => n + f.size, 0);
    if (files.length > this.cfg.TORRENT_MAX_FILES) throw new TorrentFailure('too_many_files', `This torrent has ${files.length} files; the limit is ${this.cfg.TORRENT_MAX_FILES}.`);
    if (files.length === 0 || total === 0) throw new TorrentFailure('empty_torrent', 'This torrent contains no data.');
    const verdict = await this.checkSelection(job.user_id, files);
    const go = job.auto_start && verdict === null;
    const r = await this.db.query(
      `UPDATE torrent_jobs SET name = $3, files = $4, metainfo = COALESCE($5, metainfo), total_bytes = $6, selected_bytes = $6,
              state = $7, worker_id = NULL, lease_expires_at = NULL, updated_at = now(),
              error_code = $8, error_message = $9
        WHERE id = $1 AND worker_id = $2`,
      [job.id, this.workerId, safeSegment(name), JSON.stringify(files), metainfo, total, go ? 'queued' : 'awaiting_selection',
        job.auto_start && verdict ? verdict.code : null, job.auto_start && verdict ? verdict.message : null]);
    if (r.rowCount === 0) throw new LostLease();
    if (!go) await this.notify(job.user_id, 'torrent_ready', 'Choose what to download', `"${name}" is ready: ${files.length} file(s), ${total} bytes.`);
  }

  /** null when the selection can be downloaded, otherwise why not. */
  checkSelection(userId: string, files: TorrentFileInfo[]) { return checkSel(this.db, this.cfg, userId, files); }

  // ---------------------------------------------------------------- 2. download
  private async download(job: TorrentRow, ac: AbortController) {
    if (!job.metainfo) throw new TorrentFailure('no_metadata', 'The torrent file is missing; add the torrent again.');
    const parsed = await parseTorrentInput(job.metainfo).catch(() => { throw new TorrentFailure('invalid_torrent', 'The saved torrent file is unreadable; add it again.'); });
    if (job.magnet) { // the magnet link's own trackers and peer hints are not inside the saved .torrent; keep them (they are filtered like any others)
      const m = await parseTorrentInput(job.magnet).catch(() => null);
      if (m) { parsed.peerAddresses = m.peerAddresses; parsed.announce = [...new Set([...(parsed.announce ?? []), ...(m.announce ?? [])])]; }
    }
    const chosen = new Set(job.files.filter((f) => f.selected).map((f) => f.i));
    const wantBytes = job.files.filter((f) => f.selected).reduce((n, f) => n + f.size, 0);
    const verdict = await this.checkSelection(job.user_id, job.files);
    if (verdict) throw new TorrentFailure(verdict.code, verdict.message);

    const dir = this.dir(job.id);
    await mkdir(dir, { recursive: true });
    const free = Number((await statfs(dir)).bavail) * Number((await statfs(dir)).bsize);
    if (free < wantBytes + MIN_FREE_MARGIN) throw new TorrentFailure('disk_full', 'The server does not have enough free disk space for this download.');

    const t = await this.open(parsed, dir, ac);
    try {
      await new Promise<void>((resolve, reject) => {
        t.once('ready', (() => {
          // Everything starts deselected (the `deselect` option). Only select; calling deselect() on a neighbour would also drop the piece
          // it shares with a selected file, and that file could never finish.
          t.files.forEach((f, i) => { if (chosen.has(i)) f.select(); });
          resolve();
        }) as never);
        t.once('error', ((err: Error) => reject(new TorrentFailure('torrent_error', err.message))) as never);
        ac.signal.addEventListener('abort', () => reject(ac.signal.reason instanceof Interrupted ? ac.signal.reason : new Interrupted('shutdown')), { once: true });
      });
      const mine = t.files.filter((_, i) => chosen.has(i));
      let lastBytes = -1, lastChange = Date.now();
      let reportedAt = 0;
      for (;;) {
        if (ac.signal.aborted) throw ac.signal.reason instanceof Interrupted ? ac.signal.reason : new Interrupted('shutdown');
        const done = mine.reduce((n, f) => n + Math.min(f.length, Math.round(f.progress * f.length)), 0);
        const finished = mine.every((f) => f.progress >= 1);
        if (done !== lastBytes) { lastBytes = done; lastChange = Date.now(); }
        if (Date.now() - reportedAt > 1500 || finished) {
          reportedAt = Date.now();
          const c = await this.control(job);
          if (c) throw new Interrupted(c);
          const r = await this.db.query(
            `UPDATE torrent_jobs SET bytes_done = $2, peers = $3, down_bps = $4, up_bps = $5, selected_bytes = $6, lease_expires_at = now() + make_interval(secs => $7), updated_at = now()
              WHERE id = $1 AND worker_id = $8`, [job.id, done, t.numPeers, Math.round(t.downloadSpeed), Math.round(t.uploadSpeed), wantBytes, LEASE_SECONDS, this.workerId]);
          if (r.rowCount === 0) throw new LostLease();
        }
        if (finished) break;
        if (Date.now() - lastChange > this.cfg.TORRENT_STALL_MINUTES * 60_000) {
          throw new TorrentFailure('stalled', `No data arrived for ${this.cfg.TORRENT_STALL_MINUTES} minutes (${t.numPeers} peer(s) connected). The torrent may have no seeders.`);
        }
        await sleep(250);
      }
      await this.db.query(`UPDATE torrent_jobs SET state = 'importing', peers = 0, down_bps = 0, up_bps = 0, bytes_done = $2, updated_at = now() WHERE id = $1 AND worker_id = $3`, [job.id, wantBytes, this.workerId]);
    } finally {
      await closeTorrent(t); // we do not keep seeding: the data is about to be imported
    }
  }

  // ---------------------------------------------------------------- 3. import into the user's storage
  private async ensureFolder(userId: string, parentId: string | null, name: string, reuse: boolean): Promise<string> {
    if (reuse) {
      const f = await this.db.query<{ id: string }>(
        `SELECT id FROM folders WHERE user_id = $1 AND deleted_at IS NULL AND COALESCE(parent_id, '00000000-0000-0000-0000-000000000000') = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000') AND lower(name) = lower($3)`,
        [userId, parentId, name]);
      if (f.rows[0]) return f.rows[0].id;
    }
    return this.db.tx(async (t) => {
      const free = await freeName(t, userId, parentId, name, 'folders');
      return (await t.query<{ id: string }>(`INSERT INTO folders (user_id, parent_id, name) VALUES ($1, $2, $3) RETURNING id`, [userId, parentId, free])).rows[0]!.id;
    });
  }

  private async importFiles(job: TorrentRow, ac: AbortController) {
    const fresh = (await this.db.query<TorrentRow>(`SELECT id, user_id, files, name, folder_id, result_folder_id, info_hash FROM torrent_jobs WHERE id = $1 AND worker_id = $2`, [job.id, this.workerId])).rows[0];
    if (!fresh) throw new LostLease();
    const selected = fresh.files.filter((f) => f.selected && !f.imported);
    const dir = this.dir(job.id);
    const root = await realpath(dir);
    const single = fresh.files.filter((f) => f.selected).length === 1 && !fresh.files.find((f) => f.selected)!.path.includes('/');
    // the folder that holds the results: a single loose file goes straight to the chosen folder
    let top: string | null = fresh.folder_id;
    if (!single) {
      top = fresh.result_folder_id ?? await this.ensureFolder(job.user_id, fresh.folder_id, safeSegment(fresh.name ?? 'Torrent'), false);
      await this.db.query(`UPDATE torrent_jobs SET result_folder_id = $2 WHERE id = $1`, [job.id, top]);
    }
    const cache = new Map<string, string | null>([['', top]]);
    const folderFor = async (segments: string[]): Promise<string | null> => {
      let key = '';
      let parent = top;
      for (const seg of segments) {
        key += `/${seg}`;
        if (!cache.has(key)) cache.set(key, await this.ensureFolder(job.user_id, parent, seg, true));
        parent = cache.get(key)!;
      }
      return parent;
    };
    const adapter = this.o.storage;
    const meta = (await this.db.query<{ metainfo: Buffer }>(`SELECT metainfo FROM torrent_jobs WHERE id = $1`, [job.id])).rows[0]?.metainfo;
    const parsedFiles = meta ? (await parseTorrentInput(meta)).files ?? [] : [];

    for (const f of selected) {
      if (ac.signal.aborted) throw ac.signal.reason instanceof Interrupted ? ac.signal.reason : new Interrupted('shutdown');
      const c = await this.control(job);
      if (c === 'cancel') throw new Interrupted('cancel');
      const segs = f.path.split('/');
      const name = segs.pop()!;
      // For a multi-file torrent the first segment is the torrent's own name, which is the result folder already.
      const inner = single ? [] : segs.slice(1);
      const own = parsedFiles[f.i];
      if (!own) throw new TorrentFailure('file_missing', 'The torrent file list changed unexpectedly.');
      // WebTorrent wrote the file at its own (library-normalised) path; the realpath check below is the real guard
      const src = path.join(dir, ...own.path.split(/[\/]+/).filter((x) => x !== '' && x !== '.' && x !== '..'));
      let real: string;
      try { real = await realpath(src); } catch { throw new TorrentFailure('file_missing', `"${f.path}" was not found after downloading.`); }
      if (!real.startsWith(root + path.sep)) throw new TorrentFailure('unsafe_path', 'The torrent tried to place a file outside its download folder.');
      const size = (await stat(real)).size;
      if (size !== f.size) throw new TorrentFailure('size_mismatch', `"${f.path}" has the wrong size after downloading.`);

      const folderId = await folderFor(inner);
      const fileId = randomUUID();
      const key = `${fileId.slice(0, 2)}/${fileId.slice(2, 4)}/${fileId}`;
      const quota = (await this.db.query<{ quota_bytes: number; used_bytes: number }>(`SELECT quota_bytes, used_bytes FROM storage_quotas WHERE user_id = $1`, [job.user_id])).rows[0];
      const limit = Math.min(this.cfg.MAX_FILE_SIZE_BYTES, Math.max(0, Number(quota?.quota_bytes ?? 0) - Number(quota?.used_bytes ?? 0)));
      const put = await adapter.put(key, createReadStream(real), { maxBytes: limit });
      try {
        await this.db.tx(async (t) => {
          await insertFileRecord(t, { id: fileId, userId: job.user_id, folderId, name, onConflict: 'rename', size: put.size, sha256: put.sha256, key, kind: adapter.kind });
          const upd = await t.query(
            `UPDATE torrent_jobs SET files = jsonb_set(files, ARRAY[$2::text, 'imported'], 'true'::jsonb), imported_files = imported_files + 1, updated_at = now() WHERE id = $1 AND worker_id = $3`,
            [job.id, String(f.i), this.workerId]);
          if (upd.rowCount === 0) throw new LostLease();
        });
      } catch (e) { await adapter.delete(key).catch(() => undefined); throw e; }
      await rm(real, { force: true }); // free scratch space as we go
    }

    const done = await this.db.query(
      `UPDATE torrent_jobs SET state = 'completed', finished_at = now(), worker_id = NULL, lease_expires_at = NULL, control = NULL, updated_at = now(), error_code = NULL, error_message = NULL
        WHERE id = $1 AND worker_id = $2 AND state = 'importing'`, [job.id, this.workerId]);
    if (done.rowCount === 0) throw new LostLease();
    await this.cleanup(job.id);
    await this.notify(job.user_id, 'torrent_completed', 'Torrent finished', `${fresh.name ?? 'A torrent'} is in your files.`);
  }
}
