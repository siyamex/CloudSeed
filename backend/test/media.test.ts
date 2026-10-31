import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import S3rver from 's3rver';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { MediaEngine } from '../src/media/engine.js';
import { S3Storage } from '../src/storage/s3.js';
import type { StorageAdapter } from '../src/storage/types.js';
import { authed, createTestEnv, login, multipartBody, type Session, type TestEnv } from './helpers.js';
import { ffmpegPath, ffprobePath, fixtures, type Fixtures } from './media-fixtures.js';

const silent = { info() {}, warn() {}, error() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, ms = 30000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(40); }
  throw new Error(`timed out waiting for ${what}`);
}

let t: TestEnv;
let fx: Fixtures;
let engines: MediaEngine[] = [];
let userSeq = 0;

beforeAll(async () => {
  fx = await fixtures();
  t = await createTestEnv({
    FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: ffprobePath, MEDIA_TRANSCODING_ENABLED: 'true', MEDIA_THUMBNAIL_WIDTH: '160',
    MEDIA_PROBE_TIMEOUT_MS: '30000', MEDIA_THUMBNAIL_TIMEOUT_MS: '30000', MEDIA_MAX_ATTEMPTS: '2',
  });
}, 120_000);
afterEach(async () => { for (const e of engines.splice(0)) await e.stop(); });
afterAll(async () => { await t.close(); });

function mkEngine(over: Partial<Config> = {}, adapter: StorageAdapter = t.storage) {
  const e = new MediaEngine({ db: t.db, config: { ...t.config, ...over } as Config, storage: adapter, adapterFor: () => adapter, log: silent });
  engines.push(e);
  return e;
}
const user = (name = `m${++userSeq}`): Promise<Session> => login(t, `media-${name}`, `media-${name}@example.com`);
const call = (s: Session | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: { ...(s ? authed(s) : {}), ...headers }, payload: payload as object });
const get = (s: Session | null, url: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { ...(s ? { cookie: s.cookie } : {}), ...headers } });

async function put(s: Session, name: string, content: Buffer | string, folder = 'root'): Promise<string> {
  const m = multipartBody(name, content);
  const r = await t.app.inject({ method: 'POST', url: `/api/v1/files/upload?folder=${folder}`, headers: { ...authed(s), ...m.headers }, payload: m.body });
  if (r.statusCode !== 201) throw new Error(`upload ${name} failed: ${r.body}`);
  return r.json().id;
}
const settled = (s: Session, id: string, ms = 40000) => waitFor(async () => {
  const d = (await get(s, `/media/${id}`)).json();
  return ['ready', 'unsupported', 'failed'].includes(d.status) ? d : false;
}, ms, `media ${id.slice(0, 8)} to settle`);
const used = async (s: Session) => Number((await t.db.query<{ used_bytes: number }>('SELECT used_bytes FROM storage_quotas WHERE user_id = $1', [s.userId])).rows[0]!.used_bytes);
const assetRows = async (fileId: string) => (await t.db.query<any>('SELECT * FROM media_assets WHERE file_id = $1 ORDER BY kind, variant', [fileId])).rows;

/** Uploads a fixture, runs the engine until it is indexed, and returns its detail. */
async function indexed(s: Session, name: keyof Fixtures['files'] | string, content?: Buffer) {
  const id = await put(s, name, content ?? fx.files[name]!);
  const e = mkEngine(); e.start();
  const d = await settled(s, id);
  return { id, d, e };
}

