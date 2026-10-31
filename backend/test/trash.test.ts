import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeExpiredTrash, deleteObjects } from '../src/files/ops.js';
import { authed, createTestEnv, login, multipartBody, type Session, type TestEnv } from './helpers.js';

let t: TestEnv;
let alice: Session, bob: Session;
beforeAll(async () => {
  t = await createTestEnv();
  alice = await login(t, 't-alice', 'alice@example.com');
  bob = await login(t, 't-bob', 'bob@example.com');
});
afterAll(async () => { await t.close(); });

const upload = (s: Session, name: string, content: string, folder = 'root') => {
  const m = multipartBody(name, content);
  return t.app.inject({ method: 'POST', url: `/api/v1/files/upload?folder=${folder}`, headers: { ...authed(s), ...m.headers }, payload: m.body });
};
const mkdir = async (s: Session, name: string, parentId: string | null = null) =>
  (await t.app.inject({ method: 'POST', url: '/api/v1/folders', headers: authed(s), payload: { name, parentId } })).json();
const post = (s: Session, url: string, payload: unknown = {}) => t.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: authed(s), payload: payload as object });
const get = (s: Session, url: string) => t.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { cookie: s.cookie } });
const trashList = async (s: Session) => (await get(s, '/trash')).json();
const used = async (s: Session) => (await t.db.query<{ used_bytes: number }>('SELECT used_bytes FROM storage_quotas WHERE user_id = $1', [s.userId])).rows[0]!.used_bytes;

