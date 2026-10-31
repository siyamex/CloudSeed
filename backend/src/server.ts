import { buildApp } from './app.js';
import { applyRuntimeSettings, watchRuntimeSettings } from './auth/providers.js';
import { needsSetup, setupCode } from './auth/setup.js';
import { loadConfig } from './config.js';
import { createPgDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { deleteObjects, purgeExpiredTrash } from './files/ops.js';
import { createStorages } from './storage/index.js';

const config = loadConfig();
const db = createPgDb(config.DATABASE_URL, config.DB_POOL_MAX);

// Migrations are applied explicitly (`npm run migrate`) in production; auto-apply only in development.
if (config.NODE_ENV === 'development') await migrate(db, config.MIGRATIONS_DIR, (m) => console.log(m));

// The public address an administrator saved in the admin panel (if any) applies from the start.
await applyRuntimeSettings(db, config).catch(() => undefined);

// New files go to the configured backend; the other stays readable so existing files keep working after a switch.
const { storage, storages, adapterFor } = createStorages(config);
// Google sign-in is read from the database (admin panel) or the environment on every sign-in attempt, so no restart is needed to change it.
const app = await buildApp({ config, db, storage, storages, oidc: null });
watchRuntimeSettings(db, config, (err) => app.log.warn({ err }, 'could not refresh runtime settings'));

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
if (await needsSetup(db)) {
  app.log.warn(`FIRST RUN: open the web page to create the administrator account. From the same network no code is needed. From elsewhere (for example through a tunnel) you will be asked for this setup code: ${setupCode()}`);
}
