import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { createVault } from '../src/crypto.js';
import { MediaEngine } from '../src/media/engine.js';
import { TelegramEngine } from '../src/telegram/engine.js';
import { startFakeTelegram, type FakeTelegram } from './fake-telegram.js';
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
let fake: FakeTelegram;
let fx: Fixtures;
const stoppers: { stop(): Promise<void> }[] = [];
let seq = 0;

beforeAll(async () => {
  fx = await fixtures();
  fake = await startFakeTelegram();
  t = await createTestEnv({
    ENCRYPTION_KEY: Buffer.alloc(32, 6).toString('base64'), TELEGRAM_API_BASE: fake.url, TELEGRAM_CHAT_INTERVAL_MS: '0', TELEGRAM_BACKOFF_BASE_MS: '30',
    FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: ffprobePath, MEDIA_THUMBNAIL_WIDTH: '160',
  });
}, 120_000);
afterEach(async () => { for (const e of stoppers.splice(0)) await e.stop(); fake.clearFailures(); });
afterAll(async () => { await t.close(); await fake.close(); });

const call = (s: Session, method: string, url: string, payload?: unknown) => t.app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: authed(s), payload: payload as object });

async function setup() {
  const n = ++seq;
  const s = await login(t, `tgm-${n}`, `tgm-${n}@example.com`);
  const botId = 700000 + n, token = `${botId}:AAAA${'q'.repeat(16)}_m${n}`, chatId = -1007000000000 - n;
  fake.addBot(token, { id: botId, username: `media${n}_bot` });
  fake.addChat({ id: chatId, type: 'supergroup', title: `media ${n}` }, { [botId]: { status: 'member' } });
  const bot = (await call(s, 'POST', '/telegram/bots', { token })).json();
  const dest = (await call(s, 'POST', '/telegram/destinations', { botId: bot.id, chat: String(chatId) })).json();
  return { s, chatId, dest };
}
async function upload(s: Session, name: string): Promise<string> {
  const m = multipartBody(name, fx.files[name]!);
  const r = await t.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(s), ...m.headers }, payload: m.body });
  return r.json().id;
}
async function index(id: string) {
  const e = new MediaEngine({ db: t.db, config: t.config as Config, storage: t.storage, adapterFor: () => t.storage, log: silent });
  e.start(); stoppers.push(e);
  await waitFor(async () => ['ready', 'failed', 'unsupported'].includes((await t.db.query<{ status: string }>('SELECT status FROM media_metadata WHERE file_id = $1', [id])).rows[0]!.status), 40000, 'indexing');
  await e.stop();
}
async function deliver(c: Awaited<ReturnType<typeof setup>>, fileIds: string[], extra: Record<string, unknown> = {}) {
  const r = await call(c.s, 'POST', '/telegram/transfers', { destinationId: c.dest.id, fileIds, ...extra });
  expect(r.statusCode).toBe(201);
  const e = new TelegramEngine({ db: t.db, vault: createVault(t.config), config: t.config as Config, adapterFor: () => t.storage, log: silent });
  e.start(); stoppers.push(e);
  const id = r.json().id;
  const done = await waitFor(async () => { const x = (await t.app.inject({ method: 'GET', url: `/api/v1/telegram/transfers/${id}`, headers: { cookie: c.s.cookie } })).json(); return ['sent', 'failed', 'partial'].includes(x.state) ? x : false; }, 30000, 'delivery');
  return { done, sent: fake.sent.filter((x) => x.chatId === c.chatId) };
}

describe('Telegram uploads use the media index', () => {
  it('sends a video with its thumbnail, dimensions and duration', async () => {
    const c = await setup();
    const id = await upload(c.s, 'clip.mp4');
    await index(id);
    const { done, sent } = await deliver(c, [id]);
    expect(done.state).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('sendVideo');
    expect(sent[0]!.fields).toMatchObject({ width: '320', height: '240', duration: '3', supports_streaming: 'true', thumbnail: 'attach://thumb' });
    const thumb = sent[0]!.files.find((f) => f.field === 'thumb')!;
    expect(thumb).toMatchObject({ contentType: 'image/jpeg', filename: 'thumb.jpg' });
    expect(thumb.size).toBeGreaterThan(100);
    expect(thumb.size).toBeLessThanOrEqual(200 * 1024); // Telegram's limit for thumbnails
    expect(sent[0]!.files.find((f) => f.field === 'video')!.size).toBe(fx.files['clip.mp4']!.length);
  });

  it('sends audio with its cover, duration, title and artist', async () => {
    const c = await setup();
    const id = await upload(c.s, 'covered.mp3');
    await index(id);
    const { done, sent } = await deliver(c, [id]);
    expect(done.state).toBe('sent');
    expect(sent[0]!.method).toBe('sendAudio');
    expect(sent[0]!.fields).toMatchObject({ duration: '3', title: 'Test Tone', performer: 'Sine Band', thumbnail: 'attach://thumb' });
    expect(sent[0]!.files.some((f) => f.field === 'thumb')).toBe(true);
  });

  it('still sends media that has not been indexed, just without the extras', async () => {
    const c = await setup();
    const id = await upload(c.s, 'clip.mp4'); // no media engine has run
    const { done, sent } = await deliver(c, [id]);
    expect(done.state).toBe('sent');
    expect(sent[0]!.method).toBe('sendVideo');
    expect(sent[0]!.fields.thumbnail).toBeUndefined();
    expect(sent[0]!.fields.width).toBeUndefined();
    expect(sent[0]!.files.map((f) => f.field)).toEqual(['video']);
  });

  it('does not add extras when the file is sent as a plain document', async () => {
    const c = await setup();
    const id = await upload(c.s, 'clip.mp4');
    await index(id);
    const { sent } = await deliver(c, [id], { method: 'document' });
    expect(sent[0]!.method).toBe('sendDocument');
    expect(sent[0]!.fields.thumbnail).toBeUndefined();
    expect(sent[0]!.files.map((f) => f.field)).toEqual(['document']);
  });

  it('retries once without the thumbnail if Telegram rejects it, and does not post twice', async () => {
    const c = await setup();
    const id = await upload(c.s, 'clip.mp4');
    await index(id);
    fake.fail({ method: 'sendVideo', kind: 'status', status: 400, description: 'Bad Request: wrong thumbnail dimensions' });
    const { done, sent } = await deliver(c, [id]);
    expect(done.state).toBe('sent');
    expect(done.files[0]).toMatchObject({ state: 'sent', attempt: 0, ambiguous: false });
    expect(sent).toHaveLength(1); // exactly one message reached the chat
    expect(sent[0]!.fields.thumbnail).toBeUndefined();
    expect(sent[0]!.files.map((f) => f.field)).toEqual(['video']);
  });
});
