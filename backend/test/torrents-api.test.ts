import bencode from 'bencode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, createTestEnv, login, type Session, type TestEnv } from './helpers.js';

let t: TestEnv;
let admin: Session;
let seq = 0;
let hashSeq = 0;
const hash = () => (++hashSeq).toString(16).padStart(40, 'a');
beforeAll(async () => {
  t = await createTestEnv({ TORRENT_ENABLED: 'true', TORRENT_MAX_ACTIVE_PER_USER: '4', TORRENT_MAX_FILES: '5', DEFAULT_USER_QUOTA_BYTES: String(1_000_000), MAX_FILE_SIZE_BYTES: String(600_000) });
  admin = await login(t, 'ta-admin', 'admin@example.com');
});
afterAll(async () => { await t.close(); });

const user = (): Promise<Session> => { const n = ++seq; return login(t, `ta-${n}`, `ta-${n}@example.com`); };
const call = (s: Session | null, method: string, url: string, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: s ? authed(s) : {}, payload: payload as object });
const magnet = (h = hash()) => `magnet:?xt=urn:btih:${h}&dn=Some%20Thing`;

function torrentFile(name: string, files: { path: string[]; length: number }[]): Buffer {
  const total = files.reduce((n, f) => n + f.length, 0);
  const pieces = Buffer.alloc(Math.max(1, Math.ceil(total / 16384)) * 20, 7);
  return Buffer.from(bencode.encode({ info: { name, files: files.map((f) => ({ length: f.length, path: f.path })), 'piece length': 16384, pieces } }));
}
const upload = (s: Session, bytes: Buffer, query = 'folder=root') => {
  const b = '----x';
  const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`), bytes, Buffer.from(`\r\n--${b}--\r\n`)]);
  return t.app.inject({ method: 'POST', url: `/api/v1/torrents/file?${query}`, headers: { ...authed(s), 'content-type': `multipart/form-data; boundary=${b}` }, payload: body });
};

describe('who may use it', () => {
  it('needs a session', async () => {
    for (const [m, u] of [['GET', '/torrents'], ['GET', '/torrents/status'], ['POST', '/torrents/magnet'], ['POST', '/torrents/file']] as const) {
      expect((await t.app.inject({ method: m, url: `/api/v1${u}` })).statusCode, u).toBe(401);
    }
  });

  it('reports what is allowed and carries a plain warning about exposure', async () => {
    const s = await user();
    const r = (await call(s, 'GET', '/torrents/status')).json();
    expect(r.enabled).toBe(true);
    expect(r.limits).toMatchObject({ maxFiles: 5, maxActivePerUser: 4, torrentFileMaxBytes: 2 * 1024 * 1024 });
    expect(r.notice).toMatch(/internet address/);
  });

  it('keeps every user\'s torrents to themselves', async () => {
    const a = await user(), b = await user();
    const mine = (await call(a, 'POST', '/torrents/magnet', { magnet: magnet() })).json();
    expect((await call(b, 'GET', `/torrents/${mine.id}`)).statusCode).toBe(404);
    for (const act of ['pause', 'resume', 'cancel', 'retry', 'start']) expect((await call(b, 'POST', `/torrents/${mine.id}/${act}`, {})).statusCode, act).toBe(404);
    expect((await call(b, 'DELETE', `/torrents/${mine.id}`)).statusCode).toBe(404);
    expect((await call(b, 'GET', '/torrents')).json().torrents).toEqual([]);
    expect((await call(a, 'GET', '/torrents')).json().torrents).toHaveLength(1);
  });

  it('is refused while an administrator has turned torrents off, and works again when they turn it back on', async () => {
    const s = await user();
    expect((await call(admin, 'PATCH', '/admin/settings', { torrents_enabled: false })).json().settings.torrents_enabled).toBe(false);
    try {
      const r = await call(s, 'POST', '/torrents/magnet', { magnet: magnet() });
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('torrents_disabled');
      expect((await call(s, 'GET', '/torrents/status')).json().enabled).toBe(false);
      expect((await call(admin, 'GET', '/admin/overview')).json().features.torrents).toBe(false);
    } finally { await call(admin, 'PATCH', '/admin/settings', { torrents_enabled: true }); }
    expect((await call(s, 'POST', '/torrents/magnet', { magnet: magnet() })).statusCode).toBe(201);
    expect((await call(s, 'PATCH', '/admin/settings', { torrents_enabled: false })).statusCode).toBe(403); // not for ordinary users
  });
});

describe('adding a magnet link', () => {
  it('creates a pending job from a valid link', async () => {
    const s = await user();
    const h = hash();
    const r = await call(s, 'POST', '/torrents/magnet', { magnet: magnet(h) });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ source: 'magnet', state: 'pending', infoHash: h, name: 'Some Thing', fileCount: 0, error: null });
  });

  it('rejects links that are not magnet links, are too long, or are for a missing folder', async () => {
    const s = await user();
    for (const bad of ['https://example.com/x.torrent', 'magnet:?dn=nothing', 'javascript:alert(1)', `magnet:?xt=urn:btih:${hash()}&dn=${'a'.repeat(5000)}`]) {
      expect((await call(s, 'POST', '/torrents/magnet', { magnet: bad })).statusCode, bad.slice(0, 30)).toBe(400);
    }
    expect((await call(s, 'POST', '/torrents/magnet', {})).statusCode).toBe(400);
    expect((await call(s, 'POST', '/torrents/magnet', { magnet: magnet(), folderId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
  });

  it('will not put results into someone else\'s folder', async () => {
    const a = await user(), b = await user();
    const theirs = (await call(b, 'POST', '/folders', { name: 'private', parentId: null })).json().id;
    expect((await call(a, 'POST', '/torrents/magnet', { magnet: magnet(), folderId: theirs })).statusCode).toBe(404);
  });

  it('refuses the same torrent twice while it is live, but allows it again after it finished', async () => {
    const s = await user();
    const h = hash();
    const first = (await call(s, 'POST', '/torrents/magnet', { magnet: magnet(h) })).json();
    const dup = await call(s, 'POST', '/torrents/magnet', { magnet: magnet(h.toUpperCase()) });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('already_added');
    await call(s, 'POST', `/torrents/${first.id}/cancel`, {});
    expect((await call(s, 'POST', '/torrents/magnet', { magnet: magnet(h) })).statusCode).toBe(201);
    const other = await user(); // another user may add the same torrent
    expect((await call(other, 'POST', '/torrents/magnet', { magnet: magnet(h) })).statusCode).toBe(201);
  });

  it('limits how many unfinished torrents one person can have', async () => {
    const s = await user();
    for (let i = 0; i < 4; i++) expect((await call(s, 'POST', '/torrents/magnet', { magnet: magnet() })).statusCode).toBe(201);
    const r = await call(s, 'POST', '/torrents/magnet', { magnet: magnet() });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe('too_many_torrents');
  });
});

describe('uploading a .torrent file', () => {
  it('reads it at once and waits for the user to pick files', async () => {
    const s = await user();
    const r = await upload(s, torrentFile('Pack', [{ path: ['a.bin'], length: 100_000 }, { path: ['sub', 'b.bin'], length: 200_000 }]));
    expect(r.statusCode, r.body).toBe(201);
    const j = r.json();
    expect(j).toMatchObject({ source: 'file', name: 'Pack', state: 'awaiting_selection', totalBytes: 300_000, fileCount: 2, selectedCount: 2 });
    expect(j.files.map((f: any) => f.path)).toEqual(['Pack/a.bin', 'Pack/sub/b.bin']);
    expect(JSON.stringify(j)).not.toMatch(/metainfo/);
  });

  it('can start straight away when it fits, and explains when it does not', async () => {
    const s = await user();
    expect((await upload(s, torrentFile('Fits', [{ path: ['a'], length: 1000 }]), 'folder=root&autoStart=true')).json().state).toBe('queued');
    const big = await upload(s, torrentFile('Huge', [{ path: ['a'], length: 900_000 }]), 'folder=root&autoStart=true'); // over the 600 000-byte file limit
    expect(big.json()).toMatchObject({ state: 'awaiting_selection', error: { code: 'file_too_large' } });
  });

  it('rejects files that are not torrents, empty ones, ones with too many files, and oversize uploads', async () => {
    const s = await user();
    expect((await upload(s, Buffer.from('hello there'))).statusCode).toBe(400);
    expect((await upload(s, Buffer.from('this is 20 bytes!!!!'))).statusCode).toBe(400); // exactly the length of a bare info hash
    expect((await upload(s, Buffer.alloc(0))).statusCode).toBe(400);
    expect((await upload(s, Buffer.alloc(3 * 1024 * 1024, 100))).statusCode).toBe(400);
    const many = torrentFile('Many', Array.from({ length: 6 }, (_, i) => ({ path: [`f${i}`], length: 10 })));
    const r = await upload(s, many);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('too_many_files');
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/torrents/file', headers: authed(s), payload: { a: 1 } })).statusCode).toBe(400); // not multipart
  });

  it('keeps hostile file names out of the file list', async () => {
    const s = await user();
    const r = await upload(s, torrentFile('..', [{ path: ['..', '..', 'etc', 'passwd'], length: 10 }, { path: ['x\u0000y', 'CON:?.txt'], length: 10 }]));
    expect(r.statusCode, r.body).toBe(201);
    for (const f of r.json().files) {
      expect(f.path).not.toMatch(/(^|\/)\.\.(\/|$)/);
      expect(f.path).not.toMatch(/[\u0000:?]/);
      expect(f.path.startsWith('/')).toBe(false);
    }
  });
});

describe('choosing files and controlling a download', () => {
  const ready = async (s: Session, sizes = [100_000, 200_000, 300_000]) =>
    (await upload(s, torrentFile(`T${++seq}`, sizes.map((length, i) => ({ path: [`f${i}.bin`], length }))))).json();

  it('queues the chosen files and records the choice', async () => {
    const s = await user();
    const j = await ready(s);
    const r = await call(s, 'POST', `/torrents/${j.id}/start`, { files: [0, 2] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ state: 'queued', selectedCount: 2, selectedBytes: 400_000 });
    expect(r.json().files.map((f: any) => f.selected)).toEqual([true, false, true]);
    expect((await call(s, 'POST', `/torrents/${j.id}/start`, {})).json().error.code).toBe('invalid_state'); // only once
  });

  it('refuses nonsense choices and anything that does not fit, before any download', async () => {
    const s = await user();
    const j = await ready(s);
    expect((await call(s, 'POST', `/torrents/${j.id}/start`, { files: [] })).json().error.code).toBe('nothing_selected');
    expect((await call(s, 'POST', `/torrents/${j.id}/start`, { files: [7] })).json().error.code).toBe('invalid_file');
    expect((await call(s, 'POST', `/torrents/${j.id}/start`, { files: [-1] })).statusCode).toBe(400);
    expect((await call(s, 'POST', `/torrents/${j.id}/start`, { folderId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
    const huge = await ready(s, [700_000]);
    expect((await call(s, 'POST', `/torrents/${huge.id}/start`, {})).json().error.code).toBe('file_too_large');
    const poor = await user();
    await t.db.query(`UPDATE storage_quotas SET used_bytes = quota_bytes - 150000 WHERE user_id = $1`, [poor.userId]);
    const r = await call(poor, 'POST', `/torrents/${(await ready(poor)).id}/start`, {});
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('quota_exceeded');
  });

  it('can choose the destination folder when starting', async () => {
    const s = await user();
    const folder = (await call(s, 'POST', '/folders', { name: 'Downloads', parentId: null })).json().id;
    const j = await ready(s);
    expect((await call(s, 'POST', `/torrents/${j.id}/start`, { folderId: folder })).json().folderId).toBe(folder);
  });

  it('pauses and resumes a queued torrent, and cancels one at any stage before the end', async () => {
    const s = await user();
    const j = await ready(s);
    await call(s, 'POST', `/torrents/${j.id}/start`, {});
    expect((await call(s, 'POST', `/torrents/${j.id}/pause`, {})).json().state).toBe('paused');
    expect((await call(s, 'POST', `/torrents/${j.id}/pause`, {})).json().error.code).toBe('invalid_state');
    expect((await call(s, 'POST', `/torrents/${j.id}/resume`, {})).json().state).toBe('queued');
    expect((await call(s, 'POST', `/torrents/${j.id}/cancel`, {})).json().state).toBe('cancelled');
    expect((await call(s, 'POST', `/torrents/${j.id}/cancel`, {})).json().error.code).toBe('invalid_state');
    expect((await call(s, 'POST', `/torrents/${j.id}/resume`, {})).json().error.code).toBe('invalid_state');
  });

  it('asks a running job to stop by raising a flag the worker obeys', async () => {
    const s = await user();
    const j = await ready(s);
    await t.db.query(`UPDATE torrent_jobs SET state = 'downloading', worker_id = 'w1' WHERE id = $1`, [j.id]);
    await call(s, 'POST', `/torrents/${j.id}/pause`, {});
    expect((await t.db.query<any>(`SELECT control FROM torrent_jobs WHERE id = $1`, [j.id])).rows[0].control).toBe('pause');
    await call(s, 'POST', `/torrents/${j.id}/cancel`, {});
    expect((await t.db.query<any>(`SELECT control FROM torrent_jobs WHERE id = $1`, [j.id])).rows[0].control).toBe('cancel');
    await t.db.query(`UPDATE torrent_jobs SET state = 'importing' WHERE id = $1`, [j.id]);
    expect((await call(s, 'POST', `/torrents/${j.id}/cancel`, {})).json().error.code).toBe('invalid_state'); // too late: files are being moved in
  });

  it('retries a failed torrent from where it can, and removes finished ones from the list', async () => {
    const s = await user();
    const j = await ready(s);
    await call(s, 'POST', `/torrents/${j.id}/start`, {});
    await t.db.query(`UPDATE torrent_jobs SET state = 'failed', error_code = 'stalled', error_message = 'no data', attempt = 3 WHERE id = $1`, [j.id]);
    expect((await call(s, 'DELETE', `/torrents/${j.id}`)).statusCode).toBe(204); // failed jobs can be removed...
    const k = await ready(s);
    await call(s, 'POST', `/torrents/${k.id}/start`, {});
    await t.db.query(`UPDATE torrent_jobs SET state = 'failed', error_code = 'stalled', error_message = 'no data', attempt = 3 WHERE id = $1`, [k.id]);
    const r = await call(s, 'POST', `/torrents/${k.id}/retry`, {});
    expect(r.json()).toMatchObject({ state: 'queued', error: null }); // the earlier choice is kept
    expect((await call(s, 'DELETE', `/torrents/${k.id}`)).json().error.code).toBe('invalid_state'); // ...but a live one must be cancelled first
    const m = (await call(s, 'POST', '/torrents/magnet', { magnet: magnet() })).json();
    await t.db.query(`UPDATE torrent_jobs SET state = 'failed', error_code = 'metadata_timeout' WHERE id = $1`, [m.id]);
    expect((await call(s, 'POST', `/torrents/${m.id}/retry`, {})).json().state).toBe('pending'); // no file list yet: start from the beginning
    expect((await call(s, 'POST', `/torrents/${m.id}/retry`, {})).json().error.code).toBe('invalid_state');
  });
});

describe('what the administrator sees', () => {
  it('shows torrent job states in operations and metrics, without names or links', async () => {
    const s = await user();
    await call(s, 'POST', '/torrents/magnet', { magnet: `magnet:?xt=urn:btih:${hash()}&dn=VerySecretTitle` });
    const q = await call(admin, 'GET', '/admin/queues');
    expect(q.json().torrents.find((x: any) => x.state === 'pending').count).toBeGreaterThanOrEqual(1);
    expect(q.body).not.toContain('VerySecretTitle');
  });
});
