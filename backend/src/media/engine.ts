import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { backoffMs } from '../downloads/state.js';
import type { StorageAdapter } from '../storage/types.js';
import { deleteReplaced, storeAsset } from './assets.js';
import { MEDIA_EXTENSIONS, formatFor } from './classify.js';
import { Ffmpeg, FfmpegError, TRANSCODE_PROFILES, type MediaInput } from './ffmpeg.js';

export interface Logger {
  info(o: object, msg?: string): void;
  warn(o: object, msg?: string): void;
  error(o: object, msg?: string): void;
}

export interface MediaEngineOptions {
  db: Db;
  config: Config;
  /** Adapter used to store derived objects. */
  storage: StorageAdapter;
  adapterFor: (kind: string) => StorageAdapter | undefined;
  log: Logger;
  ffmpeg?: Ffmpeg;
  workerId?: string;
  aliveFile?: string;
}

const MAX_SUBTITLE_TRACKS = 8;
const AUDIO_EXT_RE = MEDIA_EXTENSIONS.filter((e) => formatFor(`x${e}`)?.kind === 'audio').map((e) => e.slice(1)).join('|');
const MEDIA_EXT_RE = MEDIA_EXTENSIONS.map((e) => e.slice(1)).join('|');

interface Claimed { file_id: string; user_id: string; attempt: number }
interface ClaimedRendition { id: string; file_id: string; user_id: string; variant: string }

/**
 * Indexes media files in the background: ffprobe metadata, a thumbnail, embedded text subtitles, and (when enabled)
 * transcoded copies. All FFmpeg work happens here, in the worker process, never in the API.
 */
export class MediaEngine {
  private readonly ffmpeg: Ffmpeg;
  private readonly controllers = new Set<AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private probes = 0;
  private renditions = 0;
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private ticking = false;
  private tickPromise?: Promise<void>;
  private lastRecover = 0;
  private lastDiscover = 0;
  readonly workerId: string;

  constructor(private readonly o: MediaEngineOptions) {
    this.ffmpeg = o.ffmpeg ?? new Ffmpeg(o.config);
    this.workerId = o.workerId ?? `media-${process.pid}-${randomUUID().slice(0, 8)}`;
  }

  private get db() { return this.o.db; }
  private get cfg() { return this.o.config; }

