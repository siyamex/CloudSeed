import type { Db } from '../db/index.js';

export interface TableInfo {
  name: string;
  pk: string[];
  pkTypes: string[];
  /** Column referencing the table itself (a tree such as folders), if any. */
  selfRef: string | null;
  columns: string[];
}
export interface SchemaInfo {
  /** Tables in an order where every table comes after the tables it references. */
  tables: TableInfo[];
  /** Columns filled from a sequence (BIGSERIAL), which must be advanced after rows are restored. */
  serials: { table: string; column: string }[];
}

/**
 * Tables the migrations fill with fixed rows. A fresh install already has them, so restore replaces their content
 * instead of treating it as existing data. (A test checks this list is complete.)
 */
export const SEEDED_TABLES = ['roles', 'application_settings'];

const IDENT = /^[a-z_][a-z0-9_]*$/;
export const q = (id: string) => {
  if (!IDENT.test(id)) throw new Error(`unsupported identifier in schema: ${id}`);
  return `"${id}"`;
};

/** Reads the live schema so backup and restore never depend on a hand-kept table list. */
export async function describeSchema(db: Db): Promise<SchemaInfo> {
  const names = (await db.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' ORDER BY tablename`)).rows.map((r) => r.t);
  const cols = (await db.query<{ t: string; c: string }>(
    `SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`)).rows;
  const pks = (await db.query<{ t: string; cols: string[]; types: string[] }>(
    `SELECT c.relname AS t, array_agg(a.attname::text ORDER BY k.ord) AS cols, array_agg(format_type(a.atttypid, NULL) ORDER BY k.ord) AS types
       FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE con.contype = 'p' GROUP BY c.relname`)).rows;
  const fks = (await db.query<{ t: string; ref: string; col: string }>(
    `SELECT c.relname AS t, r.relname AS ref, a.attname::text AS col
       FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_class r ON r.oid = con.confrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f'`)).rows;
  const serials = (await db.query<{ table: string; column: string }>(
    `SELECT table_name AS "table", column_name AS "column" FROM information_schema.columns WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'`)).rows
    .filter((s) => s.table !== 'schema_migrations');

  const info = new Map<string, TableInfo>();
  for (const n of names) {
    const pk = pks.find((p) => p.t === n);
    info.set(n, {
      name: n, pk: pk?.cols ?? [], pkTypes: pk?.types ?? [],
      selfRef: fks.find((f) => f.t === n && f.ref === n)?.col ?? null,
      columns: cols.filter((c) => c.t === n).map((c) => c.c),
    });
  }
  for (const t of info.values()) { t.columns.forEach(q); q(t.name); t.pkTypes.forEach((x) => { if (!/^[a-z ]+$/.test(x)) throw new Error(`unsupported key type ${x}`); }); }

  // topological order (Kahn); self references are handled by ordering the rows instead
  const deps = new Map(names.map((n) => [n, new Set(fks.filter((f) => f.t === n && f.ref !== n && info.has(f.ref)).map((f) => f.ref))]));
  const ordered: TableInfo[] = [];
  const left = new Set(names);
  while (left.size) {
    const ready = [...left].filter((n) => [...deps.get(n)!].every((d) => !left.has(d))).sort();
    if (!ready.length) throw new Error(`tables reference each other in a cycle (${[...left].join(', ')}); backup does not support this schema`);
    for (const n of ready) { ordered.push(info.get(n)!); left.delete(n); }
  }
  return { tables: ordered, serials };
}
