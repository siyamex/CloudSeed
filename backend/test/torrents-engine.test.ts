import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebTorrent from 'webtorrent';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { TorrentEngine, createSafeClient, type WtClient } from '../src/torrents/engine.js';
import { authed, createTestEnv, login, type Session, type TestEnv } from './helpers.js';
import { makeBytes } from './origin.js';

const silent = { info() {}, warn() {}, error() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, ms = 30000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(40); }
  throw new Error(`timed out waiting for ${what}`);
}

interface Seed { client: any; torrent: any; port: number; magnet: string; file: Buffer; hash: string; close(): Promise<void> }
const seeders: Seed[] = [];
/** A real BitTorrent peer on localhost with no tracker and no DHT: the only way to reach it is to be told its address. */
async function seed(input: Buffer | string, opts: { name?: string; uploadLimit?: number } = {}): Promise<Seed> {
  const client = new (WebTorrent as any)({ dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false, uploadLimit: opts.uploadLimit ?? -1 });
  const seedInput = Buffer.isBuffer(input) ? Object.assign(Buffer.from(input), { name: opts.name ?? 'data.bin' }) : input;
  const torrent: any = await new Promise((res) => client.seed(seedInput, { announce: [] }, res));
  await waitFor(async () => client.torrentPort > 0, 5000, 'seeder port');
  const s: Seed = {
    client, torrent, port: client.torrentPort, hash: torrent.infoHash, file: Buffer.isBuffer(input) ? input : Buffer.alloc(0),
    magnet: `magnet:?xt=urn:btih:${torrent.infoHash}&dn=${encodeURIComponent(torrent.name)}&x.pe=127.0.0.1:${client.torrentPort}`,
    close: () => new Promise((r) => client.destroy(() => r())),
  };
  seeders.push(s);
  return s;
}

let t: TestEnv;
let seq = 0;
const engines: TorrentEngine[] = [];
const user = (): Promise<Session> => { const n = ++seq; return login(t, `tr-${n}`, `tr-${n}@example.com`); };
const call = (s: Session, method: string, url: string, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: authed(s), payload: payload as object });
const mk = (over: Partial<Config> = {}, extra: Partial<ConstructorParameters<typeof TorrentEngine>[0]> = {}) => {
  const e = new TorrentEngine({ db: t.db, config: { ...t.config, ...over } as Config, storage: t.storage, log: silent, ...extra });
  engines.push(e); return e;
};
const state = async (s: Session, id: string) => (await call(s, 'GET', `/torrents/${id}`)).json();
const until = async (s: Session, id: string, ...states: string[]) => {
  let last: any = null;
  try { return await waitFor(async () => { last = await state(s, id); return states.includes(last.state) ? last : false; }, 40000, `torrent ${id.slice(0, 8)} -> ${states.join('|')}`); }
  catch (e) { throw new Error(`${(e as Error).message}; last seen: ${JSON.stringify({ ...last, files: undefined })}`); }
};
const filesOf = async (s: Session) => (await t.db.query<any>(`SELECT f.id, f.name, f.size_bytes, f.folder_id, f.storage_key, d.name AS folder FROM files f LEFT JOIN folders d ON d.id = f.folder_id WHERE f.user_id = $1 AND f.deleted_at IS NULL ORDER BY f.name`, [s.userId])).rows;
const bytesOf = async (key: string) => { const c: Buffer[] = []; for await (const x of await t.storage.get(key)) c.push(x as Buffer); return Buffer.concat(c); };

beforeAll(async () => {
  t = await createTestEnv({
    TORRENT_ENABLED: 'true', TORRENT_ALLOWED_CIDRS: '127.0.0.0/8', TORRENT_DHT: 'false', WORKER_POLL_MS: '30', TORRENT_METADATA_TIMEOUT_MS: '8000',
    DEFAULT_USER_QUOTA_BYTES: String(50 * 1024 * 1024), MAX_FILE_SIZE_BYTES: String(20 * 1024 * 1024), TORRENT_UPLOAD_LIMIT_BPS: '0',
  });
}, 60_000);
afterEach(async () => { for (const e of engines.splice(0)) await e.stop(); for (const s of seeders.splice(0)) await s.close(); });
afterAll(async () => { await t.close(); });

