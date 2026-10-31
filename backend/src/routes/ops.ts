import type { FastifyPluginAsync } from 'fastify';
import { safeEqual } from '../auth/session.js';
import type { Deps } from '../app.js';
import { gauge, type HttpMetrics } from '../metrics.js';

/** Health and metrics endpoints for load balancers and monitoring. They carry no per-user data. */
export const opsRoutes = (deps: Deps, metrics: HttpMetrics): FastifyPluginAsync => async (app) => {
  const { db, config } = deps;

  /** Ready = the database answers. Workers are reported but do not fail readiness: the web app works without them. */
  app.get('/health/ready', async (_req, reply) => {
    try {
      await db.query('SELECT 1');
      const w = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM worker_heartbeats WHERE last_seen_at > now() - interval '60 seconds'`);
      return { status: 'ok', database: 'ok', workers: w.rows[0]!.n };
    } catch {
      return reply.status(503).send({ status: 'unavailable', database: 'down' });
    }
  });

  app.get('/metrics', async (req, reply) => {
    // Disabled unless a token is configured; the endpoint should not even appear to exist otherwise.
    if (!config.METRICS_TOKEN) return reply.status(404).send({ error: { code: 'not_found', message: 'Route not found', requestId: req.id } });
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!m || !safeEqual(m[1]!, config.METRICS_TOKEN)) {
      return reply.status(401).header('www-authenticate', 'Bearer').send({ error: { code: 'unauthorized', message: 'A valid bearer token is required', requestId: req.id } });
    }
    const rows = async (sql: string): Promise<[string, number][]> => (await db.query<{ k: string; n: number }>(sql)).rows.map((r) => [r.k, Number(r.n)]);
    const [users, files, used, quota, shares, reports, dl, tg, tor, md, workers] = await Promise.all([
      rows(`SELECT status AS k, count(*)::int AS n FROM users WHERE status <> 'deleted' GROUP BY status`),
      rows(`SELECT 'all' AS k, count(*)::int AS n FROM files WHERE deleted_at IS NULL`),
      rows(`SELECT 'all' AS k, COALESCE(sum(used_bytes),0)::bigint AS n FROM storage_quotas`),
      rows(`SELECT 'all' AS k, COALESCE(sum(quota_bytes),0)::bigint AS n FROM storage_quotas`),
      rows(`SELECT 'active' AS k, count(*)::int AS n FROM shared_links WHERE revoked_at IS NULL AND NOT disabled_by_admin AND expires_at > now()`),
      rows(`SELECT 'open' AS k, count(*)::int AS n FROM abuse_reports WHERE status = 'open'`),
      rows(`SELECT state AS k, count(*)::int AS n FROM download_jobs GROUP BY state`),
      rows(`SELECT state AS k, count(*)::int AS n FROM telegram_transfers GROUP BY state`),
      rows(`SELECT state AS k, count(*)::int AS n FROM torrent_jobs GROUP BY state`),
      rows(`SELECT status AS k, count(*)::int AS n FROM media_assets GROUP BY status`),
      rows(`SELECT role AS k, count(*)::int AS n FROM worker_heartbeats WHERE last_seen_at > now() - interval '60 seconds' GROUP BY role`),
    ]);
    const backupTs = await rows(`SELECT 'last' AS k, COALESCE(extract(epoch FROM max(finished_at)), 0)::bigint AS n FROM backup_runs WHERE status = 'succeeded' AND verified`);
    const body = metrics.render()
      + gauge('cloudseed_users', 'Users by status.', 'status', users)
      + gauge('cloudseed_files', 'Files that are not in the trash.', null, files.map((r) => ['', r[1]]))
      + gauge('cloudseed_storage_used_bytes', 'Bytes charged to user quotas.', null, used.map((r) => ['', r[1]]))
      + gauge('cloudseed_storage_quota_bytes', 'Sum of all user quotas.', null, quota.map((r) => ['', r[1]]))
      + gauge('cloudseed_share_links_active', 'Share links that are currently usable.', null, shares.map((r) => ['', r[1]]))
      + gauge('cloudseed_abuse_reports_open', 'Abuse reports waiting for review.', null, reports.map((r) => ['', r[1]]))
      + gauge('cloudseed_download_jobs', 'Download jobs by state.', 'state', dl)
      + gauge('cloudseed_telegram_transfers', 'Telegram transfers by state.', 'state', tg)
      + gauge('cloudseed_torrent_jobs', 'Torrent jobs by state.', 'state', tor)
      + gauge('cloudseed_media_assets', 'Derived media assets by state.', 'status', md)
      + gauge('cloudseed_backup_last_success_timestamp_seconds', 'Unix time of the last successful, verified backup (0 = never).', null, backupTs.map((r) => ['', r[1]]))
      + gauge('cloudseed_workers_alive', 'Worker processes that sent a heartbeat in the last minute.', 'role', workers);
    return reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8').header('cache-control', 'no-store').send(body);
  });
};
