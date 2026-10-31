import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { path7za } from '7zip-bin';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, createTestEnv, login, multipartBody, type Session, type TestEnv } from './helpers.js';

let t: TestEnv, noTool: TestEnv;
let ann: Session, ben: Session, zed: Session;
beforeAll(async () => {
  t = await createTestEnv({ SEVENZIP_PATH: path7za });
  noTool = await createTestEnv({ SEVENZIP_PATH: path.join(os.tmpdir(), 'definitely-not-installed-7z') });
  ann = await login(t, 'a-ann', 'ann@example.com');
  ben = await login(t, 'a-ben', 'ben@example.com');
  zed = await login(noTool, 'a-zed', 'zed@example.com');
});
afterAll(async () => { await t.close(); await noTool.close(); });

const upload = (env: TestEnv, s: Session, name: string, content: Buffer | string) => {
  const m = multipartBody(name, content);
  return env.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(s), ...m.headers }, payload: m.body });
};
const get = (env: TestEnv, s: Session, url: string) => env.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { cookie: s.cookie } });
const post = (env: TestEnv, s: Session, url: string, payload: Record<string, unknown>) => env.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: authed(s), payload });
const used = async (s: Session) => (await t.db.query<{ used_bytes: number }>('SELECT used_bytes FROM storage_quotas WHERE user_id = $1', [s.userId])).rows[0]!.used_bytes;
const countFolders = async (s: Session) => (await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM folders WHERE user_id = $1', [s.userId])).rows[0]!.n;
const names = (xs: { name: string }[]) => xs.map((x) => x.name).sort();

const sampleZip = () => Buffer.from(zipSync({
  'readme.txt': strToU8('hello from the zip'),
  'docs/guide.md': [strToU8('# Guide\n'.repeat(200)), { level: 6 }],
  'docs/deep/note.txt': [strToU8('stored, not compressed'), { level: 0 }],
  'zażółć.txt': strToU8('unicode name'),
  '../evil.txt': strToU8('escape attempt'),
  '/abs.txt': strToU8('absolute path'),
}));

describe('ZIP', () => {
  it('lists the contents without unpacking, hides unsafe names, and downloads single entries', async () => {
    const f = (await upload(t, ann, 'sample.zip', sampleZip())).json();
    const r = await get(t, ann, `/files/${f.id}/archive`);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.kind).toBe('zip');
    expect(body.entries.map((e: { path: string }) => e.path).sort()).toEqual(['docs/deep/note.txt', 'docs/guide.md', 'readme.txt', 'zażółć.txt']);
    expect(body.hidden).toBe(2);

    const one = await get(t, ann, `/files/${f.id}/archive/entry?path=${encodeURIComponent('docs/guide.md')}`);
    expect(one.statusCode).toBe(200);
    expect(one.body).toBe('# Guide\n'.repeat(200));
    expect(one.headers['content-disposition']).toContain('attachment');
    expect(one.headers['x-content-type-options']).toBe('nosniff');
    expect((await get(t, ann, `/files/${f.id}/archive/entry?path=${encodeURIComponent('docs/deep/note.txt')}`)).body).toBe('stored, not compressed');
    expect((await get(t, ann, `/files/${f.id}/archive/entry?path=${encodeURIComponent('zażółć.txt')}`)).body).toBe('unicode name');
    expect((await get(t, ann, `/files/${f.id}/archive/entry?path=nope.txt`)).statusCode).toBe(404);
    expect((await get(t, ann, `/files/${f.id}/archive/entry?path=docs`)).statusCode).toBe(404);
  });

  it('is private to its owner and refuses files that are not archives', async () => {
    const f = (await upload(t, ann, 'private.zip', sampleZip())).json();
    expect((await get(t, ben, `/files/${f.id}/archive`)).statusCode).toBe(404);
    expect((await post(t, ben, `/files/${f.id}/archive/extract`, {})).statusCode).toBe(404);
    const txt = (await upload(t, ann, 'plain.txt', 'hi')).json();
    expect((await get(t, ann, `/files/${txt.id}/archive`)).statusCode).toBe(415);
    const broken = (await upload(t, ann, 'broken.zip', Buffer.from('this is not a zip file at all, just text'))).json();
    expect((await get(t, ann, `/files/${broken.id}/archive`)).statusCode).toBe(422);
  });

  it('extracts everything into a new folder, skipping unsafe paths, and charges the quota', async () => {
    const f = (await upload(t, ann, 'bundle.zip', sampleZip())).json();
    const before = await used(ann);
    const r = await post(t, ann, `/files/${f.id}/archive/extract`, {});
    expect(r.statusCode).toBe(200);
    const out = r.json();
    expect(out.files).toBe(4);
    expect(out.folderName).toBe('bundle');
    expect(out.skippedCount).toBe(2);
    expect(await used(ann)).toBe(before + 18 + 1600 + 22 + Buffer.byteLength('unicode name'));
    const top = (await get(t, ann, `/files?folder=${out.folderId}`)).json();
    expect(names(top.files)).toEqual(['readme.txt', 'zażółć.txt']);
    expect(names(top.folders)).toEqual(['docs']);
    const docs = (await get(t, ann, `/files?folder=${top.folders[0].id}`)).json();
    expect(names(docs.files)).toEqual(['guide.md']);
    expect(names(docs.folders)).toEqual(['deep']);
    expect((await get(t, ann, `/files/${docs.files[0].id}/content`)).body).toBe('# Guide\n'.repeat(200));
    // extracting again does not collide: the folder gets a number
    expect((await post(t, ann, `/files/${f.id}/archive/extract`, {})).json().folderName).toBe('bundle (1)');
  });

  it('extracts only the chosen entries', async () => {
    const f = (await upload(t, ann, 'pick.zip', sampleZip())).json();
    const r = await post(t, ann, `/files/${f.id}/archive/extract`, { paths: ['docs'] });
    expect(r.json().files).toBe(2);
    const top = (await get(t, ann, `/files?folder=${r.json().folderId}`)).json();
    expect(top.files).toHaveLength(0);
    expect(names(top.folders)).toEqual(['docs']);
    expect((await post(t, ann, `/files/${f.id}/archive/extract`, { paths: ['missing'] })).statusCode).toBe(400);
  });

  it('refuses a zip bomb up front (declared size over the free space) and leaves nothing behind', async () => {
    const bomb = Buffer.from(zipSync({ 'zeros.bin': [new Uint8Array(3 * 1024 * 1024), { level: 9 }] }));
    expect(bomb.length).toBeLessThan(20_000);
    const f = (await upload(t, ben, 'bomb.zip', bomb)).json();
    const before = await used(ben); const folders = await countFolders(ben);
    const r = await post(t, ben, `/files/${f.id}/archive/extract`, {});
    expect(r.statusCode).toBe(413);
    expect(r.json().error.code).toBe('quota_exceeded');
    expect(await used(ben)).toBe(before);
    expect(await countFolders(ben)).toBe(folders);
  });

  it('stops an entry that is bigger than the archive says, and undoes the extraction', async () => {
    const real = Buffer.from(zipSync({ 'ok.txt': strToU8('fine'), 'liar.bin': [new Uint8Array(200_000), { level: 9 }] }));
    // lower the declared size of the last central-directory entry (liar.bin)
    const at = real.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(at).toBeGreaterThan(0);
    real.writeUInt32LE(1000, at + 24);
    const f = (await upload(t, ben, 'liar.zip', real)).json();
    const before = await used(ben); const folders = await countFolders(ben);
    const r = await post(t, ben, `/files/${f.id}/archive/extract`, {});
    expect(r.statusCode).toBe(413);
    expect(r.json().error.code).toBe('archive_too_large');
    expect(await used(ben)).toBe(before);
    expect(await countFolders(ben)).toBe(folders);
  });
});

