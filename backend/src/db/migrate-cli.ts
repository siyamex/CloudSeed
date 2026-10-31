import { loadConfig } from '../config.js';
import { createPgDb } from './index.js';
import { migrate } from './migrate.js';

const cfg = loadConfig();
const db = createPgDb(cfg.DATABASE_URL, cfg.DB_POOL_MAX);
try {
  const ran = await migrate(db, cfg.MIGRATIONS_DIR, (m) => console.log(m));
  console.log(ran.length ? `${ran.length} migration(s) applied` : 'database is up to date');
} finally {
  await db.close();
}
