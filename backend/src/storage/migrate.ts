import type { Db } from '../db/index.js';
import type { StorageAdapter } from './types.js';

export interface MigrateStorageOptions {
  db: Db;
  from: StorageAdapter;
  to: StorageAdapter;
  /** After a file is copied, checked and its row switched, remove the source copy. Off by default so the move can be undone. */
  deleteOriginals?: boolean;
  dryRun?: boolean;
  concurrency?: number;
  log?: (m: string) => void;
}
export interface MigrateStorageResult {
  moved: number; bytes: number; alreadyThere: number; skippedGone: number;
  failed: { table: string; id: string; key: string; reason: string }[];
  originalsDeleted: number; dryRun: boolean;
}

type Row = { table: 'files' | 'media_assets'; id: string; key: string; size: number; sha256: string | null };

/**
 * Moves stored objects from one backend to another and re-points their rows, one object at a time:
 * copy -> verify (size and SHA-256) -> switch the row -> (optionally) delete the original.
 * It is safe to stop and run again, and files stay downloadable throughout because a row only changes after
 * its object exists in the new place.
 */
export async function migrateStorage(o: MigrateStorageOptions): Promise<MigrateStorageResult> {
  const log = o.log ?? (() => {});
  if (o.from.kind === o.to.kind) throw new Error('source and destination are the same kind of storage');
  const res: MigrateStorageResult = { moved: 0, bytes: 0, alreadyThere: 0, skippedGone: 0, failed: [], originalsDeleted: 0, dryRun: !!o.dryRun };

  async function one(r: Row) {
    try {
      const src = await o.from.stat(r.key);
      if (!src) { res.failed.push({ table: r.table, id: r.id, key: r.key, reason: 'the object is missing from the source storage' }); return; }
      const dst = await o.to.stat(r.key);
      if (dst && dst.size === src.size) res.alreadyThere++; // left by an earlier, interrupted run
      else if (!o.dryRun) {
        const put = await o.to.put(r.key, await o.from.get(r.key), { maxBytes: Number.MAX_SAFE_INTEGER });
        if (put.size !== src.size) throw new Error(`copied ${put.size} of ${src.size} bytes`);
        if (r.sha256 && put.sha256 !== r.sha256) { await o.to.delete(r.key); throw new Error('the copy does not match the SHA-256 recorded for this file'); }
      }
      if (o.dryRun) { res.moved++; res.bytes += src.size; return; }
      // Switch only if the row is unchanged and still on the old backend (the user may have deleted it meanwhile).
      const upd = await o.db.query(
        `UPDATE ${r.table} SET storage_provider_kind = $2 WHERE id = $1 AND storage_provider_kind = $3 AND storage_key = $4`, [r.id, o.to.kind, o.from.kind, r.key]);
      if (!upd.rowCount) { await o.to.delete(r.key).catch(() => undefined); res.skippedGone++; return; }
      res.moved++; res.bytes += src.size;
      if (o.deleteOriginals) { await o.from.delete(r.key); res.originalsDeleted++; }
    } catch (e) {
      res.failed.push({ table: r.table, id: r.id, key: r.key, reason: (e as Error).message });
    }
  }

  for (const table of ['files', 'media_assets'] as const) {
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const rows = (await o.db.query<{ id: string; key: string; size: number; sha256: string | null }>(
        table === 'files'
          ? `SELECT id, storage_key AS key, size_bytes AS size, sha256 FROM files WHERE storage_provider_kind = $1 AND id > $2 ORDER BY id LIMIT 200`
          : `SELECT id, storage_key AS key, size_bytes AS size, NULL AS sha256 FROM media_assets WHERE storage_provider_kind = $1 AND storage_key IS NOT NULL AND id > $2 ORDER BY id LIMIT 200`,
        [o.from.kind, after])).rows;
      if (!rows.length) break;
      after = rows[rows.length - 1]!.id;
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 4, rows.length) }, async () => {
        while (i < rows.length) { const r = rows[i++]!; await one({ table, ...r }); }
      }));
      log(`${table}: ${res.moved} moved, ${res.failed.length} failed`);
    }
  }
  return res;
}