describe('7Z and RAR (through 7-Zip)', () => {
  function make7z(): Buffer {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cs-7z-'));
    const src = path.join(dir, 'src');
    mkdirSync(path.join(src, 'sub'), { recursive: true });
    writeFileSync(path.join(src, 'one.txt'), 'first file');
    writeFileSync(path.join(src, 'sub', 'two.txt'), 'second file, inside a folder');
    writeFileSync(path.join(src, '-dash.txt'), 'a name that looks like a switch');
    execFileSync(path7za, ['a', '-bd', '-y', path.join(dir, 'x.7z'), '.'], { cwd: src, stdio: 'ignore' });
    return readFileSync(path.join(dir, 'x.7z'));
  }

  it('lists, downloads one entry, and extracts a 7z archive', async () => {
    const f = (await upload(t, ann, 'pack.7z', make7z())).json();
    const r = await get(t, ann, `/files/${f.id}/archive`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().kind).toBe('7z');
    expect(r.json().entries.filter((e: { isDir: boolean }) => !e.isDir).map((e: { path: string }) => e.path).sort()).toEqual(['-dash.txt', 'one.txt', 'sub/two.txt']);
    expect((await get(t, ann, `/files/${f.id}/archive/entry?path=${encodeURIComponent('sub/two.txt')}`)).body).toBe('second file, inside a folder');
    expect((await get(t, ann, `/files/${f.id}/archive/entry?path=${encodeURIComponent('-dash.txt')}`)).body).toBe('a name that looks like a switch');
    expect((await get(t, ann, `/files/${f.id}/archive/entry?path=${encodeURIComponent('*.txt')}`)).statusCode).toBe(404); // no wildcards
    const x = await post(t, ann, `/files/${f.id}/archive/extract`, {});
    expect(x.statusCode, x.body).toBe(200);
    expect(x.json().files).toBe(3);
  });

  it('says so plainly when 7-Zip is missing or the file is not a valid archive', async () => {
    const g = (await upload(noTool, zed, 'b.rar', Buffer.from('Rar!\u001a\u0007\u0000 not really'))).json();
    const r = await get(noTool, zed, `/files/${g.id}/archive`);
    expect(r.statusCode).toBe(501);
    expect(r.json().error.code).toBe('archive_no_tool');
    const bad = (await upload(t, ann, 'junk.rar', Buffer.from('definitely not a rar file'))).json();
    expect((await get(t, ann, `/files/${bad.id}/archive`)).statusCode).toBe(422);
  });
});
