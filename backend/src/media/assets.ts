import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Db } from '../db/index.js';
import { HttpError } from '../errors.js';
import type { StorageAdapter } from '../storage/types.js';

export type AssetKind = 'thumbnail' | 'subtitle' | 'rendition' | 'sprite';

export interface StoreAssetInput {
  fileId: string;
  userId: string;
  kind: AssetKind;
  variant: string;
  mime: string;
  data: Buffer | Readable;
  /** Upper bound enforced while streaming (use the owner's remaining quota for large renditions). */
  maxBytes: number;
}

export interface StoredAsset { id: string; size: number; /** The object this asset replaced; delete it with deleteReplaced() once you are done. */ replaced: { key: string; kind: string } | null }

/**
 * Stores a derived object and registers it, charging the owner's quota atomically. Replaces any previous asset with
 * the same (file, kind, variant). The new object is removed again if registration fails, and the replaced one is
 * removed only after the new one is committed, so a reader never sees a row without an object.
 */
export async function storeAsset(db: Db, storage: StorageAdapter, a: StoreAssetInput): Promise<StoredAsset> {
  const id = randomUUID();
  const key = `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}`;
  const body = Buffer.isBuffer(a.data) ? Readable.from([a.data]) : a.data;
  const put = await storage.put(key, body, { maxBytes: a.maxBytes });
  let replaced: { key: string; kind: string } | null = null;
  let rowId: string = id;
  try {
    await db.tx(async (t) => {
      const old = (await t.query<{ id: string; size_bytes: number; storage_key: string | null; storage_provider_kind: string | null }>(
        `SELECT id, size_bytes, storage_key, storage_provider_kind FROM media_assets WHERE file_id = $1 AND kind = $2 AND variant = $3 FOR UPDATE`,
        [a.fileId, a.kind, a.variant])).rows[0];
      const delta = put.size - Number(old?.size_bytes ?? 0);
      const upd = await t.query(
        `UPDATE storage_quotas SET used_bytes = GREATEST(0, used_bytes + $2) WHERE user_id = $1 AND ($2 <= 0 OR used_bytes + $2 <= quota_bytes)`, [a.userId, delta]);
      if (upd.rowCount === 0) throw new HttpError(413, 'quota_exceeded', 'Not enough storage space for the generated file');
      const up = await t.query<{ id: string }>(
        `INSERT INTO media_assets (id, file_id, user_id, kind, variant, status, storage_provider_kind, storage_key, size_bytes, mime_type, progress)
         VALUES ($1, $2, $3, $4, $5, 'ready', $6, $7, $8, $9, 1)
         ON CONFLICT (file_id, kind, variant) DO UPDATE SET status = 'ready', storage_provider_kind = EXCLUDED.storage_provider_kind, storage_key = EXCLUDED.storage_key,
           size_bytes = EXCLUDED.size_bytes, mime_type = EXCLUDED.mime_type, progress = 1, error_message = NULL, worker_id = NULL, lease_expires_at = NULL, updated_at = now()
         RETURNING id`,
        [id, a.fileId, a.userId, a.kind, a.variant, storage.kind, key, put.size, a.mime]);
      rowId = up.rows[0]!.id;
      replaced = old?.storage_key && old.storage_provider_kind ? { key: old.storage_key, kind: old.storage_provider_kind } : null;
    });
  } catch (e) {
    await storage.delete(key).catch(() => undefined);
    throw e;
  }
  return { id: rowId, size: put.size, replaced };
}

/** Deletes the object a replaced asset used to point at (call after storeAsset returned `replaced`). */
export async function deleteReplaced(r: Pick<StoredAsset, 'replaced'>, adapterFor: (kind: string) => StorageAdapter | undefined) {
  if (r.replaced) await adapterFor(r.replaced.kind)?.delete(r.replaced.key).catch(() => undefined);
}
