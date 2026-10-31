/**
 * End-to-end smoke test against the BUILT code (run `npm run build` first):
 *   - a REAL PostgreSQL server (embedded binaries, started with pg_ctl) and the real `pg` driver
 *   - API and worker as separate OS processes
 *   - a worker is SIGKILLed mid-download and a new worker must recover and finish the file
 * Google OAuth is bypassed by inserting a session row directly (the OAuth flow itself is covered by the test suite).
 *
 *   npx tsx scripts/smoke.mts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import WebTorrent from 'webtorrent';
import pg from 'pg';
import { makeBytes, startOrigin } from '../backend/test/origin.js';
import { startFakeTelegram } from '../backend/test/fake-telegram.js';
import { ffmpegPath, ffprobePath, fixtures } from '../backend/test/media-fixtures.js';
import { startPostgres } from '../backend/test/pg-server.js';

const root = path.resolve(import.meta.dirname, '..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'cloudseed-smoke-'));
const API_PORT = 18080;
const results: { name: string; ok: boolean; detail?: string }[] = [];
const procs: ChildProcess[] = [];

const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | false | undefined>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn().catch(() => false); if (v) return v; await sleep(150); }
  throw new Error(`timed out waiting for ${what}`);
}

const origin = await startOrigin();
const postgres = await startPostgres();
const telegram = await startFakeTelegram();
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'development', LOG_LEVEL: 'warn', PORT: String(API_PORT), PUBLIC_URL: `http://127.0.0.1:${API_PORT}`,
  DATABASE_URL: postgres.adminUrl, MIGRATIONS_DIR: path.join(root, 'migrations'),
  SESSION_SECRET: 'x'.repeat(40), LOCAL_STORAGE_ROOT: path.join(tmp, 'storage'), LOCAL_TMP_DIR: path.join(tmp, 'tmp'),
  DOWNLOAD_WORKDIR: path.join(tmp, 'downloads'), DOWNLOAD_ALLOWED_CIDRS: '127.0.0.0/8', DOWNLOAD_ALLOWED_PORTS: String(origin.port),
  DOWNLOAD_LEASE_SECONDS: '3', WORKER_POLL_MS: '200', DOWNLOAD_BACKOFF_BASE_MS: '200', DEFAULT_USER_QUOTA_BYTES: String(50 * 1024 * 1024),
  MAX_FILE_SIZE_BYTES: String(20 * 1024 * 1024), DB_POOL_MAX: '3',
  FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: ffprobePath, MEDIA_WORKDIR: path.join(tmp, 'media'),
  ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'), TELEGRAM_API_BASE: telegram.url, TELEGRAM_LEASE_SECONDS: '3', TELEGRAM_CHAT_INTERVAL_MS: '0', WORKER_ALIVE_FILE: path.join(tmp, 'alive'),
  METRICS_TOKEN: 'smoke-metrics-token-1234567890',
  TORRENT_ENABLED: 'true', TORRENT_ALLOWED_CIDRS: '127.0.0.0/8', TORRENT_DHT: 'false', TORRENT_UPLOAD_LIMIT_BPS: '0',
  BACKUP_INTERVAL_HOURS: '24', BACKUP_PASSPHRASE: 'smoke scheduled passphrase', BACKUP_DIR: path.join(tmp, 'backups'), BACKUP_KEEP: '3',
};

function start(name: string, script: string): ChildProcess {
  const p = spawn(process.execPath, [path.join(root, 'backend/dist', script)], { env, cwd: path.join(root, 'backend'), stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(path.join(tmp, `${name}.log`));
  p.stdout!.pipe(log); p.stderr!.pipe(log);
  procs.push(p);
  return p;
}
const cleanup = async () => { for (const p of procs) p.kill('SIGKILL'); await origin.close(); await telegram.close(); postgres.stop(); };

try {
  // ---- database over the wire protocol ----
  const admin = new pg.Client({ connectionString: env.DATABASE_URL });
  await admin.connect();
  check('pg driver connects to a real PostgreSQL server', (await admin.query('SELECT 1 AS n')).rows[0].n === 1);

  const mig = spawn(process.execPath, [path.join(root, 'backend/dist/db/migrate-cli.js')], { env, cwd: path.join(root, 'backend') });
  let migOut = ''; mig.stdout.on('data', (d) => (migOut += d)); mig.stderr.on('data', (d) => (migOut += d));
  const migCode: number = await new Promise((r) => mig.on('exit', (c) => r(c ?? -1)));
  check('migrate CLI applies all migrations via pg', migCode === 0 && /applied 0002_downloads/.test(migOut), migCode === 0 ? '' : migOut.trim().slice(0, 1200));

  // ---- a user and a session (OAuth bypassed) ----
  const u = (await admin.query(`INSERT INTO users (email, email_verified) VALUES ('smoke@example.com', true) RETURNING id`)).rows[0].id;
  await admin.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 1)`, [u]);
  await admin.query(`INSERT INTO storage_quotas (user_id, quota_bytes) VALUES ($1, $2)`, [u, 50 * 1024 * 1024]);
  const token = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url');
  await admin.query(`INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')`,
    [createHash('sha256').update(token).digest(), u, csrf]);

  // ---- processes ----
  start('api', 'server.js');
  let worker = start('worker1', 'worker.js');
  const base = `http://127.0.0.1:${API_PORT}/api/v1`;
  await until(async () => (await fetch(`${base}/health`)).ok, 30000, 'API health');
  check('API (built, separate process) is healthy and talks to the DB through pg', true);

  const call = (method: string, p: string, body?: unknown) => fetch(`${base}${p}`, {
    method, headers: { cookie: `cs_session=${token}`, 'x-csrf-token': csrf, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const job = async (id: string) => (await (await call('GET', `/downloads/${id}`)).json()) as any;
  const bytesOf = async (fileId: string) => Buffer.from(await (await call('GET', `/files/${fileId}/content`)).arrayBuffer());

  // ---- SSE through the real server ----
  const sse = await fetch(`${base}/downloads/events`, { headers: { cookie: `cs_session=${token}` } });
  const seen: any[] = [];
  void (async () => {
    const rd = sse.body!.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await rd.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const d = /^data: (.+)$/m.exec(b)?.[1]; if (d) seen.push(JSON.parse(d)); }
    }
  })();

  // ---- 1. plain download through API -> worker process -> storage ----
  const SIZE1 = 2_000_000;
  let r = await call('POST', '/downloads', { url: `${origin.url}/file?size=${SIZE1}&seed=3&disp=smoke1.bin` });
  const j1 = (await r.json()) as any;
  check('POST /downloads creates a queued job', r.status === 201 && j1.state === 'queued', `status ${r.status}`);
  const d1 = await until(async () => { const j = await job(j1.id); return ['completed', 'failed'].includes(j.state) && j; }, 30000, 'download 1');
  check('worker process completes the download', d1.state === 'completed', d1.error?.message);
  if (d1.state !== 'completed') {
    console.log('DEBUG quota rows:', JSON.stringify((await admin.query('SELECT * FROM storage_quotas')).rows));
    console.log('DEBUG job row:', JSON.stringify((await admin.query('SELECT id,state,error_code,error_message,attempt,worker_id FROM download_jobs')).rows));
    console.log('DEBUG user:', JSON.stringify((await admin.query('SELECT id FROM users')).rows), 'session user', u);
  }
  check('stored file is byte-identical to the origin', (await bytesOf(d1.fileId)).equals(makeBytes(SIZE1, 3)));
  // A fast job can finish between two 1s SSE polls, so only the final state is guaranteed here; mid-download progress is checked on the slow job below.
  await until(async () => seen.some((e) => e.id === j1.id && e.state === 'completed'), 5000, 'SSE completion event');
  check('SSE delivers the completed state of the job over the real server', true);

  // ---- 2. pause then resume (Range) across the real API/worker boundary ----
  const SIZE2 = 3_000_000;
  const j2 = (await (await call('POST', '/downloads', { url: `${origin.url}/file?size=${SIZE2}&seed=4&slow=1000000&disp=smoke2.bin` })).json()) as any;
  await until(async () => (await job(j2.id)).bytesReceived > 200_000, 20000, 'progress on download 2');
  await call('POST', `/downloads/${j2.id}/pause`);
  const paused = await until(async () => { const j = await job(j2.id); return j.state === 'paused' && j; }, 10000, 'pause');
  check('pause stops the running download and keeps partial data', paused.bytesReceived > 0 && paused.bytesReceived < SIZE2, `${paused.bytesReceived} bytes`);
  await call('POST', `/downloads/${j2.id}/resume`);
  const d2 = await until(async () => { const j = await job(j2.id); return ['completed', 'failed'].includes(j.state) && j; }, 30000, 'download 2');
  check('resume completes via a Range request with identical bytes',
    d2.state === 'completed' && (await bytesOf(d2.fileId)).equals(makeBytes(SIZE2, 4)) && origin.log.some((q) => q.path === '/file' && /^bytes=\d+-$/.test(q.range ?? '')), d2.error?.message);

  const mid = seen.filter((e) => e.id === j2.id && e.state === 'downloading' && e.bytesReceived > 0 && e.bytesReceived < SIZE2);
  check('SSE streams intermediate progress for a slow download', mid.length >= 2 && new Set(mid.map((e) => e.bytesReceived)).size >= 2, `${mid.length} progress events`);

  // ---- 3. SIGKILL the worker mid-download; a new worker must recover it ----
  const SIZE3 = 4_000_000;
  const j3 = (await (await call('POST', '/downloads', { url: `${origin.url}/file?size=${SIZE3}&seed=5&slow=1000000&disp=smoke3.bin` })).json()) as any;
  await until(async () => (await job(j3.id)).bytesReceived > 300_000, 20000, 'progress on download 3');
  worker.kill('SIGKILL');
  await new Promise((r) => worker.on('exit', r));
  const afterKill = await job(j3.id);
  check('after SIGKILL the job is left mid-flight (not completed)', afterKill.state === 'downloading', afterKill.state);
  const rangeReqsBefore = origin.log.filter((q) => /^bytes=\d+-$/.test(q.range ?? '')).length;
  worker = start('worker2', 'worker.js');
  const d3 = await until(async () => { const j = await job(j3.id); return ['completed', 'failed'].includes(j.state) && j; }, 60000, 'recovery of download 3');
  check('a new worker recovers the orphaned job and finishes it', d3.state === 'completed', d3.error?.message);
  check('recovered file is byte-identical', d3.state === 'completed' && (await bytesOf(d3.fileId)).equals(makeBytes(SIZE3, 5)));
  check('recovery resumed from the partial file (Range) instead of restarting',
    origin.log.filter((q) => /^bytes=\d+-$/.test(q.range ?? '')).length > rangeReqsBefore);

  // ---- 4. Telegram: delivery through the real API + worker processes, and the no-duplicate rule after a crash ----
  const TOKEN = '424242424:AAEsmokeSmokeSmokeSmokeSmoke_token', BOT_ID = 424242424, CHAT = -1001234567890;
  telegram.addBot(TOKEN, { id: BOT_ID, username: 'smoke_bot' });
  telegram.addChat({ id: CHAT, type: 'supergroup', title: 'Smoke Group' }, { [BOT_ID]: { status: 'member' } });
  r = await call('POST', '/telegram/bots', { token: TOKEN });
  const botBody = await r.text();
  const bot = JSON.parse(botBody) as any;
  check('Telegram: bot connects through the real API (token validated with Telegram)', r.status === 201 && bot.username === 'smoke_bot', `status ${r.status}`);
  const enc = (await admin.query('SELECT token_enc FROM telegram_bots WHERE id = $1', [bot.id])).rows[0].token_enc as Buffer;
  check('Telegram: the token is neither returned by the API nor stored in plaintext', !botBody.includes(TOKEN) && !enc.toString('latin1').includes('smokeSmoke') && enc.length > 29);
  r = await call('POST', '/telegram/destinations', { botId: bot.id, chat: String(CHAT) });
  const dest = (await r.json()) as any;
  check('Telegram: destination is validated against real membership', r.status === 201 && dest.canSend === true && dest.type === 'supergroup');

  r = await call('POST', '/telegram/transfers', { destinationId: dest.id, fileIds: [d1.fileId], caption: 'smoke' });
  const tr1 = (await r.json()) as any;
  const tdone = await until(async () => { const j = (await (await call('GET', `/telegram/transfers/${tr1.id}`)).json()) as any; return ['sent', 'failed', 'partial'].includes(j.state) && j; }, 30000, 'telegram transfer 1');
  check('Telegram: the worker process delivers the file', tdone.state === 'sent', JSON.stringify(tdone.files?.[0]?.error));
  const got = telegram.sent.find((x) => x.method === 'sendDocument' && x.chatId === CHAT);
  check('Telegram: Telegram received the exact bytes, name and caption',
    !!got && got.files[0]!.size === SIZE1 && got.files[0]!.sha256 === createHash('sha256').update(makeBytes(SIZE1, 3)).digest('hex') && got.files[0]!.filename === 'smoke1.bin' && got.fields.caption === 'smoke');

  // A worker dies after the whole file has been handed to Telegram but before Telegram answered.
  telegram.setLatency(8000);
  const before = telegram.calls.filter((x) => x.method === 'sendDocument').length;
  r = await call('POST', '/telegram/transfers', { destinationId: dest.id, fileIds: [d2.fileId] });
  const tr2 = (await r.json()) as any;
  await until(async () => telegram.calls.filter((x) => x.method === 'sendDocument').length > before, 30000, 'request to reach Telegram');
  worker.kill('SIGKILL');
  await new Promise((res) => worker.on('exit', res));
  telegram.setLatency(0);
  worker = start('worker3', 'worker.js');
  const t2 = await until(async () => { const j = (await (await call('GET', `/telegram/transfers/${tr2.id}`)).json()) as any; return ['sent', 'failed', 'partial'].includes(j.state) && j; }, 60000, 'telegram crash recovery');
  check('Telegram: after a worker crash mid-delivery the file is marked delivery-unknown, not re-sent',
    t2.state === 'failed' && t2.files[0].ambiguous === true && t2.files[0].error.code === 'delivery_unknown', `${t2.state} ${JSON.stringify(t2.files?.[0]?.error)}`);
  await new Promise((res) => setTimeout(res, 1500));
  check('Telegram: no duplicate request was made by the recovering worker', telegram.calls.filter((x) => x.method === 'sendDocument').length === before + 1);
  r = await call('POST', `/telegram/transfers/${tr2.id}/retry`, {});
  check('Telegram: retrying an unknown-delivery file requires explicit confirmation', r.status === 409 && ((await r.json()) as any).error.code === 'confirmation_required');
  r = await call('POST', `/telegram/transfers/${tr2.id}/retry`, { confirmDuplicateRisk: true });
  const t3 = await until(async () => { const j = (await (await call('GET', `/telegram/transfers/${tr2.id}`)).json()) as any; return ['sent', 'failed', 'partial'].includes(j.state) && j; }, 30000, 'confirmed retry');
  check('Telegram: after confirmation the file is sent', r.status === 200 && t3.state === 'sent');

  // ---- 5. security + accounting ----
  r = await call('POST', '/downloads', { url: 'http://169.254.169.254/latest/meta-data/' });
  check('SSRF: cloud-metadata URL is rejected by the API', r.status === 400 && ((await r.json()) as any).error.code === 'blocked_destination');
  const noCsrf = await fetch(`${base}/downloads`, { method: 'POST', headers: { cookie: `cs_session=${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ url: `${origin.url}/file` }) });
  check('CSRF token is required over real HTTP', noCsrf.status === 403);
  const dash = (await (await call('GET', '/dashboard')).json()) as any;
  check('dashboard reflects real totals', dash.downloads.completed === 3 && dash.storage.usedBytes === SIZE1 + SIZE2 + SIZE3, JSON.stringify(dash.downloads));
  const left = (await admin.query(`SELECT count(*)::int AS n FROM download_jobs WHERE state NOT IN ('completed')`)).rows[0].n;
  check('no jobs left stuck in a non-terminal state', left === 0);

  // ---- 6. Media: FFmpeg indexing in the worker process, then authorised range streaming through the API ----
  const fx = await fixtures();
  const upload = async (name: string) => {
    const fd = new FormData();
    fd.append('file', new Blob([fx.files[name]!]), name);
    const res = await fetch(`${base}/files/upload`, { method: 'POST', headers: { cookie: `cs_session=${token}`, 'x-csrf-token': csrf }, body: fd });
    return { status: res.status, body: (await res.json()) as any };
  };
  const clip = await upload('clip.mp4');
  const evil = await upload('evil.mp4');
  const media = async (id: string) => (await (await call('GET', `/media/${id}`)).json()) as any;
  const mDone = await until(async () => { const m = await media(clip.body.id); return ['ready', 'failed', 'unsupported'].includes(m.status) && m; }, 60000, 'media indexing');
  check('Media: the worker process probes a video with FFmpeg', clip.status === 201 && mDone.status === 'ready' && mDone.width === 320 && mDone.videoCodec === 'h264', `${mDone.status} ${mDone.error ?? ''}`);
  const th = await call('GET', `/media/${clip.body.id}/thumbnail`);
  const thBytes = Buffer.from(await th.arrayBuffer());
  check('Media: a real JPEG thumbnail was generated and is served', th.status === 200 && thBytes[0] === 0xff && thBytes[1] === 0xd8 && thBytes.length > 500);
  const rng = await fetch(`${base}/media/${clip.body.id}/stream`, { headers: { cookie: `cs_session=${token}`, range: 'bytes=100-299' } });
  check('Media: Range requests return exactly the requested bytes', rng.status === 206 && Buffer.from(await rng.arrayBuffer()).equals(fx.files['clip.mp4']!.subarray(100, 300)));
  const anon = await fetch(`${base}/media/${clip.body.id}/stream`);
  check('Media: streaming requires a session', anon.status === 401);
  const eDone = await until(async () => { const m = await media(evil.body.id); return ['ready', 'failed', 'unsupported'].includes(m.status) && m; }, 60000, 'hostile playlist');
  check('Media: a playlist disguised as .mp4 is rejected and nothing is derived from it', eDone.status === 'unsupported' && eDone.hasThumbnail === false);
  const put = await call('PUT', `/media/${clip.body.id}/progress`, { positionMs: 1000, durationMs: 3000 });
  check('Media: playback progress is saved and returned', put.status === 200 && (await media(clip.body.id)).progress?.positionMs === 1000);

  // ---- 7. Sharing over real HTTP: anonymous download, limits, revoke ----
  const shareRes = await call('POST', '/shares', { fileId: d1.fileId, expiresInHours: 2, maxDownloads: 2, acknowledgePublic: true });
  const share = (await shareRes.json()) as any;
  check('Sharing: a link is created and its token is shown once', shareRes.status === 201 && /^[A-Za-z0-9_-]{43}$/.test(share.token));
  const pub = (p: string, init: RequestInit = {}) => fetch(`${base}/public/shares/${share.token}${p}`, init); // no cookie: an anonymous visitor
  const dlA = await pub('/download');
  const dlBytes = Buffer.from(await dlA.arrayBuffer());
  check('Sharing: an anonymous visitor downloads the exact bytes as an attachment',
    dlA.status === 200 && dlBytes.equals(makeBytes(SIZE1, 3)) && /attachment/.test(dlA.headers.get('content-disposition') ?? '') && dlA.headers.get('x-content-type-options') === 'nosniff');
  await (await pub('/download')).arrayBuffer();
  const dlC = await pub('/download');
  check('Sharing: the download limit holds (third download refused)', dlC.status === 410 && ((await dlC.json()) as any).error.code === 'share_exhausted');
  const share2 = (await (await call('POST', '/shares', { fileId: d1.fileId, expiresInHours: 2, acknowledgePublic: true })).json()) as any;
  await call('POST', `/shares/${share2.id}/revoke`, {});
  const dlR = await fetch(`${base}/public/shares/${share2.token}/download`);
  check('Sharing: a revoked link stops working at once', dlR.status === 410 && ((await dlR.json()) as any).error.code === 'share_revoked');

  // folder link: browse and download everything as a ZIP, anonymously
  const folder = (await (await call('POST', '/folders', { name: 'Shared folder', parentId: null })).json()) as any;
  const inFolder = new FormData();
  inFolder.append('file', new Blob(['folder file contents']), 'inside.txt');
  const up2 = await fetch(`${base}/files/upload?folder=${folder.id}`, { method: 'POST', headers: { cookie: `cs_session=${token}`, 'x-csrf-token': csrf }, body: inFolder });
  check('Folder sharing: a file is uploaded into the folder', up2.status === 201);
  const fshare = (await (await call('POST', '/shares', { folderId: folder.id, expiresInHours: 2, acknowledgePublic: true })).json()) as any;
  const listing = (await (await fetch(`${base}/public/shares/${fshare.token}/list`)).json()) as any;
  check('Folder sharing: an anonymous visitor can list the folder', listing.files?.length === 1 && listing.files[0].name === 'inside.txt' && listing.path[0].name === 'Shared folder');
  const zipRes = await fetch(`${base}/public/shares/${fshare.token}/zip`);
  const unzipped = unzipSync(new Uint8Array(await zipRes.arrayBuffer()));
  check('Folder sharing: the ZIP is a valid archive with the exact file',
    zipRes.status === 200 && zipRes.headers.get('content-type') === 'application/zip' && Buffer.from(unzipped['Shared folder/inside.txt']!).toString() === 'folder file contents', Object.keys(unzipped).join());

  // ---- 8. Administration, health and metrics ----
  const anonAdmin = await fetch(`${base}/admin/overview`);
  check('Admin: the admin API requires a session', anonAdmin.status === 401);
  const notAdmin = await call('GET', '/admin/overview');
  check('Admin: a normal user is refused', notAdmin.status === 403);
  await admin.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 2)`, [u]);
  const ov = (await (await call('GET', '/admin/overview')).json()) as any;
  check('Admin: an administrator sees real totals', ov.users.active === 1 && ov.storage.files >= 5, JSON.stringify(ov.users));
  const workers = await until(async () => { const w = ((await (await call('GET', '/admin/workers')).json()) as any).workers; return w.some((x: any) => x.alive) && w; }, 20000, 'worker heartbeat');
  check('Admin: the worker process reports a heartbeat', workers.some((x: any) => x.role === 'worker' && x.alive));
  const ready = await fetch(`${base}/health/ready`);
  check('Health: /health/ready reports the database and workers', ready.status === 200 && ((await ready.json()) as any).workers >= 1);
  const m401 = await fetch(`${base}/metrics`, { headers: { cookie: `cs_session=${token}` } });
  const mOk = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${env.METRICS_TOKEN}` } });
  const mText = await mOk.text();
  check('Metrics: needs the bearer token, then serves Prometheus text without personal data',
    m401.status === 401 && mOk.status === 200 && mText.includes('cloudseed_download_jobs{state="completed"}') && !mText.includes('smoke@example.com'));

  // The worker process made a scheduled backup on start-up (BACKUP_INTERVAL_HOURS), while downloads were running.
  const sched = await until(async () => {
    const list = (await (await call('GET', '/admin/backups')).json()) as any;
    const r = list.runs.find((x: any) => ['succeeded', 'failed'].includes(x.status));
    return r && { r, list };
  }, 60000, 'the scheduled backup');
  check('Backups: the worker made a scheduled backup that was verified after writing', sched.r.status === 'succeeded' && sched.r.verified === true && sched.r.trigger === 'schedule', sched.r.error ?? '');
  const schedFile = path.join(tmp, 'backups', sched.r.fileName ?? 'missing');
  const sv = await new Promise<{ code: number; out: string }>((resolve) => {
    const c = spawn(process.execPath, [path.join(root, 'backend/dist/cli.js'), 'verify', schedFile], { env: { ...env, BACKUP_PASSPHRASE: 'smoke scheduled passphrase' }, cwd: path.join(root, 'backend') });
    let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d)); c.on('exit', (code) => resolve({ code: code ?? -1, out }));
  });
  check('Backups: the CLI can open the scheduled backup with its passphrase', sv.code === 0 && /^OK/m.test(sv.out), sv.out.slice(0, 200));
  const manual = await call('POST', '/admin/backups/run', {});
  check('Backups: an administrator can request a backup now', manual.status === 202);
  const after = await until(async () => {
    const list = (await (await call('GET', '/admin/backups')).json()) as any;
    const r = list.runs.find((x: any) => x.trigger === 'manual' && ['succeeded', 'failed'].includes(x.status));
    return r;
  }, 60000, 'the requested backup');
  check('Backups: the requested backup is made by the worker and verified', after.status === 'succeeded' && after.verified === true, after.error ?? '');

  // ---- 9. Backup, verify, restore and reconcile with the built CLI, while the app keeps running ----
  const cli = (args: string[], over: NodeJS.ProcessEnv = {}) => new Promise<{ code: number; out: string }>((resolve) => {
    const c = spawn(process.execPath, [path.join(root, 'backend/dist/cli.js'), ...args], { env: { ...env, BACKUP_PASSPHRASE: 'smoke test passphrase 123', ...over }, cwd: path.join(root, 'backend') });
    let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
    c.on('exit', (code) => resolve({ code: code ?? -1, out }));
  });
  const bak = path.join(tmp, 'smoke.csbk');
  const b1 = await cli(['backup', '--out', bak]);
  check('Backup: the CLI writes an encrypted backup of the live system', b1.code === 0 && existsSync(bak) && statSync(bak).size > 1000, b1.out.slice(-400));
  const raw = readFileSync(bak);
  check('Backup: no plaintext (email, file name) in the file', !raw.includes(Buffer.from('smoke@example.com')) && !raw.includes(Buffer.from('smoke1.bin')));
  const v1 = await cli(['verify', bak]);
  check('Backup: verify passes with the right passphrase', v1.code === 0 && /^OK/m.test(v1.out), v1.out.slice(0, 300));
  const v2 = await cli(['verify', bak], { BACKUP_PASSPHRASE: 'definitely not the passphrase' });
  check('Backup: verify fails with the wrong passphrase', v2.code === 1 && /wrong passphrase/.test(v2.out));

  await admin.query('CREATE DATABASE restored');
  const restoredUrl = new URL(postgres.adminUrl); restoredUrl.pathname = '/restored';
  const restoredEnv = { DATABASE_URL: restoredUrl.toString(), LOCAL_STORAGE_ROOT: path.join(tmp, 'restored-storage'), LOCAL_TMP_DIR: path.join(tmp, 'restored-tmp') };
  const noYes = await cli(['restore', bak], restoredEnv);
  check('Restore: refuses to run without --yes', noYes.code === 1 && /--yes/.test(noYes.out));
  const rs = await cli(['restore', bak, '--yes'], restoredEnv);
  check('Restore: loads the backup into a fresh database and storage', rs.code === 0 && /Restored \d+ rows/.test(rs.out), rs.out.slice(-500));
  const rdb = new pg.Client({ connectionString: restoredUrl.toString() });
  await rdb.connect();
  const sum = async (c: pg.Client) => (await c.query(`SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM files)::int AS files, (SELECT COALESCE(sum(size_bytes),0) FROM files)::bigint AS bytes, (SELECT count(*) FROM shared_links)::int AS shares`)).rows[0];
  const [orig, rest] = [await sum(admin), await sum(rdb)];
  check('Restore: the restored database matches the original', JSON.stringify(orig) === JSON.stringify(rest) && orig.files >= 5, JSON.stringify([orig, rest]));
  await rdb.end();
  const rc = await cli(['reconcile'], restoredEnv);
  check('Reconcile: the restored system is fully consistent (database and files agree)', rc.code === 0 && /consistent/.test(rc.out), rc.out.slice(-500));
  const rc0 = await cli(['reconcile']);
  check('Reconcile: the live system is consistent too', rc0.code === 0, rc0.out.slice(-500));
  const drill = await cli(['restore-test', bak]);
  check('Restore test: a backup is proven restorable in a throwaway database, which is removed again',
    drill.code === 0 && /RESTORE TEST PASSED/.test(drill.out) && (await admin.query(`SELECT 1 FROM pg_database WHERE datname LIKE 'cloudseed_drill_%'`)).rowCount === 0, drill.out.slice(-400));
  const again = await cli(['restore', bak, '--yes'], restoredEnv);
  check('Restore: refuses a database that already has data', again.code === 1 && /not empty/.test(again.out));
  // ---- 10. A magnet link, through the built API and worker processes, from a real local BitTorrent peer ----
  const torrentData = makeBytes(300_000, 42);
  const seeder: any = new (WebTorrent as any)({ dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false });
  try {
    const seeded: any = await new Promise((res) => seeder.seed(Object.assign(Buffer.from(torrentData), { name: 'smoke-torrent.bin' }), { announce: [] }, res));
    await until(async () => seeder.torrentPort > 0, 10000, 'the local seeder');
    const magnet = `magnet:?xt=urn:btih:${seeded.infoHash}&dn=smoke-torrent.bin&x.pe=127.0.0.1:${seeder.torrentPort}`;
    const tr = await call('POST', '/torrents/magnet', { magnet, autoStart: true });
    const tj = (await tr.json()) as any;
    check('Torrents: a magnet link is accepted', tr.status === 201 && tj.state === 'pending', `status ${tr.status}`);
    const finished = await until(async () => { const j = (await (await call('GET', `/torrents/${tj.id}`)).json()) as any; return ['completed', 'failed'].includes(j.state) && j; }, 90000, 'the torrent');
    check('Torrents: the worker process finds the file list, downloads from the peer and imports it', finished.state === 'completed', JSON.stringify(finished.error));
    const tf = (await admin.query(`SELECT id, size_bytes FROM files WHERE name = 'smoke-torrent.bin'`)).rows[0];
    check('Torrents: the imported file is byte-identical', !!tf && (await bytesOf(tf.id)).equals(torrentData));
    const pub = await call('GET', '/torrents/status');
    check('Torrents: the status endpoint explains the exposure', ((await pub.json()) as any).notice.includes('internet address'));
  } finally { await new Promise<void>((r) => seeder.destroy(() => r())); }

  await admin.end();
} catch (e) {
  check('smoke test ran to completion', false, (e as Error).message);
  console.log(`logs in ${tmp}`);
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
