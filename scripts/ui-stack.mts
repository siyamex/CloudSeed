/**
 * DEVELOPMENT / VERIFICATION ONLY. Starts a complete, disposable CloudSeed stack with no Google login so the UI can be
 * exercised in a real browser:
 *   - a throwaway real PostgreSQL server (embedded binaries), the BUILT API and worker as separate processes
 *   - a fake Telegram Bot API (one bot and one group are pre-registered; the printed token works in the UI)
 *   - a seeded user with an already-valid session cookie, and sample media uploaded through the real API
 * It never touches real data or the network. Run `npm run build` first, then:   npx tsx scripts/ui-stack.mts
 * Writes connection details to the file given as the first argument (default ./ui-stack.json), prints READY, then waits.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, openSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { startFakeTelegram } from '../backend/test/fake-telegram.js';
import { ffmpegPath, ffprobePath, fixtures } from '../backend/test/media-fixtures.js';
import { startPostgres } from '../backend/test/pg-server.js';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.argv[2] ?? 'ui-stack.json');
const API_PORT = Number(process.env.UI_API_PORT ?? 18081);
const WEB_ORIGIN = process.env.UI_WEB_ORIGIN ?? 'http://localhost:5199';
const tmp = mkdtempSync(path.join(os.tmpdir(), 'cloudseed-ui-'));
const procs: ChildProcess[] = [];
/** UI_FRESH=1: an empty server, as a new install would be: no user, no test login, so the first-run setup page is what you see. */
const FRESH = process.env.UI_FRESH === '1';

const postgres = await startPostgres();
const telegram = await startFakeTelegram();
const BOT = { token: '555000111:AAEuiStackFakeBotTokenForLocalUseOnly', id: 555000111, username: 'ui_demo_bot' };
const CHAT = { id: -1005550001111, title: 'UI Demo Group' };
telegram.addBot(BOT.token, { id: BOT.id, username: BOT.username });
telegram.addChat({ id: CHAT.id, type: 'supergroup', title: CHAT.title }, { [BOT.id]: { status: 'member' } });

const env: NodeJS.ProcessEnv = {
  ...process.env, NODE_ENV: 'development', LOG_LEVEL: 'warn', PORT: String(API_PORT), PUBLIC_URL: WEB_ORIGIN,
  DATABASE_URL: postgres.adminUrl, MIGRATIONS_DIR: path.join(root, 'migrations'), SESSION_SECRET: 'x'.repeat(40), METRICS_TOKEN: 'ui-stack-metrics-token-123', DEV_LOGIN: process.env.UI_FRESH === '1' ? 'false' : 'true', DEV_LOGIN_EMAIL: 'demo@example.com', ADMIN_EMAILS: 'demo@example.com',
  LOCAL_STORAGE_ROOT: path.join(tmp, 'storage'), LOCAL_TMP_DIR: path.join(tmp, 'tmp'), DOWNLOAD_WORKDIR: path.join(tmp, 'downloads'),
  DEFAULT_USER_QUOTA_BYTES: String(500 * 1024 * 1024), MAX_FILE_SIZE_BYTES: String(100 * 1024 * 1024), DB_POOL_MAX: '3',
  ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'), TELEGRAM_API_BASE: telegram.url, TELEGRAM_CHAT_INTERVAL_MS: '300',
  FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: ffprobePath, MEDIA_WORKDIR: path.join(tmp, 'media'), MEDIA_TRANSCODING_ENABLED: 'true',
  WORKER_POLL_MS: '300', WORKER_ALIVE_FILE: path.join(tmp, 'alive'),
};
const logs: Record<string, string> = {};
const start = (script: string) => {
  const log = path.join(tmp, `${script.replace('.js', '')}.log`);
  logs[script] = log;
  const fd = openSync(log, 'a');
  const p = spawn(process.execPath, [path.join(root, 'backend/dist', script)], { env: { ...env, LOG_LEVEL: 'info' }, cwd: path.join(root, 'backend'), stdio: ['ignore', fd, fd] });
  p.on('exit', (code, sig) => console.log(`${script} exited code=${code} signal=${sig}`));
  procs.push(p);
  return p;
};
let closing = false;
const cleanup = async () => {
  if (closing) return;
  closing = true;
  for (const p of procs) p.kill('SIGKILL');
  await telegram.close();
  postgres.stop();
  process.exit(0);
};
process.on('SIGTERM', () => void cleanup());
process.on('SIGINT', () => void cleanup());

