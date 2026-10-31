import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { adapterFor, requireAuth, type Deps } from '../app.js';
import type { Db } from '../db/index.js';
import { HttpError, badRequest, conflict, notFound } from '../errors.js';
import { NIL, deleteObjects, descendantIds, freeName, insertFileRecord, trashFiles, trashFolders, type ObjectRef } from '../files/ops.js';
import { TYPE_FILTERS, contentDisposition, mimeFromName, parseRange, sanitizeName, validateName } from '../files/util.js';
import { StorageLimitError } from '../storage/types.js';

const uuid = z.string().uuid();
const isUnique = (e: unknown) => (e as { code?: string })?.code === '23505';

interface FileRow {
  id: string; folder_id: string | null; name: string; size_bytes: number; mime_type: string;
  created_at: string; updated_at: string; sharing_disabled?: boolean;
}
const fileDto = (r: FileRow) => ({
  id: r.id, folderId: r.folder_id, name: r.name, size: Number(r.size_bytes), mimeType: r.mime_type,
  createdAt: r.created_at, updatedAt: r.updated_at, sharingDisabled: r.sharing_disabled ?? false,
});

const SORTS: Record<string, { expr: string; cast: string }> = {
  name: { expr: 'lower(name)', cast: 'text' },
  size: { expr: 'size_bytes', cast: 'bigint' },
  date: { expr: 'created_at', cast: 'timestamptz' },
  type: { expr: 'mime_type', cast: 'text' },
};

