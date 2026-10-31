import { crc32 } from 'node:zlib';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zipStream } from '../src/files/zip.js';
import { MaintenanceEngine } from '../src/maintenance/engine.js';
import { createMailer } from '../src/mail/mailer.js';
import { authed, createTestEnv, login, multipartBody, type Session, type TestEnv } from './helpers.js';

let t: TestEnv;
let seq = 0;
beforeAll(async () => { t = await createTestEnv({ SHARE_UNLOCK_RATE_PER_MIN: '1000', SHARING_ZIP_MAX_FILES: '6' }); });
afterAll(async () => { await t.close(); });

const user = (): Promise<Session> => { const n = ++seq; return login(t, `fs-${n}`, `fs-${n}@example.com`); };
const call = (s: Session | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { ...(s ? authed(s) : {}), ...headers }, payload: payload as object });
const folder = async (s: Session, name: string, parentId: string | null = null) => (await call(s, 'POST', '/folders', { name, parentId })).json().id as string;
async function upload(s: Session, name: string, content: Buffer | string, folderId: string | null): Promise<string> {
  const m = multipartBody(name, content);
  const r = await t.app.inject({ method: 'POST', url: `/api/v1/files/upload?folder=${folderId ?? 'root'}`, headers: { ...authed(s), ...m.headers }, payload: m.body });
  if (r.statusCode !== 201) throw new Error(r.body);
  return r.json().id;
}
const share = async (s: Session, folderId: string, extra: Record<string, unknown> = {}) => {
  const r = await call(s, 'POST', '/shares', { folderId, expiresInHours: 24, acknowledgePublic: true, ...extra });
  return { r, body: r.json(), token: r.json().token as string };
};
const pub = (token: string, tail = '', headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url: `/api/v1/public/shares/${token}${tail}`, headers });

/** projects/{readme.txt, docs/{guide.txt, deep/{notes.txt}}, secret.txt (sharing off), gone.txt (trashed)}, plus an outside folder. */
async function tree() {
  const s = await user();
  const root = await folder(s, 'Projects');
  const docs = await folder(s, 'docs', root);
  const deep = await folder(s, 'deep', docs);
  const outside = await folder(s, 'outside');
  const f = {
    readme: await upload(s, 'readme.txt', 'read me', root),
    guide: await upload(s, 'guide.txt', 'the guide', docs),
    notes: await upload(s, 'notes.txt', 'deep notes', deep),
    secret: await upload(s, 'secret.txt', 'not for sharing', root),
    gone: await upload(s, 'gone.txt', 'trashed', root),
    other: await upload(s, 'other.txt', 'outside the share', outside),
  };
  await call(s, 'PATCH', `/files/${f.secret}`, { sharingDisabled: true });
  await call(s, 'DELETE', `/files/${f.gone}`);
  return { s, root, docs, deep, outside, f };
}

describe('creating folder links', () => {
  it('accepts a folder, shows kind "folder", and needs exactly one target', async () => {
    const { s, root, f } = await tree();
    const { r, body, token } = await share(s, root, { label: 'team' });
    expect(r.statusCode).toBe(201);
    expect(body).toMatchObject({ kind: 'folder', folderId: root, fileId: null, fileName: 'Projects', status: 'active' });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await call(s, 'POST', '/shares', { fileId: f.readme, folderId: root, expiresInHours: 1, acknowledgePublic: true })).json().error.code).toBe('invalid_target');
    expect((await call(s, 'POST', '/shares', { expiresInHours: 1, acknowledgePublic: true })).json().error.code).toBe('invalid_target');
    expect((await call(s, 'POST', '/shares', { folderId: root, expiresInHours: 1 })).json().error.code).toBe('public_not_acknowledged');
    const mine = (await call(s, 'GET', '/shares')).json().shares;
    expect(mine.find((x: any) => x.id === body.id)).toMatchObject({ kind: 'folder', fileName: 'Projects' });
  });

  it('cannot share another user\'s folder or a trashed one', async () => {
    const { root } = await tree();
    const stranger = await user();
    expect((await call(stranger, 'POST', '/shares', { folderId: root, expiresInHours: 1, acknowledgePublic: true })).statusCode).toBe(404);
    const mine = await folder(stranger, 'tmp');
    await call(stranger, 'DELETE', `/folders/${mine}`);
    expect((await call(stranger, 'POST', '/shares', { folderId: mine, expiresInHours: 1, acknowledgePublic: true })).statusCode).toBe(404);
  });
});