describe('a magnet link, end to end', () => {
  it('finds the metadata, waits for a choice, downloads exactly what was chosen and imports it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cs-seed-'));
    await mkdir(path.join(dir, 'Album', 'extras'), { recursive: true });
    const a = makeBytes(120_000, 1), b = makeBytes(90_000, 2), c = makeBytes(60_000, 3);
    await writeFile(path.join(dir, 'Album', 'one.bin'), a);
    await writeFile(path.join(dir, 'Album', 'two.bin'), b);
    await writeFile(path.join(dir, 'Album', 'extras', 'bonus.bin'), c);
    const sd = await seed(path.join(dir, 'Album'));

    const s = await user();
    const e = mk(); e.start();
    const created = (await call(s, 'POST', '/torrents/magnet', { magnet: sd.magnet })).json();
    expect(created.state).toBe('pending');
    const ready = await until(s, created.id, 'awaiting_selection');
    expect(ready.name).toBe('Album');
    expect(ready.files.map((f: any) => f.path).sort()).toEqual(['Album/extras/bonus.bin', 'Album/one.bin', 'Album/two.bin']);
    expect(ready.totalBytes).toBe(270_000);
    expect((await call(s, 'GET', '/notifications')).json().items.some((n: any) => n.kind === 'torrent_ready')).toBe(true);
    expect((await filesOf(s)).length).toBe(0); // nothing is downloaded before a choice is made

    const one = ready.files.find((f: any) => f.path.endsWith('one.bin')).i, bonus = ready.files.find((f: any) => f.path.endsWith('bonus.bin')).i;
    expect((await call(s, 'POST', `/torrents/${created.id}/start`, { files: [one, bonus] })).json().state).toBe('queued');
    const done = await until(s, created.id, 'completed', 'failed');
    expect(done.state, JSON.stringify(done.error)).toBe('completed');
    expect(done.importedFiles).toBe(2);

    const files = await filesOf(s);
    expect(files.map((f: any) => `${f.folder}/${f.name}`).sort()).toEqual(['Album/one.bin', 'extras/bonus.bin']); // folder layout kept, two.bin skipped
    expect((await bytesOf(files.find((f: any) => f.name === 'one.bin').storage_key)).equals(a)).toBe(true);
    expect((await bytesOf(files.find((f: any) => f.name === 'bonus.bin').storage_key)).equals(c)).toBe(true);
    const parent = (await t.db.query<any>(`SELECT d.name, p.name AS parent FROM folders d LEFT JOIN folders p ON p.id = d.parent_id WHERE d.id = $1`, [files.find((f: any) => f.name === 'bonus.bin').folder_id])).rows[0];
    expect(parent).toEqual({ name: 'extras', parent: 'Album' });
    expect((await t.db.query<any>(`SELECT used_bytes FROM storage_quotas WHERE user_id = $1`, [s.userId])).rows[0].used_bytes).toBeGreaterThanOrEqual(180_000);
    expect((await call(s, 'GET', '/notifications')).json().items.some((n: any) => n.kind === 'torrent_completed')).toBe(true);
    await sleep(200);
    expect(await readdir(e.baseDir()).catch(() => [])).toEqual([]); // the scratch folder is gone
    await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it('imports a single file straight into the chosen folder, and starts by itself when asked to', async () => {
    const data = makeBytes(150_000, 9);
    const sd = await seed(data, { name: 'movie.mkv' });
    const s = await user();
    const folder = (await call(s, 'POST', '/folders', { name: 'Films', parentId: null })).json().id;
    mk().start();
    const j = (await call(s, 'POST', '/torrents/magnet', { magnet: sd.magnet, folderId: folder, autoStart: true })).json();
    const done = await until(s, j.id, 'completed', 'failed');
    expect(done.state, JSON.stringify(done.error)).toBe('completed');
    const files = await filesOf(s);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: 'movie.mkv', folder: 'Films', size_bytes: 150_000 });
    expect((await bytesOf(files[0].storage_key)).equals(data)).toBe(true);
    expect(done.resultFolderId).toBeNull(); // no wrapper folder for a lone file
  }, 60_000);

  it('does not find a magnet that nobody is seeding, and says why', async () => {
    const s = await user();
    mk({ TORRENT_METADATA_TIMEOUT_MS: 1500 }).start();
    const j = (await call(s, 'POST', '/torrents/magnet', { magnet: `magnet:?xt=urn:btih:${'ab'.repeat(20)}&x.pe=127.0.0.1:9` })).json();
    const f = await until(s, j.id, 'failed');
    expect(f.error.code).toBe('metadata_timeout');
    expect(f.error.message).toMatch(/No peers could be found/);
  }, 30_000);
});

