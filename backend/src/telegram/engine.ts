import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Config } from '../config.js';
import type { Vault } from '../crypto.js';
import type { Db } from '../db/index.js';
import { backoffMs } from '../downloads/state.js';
import type { StorageAdapter } from '../storage/types.js';
import {
  TelegramApiError, TelegramNetworkError, TelegramSourceError, sendMessage, upload,
  type TgMessage, type UploadPart,
} from './client.js';
import type { SendAs } from './plan.js';
import { recomputeTransfer } from './state.js';

export interface Logger {
  info(o: object, msg?: string): void;
  warn(o: object, msg?: string): void;
  error(o: object, msg?: string): void;
}

export interface UnitRow {
  id: string; transfer_id: string; user_id: string; position: number; file_id: string | null; name: string; size_bytes: number;
  mime_type: string; part_offset: number; part_index: number | null; send_as: SendAs; album_key: string | null; caption: string | null; share_id: string | null;
  attempt: number;
}

export interface TelegramEngineOptions {
  db: Db;
  vault: Vault;
  config: Config;
  adapterFor: (kind: string) => StorageAdapter | undefined;
  log: Logger;
  workerId?: string;
  aliveFile?: string;
}

const HEARTBEAT_MS = 500;

export const botAad = (userId: string, tgBotId: number | string) => `telegram-bot:${userId}:${tgBotId}`;

interface Running { ac: AbortController; bodySent: boolean }

/**
 * Sends queued files to Telegram. Safety rule: a request whose body was fully handed to Telegram and whose
 * outcome is unknown is NEVER retried automatically (Telegram has no idempotency keys, so a retry could
 * post a duplicate). It is marked `ambiguous` and waits for an explicit, confirmed resend.
 */
export class TelegramEngine {
  private readonly running = new Map<string, Running>();
  private readonly tasks = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private ticking = false;
  private tickPromise?: Promise<void>;
  private lastRecover = 0;
  readonly workerId: string;

  constructor(private readonly o: TelegramEngineOptions) {
    this.workerId = o.workerId ?? `tg-${process.pid}-${randomUUID().slice(0, 8)}`;
  }

  private get db() { return this.o.db; }
  private get cfg() { return this.o.config; }

  start() {
    this.timer = setInterval(() => void this.tick(), this.cfg.WORKER_POLL_MS);
    this.timer.unref();
    void this.tick();
  }

