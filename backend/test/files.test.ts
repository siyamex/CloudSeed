import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authed, createTestEnv, login, multipartBody, type Session, type TestEnv } from './helpers.js';

let t: TestEnv;
let alice: Session, bob: Session;
beforeAll(async () => {
  t = await createTestEnv();
  alice = await login(t, 'f-alice', 'alice@example.com');
  bob = await login(t, 'f-bob', 'bob@example.com');
});
afterAll(async () => { await t.close(); });

const upload = (s: Session, name: string, content: Buffer | string, qs = '') => {
  const m = multipartBody(name, content);
  return t.app.inject({ method: 'POST', url: `/api/v1/files/upload${qs}`, headers: { ...authed(s), ...m.headers }, payload: m.body });
};
const mkdir = async (s: Session, name: string, parentId: string | null = null) =>
  (await t.app.inject({ method: 'POST', url: '/api/v1/folders', headers: authed(s), payload: { name, parentId } })).json();
const list = (s: Session, qs = '') => t.app.inject({ method: 'GET', url: `/api/v1/files${qs}`, headers: { cookie: s.cookie } });
const used = async (s: Session) => (await t.db.query<{ used_bytes: number }>('SELECT used_bytes FROM storage_quotas WHERE user_id = $1', [s.userId])).rows[0]!.used_bytes;

