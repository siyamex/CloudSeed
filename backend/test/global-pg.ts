import pg from 'pg';
import { createPgDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { MIGRATIONS } from './helpers.js';
import { startPostgres, type TestPostgres } from './pg-server.js';

let server: TestPostgres | undefined;

/**
 * Runs once before all test files when TEST_DB=postgres; workers inherit the env vars. The schema is migrated once into
 * a template database that every test environment then clones, which is much faster than migrating per environment.
 */
export async function setup() {
  server = await startPostgres();
  process.env.TEST_PG_ADMIN_URL = server.adminUrl;

  const admin = new pg.Client({ connectionString: server.adminUrl });
  await admin.connect();
  await admin.query('CREATE DATABASE cs_template');
  await admin.end();
  const u = new URL(server.adminUrl);
  u.pathname = '/cs_template';
  const db = createPgDb(u.toString(), 1);
  await migrate(db, MIGRATIONS);
  await db.close(); // a template must have no open connections
  process.env.TEST_PG_TEMPLATE = 'cs_template';
}
export function teardown() { server?.stop(); }