  /** Uploads whose body is still being written are aborted and requeued; ones already fully sent are awaited. */
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    const abortUnsent = () => { for (const r of this.running.values()) if (!r.bodySent) r.ac.abort('shutdown'); };
    abortUnsent();
    await this.tickPromise?.catch(() => undefined);
    abortUnsent();
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
      if (Date.now() - this.lastRecover > 5_000) { this.lastRecover = Date.now(); await this.recoverStale(); }
      while (!this.stopping && this.running.size < this.cfg.TELEGRAM_CONCURRENCY) {
        const unit = await this.claim();
        if (!unit) break;
        if (this.stopping) { await this.release(unit); break; }
        const id = unit[0]!.id;
        const t: Promise<void> = this.runUnit(unit).catch((err) => this.o.log.error({ err, unit: id }, 'telegram unit crashed')).finally(() => this.tasks.delete(t));
        this.tasks.add(t);
      }
    } catch (err) {
      this.o.log.error({ err }, 'telegram tick failed');
    }
  }

  // ---- queue ----

  /**
   * Claims the next sendable unit: one file, or all files of one album. Per chat, units go strictly one at a time
   * (flood-limit pacing via next_send_at), in transfer order, and nothing is sent through an inactive bot.
   */
  async claim(): Promise<UnitRow[] | null> {
    return this.db.tx(async (t) => {
      await t.query('SELECT pg_advisory_xact_lock(7302)');
      const head = (await t.query<UnitRow>(
        `SELECT f.* FROM telegram_transfer_files f
           JOIN telegram_transfers tr ON tr.id = f.transfer_id
           JOIN telegram_bots b ON b.id = tr.bot_id AND b.status = 'active'
           JOIN telegram_destinations d ON d.id = tr.destination_id
          WHERE f.state = 'queued' AND f.next_attempt_at <= now() AND d.next_send_at <= now()
            AND (b.blocked_until IS NULL OR b.blocked_until <= now())
            AND NOT EXISTS (SELECT 1 FROM telegram_transfer_files x JOIN telegram_transfers xt ON xt.id = x.transfer_id
                             WHERE xt.destination_id = tr.destination_id AND x.state = 'uploading')
            AND NOT EXISTS (SELECT 1 FROM telegram_transfer_files e WHERE e.transfer_id = f.transfer_id AND e.position < f.position
                             AND e.state IN ('queued','uploading'))
          ORDER BY tr.created_at, f.position LIMIT 1 FOR UPDATE OF f SKIP LOCKED`)).rows[0];
      if (!head) return null;
      const rows = (await t.query<UnitRow>(
        head.album_key
          ? `SELECT * FROM telegram_transfer_files WHERE album_key = $1 AND state = 'queued' ORDER BY position`
          : `SELECT * FROM telegram_transfer_files WHERE id = $1`, [head.album_key ?? head.id])).rows;
      await t.query(
        `UPDATE telegram_transfer_files SET state = 'uploading', worker_id = $2, bytes_sent = 0, ambiguous = FALSE,
                lease_expires_at = now() + make_interval(secs => $3), updated_at = now()
          WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id), this.workerId, this.cfg.TELEGRAM_LEASE_SECONDS]);
      await t.query(`UPDATE telegram_transfers SET state = 'uploading', updated_at = now() WHERE id = $1 AND state IN ('queued','partial','failed')`, [head.transfer_id]);
      // Hold the chat while this unit is in flight: nothing else may start there until the unit ends and sets the real
      // pacing time (otherwise there is a window after a send in which the next file would go out immediately).
      await t.query(`UPDATE telegram_destinations SET next_send_at = now() + make_interval(secs => $2)
                      WHERE id = (SELECT destination_id FROM telegram_transfers WHERE id = $1)`, [head.transfer_id, this.cfg.TELEGRAM_LEASE_SECONDS]);
      return rows;
    });
  }

  /** A unit claimed while shutting down goes straight back, untouched. */
  private async release(unit: UnitRow[]) {
    await this.db.query(
      `UPDATE telegram_transfer_files SET state = 'queued', worker_id = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = ANY($1::uuid[]) AND worker_id = $2 AND state = 'uploading'`, [unit.map((r) => r.id), this.workerId]);
    await this.setPacing(unit[0]!.transfer_id, 0);
    await this.recompute(unit[0]!.transfer_id);
  }

  /**
   * An expired lease means a worker died mid-upload. We cannot know whether Telegram received the message, so the
   * files are failed as ambiguous rather than blindly re-sent.
   */
  async recoverStale(): Promise<number> {
    const r = await this.db.query<{ id: string; transfer_id: string }>(
      `UPDATE telegram_transfer_files SET state = 'failed', ambiguous = TRUE, worker_id = NULL, lease_expires_at = NULL,
              error_code = 'delivery_unknown', updated_at = now(),
              error_message = 'The worker stopped during the upload, so it is unknown whether Telegram received this file. Check the chat before sending it again.'
        WHERE state = 'uploading' AND lease_expires_at < now() RETURNING id, transfer_id`);
    for (const id of new Set(r.rows.map((x) => x.transfer_id))) { await this.setPacing(id, 0); await this.recompute(id); }
    if (r.rowCount) this.o.log.warn({ files: r.rowCount }, 'telegram uploads with an expired lease marked as delivery_unknown');
    return r.rowCount;
  }

  // ---- state helpers ----

  private recompute(transferId: string) { return recomputeTransfer(this.db, transferId); }

  /** Sets the earliest time the next message may go to this transfer's chat (replaces any hold). */
  private async setPacing(transferId: string, ms: number) {
    await this.db.query(`UPDATE telegram_destinations SET next_send_at = now() + make_interval(secs => $2)
                          WHERE id = (SELECT destination_id FROM telegram_transfers WHERE id = $1)`, [transferId, ms / 1000]).catch(() => undefined);
  }

  private async notify(userId: string, kind: string, title: string, body: string) {
    await this.db.query(`INSERT INTO notifications (user_id, kind, title, body) VALUES ($1, $2, $3, $4)`, [userId, kind, title, body.slice(0, 500)]).catch(() => undefined);
  }

  // ---- execution ----

  private async runUnit(unit: UnitRow[]) {
    const ids = unit.map((u) => u.id);
    const transferId = unit[0]!.transfer_id;
    const state: Running = { ac: new AbortController(), bodySent: false };
    const key = ids[0]!;
    this.running.set(key, state);
    const sent = unit.map(() => 0);
    let beating = false;
    const hb = setInterval(() => {
      if (beating) return;
      beating = true;
      void this.heartbeat(ids, sent, state.ac).finally(() => { beating = false; });
    }, HEARTBEAT_MS);
    let paceMs = this.cfg.TELEGRAM_CHAT_INTERVAL_MS * unit.length;
    let answeredAt = Date.now();
    try {
      const ctx = await this.context(unit);
      if (unit.length === 1 && unit[0]!.send_as === 'link') {
        // Not an upload: a text message with a download link (the file stays on CloudSeed).
        const m = await sendMessage({ base: this.cfg.TELEGRAM_API_BASE, token: ctx.token }, ctx.chatId, unit[0]!.caption ?? '');
        answeredAt = Date.now();
        await this.markSent(unit, [m], ctx.destinationId);
      } else {
      const parts: UploadPart[] = unit.map((u, i) => ({
        field: unit.length > 1 ? `file${i}` : u.send_as,
        filename: u.name,
        contentType: u.mime_type || 'application/octet-stream',
        size: Number(u.size_bytes),
        open: async () => {
          const f = ctx.sources[i]!;
          const whole = Number(u.part_offset) === 0 && Number(u.size_bytes) === f.size;
          return whole ? f.adapter.get(f.key) : f.adapter.get(f.key, { start: Number(u.part_offset), end: Number(u.part_offset) + Number(u.size_bytes) - 1 });
        },
      }));

      let method: string;
      const fields: Record<string, string> = { chat_id: String(ctx.chatId) };
      if (unit.length > 1) {
        method = 'sendMediaGroup';
        fields.media = JSON.stringify(unit.map((u, i) => ({
          type: u.send_as, media: `attach://file${i}`,
          ...(u.caption ? { caption: u.caption } : {}),
        })));
      } else {
        const u = unit[0]!;
        method = ({ document: 'sendDocument', photo: 'sendPhoto', video: 'sendVideo', audio: 'sendAudio' } as Record<string, string>)[u.send_as]!;
        if (u.caption) fields.caption = u.caption;
        if (u.send_as === 'video') fields.supports_streaming = 'true';
      }

      // Indexed media: send its dimensions/duration/tags and a thumbnail so Telegram previews it properly.
      const media = ctx.media;
      const withMeta = (f: Record<string, string>): Record<string, string> => {
        if (!media) return f;
        const out = { ...f };
        if (media.durationS) out.duration = String(media.durationS);
        if (unit[0]!.send_as === 'video') { if (media.width) out.width = String(media.width); if (media.height) out.height = String(media.height); }
        if (unit[0]!.send_as === 'audio') { if (media.title) out.title = media.title; if (media.artist) out.performer = media.artist; }
        return out;
      };
      const attempt = (useThumb: boolean) => upload<TgMessage | TgMessage[]>({
        base: this.cfg.TELEGRAM_API_BASE, token: ctx.token, method,
        fields: useThumb && media?.thumb ? { ...withMeta(fields), thumbnail: 'attach://thumb' } : withMeta(fields),
        parts: useThumb && media?.thumb ? [...parts, media.thumb] : parts,
        connectTimeoutMs: this.cfg.TELEGRAM_CONNECT_TIMEOUT_MS, idleTimeoutMs: this.cfg.TELEGRAM_IDLE_TIMEOUT_MS,
        responseTimeoutMs: this.cfg.TELEGRAM_RESPONSE_TIMEOUT_MS, signal: state.ac.signal,
        onProgress: (i, n) => { if (i < sent.length) sent[i] = n; },
        onBodySent: () => { state.bodySent = true; },
      });
      let result: TgMessage | TgMessage[];
      try { result = await attempt(true); }
      catch (e) {
        // A 400 about the thumbnail means Telegram refused the request before doing anything, so sending again without
        // it cannot duplicate. (Any other failure takes the normal path.)
        if (media?.thumb && e instanceof TelegramApiError && e.status === 400 && /thumb/i.test(e.description)) result = await attempt(false);
        else throw e;
      }
      answeredAt = Date.now();
      const msgs = Array.isArray(result) ? result : [result];
      if (msgs.length !== unit.length) throw new TelegramApiError(200, `Telegram returned ${msgs.length} messages for ${unit.length} files`);
      await this.markSent(unit, msgs, ctx.destinationId);
      }
    } catch (e) {
      answeredAt = Date.now();
      paceMs = await this.onError(unit, e, state, paceMs);
    } finally {
      clearInterval(hb);
      this.running.delete(key);
    }
    // Always release the hold set at claim time; the interval counts from the moment Telegram answered.
    await this.setPacing(transferId, Math.max(0, paceMs - (Date.now() - answeredAt)));
    await this.recompute(transferId);
  }

  private async heartbeat(ids: string[], sent: number[], ac: AbortController) {
    try {
      const r = await this.db.query(
        `UPDATE telegram_transfer_files f SET bytes_sent = v.b, lease_expires_at = now() + make_interval(secs => $4), updated_at = now()
           FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::bigint[]) AS b) v
          WHERE f.id = v.id AND f.worker_id = $3 AND f.state = 'uploading'`, [ids, sent, this.workerId, this.cfg.TELEGRAM_LEASE_SECONDS]);
      if (r.rowCount < ids.length) ac.abort('lost');
    } catch (err) {
      this.o.log.warn({ err }, 'telegram heartbeat failed');
    }
  }

  /** Loads and validates everything needed to send; throws UnitFailure for permanent problems. */
  private async context(unit: UnitRow[]) {
    const tr = (await this.db.query<{ bot_id: string; destination_id: string; chat_id: number; user_id: string }>(
      `SELECT tr.bot_id, tr.destination_id, d.chat_id, tr.user_id FROM telegram_transfers tr
         JOIN telegram_destinations d ON d.id = tr.destination_id WHERE tr.id = $1`, [unit[0]!.transfer_id])).rows[0];
    if (!tr) throw new UnitFailure('destination_removed', 'The destination was removed');
    const bot = (await this.db.query<{ tg_bot_id: number; token_enc: Buffer | null; status: string }>(
      `SELECT tg_bot_id, token_enc, status FROM telegram_bots WHERE id = $1`, [tr.bot_id])).rows[0];
    if (!bot || !bot.token_enc || bot.status !== 'active') throw new UnitFailure('bot_unavailable', 'The bot is not connected', false, true);
    let token: string;
    try { token = this.o.vault.decrypt(bot.token_enc, botAad(tr.user_id, bot.tg_bot_id)); }
    catch { throw new UnitFailure('token_unreadable', 'The stored bot token cannot be decrypted (was ENCRYPTION_KEY changed?). Reconnect the bot.'); }

    const sources: { adapter: StorageAdapter; key: string; size: number }[] = [];
    for (const u of unit) {
      const f = u.file_id ? (await this.db.query<{ size_bytes: number; storage_key: string; storage_provider_kind: string; deleted_at: string | null }>(
        `SELECT size_bytes, storage_key, storage_provider_kind, deleted_at FROM files WHERE id = $1 AND user_id = $2`, [u.file_id, u.user_id])).rows[0] : undefined;
      if (!f || f.deleted_at) throw new UnitFailure('source_missing', `"${u.name}" was deleted or moved to the trash before it could be sent`);
      const adapter = this.o.adapterFor(f.storage_provider_kind);
      if (!adapter) throw new UnitFailure('storage_unavailable', `The ${f.storage_provider_kind} storage holding "${u.name}" is not configured`);
      if (Number(u.part_offset) + Number(u.size_bytes) > Number(f.size_bytes)) throw new UnitFailure('source_changed', `"${u.name}" has changed since the transfer was created`);
      if (u.send_as === 'link') {
        const ok = u.share_id && (await this.db.query(
          `SELECT 1 FROM shared_links WHERE id = $1 AND revoked_at IS NULL AND NOT disabled_by_admin AND expires_at > now()`, [u.share_id])).rowCount > 0;
        if (!ok) throw new UnitFailure('share_unavailable', 'The download link was turned off or expired before it could be sent');
      }
      sources.push({ adapter, key: f.storage_key, size: Number(f.size_bytes) });
    }
    return { token, chatId: tr.chat_id, destinationId: tr.destination_id, sources, media: await this.mediaExtras(unit, sources) };
  }

  /** Metadata and thumbnail of an indexed video/audio file, when sending it whole. Everything here is best effort. */
  private async mediaExtras(unit: UnitRow[], sources: { size: number }[]) {
    const u = unit[0]!;
    if (unit.length !== 1 || !u.file_id || (u.send_as !== 'video' && u.send_as !== 'audio')) return null;
    if (Number(u.part_offset) !== 0 || Number(u.size_bytes) !== sources[0]!.size) return null;
    try {
      const m = (await this.db.query<{ duration_ms: number | null; width: number | null; height: number | null; title: string | null; tags: Record<string, string> }>(
        `SELECT duration_ms, width, height, title, tags FROM media_metadata WHERE file_id = $1 AND user_id = $2 AND status = 'ready'`, [u.file_id, u.user_id])).rows[0];
      if (!m) return null;
      let thumb: UploadPart | undefined;
      // Telegram wants a JPEG under 200 kB and at most 320 px on a side.
      if (this.cfg.MEDIA_THUMBNAIL_WIDTH <= 320) {
        const t = (await this.db.query<{ storage_key: string; storage_provider_kind: string; size_bytes: number }>(
          `SELECT storage_key, storage_provider_kind, size_bytes FROM media_assets WHERE file_id = $1 AND kind = 'thumbnail' AND status = 'ready'`, [u.file_id])).rows[0];
        const adapter = t && this.o.adapterFor(t.storage_provider_kind);
        if (t && adapter && Number(t.size_bytes) > 0 && Number(t.size_bytes) <= 200 * 1024) {
          thumb = { field: 'thumb', filename: 'thumb.jpg', contentType: 'image/jpeg', size: Number(t.size_bytes), open: async () => adapter.get(t.storage_key) };
        }
      }
      return {
        durationS: m.duration_ms ? Math.max(1, Math.round(Number(m.duration_ms) / 1000)) : null, width: m.width, height: m.height,
        title: m.title ?? null, artist: m.tags?.artist ?? null, thumb,
      };
    } catch (err) {
      this.o.log.warn({ err }, 'media details unavailable; sending without them');
      return null;
    }
  }

  private async markSent(unit: UnitRow[], msgs: TgMessage[], destinationId: string) {
    for (let i = 0; i < unit.length; i++) {
      await this.db.query(
        `UPDATE telegram_transfer_files SET state = 'sent', message_id = $2, bytes_sent = size_bytes, sent_at = now(), updated_at = now(), caption = CASE WHEN send_as = 'link' THEN NULL ELSE caption END,
                worker_id = NULL, lease_expires_at = NULL, error_code = NULL, error_message = NULL, ambiguous = FALSE
          WHERE id = $1 AND worker_id = $3 AND state = 'uploading'`, [unit[i]!.id, msgs[i]!.message_id, this.workerId]);
    }
    await this.db.query(`UPDATE telegram_destinations SET can_send = TRUE, problem = NULL WHERE id = $1`, [destinationId]);
    await this.db.query(`UPDATE telegram_bots SET blocked_until = NULL WHERE id = (SELECT bot_id FROM telegram_destinations WHERE id = $1)`, [destinationId]);
  }

  /** Records the outcome of a failed attempt. Returns the pacing delay (ms) to apply to the destination. */
  private async onError(unit: UnitRow[], e: unknown, run: Running, pace: number): Promise<number> {
    const ids = unit.map((u) => u.id);
    const reason = run.ac.signal.aborted ? String(run.ac.signal.reason) : undefined;
    const base = `WHERE id = ANY($1::uuid[]) AND worker_id = $2 AND state = 'uploading'`;
    const clear = `worker_id = NULL, lease_expires_at = NULL, updated_at = now()`;

    // code/message are optional: set while the unit waits for an automatic retry so the UI can say why.
    const requeue = (delayMs: number, count = true, code: string | null = null, message: string | null = null) => this.db.query(
      `UPDATE telegram_transfer_files SET state = 'queued', ${clear}, attempt = attempt + $6, bytes_sent = 0,
              next_attempt_at = now() + make_interval(secs => $3), error_code = $4, error_message = $5 ${base}`,
      [ids, this.workerId, delayMs / 1000, code, message?.slice(0, 500) ?? null, count ? 1 : 0]);
    const fail = (code: string, message: string, ambiguous = false) => this.db.query(
      `UPDATE telegram_transfer_files SET state = 'failed', ${clear}, attempt = attempt + 1, ambiguous = $5, error_code = $3, error_message = $4 ${base}`,
      [ids, this.workerId, code, message.slice(0, 500), ambiguous]);

    if (reason === 'lost') return 0; // another process owns these rows now
    if (reason === 'shutdown') { await requeue(0, false); return 0; }

    if (e instanceof UnitFailure) {
      if (e.requeue) { await requeue(30_000, false); return 0; } // bot not usable right now: wait, do not burn attempts
      await fail(e.code, e.message);
      return 0;
    }

    if (e instanceof TelegramApiError) {
      const d = e.description;
      if (e.status === 429) {
        const wait = (e.retryAfter ?? 5) * 1000;
        if (wait > 3_600_000) { await fail('rate_limited', `Telegram asked us to wait ${Math.round(wait / 60000)} minutes`); return wait; }
        const jitter = Math.floor(Math.random() * 1000);
        await requeue(wait + jitter, false, 'rate_limited', 'Telegram rate limit; retrying automatically');
        await this.db.query(`UPDATE telegram_bots SET blocked_until = now() + make_interval(secs => $2) WHERE id = (SELECT bot_id FROM telegram_transfers WHERE id = $1)`, [unit[0]!.transfer_id, (wait + jitter) / 1000]);
        return wait + jitter;
      }
      if (e.migrateTo) {
        await this.db.query(`UPDATE telegram_destinations SET chat_id = $2, chat_type = 'supergroup' WHERE id = (SELECT destination_id FROM telegram_transfers WHERE id = $1)`, [unit[0]!.transfer_id, e.migrateTo]);
        await requeue(0, false);
        return 0;
      }
      if (e.status === 401) {
        await this.db.query(`UPDATE telegram_bots SET status = 'invalid', updated_at = now() WHERE id = (SELECT bot_id FROM telegram_transfers WHERE id = $1) AND status = 'active'`, [unit[0]!.transfer_id]);
        const uid = unit[0]!.user_id;
        await this.notify(uid, 'integration_disconnected', 'Telegram bot disconnected', 'Telegram rejected the bot token. Rotate the token to continue; queued files are kept.');
        await requeue(0, false); // not the files' fault; they resume after the token is replaced
        return 0;
      }
      if (e.status >= 500) {
        await fail('delivery_unknown', `Telegram responded with an error (${e.status}) after receiving the file, so it is unknown whether it was delivered. Check the chat before sending it again.`, true);
        return pace;
      }
      if (e.status === 413 || /too large|file is too big|entity too large/i.test(d)) { await fail('file_too_large', 'Telegram rejected the file as too large for this Bot API server'); return pace; }
      if (/chat not found|chat_id is empty/i.test(d)) {
        await this.markDestination(unit[0]!.transfer_id, false, 'Chat not found: the bot cannot see this chat');
        await fail('chat_not_found', 'Telegram cannot find this chat. The bot may have been removed from it.'); return pace;
      }
      if (e.status === 403 || /not enough rights|have no rights|can't send|cannot send|not a member|was kicked|was blocked|forbidden/i.test(d)) {
        await this.markDestination(unit[0]!.transfer_id, false, 'The bot is not allowed to post here');
        await fail('no_permission', 'The bot is not allowed to send messages or files in this chat. Add it as a member (groups) or an administrator with permission to post (channels).'); return pace;
      }
      if (/caption/i.test(d)) { await fail('invalid_caption', d); return pace; }
      const sendAs = unit[0]!.send_as;
      if (/wrong file|PHOTO_|IMAGE_PROCESS|VIDEO_|wrong type|file must be non-empty|failed to get HTTP URL/i.test(d)) {
        if (sendAs !== 'document') {
          // Photo/video/audio rejected (dimensions, codec, format): the file itself is fine, so send it as a document.
          await this.db.query(`UPDATE telegram_transfer_files SET state = 'queued', send_as = 'document', album_key = NULL, ${clear}, bytes_sent = 0,
                  error_code = NULL, error_message = NULL, next_attempt_at = now() ${base}`, [ids, this.workerId]);
          return pace;
        }
        await fail('unsupported_media', `Telegram rejected this file: ${d}`); return pace;
      }
      await fail('telegram_error', `Telegram error ${e.status}: ${d}`);
      return pace;
    }

    if (e instanceof TelegramNetworkError) {
      if (e.possiblyDelivered) {
        await fail('delivery_unknown', `The connection failed after the file was sent (${e.code}), so it is unknown whether Telegram received it. Check the chat before sending it again.`, true);
        return pace;
      }
      return this.retryOrFail(unit, 'network_error', `Network problem talking to Telegram (${e.code})`, requeue, fail, pace);
    }
    if (e instanceof TelegramSourceError) {
      return this.retryOrFail(unit, 'source_read_failed', e.message, requeue, fail, pace);
    }
    this.o.log.error({ err: e }, 'unexpected telegram send error');
    await fail('internal_error', 'Unexpected error while sending to Telegram');
    return pace;
  }

  private async retryOrFail(unit: UnitRow[], code: string, message: string,
    requeue: (ms: number, count?: boolean, code?: string | null, message?: string | null) => Promise<unknown>, fail: (c: string, m: string) => Promise<unknown>, pace: number) {
    const attempt = unit[0]!.attempt + 1;
    if (attempt >= this.cfg.TELEGRAM_MAX_ATTEMPTS) { await fail(code, `${message}; giving up after ${attempt} attempts`); return pace; }
    const delay = backoffMs(attempt, this.cfg.TELEGRAM_BACKOFF_BASE_MS, this.cfg.TELEGRAM_BACKOFF_MAX_MS);
    await requeue(delay, true, code, message);
    return 0;
  }

  private async markDestination(transferId: string, canSend: boolean, problem: string) {
    await this.db.query(`UPDATE telegram_destinations SET can_send = $2, problem = $3 WHERE id = (SELECT destination_id FROM telegram_transfers WHERE id = $1)`, [transferId, canSend, problem]).catch(() => undefined);
  }
}

/** A problem found before contacting Telegram. */
class UnitFailure extends Error {
  constructor(public readonly code: string, message: string, public readonly ambiguous = false, public readonly requeue = false) { super(message); }
}

