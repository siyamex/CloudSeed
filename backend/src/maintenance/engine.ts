import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { Mailer } from '../mail/mailer.js';
import { BackupScheduler } from '../backup/scheduler.js';
import type { StorageAdapter } from '../storage/types.js';
import type { Vault } from '../crypto.js';
import { sendToDestination } from '../telegram/notify.js';

export interface Logger {
  info(o: object, msg?: string): void;
  warn(o: object, msg?: string): void;
  error(o: object, msg?: string): void;
}

export interface MaintenanceOptions {
  db: Db;
  config: Config;
  mailer: Mailer;
  log: Logger;
  /** Name shown on the admin worker page, e.g. "worker". */
  role?: string;
  workerId?: string;
  aliveFile?: string;
  /** Needed for backups of stored files. Without it the engine does no backups. */
  adapterFor?: (kind: string) => StorageAdapter | undefined;
  /** Needed to send notifications through users' Telegram bots. Without it Telegram notifications are not sent. */
  vault?: Vault;
}

const SWEEP_EVERY_MS = 5 * 60_000;

/**
 * Housekeeping that must happen even when nobody is using the site: email delivery, warnings (storage almost full,
 * share links about to expire), clean-up of expired sessions and old notifications, and the worker heartbeat the
 * admin pages read. Every step is idempotent, so several workers can run it at once.
 */
export class MaintenanceEngine {
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private ticking = false;
  private lastSweep = 0;
  private lastBeat = 0;
  private lastBackupCheck = 0;
  private readonly backups?: BackupScheduler;
  readonly workerId: string;
  readonly startedAt = new Date();

  constructor(private readonly o: MaintenanceOptions) {
    this.workerId = o.workerId ?? `maint-${process.pid}-${randomUUID().slice(0, 8)}`;
    if (o.adapterFor) this.backups = new BackupScheduler({ db: o.db, config: o.config, adapterFor: o.adapterFor, log: o.log, workerId: this.workerId });
  }

  private get db() { return this.o.db; }
  private get cfg() { return this.o.config; }

  start() {
    this.timer = setInterval(() => void this.tick(), Math.max(500, this.cfg.WORKER_POLL_MS));
    this.timer.unref();
    void this.tick();
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.db.query(`DELETE FROM worker_heartbeats WHERE id = $1`, [this.workerId]).catch(() => undefined);
  }