describe('indexing: metadata, thumbnails and tracks', () => {
  it('probes a video, creates a thumbnail, and charges the derived file to the quota', async () => {
    const s = await user();
    const { id, d } = await indexed(s, 'clip.mp4');
    expect(d).toMatchObject({ status: 'ready', kind: 'video', width: 320, height: 240, videoCodec: 'h264', audioCodec: 'aac', hasThumbnail: true });
    expect(d.durationMs).toBeGreaterThan(2800);
    expect(d.durationMs).toBeLessThan(3300);
    expect(d.playback).toEqual({ mode: 'direct', reason: null });

    const th = await get(s, `/media/${id}/thumbnail`);
    expect(th.statusCode).toBe(200);
    expect(th.headers['content-type']).toBe('image/jpeg');
    expect([th.rawPayload[0], th.rawPayload[1]]).toEqual([0xff, 0xd8]); // a real JPEG
    expect(th.headers['x-content-type-options']).toBe('nosniff');

    const assets = await assetRows(id);
    expect(assets).toHaveLength(1);
    expect(await used(s)).toBe(fx.files['clip.mp4']!.length + Number(assets[0].size_bytes)); // thumbnail counts toward the quota
  });

  it('reads audio tags and has no thumbnail unless the file carries cover art', async () => {
    const s = await user();
    const { id, d } = await indexed(s, 'tone.mp3');
    expect(d).toMatchObject({ status: 'ready', kind: 'audio', title: 'Test Tone', artist: 'Sine Band', album: 'Hertz', audioCodec: 'mp3', hasThumbnail: false });
    expect(d.playback.mode).toBe('direct');
    expect((await get(s, `/media/${id}/thumbnail`)).statusCode).toBe(404);

    const cov = await put(s, 'covered.mp3', fx.files['covered.mp3']!);
    const dc = await settled(s, cov);
    expect(dc).toMatchObject({ status: 'ready', kind: 'audio', hasThumbnail: true });
    expect((await get(s, `/media/${cov}/thumbnail`)).headers['content-type']).toBe('image/jpeg');
  });

  it('lists audio tracks and extracts embedded text subtitles as WebVTT', async () => {
    const s = await user();
    const { id, d } = await indexed(s, 'multi.mkv');
    expect(d.status).toBe('ready');
    expect(d.audioTracks.map((x: any) => x.language)).toEqual(['eng', 'fra']);
    const subs = d.subtitles.filter((x: any) => x.source === 'embedded');
    expect(subs.map((x: any) => [x.language, x.available])).toEqual([['eng', true], ['fra', true]]);
    const en = await get(s, `/media/${id}/subtitles/${subs[0].id}.vtt`);
    expect(en.statusCode).toBe(200);
    expect(en.headers['content-type']).toBe('text/vtt; charset=utf-8');
    expect(en.body.startsWith('WEBVTT')).toBe(true);
    expect(en.body).toContain('Hello <i>world</i>');
    expect((await get(s, `/media/${id}/subtitles/${subs[1].id}`)).body).toContain('Bonjour');
    expect(d.playback.mode).toBe('maybe');
  });

  it('says plainly when a browser cannot play a format', async () => {
    const s = await user();
    const { d } = await indexed(s, 'old.avi');
    expect(d).toMatchObject({ status: 'ready', videoCodec: 'mpeg4', hasThumbnail: true });
    expect(d.playback).toMatchObject({ mode: 'transcode', reason: expect.stringMatching(/AVI/) });
    expect(d.transcoding.enabled).toBe(true);
    expect(d.transcoding.profiles.map((p: any) => p.name)).toEqual(['web-720p', 'web-480p']);
  });

  it('marks unreadable files unsupported without retry loops, and a hostile playlist disguised as .mp4 reads nothing', async () => {
    const s = await user();
    const bad = await put(s, 'garbage.mp4', fx.files['garbage.mp4']!);
    const evil = await put(s, 'evil.mp4', fx.files['evil.mp4']!);
    const e = mkEngine(); e.start();
    const [b, v] = [await settled(s, bad), await settled(s, evil)];
    for (const d of [b, v]) {
      expect(d).toMatchObject({ status: 'unsupported', hasThumbnail: false });
      expect(d.error).toMatch(/could not be read as media/);
      expect(d.durationMs).toBeNull();
    }
    // nothing derived from the file the playlist pointed at
    expect(await assetRows(evil)).toEqual([]);
    expect(JSON.stringify(v)).not.toContain('TOP-SECRET');
    const calls = (await t.db.query<{ attempt: number }>('SELECT attempt FROM media_metadata WHERE file_id = $1', [evil])).rows[0]!;
    expect(calls.attempt).toBe(0); // permanent: not retried
    // a manual retry is allowed and ends the same way
    expect((await call(s, 'POST', `/media/${evil}/reprobe`)).statusCode).toBe(200);
    expect((await settled(s, evil)).status).toBe('unsupported');
    expect((await call(s, 'POST', `/media/${id0(s)}/reprobe`)).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('retries with backoff when FFmpeg is missing, then fails with a clear message', async () => {
    const s = await user();
    const id = await put(s, 'nofx.mp4', fx.files['clip.mp4']!);
    const e = mkEngine({ FFPROBE_PATH: 'definitely-not-installed-ffprobe', MEDIA_MAX_ATTEMPTS: 1 }); e.start();
    const d = await settled(s, id);
    expect(d).toMatchObject({ status: 'failed', error: 'FFmpeg is not available on the server' });
    expect(JSON.stringify(d)).not.toMatch(/definitely-not/); // no internals in the message
  });

  it('indexes media that has no index row yet (older uploads, renames) via discovery', async () => {
    const s = await user();
    const id = await put(s, 'later.mp4', fx.files['clip.mp4']!);
    await t.db.query('DELETE FROM media_metadata WHERE file_id = $1', [id]); // as if uploaded before the feature existed
    const txt = await put(s, 'notes.txt', 'plain');
    await call(s, 'PATCH', `/files/${txt}`, { name: 'renamed.mp3' }); // not media content, but now a media name
    const e = mkEngine();
    expect(await e.discover()).toBeGreaterThanOrEqual(2);
    e.start();
    expect((await settled(s, id)).status).toBe('ready');
    expect((await settled(s, txt)).status).toBe('unsupported'); // text renamed to .mp3 is rejected by FFmpeg
  });

  it('recovers work left by a dead worker, bounded by the attempt limit', async () => {
    const s = await user();
    const id = await put(s, 'stale.mp4', fx.files['clip.mp4']!);
    await t.db.query(`UPDATE media_metadata SET status = 'processing', worker_id = 'dead', lease_expires_at = now() - interval '1 minute' WHERE file_id = $1`, [id]);
    const e = mkEngine();
    expect(await e.recover()).toBe(1);
    expect((await t.db.query<any>('SELECT status, attempt FROM media_metadata WHERE file_id = $1', [id])).rows[0]).toMatchObject({ status: 'pending', attempt: 1 });
    await t.db.query(`UPDATE media_metadata SET status = 'processing', worker_id = 'dead', lease_expires_at = now() - interval '1 minute' WHERE file_id = $1`, [id]);
    await e.recover();
    expect((await t.db.query<any>('SELECT status, error_message FROM media_metadata WHERE file_id = $1', [id])).rows[0]).toMatchObject({ status: 'failed', error_message: expect.stringMatching(/interrupted repeatedly/) });
  });
});
const id0 = (_s: Session) => '00000000-0000-4000-8000-000000000000';

describe('streaming', () => {
  it('serves exact bytes with Range support, inline and sandboxed', async () => {
    const s = await user();
    const id = await put(s, 'stream.mp4', fx.files['clip.mp4']!); // streamable before indexing finishes
    const data = fx.files['clip.mp4']!;
    const full = await get(s, `/media/${id}/stream`);
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-disposition']).toMatch(/^inline;/);
    expect(full.headers['x-content-type-options']).toBe('nosniff');
    expect(full.headers['content-security-policy']).toContain('sandbox');
    expect(Buffer.from(full.rawPayload).equals(data)).toBe(true);

    const r1 = await get(s, `/media/${id}/stream`, { range: 'bytes=100-299' });
    expect([r1.statusCode, r1.headers['content-range']]).toEqual([206, `bytes 100-299/${data.length}`]);
    expect(Buffer.from(r1.rawPayload).equals(data.subarray(100, 300))).toBe(true);
    expect(Buffer.from((await get(s, `/media/${id}/stream`, { range: 'bytes=-50' })).rawPayload).equals(data.subarray(data.length - 50))).toBe(true);
    expect(Buffer.from((await get(s, `/media/${id}/stream`, { range: `bytes=${data.length - 10}-` })).rawPayload).equals(data.subarray(data.length - 10))).toBe(true);
    expect((await get(s, `/media/${id}/stream`, { range: `bytes=${data.length + 5}-` })).statusCode).toBe(416);
  });

  it('refuses non-media, other users, trashed files and anonymous requests', async () => {
    const a = await user(); const b = await user();
    const id = await put(a, 'private.mp4', fx.files['clip.mp4']!);
    const txt = await put(a, 'readme.txt', 'text');
    expect((await get(null, `/media/${id}/stream`)).statusCode).toBe(401);
    expect((await get(b, `/media/${id}/stream`)).statusCode).toBe(404);
    expect((await get(a, `/media/${txt}/stream`)).statusCode).toBe(404); // no media row: plain files are not streamed inline
    await call(a, 'DELETE', `/files/${id}`);
    expect((await get(a, `/media/${id}/stream`)).statusCode).toBe(404);
  });

  it('the stored extension decides the type: a renamed file cannot be served as something else', async () => {
    const a = await user();
    const id = await put(a, 'tone.mp3', fx.files['tone.mp3']!);
    await call(a, 'PATCH', `/files/${id}`, { name: 'tone.html' }); // no longer a media name
    expect((await get(a, `/media/${id}/stream`)).statusCode).toBe(415);
  });
});

describe('playback progress and the library', () => {
  it('stores resume positions, marks finished items, and filters the library by progress', async () => {
    const s = await user();
    const id = await put(s, 'p.mp4', fx.files['clip.mp4']!);
    const other = await put(s, 'unwatched.mp3', fx.files['tone.mp3']!);
    mkEngine().start();
    await settled(s, id); await settled(s, other);

    expect((await call(s, 'PUT', `/media/${id}/progress`, { positionMs: 1200, durationMs: 3000 })).json()).toEqual({ positionMs: 1200, completed: false });
    expect((await get(s, `/media/${id}`)).json().progress).toMatchObject({ positionMs: 1200, durationMs: 3000, completed: false });
    expect((await get(s, '/media?progress=inprogress')).json().items.map((i: any) => i.id)).toEqual([id]);
    expect((await get(s, '/media?progress=unwatched')).json().items.map((i: any) => i.id)).toEqual([other]);

    expect((await call(s, 'PUT', `/media/${id}/progress`, { positionMs: 2900, durationMs: 3000 })).json().completed).toBe(true); // past 95 %
    expect((await call(s, 'PUT', `/media/${id}/progress`, { positionMs: 7_000_000, durationMs: 7_200_000 })).json().completed).toBe(true); // end credits of a long film
    expect((await call(s, 'PUT', `/media/${id}/progress`, { positionMs: 70_000, durationMs: 100_000 })).json().completed).toBe(false); // short clip: only the percentage counts
    expect((await call(s, 'PUT', `/media/${id}/progress`, { positionMs: 2900, durationMs: 3000 })).json().completed).toBe(true);
    expect((await get(s, '/media?progress=completed')).json().items.map((i: any) => i.id)).toEqual([id]);
    expect((await get(s, '/media?progress=inprogress')).json().items).toEqual([]);

    expect((await call(s, 'DELETE', `/media/${id}/progress`)).statusCode).toBe(204);
    expect((await get(s, `/media/${id}`)).json().progress).toBeNull();
    for (const bad of [{ positionMs: -1 }, { positionMs: 1.5 }, { positionMs: 1e12 }, { positionMs: 'x' }, {}]) {
      expect((await call(s, 'PUT', `/media/${id}/progress`, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('searches, filters by type and date, sorts, and paginates', async () => {
    const s = await user();
    const ids: Record<string, string> = {};
    for (const n of ['clip.mp4', 'tone.mp3', 'covered.mp3', 'old.avi']) ids[n] = await put(s, n, fx.files[n]!);
    mkEngine().start();
    for (const id of Object.values(ids)) await settled(s, id);

    const names = async (qs: string) => (await get(s, `/media?${qs}`)).json().items.map((i: any) => i.name);
    expect((await names('')).sort()).toEqual(['clip.mp4', 'covered.mp3', 'old.avi', 'tone.mp3']);
    expect((await names('type=audio')).sort()).toEqual(['covered.mp3', 'tone.mp3']);
    expect((await names('type=video')).sort()).toEqual(['clip.mp4', 'old.avi']);
    expect((await names('q=sine')).sort()).toEqual(['covered.mp3', 'tone.mp3']); // matches the artist tag
    expect(await names('q=hertz&type=video')).toEqual([]);
    expect(await names('q=%25')).toEqual([]); // wildcard characters are literal
    const titles = (await get(s, '/media?sort=title&dir=asc')).json().items.map((i: any) => String(i.title).toLowerCase());
    expect(titles).toEqual(['clip.mp4', 'old.avi', 'test tone', 'test tone']); // by title (the two tagged files tie, so only titles are compared)
    expect((await get(s, '/media?sort=title&dir=desc')).json().items.map((i: any) => String(i.title).toLowerCase())).toEqual([...titles].reverse());
    expect((await names('sort=duration&dir=desc'))[0]).toBe('old.avi'); // 3.1 s, the longest
    expect(await names(`from=${new Date(Date.now() + 3_600_000).toISOString()}`)).toEqual([]);
    expect((await names(`to=${new Date(Date.now() + 3_600_000).toISOString()}`)).length).toBe(4);

    for (const sort of ['date', 'title', 'duration', 'size']) {
      for (const dir of ['asc', 'desc']) {
        const seen: string[] = []; let cursor: string | null = null;
        do {
          const r: any = (await get(s, `/media?sort=${sort}&dir=${dir}&limit=3${cursor ? `&cursor=${cursor}` : ''}`)).json();
          seen.push(...r.items.map((i: any) => i.id)); cursor = r.nextCursor;
        } while (cursor);
        expect(new Set(seen).size, `${sort}/${dir}`).toBe(4);
        expect(seen.length).toBe(4);
      }
    }
    expect((await get(s, '/media?cursor=garbage')).statusCode).toBe(400);
    expect((await get(s, '/media?type=image')).statusCode).toBe(400);
  });

  it("never shows another user's media or trashed files", async () => {
    const a = await user(); const b = await user();
    const id = await put(a, 'mine.mp4', fx.files['clip.mp4']!);
    mkEngine().start();
    await settled(a, id);
    expect((await get(b, '/media')).json().items).toEqual([]);
    expect((await get(b, `/media/${id}`)).statusCode).toBe(404);
    for (const [m, u, body] of [
      ['GET', `/media/${id}/thumbnail`], ['GET', `/media/${id}/subtitles/emb-3`], ['PUT', `/media/${id}/progress`, { positionMs: 1 }], ['DELETE', `/media/${id}/progress`],
      ['POST', `/media/${id}/reprobe`], ['POST', `/media/${id}/renditions`, { profile: 'web-480p' }], ['DELETE', `/media/${id}/renditions/web-480p`],
      ['POST', `/media/${id}/subtitles`, { fileId: id }],
    ] as [string, string, unknown?][]) {
      expect((await call(b, m, u, body)).statusCode, `${m} ${u}`).toBe(404);
    }
    expect((await get(null, '/media')).statusCode).toBe(401);
    await call(a, 'DELETE', `/files/${id}`);
    expect((await get(a, '/media')).json().items).toEqual([]);
  });
});

describe('external subtitles', () => {
  const srt = '1\n00:00:00,500 --> 00:00:01,500\nHello, world\n';

  it('finds subtitles named like the video, converts them to WebVTT, and ignores unrelated files', async () => {
    const s = await user();
    const id = await put(s, 'Movie.mp4', fx.files['clip.mp4']!);
    const plain = await put(s, 'Movie.srt', srt);
    const en = await put(s, 'Movie.en.srt', srt.replace('Hello', 'Howdy'));
    const unrelated = await put(s, 'Other.srt', 'x');
    const d = (await get(s, `/media/${id}`)).json();
    const ext = d.subtitles.filter((x: any) => x.source === 'file');
    expect(ext.map((x: any) => [x.id, x.language])).toEqual(expect.arrayContaining([[`ext-${plain}`, null], [`ext-${en}`, 'en']]));
    expect(ext.map((x: any) => x.id)).not.toContain(`ext-${unrelated}`);

    const vtt = await get(s, `/media/${id}/subtitles/ext-${plain}.vtt`);
    expect(vtt.statusCode).toBe(200);
    expect(vtt.body).toBe('WEBVTT\n\n1\n00:00:00.500 --> 00:00:01.500\nHello, world\n');
    expect((await get(s, `/media/${id}/subtitles/ext-${en}`)).body).toContain('Howdy');
    expect((await get(s, `/media/${id}/subtitles/ext-${unrelated}`)).statusCode).toBe(404); // not this video's subtitle
  });

  it('lets the user link any subtitle file explicitly, and unlink it again', async () => {
    const s = await user();
    const id = await put(s, 'Film.mp4', fx.files['clip.mp4']!);
    const sub = await put(s, 'translation.srt', srt);
    expect((await get(s, `/media/${id}/subtitles/ext-${sub}`)).statusCode).toBe(404);
    const link = await call(s, 'POST', `/media/${id}/subtitles`, { fileId: sub, label: 'Deutsch', language: 'de' });
    expect(link.statusCode).toBe(201);
    const listed = (await get(s, `/media/${id}`)).json().subtitles.find((x: any) => x.id === `ext-${sub}`);
    expect(listed).toMatchObject({ label: 'Deutsch', language: 'de', source: 'file', linkId: link.json().id });
    expect((await get(s, `/media/${id}/subtitles/ext-${sub}`)).statusCode).toBe(200);
    expect((await call(s, 'DELETE', `/media/${id}/subtitles/${link.json().id}`)).statusCode).toBe(204);
    expect((await get(s, `/media/${id}/subtitles/ext-${sub}`)).statusCode).toBe(404);

    const notSub = await put(s, 'data.txt', 'x');
    expect((await call(s, 'POST', `/media/${id}/subtitles`, { fileId: notSub })).json().error.code).toBe('unsupported_subtitle');
  });

  it("cannot link or read someone else's subtitle file", async () => {
    const a = await user(); const b = await user();
    const id = await put(a, 'Mine.mp4', fx.files['clip.mp4']!);
    const theirs = await put(b, 'secret.srt', 'private text');
    expect((await call(a, 'POST', `/media/${id}/subtitles`, { fileId: theirs })).statusCode).toBe(404);
    expect((await get(a, `/media/${id}/subtitles/ext-${theirs}`)).statusCode).toBe(404);
  });

  it('decodes legacy encodings and refuses oversized subtitle files', async () => {
    const s = await user();
    const id = await put(s, 'Enc.mp4', fx.files['clip.mp4']!);
    const latin = await put(s, 'Enc.srt', Buffer.from('1\n00:00:00,000 --> 00:00:01,000\ncaf\xe9\n', 'latin1'));
    expect((await get(s, `/media/${id}/subtitles/ext-${latin}`)).body).toContain('café');
    const big = await put(s, 'Enc.fr.srt', 'x');
    await t.db.query('UPDATE files SET size_bytes = $2 WHERE id = $1', [big, 3 * 1024 * 1024]);
    const r = await get(s, `/media/${id}/subtitles/ext-${big}`);
    expect([r.statusCode, r.json().error.code]).toEqual([413, 'subtitle_too_large']);
    expect((await get(s, `/media/${id}/subtitles/..%2F..%2Fetc`)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await get(s, `/media/${id}/subtitles/emb-abc`)).statusCode).toBe(400);
  });
});

describe('derived files and cleanup', () => {
  it('deleting a file for good removes its thumbnail and subtitles from storage and gives the quota back', async () => {
    const s = await user();
    const { id } = await indexed(s, 'multi.mkv');
    const assets = await assetRows(id);
    expect(assets.map((a: any) => a.kind).sort()).toEqual(['subtitle', 'subtitle', 'thumbnail']);
    const keys = assets.map((a: any) => a.storage_key as string);
    for (const k of keys) expect(await t.storage.stat(k)).not.toBeNull();

    await call(s, 'DELETE', `/files/${id}`);
    expect(await used(s)).toBeGreaterThan(0); // still in the trash: still counted
    await call(s, 'POST', '/trash/empty');
    expect(await assetRows(id)).toEqual([]);
    for (const k of keys) expect(await t.storage.stat(k)).toBeNull();
    expect(await used(s)).toBe(0);
  });

  it('replacing a thumbnail does not leak the old object or double-charge', async () => {
    const s = await user();
    const { id, e } = await indexed(s, 'clip.mp4');
    const before = { assets: await assetRows(id), used: await used(s) };
    await t.db.query(`UPDATE media_metadata SET status = 'pending', next_attempt_at = now() WHERE file_id = $1`, [id]);
    await e.tick();
    await settled(s, id);
    await waitFor(async () => (await t.db.query<any>('SELECT status FROM media_metadata WHERE file_id = $1', [id])).rows[0].status === 'ready');
    const after = { assets: await assetRows(id), used: await used(s) };
    expect(after.assets).toHaveLength(1);
    expect(after.used).toBe(before.used); // same thumbnail size, charged once
    if (after.assets[0].storage_key !== before.assets[0].storage_key) expect(await t.storage.stat(before.assets[0].storage_key)).toBeNull();
  });
});

describe('converted copies (transcoding)', () => {
  it('converts an unplayable AVI to a browser-friendly MP4 and streams it with Range support', async () => {
    const s = await user();
    const { id } = await indexed(s, 'old.avi');
    await t.db.query('UPDATE storage_quotas SET quota_bytes = $2 WHERE user_id = $1', [s.userId, 50 * 1024 * 1024]);
    const before = await used(s);
    const r = await call(s, 'POST', `/media/${id}/renditions`, { profile: 'web-480p' });
    expect([r.statusCode, r.json().status]).toEqual([202, 'queued']);
    const e = mkEngine(); e.start();
    const done = await waitFor(async () => {
      const d = (await get(s, `/media/${id}`)).json();
      const x = d.renditions.find((y: any) => y.profile === 'web-480p');
      return x && ['ready', 'failed'].includes(x.status) ? x : false;
    }, 90000, 'conversion');
    expect(done).toMatchObject({ status: 'ready', progress: 1 });
    expect(done.size).toBeGreaterThan(1000);
    expect(await used(s)).toBe(before + done.size);

    const res = await get(s, `/media/${id}/stream?rendition=web-480p`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(Buffer.from(res.rawPayload.subarray(4, 8)).toString()).toBe('ftyp'); // really an MP4
    const part = await get(s, `/media/${id}/stream?rendition=web-480p`, { range: 'bytes=0-99' });
    expect([part.statusCode, part.rawPayload.length]).toEqual([206, 100]);
    expect((await get(s, `/media/${id}/stream?rendition=nope`)).statusCode).toBe(404);

    // the copy is a normal browser-playable file
    const { Ffmpeg } = await import('../src/media/ffmpeg.js');
    const ff = new Ffmpeg({ ...t.config, FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: ffprobePath } as never);
    const asset = (await assetRows(id)).find((a: any) => a.kind === 'rendition');
    const probed = await ff.probe({ kind: 'file', path: (t.storage as any).localPath(asset.storage_key) }, 'mov');
    expect(probed).toMatchObject({ videoCodec: 'h264', audioCodec: 'aac', hasVideo: true });
    expect(probed.height).toBeLessThanOrEqual(480);

    // deleting it frees the space and the object
    expect((await call(s, 'DELETE', `/media/${id}/renditions/web-480p`)).statusCode).toBe(204);
    expect(await used(s)).toBe(before);
    expect(await t.storage.stat(asset.storage_key)).toBeNull();
  }, 120_000);

  it('converts audio to AAC and validates requests', async () => {
    const s = await user();
    const { id } = await indexed(s, 'tone.mp3');
    await t.db.query('UPDATE storage_quotas SET quota_bytes = $2 WHERE user_id = $1', [s.userId, 50 * 1024 * 1024]);
    expect((await call(s, 'POST', `/media/${id}/renditions`, { profile: 'web-480p' })).json().error.code).toBe('profile_mismatch');
    expect((await call(s, 'POST', `/media/${id}/renditions`, { profile: 'bogus' })).json().error.code).toBe('unknown_profile');
    expect((await call(s, 'POST', `/media/${id}/renditions`, { profile: 'audio-aac' })).statusCode).toBe(202);
    expect((await call(s, 'POST', `/media/${id}/renditions`, { profile: 'audio-aac' })).json().error.code).toBe('already_exists');
    mkEngine().start();
    await waitFor(async () => (await get(s, `/media/${id}`)).json().renditions[0]?.status === 'ready', 60000, 'audio conversion');
    const res = await get(s, `/media/${id}/stream?rendition=audio-aac`);
    expect([res.statusCode, res.headers['content-type']]).toEqual([200, 'audio/mp4']);
    expect((await call(s, 'DELETE', `/media/${id}/renditions/audio-aac`)).statusCode).toBe(204);
    expect((await call(s, 'DELETE', `/media/${id}/renditions/audio-aac`)).statusCode).toBe(409);
  }, 90_000);

  it('is off unless enabled, refuses when storage is full, and reports failures without leaking internals', async () => {
    const off = await createTestEnv({ FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: ffprobePath });
    try {
      const s = await login(off, 'tc-off', 'tc-off@example.com');
      const m = multipartBody('x.mp4', fx.files['clip.mp4']!);
      const up = await off.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(s), ...m.headers }, payload: m.body });
      const r = await off.app.inject({ method: 'POST', url: `/api/v1/media/${up.json().id}/renditions`, headers: authed(s), payload: { profile: 'web-480p' } });
      expect([r.statusCode, r.json().error.code]).toEqual([409, 'transcoding_disabled']);
    } finally { await off.close(); }

    const s = await user();
    const { id, e: indexer } = await indexed(s, 'old.avi');
    await indexer.stop(); // otherwise this working engine would convert the file before the broken one below can fail it
    await t.db.query('UPDATE storage_quotas SET quota_bytes = $2 WHERE user_id = $1', [s.userId, 50 * 1024 * 1024]);
    await t.db.query('UPDATE storage_quotas SET used_bytes = quota_bytes - 1000 WHERE user_id = $1', [s.userId]);
    const full = await call(s, 'POST', `/media/${id}/renditions`, { profile: 'web-480p' });
    expect([full.statusCode, full.json().error.code]).toEqual([413, 'quota_exceeded']);
    await t.db.query('UPDATE storage_quotas SET used_bytes = $2 WHERE user_id = $1', [s.userId, fx.files['old.avi']!.length]);

    // a conversion that fails is reported and can be started again
    expect((await call(s, 'POST', `/media/${id}/renditions`, { profile: 'web-480p' })).statusCode).toBe(202);
    const broken = mkEngine({ FFMPEG_PATH: 'definitely-not-installed-ffmpeg' }); broken.start();
    const failed = await waitFor(async () => { const x = (await get(s, `/media/${id}`)).json().renditions[0]; return x?.status === 'failed' ? x : false; }, 30000, 'failed conversion');
    expect(failed.error).toBe('FFmpeg is not available on the server');
    await broken.stop();
    expect((await call(s, 'POST', `/media/${id}/renditions`, { profile: 'web-480p' })).statusCode).toBe(202); // retry allowed after failure
  }, 120_000);
});

describe('S3-compatible storage (FFmpeg reads through a private presigned URL)', () => {
  let server: { close(): Promise<void>; run(): Promise<unknown> };
  let endpoint = '';
  beforeAll(async () => {
    const port = await new Promise<number>((res) => { const sv = net.createServer().listen(0, '127.0.0.1', () => { const p = (sv.address() as AddressInfo).port; sv.close(() => res(p)); }); });
    server = new (S3rver as any)({ port, address: '127.0.0.1', silent: true, directory: await mkdtemp(path.join(os.tmpdir(), 's3rver-media-')), configureBuckets: [{ name: 'media' }] });
    await server.run();
    endpoint = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => { await server.close(); });

  it('indexes, thumbnails and streams a video that lives in S3', async () => {
    const s3 = new S3Storage({ endpoint, region: 'us-east-1', bucket: 'media', accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER', forcePathStyle: true, keyPrefix: 'm' }, { maxAttempts: 1 });
    const env = await createTestEnv({ FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: ffprobePath }, { storage: s3 });
    const eng = new MediaEngine({ db: env.db, config: env.config, storage: s3, adapterFor: () => s3, log: silent });
    try {
      const s = await login(env, 'media-s3', 'media-s3@example.com');
      const m = multipartBody('remote.mp4', fx.files['clip.mp4']!);
      const up = await env.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(s), ...m.headers }, payload: m.body });
      expect(up.statusCode).toBe(201);
      const id = up.json().id;
      eng.start();
      const d = await waitFor(async () => { const x = (await env.app.inject({ method: 'GET', url: `/api/v1/media/${id}`, headers: { cookie: s.cookie } })).json(); return ['ready', 'failed', 'unsupported'].includes(x.status) ? x : false; }, 60000, 'S3 media');
      expect(d).toMatchObject({ status: 'ready', width: 320, videoCodec: 'h264', hasThumbnail: true });
      const th = await env.app.inject({ method: 'GET', url: `/api/v1/media/${id}/thumbnail`, headers: { cookie: s.cookie } });
      expect(th.rawPayload[0]).toBe(0xff);
      const part = await env.app.inject({ method: 'GET', url: `/api/v1/media/${id}/stream`, headers: { cookie: s.cookie, range: 'bytes=0-99' } });
      expect([part.statusCode, Buffer.from(part.rawPayload).equals(fx.files['clip.mp4']!.subarray(0, 100))]).toEqual([206, true]);
      const row = (await env.db.query<{ error_message: string | null }>('SELECT error_message FROM media_metadata WHERE file_id = $1', [id])).rows[0]!;
      expect(row.error_message ?? '').not.toMatch(/X-Amz|http/); // the presigned URL never reaches the database
    } finally { await eng.stop(); await env.close(); }
  }, 120_000);
});
