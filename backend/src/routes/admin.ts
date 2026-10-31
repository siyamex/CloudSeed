import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAdmin, type Deps } from '../app.js';
import { HttpError } from '../errors.js';
import { passphraseConfigured } from '../backup/scheduler.js';

const uuid = z.string().uuid();
const page = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });

/** Settings an administrator can change at run time. Everything else is configured through the environment. */
export const SETTINGS = {
  registration_policy: z.enum(['open', 'closed']),
  default_quota_bytes: z.number().int().min(0),
} as const;
type SettingKey = keyof typeof SETTINGS;

export const adminRoutes = (deps: Deps): FastifyPluginAsync => async (app) => {
  const { db, config } = deps;
  app.addHook('preHandler', async (req) => { requireAdmin(req); });
  const audit = (adminId: string, action: string, target: string | null, ip: string, meta: object = {}) =>
    db.query(`INSERT INTO audit_logs (user_id, action, target, ip, metadata) VALUES ($1, $2, $3, $4, $5)`, [adminId, action, target, ip, JSON.stringify(meta)]);

  async function settingsNow() {
    const r = await db.query<{ key: string; value: unknown }>(`SELECT key, value FROM application_settings WHERE key = ANY($1)`, [Object.keys(SETTINGS)]);
    const m = new Map(r.rows.map((x) => [x.key, x.value]));
    return {
      registration_policy: (m.get('registration_policy') as string | undefined) ?? config.REGISTRATION_POLICY,
      default_quota_bytes: Number(m.get('default_quota_bytes') ?? config.DEFAULT_USER_QUOTA_BYTES),
    };
  }

  // ------------------------------------------------------------------ overview
  app.get('/admin/overview', async () => {
    const one = async <T>(sql: string) => (await db.query<T & object>(sql)).rows[0]!;
    const [users, storage, shares, reports, workers] = await Promise.all([
      one<{ active: number; disabled: number }>(`SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'disabled')::int AS disabled FROM users`),
      one<{ files: number; used: string; quota: string }>(`SELECT (SELECT count(*)::int FROM files WHERE deleted_at IS NULL) AS files, COALESCE(sum(used_bytes),0) AS used, COALESCE(sum(quota_bytes),0) AS quota FROM storage_quotas`),
      one<{ active: number }>(`SELECT count(*)::int AS active FROM shared_links WHERE revoked_at IS NULL AND NOT disabled_by_admin AND expires_at > now()`),
      one<{ open: number }>(`SELECT count(*)::int AS open FROM abuse_reports WHERE status = 'open'`),
      one<{ alive: number }>(`SELECT count(*)::int AS alive FROM worker_heartbeats WHERE last_seen_at > now() - interval '60 seconds'`),
    ]);
    const lastBackup = (await db.query<{ finished_at: string; verified: boolean }>(`SELECT finished_at, verified FROM backup_runs WHERE status = 'succeeded' ORDER BY finished_at DESC LIMIT 1`)).rows[0];
    const lastFailed = (await db.query<{ finished_at: string }>(`SELECT finished_at FROM backup_runs WHERE status = 'failed' ORDER BY finished_at DESC LIMIT 1`)).rows[0];
    return {
      users: users, storage: { files: storage.files, usedBytes: Number(storage.used), quotaBytes: Number(storage.quota) },
      activeShareLinks: shares.active, openAbuseReports: reports.open, workersAlive: workers.alive,
      backup: {
        ...backupConfig(), lastSuccessAt: lastBackup?.finished_at ?? null, lastVerified: lastBackup?.verified ?? null,
        lastFailureAt: lastFailed && (!lastBackup || new Date(lastFailed.finished_at) > new Date(lastBackup.finished_at)) ? lastFailed.finished_at : null,
      },
      features: { email: config.SMTP_HOST !== '', sharing: config.SHARING_ENABLED, telegram: config.TELEGRAM_ENABLED, media: config.MEDIA_ENABLED, metrics: config.METRICS_TOKEN !== '' },
    };
  });

  // ------------------------------------------------------------------ backups
  const backupConfig = () => ({
    enabled: config.BACKUP_INTERVAL_HOURS > 0, intervalHours: config.BACKUP_INTERVAL_HOURS, keep: config.BACKUP_KEEP, directory: config.BACKUP_DIR,
    includeObjects: config.BACKUP_INCLUDE_OBJECTS, passphraseConfigured: passphraseConfigured(config),
  });

  app.get('/admin/backups', async () => {
    const r = await db.query<{ id: string; trigger: string; status: string; requested_at: string; started_at: string | null; finished_at: string | null; file_name: string | null;
      bytes: number | null; row_count: number | null; object_count: number | null; missing_count: number; corrupt_count: number; verified: boolean; pruned_at: string | null; error: string | null }>(
      `SELECT id, trigger, status, requested_at, started_at, finished_at, file_name, bytes, row_count, object_count, missing_count, corrupt_count, verified, pruned_at, error
         FROM backup_runs ORDER BY requested_at DESC LIMIT 50`);
    return {
      config: backupConfig(),
      runs: r.rows.map((x) => ({
        id: x.id, trigger: x.trigger, status: x.status, requestedAt: x.requested_at, startedAt: x.started_at, finishedAt: x.finished_at,
        fileName: x.pruned_at ? null : x.file_name, bytes: x.bytes === null ? null : Number(x.bytes), rows: x.row_count, objects: x.object_count,
        missing: x.missing_count, corrupt: x.corrupt_count, verified: x.verified, pruned: x.pruned_at !== null, error: x.error,
      })),
    };
  });

  app.post('/admin/backups/run', async (req, reply) => {
    const admin = requireAdmin(req);
    if (!passphraseConfigured(config)) {
      throw new HttpError(409, 'backup_not_configured', 'Set BACKUP_PASSPHRASE_FILE (or BACKUP_PASSPHRASE) for the worker first. A backup is always encrypted.');
    }
    const id = await db.tx(async (t) => {
      await t.query('SELECT pg_advisory_xact_lock(7302)');
      if ((await t.query(`SELECT 1 FROM backup_runs WHERE status IN ('requested', 'running')`)).rowCount) {
        throw new HttpError(409, 'backup_in_progress', 'A backup is already waiting or running.');
      }
      const r = await t.query<{ id: string }>(`INSERT INTO backup_runs (trigger, requested_by) VALUES ('manual', $1) RETURNING id`, [admin.userId]);
      await t.query(`INSERT INTO audit_logs (user_id, action, target, ip) VALUES ($1, 'admin.backup_requested', $2, $3)`, [admin.userId, `backup:${r.rows[0]!.id}`, req.ip]);
      return r.rows[0]!.id;
    });
    return reply.status(202).send({ id });
  });

  // ------------------------------------------------------------------ users
  app.get('/admin/users', async (req) => {
    const p = page.extend({ q: z.string().max(200).optional(), status: z.enum(['active', 'disabled']).optional() }).parse(req.query);
    const like = p.q ? `%${p.q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const rows = (await db.query<{ id: string; email: string; status: string; created_at: string; roles: string[]; quota: string | null; used: string | null; files: number; last_seen: string | null; total: number }>(
      `SELECT u.id, u.email, u.status, u.created_at,
              COALESCE((SELECT array_agg(r.name ORDER BY r.name) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '{}') AS roles,
              q.quota_bytes AS quota, q.used_bytes AS used,
              (SELECT count(*)::int FROM files f WHERE f.user_id = u.id AND f.deleted_at IS NULL) AS files,
              (SELECT max(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen,
              count(*) OVER ()::int AS total
         FROM users u LEFT JOIN storage_quotas q ON q.user_id = u.id
        WHERE u.status <> 'deleted' AND ($1::text IS NULL OR u.email ILIKE $1 ESCAPE '\\') AND ($2::text IS NULL OR u.status = $2)
        ORDER BY u.created_at DESC LIMIT $3 OFFSET $4`, [like, p.status ?? null, p.limit, p.offset])).rows;
    return {
      total: rows[0]?.total ?? 0,
      users: rows.map((u) => ({
        id: u.id, email: u.email, status: u.status, roles: u.roles, createdAt: u.created_at, lastSeenAt: u.last_seen,
        quotaBytes: u.quota === null ? null : Number(u.quota), usedBytes: u.used === null ? null : Number(u.used), files: u.files,
      })),
    };
  });

  app.patch('/admin/users/:id', async (req) => {
    const admin = requireAdmin(req);
    const id = uuid.parse((req.params as { id: string }).id);
    const b = z.object({
      status: z.enum(['active', 'disabled']).optional(),
      admin: z.boolean().optional(),
      quotaBytes: z.number().int().min(0).optional(),
    }).strict().parse(req.body);

    await db.tx(async (t) => {
      const u = (await t.query<{ status: string }>(`SELECT status FROM users WHERE id = $1 AND status <> 'deleted' FOR UPDATE`, [id])).rows[0];
      if (!u) throw new HttpError(404, 'not_found', 'User not found');
      const wasAdmin = (await t.query(`SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = 2`, [id])).rowCount > 0;
      const losesAdmin = (b.admin === false && wasAdmin) || (b.status === 'disabled' && wasAdmin);
      if (losesAdmin) {
        if (id === admin.userId) throw new HttpError(409, 'self_lockout', 'You cannot remove your own administrator access or disable yourself. Ask another administrator.');
        const others = await t.query(`SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id AND ur.role_id = 2 WHERE u.status = 'active' AND u.id <> $1 FOR UPDATE OF u`, [id]);
        if (!others.rowCount) throw new HttpError(409, 'last_admin', 'This is the only active administrator');
      }
      if (b.status) {
        await t.query(`UPDATE users SET status = $2, updated_at = now() WHERE id = $1`, [id, b.status]);
        if (b.status === 'disabled') await t.query(`DELETE FROM sessions WHERE user_id = $1`, [id]); // signed out immediately
      }
      if (b.admin === true) await t.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 2) ON CONFLICT DO NOTHING`, [id]);
      if (b.admin === false) await t.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = 2`, [id]);
      if (b.quotaBytes !== undefined) await t.query(`UPDATE storage_quotas SET quota_bytes = $2 WHERE user_id = $1`, [id, b.quotaBytes]);
      await t.query(`INSERT INTO audit_logs (user_id, action, target, ip, metadata) VALUES ($1, 'admin.user_update', $2, $3, $4)`, [admin.userId, `user:${id}`, req.ip, JSON.stringify(b)]);
    });
    return { ok: true };
  });

  // ------------------------------------------------------------------ queues and workers
  /** Operational numbers only. Administrators see job states and error codes, never users' URLs or file names. */
  app.get('/admin/queues', async () => {
    const [dl, tg, md] = await Promise.all([
      db.query<{ state: string; n: number; oldest: number | null; stuck: number }>(
        `SELECT state, count(*)::int AS n, extract(epoch FROM now() - min(created_at))::int AS oldest,
                count(*) FILTER (WHERE lease_expires_at < now())::int AS stuck
           FROM download_jobs WHERE state NOT IN ('completed','cancelled') OR finished_at > now() - interval '1 day' GROUP BY state ORDER BY state`),
      db.query<{ state: string; n: number; oldest: number | null }>(
        `SELECT state, count(*)::int AS n, extract(epoch FROM now() - min(created_at))::int AS oldest FROM telegram_transfers
          WHERE state IN ('queued','uploading') OR created_at > now() - interval '1 day' GROUP BY state ORDER BY state`),
      db.query<{ status: string; n: number; oldest: number | null }>(
        `SELECT status, count(*)::int AS n, extract(epoch FROM now() - min(created_at))::int AS oldest FROM media_assets
          WHERE status IN ('queued','processing','failed') GROUP BY status ORDER BY status`),
    ]);
    const failures = (await db.query<{ id: string; error_code: string | null; finished_at: string }>(
      `SELECT id, error_code, finished_at FROM download_jobs WHERE state = 'failed' ORDER BY finished_at DESC NULLS LAST LIMIT 20`)).rows;
    return {
      downloads: dl.rows.map((r) => ({ state: r.state, count: r.n, oldestSeconds: r.oldest, expiredLeases: r.stuck })),
      telegram: tg.rows.map((r) => ({ state: r.state, count: r.n, oldestSeconds: r.oldest })),
      media: md.rows.map((r) => ({ state: r.status, count: r.n, oldestSeconds: r.oldest })),
      recentDownloadFailures: failures.map((f) => ({ id: f.id, code: f.error_code, at: f.finished_at })),
    };
  });

  app.get('/admin/workers', async () => {
    const r = await db.query<{ id: string; role: string; started_at: string; last_seen_at: string; pid: number | null; host: string | null; info: object; alive: boolean }>(
      `SELECT id, role, started_at, last_seen_at, pid, host, info, last_seen_at > now() - interval '60 seconds' AS alive FROM worker_heartbeats ORDER BY last_seen_at DESC`);
    return { workers: r.rows.map((w) => ({ id: w.id, role: w.role, startedAt: w.started_at, lastSeenAt: w.last_seen_at, pid: w.pid, host: w.host, info: w.info, alive: w.alive })) };
  });

  // ------------------------------------------------------------------ abuse reports
  app.get('/admin/reports', async (req) => {
    const p = page.extend({ status: z.enum(['open', 'dismissed', 'actioned']).default('open') }).parse(req.query);
    const r = await db.query<any>(
      `SELECT a.id, a.share_id, a.file_name, a.reason, a.details, a.status, a.created_at, a.resolved_at, a.resolution_note,
              s.disabled_by_admin, s.revoked_at, o.email AS owner_email, count(*) OVER ()::int AS total,
              (SELECT count(*)::int FROM abuse_reports x WHERE x.owner_id = a.owner_id AND x.status = 'actioned') AS owner_actioned
         FROM abuse_reports a LEFT JOIN shared_links s ON s.id = a.share_id LEFT JOIN users o ON o.id = a.owner_id
        WHERE a.status = $1 ORDER BY a.created_at DESC LIMIT $2 OFFSET $3`, [p.status, p.limit, p.offset]);
    return {
      total: r.rows[0]?.total ?? 0,
      reports: r.rows.map((x) => ({
        id: x.id, shareId: x.share_id, fileName: x.file_name, reason: x.reason, details: x.details, status: x.status, createdAt: x.created_at,
        resolvedAt: x.resolved_at, resolutionNote: x.resolution_note, ownerEmail: x.owner_email, ownerActionedReports: x.owner_actioned,
        linkDisabled: x.disabled_by_admin === true || x.revoked_at !== null,
      })),
    };
  });

  app.post('/admin/reports/:id/resolve', async (req) => {
    const admin = requireAdmin(req);
    const id = uuid.parse((req.params as { id: string }).id);
    const b = z.object({
      action: z.enum(['dismiss', 'disable_link', 'disable_link_and_file']),
      note: z.string().trim().max(1000).optional(),
    }).strict().parse(req.body);

    await db.tx(async (t) => {
      const rep = (await t.query<{ status: string; share_id: string | null; owner_id: string | null; file_name: string | null }>(
        `SELECT status, share_id, owner_id, file_name FROM abuse_reports WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!rep) throw new HttpError(404, 'not_found', 'Report not found');
      if (rep.status !== 'open') throw new HttpError(409, 'already_resolved', 'This report has already been resolved');
      let notified = false;
      if (b.action !== 'dismiss' && rep.share_id) {
        const s = (await t.query<{ file_id: string | null; user_id: string }>(`UPDATE shared_links SET disabled_by_admin = TRUE WHERE id = $1 RETURNING file_id, user_id`, [rep.share_id])).rows[0];
        if (s) {
          if (b.action === 'disable_link_and_file' && s.file_id) { // a folder link has no single file to block; the link itself is disabled
            await t.query(`UPDATE files SET sharing_disabled = TRUE WHERE id = $1`, [s.file_id]);
            await t.query(`UPDATE shared_links SET disabled_by_admin = TRUE WHERE file_id = $1`, [s.file_id]);
          }
          await t.query(`INSERT INTO notifications (user_id, kind, title, body) VALUES ($1, 'share_disabled', 'A share link was disabled', $2)`,
            [s.user_id, `An administrator disabled the link to "${rep.file_name ?? 'a file'}" after a report. ${b.action === 'disable_link_and_file' ? 'Sharing is turned off for this file.' : ''}`.trim()]);
          notified = true;
        }
      }
      await t.query(`UPDATE abuse_reports SET status = $2, resolved_by = $3, resolved_at = now(), resolution_note = $4 WHERE id = $1`,
        [id, b.action === 'dismiss' ? 'dismissed' : 'actioned', admin.userId, b.note ?? null]);
      await t.query(`INSERT INTO audit_logs (user_id, action, target, ip, metadata) VALUES ($1, 'admin.report_resolve', $2, $3, $4)`,
        [admin.userId, `report:${id}`, req.ip, JSON.stringify({ action: b.action, owner: rep.owner_id, ownerNotified: notified })]);
    });
    return { ok: true };
  });

  // ------------------------------------------------------------------ audit log
  app.get('/admin/audit', async (req) => {
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      before: z.coerce.number().int().positive().optional(),
      action: z.string().max(100).optional(),
      userId: uuid.optional(),
    }).parse(req.query);
    const rows = (await db.query<{ id: string; user_id: string | null; email: string | null; action: string; target: string | null; ip: string | null; metadata: object; created_at: string }>(
      `SELECT l.id, l.user_id, u.email, l.action, l.target, l.ip, l.metadata, l.created_at FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id
        WHERE ($1::bigint IS NULL OR l.id < $1) AND ($2::text IS NULL OR l.action LIKE $2 || '%') AND ($3::uuid IS NULL OR l.user_id = $3)
        ORDER BY l.id DESC LIMIT $4`, [q.before ?? null, q.action ?? null, q.userId ?? null, q.limit + 1])).rows;
    const items = rows.slice(0, q.limit);
    return {
      entries: items.map((e) => ({ id: Number(e.id), userId: e.user_id, email: e.email, action: e.action, target: e.target, ip: e.ip, metadata: e.metadata, at: e.created_at })),
      nextBefore: rows.length > q.limit ? Number(items[items.length - 1]!.id) : null,
    };
  });

  // ------------------------------------------------------------------ settings
  app.get('/admin/settings', async () => ({ settings: await settingsNow() }));

  app.patch('/admin/settings', async (req) => {
    const admin = requireAdmin(req);
    const body = z.record(z.string(), z.unknown()).parse(req.body);
    const changes: [SettingKey, unknown][] = [];
    for (const [k, v] of Object.entries(body)) {
      if (!(k in SETTINGS)) throw new HttpError(422, 'unknown_setting', `Unknown setting: ${k}`);
      const parsed = SETTINGS[k as SettingKey].safeParse(v);
      if (!parsed.success) throw new HttpError(422, 'invalid_setting', `Invalid value for ${k}`);
      changes.push([k as SettingKey, parsed.data]);
    }
    await db.tx(async (t) => {
      for (const [k, v] of changes) {
        await t.query(`INSERT INTO application_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [k, JSON.stringify(v)]);
      }
      if (changes.length) await t.query(`INSERT INTO audit_logs (user_id, action, ip, metadata) VALUES ($1, 'admin.settings_update', $2, $3)`, [admin.userId, req.ip, JSON.stringify(Object.fromEntries(changes))]);
    });
    return { settings: await settingsNow() };
  });
};