  async tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      if (this.o.aliveFile) await writeFile(this.o.aliveFile, String(Date.now())).catch(() => undefined);
      const now = Date.now();
      if (now - this.lastBeat > 10_000) { this.lastBeat = now; await this.heartbeat().catch((err) => this.o.log.warn({ err }, 'heartbeat failed')); }
      if (this.backups && now - this.lastBackupCheck > 5_000) { this.lastBackupCheck = now; this.backups.tick(); } // runs in the background: a backup can take minutes
      await this.sendEmails().catch((err) => this.o.log.error({ err }, 'email sweep failed'));
      await this.sendTelegram().catch((err) => this.o.log.error({ err }, 'telegram notification sweep failed'));
      if (now - this.lastSweep > SWEEP_EVERY_MS) {
        this.lastSweep = now;
        await this.sweep().catch((err) => this.o.log.error({ err }, 'maintenance sweep failed'));
      }
    } finally { this.ticking = false; }
  }

  /** Registers this process so administrators can see that it is alive. */
  async heartbeat() {
    await this.db.query(
      `INSERT INTO worker_heartbeats (id, role, started_at, last_seen_at, pid, host, info)
       VALUES ($1, $2, $3, now(), $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET last_seen_at = now(), info = EXCLUDED.info`,
      [this.workerId, this.o.role ?? 'worker', this.startedAt.toISOString(), process.pid, process.env.HOSTNAME ?? 'unknown',
        JSON.stringify({ node: process.version, rssMb: Math.round(process.memoryUsage().rss / 1048576), email: this.o.mailer.configured })]);
    await this.db.query(`DELETE FROM worker_heartbeats WHERE last_seen_at < now() - interval '1 day'`);
  }

  // ---------------------------------------------------------------- email
  /**
   * Emails unsent notifications to users who asked for them. A notification is emailed at most once; failures are retried
   * with back-off and then given up on. Nothing here ever blocks or fails the notification itself.
   */
  async sendEmails(): Promise<number> {
    if (!this.o.mailer.configured) {
      await this.db.query(`UPDATE notifications SET email_state = 'skipped' WHERE email_state IS NULL AND created_at < now() - interval '1 minute'`);
      return 0;
    }
    const batch = await this.db.tx(async (t) => {
      const rows = (await t.query<{ id: string; user_id: string; kind: string; title: string; body: string | null; email: string; enabled: boolean | null; muted: string[] | null; attempts: number }>(
        `SELECT n.id, n.user_id, n.kind, n.title, n.body, u.email, us.email_notifications AS enabled, us.muted_kinds AS muted, n.email_attempts AS attempts
           FROM notifications n JOIN users u ON u.id = n.user_id AND u.status = 'active' LEFT JOIN user_settings us ON us.user_id = n.user_id
          WHERE n.email_state IS NULL AND n.email_next_at <= now() AND n.created_at > now() - interval '2 days'
          ORDER BY n.created_at LIMIT 20 FOR UPDATE OF n SKIP LOCKED`)).rows;
      // lease: another worker will not pick these up for a few minutes even if this one dies mid-send
      if (rows.length) await t.query(`UPDATE notifications SET email_next_at = now() + interval '5 minutes' WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
      return rows;
    });

    let sent = 0;
    for (const n of batch) {
      const skip = !n.enabled || (n.muted ?? []).includes(n.kind);
      const capped = !skip && (await this.db.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM notifications WHERE user_id = $1 AND email_state = 'sent' AND created_at > now() - interval '1 hour'`, [n.user_id])).rows[0]!.c >= this.cfg.EMAIL_MAX_PER_HOUR;
      if (skip || capped) { await this.db.query(`UPDATE notifications SET email_state = 'skipped' WHERE id = $1`, [n.id]); continue; }
      try {
        await this.o.mailer.send({
          to: n.email, subject: `[CloudSeed] ${n.title}`,
          text: `${n.title}\n\n${n.body ?? ''}\n\nOpen CloudSeed: ${this.cfg.PUBLIC_URL}\n\nYou get this email because email notifications are turned on in your CloudSeed settings.\n`,
        });
        await this.db.query(`UPDATE notifications SET email_state = 'sent' WHERE id = $1`, [n.id]);
        sent++;
      } catch (err) {
        const attempts = n.attempts + 1;
        this.o.log.warn({ code: (err as { code?: string }).code ?? 'error', attempts }, 'notification email failed'); // never log the address or content
        await this.db.query(
          `UPDATE notifications SET email_attempts = $2, email_state = $3, email_next_at = now() + make_interval(secs => $4) WHERE id = $1`,
          [n.id, attempts, attempts >= 3 ? 'failed' : null, 60 * 2 ** attempts]);
      }
    }
    return sent;
  }

  // ---------------------------------------------------------------- Telegram
  /**
   * Sends notifications to the Telegram destination a user chose, through that user's own bot. Each notification goes out at most
   * once per success; failures back off and are given up on after three tries. Sends share the destination's pacing slot with file
   * transfers, so a burst of notifications cannot trip Telegram's flood limit for the chat.
   */
  async sendTelegram(): Promise<number> {
    if (!this.o.vault || !this.cfg.TELEGRAM_ENABLED) return 0;
    const batch = await this.db.tx(async (t) => {
      const rows = (await t.query<{ id: string; user_id: string; kind: string; title: string; body: string | null; attempts: number; dest: string | null; muted: string[] | null }>(
        `SELECT n.id, n.user_id, n.kind, n.title, n.body, n.tg_attempts AS attempts, us.telegram_notify_destination_id AS dest, us.muted_kinds AS muted
           FROM notifications n JOIN users u ON u.id = n.user_id AND u.status = 'active' LEFT JOIN user_settings us ON us.user_id = n.user_id
          WHERE n.tg_state IS NULL AND n.tg_next_at <= now() AND n.created_at > now() - interval '2 days'
          ORDER BY n.created_at LIMIT 10 FOR UPDATE OF n SKIP LOCKED`)).rows;
      if (rows.length) await t.query(`UPDATE notifications SET tg_next_at = now() + interval '5 minutes' WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
      return rows;
    });
    let sent = 0;
    for (const n of batch) {
      if (!n.dest || (n.muted ?? []).includes(n.kind)) { await this.db.query(`UPDATE notifications SET tg_state = 'skipped' WHERE id = $1`, [n.id]); continue; }
      const recent = (await this.db.query<{ c: number }>(`SELECT count(*)::int AS c FROM notifications WHERE user_id = $1 AND tg_state = 'sent' AND created_at > now() - interval '1 hour'`, [n.user_id])).rows[0]!.c;
      if (recent >= this.cfg.TELEGRAM_NOTIFY_MAX_PER_HOUR) { await this.db.query(`UPDATE notifications SET tg_state = 'skipped' WHERE id = $1`, [n.id]); continue; }
      // take the destination's next sending slot; if another send holds it, try again in a few seconds (not an attempt)
      const slot = await this.db.query(
        `UPDATE telegram_destinations SET next_send_at = now() + make_interval(secs => $2::float8) WHERE id = $1 AND next_send_at <= now()`, [n.dest, this.cfg.TELEGRAM_CHAT_INTERVAL_MS / 1000]);
      if (!slot.rowCount) { await this.db.query(`UPDATE notifications SET tg_next_at = now() + interval '5 seconds' WHERE id = $1`, [n.id]); continue; }

      const out = await sendToDestination({
        db: this.db, vault: this.o.vault, config: this.cfg, userId: n.user_id, destinationId: n.dest,
        text: `${n.title}${n.body ? `\n\n${n.body}` : ''}\n\n${this.cfg.PUBLIC_URL}`,
      });
      if (out.ok) { await this.db.query(`UPDATE notifications SET tg_state = 'sent' WHERE id = $1`, [n.id]); sent++; continue; }
      const attempts = n.attempts + 1;
      this.o.log.warn({ attempts, retry: out.retry }, 'telegram notification failed'); // never the text, chat or token
      if (out.retryAfterSeconds) await this.db.query(`UPDATE telegram_destinations SET next_send_at = now() + make_interval(secs => $2::float8) WHERE id = $1`, [n.dest, out.retryAfterSeconds]);
      await this.db.query(
        `UPDATE notifications SET tg_attempts = $2, tg_state = $3, tg_next_at = now() + make_interval(secs => $4::float8) WHERE id = $1`,
        [n.id, attempts, !out.retry || attempts >= 3 ? 'failed' : null, out.retryAfterSeconds ?? 60 * 2 ** attempts]);
    }
    return sent;
  }

  // ---------------------------------------------------------------- warnings and clean-up
  async sweep() {
    const q = await this.db.query(
      `INSERT INTO notifications (user_id, kind, title, body)
       SELECT q.user_id, 'quota_warning', 'Your storage is almost full', format('You are using %s%% of your storage quota. Free some space or ask the administrator for more.', round(100.0 * q.used_bytes / q.quota_bytes))
         FROM storage_quotas q JOIN users u ON u.id = q.user_id AND u.status = 'active'
        WHERE q.quota_bytes > 0 AND q.used_bytes * 100 >= q.quota_bytes * $1
          AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = q.user_id AND n.kind = 'quota_warning' AND n.created_at > now() - interval '24 hours')`,
      [this.cfg.QUOTA_WARNING_PERCENT]);
    const s = await this.db.query(
      `WITH due AS (
         UPDATE shared_links s SET expiry_notified = TRUE
          WHERE s.revoked_at IS NULL AND NOT s.disabled_by_admin AND NOT s.expiry_notified AND s.expires_at > now() AND s.expires_at <= now() + interval '24 hours'
          RETURNING s.user_id, s.file_id, s.folder_id, s.expires_at)
       INSERT INTO notifications (user_id, kind, title, body)
       SELECT d.user_id, 'share_expiring', 'A share link expires soon', format('The link to "%s" expires at %s UTC.', COALESCE(f.name, g.name), to_char(d.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'))
         FROM due d LEFT JOIN files f ON f.id = d.file_id LEFT JOIN folders g ON g.id = d.folder_id`);
    await this.db.query(`DELETE FROM notifications WHERE created_at < now() - make_interval(days => $1)`, [this.cfg.NOTIFICATION_RETENTION_DAYS]);
    await this.db.query(`DELETE FROM sessions WHERE expires_at < now() - interval '1 day'`);
    await this.db.query(`DELETE FROM oauth_login_states WHERE expires_at < now() - interval '1 hour'`);
    if (q.rowCount || s.rowCount) this.o.log.info({ quotaWarnings: q.rowCount, expiringLinks: s.rowCount }, 'warnings raised');
    return { quotaWarnings: q.rowCount, expiringLinks: s.rowCount };
  }
}
