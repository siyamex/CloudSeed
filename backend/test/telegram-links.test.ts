import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { createVault } from '../src/crypto.js';
import { TelegramEngine } from '../src/telegram/engine.js';
import { startFakeTelegram, type FakeTelegram } from './fake-telegram.js';
import { authed, createTestEnv, login, multipartBody, type Session, type TestEnv } from './helpers.js';

const silent = { info() {}, warn() {}, error() {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ENC = Buffer.alloc(32, 4).toString('base64');
const BIG = Buffer.alloc(450_000, 7); // the test limit is 200000 bytes
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, ms = 15000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); }
  throw new Error(`timed out waiting for ${what}`);
}

let t: TestEnv;
let fake: FakeTelegram;
const engines: TelegramEngine[] = [];
let seq = 0;
const baseEnv = (extra: Record<string, string> = {}) => ({
  ENCRYPTION_KEY: ENC, TELEGRAM_API_BASE: fake.url, TELEGRAM_MAX_UPLOAD_BYTES: '200000', TELEGRAM_CHAT_INTERVAL_MS: '0', TELEGRAM_BACKOFF_BASE_MS: '30', ...extra,
});
beforeAll(async () => { fake = await startFakeTelegram(); t = await createTestEnv(baseEnv()); });
afterEach(async () => { for (const e of engines.splice(0)) await e.stop(); });
afterAll(async () => { await t.close(); await fake.close(); });

async function setup(env: TestEnv = t, name = `l${++seq}`) {
  const s = await login(env, `lnk-${name}`, `lnk-${name}@example.com`);
  const botId = 800000 + ++seq, token = `${botId}:AAAA${'k'.repeat(16)}_${seq}`, chatId = -1008000000000 - seq;
  fake.addBot(token, { id: botId, username: `lnk${seq}_bot` });
  fake.addChat({ id: chatId, type: 'supergroup', title: `links ${seq}` }, { [botId]: { status: 'member' } });
  const call = (m: string, u: string, p?: unknown) => env.app.inject({ method: m as 'GET', url: `/api/v1${u}`, headers: authed(s), payload: p as object });
  const bot = (await call('POST', '/telegram/bots', { token })).json();
  const dest = (await call('POST', '/telegram/destinations', { botId: bot.id, chat: String(chatId) })).json();
  const up = async (name: string, content: Buffer | string) => {
    const m = multipartBody(name, content);
    const r = await env.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(s), ...m.headers }, payload: m.body });
    return r.json().id as string;
  };
  return { s, chatId, dest, call, up, env };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const link = { expiresInHours: 48, maxDownloads: 3, confirmPublic: true as const };
const run = (c: Ctx, over: Partial<Config> = {}) => {
  const e = new TelegramEngine({ db: c.env.db, vault: createVault(c.env.config), config: { ...c.env.config, ...over } as Config, adapterFor: () => c.env.storage, log: silent });
  e.start(); engines.push(e); return e;
};
const settle = (c: Ctx, id: string) => waitFor(async () => { const x = (await c.call('GET', `/telegram/transfers/${id}`)).json(); return ['sent', 'failed', 'partial'].includes(x.state) ? x : false; }, 20000, 'delivery');
const sentTo = (c: Ctx) => fake.sent.filter((x) => x.chatId === c.chatId);

