import pg from 'pg';

export interface QueryResult<T> { rows: T[]; rowCount: number }

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Runs fn in a transaction; commits on resolve, rolls back on throw. */
  tx<R>(fn: (db: Db) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

// BIGINT -> number. Safe up to 2^53 bytes (~9 PB), well beyond any quota here.
pg.types.setTypeParser(20, (v) => Number(v));

export function createPgDb(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max });
  const wrap = (q: pg.Pool | pg.PoolClient, root: boolean): Db => ({
    async query<T>(text: string, params?: unknown[]) {
      const r = await q.query(text, params as unknown[]);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
    async tx<R>(fn: (db: Db) => Promise<R>) {
      if (!root) return fn(this); // already inside a transaction
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client, false));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    async close() { if (root) await pool.end(); },
  });
  return wrap(pool, true);
}
