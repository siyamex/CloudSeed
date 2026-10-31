import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createPgDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { reconcile, type ReconcileReport } from '../maintenance/reconcile.js';
import { LocalStorage } from '../storage/local.js';
import { restoreBackup, type Log, type RestoreResult } from './backup.js';
import { describeSchema, q } from './schema.js';

export interface DrillResult {
  restored: RestoreResult;
  /** Tables whose restored row count differs from what the archive says (should be empty). */
  rowMismatches: { table: string; expected: number; actual: number }[];
  reconcile: ReconcileReport;
  ok: boolean;
}

/**
 * Proves a backup can really be restored: loads it into a new, temporary database and a temporary directory, checks the
 * row counts and that every file the database mentions exists, then deletes both. The real database and the real storage
 * (including any S3 bucket) are never written to: every storage backend is replaced by the temporary directory.
 * Needs a database role that may CREATE DATABASE.
 */
export async function restoreDrill(o: { databaseUrl: string; migrationsDir: string; file: string; passphrase: string; log?: Log }): Promise<DrillResult> {
  const log = o.log ?? (() => {});
  const name = `cloudseed_drill_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: o.databaseUrl });
  await admin.connect();
  const u = new URL(o.databaseUrl); u.pathname = `/${name}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudseed-drill-'));
  let db: ReturnType<typeof createPgDb> | null = null;
  try {
    try { await admin.query(`CREATE DATABASE ${name}`); } catch (e) {
      throw new Error(`Could not create a temporary database (${(e as Error).message}). The database user needs the CREATEDB privilege for a restore drill.`);
    }
    log(`temporary database ${name} created`);
    db = createPgDb(u.toString(), 3);
    await migrate(db, o.migrationsDir);
    const scratch = new LocalStorage(path.join(dir, 'storage'), path.join(dir, 'tmp'));
    const adapterFor = () => scratch; // every kind, "s3" included, lands in the temporary directory
    const restored = await restoreBackup({ db, file: o.file, passphrase: o.passphrase, adapterFor, log });

    const rowMismatches: DrillResult['rowMismatches'] = [];
    for (const t of (await describeSchema(db)).tables) {
      const actual = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${q(t.name)}`)).rows[0]!.n;
      const expected = restored.rows[t.name] ?? 0;
      if (actual !== expected) rowMismatches.push({ table: t.name, expected, actual });
    }
    const rec = await reconcile({ db, adapterFor, log });
    // a backup made without stored files cannot pass the "objects exist" check; that is expected, not a failure
    const objectsExpected = restored.includeObjects;
    const ok = rowMismatches.length === 0 && (!objectsExpected || (rec.missing.length === 0 && rec.sizeMismatch.length === 0));
    return { restored, rowMismatches, reconcile: rec, ok };
  } finally {
    await db?.close().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
