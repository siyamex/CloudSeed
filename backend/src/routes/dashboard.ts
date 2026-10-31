import type { FastifyPluginAsync } from 'fastify';
import { requireAuth, type Deps } from '../app.js';

/** Dashboard figures come straight from the database. Download/Telegram widgets are added with those features. */
export const dashboardRoutes = (deps: Deps): FastifyPluginAsync => async (app) => {
  const { db, storage } = deps;

  app.get('/dashboard', async (req) => {
    const a = requireAuth(req);
    const [quota, counts, recent, byType, unread, trash, dl, tgRecent, tgCounts] = await Promise.all([
      db.query<{ quota_bytes: number; used_bytes: number }>(`SELECT quota_bytes, used_bytes FROM storage_quotas WHERE user_id = $1`, [a.userId]),
      db.query<{ files: number; folders: number }>(
        `SELECT (SELECT count(*) FROM files WHERE user_id = $1 AND deleted_at IS NULL)::int AS files,
                (SELECT count(*) FROM folders WHERE user_id = $1 AND deleted_at IS NULL)::int AS folders`, [a.userId]),
      db.query<{ id: string; name: string; size_bytes: number; mime_type: string; created_at: string; folder_id: string | null }>(
        `SELECT id, name, size_bytes, mime_type, created_at, folder_id FROM files WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 8`, [a.userId]),
      db.query<{ category: string; bytes: number; files: number }>(
        `SELECT split_part(mime_type, '/', 1) AS category, COALESCE(sum(size_bytes), 0)::bigint AS bytes, count(*)::int AS files
           FROM files WHERE user_id = $1 AND deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC`, [a.userId]),
      db.query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [a.userId]),
      db.query<{ bytes: number; files: number }>(
        `SELECT COALESCE(sum(size_bytes), 0)::bigint AS bytes, count(*)::int AS files FROM files WHERE user_id = $1 AND deleted_at IS NOT NULL`, [a.userId]),
      db.query<{ active: number; waiting: number; paused: number; completed: number; failed: number }>(
        `SELECT count(*) FILTER (WHERE state IN ('resolving','downloading','verifying'))::int AS active,
                count(*) FILTER (WHERE state IN ('pending','queued'))::int AS waiting,
                count(*) FILTER (WHERE state = 'paused')::int AS paused,
                count(*) FILTER (WHERE state = 'completed')::int AS completed,
                count(*) FILTER (WHERE state = 'failed')::int AS failed
           FROM download_jobs WHERE user_id = $1`, [a.userId]),
      db.query<{ id: string; state: string; destination_title: string; created_at: string; total: number; first_name: string | null }>(
        `SELECT t.id, t.state, t.destination_title, t.created_at, s.total, s.first_name FROM telegram_transfers t
           LEFT JOIN LATERAL (SELECT count(*)::int AS total, min(name) FILTER (WHERE position = 0) AS first_name FROM telegram_transfer_files WHERE transfer_id = t.id) s ON TRUE
          WHERE t.user_id = $1 ORDER BY t.created_at DESC LIMIT 5`, [a.userId]),
      db.query<{ active: number; failed: number; bots: number }>(
        `SELECT (SELECT count(*) FROM telegram_transfers WHERE user_id = $1 AND state IN ('queued','uploading'))::int AS active,
                (SELECT count(*) FROM telegram_transfers WHERE user_id = $1 AND state IN ('failed','partial'))::int AS failed,
                (SELECT count(*) FROM telegram_bots WHERE user_id = $1 AND status <> 'disconnected')::int AS bots`, [a.userId]),
    ]);
    const q = quota.rows[0];
    const health = await storage.health();
    return {
      storage: {
        backend: storage.kind,
        quotaBytes: Number(q?.quota_bytes ?? 0),
        usedBytes: Number(q?.used_bytes ?? 0),
        availableBytes: Math.max(0, Number(q?.quota_bytes ?? 0) - Number(q?.used_bytes ?? 0)),
        healthy: health.ok,
        trashBytes: Number(trash.rows[0]?.bytes ?? 0),
        trashFiles: Number(trash.rows[0]?.files ?? 0),
      },
      counts: { files: Number(counts.rows[0]?.files ?? 0), folders: Number(counts.rows[0]?.folders ?? 0) },
      usageByType: byType.rows.map((r) => ({ category: r.category, bytes: Number(r.bytes), files: Number(r.files) })),
      recentFiles: recent.rows.map((f) => ({ id: f.id, name: f.name, size: Number(f.size_bytes), mimeType: f.mime_type, createdAt: f.created_at, folderId: f.folder_id })),
      downloads: {
        active: Number(dl.rows[0]?.active ?? 0), waiting: Number(dl.rows[0]?.waiting ?? 0), paused: Number(dl.rows[0]?.paused ?? 0),
        completed: Number(dl.rows[0]?.completed ?? 0), failed: Number(dl.rows[0]?.failed ?? 0),
      },
      telegram: {
        bots: Number(tgCounts.rows[0]?.bots ?? 0), active: Number(tgCounts.rows[0]?.active ?? 0), failed: Number(tgCounts.rows[0]?.failed ?? 0),
        recent: tgRecent.rows.map((t) => ({ id: t.id, state: t.state, destination: t.destination_title, files: Number(t.total), firstFileName: t.first_name, createdAt: t.created_at })),
      },
      unreadNotifications: Number(unread.rows[0]?.n ?? 0),
    };
  });
};