const startWeb = () => {
  if (process.env.UI_NO_WEB === '1') return;
  const webLog = openSync(path.join(tmp, 'web.log'), 'a');
  const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', String(new URL(WEB_ORIGIN).port || 5199), '--strictPort'],
    { cwd: path.join(root, 'frontend'), env: { ...process.env, API_URL: `http://127.0.0.1:${API_PORT}` }, stdio: ['ignore', webLog, webLog] });
  procs.push(vite);
  console.log(`
Open ${WEB_ORIGIN}${FRESH ? '  ->  you will see the first-run setup page (create the administrator).' : '  ->  click "Sign in as the local test user".'}
This is a throwaway demo: its data lives in a temporary folder and disappears when you stop it (Ctrl+C).`);
};

const mig = spawn(process.execPath, [path.join(root, 'backend/dist/db/migrate-cli.js')], { env, cwd: path.join(root, 'backend'), stdio: 'ignore' });
if ((await new Promise<number>((r) => mig.on('exit', (c) => r(c ?? -1)))) !== 0) throw new Error('migration failed');

if (FRESH) {
  start('server.js');
  start('worker.js');
  const b = `http://127.0.0.1:${API_PORT}/api/v1`;
  for (let i = 0; i < 100; i++) { if (await fetch(`${b}/health`).then((r) => r.ok).catch(() => false)) break; await new Promise((r) => setTimeout(r, 200)); }
  writeFileSync(out, JSON.stringify({ apiPort: API_PORT, webOrigin: WEB_ORIGIN, fresh: true, logs }, null, 2));
  console.log('READY', out);
  startWeb();
  setInterval(() => undefined, 1 << 30);
  await new Promise(() => undefined);
}

const admin = new pg.Client({ connectionString: postgres.adminUrl });
await admin.connect();
const uid = (await admin.query(`INSERT INTO users (email, email_verified) VALUES ('demo@example.com', true) RETURNING id`)).rows[0].id;
await admin.query(`INSERT INTO user_profiles (user_id, display_name) VALUES ($1, 'Demo User')`, [uid]);
await admin.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 1), ($1, 2)`, [uid]); // the demo user is also an administrator
await admin.query(`INSERT INTO storage_quotas (user_id, quota_bytes) VALUES ($1, $2)`, [uid, 500 * 1024 * 1024]);
const token = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url');
await admin.query(`INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`, [createHash('sha256').update(token).digest(), uid, csrf]);
// Something to look at in the notification bell, the admin lists and the abuse-report queue.
await admin.query(`INSERT INTO notifications (user_id, kind, title, body, created_at) VALUES
  ($1, 'download_completed', 'Download finished: ubuntu.iso', '4.7 GB saved to My Files.', now() - interval '5 minutes'),
  ($1, 'download_failed', 'Download failed: broken.zip', 'The server answered 404 (not found).', now() - interval '2 hours'),
  ($1, 'quota_warning', 'Your storage is almost full', 'You are using 93% of your storage quota.', now() - interval '1 day')`, [uid]);
const other = (await admin.query(`INSERT INTO users (email, email_verified) VALUES ('sam@example.com', true) RETURNING id`)).rows[0].id;
await admin.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 1)`, [other]);
await admin.query(`INSERT INTO storage_quotas (user_id, quota_bytes, used_bytes) VALUES ($1, $2, $3)`, [other, 100 * 1024 * 1024, 91 * 1024 * 1024]);
await admin.query(`INSERT INTO abuse_reports (file_name, owner_id, reason, details, reporter_hash) VALUES ('holiday-photos.zip', $1, 'privacy', 'These are my photos and I did not agree to share them.', 'x')`, [other]);
await admin.end();

start('server.js');
start('worker.js');
const base = `http://127.0.0.1:${API_PORT}/api/v1`;
for (let i = 0; i < 100; i++) { if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) break; await new Promise((r) => setTimeout(r, 200)); }

const fx = await fixtures();
const uploaded: Record<string, string> = {};
for (const name of ['long.webm', 'long.srt', 'clip.webm', 'old.avi', 'tone.mp3', 'covered.mp3', 'multi.mkv', 'garbage.mp4']) {
  const fd = new FormData();
  fd.append('file', new Blob([fx.files[name]!]), name);
  const r = await fetch(`${base}/files/upload`, { method: 'POST', headers: { cookie: `cs_session=${token}`, 'x-csrf-token': csrf }, body: fd });
  if (r.status !== 201) throw new Error(`upload ${name}: ${r.status} ${await r.text()}`);
  uploaded[name] = ((await r.json()) as { id: string }).id;
}
writeFileSync(out, JSON.stringify({ apiPort: API_PORT, webOrigin: WEB_ORIGIN, cookieName: 'cs_session', token, csrf, bot: BOT, chat: CHAT, uploaded, logs }, null, 2));
console.log('READY', out);

startWeb();
setInterval(() => undefined, 1 << 30);
