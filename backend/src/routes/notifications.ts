import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, type Deps } from '../app.js';
import { HttpError } from '../errors.js';
import { NOTIFICATION_KINDS } from '../notifications/kinds.js';

const uuid = z.string().uuid();
const listQuery = z.object({
  unread: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.string().datetime().optional(),
});

// Notifications the user muted in settings are hidden from the list and the unread count (they are kept, so unmuting brings them back).
const VISIBLE = `NOT (n.kind = ANY (COALESCE((SELECT muted_kinds FROM user_settings WHERE user_id = n.user_id), '{}')))`;

export const notificationRoutes = (deps: Deps): FastifyPluginAsync => async (app) => {
  const { db } = deps;

  app.get('/notifications', async (req) => {
    const a = requireAuth(req);
    const q = listQuery.parse(req.query);
    const rows = (await db.query<{ id: string; kind: string; title: string; body: string | null; read_at: string | null; created_at: string }>(
      `SELECT n.id, n.kind, n.title, n.body, n.read_at, n.created_at FROM notifications n
        WHERE n.user_id = $1 AND ${VISIBLE} AND ($2::boolean IS NOT TRUE OR n.read_at IS NULL) AND ($3::timestamptz IS NULL OR n.created_at < $3)
        ORDER BY n.created_at DESC LIMIT $4`, [a.userId, q.unread === 'true', q.before ?? null, q.limit + 1])).rows;
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, read: n.read_at !== null, createdAt: n.created_at })),
      nextBefore: rows.length > q.limit ? page[page.length - 1]!.created_at : null,
    };
  });

  app.get('/notifications/unread-count', async (req) => {
    const a = requireAuth(req);
    const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications n WHERE n.user_id = $1 AND n.read_at IS NULL AND ${VISIBLE}`, [a.userId]);
    return { unread: r.rows[0]!.n };
  });

  /** The kinds a user can mute, for the settings page. */
  app.get('/notifications/kinds', async () => ({ kinds: Object.entries(NOTIFICATION_KINDS).map(([kind, label]) => ({ kind, label })) }));

  app.post('/notifications/read-all', async (req) => {
    const a = requireAuth(req);
    const r = await db.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [a.userId]);
    return { updated: r.rowCount };
  });

  app.post('/notifications/:id/read', async (req) => {
    const a = requireAuth(req);
    const id = uuid.parse((req.params as { id: string }).id);
    const r = await db.query(`UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2`, [id, a.userId]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'Notification not found');
    return { ok: true };
  });

  app.delete('/notifications/:id', async (req) => {
    const a = requireAuth(req);
    const id = uuid.parse((req.params as { id: string }).id);
    const r = await db.query(`DELETE FROM notifications WHERE id = $1 AND user_id = $2`, [id, a.userId]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'Notification not found');
    return { ok: true };
  });

  app.delete('/notifications', async (req) => {
    const a = requireAuth(req);
    const r = await db.query(`DELETE FROM notifications WHERE user_id = $1 AND read_at IS NOT NULL`, [a.userId]);
    return { deleted: r.rowCount };
  });
};
