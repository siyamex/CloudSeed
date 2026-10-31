import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { adapterFor, requireAuth, type Deps } from '../app.js';
import { deleteObjects, purgeFiles, purgeFolders, restoreFile, restoreFolder } from '../files/ops.js';

const uuid = z.string().uuid();
const idsBody = z.object({ fileIds: z.array(uuid).max(500).default([]), folderIds: z.array(uuid).max(500).default([]) });

export const trashRoutes = (deps: Deps): FastifyPluginAsync => async (app) => {
  const { db, config } = deps;

  const removeObjects = (refs: Parameters<typeof deleteObjects>[0]) =>
    deleteObjects(refs, (k) => { try { return adapterFor(deps, k); } catch { return undefined; } },
      (err, key) => app.log.error({ err, key }, 'object delete failed; reconciliation will retry'));

  /** Top-level trashed items only: children trashed together with a parent come back with it. */
  app.get('/trash', async (req) => {
    const a = requireAuth(req);
    const [folders, files] = await Promise.all([
      db.query<{ id: string; name: string; deleted_at: string }>(
        `SELECT f.id, f.name, f.deleted_at FROM folders f
          WHERE f.user_id = $1 AND f.deleted_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM folders p WHERE p.id = f.parent_id AND p.deleted_at = f.deleted_at)
          ORDER BY f.deleted_at DESC LIMIT 500`, [a.userId]),
      db.query<{ id: string; name: string; size_bytes: number; mime_type: string; deleted_at: string }>(
        `SELECT f.id, f.name, f.size_bytes, f.mime_type, f.deleted_at FROM files f
          WHERE f.user_id = $1 AND f.deleted_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM folders p WHERE p.id = f.folder_id AND p.deleted_at = f.deleted_at)
          ORDER BY f.deleted_at DESC LIMIT 500`, [a.userId]),
    ]);
    const days = config.TRASH_RETENTION_DAYS;
    const expires = (d: string) => (days > 0 ? new Date(new Date(d).getTime() + days * 86_400_000).toISOString() : null);
    return {
      retentionDays: days,
      folders: folders.rows.map((f) => ({ id: f.id, name: f.name, deletedAt: f.deleted_at, expiresAt: expires(f.deleted_at) })),
      files: files.rows.map((f) => ({ id: f.id, name: f.name, size: Number(f.size_bytes), mimeType: f.mime_type, deletedAt: f.deleted_at, expiresAt: expires(f.deleted_at) })),
    };
  });

  app.post('/trash/restore', async (req) => {
    const a = requireAuth(req);
    const b = idsBody.parse(req.body);
    return db.tx(async (t) => {
      let restored = 0;
      for (const id of b.folderIds) if (await restoreFolder(t, a.userId, id)) restored++;
      for (const id of b.fileIds) if (await restoreFile(t, a.userId, id)) restored++;
      return { restored };
    });
  });

  /** Permanent deletion; only items already in the trash can be purged. */
  app.post('/trash/purge', async (req) => {
    const a = requireAuth(req);
    const b = idsBody.parse(req.body);
    const refs = await db.tx(async (t) => {
      const trashed = b.folderIds.length
        ? (await t.query<{ id: string }>(`SELECT id FROM folders WHERE user_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NOT NULL`, [a.userId, b.folderIds])).rows.map((r) => r.id)
        : [];
      const out = await purgeFolders(t, a.userId, trashed);
      if (b.fileIds.length) out.push(...await purgeFiles(t, a.userId, `id = ANY($2::uuid[]) AND deleted_at IS NOT NULL`, [b.fileIds]));
      return out;
    });
    await removeObjects(refs);
    return { purgedFiles: refs.length };
  });

  app.post('/trash/empty', async (req) => {
    const a = requireAuth(req);
    const refs = await db.tx(async (t) => {
      const ids = (await t.query<{ id: string }>(`SELECT id FROM folders WHERE user_id = $1 AND deleted_at IS NOT NULL`, [a.userId])).rows.map((r) => r.id);
      const out = await purgeFolders(t, a.userId, ids);
      out.push(...await purgeFiles(t, a.userId, `deleted_at IS NOT NULL`, []));
      return out;
    });
    await removeObjects(refs);
    return { purgedFiles: refs.length };
  });
};