describe('upload and download', () => {
  it('stores a file, records metadata and usage, and serves identical bytes back', async () => {
    const before = await used(alice);
    const r = await upload(alice, 'hello.txt', 'hello world');
    expect(r.statusCode).toBe(201);
    const f = r.json();
    expect(f).toMatchObject({ name: 'hello.txt', size: 11, mimeType: 'text/plain' });
    expect(await used(alice)).toBe(before + 11);

    const dl = await t.app.inject({ method: 'GET', url: `/api/v1/files/${f.id}/content`, headers: { cookie: alice.cookie } });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('hello world');
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['accept-ranges']).toBe('bytes');
  });

  it('supports byte ranges and rejects unsatisfiable ones', async () => {
    const f = (await upload(alice, 'range.bin', '0123456789')).json();
    const get = (range: string) => t.app.inject({ method: 'GET', url: `/api/v1/files/${f.id}/content`, headers: { cookie: alice.cookie, range } });
    const a = await get('bytes=2-5');
    expect(a.statusCode).toBe(206);
    expect(a.body).toBe('2345');
    expect(a.headers['content-range']).toBe('bytes 2-5/10');
    expect((await get('bytes=-3')).body).toBe('789');
    expect((await get('bytes=8-')).body).toBe('89');
    expect((await get('bytes=50-60')).statusCode).toBe(416);
  });

  it('sanitises path components in uploaded filenames', async () => {
    const r = await upload(alice, '../../etc/passwd', 'x');
    expect(r.statusCode).toBe(201);
    expect(r.json().name).toBe('passwd');
  });

  it('rejects duplicate names by default and offers rename / replace', async () => {
    await upload(alice, 'dup.txt', 'one');
    const again = await upload(alice, 'dup.txt', 'two');
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('name_conflict');

    const renamed = await upload(alice, 'dup.txt', 'three', '?onConflict=rename');
    expect(renamed.json().name).toBe('dup (1).txt');

    const before = await used(alice);
    const replaced = await upload(alice, 'dup.txt', 'twelve chars', '?onConflict=replace');
    expect(replaced.statusCode).toBe(201);
    expect(await used(alice)).toBe(before - 3 + 12);
    const dl = await t.app.inject({ method: 'GET', url: `/api/v1/files/${replaced.json().id}/content`, headers: { cookie: alice.cookie } });
    expect(dl.body).toBe('twelve chars');
  });

  it('enforces the max file size and leaves no object or row behind', async () => {
    const rowsBefore = (await t.db.query('SELECT 1 FROM files')).rowCount;
    const r = await upload(alice, 'big.bin', Buffer.alloc(600 * 1024));
    expect(r.statusCode).toBe(413);
    expect(r.json().error.code).toBe('file_too_large');
    expect((await t.db.query('SELECT 1 FROM files')).rowCount).toBe(rowsBefore);
  });

  it('enforces the per-user quota', async () => {
    const c = await login(t, 'f-carol', 'carol@example.com'); // 1 MiB quota
    expect((await upload(c, 'a.bin', Buffer.alloc(500 * 1024))).statusCode).toBe(201);
    expect((await upload(c, 'b.bin', Buffer.alloc(500 * 1024))).statusCode).toBe(201);
    const over = await upload(c, 'c.bin', Buffer.alloc(100 * 1024));
    expect(over.statusCode, over.body).toBe(413);
    expect(over.json().error.code).toBe('quota_exceeded');
    expect(await used(c)).toBe(1000 * 1024);
  });

  it('requires authentication and CSRF', async () => {
    const m = multipartBody('x.txt', 'x');
    const anon = await t.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: m.headers, payload: m.body });
    expect(anon.statusCode).toBe(401);
    const noCsrf = await t.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { cookie: alice.cookie, ...m.headers }, payload: m.body });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe('folders', () => {
  it('lists folder contents with breadcrumbs', async () => {
    const a = await mkdir(alice, 'docs');
    const b = await mkdir(alice, 'reports', a.id);
    await upload(alice, 'q1.txt', 'q1', `?folder=${b.id}`);
    const r = (await list(alice, `?folder=${b.id}`)).json();
    expect(r.breadcrumbs.map((x: { name: string }) => x.name)).toEqual(['docs', 'reports']);
    expect(r.files.map((x: { name: string }) => x.name)).toEqual(['q1.txt']);
    const root = (await list(alice)).json();
    expect(root.folders.map((x: { name: string }) => x.name)).toContain('docs');
  });

  it('rejects duplicate folder names case-insensitively', async () => {
    await mkdir(alice, 'Photos');
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/folders', headers: authed(alice), payload: { name: 'photos' } });
    expect(r.statusCode).toBe(409);
  });

  it.each(['a/b', '..', '', '  ', 'x\u0000y'])('rejects invalid folder name %j', async (name) => {
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/folders', headers: authed(alice), payload: { name } });
    expect(r.statusCode).toBe(400);
  });

  it('prevents moving a folder into its own descendant', async () => {
    const a = await mkdir(alice, 'cycle-a');
    const b = await mkdir(alice, 'cycle-b', a.id);
    const r = await t.app.inject({ method: 'PATCH', url: `/api/v1/folders/${a.id}`, headers: authed(alice), payload: { parentId: b.id } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('invalid_move');
    const self = await t.app.inject({ method: 'PATCH', url: `/api/v1/folders/${a.id}`, headers: authed(alice), payload: { parentId: a.id } });
    expect(self.statusCode).toBe(400);
  });

  it('trashes recursively; quota and objects are kept until the trash is purged', async () => {
    const dave = await login(t, 'f-dave', 'dave@example.com');
    const top = await mkdir(dave, 'top');
    const sub = await mkdir(dave, 'sub', top.id);
    await upload(dave, 'a.txt', 'aaaa', `?folder=${top.id}`);
    const deep = (await upload(dave, 'b.txt', 'bbbbbb', `?folder=${sub.id}`)).json();
    const key = (await t.db.query<{ storage_key: string }>('SELECT storage_key FROM files WHERE id = $1', [deep.id])).rows[0]!.storage_key;
    expect(await used(dave)).toBe(10);

    const del = await t.app.inject({ method: 'DELETE', url: `/api/v1/folders/${top.id}`, headers: authed(dave) });
    expect(del.statusCode).toBe(204);
    expect((await list(dave)).json().folders).toHaveLength(0);
    expect(await used(dave)).toBe(10); // still accounted while in trash
    expect(await t.storage.stat(key)).not.toBeNull();

    const purge = await t.app.inject({ method: 'POST', url: '/api/v1/trash/empty', headers: authed(dave) });
    expect(purge.statusCode).toBe(200);
    expect(await used(dave)).toBe(0);
    expect(await t.storage.stat(key)).toBeNull();
    expect((await t.db.query('SELECT 1 FROM folders WHERE user_id = $1', [dave.userId])).rowCount).toBe(0);
  });

  it('renames and moves files', async () => {
    const dst = await mkdir(alice, 'move-dst');
    const f = (await upload(alice, 'moveme.txt', 'm')).json();
    const r = await t.app.inject({ method: 'PATCH', url: `/api/v1/files/${f.id}`, headers: authed(alice), payload: { name: 'moved.md', folderId: dst.id } });
    expect(r.statusCode).toBe(200);
    const inDst = (await list(alice, `?folder=${dst.id}`)).json();
    expect(inDst.files[0]).toMatchObject({ name: 'moved.md', mimeType: 'text/markdown' });
  });
});

describe('listing, search, sort, pagination', () => {
  it('paginates with stable cursors across all sort orders', async () => {
    const e = await login(t, 'f-erin', 'erin@example.com');
    const names = ['b', 'a', 'd', 'c', 'e'];
    for (const [i, n] of names.entries()) await upload(e, `${n}.txt`, 'x'.repeat(i + 1));

    for (const sort of ['name', 'size', 'date', 'type']) {
      for (const dir of ['asc', 'desc']) {
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const r: any = (await list(e, `?sort=${sort}&dir=${dir}&limit=2${cursor ? `&cursor=${cursor}` : ''}`)).json();
          expect(r.files.length).toBeLessThanOrEqual(2);
          seen.push(...r.files.map((f: { name: string }) => f.name));
          cursor = r.nextCursor;
        } while (cursor);
        expect(seen.length, `${sort}/${dir}`).toBe(5);
        expect(new Set(seen).size).toBe(5);
        if (sort === 'name') expect(seen).toEqual(dir === 'asc' ? ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'] : ['e.txt', 'd.txt', 'c.txt', 'b.txt', 'a.txt']);
      }
    }
  });

  it('searches by filename across folders, escaping LIKE wildcards, and filters by type', async () => {
    const f = await login(t, 'f-fay', 'fay@example.com');
    const d = await mkdir(f, 'inner');
    await upload(f, 'report_final.pdf', 'p', `?folder=${d.id}`);
    await upload(f, 'reportXfinal.pdf', 'p');
    await upload(f, 'photo.png', 'i');
    const s = (await list(f, '?q=report_final')).json();
    expect(s.files.map((x: { name: string }) => x.name)).toEqual(['report_final.pdf']); // "_" is literal, not a wildcard
    const imgs = (await list(f, '?type=image')).json();
    expect(imgs.files.map((x: { name: string }) => x.name)).toEqual(['photo.png']);
  });

  it('rejects a tampered cursor', async () => {
    expect((await list(alice, '?cursor=garbage')).statusCode).toBe(400);
  });
});

describe('authorization isolation (IDOR)', () => {
  it("never lets one user read, modify or delete another user's resources", async () => {
    const secret = (await upload(alice, 'secret.txt', 'alice only')).json();
    const folder = await mkdir(alice, 'alice-private');
    const h = authed(bob);

    expect((await t.app.inject({ method: 'GET', url: `/api/v1/files/${secret.id}/content`, headers: { cookie: bob.cookie } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'PATCH', url: `/api/v1/files/${secret.id}`, headers: h, payload: { name: 'pwned' } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/files/${secret.id}`, headers: h })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'PATCH', url: `/api/v1/folders/${folder.id}`, headers: h, payload: { name: 'pwned' } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/v1/folders/${folder.id}`, headers: h })).statusCode).toBe(404);
    expect((await list(bob, `?folder=${folder.id}`)).statusCode).toBe(404);
    // cannot upload into, create under, or move into someone else's folder
    expect((await upload(bob, 'x.txt', 'x', `?folder=${folder.id}`)).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/folders', headers: h, payload: { name: 'x', parentId: folder.id } })).statusCode).toBe(404);
    const own = (await upload(bob, 'own.txt', 'o')).json();
    expect((await t.app.inject({ method: 'PATCH', url: `/api/v1/files/${own.id}`, headers: h, payload: { folderId: folder.id } })).statusCode).toBe(404);

    // bulk delete silently ignores foreign ids
    const bulk = await t.app.inject({ method: 'POST', url: '/api/v1/files/bulk-delete', headers: h, payload: { fileIds: [secret.id], folderIds: [folder.id] } });
    expect(bulk.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/files/${secret.id}/content`, headers: { cookie: alice.cookie } })).body).toBe('alice only');

    // search never leaks
    expect(((await list(bob, '?q=secret')).json()).files).toHaveLength(0);
  });

  it('bulk delete trashes own items', async () => {
    const g = await login(t, 'f-gus', 'gus@example.com');
    const f1 = (await upload(g, '1.txt', '111')).json();
    const f2 = (await upload(g, '2.txt', '22')).json();
    const d = await mkdir(g, 'bd');
    await upload(g, '3.txt', '3', `?folder=${d.id}`);
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/files/bulk-delete', headers: authed(g), payload: { fileIds: [f1.id, f2.id], folderIds: [d.id] } });
    expect(r.json()).toEqual({ trashedFolders: 1, trashedFiles: 2 });
    const root = (await list(g)).json();
    expect(root.files).toHaveLength(0);
    expect(root.folders).toHaveLength(0);
  });
});

describe('copy', () => {
  const copy = (s: Session, payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url: '/api/v1/files/copy', headers: authed(s), payload });

  it('copies files and whole folders as independent objects, renaming clashes and charging the quota', async () => {
    const s = await login(t, 'f-cora', 'cora@example.com');
    const a = (await upload(s, 'a.txt', 'hello')).json();
    const d = await mkdir(s, 'docs');
    const sub = (await t.app.inject({ method: 'POST', url: '/api/v1/folders', headers: authed(s), payload: { name: 'inner', parentId: d.id } })).json();
    await upload(s, 'b.txt', 'bb', `?folder=${d.id}`);
    await upload(s, 'c.txt', 'ccc', `?folder=${sub.id}`);
    const before = await used(s);
    const target = await mkdir(s, 'target');

    const r = await copy(s, { fileIds: [a.id], folderIds: [d.id], targetFolderId: target.id });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ copiedFiles: 3, copiedFolders: 2 });
    expect(await used(s)).toBe(before + 5 + 2 + 3);

    const inTarget = (await list(s, `?folder=${target.id}`)).json();
    expect(inTarget.files.map((f: { name: string }) => f.name)).toEqual(['a.txt']);
    expect(inTarget.folders.map((f: { name: string }) => f.name)).toEqual(['docs']);
    const copiedDocs = (await list(s, `?folder=${inTarget.folders[0].id}`)).json();
    expect(copiedDocs.files.map((f: { name: string }) => f.name)).toEqual(['b.txt']);
    expect(copiedDocs.folders.map((f: { name: string }) => f.name)).toEqual(['inner']);
    // the copy has its own bytes; the original is untouched
    const copyOfA = inTarget.files[0];
    expect(copyOfA.id).not.toBe(a.id);
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/files/${copyOfA.id}/content`, headers: { cookie: s.cookie } })).body).toBe('hello');
    await t.app.inject({ method: 'DELETE', url: `/api/v1/files/${copyOfA.id}`, headers: authed(s) });
    expect((await t.app.inject({ method: 'GET', url: `/api/v1/files/${a.id}/content`, headers: { cookie: s.cookie } })).body).toBe('hello');

    // copying into the same folder numbers the name
    const again = await copy(s, { fileIds: [a.id], targetFolderId: null });
    expect(again.json().copiedFiles).toBe(1);
    const root = (await list(s)).json();
    expect(root.files.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(['a.txt', 'a (1).txt']));
  });

  it('refuses a folder into itself, someone else\'s items, and a copy that would not fit', async () => {
    const s = await login(t, 'f-cade', 'cade@example.com');
    const o = await login(t, 'f-cody', 'cody@example.com');
    const d = await mkdir(s, 'loop');
    const inner = (await t.app.inject({ method: 'POST', url: '/api/v1/folders', headers: authed(s), payload: { name: 'in', parentId: d.id } })).json();
    expect((await copy(s, { folderIds: [d.id], targetFolderId: inner.id })).statusCode).toBe(400);
    const theirs = (await upload(o, 't.txt', 'theirs')).json();
    const r = await copy(s, { fileIds: [theirs.id], targetFolderId: null });
    expect(r.json()).toEqual({ copiedFiles: 0, copiedFolders: 0 });
    expect((await copy(s, { fileIds: [], targetFolderId: (await mkdir(o, 'x')).id })).statusCode).toBe(404);
    // quota: 1 MiB; 800 KiB cannot be copied into 200 KiB of free space
    const big1 = (await upload(s, 'big1.bin', Buffer.alloc(400 * 1024))).json(); const big2 = (await upload(s, 'big2.bin', Buffer.alloc(400 * 1024))).json();
    const before = await used(s);
    const over = await copy(s, { fileIds: [big1.id, big2.id], targetFolderId: d.id });
    expect(over.statusCode, over.body).toBe(413);
    expect(over.json().error.code).toBe('quota_exceeded');
    expect(await used(s)).toBe(before);
  });
});

describe('dashboard', () => {
  it('reports real figures from the database', async () => {
    const h = await login(t, 'f-hal', 'hal@example.com');
    await upload(h, 'a.txt', '12345');
    await upload(h, 'p.png', '123');
    await mkdir(h, 'd');
    const r = (await t.app.inject({ method: 'GET', url: '/api/v1/dashboard', headers: { cookie: h.cookie } })).json();
    expect(r.storage).toMatchObject({ backend: 'local', usedBytes: 8, quotaBytes: 1024 * 1024, healthy: true });
    expect(r.storage.availableBytes).toBe(1024 * 1024 - 8);
    expect(r.counts).toEqual({ files: 2, folders: 1 });
    expect(r.storage).toMatchObject({ trashBytes: 0, trashFiles: 0 });
    expect(r.recentFiles).toHaveLength(2);
    expect(r.usageByType.map((x: { category: string }) => x.category).sort()).toEqual(['image', 'text']);
  });
  it('requires authentication', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/dashboard' })).statusCode).toBe(401);
  });
});
