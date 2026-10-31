import type { Db } from '../db/index.js';
import { HttpError, conflict } from '../errors.js';
import { formatFor } from '../media/classify.js';
import { mimeFromName, numberedName } from './util.js';
import type { StorageAdapter } from '../storage/types.js';

export const NIL = '00000000-0000-0000-0000-000000000000';

export interface ObjectRef { key: string; kind: string }

/** All folder ids at or below `ids` (owned by userId), regardless of trash state. */
export async function descendantIds(d: Db, userId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const r = await d.query<{ id: string }>(
    `WITH RECURSIVE t AS (
       SELECT id FROM folders WHERE user_id = $1 AND id = ANY($2::uuid[])
       UNION SELECT f.id FROM folders f JOIN t ON f.parent_id = t.id WHERE f.user_id = $1)
     SELECT id FROM t`, [userId, ids]);
  return r.rows.map((x) => x.id);
}

/**
 * Permanently removes file rows plus their derived media assets (thumbnails, subtitles, renditions), releases the quota
 * both used, and returns the objects to delete once the transaction commits.
 */
export async function purgeFiles(t: Db, userId: string, where: string, params: unknown[]): Promise<ObjectRef[]> {
  const assets = await t.query<{ size_bytes: number; storage_key: string | null; storage_provider_kind: string | null }>(
    `DELETE FROM media_assets WHERE file_id IN (SELECT id FROM files WHERE user_id = $1 AND ${where}) RETURNING size_bytes, storage_key, storage_provider_kind`, [userId, ...params]);
  const r = await t.query<{ size_bytes: number; storage_key: string; storage_provider_kind: string }>(
    `DELETE FROM files WHERE user_id = $1 AND ${where} RETURNING size_bytes, storage_key, storage_provider_kind`, [userId, ...params]);
  const total = r.rows.reduce((s, x) => s + Number(x.size_bytes), 0) + assets.rows.reduce((s, x) => s + Number(x.size_bytes), 0);
  if (total > 0) await t.query(`UPDATE storage_quotas SET used_bytes = GREATEST(0, used_bytes - $2) WHERE user_id = $1`, [userId, total]);
  return [
    ...r.rows.map((x) => ({ key: x.storage_key, kind: x.storage_provider_kind })),
    ...assets.rows.filter((x) => x.storage_key && x.storage_provider_kind).map((x) => ({ key: x.storage_key!, kind: x.storage_provider_kind! })),
  ];
}

export async function purgeFolders(t: Db, userId: string, ids: string[]): Promise<ObjectRef[]> {
  const all = await descendantIds(t, userId, ids);
  if (all.length === 0) return [];
  const refs = await purgeFiles(t, userId, `folder_id = ANY($2::uuid[])`, [all]);
  await t.query(`DELETE FROM folders WHERE user_id = $1 AND id = ANY($2::uuid[])`, [userId, all]);
  return refs;
}

/** Best effort: a failed delete leaves an orphan object, never a dangling row. */
export async function deleteObjects(refs: ObjectRef[], adapterFor: (kind: string) => StorageAdapter | undefined, log: (err: unknown, key: string) => void) {
  for (const r of refs) {
    try { await adapterFor(r.kind)?.delete(r.key); } catch (err) { log(err, r.key); }
  }
}

export async function freeName(d: Db, userId: string, parentId: string | null, name: string, table: 'files' | 'folders') {
  const col = table === 'files' ? 'folder_id' : 'parent_id';
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? name : numberedName(name, n);
    const r = await d.query(
      `SELECT 1 FROM ${table} WHERE user_id = $1 AND deleted_at IS NULL AND COALESCE(${col}, $2::uuid) = COALESCE($3::uuid, $2::uuid) AND lower(name) = lower($4)`,
      [userId, NIL, parentId, candidate]);
    if (r.rowCount === 0) return candidate;
  }
  throw conflict('Could not find a free name', 'name_conflict');
}

// ---- trash ----
// Trashing a folder stamps the folder, all descendant folders and their files with the same
// deleted_at (one transaction => one now()). Items sharing the stamp with their parent are hidden
// from the trash list and come back together with it.

export async function trashFiles(t: Db, userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await t.query(`UPDATE files SET deleted_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`, [userId, ids]);
  return r.rowCount;
}

export async function trashFolders(t: Db, userId: string, ids: string[]): Promise<number> {
  const live = (await t.query<{ id: string }>(
    `SELECT id FROM folders WHERE user_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`, [userId, ids])).rows.map((r) => r.id);
  const all = await descendantIds(t, userId, live);
  if (all.length === 0) return 0;
  await t.query(`UPDATE files SET deleted_at = now() WHERE user_id = $1 AND folder_id = ANY($2::uuid[]) AND deleted_at IS NULL`, [userId, all]);
  await t.query(`UPDATE folders SET deleted_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`, [userId, all]);
  return live.length;
}

export async function restoreFile(t: Db, userId: string, id: string): Promise<boolean> {
  const f = (await t.query<{ name: string; folder_id: string | null; parent_live: boolean | null }>(
    `SELECT f.name, f.folder_id, (p.id IS NOT NULL AND p.deleted_at IS NULL) AS parent_live
       FROM files f LEFT JOIN folders p ON p.id = f.folder_id
      WHERE f.id = $1 AND f.user_id = $2 AND f.deleted_at IS NOT NULL`, [id, userId])).rows[0];
  if (!f) return false;
  const folderId = f.folder_id && f.parent_live ? f.folder_id : null; // parent gone/trashed -> root
  const name = await freeName(t, userId, folderId, f.name, 'files');
  await t.query(`UPDATE files SET deleted_at = NULL, folder_id = $3, name = $4, updated_at = now() WHERE id = $1 AND user_id = $2`, [id, userId, folderId, name]);
  return true;
}