describe('trash', () => {
  it('hides trashed files from listing, search, download and edits, but still counts them toward quota', async () => {
    const u = await login(t, 't-u1', 'u1@example.com');
    const f = (await upload(u, 'gone.txt', 'twelve bytes')).json();
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/files/${f.id}`, headers: authed(u) })).statusCode).toBe(204);

    expect((await get(u, '/files')).json().files).toHaveLength(0);
    expect((await get(u, '/files?q=gone')).json().files).toHaveLength(0);
    expect((await get(u, `/files/${f.id}/content`)).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'PATCH', url: `/api/v1/files/${f.id}`, headers: authed(u), payload: { name: 'x' } })).statusCode).toBe(404);
    expect(await used(u)).toBe(12);

    const d = (await get(u, '/dashboard')).json();
    expect(d.counts.files).toBe(0);
    expect(d.storage).toMatchObject({ usedBytes: 12, trashBytes: 12, trashFiles: 1 });
    // deleting twice is a 404, not a second trash
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/files/${f.id}`, headers: authed(u) })).statusCode).toBe(404);
  });

  it('restores a file with its content intact', async () => {
    const u = await login(t, 't-u2', 'u2@example.com');
    const f = (await upload(u, 'keep.txt', 'precious')).json();
    await t.app.inject({ method: 'DELETE', url: `/api/v1/files/${f.id}`, headers: authed(u) });
    expect((await trashList(u)).files.map((x: { name: string }) => x.name)).toEqual(['keep.txt']);

    expect((await post(u, '/trash/restore', { fileIds: [f.id] })).json()).toEqual({ restored: 1 });
    expect((await get(u, `/files/${f.id}/content`)).body).toBe('precious');
    expect((await trashList(u)).files).toHaveLength(0);
  });

  it('renames on restore when the original name has been reused', async () => {
    const u = await login(t, 't-u3', 'u3@example.com');
    const old = (await upload(u, 'report.pdf', 'old')).json();
    await t.app.inject({ method: 'DELETE', url: `/api/v1/files/${old.id}`, headers: authed(u) });
    await upload(u, 'report.pdf', 'new'); // allowed: the old one is in the trash
    await post(u, '/trash/restore', { fileIds: [old.id] });
    const names = (await get(u, '/files')).json().files.map((x: { name: string }) => x.name).sort();
    expect(names).toEqual(['report (1).pdf', 'report.pdf']);
  });

  it('trashes and restores a folder tree together, showing only the top-level item in the trash', async () => {
    const u = await login(t, 't-u4', 'u4@example.com');
    const top = await mkdir(u, 'proj');
    const sub = await mkdir(u, 'src', top.id);
    await upload(u, 'a.txt', 'a', top.id);
    await upload(u, 'b.txt', 'b', sub.id);
    await t.app.inject({ method: 'DELETE', url: `/api/v1/folders/${top.id}`, headers: authed(u) });

    const tr = await trashList(u);
    expect(tr.folders.map((x: { name: string }) => x.name)).toEqual(['proj']);
    expect(tr.files).toHaveLength(0);
    expect((await get(u, `/files?folder=${top.id}`)).statusCode).toBe(404);
    expect((await get(u, '/files?q=b.txt')).json().files).toHaveLength(0);

    await post(u, '/trash/restore', { folderIds: [top.id] });
    expect((await get(u, `/files?folder=${sub.id}`)).json().files.map((x: { name: string }) => x.name)).toEqual(['b.txt']);
    expect((await get(u, `/files?folder=${top.id}`)).json().files.map((x: { name: string }) => x.name)).toEqual(['a.txt']);
  });

  it('keeps an individually trashed file in the trash when its folder is restored', async () => {
    const u = await login(t, 't-u5', 'u5@example.com');
    const dir = await mkdir(u, 'box');
    const f1 = (await upload(u, 'one.txt', '1', dir.id)).json();
    await upload(u, 'two.txt', '2', dir.id);
    await t.app.inject({ method: 'DELETE', url: `/api/v1/files/${f1.id}`, headers: authed(u) });
    await t.app.inject({ method: 'DELETE', url: `/api/v1/folders/${dir.id}`, headers: authed(u) });
    await post(u, '/trash/restore', { folderIds: [dir.id] });
    expect((await get(u, `/files?folder=${dir.id}`)).json().files.map((x: { name: string }) => x.name)).toEqual(['two.txt']);
    expect((await trashList(u)).files.map((x: { name: string }) => x.name)).toEqual(['one.txt']);
  });

  it('restores to the root when the original parent is still in the trash', async () => {
    const u = await login(t, 't-u6', 'u6@example.com');
    const dir = await mkdir(u, 'parent');
    const f = (await upload(u, 'child.txt', 'c', dir.id)).json();
    await t.app.inject({ method: 'DELETE', url: `/api/v1/files/${f.id}`, headers: authed(u) });
    await t.app.inject({ method: 'DELETE', url: `/api/v1/folders/${dir.id}`, headers: authed(u) });
    await post(u, '/trash/restore', { fileIds: [f.id] });
    expect((await get(u, '/files')).json().files.map((x: { name: string }) => x.name)).toEqual(['child.txt']);
  });

  it('purge deletes only trashed items, removes objects and releases quota', async () => {
    const u = await login(t, 't-u7', 'u7@example.com');
    const live = (await upload(u, 'live.txt', 'live')).json();
    const dead = (await upload(u, 'dead.txt', 'deadbeef')).json();
    const deadKey = (await t.db.query<{ storage_key: string }>('SELECT storage_key FROM files WHERE id = $1', [dead.id])).rows[0]!.storage_key;
    await t.app.inject({ method: 'DELETE', url: `/api/v1/files/${dead.id}`, headers: authed(u) });

    const r = await post(u, '/trash/purge', { fileIds: [live.id, dead.id] });
    expect(r.json().purgedFiles).toBe(1); // the live file is untouched
    expect(await used(u)).toBe(4);
    expect(await t.storage.stat(deadKey)).toBeNull();
    expect((await get(u, `/files/${live.id}/content`)).body).toBe('live');
  });

  it("never touches another user's trash", async () => {
    const f = (await upload(alice, 'private.txt', 'mine')).json();
    await t.app.inject({ method: 'DELETE', url: `/api/v1/files/${f.id}`, headers: authed(alice) });
    expect((await trashList(bob)).files).toHaveLength(0);
    expect((await post(bob, '/trash/restore', { fileIds: [f.id] })).json()).toEqual({ restored: 0 });
    expect((await post(bob, '/trash/purge', { fileIds: [f.id] })).json().purgedFiles).toBe(0);
    await post(bob, '/trash/empty');
    expect((await trashList(alice)).files.map((x: { name: string }) => x.name)).toEqual(['private.txt']);
    expect((await get(bob, '/trash')).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/trash' })).statusCode).toBe(401);
  });

  it('retention purges only expired items, across users', async () => {
    const u = await login(t, 't-u8', 'u8@example.com');
    const oldF = (await upload(u, 'old.txt', 'oldold')).json();
    const newF = (await upload(u, 'new.txt', 'new')).json();
    const dir = await mkdir(u, 'oldfolder');
    await upload(u, 'inside.txt', 'in', dir.id);
    for (const id of [oldF.id, newF.id]) await t.app.inject({ method: 'DELETE', url: `/api/v1/files/${id}`, headers: authed(u) });
    await t.app.inject({ method: 'DELETE', url: `/api/v1/folders/${dir.id}`, headers: authed(u) });

    // age the old file and the folder tree beyond the 30-day retention
    await t.db.query(`UPDATE files SET deleted_at = now() - interval '31 days' WHERE id = $1 OR folder_id = $2`, [oldF.id, dir.id]);
    await t.db.query(`UPDATE folders SET deleted_at = now() - interval '31 days' WHERE id = $1`, [dir.id]);

    const refs = await purgeExpiredTrash(t.db, 30);
    expect(refs).toHaveLength(2);
    await deleteObjects(refs, () => t.storage, () => {});
    const tr = await trashList(u);
    expect(tr.files.map((x: { name: string }) => x.name)).toEqual(['new.txt']);
    expect(tr.folders).toHaveLength(0);
    expect(await used(u)).toBe(3);
    expect(await purgeExpiredTrash(t.db, 30)).toEqual([]); // idempotent
    expect(await purgeExpiredTrash(t.db, 0)).toEqual([]); // 0 disables
  });

  it('allows reusing the name of a trashed folder', async () => {
    const u = await login(t, 't-u9', 'u9@example.com');
    const a = await mkdir(u, 'dup');
    await t.app.inject({ method: 'DELETE', url: `/api/v1/folders/${a.id}`, headers: authed(u) });
    const b = await t.app.inject({ method: 'POST', url: '/api/v1/folders', headers: authed(u), payload: { name: 'dup' } });
    expect(b.statusCode).toBe(201);
    await post(u, '/trash/restore', { folderIds: [a.id] });
    expect((await get(u, '/files')).json().folders.map((x: { name: string }) => x.name).sort()).toEqual(['dup', 'dup (1)']);
  });
});
