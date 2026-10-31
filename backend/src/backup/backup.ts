import { createHash } from 'node:crypto';
import { rename, rm, stat } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import type { Db } from '../db/index.js';
import type { StorageAdapter } from '../storage/types.js';
import { ArchiveWriter, MIN_PASSPHRASE, Rec, readArchive } from './archive.js';
import { SEEDED_TABLES, describeSchema, q, type TableInfo } from './schema.js';

const BATCH = 1000;
export const FORMAT = 'cloudseed-backup-v1';

export interface ObjectRefRow { key: string; kind: string; size: number; sha256: string | null; what: string }
export interface BackupSummary {
  file: string;
  createdAt: string;
  rows: Record<string, number>;
  objects: { included: number; bytes: number };
  missing: { key: string; kind: string; what: string }[];
  corrupt: { key: string; kind: string; reason: string }[];
  bytes: number;
}
export type Log = (message: string) => void;

export function checkPassphrase(p: string | undefined): string {
  if (!p || p.length < MIN_PASSPHRASE) throw new Error(`The backup passphrase is missing or shorter than ${MIN_PASSPHRASE} characters (set BACKUP_PASSPHRASE or BACKUP_PASSPHRASE_FILE)`);
  return p;
}

/** Rows of one table in batches, in an order that is safe to insert (parents before children for trees). */
async function* exportRows(db: Db, t: TableInfo): AsyncGenerator<object[]> {
  const T = q(t.name);
  if (t.selfRef && t.pk.length === 1) {
    const [pk, ref] = [q(t.pk[0]!), q(t.selfRef)];
    const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${T}`)).rows[0]!.n;
    let seen = 0;
    for (let off = 0; off < total; off += BATCH) {
      const r = await db.query<{ j: object }>(
        `SELECT to_json(x) AS j FROM ${T} x JOIN (
           WITH RECURSIVE d AS (SELECT ${pk} AS id, 0 AS depth FROM ${T} WHERE ${ref} IS NULL
                                UNION ALL SELECT c.${pk}, d.depth + 1 FROM ${T} c JOIN d ON c.${ref} = d.id)
           SELECT id, min(depth) AS depth FROM d GROUP BY id) o ON o.id = x.${pk}
          ORDER BY o.depth, x.${pk} LIMIT ${BATCH} OFFSET ${off}`);
      seen += r.rows.length;
      if (r.rows.length) yield r.rows.map((x) => x.j);
    }
    if (seen !== total) throw new Error(`table ${t.name} has rows that are not reachable from its roots (a cycle?); backup stopped`);
    return;
  }
  if (t.pk.length === 1) { // keyset paging: constant cost per batch
    const pk = q(t.pk[0]!), type = t.pkTypes[0]!;
    let last: string | null = null;
    for (;;) {
      const r: { rows: { j: object; k: string }[] } = await db.query(
        `SELECT to_json(x) AS j, x.${pk}::text AS k FROM ${T} x WHERE ($1::${type} IS NULL OR x.${pk} > $1::${type}) ORDER BY x.${pk} LIMIT ${BATCH}`, [last]);
      if (!r.rows.length) return;
      yield r.rows.map((x) => x.j);
      last = r.rows[r.rows.length - 1]!.k;
      if (r.rows.length < BATCH) return;
    }
  }
  const order = t.pk.length ? t.pk.map(q).join(', ') : 'ctid';
  for (let off = 0; ; off += BATCH) {
    const r = await db.query<{ j: object }>(`SELECT to_json(x) AS j FROM ${T} x ORDER BY ${order} LIMIT ${BATCH} OFFSET ${off}`);
    if (!r.rows.length) return;
    yield r.rows.map((x) => x.j);
    if (r.rows.length < BATCH) return;
  }
}

export async function createBackup(o: {
  db: Db; out: string; passphrase: string; includeObjects: boolean;
  adapterFor: (kind: string) => StorageAdapter | undefined; log?: Log;
}): Promise<BackupSummary> {
  const log = o.log ?? (() => {});
  const partial = `${o.out}.partial`;
  const w = new ArchiveWriter(partial, checkPassphrase(o.passphrase));
  const summary: BackupSummary = { file: o.out, createdAt: new Date().toISOString(), rows: {}, objects: { included: 0, bytes: 0 }, missing: [], corrupt: [], bytes: 0 };
  try {
    // One snapshot: every table is read as it was at the same instant, even while the app keeps running.
    await o.db.tx(async (t) => {
      await t.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const schema = await describeSchema(t);
      const migrations = (await t.query<{ name: string; checksum: string }>(`SELECT name, checksum FROM schema_migrations ORDER BY name`)).rows;
      await w.write(Rec.Header, { format: FORMAT, createdAt: summary.createdAt, migrations, tables: schema.tables.map((x) => x.name), includeObjects: o.includeObjects });

      for (const tb of schema.tables) {
        let n = 0;
        for await (const rows of exportRows(t, tb)) { await w.write(Rec.Rows, { table: tb.name, rows }); n += rows.length; }
        summary.rows[tb.name] = n;
        log(`${tb.name}: ${n} rows`);
      }

      if (o.includeObjects) {
        const refs = (await t.query<ObjectRefRow>(
          `SELECT storage_key AS key, storage_provider_kind AS kind, size_bytes AS size, sha256, 'file' AS what FROM files
           UNION ALL SELECT storage_key, storage_provider_kind, size_bytes, NULL, 'media' FROM media_assets WHERE storage_key IS NOT NULL AND storage_provider_kind IS NOT NULL`)).rows;
        const seen = new Set<string>();
        for (const ref of refs) {
          const id = `${ref.kind}:${ref.key}`;
          if (seen.has(id)) continue; seen.add(id);
          const ad = o.adapterFor(ref.kind);
          if (!ad) throw new Error(`Objects are stored in "${ref.kind}" but that storage backend is not configured here; configure it or back up without objects`);
          const st = await ad.stat(ref.key);
          if (!st) { summary.missing.push({ key: ref.key, kind: ref.kind, what: ref.what }); log(`MISSING object ${ref.kind}:${ref.key}`); continue; }
          await w.write(Rec.ObjectBegin, { key: ref.key, kind: ref.kind, size: st.size });
          const hash = createHash('sha256'); let size = 0;
          for await (const chunk of await ad.get(ref.key)) {
            const b = chunk as Buffer; hash.update(b); size += b.length;
            await w.write(Rec.ObjectData, b);
          }
          const sha = hash.digest('hex');
          await w.write(Rec.ObjectEnd, { sha256: sha, size });
          summary.objects.included++; summary.objects.bytes += size;
          if (size !== st.size) summary.corrupt.push({ key: ref.key, kind: ref.kind, reason: `size changed while reading (${st.size} -> ${size})` });
          else if (ref.sha256 && ref.sha256 !== sha) summary.corrupt.push({ key: ref.key, kind: ref.kind, reason: 'content does not match the SHA-256 recorded when it was stored' });
          if (summary.objects.included % 100 === 0) log(`${summary.objects.included} objects written`);
        }
      }
      await w.write(Rec.Footer, { rows: summary.rows, objects: summary.objects, missing: summary.missing, corrupt: summary.corrupt });
    });
    await w.end();
    await rename(partial, o.out);
    summary.bytes = (await stat(o.out)).size;
    return summary;
  } catch (e) {
    w.abort(e as Error);
    await rm(partial, { force: true });
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------- verify / restore
export interface VerifyResult {
  createdAt: string; migrations: number; rows: Record<string, number>; totalRows: number;
  objects: { count: number; bytes: number }; includeObjects: boolean;
  missing: { key: string; kind: string; what: string }[]; corrupt: { key: string; kind: string; reason: string }[];
}

export interface ObjectMeta { key: string; kind: string; size: number }
interface Header { format: string; createdAt: string; migrations: { name: string; checksum: string }[]; tables: string[]; includeObjects: boolean }

/**
 * Walks an archive: decrypts every frame (so any change or truncation is caught), checks the record structure,
 * and recomputes every object's SHA-256 against the footer. `handlers` lets restore reuse the same walk.
 */
export async function scanArchive(file: string, passphrase: string, handlers: {
  onHeader?: (h: Header) => Promise<void>;
  onRows?: (table: string, rows: object[]) => Promise<void>;
  /** Objects are pushed one chunk at a time, so memory stays bounded however large they are. */
  onObjectBegin?: (meta: ObjectMeta) => Promise<void>;
  onObjectData?: (chunk: Buffer) => Promise<void>;
  onObjectEnd?: () => Promise<{ sha256: string; size: number }>;
} = {}): Promise<VerifyResult> {
  let header: Header | null = null, footer: any = null;
  const rows: Record<string, number> = {};
  const objects = { count: 0, bytes: 0 };
  let current: { meta: ObjectMeta; hash: ReturnType<typeof createHash>; size: number } | null = null;

  for await (const rec of readArchive(file, checkPassphrase(passphrase))) {
    if (footer) throw new Error('backup file is corrupted (records after the footer)');
    switch (rec.type) {
      case Rec.Header: {
        if (header) throw new Error('backup file is corrupted (two headers)');
        header = JSON.parse(rec.payload.toString());
        if (header!.format !== FORMAT) throw new Error(`unsupported backup format: ${header!.format}`);
        await handlers.onHeader?.(header!);
        break;
      }
      case Rec.Rows: {
        if (!header) throw new Error('backup file is corrupted (rows before header)');
        const { table, rows: r } = JSON.parse(rec.payload.toString()) as { table: string; rows: object[] };
        if (!header.tables.includes(table)) throw new Error(`backup contains an unknown table: ${table}`);
        rows[table] = (rows[table] ?? 0) + r.length;
        await handlers.onRows?.(table, r);
        break;
      }
      case Rec.ObjectBegin: {
        if (current) throw new Error('backup file is corrupted (object inside object)');
        current = { meta: JSON.parse(rec.payload.toString()), hash: createHash('sha256'), size: 0 };
        await handlers.onObjectBegin?.(current.meta);
        break;
      }
      case Rec.ObjectData: {
        if (!current) throw new Error('backup file is corrupted (object data outside an object)');
        current.hash.update(rec.payload); current.size += rec.payload.length;
        await handlers.onObjectData?.(rec.payload);
        break;
      }
      case Rec.ObjectEnd: {
        if (!current) throw new Error('backup file is corrupted (object end without start)');
        const end = JSON.parse(rec.payload.toString()) as { sha256: string; size: number };
        const sha = current.hash.digest('hex');
        const name = `${current.meta.kind}:${current.meta.key}`;
        if (sha !== end.sha256 || current.size !== end.size || current.size !== current.meta.size) throw new Error(`object ${name} does not match its checksum in the backup`);
        const stored = await handlers.onObjectEnd?.();
        if (stored && (stored.sha256 !== sha || stored.size !== current.size)) throw new Error(`object ${name} was not stored intact`);
        objects.count++; objects.bytes += current.size;
        current = null;
        break;
      }
      case Rec.Footer: footer = JSON.parse(rec.payload.toString()); break;
      default: throw new Error(`backup file is corrupted (unknown record type ${rec.type})`);
    }
  }
  if (!header || !footer) throw new Error('backup file is incomplete (no footer)');
  if (current) throw new Error('backup file is truncated inside an object');
  for (const t of header.tables) if ((footer.rows[t] ?? 0) !== (rows[t] ?? 0)) throw new Error(`row count mismatch in ${t}: footer says ${footer.rows[t] ?? 0}, file has ${rows[t] ?? 0}`);
  if (footer.objects.included !== objects.count || footer.objects.bytes !== objects.bytes) throw new Error('object count mismatch between footer and contents');
  return {
    createdAt: header.createdAt, migrations: header.migrations.length, rows, totalRows: Object.values(rows).reduce((a, b) => a + b, 0),
    objects, includeObjects: header.includeObjects, missing: footer.missing, corrupt: footer.corrupt,
  };
}

export const verifyBackup = (file: string, passphrase: string) => scanArchive(file, passphrase);

export interface RestoreResult extends VerifyResult { sequencesReset: number }

/**
 * Loads a backup into an empty, freshly migrated database in a single transaction, then writes the stored objects.
 * Any failure rolls the database back and removes the objects written so far.
 */
export async function restoreBackup(o: {
  db: Db; file: string; passphrase: string; adapterFor: (kind: string) => StorageAdapter | undefined; log?: Log;
}): Promise<RestoreResult> {
  const log = o.log ?? (() => {});
  // First pass: prove the whole file is intact before touching the database.
  log('verifying archive...');
  const info = await verifyBackup(o.file, o.passphrase);
  if (info.corrupt.length) log(`WARNING: ${info.corrupt.length} object(s) were already inconsistent when the backup was made`);

  const written: { adapter: StorageAdapter; key: string }[] = [];
  let out: { body: PassThrough; done: Promise<{ sha256: string; size: number }>; adapter: StorageAdapter; key: string } | null = null;
  let sequencesReset = 0;
  try {
    await o.db.tx(async (t) => {
      const schema = await describeSchema(t);
      const applied = (await t.query<{ name: string; checksum: string }>(`SELECT name, checksum FROM schema_migrations ORDER BY name`)).rows;
      for (const tb of schema.tables.filter((x) => !SEEDED_TABLES.includes(x.name))) {
        const n = (await t.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${q(tb.name)}`)).rows[0]!.n;
        if (n > 0) throw new Error(`The target database is not empty (${tb.name} has ${n} rows). Restore into a new, freshly migrated database.`);
      }
      for (const name of SEEDED_TABLES) await t.query(`DELETE FROM ${q(name)}`); // the backup carries the real content
      await scanArchive(o.file, o.passphrase, {
        async onHeader(h) {
          const a = applied.map((m) => `${m.name}:${m.checksum}`).join(','), b = h.migrations.map((m) => `${m.name}:${m.checksum}`).join(',');
          if (a !== b) {
            throw new Error(`Schema version mismatch. The backup was made with ${h.migrations.length} migrations (last: ${h.migrations.at(-1)?.name}), this database has ${applied.length} (last: ${applied.at(-1)?.name}). ` +
              'Restore with the same CloudSeed version that made the backup, then upgrade.');
          }
          const missing = h.tables.filter((x) => !schema.tables.some((s) => s.name === x));
          if (missing.length) throw new Error(`The database lacks tables from the backup: ${missing.join(', ')}`);
        },
        async onRows(table, rows) {
          if (!rows.length) return;
          await t.query(`INSERT INTO ${q(table)} SELECT * FROM json_populate_recordset(null::${q(table)}, $1::json)`, [JSON.stringify(rows)]);
        },
        async onObjectBegin(meta) {
          const ad = o.adapterFor(meta.kind);
          if (!ad) throw new Error(`The backup contains objects for the "${meta.kind}" storage backend, which is not configured here`);
          const body = new PassThrough();
          const done = ad.put(meta.key, body, { maxBytes: Number.MAX_SAFE_INTEGER });
          done.catch(() => undefined); // reported by onObjectData / onObjectEnd
          out = { body, done, adapter: ad, key: meta.key };
        },
        async onObjectData(chunk) {
          if (!out!.body.write(chunk)) await Promise.race([new Promise<void>((r) => out!.body.once('drain', r)), out!.done]);
        },
        async onObjectEnd() {
          out!.body.end();
          const r = await out!.done;
          written.push({ adapter: out!.adapter, key: out!.key });
          out = null;
          return r;
        },
      });
      // A backup made while another one was running contains that run as "in progress". It is not, after a restore.
      await t.query(`UPDATE backup_runs SET status = 'failed', finished_at = now(), error = 'Restored from a backup: this run was still in progress when that backup was made.' WHERE status IN ('requested', 'running')`);
      for (const s of schema.serials) {
        await t.query(`SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT max(${q(s.column)}) FROM ${q(s.table)}), 0) + 1, false)`, [`public.${s.table}`, s.column]);
        sequencesReset++;
      }
    });
  } catch (e) {
    (out as { body: PassThrough } | null)?.body.destroy(); // an object that was being written
    for (const w of written) await w.adapter.delete(w.key).catch(() => undefined); // leave nothing behind
    throw e;
  }
  return { ...info, sequencesReset };
}