export async function restoreFolder(t: Db, userId: string, id: string): Promise<boolean> {
  const f = (await t.query<{ name: string; parent_id: string | null; parent_live: boolean | null }>(
    `SELECT f.name, f.parent_id, (p.id IS NOT NULL AND p.deleted_at IS NULL) AS parent_live
       FROM folders f LEFT JOIN folders p ON p.id = f.parent_id
      WHERE f.id = $1 AND f.user_id = $2 AND f.deleted_at IS NOT NULL`, [id, userId])).rows[0];
  if (!f) return false;
  // Descendants that were trashed together with this folder (identical stamp) come back with it.
  const group = (await t.query<{ id: string }>(
    `WITH RECURSIVE g AS (
       SELECT id FROM folders WHERE id = $2 AND user_id = $1
       UNION SELECT c.id FROM folders c JOIN g ON c.parent_id = g.id
        WHERE c.user_id = $1 AND c.deleted_at = (SELECT deleted_at FROM folders WHERE id = $2))
     SELECT id FROM g`, [userId, id])).rows.map((r) => r.id);
  const parentId = f.parent_id && f.parent_live ? f.parent_id : null;
  const name = await freeName(t, userId, parentId, f.name, 'folders');
  // Rename/re-parent while still trashed (the unique index only covers live rows), then bring the group back.
  await t.query(`UPDATE folders SET name = $3, parent_id = $4, updated_at = now() WHERE id = $1 AND user_id = $2`, [id, userId, name, parentId]);
  await t.query(`UPDATE files SET deleted_at = NULL WHERE user_id = $1 AND folder_id = ANY($2::uuid[])
                   AND deleted_at = (SELECT deleted_at FROM folders WHERE id = $3)`, [userId, group, id]);
  await t.query(`UPDATE folders SET deleted_at = NULL WHERE user_id = $1 AND id = ANY($2::uuid[])`, [userId, group]);
  return true;
}

/** Permanently deletes expired trash for every user. Safe to run repeatedly and concurrently with uploads. */
export async function purgeExpiredTrash(db: Db, days: number): Promise<ObjectRef[]> {
  if (days <= 0) return [];
  const users = (await db.query<{ user_id: string }>(
    `SELECT user_id FROM files WHERE deleted_at < now() - make_interval(days => $1)
     UNION SELECT user_id FROM folders WHERE deleted_at < now() - make_interval(days => $1)`, [days])).rows;
  const refs: ObjectRef[] = [];
  for (const { user_id } of users) {
    refs.push(...await db.tx(async (t) => {
      const folderIds = (await t.query<{ id: string }>(
        `SELECT id FROM folders WHERE user_id = $1 AND deleted_at < now() - make_interval(days => $2)`, [user_id, days])).rows.map((r) => r.id);
      const out = await purgeFolders(t, user_id, folderIds);
      out.push(...await purgeFiles(t, user_id, `deleted_at < now() - make_interval(days => $2)`, [days]));
      return out;
    }));
  }
  return refs;
}

export interface NewFile {
  id: string; userId: string; folderId: string | null; name: string; onConflict: 'reject' | 'rename' | 'replace';
  size: number; sha256: string; key: string; kind: string;
}
export interface FileRecord {
  id: string; folder_id: string | null; name: string; size_bytes: number; mime_type: string; created_at: string; updated_at: string;
}

/**
 * Registers an already-stored object as a file: resolves name conflicts, atomically charges the quota and
 * inserts the row. Must run inside a transaction; throws (rolling the caller's tx back) on quota/conflict errors.
 * Returns objects displaced by `replace` for the caller to delete after commit.
 */
export async function insertFileRecord(t: Db, f: NewFile): Promise<{ row: FileRecord; replaced: ObjectRef[] }> {
  let name = f.name;
  let replaced: ObjectRef[] = [];
  if (f.onConflict === 'rename') name = await freeName(t, f.userId, f.folderId, f.name, 'files');
  if (f.onConflict === 'replace') {
    replaced = await purgeFiles(t, f.userId,
      `deleted_at IS NULL AND COALESCE(folder_id, $2::uuid) = COALESCE($3::uuid, $2::uuid) AND lower(name) = lower($4)`, [NIL, f.folderId, f.name]);
  }
  // Atomic quota check: any earlier free-space check is advisory; this one is authoritative.
  const upd = await t.query(
    `UPDATE storage_quotas SET used_bytes = used_bytes + $2 WHERE user_id = $1 AND used_bytes + $2 <= quota_bytes`, [f.userId, f.size]);
  if (upd.rowCount === 0) throw new HttpError(413, 'quota_exceeded', 'Not enough storage space for this file');
  try {
    const ins = await t.query<FileRecord>(
      `INSERT INTO files (id, user_id, folder_id, name, size_bytes, mime_type, sha256, storage_provider_kind, storage_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, folder_id, name, size_bytes, mime_type, created_at, updated_at`,
      [f.id, f.userId, f.folderId, name, f.size, mimeFromName(name), f.sha256, f.kind, f.key]);
    const media = formatFor(ins.rows[0]!.name);
    if (media) {
      await t.query(`INSERT INTO media_metadata (file_id, user_id, kind) VALUES ($1, $2, $3) ON CONFLICT (file_id) DO NOTHING`, [f.id, f.userId, media.kind]);
    }
    return { row: ins.rows[0]!, replaced };
  } catch (e) {
    if ((e as { code?: string })?.code === '23505') throw conflict('A file with that name already exists here', 'name_conflict');
    throw e;
  }
}
