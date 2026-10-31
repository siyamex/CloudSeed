import { buildApp } from './app.js';
import { googleOidc } from './auth/oidc.js';
import { loadConfig } from './config.js';
import { createPgDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { deleteObjects, purgeExpiredTrash } from './files/ops.js';
import { createStorages } from './storage/index.js';

const config = loadConfig();
const db = createPgDb(config.DATABASE_URL, config.DB_POOL_MAX);

// Migrations are applied explicitly (`npm run migrate`) in production; auto-apply only in development.
if (config.NODE_ENV === 'development') await migrate(db, config.MIGRATIONS_DIR, (m) => console.log(m));

const oidc = config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_REDIRECT_URI
  ? googleOidc(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET, config.GOOGLE_REDIRECT_URI)
  : null;

// New files go to the configured backend; the other stays readable so existing files keep working after a switch.
const { storage, storages, adapterFor } = createStorages(config);
const app = await buildApp({ config, db, storage, storages, oidc });

// Retention: purge expired trash hourly (and once at startup).
const sweepTrash = async () => {
  try {
    const refs = await purgeExpiredTrash(db, config.TRASH_RETENTION_DAYS);
    await deleteObjects(refs, adapterFor, (err, key) => app.log.error({ err, key }, 'trash object delete failed'));
    if (refs.length) app.log.info({ purged: refs.length }, 'expired trash purged');
  } catch (err) { app.log.error({ err }, 'trash sweep failed'); }
};
void sweepTrash();
const sweeper = setInterval(() => void sweepTrash(), 3_600_000);
sweeper.unref();

const shutdown = async (sig: string) => {
  app.log.info({ sig }, 'shutting down');
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.PORT });