describe('a .torrent file', () => {
  it('lists the files immediately, downloads from a peer and imports', async () => {
    const data = makeBytes(100_000, 5);
    const sd = await seed(data, { name: 'doc.bin' });
    const s = await user();
    // a plain .torrent has no peer addresses, so the test client is told where its only peer is
    const wrapped = async (): Promise<WtClient> => {
      const c = await createSafeClient({ ...t.config, TORRENT_DHT: false, TORRENT_ALLOWED_CIDRS: '127.0.0.0/8' } as Config);
      const add = c.add.bind(c);
      c.add = (id: unknown, o: Record<string, unknown>) => { const tor = add(id, o); tor.once('infoHash', (() => (tor as any).addPeer(`127.0.0.1:${sd.port}`)) as never); return tor; };
      return c;
    };
    mk({}, { createClient: wrapped }).start();
    const m = (await call(s, 'POST', '/torrents/file?folder=root&autoStart=true', undefined)).statusCode; // no body: refused
    expect(m).toBe(400);
    const boundary = '----t';
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`), Buffer.from(sd.torrent.torrentFile), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/torrents/file?folder=root&autoStart=true', headers: { ...authed(s), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ source: 'file', name: 'doc.bin', state: 'queued', totalBytes: 100_000 }); // no metadata step for a file
    const done = await until(s, r.json().id, 'completed', 'failed');
    expect(done.state, JSON.stringify(done.error)).toBe('completed');
    expect((await bytesOf((await filesOf(s))[0].storage_key)).equals(data)).toBe(true);
  }, 60_000);
});

describe('pause, resume, cancel', () => {
  it('pauses a running download, keeps what it has, and finishes after resume with identical bytes', async () => {
    const data = makeBytes(1_200_000, 7);
    const sd = await seed(data, { name: 'slow.bin', uploadLimit: 250_000 });
    const s = await user();
    mk().start();
    const j = (await call(s, 'POST', '/torrents/magnet', { magnet: sd.magnet, autoStart: true })).json();
    await waitFor(async () => (await state(s, j.id)).bytesDone > 100_000, 30000, 'progress');
    await call(s, 'POST', `/torrents/${j.id}/pause`);
    const paused = await until(s, j.id, 'paused');
    expect(paused.bytesDone).toBeGreaterThan(0);
    expect(paused.bytesDone).toBeLessThan(1_200_000);
    expect(paused.peers).toBe(0);
    await call(s, 'POST', `/torrents/${j.id}/resume`);
    const done = await until(s, j.id, 'completed', 'failed');
    expect(done.state, JSON.stringify(done.error)).toBe('completed');
    expect((await bytesOf((await filesOf(s))[0].storage_key)).equals(data)).toBe(true);
  }, 90_000);

  it('cancels a running download and removes everything it had written', async () => {
    const sd = await seed(makeBytes(1_500_000, 8), { name: 'cancel.bin', uploadLimit: 200_000 });
    const s = await user();
    const e = mk(); e.start();
    const j = (await call(s, 'POST', '/torrents/magnet', { magnet: sd.magnet, autoStart: true })).json();
    await waitFor(async () => (await state(s, j.id)).bytesDone > 50_000, 30000, 'progress');
    await call(s, 'POST', `/torrents/${j.id}/cancel`);
    expect((await until(s, j.id, 'cancelled')).state).toBe('cancelled');
    await waitFor(async () => (await readdir(e.baseDir()).catch(() => [])).length === 0, 8000, 'scratch folder to be removed');
    expect(await filesOf(s)).toEqual([]);
  }, 60_000);
});

describe('what a torrent is NOT allowed to make this server do', () => {
  it('never connects to a peer on a private or loopback address unless the operator allowed that network', async () => {
    const sd = await seed(makeBytes(50_000, 4), { name: 'x.bin' });
    let wires = 0;
    sd.torrent.on('wire', () => { wires++; });
    const s = await user();
    // here 127.0.0.0/8 is NOT allowed, so the only known peer (a loopback address) must be ignored
    mk({ TORRENT_ALLOWED_CIDRS: '', TORRENT_METADATA_TIMEOUT_MS: 2500 }).start();
    const j = (await call(s, 'POST', '/torrents/magnet', { magnet: sd.magnet })).json();
    const f = await until(s, j.id, 'failed');
    expect(f.error.code).toBe('metadata_timeout');
    expect(wires).toBe(0); // the seeder never saw a connection attempt
  }, 30_000);

  it('never asks a tracker on a private address, and never fetches web seeds', async () => {
    const hits: string[] = [];
    const web: Server = createServer((req, res) => { hits.push(req.url ?? ''); res.writeHead(404); res.end(); });
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
    const port = (web.address() as AddressInfo).port;
    try {
      const sd = await seed(makeBytes(50_000, 6), { name: 'w.bin' });
      const s = await user();
      mk({ TORRENT_ALLOWED_CIDRS: '', TORRENT_METADATA_TIMEOUT_MS: 2500 }).start();
      const magnet = `magnet:?xt=urn:btih:${sd.hash}&tr=${encodeURIComponent(`http://127.0.0.1:${port}/announce`)}&ws=${encodeURIComponent(`http://127.0.0.1:${port}/file`)}&x.pe=127.0.0.1:${sd.port}`;
      const j = (await call(s, 'POST', '/torrents/magnet', { magnet })).json();
      await until(s, j.id, 'failed');
      await sleep(500);
      expect(hits).toEqual([]);
    } finally { web.closeAllConnections(); await new Promise((r) => web.close(r)); }
  }, 30_000);

  it('even with the network allowed for peers, trackers and web seeds on it stay blocked unless the operator allowed it (and then web seeds are still off)', async () => {
    const hits: string[] = [];
    const web: Server = createServer((req, res) => { hits.push(req.url ?? ''); res.writeHead(404); res.end(); });
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
    const port = (web.address() as AddressInfo).port;
    try {
      const sd = await seed(makeBytes(40_000, 11), { name: 'v.bin' });
      const s = await user();
      mk().start(); // loopback IS allowed here (lab setting), so the tracker may be asked, but a web seed must never be
      const magnet = `magnet:?xt=urn:btih:${sd.hash}&ws=${encodeURIComponent(`http://127.0.0.1:${port}/file`)}&x.pe=127.0.0.1:${sd.port}`;
      const j = (await call(s, 'POST', '/torrents/magnet', { magnet, autoStart: true })).json();
      const done = await until(s, j.id, 'completed', 'failed');
      expect(done.state, JSON.stringify(done.error)).toBe('completed');
      expect(hits).toEqual([]);
    } finally { web.closeAllConnections(); await new Promise((r) => web.close(r)); }
  }, 40_000);
});

describe('limits and failure handling', () => {
  it('refuses a selection larger than the free quota, before downloading anything', async () => {
    const sd = await seed(makeBytes(400_000, 12), { name: 'big.bin' });
    const s = await user();
    await t.db.query(`UPDATE storage_quotas SET quota_bytes = 100000 WHERE user_id = $1`, [s.userId]);
    mk().start();
    const j = (await call(s, 'POST', '/torrents/magnet', { magnet: sd.magnet })).json();
    const ready = await until(s, j.id, 'awaiting_selection');
    const r = await call(s, 'POST', `/torrents/${j.id}/start`, { files: [0] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('quota_exceeded');
    expect(ready.state).toBe('awaiting_selection');
  }, 30_000);

  it('fails with a clear message, and keeps the server alive, when the BitTorrent library cannot start', async () => {
    const s = await user();
    mk({}, { createClient: async () => { throw new Error('native module missing'); } }).start();
    const j = (await call(s, 'POST', '/torrents/magnet', { magnet: `magnet:?xt=urn:btih:${'cd'.repeat(20)}` })).json();
    const f = await until(s, j.id, 'failed');
    expect(f.error.code).toBe('client_unavailable');
    expect(f.error.message).toMatch(/could not start on this server/);
  }, 30_000);

  it('does nothing while an administrator has torrents switched off', async () => {
    const s = await user();
    await t.db.query(`INSERT INTO application_settings (key, value) VALUES ('torrents_enabled', 'false') ON CONFLICT (key) DO UPDATE SET value = 'false'`);
    try {
      mk().start();
      const r = await call(s, 'POST', '/torrents/magnet', { magnet: `magnet:?xt=urn:btih:${'ef'.repeat(20)}` });
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('torrents_disabled');
      await t.db.query(`INSERT INTO torrent_jobs (user_id, source, magnet, info_hash) VALUES ($1, 'magnet', 'x', $2)`, [s.userId, 'ef'.repeat(20)]);
      await sleep(300);
      expect((await t.db.query<any>(`SELECT state FROM torrent_jobs WHERE user_id = $1`, [s.userId])).rows[0].state).toBe('pending'); // untouched
    } finally { await t.db.query(`DELETE FROM application_settings WHERE key = 'torrents_enabled'`); }
  }, 30_000);

  it('recovers jobs whose worker vanished, and gives up on one that keeps killing its worker', async () => {
    const s = await user();
    const ins = async (attempt: number) => (await t.db.query<any>(
      `INSERT INTO torrent_jobs (user_id, source, magnet, info_hash, state, worker_id, lease_expires_at, attempt, metainfo) VALUES ($1, 'magnet', 'x', $2, 'downloading', 'dead', now() - interval '1 minute', $3, '\\x00') RETURNING id`,
      [s.userId, Math.random().toString(16).slice(2).padEnd(40, '0').slice(0, 40), attempt])).rows[0].id;
    const a = await ins(0), b = await ins(2);
    expect(await mk().recoverStale()).toBe(2);
    expect((await state(s, a)).state).toBe('queued');
    const dead = await state(s, b);
    expect(dead.state).toBe('failed');
    expect(dead.error.code).toBe('worker_lost');
  });

  it('runs at most TORRENT_CONCURRENCY jobs at once across workers', async () => {
    await t.db.query(`DELETE FROM torrent_jobs`); // this test counts rows, so start clean
    const s = await user();
    for (let i = 0; i < 3; i++) await t.db.query(`INSERT INTO torrent_jobs (user_id, source, magnet, info_hash, state) VALUES ($1, 'magnet', 'x', $2, 'pending')`, [s.userId, String(i).repeat(40)]);
    const e1 = mk({ TORRENT_CONCURRENCY: 2 }), e2 = mk({ TORRENT_CONCURRENCY: 2 });
    const got = [await e1.claim(), await e2.claim(), await e1.claim()];
    expect(got.filter(Boolean)).toHaveLength(2);
    expect(got[2]).toBeNull();
  });
});
