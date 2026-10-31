import pino from 'pino';
import { loadConfig } from './config.js';
import { applyRuntimeSettings, watchRuntimeSettings } from './auth/providers.js';
import { createVault } from './crypto.js';
import { createPgDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { DownloadEngine } from './downloads/engine.js';
import { createGuard } from './downloads/ssrf.js';
import { createMailer } from './mail/mailer.js';
import { MaintenanceEngine } from './maintenance/engine.js';
import { MediaEngine } from './media/engine.js';
import { TorrentEngine } from './torrents/engine.js';
import { createStorages } from './storage/index.js';
import { TelegramEngine } from './telegram/engine.js';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL, redact: ['*.url'] });
const db = createPgDb(config.DATABASE_URL, config.DB_POOL_MAX);
if (config.NODE_ENV === 'development') await migrate(db, config.MIGRATIONS_DIR, (m) => log.info(m));

await applyRuntimeSettings(db, config).catch(() => undefined);
watchRuntimeSettings(db, config); // links in emails follow the public address set in the admin panel

const { storage, adapterFor } = createStorages(config);
const engine = new DownloadEngine({
  db, storage, adapterFor, config, log,
  guard: createGuard({ allowedCidrs: config.DOWNLOAD_ALLOWED_CIDRS, allowedPorts: config.DOWNLOAD_ALLOWED_PORTS }),
  aliveFile: process.env.WORKER_ALIVE_FILE || '/tmp/worker-alive',
});
engine.start();
const telegram = config.TELEGRAM_ENABLED
  ? new TelegramEngine({ db, vault: createVault(config), config, adapterFor, log, aliveFile: `${process.env.WORKER_ALIVE_FILE || '/tmp/worker-alive'}-telegram` })
  : null;
telegram?.start();
const media = config.MEDIA_ENABLED
  ? new MediaEngine({ db, config, storage, adapterFor, log, aliveFile: `${process.env.WORKER_ALIVE_FILE || '/tmp/worker-alive'}-media` })
  : null;
media?.start();
// Always created, idle until torrents are switched on (environment or Administration > Settings); the BitTorrent library only loads when a job needs it.
const torrents = new TorrentEngine({ db, config, storage, adapterFor, log, aliveFile: `${process.env.WORKER_ALIVE_FILE || '/tmp/worker-alive'}-torrents` });
torrents.start();
const mailer = createMailer(config);
const maintenance = new MaintenanceEngine({ db, config, mailer, log, adapterFor, vault: createVault(config), role: 'worker', aliveFile: `${process.env.WORKER_ALIVE_FILE || '/tmp/worker-alive'}-maintenance` });
maintenance.start();
log.info({ workerId: engine.workerId, concurrency: config.WORKER_CONCURRENCY }, 'download worker started');

// Graceful shutdown: running downloads are interrupted, keep their partial data, and go back to the queue.
let closing = false;
const shutdown = async (sig: string) => {
  if (closing) return;
  closing = true;
  log.info({ sig }, 'worker shutting down');
  await Promise.all([engine.stop(), telegram?.stop(), media?.stop(), torrents.stop(), maintenance.stop()]);
  mailer.close();
  await db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
