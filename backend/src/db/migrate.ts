import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Db } from './index.js';

/** Applies *.sql files in lexical order, once each, each inside a transaction. */
export async function migrate(db: Db, dir: string, log: (m: string) => void = () => {}): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = new Map(
    (await db.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const f of files) {
    const sql = await readFile(path.join(dir, f), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const prev = applied.get(f);
    if (prev) {
      if (prev !== checksum) throw new Error(`Migration ${f} was modified after being applied`);
      continue;
    }
    await db.tx(async (t) => {
      await t.query(sql);
      await t.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [f, checksum]);
    });
    log(`applied ${f}`);
    ran.push(f);
  }
  return ran;
}
