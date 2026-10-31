import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { archiveKind, openArchive, type OpenArchive } from '../archives/service.js';
import { ArchiveError, safeEntryPath } from '../archives/types.js';
import { adapterFor, requireAuth, type Deps } from '../app.js';
import { HttpError, badRequest, notFound } from '../errors.js';
import { deleteObjects, freeName, insertFileRecord, type ObjectRef } from '../files/ops.js';
import { contentDisposition, validateName } from '../files/util.js';
import { StorageLimitError } from '../storage/types.js';

const uuid = z.string().uuid();

const STATUS: Record<ArchiveError['code'], number> = {
  not_an_archive: 422, too_many_entries: 413, encrypted: 422, unsupported: 415, too_large: 413, no_tool: 501, not_found: 404, tool_failed: 502,
};
const toHttp = (e: unknown): never => {
  if (e instanceof ArchiveError) throw new HttpError(STATUS[e.code], `archive_${e.code}`, e.message);
  throw e;
};

export const archiveRoutes = (deps: Deps): FastifyPluginAsync => async (app) => {
  const { db, storage, config } = deps;

  async function load(userId: string, id: string) {
    const f = (await db.query<{ id: string; name: string; size_bytes: number; storage_key: string; storage_provider_kind: string; sha256: string | null; folder_id: string | null }>(
      `SELECT id, name, size_bytes, storage_key, storage_provider_kind, sha256, folder_id FROM files WHERE id = $1 AND user_id = $2 AND status = 'ready' AND deleted_at IS NULL`, [id, userId])).rows[0];
    if (!f) throw notFound('File not found');
    if (!archiveKind(f.name)) throw new HttpError(415, 'archive_unsupported', 'This file type cannot be opened as an archive (ZIP, 7Z and RAR can)');
    return f;
  }
  const open = (f: Awaited<ReturnType<typeof load>>): Promise<OpenArchive> =>
    openArchive(adapterFor(deps, f.storage_provider_kind), { id: f.id, name: f.name, key: f.storage_key, size: Number(f.size_bytes), sha256: f.sha256 },
      { sevenZipPath: config.SEVENZIP_PATH, maxEntries: config.ARCHIVE_MAX_ENTRIES }).catch(toHttp);

  /** The table of contents, without unpacking anything. Entries with unusable paths are hidden. */
  app.get('/files/:id/archive', async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const f = await load(a.userId, id);
    const arc = await open(f);
    try {
      const entries = arc.entries.flatMap((e) => {
        const p = safeEntryPath(e.path);
        return p && !e.isLink ? [{ path: p, size: e.size, isDir: e.isDir, encrypted: e.encrypted, modifiedAt: e.modifiedAt }] : [];
      });
      return { name: f.name, kind: arc.kind, folderId: f.folder_id, entries, hidden: arc.entries.length - entries.length };
    } finally { await arc.close(); }
  });

  /** Downloads one file out of the archive. */
  app.get('/files/:id/archive/entry', async (req, reply) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { path: p } = z.object({ path: z.string().min(1).max(2000) }).parse(req.query);
    const f = await load(a.userId, id);
    const arc = await open(f);
    let stream;
    try {
      const entry = arc.entries.find((e) => e.path === p);
      if (!entry || entry.isDir) throw new ArchiveError('not_found', 'No such file in the archive');
      stream = await arc.open(p, Math.min(config.MAX_FILE_SIZE_BYTES, config.ARCHIVE_EXTRACT_MAX_BYTES)).catch(toHttp);
      reply.header('content-type', 'application/octet-stream').header('x-content-type-options', 'nosniff')
        .header('content-disposition', contentDisposition(path.posix.basename(p) || 'file'))
        .header('content-security-policy', "default-src 'none'; sandbox");
    } catch (e) { await arc.close(); return toHttp(e); }
    stream.once('close', () => void arc.close());
    return reply.send(stream);
  });

  /**
   * Unpacks the chosen entries (or everything) into a new folder. Guarded against zip bombs: a cap on the number of
   * files and bytes (and on free quota), the real size of every entry is counted while it is written, names are
   * cleaned (no ../, no absolute paths, no links), and a failure undoes the whole extraction.
   */
  app.post('/files/:id/archive/extract', async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      paths: z.array(z.string().min(1).max(2000)).max(5000).optional(),
      targetFolderId: uuid.nullable().default(null),
    }).parse(req.body ?? {});
    const f = await load(a.userId, id);
    if (b.targetFolderId) {
      const ok = (await db.query(`SELECT 1 FROM folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [b.targetFolderId, a.userId])).rowCount;
      if (!ok) throw notFound('Folder not found');
    }
    const arc = await open(f);
    const made: ObjectRef[] = []; const createdFolders: string[] = [];
    const skipped: { path: string; reason: string }[] = [];
    try {
      // Which entries: everything, or the chosen files and every file under a chosen folder
      const chosen = b.paths?.map((p) => p.replace(/\/+$/, ''));
      const wanted = arc.entries.filter((e) => !e.isDir && (!chosen || chosen.some((c) => e.path === c || e.path.startsWith(`${c}/`))));
      const todo: { entry: (typeof wanted)[number]; rel: string }[] = [];
      for (const e of wanted) {
        const rel = safeEntryPath(e.path);
        if (!rel) skipped.push({ path: e.path, reason: 'unsafe name' });
        else if (e.isLink) skipped.push({ path: e.path, reason: 'link' });
        else if (e.encrypted) skipped.push({ path: e.path, reason: 'password-protected' });
        else todo.push({ entry: e, rel });
      }
      if (todo.length === 0) throw badRequest('Nothing to extract', 'nothing_to_extract');
      if (todo.length > config.ARCHIVE_EXTRACT_MAX_FILES) throw new HttpError(413, 'archive_too_many_entries', `At most ${config.ARCHIVE_EXTRACT_MAX_FILES} files can be extracted at once; pick fewer`);
      const declared = todo.reduce((n, t) => n + t.entry.size, 0);
      const quota = (await db.query<{ quota_bytes: number; used_bytes: number }>(`SELECT quota_bytes, used_bytes FROM storage_quotas WHERE user_id = $1`, [a.userId])).rows[0];
      if (!quota) throw new HttpError(500, 'no_quota', 'Storage quota is not initialised for this account');
      let budget = Math.min(Math.max(0, quota.quota_bytes - quota.used_bytes), config.ARCHIVE_EXTRACT_MAX_BYTES);
      if (declared > budget) throw new HttpError(413, declared > config.ARCHIVE_EXTRACT_MAX_BYTES ? 'archive_too_large' : 'quota_exceeded',
        declared > config.ARCHIVE_EXTRACT_MAX_BYTES ? 'The unpacked size is over the limit for one extraction' : 'Not enough storage space to extract this');

      const base = f.name.replace(/\.[^.]+$/, '') || 'archive';
      const rootName = await freeName(db, a.userId, b.targetFolderId, validateName(base.slice(0, 200)), 'folders');
      const mk = async (parent: string | null, name: string) => {
        const n = await freeName(db, a.userId, parent, name, 'folders');
        const r = await db.query<{ id: string }>(`INSERT INTO folders (user_id, parent_id, name) VALUES ($1, $2, $3) RETURNING id`, [a.userId, parent, n]);
        createdFolders.push(r.rows[0]!.id);
        return r.rows[0]!.id;
      };
      const rootId = await mk(b.targetFolderId, rootName);
      const dirs = new Map<string, string>([['', rootId]]);
      const dirFor = async (segments: string[]): Promise<string> => {
        let cur = ''; let id2 = rootId;
        for (const s of segments) {
          cur = cur ? `${cur}/${s}` : s;
          let got = dirs.get(cur);
          if (!got) { got = await mk(id2, validateName(s)); dirs.set(cur, got); }
          id2 = got;
        }
        return id2;
      };

      let count = 0;
      for (const { entry, rel } of todo) {
        const segs = rel.split('/');
        let name: string; let parent: string;
        try { name = validateName(segs[segs.length - 1]!); parent = await dirFor(segs.slice(0, -1)); }
        catch { skipped.push({ path: entry.path, reason: 'invalid name' }); continue; }
        const fid = randomUUID();
        const key = `${fid.slice(0, 2)}/${fid.slice(2, 4)}/${fid}`;
        const cap = Math.min(budget, config.MAX_FILE_SIZE_BYTES);
        let put;
        try {
          const stream = await arc.open(entry.path, cap);
          put = await storage.put(key, stream, { maxBytes: cap });
        } catch (e) {
          await storage.delete(key).catch(() => undefined);
          if (e instanceof StorageLimitError || (e instanceof ArchiveError && e.code === 'too_large')) throw new HttpError(413, 'archive_too_large', `“${entry.path}” is bigger than allowed or the archive is larger than it says`);
          if (e instanceof ArchiveError && (e.code === 'encrypted' || e.code === 'unsupported')) { skipped.push({ path: entry.path, reason: e.message }); continue; }
          throw e;
        }
        made.push({ key, kind: storage.kind });
        budget -= put.size;
        await db.tx((t) => insertFileRecord(t, { id: fid, userId: a.userId, folderId: parent, name, onConflict: 'rename', size: put.size, sha256: put.sha256, key, kind: storage.kind }));
        count++;
      }
      return { folderId: rootId, folderName: rootName, files: count, skipped: skipped.slice(0, 100), skippedCount: skipped.length, declaredBytes: declared };
    } catch (e) {
      await db.tx(async (t) => {
        const r = await t.query<{ size_bytes: number }>(`DELETE FROM files WHERE user_id = $1 AND storage_key = ANY($2::text[]) RETURNING size_bytes`, [a.userId, made.map((m) => m.key)]);
        const freed = r.rows.reduce((n, x) => n + Number(x.size_bytes), 0);
        if (freed) await t.query(`UPDATE storage_quotas SET used_bytes = GREATEST(0, used_bytes - $2) WHERE user_id = $1`, [a.userId, freed]);
        if (createdFolders.length) await t.query(`DELETE FROM folders WHERE user_id = $1 AND id = ANY($2::uuid[])`, [a.userId, createdFolders]);
      }).catch((err) => app.log.error({ err }, 'extract rollback failed'));
      await deleteObjects(made, (k) => { try { return adapterFor(deps, k); } catch { return undefined; } }, (err, key) => app.log.error({ err, key }, 'object delete failed; reconciliation will retry'));
      return toHttp(e);
    } finally { await arc.close(); }
  });
};