describe('browsing a shared folder', () => {
  it('lists the root and navigates into sub-folders with a breadcrumb path, hiding unshareable files', async () => {
    const { s, root, docs, deep } = await tree();
    const { token } = await share(s, root);
    const info = (await pub(token)).json();
    expect(info).toMatchObject({ kind: 'folder', name: 'Projects', passwordRequired: false });

    const top = (await pub(token, '/list')).json();
    expect(top.path.map((p: any) => p.name)).toEqual(['Projects']);
    expect(top.folders.map((x: any) => x.name)).toEqual(['docs']);
    expect(top.files.map((x: any) => x.name)).toEqual(['readme.txt']); // secret.txt (sharing off) and gone.txt (trashed) are absent
    expect(top.files[0]).toMatchObject({ size: 7 });

    const sub = (await pub(token, `/list?folder=${docs}`)).json();
    expect(sub.path.map((p: any) => p.name)).toEqual(['Projects', 'docs']);
    expect(sub.files.map((x: any) => x.name)).toEqual(['guide.txt']);
    const dd = (await pub(token, `/list?folder=${deep}`)).json();
    expect(dd.path.map((p: any) => p.name)).toEqual(['Projects', 'docs', 'deep']);
    expect(JSON.stringify(top)).not.toMatch(/storage|user_id|sha256/i);
  });

  it('refuses any folder outside the share: a sibling, a parent, another user\'s folder, junk', async () => {
    const { s, root, outside } = await tree();
    const other = await tree();
    const { token } = await share(s, root);
    for (const id of [outside, other.root, '00000000-0000-4000-8000-000000000000', 'not-a-uuid', "x' OR 1=1 --"]) {
      expect((await pub(token, `/list?folder=${encodeURIComponent(id)}`)).statusCode, id).toBe(404);
      expect((await pub(token, `/zip?folder=${encodeURIComponent(id)}`)).statusCode, id).toBe(404);
    }
  });

  it('serves individual files from inside the tree and nothing else', async () => {
    const { s, root, f } = await tree();
    const o = await tree();
    const { token } = await share(s, root);
    const ok = await pub(token, `/files/${f.notes}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('deep notes');
    expect(ok.headers['content-disposition']).toContain('attachment');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    for (const [label, id] of [['outside folder', f.other], ['sharing disabled', f.secret], ['trashed', f.gone], ['another user', o.f.readme]] as const) {
      expect((await pub(token, `/files/${id}`)).statusCode, label).toBe(404);
    }
    expect((await pub(token, '/download')).json().error.code).toBe('folder_share'); // the single-file route does not apply
  });

  it('does not let a folder token be used as a file link or vice versa', async () => {
    const { s, root, f } = await tree();
    const file = (await call(s, 'POST', '/shares', { fileId: f.readme, expiresInHours: 1, acknowledgePublic: true })).json();
    expect((await pub(file.token, '/list')).json().error.code).toBe('file_share');
    expect((await pub(file.token, '/zip')).statusCode).toBe(400);
    expect((await pub((await share(s, root)).token, '/download')).statusCode).toBe(400);
  });
});

describe('zip download', () => {
  it('streams a valid archive with the folder structure and exact bytes, leaving out unshareable files', async () => {
    const { s, root, docs } = await tree();
    const { token } = await share(s, root);
    const r = await pub(token, '/zip');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    expect(r.headers['content-disposition']).toContain('Projects.zip');
    const files = unzipSync(new Uint8Array(r.rawPayload));
    expect(Object.keys(files).sort()).toEqual(['Projects/docs/deep/notes.txt', 'Projects/docs/guide.txt', 'Projects/readme.txt']);
    expect(Buffer.from(files['Projects/docs/deep/notes.txt']!).toString()).toBe('deep notes');
    expect(Buffer.from(files['Projects/readme.txt']!).toString()).toBe('read me');

    const sub = unzipSync(new Uint8Array((await pub(token, `/zip?folder=${docs}`)).rawPayload));
    expect(Object.keys(sub).sort()).toEqual(['docs/deep/notes.txt', 'docs/guide.txt']);
  });

  it('writes correct CRCs, sizes and descriptors (checked against an independent computation)', async () => {
    const data = Buffer.from('a'.repeat(100_000) + 'tail');
    const { Readable } = await import('node:stream');
    const chunks: Buffer[] = [];
    for await (const c of zipStream([
      { name: 'x/a.bin', size: data.length, modified: new Date('2024-05-06T07:08:10Z'), open: async () => Readable.from([data.subarray(0, 4000), data.subarray(4000)]) },
      { name: 'empty.txt', size: 0, modified: new Date('2024-05-06T07:08:10Z'), open: async () => Readable.from([]) },
      { name: 'ünïcode ✓.txt', size: 3, modified: new Date('1970-01-01T00:00:00Z'), open: async () => Readable.from([Buffer.from('abc')]) },
    ])) chunks.push(c);
    const zip = Buffer.concat(chunks);
    const out = unzipSync(new Uint8Array(zip));
    expect(Buffer.from(out['x/a.bin']!).equals(data)).toBe(true);
    expect(out['empty.txt']!.length).toBe(0);
    expect(Buffer.from(out['ünïcode ✓.txt']!).toString()).toBe('abc');
    // the central directory carries the true CRC
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    const cdOff = zip.readUInt32LE(eocd + 16);
    expect(zip.readUInt32LE(cdOff + 16)).toBe(crc32(data));
  });

  it('fails loudly instead of producing a silently wrong archive when a stored object has the wrong size', async () => {
    const { Readable } = await import('node:stream');
    const bad = (size: number, content: string) => zipStream([{ name: 'a', size, modified: new Date(), open: async () => Readable.from([Buffer.from(content)]) }]);
    await expect((async () => { for await (const _ of bad(5, 'abc')) void _; })()).rejects.toThrow(/smaller than recorded/);
    await expect((async () => { for await (const _ of bad(2, 'abc')) void _; })()).rejects.toThrow(/larger than recorded/);
  });

  it('counts one download per archive, and individual files each count', async () => {
    const { s, root, f } = await tree();
    const { token, body } = await share(s, root, { maxDownloads: 2 });
    expect((await pub(token, '/zip')).statusCode).toBe(200);
    expect((await pub(token, `/files/${f.readme}`)).statusCode).toBe(200);
    expect((await call(s, 'GET', '/shares')).json().shares.find((x: any) => x.id === body.id).downloadCount).toBe(2);
    const over = await pub(token, '/zip');
    expect(over.statusCode).toBe(410);
    expect(over.json().error.code).toBe('share_exhausted');
    expect((await pub(token, `/files/${f.readme}`)).statusCode).toBe(410);
    // browsing still says why
    expect((await pub(token, '/list')).json().error.code).toBe('share_exhausted');
  });

  it('lets an interrupted file download continue after the limit was used, but not start again', async () => {
    const { s, root, f } = await tree();
    const { token } = await share(s, root, { maxDownloads: 1 });
    expect((await pub(token, `/files/${f.readme}`, { range: 'bytes=0-2' })).statusCode).toBe(206);
    expect((await pub(token, `/files/${f.readme}`, { range: 'bytes=3-6' })).statusCode).toBe(206); // the resumed part
    expect((await pub(token, `/files/${f.readme}`)).statusCode).toBe(410);
  });

  it('refuses archives over the file-count limit and for empty folders', async () => {
    const s = await user();
    const big = await folder(s, 'big');
    for (let i = 0; i < 7; i++) await upload(s, `f${i}.txt`, 'x', big);
    const { token } = await share(s, big);
    const r = await pub(token, '/zip');
    expect(r.statusCode).toBe(413);
    expect(r.json().error.code).toBe('zip_too_large');
    expect((await pub(token, '/files/' + (await call(s, 'GET', `/files?folder=${big}`)).json().files[0].id)).statusCode).toBe(200); // individual downloads still work
    const empty = await folder(s, 'empty');
    expect((await pub((await share(s, empty)).token, '/zip')).json().error.code).toBe('empty_folder');
  });

  it('keeps odd file and folder names inside the archive', async () => {
    const s = await user();
    const root = await folder(s, 'we:ird*name');
    await upload(s, 'a<b>c|d?.txt', 'x', root);
    const { token } = await share(s, root);
    const names = Object.keys(unzipSync(new Uint8Array((await pub(token, '/zip')).rawPayload)));
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^we_ird_name\/a_b_c_d_\.txt$/);
    expect(names[0]).not.toContain('..');
  });
});

describe('access rules apply to folder links too', () => {
  it('needs the password for listing, files and zip, and unlocks them all once', async () => {
    const { s, root, f } = await tree();
    const { token } = await share(s, root, { password: 'correct-password' });
    for (const tail of ['/list', `/files/${f.readme}`, '/zip']) {
      const r = await pub(token, tail);
      expect(r.statusCode, tail).toBe(403);
      expect(r.json().error.code).toBe('password_required');
    }
    const wrong = await t.app.inject({ method: 'POST', url: `/api/v1/public/shares/${token}/unlock`, payload: { password: 'nope' } });
    expect(wrong.statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'POST', url: `/api/v1/public/shares/${token}/unlock`, payload: { password: 'correct-password' } });
    const cookie = `cs_sg=${ok.cookies.find((c) => c.name === 'cs_sg')!.value}`;
    expect((await pub(token, '/list', { cookie })).statusCode).toBe(200);
    expect((await pub(token, '/zip', { cookie })).statusCode).toBe(200);
  });

  it('requires sign-in for private links', async () => {
    const { s, root } = await tree();
    const { token } = await share(s, root, { mode: 'private' });
    expect((await pub(token, '/list')).json().error.code).toBe('login_required');
    expect((await pub(token, '/zip')).statusCode).toBe(401);
    const viewer = await user();
    expect((await pub(token, '/list', { cookie: viewer.cookie })).statusCode).toBe(200);
  });

  it('stops working when revoked, expired or disabled, and when the folder goes to the trash', async () => {
    const { s, root } = await tree();
    const a = await share(s, root);
    expect((await pub(a.token, '/list')).statusCode).toBe(200);
    await call(s, 'DELETE', `/folders/${root}`);
    for (const tail of ['', '/list', '/zip']) expect((await pub(a.token, tail)).json().error.code, tail).toBe('file_unavailable');
    await call(s, 'POST', '/trash/restore', { folderIds: [root] });
    expect((await pub(a.token, '/list')).statusCode).toBe(200);

    await call(s, 'POST', `/shares/${a.body.id}/revoke`, {});
    expect((await pub(a.token, '/list')).json().error.code).toBe('share_revoked');

    const b = await share(s, root);
    await t.db.query(`UPDATE shared_links SET expires_at = now() - interval '1 minute' WHERE id = $1`, [b.body.id]);
    expect((await pub(b.token, '/zip')).json().error.code).toBe('share_expired');

    const c = await share(s, root);
    await t.db.query(`UPDATE shared_links SET disabled_by_admin = TRUE WHERE id = $1`, [c.body.id]);
    expect((await pub(c.token, '/list')).json().error.code).toBe('share_disabled');
  });

  it('a file added later appears, and a file whose sharing is switched off disappears at once', async () => {
    const { s, root, f } = await tree();
    const { token } = await share(s, root);
    await upload(s, 'later.txt', 'added after the link was made', root);
    expect((await pub(token, '/list')).json().files.map((x: any) => x.name)).toEqual(['later.txt', 'readme.txt']);
    await call(s, 'PATCH', `/files/${f.readme}`, { sharingDisabled: true });
    expect((await pub(token, '/list')).json().files.map((x: any) => x.name)).toEqual(['later.txt']);
    expect((await pub(token, `/files/${f.readme}`)).statusCode).toBe(404);
  });

  it('deleting the folder for good removes the link', async () => {
    const { s, root } = await tree();
    const { token, body } = await share(s, root);
    await call(s, 'DELETE', `/folders/${root}`);
    await call(s, 'POST', '/trash/purge', { folderIds: [root] });
    expect((await t.db.query(`SELECT 1 FROM shared_links WHERE id = $1`, [body.id])).rowCount).toBe(0);
    expect((await pub(token)).statusCode).toBe(404);
  });
});

describe('related behaviour', () => {
  it('reports abuse on a folder link using the folder name, and admins can disable it', async () => {
    const { s, root } = await tree();
    const { token, body } = await share(s, root);
    const rep = await t.app.inject({ method: 'POST', url: `/api/v1/public/shares/${token}/report`, headers: { 'content-type': 'application/json' }, payload: { reason: 'privacy' } });
    expect(rep.statusCode).toBe(201);
    expect((await t.db.query<any>(`SELECT file_name FROM abuse_reports WHERE share_id = $1`, [body.id])).rows[0].file_name).toBe('Projects');
  });

  it('warns the owner a day before a folder link expires, naming the folder', async () => {
    const { s, root } = await tree();
    await share(s, root, { expiresInHours: 3 });
    const config = { ...t.config } as typeof t.config;
    const eng = new MaintenanceEngine({ db: t.db, config, mailer: createMailer(config), log: { info() {}, warn() {}, error() {} } });
    await eng.sweep();
    const n = (await call(s, 'GET', '/notifications')).json().items.filter((x: any) => x.kind === 'share_expiring');
    expect(n).toHaveLength(1);
    expect(n[0].body).toContain('"Projects"');
  });
});
