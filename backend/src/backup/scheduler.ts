import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { StorageAdapter } from '../storage/types.js';
import { checkPassphrase, createBackup, verifyBackup } from './backup.js';

interface Logger { info(o: object, msg?: string): void; warn(o: object, msg?: string): void; error(o: object, msg?: string): void }

/** A run that has been "running" this long is assumed dead (its worker was stopped) and is closed as failed. */
const STALE_RUN_HOURS = 12;
/** After a failed attempt, try again after this long instead of waiting a whole interval. */
const RETRY_AFTER_FAILURE_HOURS = 1;

export async function readPassphrase(c: Pick<Config, 'BACKUP_PASSPHRASE' | 'BACKUP_PASSPHRASE_FILE'>): Promise<string> {
  const p = c.BACKUP_PASSPHRASE_FILE ? (await readFile(c.BACKUP_PASSPHRASE_FILE, 'utf8')).replace(/\r?\n$/, '') : c.BACKUP_PASSPHRASE;
  return checkPassphrase(p);
}
export const passphraseConfigured = (c: Pick<Config, 'BACKUP_PASSPHRASE' | 'BACKUP_PASSPHRASE_FILE'>) => !!(c.BACKUP_PASSPHRASE || c.BACKUP_PASSPHRASE_FILE);

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

/**
 * Makes backups on a schedule and on request. It lives in the worker (which can see the database and the storage).
 * Several workers can run it at once: a request is claimed by exactly one of them.
 */
export class BackupScheduler {
  private busy = false;
  constructor(private readonly o: { db: Db; config: Config; adapterFor: (kind: string) => StorageAdapter | undefined; log: Logger; workerId: string }) {}

  /** Cheap enough to call every few seconds. Never throws; a long backup runs without blocking the caller. */
  tick(): void {
    if (this.busy) return;
    this.busy = true;
    void this.cycle().catch((err) => this.o.log.error({ err }, 'backup scheduler failed')).finally(() => { this.busy = false; });
  }

  async cycle(): Promise<string | null> {
    const { db, config } = this.o;
    await db.query(
      `UPDATE backup_runs SET status = 'failed', finished_at = now(), error = 'Interrupted: the worker running it stopped.'
        WHERE status = 'running' AND started_at < now() - make_interval(hours => $1)`, [STALE_RUN_HOURS]);

    if (config.BACKUP_INTERVAL_HOURS > 0) {
      await db.tx(async (t) => {
        await t.query('SELECT pg_advisory_xact_lock(7302)'); // one scheduler decides at a time
        await t.query(
          `INSERT INTO backup_runs (trigger) SELECT 'schedule'
            WHERE NOT EXISTS (SELECT 1 FROM backup_runs
                               WHERE status IN ('requested', 'running')
                                  OR (status = 'succeeded' AND requested_at > now() - ($1::float8 * interval '1 hour'))
                                  OR (status = 'failed' AND requested_at > now() - ($2::float8 * interval '1 hour')))`,
          [config.BACKUP_INTERVAL_HOURS, RETRY_AFTER_FAILURE_HOURS]);
      });
    }

    const run = (await db.query<{ id: string }>(
      `UPDATE backup_runs SET status = 'running', started_at = now(), worker_id = $1
        WHERE id = (SELECT id FROM backup_runs WHERE status = 'requested' ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id`, [this.o.workerId])).rows[0];
    if (!run) return null;
    await this.execute(run.id);
    return run.id;
  }

  private async execute(id: string) {
    const { db, config, log } = this.o;
    const file = `cloudseed-${stamp()}-${randomBytes(3).toString('hex')}.csbk`; // the suffix keeps two backups in the same second apart
    const out = path.resolve(config.BACKUP_DIR, file);
    try {
      const passphrase = await readPassphrase(config);
      await mkdir(path.dirname(out), { recursive: true });
      const s = await createBackup({ db, out, passphrase, includeObjects: config.BACKUP_INCLUDE_OBJECTS, adapterFor: this.o.adapterFor });
      // Read it all back: decrypts every frame and re-checks every object's SHA-256. A backup nobody has read is only a hope.
      await verifyBackup(out, passphrase);
      const rows = Object.values(s.rows).reduce((a, b) => a + b, 0);
      await db.query(
        `UPDATE backup_runs SET status = 'succeeded', finished_at = now(), file_name = $2, bytes = $3, row_count = $4, object_count = $5,
                missing_count = $6, corrupt_count = $7, verified = TRUE WHERE id = $1`,
        [id, file, s.bytes, rows, s.objects.included, s.missing.length, s.corrupt.length]);
      log.info({ file, bytes: s.bytes, rows, objects: s.objects.included, missing: s.missing.length, corrupt: s.corrupt.length }, 'backup finished');
      if (s.missing.length || s.corrupt.length) {
        await this.notifyAdmins('backup_warning', 'Backup finished with warnings',
          `${s.missing.length} stored file(s) were missing and ${s.corrupt.length} did not match their checksum when the backup was made. Run "cli reconcile" to see which.`);
      }
      await this.prune();
    } catch (e) {
      const message = (e as Error).message.slice(0, 500); // never contains the passphrase: checkPassphrase only names the variable
      await rm(`${out}.partial`, { force: true }).catch(() => undefined);
      await rm(out, { force: true }).catch(() => undefined);
      await db.query(`UPDATE backup_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [id, message]);
      log.error({ error: message }, 'backup failed');
      await this.notifyAdmins('backup_failed', 'A backup failed', `${message} Another attempt will be made automatically if a schedule is set.`);
    }
  }

  /** Keeps the newest BACKUP_KEEP verified backups and deletes the files of the rest. */
  async prune() {
    const { db, config, log } = this.o;
    const old = (await db.query<{ id: string; file_name: string }>(
      `SELECT id, file_name FROM backup_runs WHERE status = 'succeeded' AND verified AND file_name IS NOT NULL AND pruned_at IS NULL
        ORDER BY finished_at DESC OFFSET $1`, [config.BACKUP_KEEP])).rows;
    for (const r of old) {
      // the name comes from our own table, but never trust it enough to leave the backup directory
      if (r.file_name !== path.basename(r.file_name) || !/^cloudseed-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}\.csbk$/.test(r.file_name)) continue;
      await rm(path.join(path.resolve(config.BACKUP_DIR), r.file_name), { force: true }).catch((err) => log.warn({ err }, 'could not delete an old backup'));
      await db.query(`UPDATE backup_runs SET pruned_at = now() WHERE id = $1`, [r.id]);
    }
  }

  private async notifyAdmins(kind: string, title: string, body: string) {
    await this.o.db.query(
      `INSERT INTO notifications (user_id, kind, title, body)
       SELECT u.id, $1, $2, $3 FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.role_id = 2 WHERE u.status = 'active'`, [kind, title, body]).catch(() => undefined);
  }
}