describe('sending a link instead of an oversized file', () => {
  it('offers the link as an alternative when sharing is on, and explains what it means', async () => {
    const c = await setup();
    const id = await c.up('big.bin', BIG);
    const p = (await c.call('POST', '/telegram/transfers/preview', { destinationId: c.dest.id, fileIds: [id] })).json();
    const alt = Object.fromEntries(p.issues[0].alternatives.map((a: any) => [a.kind, a]));
    expect(alt.share_link).toMatchObject({ available: true });
    expect(alt.share_link.detail).toMatch(/stays on CloudSeed, not on Telegram/);
    const withLink = (await c.call('POST', '/telegram/transfers/preview', { destinationId: c.dest.id, fileIds: [id], linkLargeFiles: true })).json();
    expect(withLink.issues).toEqual([]);
    expect(withLink.items).toEqual([expect.objectContaining({ name: 'big.bin', sendAs: 'link', size: 450000 })]);
  });

  it('creates an expiring public link, posts an honest message, and the link really downloads the file', async () => {
    const c = await setup();
    const small = await c.up('small.txt', 'tiny');
    const id = await c.up('big.bin', BIG);
    const r = await c.call('POST', '/telegram/transfers', { destinationId: c.dest.id, fileIds: [small, id], linkLargeFiles: true, shareLink: link, caption: 'Files for you' });
    expect(r.statusCode).toBe(201);
    expect(r.body).not.toMatch(/\/s\/[A-Za-z0-9_-]{43}/); // the link is not in the API response either
    run(c);
    const done = await settle(c, r.json().id);
    expect(done.state).toBe('sent');
    const sent = sentTo(c);
    expect(sent.map((x) => x.method)).toEqual(['sendDocument', 'sendMessage']); // the small file uploaded, the big one as a message
    const text = sent[1]!.fields.text!;
    expect(text).toContain('http://localhost:8080/s/');
    expect(text).toContain('hosted there, not on Telegram');
    expect(text).toMatch(/expires on \d{4}-\d\d-\d\d \d\d:\d\d UTC and allows 3 downloads/);
    expect(text).not.toMatch(/Files for you/); // the caption went on the first message (the small file)
    expect(sent[0]!.fields.caption).toBe('Files for you');

    const url = /(http:\/\/localhost:8080\/s\/[A-Za-z0-9_-]{43})/.exec(text)![1]!;
    const token = url.split('/s/')[1]!;
    const dl = await t.app.inject({ method: 'GET', url: `/api/v1/public/shares/${token}/download` });
    expect([dl.statusCode, sha(Buffer.from(dl.rawPayload))]).toEqual([200, sha(BIG)]);

    const share = (await t.db.query<any>(`SELECT * FROM shared_links WHERE file_id = $1`, [id])).rows[0];
    expect(share).toMatchObject({ mode: 'public', max_downloads: 3, user_id: c.s.userId });
    expect(Buffer.from(share.token_hash).equals(createHash('sha256').update(token).digest())).toBe(true);
    const hours = (new Date(share.expires_at).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47); expect(hours).toBeLessThan(48.1);

    // The stored message holds the secret token only until it is delivered.
    const rows = (await t.db.query<any>(`SELECT send_as, caption, share_id, message_id FROM telegram_transfer_files WHERE transfer_id = $1 ORDER BY position`, [r.json().id])).rows;
    expect(rows[1]).toMatchObject({ send_as: 'link', caption: null, share_id: share.id });
    expect(rows[1].message_id).not.toBeNull();
    expect(JSON.stringify(done)).not.toContain(token);
  });

  it('requires the owner to choose the lifetime and confirm that anyone with the link can download', async () => {
    const c = await setup();
    const id = await c.up('big.bin', BIG);
    const none = await c.call('POST', '/telegram/transfers', { destinationId: c.dest.id, fileIds: [id], linkLargeFiles: true });
    expect([none.statusCode, none.json().error.code]).toEqual([422, 'share_link_required']);
    const noConfirm = await c.call('POST', '/telegram/transfers', { destinationId: c.dest.id, fileIds: [id], linkLargeFiles: true, shareLink: { expiresInHours: 5 } });
    expect(noConfirm.statusCode).toBe(400);
    const tooLong = await c.call('POST', '/telegram/transfers', { destinationId: c.dest.id, fileIds: [id], linkLargeFiles: true, shareLink: { ...link, expiresInHours: 366 * 24 } });
    expect(tooLong.statusCode).toBe(400);
    const both = await c.call('POST', '/telegram/transfers', { destinationId: c.dest.id, fileIds: [id], linkLargeFiles: true, splitLargeFiles: true, shareLink: link });
    expect([both.statusCode, both.json().error.code]).toEqual([400, 'conflicting_options']);
    expect((await t.db.query('SELECT 1 FROM shared_links WHERE user_id = $1', [c.s.userId])).rowCount).toBe(0); // nothing was created along the way
    expect((await c.call('GET', '/telegram/transfers')).json().transfers).toEqual([]);
  });

  it('never invents a link when sharing is unavailable: server-wide off, or off for that file', async () => {
    const off = await createTestEnv(baseEnv({ SHARING_ENABLED: 'false' }));
    try {
      const c = await setup(off, 'off');
      const id = await c.up('big.bin', BIG);
      const p = (await c.call('POST', '/telegram/transfers/preview', { destinationId: c.dest.id, fileIds: [id] })).json();
      expect(p.issues[0].alternatives.find((a: any) => a.kind === 'share_link')).toMatchObject({ available: false });
      const r = await c.call('POST', '/telegram/transfers', { destinationId: c.dest.id, fileIds: [id], linkLargeFiles: true, shareLink: link });
      expect([r.statusCode, r.json().error.code]).toEqual([422, 'transfer_not_possible']);
      expect((await c.call('GET', '/telegram/status')).json().sharing.enabled).toBe(false);
    } finally { await off.close(); }

    const c = await setup();
    const id = await c.up('big.bin', BIG);
    await c.call('PATCH', `/files/${id}`, { sharingDisabled: true });
    const r = await c.call('POST', '/telegram/transfers', { destinationId: c.dest.id, fileIds: [id], linkLargeFiles: true, shareLink: link });
    expect([r.statusCode, r.json().error.code]).toEqual([409, 'file_sharing_disabled']);
  });

  it('protects the link with a password without ever putting the password in the message', async () => {
    const c = await setup();
    const id = await c.up('big.bin', BIG);
    const r = await c.call('POST', '/telegram/transfers', { destinationId: c.dest.id, fileIds: [id], linkLargeFiles: true, shareLink: { ...link, password: 'hunter2 hunter2' } });
    run(c);
    await settle(c, r.json().id);
    const text = sentTo(c)[0]!.fields.text!;
    expect(text).toContain('password protected; ask the sender for the password');
    expect(text).not.toContain('hunter2');
    const token = /\/s\/([A-Za-z0-9_-]{43})/.exec(text)![1]!;
    const locked = await t.app.inject({ method: 'GET', url: `/api/v1/public/shares/${token}/download` });
    expect(locked.statusCode).toBe(403);
    expect((await t.db.query<any>(`SELECT password_hash FROM shared_links WHERE file_id = $1`, [id])).rows[0].password_hash).toMatch(/^scrypt\$/);
  });

  it('fails the item (and sends nothing) if the link was turned off before it could be posted', async () => {
    const c = await setup();
    const id = await c.up('big.bin', BIG);
    const r = await c.call('POST', '/telegram/transfers', { destinationId: c.dest.id, fileIds: [id], linkLargeFiles: true, shareLink: link });
    const shareId = (await t.db.query<{ id: string }>(`SELECT id FROM shared_links WHERE file_id = $1`, [id])).rows[0]!.id;
    await c.call('POST', `/shares/${shareId}/revoke`);
    run(c);
    const done = await settle(c, r.json().id);
    expect(done.state).toBe('failed');
    expect(done.files[0]).toMatchObject({ sendAs: 'link', error: { code: 'share_unavailable' } });
    expect(sentTo(c)).toHaveLength(0);
  });

  it('does not repeat a link transfer as it is (it would reuse a secret that was already shown)', async () => {
    const c = await setup();
    const id = await c.up('big.bin', BIG);
    const r = await c.call('POST', '/telegram/transfers', { destinationId: c.dest.id, fileIds: [id], linkLargeFiles: true, shareLink: link });
    run(c);
    await settle(c, r.json().id);
    const again = await c.call('POST', `/telegram/transfers/${r.json().id}/resend`);
    expect([again.statusCode, again.json().error.code]).toEqual([409, 'link_transfer']);
  });

  it('respects the per-user limit on active links', async () => {
    const lim = await createTestEnv(baseEnv({ SHARING_MAX_ACTIVE_PER_USER: '1' }));
    try {
      const c = await setup(lim, 'lim');
      const a = await c.up('a.bin', BIG), b = await c.up('b.bin', BIG);
      const r = await c.call('POST', '/telegram/transfers', { destinationId: c.dest.id, fileIds: [a, b], linkLargeFiles: true, shareLink: link });
      expect([r.statusCode, r.json().error.code]).toEqual([429, 'too_many_shares']);
      expect((await lim.db.query('SELECT 1 FROM shared_links')).rowCount).toBe(0);
    } finally { await lim.close(); }
  });
});