export const fileRoutes = (deps: Deps): FastifyPluginAsync => async (app) => {
  const { db, storage, config } = deps;

  async function ownedFolder(d: Db, userId: string, id: string) {
    const r = await d.query<{ id: string; parent_id: string | null; name: string }>(
      `SELECT id, parent_id, name FROM folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [id, userId]);
    if (!r.rows[0]) throw notFound('Folder not found');
    return r.rows[0];
  }

  const removeObjects = (refs: ObjectRef[]) =>
    deleteObjects(refs, (k) => { try { return adapterFor(deps, k); } catch { return undefined; } },
      (err, key) => app.log.error({ err, key }, 'object delete failed; reconciliation will retry'));

  // ---- listing & search ----
  app.get('/files', async (req) => {
    const a = requireAuth(req);
    const q = z.object({
      folder: z.union([z.literal('root'), uuid]).default('root'),
      q: z.string().max(200).optional(),
      type: z.enum(['image', 'video', 'audio', 'text', 'pdf', 'archive']).optional(),
      sort: z.enum(['name', 'size', 'date', 'type']).default('name'),
      dir: z.enum(['asc', 'desc']).default('asc'),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      cursor: z.string().max(500).optional(),
    }).parse(req.query);

    const searching = !!q.q;
    const folderId = q.folder === 'root' ? null : q.folder;
    const crumbs: { id: string; name: string }[] = [];
    if (folderId && !searching) {
      await ownedFolder(db, a.userId, folderId);
      const r = await db.query<{ id: string; name: string }>(
        `WITH RECURSIVE up AS (
           SELECT id, parent_id, name, 0 AS depth FROM folders WHERE id = $1 AND user_id = $2
           UNION ALL SELECT f.id, f.parent_id, f.name, up.depth + 1 FROM folders f JOIN up ON f.id = up.parent_id WHERE f.user_id = $2)
         SELECT id, name FROM up ORDER BY depth DESC`, [folderId, a.userId]);
      crumbs.push(...r.rows);
    }

    const like = q.q ? `%${q.q.replace(/[\\%_]/g, '\\$&')}%` : null;

    // Folders are returned in full on the first page only; files are keyset-paginated.
    let folders: { id: string; parentId: string | null; name: string; createdAt: string }[] = [];
    if (!q.cursor && !q.type) {
      const r = await db.query<{ id: string; parent_id: string | null; name: string; created_at: string }>(
        searching
          ? `SELECT id, parent_id, name, created_at FROM folders WHERE user_id = $1 AND deleted_at IS NULL AND name ILIKE $2 ORDER BY lower(name) LIMIT 200`
          : `SELECT id, parent_id, name, created_at FROM folders WHERE user_id = $1 AND deleted_at IS NULL AND COALESCE(parent_id, $3::uuid) = COALESCE($2::uuid, $3::uuid) ORDER BY lower(name)`,
        searching ? [a.userId, like] : [a.userId, folderId, NIL]);
      folders = r.rows.map((f) => ({ id: f.id, parentId: f.parent_id, name: f.name, createdAt: f.created_at }));
    }

    const s = SORTS[q.sort]!;
    const op = q.dir === 'asc' ? '>' : '<';
    const params: unknown[] = [a.userId];
    const where = ['user_id = $1', 'deleted_at IS NULL'];
    if (searching) { params.push(like); where.push(`name ILIKE $${params.length}`); }
    else { params.push(folderId, NIL); where.push(`COALESCE(folder_id, $${params.length}::uuid) = COALESCE($${params.length - 1}::uuid, $${params.length}::uuid)`); }
    if (q.type) {
      params.push(TYPE_FILTERS[q.type]);
      where.push(`mime_type LIKE ANY($${params.length}::text[])`);
    }
    if (q.cursor) {
      let c: { v: string; id: string };
      try { c = z.object({ v: z.string(), id: uuid }).parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString())); }
      catch { throw badRequest('Invalid cursor', 'invalid_cursor'); }
      params.push(c.v, c.id);
      where.push(`(${s.expr}, id) ${op} ($${params.length - 1}::${s.cast}, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    const rows = (await db.query<FileRow & { sort_v: string }>(
      `SELECT id, folder_id, name, size_bytes, mime_type, created_at, updated_at, sharing_disabled, (${s.expr})::text AS sort_v
         FROM files WHERE ${where.join(' AND ')}
        ORDER BY ${s.expr} ${q.dir}, id ${q.dir} LIMIT $${params.length}`, params)).rows;

    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > q.limit && last
      ? Buffer.from(JSON.stringify({ v: last.sort_v, id: last.id })).toString('base64url') : null;
    return { folderId, breadcrumbs: crumbs, folders, files: page.map(fileDto), nextCursor };
  });

  // ---- folders ----
  /** Flat list of all live folders (for destination pickers); the client builds paths from parentId. */
  app.get('/folders', async (req) => {
    const a = requireAuth(req);
    const r = await db.query<{ id: string; parent_id: string | null; name: string }>(
      `SELECT id, parent_id, name FROM folders WHERE user_id = $1 AND deleted_at IS NULL ORDER BY lower(name) LIMIT 2000`, [a.userId]);
    return { folders: r.rows.map((f) => ({ id: f.id, parentId: f.parent_id, name: f.name })) };
  });

  app.post('/folders', async (req, reply) => {
    const a = requireAuth(req);
    const b = z.object({ name: z.string(), parentId: uuid.nullable().default(null) }).parse(req.body);
    const name = validateName(b.name);
    if (b.parentId) await ownedFolder(db, a.userId, b.parentId);
    try {
      const r = await db.query<{ id: string; created_at: string }>(
        `INSERT INTO folders (user_id, parent_id, name) VALUES ($1, $2, $3) RETURNING id, created_at`, [a.userId, b.parentId, name]);
      return reply.status(201).send({ id: r.rows[0]!.id, parentId: b.parentId, name, createdAt: r.rows[0]!.created_at });
    } catch (e) {
      if (isUnique(e)) throw conflict('A folder with that name already exists here', 'name_conflict');
      throw e;
    }
  });

  app.patch('/folders/:id', async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ name: z.string().optional(), parentId: uuid.nullable().optional() }).parse(req.body);
    const cur = await ownedFolder(db, a.userId, id);
    const name = b.name !== undefined ? validateName(b.name) : cur.name;
    const parentId = b.parentId !== undefined ? b.parentId : cur.parent_id;
    if (parentId) {
      await ownedFolder(db, a.userId, parentId);
      if ((await descendantIds(db, a.userId, [id])).includes(parentId)) throw badRequest('Cannot move a folder into itself or its subfolder', 'invalid_move');
    }
    try {
      await db.query(`UPDATE folders SET name = $3, parent_id = $4, updated_at = now() WHERE id = $1 AND user_id = $2`, [id, a.userId, name, parentId]);
    } catch (e) {
      if (isUnique(e)) throw conflict('A folder with that name already exists there', 'name_conflict');
      throw e;
    }
    return { id, parentId, name };
  });

  /** Moves a folder (and everything in it) to the trash. */
  app.delete('/folders/:id', async (req, reply) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await ownedFolder(db, a.userId, id);
    await db.tx((t) => trashFolders(t, a.userId, [id]));
    return reply.status(204).send();
  });

  // ---- files ----
  app.post('/files/upload', async (req, reply) => {
    const a = requireAuth(req);
    const q = z.object({
      folder: z.union([z.literal('root'), uuid]).default('root'),
      onConflict: z.enum(['reject', 'rename', 'replace']).default('reject'),
    }).parse(req.query);
    const folderId = q.folder === 'root' ? null : q.folder;
    if (folderId) await ownedFolder(db, a.userId, folderId);

    const part = await req.file();
    if (!part) throw badRequest('No file provided', 'no_file');
    const name = sanitizeName(part.filename);

    const quota = (await db.query<{ quota_bytes: number; used_bytes: number }>(
      `SELECT quota_bytes, used_bytes FROM storage_quotas WHERE user_id = $1`, [a.userId])).rows[0];
    if (!quota) throw new HttpError(500, 'no_quota', 'Storage quota is not initialised for this account');
    const free = Math.max(0, quota.quota_bytes - quota.used_bytes);
    const maxBytes = Math.min(config.MAX_FILE_SIZE_BYTES, free);

    const id = randomUUID();
    const key = `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}`;
    let put;
    try { put = await storage.put(key, part.file, { maxBytes }); }
    catch (e) {
      if (e instanceof StorageLimitError) {
        throw new HttpError(413, free < config.MAX_FILE_SIZE_BYTES ? 'quota_exceeded' : 'file_too_large',
          free < config.MAX_FILE_SIZE_BYTES ? 'Not enough storage space for this file' : 'File exceeds the maximum allowed size');
      }
      throw e;
    }

    try {
      const { row, replaced } = await db.tx((t) => insertFileRecord(t, {
        id, userId: a.userId, folderId, name, onConflict: q.onConflict, size: put.size, sha256: put.sha256, key, kind: storage.kind,
      }));
      await removeObjects(replaced);
      return reply.status(201).send(fileDto(row));
    } catch (e) {
      await storage.delete(key).catch(() => undefined);
      throw e;
    }
  });

  app.get('/files/:id/content', async (req, reply) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await db.query<{ name: string; size_bytes: number; mime_type: string; storage_key: string; storage_provider_kind: string; sha256: string | null }>(
      `SELECT name, size_bytes, mime_type, storage_key, storage_provider_kind, sha256
         FROM files WHERE id = $1 AND user_id = $2 AND status = 'ready' AND deleted_at IS NULL`, [id, a.userId]);
    const f = r.rows[0];
    if (!f) throw notFound('File not found');
    const adapter = adapterFor(deps, f.storage_provider_kind);
    const size = Number(f.size_bytes);
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') return reply.status(416).header('content-range', `bytes */${size}`).send();

    reply.header('accept-ranges', 'bytes')
      .header('content-disposition', contentDisposition(f.name))
      .header('content-type', f.mime_type)
      .header('content-security-policy', "default-src 'none'; sandbox");
    if (f.sha256) reply.header('etag', `"${f.sha256}"`);
    if (range) {
      reply.status(206).header('content-range', `bytes ${range.start}-${range.end}/${size}`).header('content-length', range.end - range.start + 1);
      return reply.send(await adapter.get(f.storage_key, range));
    }
    reply.header('content-length', size);
    return reply.send(await adapter.get(f.storage_key));
  });

  app.patch('/files/:id', async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ name: z.string().optional(), folderId: uuid.nullable().optional(), sharingDisabled: z.boolean().optional() }).parse(req.body);
    const cur = (await db.query<{ name: string; folder_id: string | null }>(
      `SELECT name, folder_id FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [id, a.userId])).rows[0];
    if (!cur) throw notFound('File not found');
    const name = b.name !== undefined ? validateName(b.name) : cur.name;
    const folderId = b.folderId !== undefined ? b.folderId : cur.folder_id;
    if (folderId) await ownedFolder(db, a.userId, folderId);
    try {
      await db.query(`UPDATE files SET name = $3, folder_id = $4, mime_type = $5, updated_at = now() WHERE id = $1 AND user_id = $2`,
        [id, a.userId, name, folderId, mimeFromName(name)]);
    } catch (e) {
      if (isUnique(e)) throw conflict('A file with that name already exists there', 'name_conflict');
      throw e;
    }
    if (b.sharingDisabled !== undefined) {
      await db.tx(async (t) => {
        await t.query(`UPDATE files SET sharing_disabled = $3 WHERE id = $1 AND user_id = $2`, [id, a.userId, b.sharingDisabled]);
        if (b.sharingDisabled) await t.query(`UPDATE shared_links SET revoked_at = COALESCE(revoked_at, now()) WHERE file_id = $1`, [id]);
      });
    }
    return { id, name, folderId, ...(b.sharingDisabled !== undefined ? { sharingDisabled: b.sharingDisabled } : {}) };
  });

  /** Moves a file to the trash (it keeps counting toward quota until purged). */
  app.delete('/files/:id', async (req, reply) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const n = await db.tx((t) => trashFiles(t, a.userId, [id]));
    if (n === 0) throw notFound('File not found');
    return reply.status(204).send();
  });

  /**
   * Copies files and folders (with everything inside) into another folder. Each copy is a separate stored object, so
   * deleting or editing one never touches the other. Names that clash are numbered ("a (1).txt"). The quota is checked
   * up front for the whole job and again per file; a partial copy is rolled back file by file when something fails.
   */
  app.post('/files/copy', async (req) => {
    const a = requireAuth(req);
    const b = z.object({
      fileIds: z.array(uuid).max(500).default([]), folderIds: z.array(uuid).max(100).default([]),
      targetFolderId: uuid.nullable().default(null),
    }).parse(req.body);
    if (b.targetFolderId) await ownedFolder(db, a.userId, b.targetFolderId);
    // Everything to copy: chosen files, plus every file inside the chosen folders
    const allFolders = b.folderIds.length ? await descendantIds(db, a.userId, b.folderIds) : [];
    if (b.targetFolderId && allFolders.includes(b.targetFolderId)) throw badRequest('Cannot copy a folder into itself', 'invalid_copy');
    const srcFiles = (await db.query<{ id: string; folder_id: string | null; name: string; size_bytes: number; storage_key: string; storage_provider_kind: string }>(
      `SELECT id, folder_id, name, size_bytes, storage_key, storage_provider_kind FROM files
        WHERE user_id = $1 AND deleted_at IS NULL AND status = 'ready'
          AND (id = ANY($2::uuid[]) OR folder_id = ANY($3::uuid[])) ORDER BY id`, [a.userId, b.fileIds, allFolders])).rows;
    if (srcFiles.length > 2000) throw badRequest('Too many files to copy at once (limit 2000)', 'too_many');
    const total = srcFiles.reduce((n, f) => n + Number(f.size_bytes), 0);
    const quota = (await db.query<{ quota_bytes: number; used_bytes: number }>(`SELECT quota_bytes, used_bytes FROM storage_quotas WHERE user_id = $1`, [a.userId])).rows[0];
    if (!quota) throw new HttpError(500, 'no_quota', 'Storage quota is not initialised for this account');
    if (total > Math.max(0, quota.quota_bytes - quota.used_bytes)) throw new HttpError(413, 'quota_exceeded', 'Not enough storage space to copy this');

    const folderRows = allFolders.length ? (await db.query<{ id: string; parent_id: string | null; name: string }>(
      `SELECT id, parent_id, name FROM folders WHERE user_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`, [a.userId, allFolders])).rows : [];
    const made: ObjectRef[] = [];
    const createdFolders: string[] = [];
    let copiedFiles = 0;
    const copyOne = async (f: (typeof srcFiles)[number], dest: string | null) => {
      const id = randomUUID();
      const key = `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}`;
      const put = await storage.put(key, await adapterFor(deps, f.storage_provider_kind).get(f.storage_key), { maxBytes: Number(f.size_bytes) + 1 });
      made.push({ key, kind: storage.kind });
      await db.tx((t) => insertFileRecord(t, { id, userId: a.userId, folderId: dest, name: f.name, onConflict: 'rename', size: put.size, sha256: put.sha256, key, kind: storage.kind }));
      copiedFiles++;
    };
    try {
      // Folders first (parents before children), remembering where each copy landed
      const destOf = new Map<string, string | null>();
      const byParent = (p: string | null) => folderRows.filter((f) => (f.parent_id ?? null) === p);
      const copyTree = async (src: { id: string; name: string }, parent: string | null) => {
        const name = await freeName(db, a.userId, parent, src.name, 'folders');
        const ins = await db.query<{ id: string }>(`INSERT INTO folders (user_id, parent_id, name) VALUES ($1, $2, $3) RETURNING id`, [a.userId, parent, name]);
        const newId = ins.rows[0]!.id;
        createdFolders.push(newId);
        destOf.set(src.id, newId);
        for (const child of byParent(src.id)) await copyTree(child, newId);
      };
      for (const id of b.folderIds) {
        const f = folderRows.find((r) => r.id === id);
        if (f) await copyTree(f, b.targetFolderId);
      }
      for (const f of srcFiles) {
        const dest = b.fileIds.includes(f.id) && !(f.folder_id && destOf.has(f.folder_id)) ? b.targetFolderId : destOf.get(f.folder_id ?? '');
        if (dest === undefined) continue;
        await copyOne(f, dest);
      }
    } catch (e) {
      // Undo: delete the new objects, rows, and quota charge
      await db.tx(async (t) => {
        const r = await t.query<{ size_bytes: number }>(`DELETE FROM files WHERE user_id = $1 AND storage_key = ANY($2::text[]) RETURNING size_bytes`, [a.userId, made.map((m) => m.key)]);
        const freed = r.rows.reduce((n, x) => n + Number(x.size_bytes), 0);
        if (freed) await t.query(`UPDATE storage_quotas SET used_bytes = GREATEST(0, used_bytes - $2) WHERE user_id = $1`, [a.userId, freed]);
        await t.query(`DELETE FROM folders WHERE user_id = $1 AND id = ANY($2::uuid[])`, [a.userId, createdFolders]);
      }).catch((err) => app.log.error({ err }, 'copy rollback failed'));
      await removeObjects(made);
      throw e;
    }
    return { copiedFiles, copiedFolders: createdFolders.length };
  });

  app.post('/files/bulk-delete', async (req) => {
    const a = requireAuth(req);
    const b = z.object({ fileIds: z.array(uuid).max(500).default([]), folderIds: z.array(uuid).max(500).default([]) }).parse(req.body);
    return db.tx(async (t) => ({
      trashedFolders: await trashFolders(t, a.userId, b.folderIds),
      trashedFiles: await trashFiles(t, a.userId, b.fileIds),
    }));
  });
};
