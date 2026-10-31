import type { Db } from '../db/index.js';
import type { StorageAdapter } from '../storage/types.js';

export interface ReconcileReport {
  /** Rows whose object is gone from storage. Nothing here can recreate the bytes; restore them from a backup. */
  missing: { table: 'files' | 'media_assets'; id: string; userId: string; kind: string; key: string }[];
  sizeMismatch: { id: string; kind: string; key: string; recorded: number; stored: number }[];
  /** Objects no database row refers to. */
  orphans: { kind: string; key: string; size: number; ageHours: number; deleted: boolean }[];
  /** Users whose recorded usage differs from the sum of their files and derived media. */
  quotaDrift: { userId: string; recorded: number; actual: number; fixed: boolean }[];
  checked: { rows: number; objects: number };
}

export interface ReconcileOptions {
  db: Db;
  adapterFor: (kind: string) => StorageAdapter | undefined;
  kinds?: string[];
  deleteOrphans?: boolean;
  /** Objects younger than this are never treated as orphans: an upload may be between "stored" and "recorded". */
  orphanGraceHours?: number;
  fixQuotas?: boolean;
  concurrency?: number;
  log?: (m: string) => void;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}

/** Compares the database with the storage backends. Read-only unless `deleteOrphans` / `fixQuotas` are set. */
export async function reconcile(o: ReconcileOptions): Promise<ReconcileReport> {
  const log = o.log ?? (() => {});
  const grace = o.orphanGraceHours ?? 24;
  const report: ReconcileReport = { missing: [], sizeMismatch: [], orphans: [], quotaDrift: [], checked: { rows: 0, objects: 0 } };
  const kinds = o.kinds ?? [...new Set((await o.db.query<{ k: string }>(
    `SELECT storage_provider_kind AS k FROM files UNION SELECT storage_provider_kind FROM media_assets WHERE storage_provider_kind IS NOT NULL`)).rows.map((r) => r.k))];

  // 1. rows -> objects
  for (const kind of kinds) {
    const ad = o.adapterFor(kind);
    if (!ad) { log(`skipping "${kind}": backend not configured here`); continue; }
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const rows = (await o.db.query<{ id: string; user_id: string; key: string; size: number; t: 'files' | 'media_assets' }>(
        `SELECT id, user_id, storage_key AS key, size_bytes AS size, t FROM (
           SELECT id, user_id, storage_key, size_bytes, 'files' AS t FROM files WHERE storage_provider_kind = $1
           UNION ALL SELECT id, user_id, storage_key, size_bytes, 'media_assets' FROM media_assets WHERE storage_provider_kind = $1 AND storage_key IS NOT NULL AND status = 'ready') u
          WHERE id > $2 ORDER BY id LIMIT 500`, [kind, after])).rows;
      if (!rows.length) break;
      after = rows[rows.length - 1]!.id;
      await pool(rows, o.concurrency ?? 8, async (r) => {
        report.checked.rows++;
        const st = await ad.stat(r.key);
        if (!st) report.missing.push({ table: r.t, id: r.id, userId: r.user_id, kind, key: r.key });
        else if (Number(r.size) !== st.size) report.sizeMismatch.push({ id: r.id, kind, key: r.key, recorded: Number(r.size), stored: st.size });
      });
    }
    log(`${kind}: ${report.checked.rows} rows checked`);

    // 2. objects -> rows
    let batch: { key: string; size: number; modifiedAt: Date }[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const keys = batch.map((b) => b.key);
      const known = new Set((await o.db.query<{ k: string }>(
        `SELECT storage_key AS k FROM files WHERE storage_provider_kind = $1 AND storage_key = ANY($2)
         UNION SELECT storage_key FROM media_assets WHERE storage_provider_kind = $1 AND storage_key = ANY($2)`, [kind, keys])).rows.map((r) => r.k));
      for (const b of batch) {
        if (known.has(b.key)) continue;
        const ageHours = (Date.now() - b.modifiedAt.getTime()) / 3_600_000;
        if (ageHours < grace) continue;
        let deleted = false;
        if (o.deleteOrphans) { await ad.delete(b.key); deleted = true; }
        report.orphans.push({ kind, key: b.key, size: b.size, ageHours: Math.round(ageHours), deleted });
      }
      batch = [];
    };
    for await (const obj of ad.list()) {
      report.checked.objects++;
      batch.push(obj);
      if (batch.length >= 500) await flush();
    }
    await flush();
  }

  // 3. quota arithmetic
  const drift = (await o.db.query<{ user_id: string; recorded: number; actual: number }>(
    `SELECT q.user_id, q.used_bytes AS recorded, (COALESCE(f.s, 0) + COALESCE(a.s, 0))::bigint AS actual
       FROM storage_quotas q
       LEFT JOIN (SELECT user_id, sum(size_bytes) AS s FROM files GROUP BY user_id) f ON f.user_id = q.user_id
       LEFT JOIN (SELECT user_id, sum(size_bytes) AS s FROM media_assets GROUP BY user_id) a ON a.user_id = q.user_id
      WHERE q.used_bytes <> COALESCE(f.s, 0) + COALESCE(a.s, 0)`)).rows;
  for (const d of drift) {
    if (o.fixQuotas) await o.db.query(`UPDATE storage_quotas SET used_bytes = $2 WHERE user_id = $1`, [d.user_id, d.actual]);
    report.quotaDrift.push({ userId: d.user_id, recorded: Number(d.recorded), actual: Number(d.actual), fixed: !!o.fixQuotas });
  }
  return report;
}