  start() {
    this.timer = setInterval(() => void this.tick(), this.cfg.WORKER_POLL_MS);
    this.timer.unref();
    void this.tick();
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const c of this.controllers) c.abort('shutdown');
    await this.tickPromise?.catch(() => undefined);
    for (const c of this.controllers) c.abort('shutdown');
    await Promise.allSettled([...this.tasks]);
  }

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
      const now = Date.now();
      if (now - this.lastRecover > 10_000) { this.lastRecover = now; await this.recover(); }
      if (now - this.lastDiscover > 30_000) { this.lastDiscover = now; await this.discover(); }
      while (!this.stopping && this.probes < this.cfg.MEDIA_CONCURRENCY) {
        const m = await this.claimProbe();
        if (!m) break;
        this.spawn(() => this.probeJob(m), () => { this.probes--; }, () => { this.probes++; });
      }
      while (!this.stopping && this.cfg.MEDIA_TRANSCODING_ENABLED && this.renditions < this.cfg.MEDIA_TRANSCODE_CONCURRENCY) {
        const r = await this.claimRendition();
        if (!r) break;
        this.spawn(() => this.renditionJob(r), () => { this.renditions--; }, () => { this.renditions++; });
      }
    } catch (err) {
      this.o.log.error({ err }, 'media tick failed');
    }
  }

  private spawn(job: () => Promise<void>, onDone: () => void, onStart: () => void) {
    onStart();
    const t: Promise<void> = job().catch((err) => this.o.log.error({ err }, 'media job crashed')).finally(() => { this.tasks.delete(t); onDone(); });
    this.tasks.add(t);
  }

  // ---------------------------------------------------------------- queue
  /** Queues media files that have no index row yet (uploads made before this feature, renames, imports). */
  async discover(): Promise<number> {
    const r = await this.db.query(
      `INSERT INTO media_metadata (file_id, user_id, kind)
       SELECT f.id, f.user_id, CASE WHEN lower(f.name) ~ '\\.(${AUDIO_EXT_RE})$' THEN 'audio' ELSE 'video' END
         FROM files f WHERE f.deleted_at IS NULL AND f.status = 'ready' AND lower(f.name) ~ '\\.(${MEDIA_EXT_RE})$'
          AND NOT EXISTS (SELECT 1 FROM media_metadata m WHERE m.file_id = f.id) LIMIT 200
       ON CONFLICT (file_id) DO NOTHING`);
    return r.rowCount;
  }

  private async claimProbe(): Promise<Claimed | null> {
    const r = await this.db.query<Claimed>(
      `UPDATE media_metadata SET status = 'processing', worker_id = $1, lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
        WHERE file_id = (SELECT m.file_id FROM media_metadata m JOIN files f ON f.id = m.file_id
                          WHERE m.status = 'pending' AND m.next_attempt_at <= now() AND f.deleted_at IS NULL AND f.status = 'ready'
                          ORDER BY m.created_at LIMIT 1 FOR UPDATE OF m SKIP LOCKED)
        RETURNING file_id, user_id, attempt`, [this.workerId, this.cfg.MEDIA_LEASE_SECONDS]);
    return r.rows[0] ?? null;
  }

  private async claimRendition(): Promise<ClaimedRendition | null> {
    const r = await this.db.query<ClaimedRendition>(
      `UPDATE media_assets SET status = 'processing', worker_id = $1, progress = 0, lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
        WHERE id = (SELECT a.id FROM media_assets a JOIN files f ON f.id = a.file_id
                     WHERE a.kind = 'rendition' AND a.status = 'queued' AND f.deleted_at IS NULL
                     ORDER BY a.created_at LIMIT 1 FOR UPDATE OF a SKIP LOCKED)
        RETURNING id, file_id, user_id, variant`, [this.workerId, this.cfg.MEDIA_LEASE_SECONDS]);
    return r.rows[0] ?? null;
  }

  /** Work whose worker disappeared: probes are retried (bounded), conversions are reported as failed. */
  async recover(): Promise<number> {
    const p = await this.db.query(
      `UPDATE media_metadata SET attempt = attempt + 1, worker_id = NULL, lease_expires_at = NULL, updated_at = now(),
              status = CASE WHEN attempt + 1 >= $1 THEN 'failed' ELSE 'pending' END,
              error_message = CASE WHEN attempt + 1 >= $1 THEN 'Processing was interrupted repeatedly' ELSE error_message END
        WHERE status = 'processing' AND lease_expires_at < now()`, [this.cfg.MEDIA_MAX_ATTEMPTS]);
    const a = await this.db.query(
      `UPDATE media_assets SET status = 'failed', worker_id = NULL, lease_expires_at = NULL, updated_at = now(),
              error_message = 'The worker stopped before the conversion finished. Start it again.'
        WHERE kind = 'rendition' AND status = 'processing' AND lease_expires_at < now()`);
    return p.rowCount + a.rowCount;
  }

  // ---------------------------------------------------------------- input
  private async inputFor(adapter: StorageAdapter, key: string): Promise<MediaInput> {
    if (adapter.localPath) return { kind: 'file', path: adapter.localPath(key) };
    if (adapter.presignedGetUrl) return { kind: 'url', url: await adapter.presignedGetUrl(key, 3600) };
    throw new FfmpegError('spawn_failed', 'This storage backend cannot provide media input');
  }

  private lease(table: 'media_metadata' | 'media_assets', idCol: string, id: string, ac: AbortController) {
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void this.db.query(`UPDATE ${table} SET lease_expires_at = now() + make_interval(secs => $3) WHERE ${idCol} = $1 AND worker_id = $2 AND status = 'processing'`,
        [id, this.workerId, this.cfg.MEDIA_LEASE_SECONDS]).then((r) => { if (r.rowCount === 0) ac.abort('lost'); }).catch(() => undefined).finally(() => { busy = false; });
    }, Math.max(1000, (this.cfg.MEDIA_LEASE_SECONDS * 1000) / 4));
    return () => clearInterval(timer);
  }

  // ---------------------------------------------------------------- probe + thumbnail + subtitles
  private async probeJob(m: Claimed) {
    const ac = new AbortController();
    this.controllers.add(ac);
    const stopLease = this.lease('media_metadata', 'file_id', m.file_id, ac);
    try {
      const f = (await this.db.query<{ name: string; size_bytes: number; storage_key: string; storage_provider_kind: string }>(
        `SELECT name, size_bytes, storage_key, storage_provider_kind FROM files WHERE id = $1 AND deleted_at IS NULL`, [m.file_id])).rows[0];
      if (!f) { await this.setPending(m.file_id, 3600); return; } // trashed meanwhile
      const fmt = formatFor(f.name);
      const adapter = this.o.adapterFor(f.storage_provider_kind);
      if (!fmt) return void await this.finish(m.file_id, 'unsupported', 'This file type is not a supported media format');
      if (!adapter) return void await this.finish(m.file_id, 'failed', `The ${f.storage_provider_kind} storage holding this file is not configured`);
      const input = await this.inputFor(adapter, f.storage_key);

      const p = await this.ffmpeg.probe(input, fmt.demuxer, ac.signal);
      if (!p.hasVideo && !p.hasAudio) return void await this.finish(m.file_id, 'unsupported', 'No audio or video stream was found in this file');
      await this.db.query(
        `UPDATE media_metadata SET kind = $2, container = $3, video_codec = $4, audio_codec = $5, duration_ms = $6, width = $7, height = $8, bitrate = $9,
                streams = $10, tags = $11, title = $12, updated_at = now() WHERE file_id = $1`,
        [m.file_id, p.hasVideo ? 'video' : 'audio', p.container, p.videoCodec, p.audioCodec, p.durationMs, p.width, p.height, p.bitrate, JSON.stringify(p.streams), JSON.stringify(p.tags), p.title]);

      if (p.hasVideo || p.hasCover) {
        try {
          const jpeg = await this.ffmpeg.thumbnail(input, fmt.demuxer, { durationMs: p.durationMs, hasVideo: p.hasVideo }, ac.signal);
          const st = await storeAsset(this.db, this.o.storage, { fileId: m.file_id, userId: m.user_id, kind: 'thumbnail', variant: '', mime: 'image/jpeg', data: jpeg, maxBytes: 2 * 1024 * 1024 });
          await deleteReplaced(st, this.o.adapterFor);
        } catch (e) { if (ac.signal.aborted) throw e; this.o.log.warn({ code: (e as FfmpegError).code ?? 'error', fileId: m.file_id }, 'thumbnail not created'); }
      }
      for (const s of p.streams.filter((x) => x.type === 'subtitle' && x.extractable).slice(0, MAX_SUBTITLE_TRACKS)) {
        try {
          const vtt = await this.ffmpeg.subtitle(input, fmt.demuxer, s.index, ac.signal);
          const st = await storeAsset(this.db, this.o.storage, { fileId: m.file_id, userId: m.user_id, kind: 'subtitle', variant: String(s.index), mime: 'text/vtt', data: Buffer.from(vtt, 'utf8'), maxBytes: 2 * 1024 * 1024 });
          await deleteReplaced(st, this.o.adapterFor);
        } catch (e) { if (ac.signal.aborted) throw e; this.o.log.warn({ code: (e as FfmpegError).code ?? 'error', fileId: m.file_id, stream: s.index }, 'subtitle track not extracted'); }
      }
      await this.db.query(
        `UPDATE media_metadata SET status = 'ready', worker_id = NULL, lease_expires_at = NULL, error_message = NULL, probed_at = now(), updated_at = now()
          WHERE file_id = $1 AND worker_id = $2`, [m.file_id, this.workerId]);
    } catch (e) {
      const reason = ac.signal.aborted ? String(ac.signal.reason) : undefined;
      if (reason === 'lost') return;
      if (reason === 'shutdown') return void await this.setPending(m.file_id, 0, false);
      if (e instanceof FfmpegError && e.code === 'invalid_data') {
        return void await this.finish(m.file_id, 'unsupported', 'This file could not be read as media (it may be corrupt or use an unsupported format)');
      }
      const code = e instanceof FfmpegError ? e.code : 'error';
      this.o.log.warn({ code, fileId: m.file_id, attempt: m.attempt + 1 }, 'media probe failed');
      const message = code === 'spawn_failed' ? 'FFmpeg is not available on the server' : code === 'timeout' ? 'Reading this file took too long' : 'Processing failed';
      if (m.attempt + 1 >= this.cfg.MEDIA_MAX_ATTEMPTS) return void await this.finish(m.file_id, 'failed', message, m.attempt + 1);
      await this.setPending(m.file_id, backoffMs(m.attempt + 1, 30_000, 1_800_000) / 1000, true, message);
    } finally {
      stopLease();
      this.controllers.delete(ac);
    }
  }

  private async finish(fileId: string, status: 'unsupported' | 'failed', message: string, attempt?: number) {
    await this.db.query(
      `UPDATE media_metadata SET status = $2, error_message = $3, attempt = COALESCE($4, attempt), worker_id = NULL, lease_expires_at = NULL, updated_at = now() WHERE file_id = $1 AND worker_id = $5`,
      [fileId, status, message, attempt ?? null, this.workerId]);
  }

  private async setPending(fileId: string, delaySeconds: number, countAttempt = false, message: string | null = null) {
    await this.db.query(
      `UPDATE media_metadata SET status = 'pending', worker_id = NULL, lease_expires_at = NULL, attempt = attempt + $4, next_attempt_at = now() + make_interval(secs => $2),
              error_message = COALESCE($3, error_message), updated_at = now() WHERE file_id = $1 AND worker_id = $5`,
      [fileId, delaySeconds, message, countAttempt ? 1 : 0, this.workerId]);
  }

  // ---------------------------------------------------------------- transcoding
  private async renditionJob(r: ClaimedRendition) {
    const ac = new AbortController();
    this.controllers.add(ac);
    const stopLease = this.lease('media_assets', 'id', r.id, ac);
    const workdir = this.cfg.MEDIA_WORKDIR;
    const out = path.join(workdir, `${r.id}.mp4`);
    const fail = (message: string) => this.db.query(
      `UPDATE media_assets SET status = 'failed', error_message = $2, worker_id = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND worker_id = $3`, [r.id, message, this.workerId]);
    try {
      const profile = TRANSCODE_PROFILES[r.variant];
      const f = (await this.db.query<{ name: string; size_bytes: number; storage_key: string; storage_provider_kind: string }>(
        `SELECT name, size_bytes, storage_key, storage_provider_kind FROM files WHERE id = $1 AND deleted_at IS NULL`, [r.file_id])).rows[0];
      const meta = (await this.db.query<{ duration_ms: number | null; kind: string }>(`SELECT duration_ms, kind FROM media_metadata WHERE file_id = $1 AND status IN ('ready','processing')`, [r.file_id])).rows[0];
      if (!profile || !f || !meta) return void await fail('The source file is no longer available');
      if (profile.kind !== meta.kind) return void await fail(`The ${profile.name} profile does not apply to ${meta.kind} files`);
      if (Number(f.size_bytes) > this.cfg.MEDIA_TRANSCODE_MAX_SOURCE_BYTES) return void await fail('The file is too large to convert');
      const fmt = formatFor(f.name)!;
      const adapter = this.o.adapterFor(f.storage_provider_kind);
      if (!adapter) return void await fail('The storage holding this file is not configured');

      const q = (await this.db.query<{ quota_bytes: number; used_bytes: number }>(`SELECT quota_bytes, used_bytes FROM storage_quotas WHERE user_id = $1`, [r.user_id])).rows[0];
      const free = Math.max(0, Number(q?.quota_bytes ?? 0) - Number(q?.used_bytes ?? 0));
      if (free < 1024 * 1024) return void await fail('Not enough free storage for the converted copy');

      await mkdir(workdir, { recursive: true });
      const input = await this.inputFor(adapter, f.storage_key);
      let last = 0;
      await this.ffmpeg.transcode(input, fmt.demuxer, profile, out, { durationMs: meta.duration_ms ? Number(meta.duration_ms) : null, maxBytes: free }, (fraction) => {
        const now = Date.now();
        if (now - last < 2000) return;
        last = now;
        void this.db.query(`UPDATE media_assets SET progress = $2, updated_at = now() WHERE id = $1 AND worker_id = $3`, [r.id, fraction, this.workerId]).catch(() => undefined);
      }, ac.signal);

      const st = await storeAsset(this.db, this.o.storage, { fileId: r.file_id, userId: r.user_id, kind: 'rendition', variant: r.variant, mime: 'video/mp4', data: createReadStream(out), maxBytes: free });
      await deleteReplaced(st, this.o.adapterFor);
    } catch (e) {
      const reason = ac.signal.aborted ? String(ac.signal.reason) : undefined;
      if (reason === 'lost') return;
      if (reason === 'shutdown') {
        return void await this.db.query(`UPDATE media_assets SET status = 'queued', worker_id = NULL, lease_expires_at = NULL, progress = 0, updated_at = now() WHERE id = $1 AND worker_id = $2`, [r.id, this.workerId]);
      }
      const code = e instanceof FfmpegError ? e.code : (e as { code?: string }).code ?? 'error';
      this.o.log.warn({ code, assetId: r.id }, 'conversion failed');
      await fail(code === 'quota_exceeded' ? 'Not enough free storage for the converted copy' : code === 'timeout' ? 'The conversion took too long' : code === 'spawn_failed' ? 'FFmpeg is not available on the server' : 'The conversion failed');
    } finally {
      stopLease();
      this.controllers.delete(ac);
      await rm(out, { force: true }).catch(() => undefined);
    }
  }
}
