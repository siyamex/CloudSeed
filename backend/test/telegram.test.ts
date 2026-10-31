import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { createVault } from '../src/crypto.js';
import { TelegramEngine } from '../src/telegram/engine.js';
import type { StorageAdapter } from '../src/storage/types.js';
import { startFakeTelegram, type FakeMember, type FakeTelegram } from './fake-telegram.js';
import { authed, createTestEnv, login, multipartBody, type Session, type TestEnv } from './helpers.js';

const silent = { info() {}, warn() {}, error() {} };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const ENC_KEY = Buffer.alloc(32, 5).toString('base64');

let t: TestEnv;
let fake: FakeTelegram;
let engines: TelegramEngine[] = [];
let botSeq = 0, chatSeq = 0, userSeq = 0;

beforeAll(async () => {
  fake = await startFakeTelegram();
  t = await createTestEnv({
    ENCRYPTION_KEY: ENC_KEY, TELEGRAM_API_BASE: fake.url, TELEGRAM_MAX_UPLOAD_BYTES: '200000', TELEGRAM_PHOTO_MAX_BYTES: '50000',
    TELEGRAM_CHAT_INTERVAL_MS: '0', TELEGRAM_BACKOFF_BASE_MS: '30', TELEGRAM_BACKOFF_MAX_MS: '200', TELEGRAM_IDLE_TIMEOUT_MS: '2000',
    TELEGRAM_RESPONSE_TIMEOUT_MS: '1500', TELEGRAM_MAX_ATTEMPTS: '3',
  });
});
afterEach(async () => { for (const e of engines.splice(0)) await e.stop(); fake.clearFailures(); fake.setLatency(0); });
afterAll(async () => { await t.close(); await fake.close(); });

// ---- helpers ----
const call = (s: Session | null, method: string, url: string, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url: `/api/v1${url}`, headers: s ? authed(s) : {}, payload: payload as object });
const tokenFor = (id: number) => `${id}:AAAA${'x'.repeat(16)}_t${id}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, ms = 15000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(25); }
  throw new Error(`timed out waiting for ${what}`);
}
function mkEngine(over: Partial<Config> = {}, adapter: StorageAdapter = t.storage) {
  const e = new TelegramEngine({ db: t.db, vault: createVault(t.config), config: { ...t.config, ...over } as Config, adapterFor: () => adapter, log: silent });
  engines.push(e);
  return e;
}
async function setup(name: string, o: { type?: 'group' | 'supergroup' | 'channel'; member?: FakeMember; username?: string } = {}) {
  const s = await login(t, `tg-${name}-${++userSeq}`, `tg-${name}-${userSeq}@example.com`);
  const botId = 100000 + ++botSeq;
  const token = tokenFor(botId);
  fake.addBot(token, { id: botId, username: `${name}${botSeq}_bot` });
  const chatId = -1001000000000 - ++chatSeq;
  fake.addChat({ id: chatId, type: o.type ?? 'supergroup', title: `${name} chat`, ...(o.username ? { username: o.username } : {}) }, { [botId]: o.member ?? { status: 'member' } });
  const bot = (await call(s, 'POST', '/telegram/bots', { token })).json();
  const destRes = await call(s, 'POST', '/telegram/destinations', { botId: bot.id, chat: String(chatId) });
  return { s, token, botId, bot, chatId, dest: destRes.json(), destRes };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

async function addFile(s: Session, name: string, content: Buffer | string): Promise<string> {
  const m = multipartBody(name, content);
  const r = await t.app.inject({ method: 'POST', url: '/api/v1/files/upload', headers: { ...authed(s), ...m.headers }, payload: m.body });
  if (r.statusCode !== 201) throw new Error(`upload failed: ${r.body}`);
  return r.json().id;
}
const send = async (c: Ctx, fileIds: string[], extra: Record<string, unknown> = {}) => {
  const r = await call(c.s, 'POST', '/telegram/transfers', { destinationId: c.dest.id, fileIds, ...extra });
  if (process.env.DEBUG_TG && r.statusCode >= 400) console.log('SEND-ERR', r.statusCode, r.body);
  return r;
};
const getTransfer = async (s: Session, id: string) => (await call(s, 'GET', `/telegram/transfers/${id}`)).json();
const waitTransfer = (s: Session, id: string, states: string[], ms = 15000) =>
  waitFor(async () => { const x = await getTransfer(s, id); return states.includes(x.state) ? x : false; }, ms, `transfer ${id.slice(0, 8)} -> ${states.join('|')}`);
const fileRows = async (transferId: string) => (await t.db.query<any>(`SELECT * FROM telegram_transfer_files WHERE transfer_id = $1 ORDER BY position`, [transferId])).rows;
const sentTo = (c: Ctx) => fake.sent.filter((x) => x.chatId === c.chatId);
const noteKinds = async (s: Session) => (await t.db.query<{ kind: string }>('SELECT kind FROM notifications WHERE user_id = $1', [s.userId])).rows.map((r) => r.kind);
const bytes = (n: number, seed = 1) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 17 + (i >> 8)) & 255; return b; };

// =============================================================== bots
describe('bot connection and credential protection', () => {
  it('connects a bot, validating the token with Telegram, and never returns or stores it in the clear', async () => {
    const s = await login(t, 'tg-conn', 'tg-conn@example.com');
    const botId = 100000 + ++botSeq; const token = tokenFor(botId);
    fake.addBot(token, { id: botId, username: 'conn_bot' });
    const r = await call(s, 'POST', '/telegram/bots', { token });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ username: 'conn_bot', status: 'active', name: 'Bot conn_bot' });
    expect(r.body).not.toContain(token);
    expect(Object.keys(r.json())).not.toContain('token');

    const list = await call(s, 'GET', '/telegram/bots');
    expect(list.body).not.toContain(token);
    expect(list.body).not.toContain('token_enc');

    const row = { token_enc: Buffer.from((await t.db.query<{ token_enc: Buffer }>('SELECT token_enc FROM telegram_bots WHERE id = $1', [r.json().id])).rows[0]!.token_enc) };
    expect(row.token_enc.toString('latin1')).not.toContain(token.split(':')[1]!);
    expect(row.token_enc.toString('utf8')).not.toContain(String(botId));
    const aad = `telegram-bot:${s.userId}:${botId}`;
    expect(createVault(t.config).decrypt(row.token_enc, aad)).toBe(token);
    const audit = await t.db.query(`SELECT 1 FROM audit_logs WHERE user_id = $1 AND action = 'telegram.bot_connected'`, [s.userId]);
    expect(audit.rowCount).toBe(1);
  });

  it('rejects malformed tokens, tokens Telegram refuses, and a duplicate connection', async () => {
    const s = await login(t, 'tg-bad', 'tg-bad@example.com');
    expect((await call(s, 'POST', '/telegram/bots', { token: 'not-a-token' })).statusCode).toBe(400);
    expect((await call(s, 'POST', '/telegram/bots', {})).statusCode).toBe(400);
    const unknown = await call(s, 'POST', '/telegram/bots', { token: tokenFor(999999) });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('invalid_token');
    expect(unknown.body).not.toContain(tokenFor(999999));

    const botId = 100000 + ++botSeq; const token = tokenFor(botId);
    fake.addBot(token, { id: botId, username: 'dup_bot' });
    expect((await call(s, 'POST', '/telegram/bots', { token })).statusCode).toBe(201);
    const dup = await call(s, 'POST', '/telegram/bots', { token });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('already_connected');
  });

  it('keeps bots isolated per user: the same bot can be connected by two users as two independent rows', async () => {
    const a = await login(t, 'tg-iso-a', 'tg-iso-a@example.com');
    const b = await login(t, 'tg-iso-b', 'tg-iso-b@example.com');
    const botId = 100000 + ++botSeq; const token = tokenFor(botId);
    fake.addBot(token, { id: botId, username: 'shared_bot' });
    const ra = (await call(a, 'POST', '/telegram/bots', { token })).json();
    const rb = (await call(b, 'POST', '/telegram/bots', { token })).json();
    expect(ra.id).not.toBe(rb.id);
    // ciphertext is bound to its owner: moving one user's blob onto the other's row must fail to decrypt
    const blobA = Buffer.from((await t.db.query<{ token_enc: Buffer }>('SELECT token_enc FROM telegram_bots WHERE id = $1', [ra.id])).rows[0]!.token_enc);
    expect(() => createVault(t.config).decrypt(blobA, `telegram-bot:${b.userId}:${botId}`)).toThrow();
  });

  it('rotates the token of the same bot only, and the new token is the one used', async () => {
    const c = await setup('rot');
    const oldBlob = Buffer.from((await t.db.query<{ token_enc: Buffer }>('SELECT token_enc FROM telegram_bots WHERE id = $1', [c.bot.id])).rows[0]!.token_enc);
    const fresh = `${c.botId}:BBBB${'y'.repeat(16)}_rotated`;
    fake.addBot(fresh, { id: c.botId, username: c.bot.username });
    const r = await call(c.s, 'PUT', `/telegram/bots/${c.bot.id}/token`, { token: fresh });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(fresh);
    const newBlob = Buffer.from((await t.db.query<{ token_enc: Buffer }>('SELECT token_enc FROM telegram_bots WHERE id = $1', [c.bot.id])).rows[0]!.token_enc);
    expect(newBlob.equals(oldBlob)).toBe(false);
    expect(createVault(t.config).decrypt(newBlob, `telegram-bot:${c.s.userId}:${c.botId}`)).toBe(fresh);

    fake.removeBot(c.token); // the old token is revoked at Telegram; only the new one works
    const id = await addFile(c.s, 'r.txt', 'rotated');
    const tr = (await send(c, [id])).json();
    mkEngine().start();
    expect((await waitTransfer(c.s, tr.id, ['sent', 'failed'])).state).toBe('sent');

    const other = 100000 + ++botSeq; const otherTok = tokenFor(other);
    fake.addBot(otherTok, { id: other, username: 'other_bot' });
    const diff = await call(c.s, 'PUT', `/telegram/bots/${c.bot.id}/token`, { token: otherTok });
    expect(diff.statusCode).toBe(400);
    expect(diff.json().error.code).toBe('different_bot');
    expect((await call(c.s, 'PUT', `/telegram/bots/${c.bot.id}/token`, { token: tokenFor(424242) })).json().error.code).toBe('invalid_token');
  });

  it('tests the connection and flags the bot invalid when Telegram rejects the token', async () => {
    const c = await setup('test');
    const ok = await call(c.s, 'POST', `/telegram/bots/${c.bot.id}/test`);
    expect(ok.json()).toMatchObject({ ok: true, bot: { status: 'active' } });
    fake.removeBot(c.token);
    const bad = await call(c.s, 'POST', `/telegram/bots/${c.bot.id}/test`);
    expect(bad.statusCode).toBe(400);
    expect((await call(c.s, 'GET', '/telegram/bots')).json().bots[0].status).toBe('invalid');
  });

  it('disconnect erases the token, cancels queued files, keeps history and blocks new destinations; reconnecting reactivates', async () => {
    const c = await setup('disc');
    const id = await addFile(c.s, 'q.txt', 'queued');
    const tr = (await send(c, [id])).json(); // no engine running: stays queued
    const del = await call(c.s, 'DELETE', `/telegram/bots/${c.bot.id}`);
    expect(del.statusCode).toBe(204);
    const row = (await t.db.query<any>('SELECT token_enc, status FROM telegram_bots WHERE id = $1', [c.bot.id])).rows[0];
    expect(row).toMatchObject({ token_enc: null, status: 'disconnected' });
    const after = await getTransfer(c.s, tr.id);
    expect(after.state).toBe('cancelled');
    expect(after.files[0]).toMatchObject({ state: 'cancelled', error: { code: 'bot_disconnected' } });
    expect(await noteKinds(c.s)).toContain('integration_disconnected');
    const dests = (await call(c.s, 'GET', '/telegram/destinations')).json().destinations;
    expect(dests[0]).toMatchObject({ canSend: false });
    const add = await call(c.s, 'POST', '/telegram/destinations', { botId: c.bot.id, chat: '@whatever' });
    expect(add.statusCode).toBe(409);
    expect(add.json().error.code).toBe('bot_disconnected');
    expect((await call(c.s, 'PUT', `/telegram/bots/${c.bot.id}/token`, { token: c.token })).statusCode).toBe(409);

    const re = await call(c.s, 'POST', '/telegram/bots', { token: c.token });
    expect(re.statusCode).toBe(201);
    expect(re.json().id).toBe(c.bot.id); // same row, history intact
    expect((await getTransfer(c.s, tr.id)).state).toBe('cancelled');
  });

  it("never lets one user see or touch another user's bots, destinations or transfers (IDOR)", async () => {
    const a = await setup('idor-a');
    const b = await login(t, 'tg-idor-b', 'tg-idor-b@example.com');
    const fileA = await addFile(a.s, 'secret.txt', 'secret');
    const trA = (await send(a, [fileA])).json();
    const fileB = await addFile(b, 'mine.txt', 'mine');

    expect((await call(b, 'GET', '/telegram/bots')).json().bots).toEqual([]);
    expect((await call(b, 'GET', '/telegram/destinations')).json().destinations).toEqual([]);
    expect((await call(b, 'GET', '/telegram/transfers')).json().transfers).toEqual([]);
    for (const [m, u, body] of [
      ['PUT', `/telegram/bots/${a.bot.id}/token`, { token: a.token }], ['POST', `/telegram/bots/${a.bot.id}/test`], ['DELETE', `/telegram/bots/${a.bot.id}`],
      ['POST', '/telegram/destinations', { botId: a.bot.id, chat: String(a.chatId) }],
      ['POST', `/telegram/destinations/${a.dest.id}/validate`], ['POST', `/telegram/destinations/${a.dest.id}/test`],
      ['PATCH', `/telegram/destinations/${a.dest.id}`, { isDefault: true }], ['DELETE', `/telegram/destinations/${a.dest.id}`],
      ['POST', '/telegram/transfers', { destinationId: a.dest.id, fileIds: [fileB] }],
      ['POST', '/telegram/transfers/preview', { destinationId: a.dest.id, fileIds: [fileB] }],
      ['GET', `/telegram/transfers/${trA.id}`], ['POST', `/telegram/transfers/${trA.id}/cancel`], ['POST', `/telegram/transfers/${trA.id}/retry`, {}],
      ['POST', `/telegram/transfers/${trA.id}/resend`], ['DELETE', `/telegram/transfers/${trA.id}`],
    ] as [string, string, unknown?][]) {
      expect((await call(b, m, u, body)).statusCode, `${m} ${u}`).toBe(404);
    }
    // sending someone else's file through your own destination is also refused
    const mine = await setup('idor-c');
    expect((await send(mine, [fileA])).statusCode).toBe(404);
    expect((await getTransfer(a.s, trA.id)).state).toBe('queued');
    const unauth = await call(null, 'GET', '/telegram/transfers');
    expect(unauth.statusCode).toBe(401);
  });
});

// =============================================================== destinations
describe('destinations', () => {
  it('adds a destination by chat id, @username and t.me link, validating real membership', async () => {
    const s = await login(t, 'tg-dest', 'tg-dest@example.com');
    const botId = 100000 + ++botSeq; const token = tokenFor(botId);
    fake.addBot(token, { id: botId, username: 'dest_bot' });
    const bot = (await call(s, 'POST', '/telegram/bots', { token })).json();
    const pub = -1002000000000 - ++chatSeq, pub2 = -1002000000000 - ++chatSeq, byId = -1002000000000 - ++chatSeq;
    fake.addChat({ id: pub, type: 'supergroup', title: 'Public One', username: 'public_one' }, { [botId]: { status: 'member' } });
    fake.addChat({ id: pub2, type: 'channel', title: 'Public Two', username: 'public_two' }, { [botId]: { status: 'administrator', can_post_messages: true } });
    fake.addChat({ id: byId, type: 'group', title: 'Private Group' }, { [botId]: { status: 'administrator' } });

    const r1 = await call(s, 'POST', '/telegram/destinations', { botId: bot.id, chat: '@public_one' });
    const r2 = await call(s, 'POST', '/telegram/destinations', { botId: bot.id, chat: 'https://t.me/public_two' });
    const r3 = await call(s, 'POST', '/telegram/destinations', { botId: bot.id, chat: String(byId) });
    expect([r1.statusCode, r2.statusCode, r3.statusCode]).toEqual([201, 201, 201]);
    expect(r1.json()).toMatchObject({ title: 'Public One', type: 'supergroup', username: 'public_one', canSend: true, problem: null, isDefault: true, chatId: pub });
    expect(r2.json()).toMatchObject({ type: 'channel', canSend: true, isDefault: false });
    expect(r3.json()).toMatchObject({ type: 'group', canSend: true });
    expect(r1.json().permissions).toMatchObject({ status: 'member' });

    const dup = await call(s, 'POST', '/telegram/destinations', { botId: bot.id, chat: String(pub) });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('already_added');
  });

  it('stores a channel where the bot lacks posting rights as not ready, with the reason, and will not send to it', async () => {
    const c = await setup('chan', { type: 'channel', member: { status: 'administrator', can_post_messages: false } });
    expect(c.destRes.statusCode).toBe(201);
    expect(c.dest).toMatchObject({ canSend: false, isDefault: false });
    expect(c.dest.problem).toMatch(/Post messages/);
    const id = await addFile(c.s, 'x.txt', 'x');
    const r = await send(c, [id]);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('destination_not_ready');
    expect((await call(c.s, 'PATCH', `/telegram/destinations/${c.dest.id}`, { isDefault: true })).statusCode).toBe(409);

    fake.setMember(c.chatId, c.botId, { status: 'administrator', can_post_messages: true }); // user fixes it in Telegram
    const v = await call(c.s, 'POST', `/telegram/destinations/${c.dest.id}/validate`);
    expect(v.json()).toMatchObject({ canSend: true, problem: null });
    expect((await send(c, [id])).statusCode).toBe(201);
  });

  it('refuses private chats, unknown chats, chats the bot cannot see, and malformed references', async () => {
    const c = await setup('bad');
    const priv = -1003000000000 - ++chatSeq;
    fake.addChat({ id: priv, type: 'private', title: 'Someone' }, { [c.botId]: { status: 'member' } });
    const r1 = await call(c.s, 'POST', '/telegram/destinations', { botId: c.bot.id, chat: String(priv) });
    expect([r1.statusCode, r1.json().error.code]).toEqual([400, 'unsupported_chat']);
    const r2 = await call(c.s, 'POST', '/telegram/destinations', { botId: c.bot.id, chat: '-1009999999999' });
    expect([r2.statusCode, r2.json().error.code]).toEqual([400, 'chat_not_found']);
    const hidden = -1003000000000 - ++chatSeq;
    fake.addChat({ id: hidden, type: 'supergroup', title: 'Hidden' }); // exists, but the bot was never added
    const r3 = await call(c.s, 'POST', '/telegram/destinations', { botId: c.bot.id, chat: String(hidden) });
    expect([r3.statusCode, r3.json().error.code]).toEqual([400, 'chat_not_found']);
    expect((await call(c.s, 'POST', '/telegram/destinations', { botId: c.bot.id, chat: 'nope nope' })).json().error.code).toBe('invalid_chat');
  });

  it('first destination becomes the default; the default can be switched, one at a time', async () => {
    const c = await setup('def');
    const second = -1004000000000 - ++chatSeq;
    fake.addChat({ id: second, type: 'supergroup', title: 'Second' }, { [c.botId]: { status: 'member' } });
    const d2 = (await call(c.s, 'POST', '/telegram/destinations', { botId: c.bot.id, chat: String(second) })).json();
    expect([c.dest.isDefault, d2.isDefault]).toEqual([true, false]);
    expect((await call(c.s, 'PATCH', `/telegram/destinations/${d2.id}`, { isDefault: true })).json().isDefault).toBe(true);
    const list = (await call(c.s, 'GET', '/telegram/destinations')).json().destinations;
    expect(list.filter((d: { isDefault: boolean }) => d.isDefault).map((d: { id: string }) => d.id)).toEqual([d2.id]);
  });

  it('sends a real test message and returns a link (public chats link publicly)', async () => {
    const c = await setup('msg', { username: 'msg_public' });
    const r = await call(c.s, 'POST', `/telegram/destinations/${c.dest.id}/test`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, link: { url: expect.stringMatching(/^https:\/\/t\.me\/msg_public\/\d+$/), membersOnly: false } });
    expect(sentTo(c).filter((x) => x.method === 'sendMessage')).toHaveLength(1);
  });

  it('reports a failed test message and marks the destination unusable', async () => {
    const c = await setup('msgfail');
    fake.setMember(c.chatId, c.botId, { status: 'kicked' });
    const r = await call(c.s, 'POST', `/telegram/destinations/${c.dest.id}/test`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('not_a_member');
    expect((await call(c.s, 'GET', '/telegram/destinations')).json().destinations[0]).toMatchObject({ canSend: false });
  });

  it('cannot delete a destination with transfers in progress', async () => {
    const c = await setup('delbusy');
    const tr = (await send(c, [await addFile(c.s, 'a.txt', 'a')])).json();
    expect((await call(c.s, 'DELETE', `/telegram/destinations/${c.dest.id}`)).statusCode).toBe(409);
    await call(c.s, 'POST', `/telegram/transfers/${tr.id}/cancel`);
    expect((await call(c.s, 'DELETE', `/telegram/destinations/${c.dest.id}`)).statusCode).toBe(204);
    expect((await getTransfer(c.s, tr.id)).destination).toMatchObject({ id: null, title: 'delbusy chat' }); // history survives
  });
});

// =============================================================== sending
describe('sending files', () => {
  it('uploads the exact bytes with the original filename, caption on the first message only, and records the message', async () => {
    const c = await setup('single');
    const data = bytes(30000, 3);
    const names = ['Résumé – final (v2).pdf', 'second.txt', 'third.txt'];
    const ids = [await addFile(c.s, names[0]!, data), await addFile(c.s, names[1]!, 'two'), await addFile(c.s, names[2]!, 'three')];
    const tr = (await send(c, ids, { caption: 'Quarterly files' })).json();
    expect(tr).toMatchObject({ state: 'queued', caption: 'Quarterly files', counts: { total: 3, sent: 0 }, destination: { title: 'single chat' } });
    mkEngine().start();
    const done = await waitTransfer(c.s, tr.id, ['sent', 'failed', 'partial']);
    expect(done.state).toBe('sent');

    const s = sentTo(c);
    expect(s.map((x) => x.method)).toEqual(['sendDocument', 'sendDocument', 'sendDocument']);
    expect(s.map((x) => x.files[0]!.filename)).toEqual(names); // sent in order, names preserved including non-ASCII
    expect(s[0]!.files[0]).toMatchObject({ field: 'document', size: 30000, sha256: sha(data) });
    expect(s[0]!.fields.chat_id).toBe(String(c.chatId));
    expect(s[0]!.fields.caption).toBe('Quarterly files');
    expect(s[1]!.fields.caption).toBeUndefined();
    expect(s[2]!.fields.caption).toBeUndefined();

    expect(done.files.map((f: any) => f.messageId)).toEqual(s.map((x) => x.messageIds[0]));
    expect(done.files[0]).toMatchObject({ state: 'sent', percent: 100, bytesSent: 30000, link: { membersOnly: true } });
    expect(done.files[0].link.url).toMatch(/^https:\/\/t\.me\/c\/\d+\/\d+$/);
    expect(await noteKinds(c.s)).toContain('telegram_transfer_completed');
    const q = (await t.db.query<{ used_bytes: number }>('SELECT used_bytes FROM storage_quotas WHERE user_id = $1', [c.s.userId])).rows[0]!;
    expect(Number(q.used_bytes)).toBe(30000 + 3 + 5); // sending to Telegram never changes storage use
  });

  it('chooses photo / video / audio / document automatically, and "as file" forces documents', async () => {
    const c = await setup('auto');
    const files = ['a.jpg', 'b.mp4', 'c.mp3', 'd.zip', 'e.flac'];
    const ids: string[] = [];
    for (const [i, n] of files.entries()) ids.push(await addFile(c.s, n, bytes(2000 + i, i)));
    const tr = (await send(c, ids)).json();
    mkEngine().start();
    await waitTransfer(c.s, tr.id, ['sent']);
    expect(sentTo(c).map((x) => [x.method, x.files[0]!.field])).toEqual([
      ['sendPhoto', 'photo'], ['sendVideo', 'video'], ['sendAudio', 'audio'], ['sendDocument', 'document'], ['sendDocument', 'document'],
    ]);
    expect(sentTo(c)[1]!.fields.supports_streaming).toBe('true');

    const c2 = await setup('asfile');
    const tr2 = (await send(c2, [await addFile(c2.s, 'p.jpg', bytes(1500)), await addFile(c2.s, 'v.mp4', bytes(1600))], { method: 'document' })).json();
    await waitTransfer(c2.s, tr2.id, ['sent']);
    expect(sentTo(c2).map((x) => x.method)).toEqual(['sendDocument', 'sendDocument']);
  });

  it('falls back to sending as a document when Telegram rejects a photo (e.g. bad dimensions)', async () => {
    const c = await setup('photofb');
    const tr = (await send(c, [await addFile(c.s, 'badphoto.jpg', bytes(3000))])).json();
    mkEngine().start();
    const done = await waitTransfer(c.s, tr.id, ['sent', 'failed']);
    expect(done.state).toBe('sent');
    expect(done.files[0]).toMatchObject({ sendAs: 'document', state: 'sent', attempt: 0 });
    expect(sentTo(c).map((x) => x.method)).toEqual(['sendDocument']);
    expect(fake.calls.filter((x) => x.method === 'sendPhoto').length).toBeGreaterThanOrEqual(1);
  });

  it('sends albums with sendMediaGroup, caption on the first item, one message id per file; never mixes incompatible kinds', async () => {
    const c = await setup('album');
    const ids = [
      await addFile(c.s, '1.jpg', bytes(1000, 1)), await addFile(c.s, '2.jpg', bytes(1100, 2)), await addFile(c.s, '3.jpg', bytes(1200, 3)),
      await addFile(c.s, 'x.pdf', bytes(1300, 4)), await addFile(c.s, 'y.pdf', bytes(1400, 5)),
    ];
    const tr = (await send(c, ids, { album: true, caption: 'Holiday' })).json();
    mkEngine().start();
    const done = await waitTransfer(c.s, tr.id, ['sent', 'failed', 'partial']);
    expect(done.state).toBe('sent');
    const groups = sentTo(c);
    expect(groups.map((g) => g.method)).toEqual(['sendMediaGroup', 'sendMediaGroup']); // photos together, documents together
    const m1 = JSON.parse(groups[0]!.fields.media!);
    expect(m1.map((m: any) => m.type)).toEqual(['photo', 'photo', 'photo']);
    expect(m1[0].caption).toBe('Holiday');
    expect(m1[1].caption).toBeUndefined();
    expect(groups[0]!.files.map((f) => f.filename)).toEqual(['1.jpg', '2.jpg', '3.jpg']);
    expect(groups[0]!.files[2]!.sha256).toBe(sha(bytes(1200, 3)));
    expect(JSON.parse(groups[1]!.fields.media!).map((m: any) => m.type)).toEqual(['document', 'document']);
    const msgIds = done.files.map((f: any) => f.messageId);
    expect(new Set(msgIds).size).toBe(5);
    expect(msgIds.slice(0, 3)).toEqual(groups[0]!.messageIds);
  });

  it('explains an oversized file with alternatives, and sends it as numbered parts only when the user asks', async () => {
    const c = await setup('split');
    const data = bytes(450000, 9); // limit in this test environment is 200000
    const id = await addFile(c.s, 'big.bin', data);

    const preview = (await call(c.s, 'POST', '/telegram/transfers/preview', { destinationId: c.dest.id, fileIds: [id] })).json();
    expect(preview.issues[0]).toMatchObject({ code: 'file_too_large', name: 'big.bin' });
    expect(preview.issues[0].alternatives.map((a: any) => [a.kind, a.available])).toEqual([['split', true], ['share_link', true]]);

    const refused = await send(c, [id]);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toMatchObject({ code: 'transfer_not_possible', details: { issues: [{ code: 'file_too_large' }] } });
    expect((await call(c.s, 'GET', '/telegram/transfers')).json().transfers).toHaveLength(0); // nothing queued

    const p2 = (await call(c.s, 'POST', '/telegram/transfers/preview', { destinationId: c.dest.id, fileIds: [id], splitLargeFiles: true })).json();
    expect(p2.issues).toEqual([]);
    expect(p2.items.map((i: any) => [i.name, i.size])).toEqual([['big.bin.001', 180000], ['big.bin.002', 180000], ['big.bin.003', 90000]]);

    const tr = (await send(c, [id], { splitLargeFiles: true })).json();
    mkEngine().start();
    const done = await waitTransfer(c.s, tr.id, ['sent', 'failed', 'partial']);
    expect(done.state).toBe('sent');
    const s = sentTo(c);
    expect(s.map((x) => x.files[0]!.filename)).toEqual(['big.bin.001', 'big.bin.002', 'big.bin.003']);
    expect(s.map((x) => x.files[0]!.sha256)).toEqual([sha(data.subarray(0, 180000)), sha(data.subarray(180000, 360000)), sha(data.subarray(360000))]);
    expect(done.files.map((f: any) => [f.partIndex, f.partCount])).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it('validates input: captions, duplicates, missing/trashed files, empty files, and too many files', async () => {
    const c = await setup('valid');
    const id = await addFile(c.s, 'ok.txt', 'ok');
    expect((await send(c, [id], { caption: 'x'.repeat(1025) })).json().error.code).toBe('caption_too_long');
    expect((await send(c, [id, id])).json().error.code).toBe('duplicate_files');
    expect((await send(c, [randomUUIDLike()])).statusCode).toBe(404);
    expect((await send(c, [])).statusCode).toBe(400);
    expect((await send(c, Array.from({ length: 101 }, randomUUIDLike))).statusCode).toBe(400);
    const empty = await addFile(c.s, 'empty.txt', '');
    const r = await send(c, [empty]);
    expect([r.statusCode, r.json().error.details.issues[0].code]).toEqual([422, 'empty_file']);
    await call(c.s, 'DELETE', `/files/${id}`);
    expect((await send(c, [id])).statusCode).toBe(404);
  });

  it('paces sends into one chat (flood-limit spacing) and keeps transfers in order', async () => {
    const c = await setup('pace');
    const ids = [await addFile(c.s, 'p1.txt', 'one'), await addFile(c.s, 'p2.txt', 'two'), await addFile(c.s, 'p3.txt', 'three')];
    const first = (await send(c, ids.slice(0, 2))).json();
    const second = (await send(c, ids.slice(2))).json();
    mkEngine({ TELEGRAM_CHAT_INTERVAL_MS: 400, TELEGRAM_CONCURRENCY: 3 }).start();
    await waitTransfer(c.s, second.id, ['sent']);
    expect((await getTransfer(c.s, first.id)).state).toBe('sent');
    const s = sentTo(c);
    expect(s.map((x) => x.files[0]!.filename)).toEqual(['p1.txt', 'p2.txt', 'p3.txt']);
    // The interval counts from when Telegram answered; the fake stamps a request slightly before answering, so allow a little slack.
    for (let i = 1; i < s.length; i++) expect(s[i]!.at - s[i - 1]!.at, `gap ${i}`).toBeGreaterThanOrEqual(330);
  });

  it('handles Telegram rate limits: waits retry_after, does not burn attempts, then succeeds', async () => {
    const c = await setup('flood');
    fake.fail({ method: 'sendDocument', kind: 'status', status: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } });
    const tr = (await send(c, [await addFile(c.s, 'f.txt', 'flood')])).json();
    const base = fake.calls.length;
    const t0 = Date.now();
    mkEngine().start();
    const waiting = await waitFor(async () => { const f = (await fileRows(tr.id))[0]; return f.error_code === 'rate_limited' && f; }, 8000, 'rate_limited marker');
    expect(waiting).toMatchObject({ state: 'queued', attempt: 0 });
    const bot = (await t.db.query<{ blocked_until: string | null }>('SELECT blocked_until FROM telegram_bots WHERE id = $1', [c.bot.id])).rows[0]!;
    expect(bot.blocked_until).not.toBeNull();
    const done = await waitTransfer(c.s, tr.id, ['sent', 'failed']);
    expect(done.state).toBe('sent');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(fake.calls.slice(base).filter((x) => x.method === 'sendDocument')).toHaveLength(2); // one refused, one retry: not hammered
    expect((await fileRows(tr.id))[0]).toMatchObject({ attempt: 0, error_code: null });
  });

  it('follows a group that was upgraded to a supergroup (migrate_to_chat_id)', async () => {
    const c = await setup('migr', { type: 'group' });
    const newId = -1005000000000 - ++chatSeq;
    fake.addChat({ id: newId, type: 'supergroup', title: 'migr chat' }, { [c.botId]: { status: 'member' } });
    fake.fail({ method: 'sendDocument', kind: 'status', status: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: newId } });
    const tr = (await send(c, [await addFile(c.s, 'm.txt', 'migrated')])).json();
    mkEngine().start();
    expect((await waitTransfer(c.s, tr.id, ['sent', 'failed'])).state).toBe('sent');
    expect(fake.sent.filter((x) => x.chatId === newId)).toHaveLength(1);
    expect((await call(c.s, 'GET', '/telegram/destinations')).json().destinations[0]).toMatchObject({ chatId: newId, type: 'supergroup' });
  });

  it('keeps queued files when Telegram rejects the token, notifies, and resumes after the token is rotated', async () => {
    const c = await setup('revoked');
    fake.removeBot(c.token);
    const tr = (await send(c, [await addFile(c.s, 'k.txt', 'keep me'), await addFile(c.s, 'k2.txt', 'and me')])).json();
    mkEngine().start();
    await waitFor(async () => (await call(c.s, 'GET', '/telegram/bots')).json().bots[0].status === 'invalid', 8000, 'bot flagged invalid');
    expect(await noteKinds(c.s)).toContain('integration_disconnected');
    await sleep(200);
    const mid = await getTransfer(c.s, tr.id);
    expect(mid.state).toBe('queued'); // nothing lost, nothing failed
    expect(mid.bot.status).toBe('invalid');
    expect(mid.files.every((f: any) => f.state === 'queued' && f.attempt === 0)).toBe(true);

    const fresh = `${c.botId}:CCCC${'z'.repeat(16)}_renewed`;
    fake.addBot(fresh, { id: c.botId, username: c.bot.username });
    expect((await call(c.s, 'PUT', `/telegram/bots/${c.bot.id}/token`, { token: fresh })).statusCode).toBe(200);
    expect((await waitTransfer(c.s, tr.id, ['sent', 'failed'])).state).toBe('sent');
    expect(sentTo(c)).toHaveLength(2);
  });
});

// =============================================================== failures, honesty, retries
describe('failures are reported honestly', () => {
  const failing = async (name: string, f: Parameters<FakeTelegram['fail']>[0], over: Partial<Config> = {}) => {
    const c = await setup(name);
    fake.fail(f);
    const tr = (await send(c, [await addFile(c.s, `${name}.txt`, 'payload')])).json();
    mkEngine(over).start();
    const done = await waitTransfer(c.s, tr.id, ['failed', 'sent', 'partial']);
    return { c, tr, done, file: done.files[0] };
  };

  it('permission errors are permanent, explained, and mark the destination unusable', async () => {
    const c = await setup('perm');
    const id = await addFile(c.s, 'perm.txt', 'x');
    fake.setMember(c.chatId, c.botId, { status: 'kicked' }); // removed after the destination was added
    const tr = (await send(c, [id])).json();
    mkEngine().start();
    const done = await waitTransfer(c.s, tr.id, ['failed', 'sent']);
    expect(done.state).toBe('failed');
    expect(done.files[0]).toMatchObject({ state: 'failed', ambiguous: false, error: { code: 'no_permission' }, attempt: 1 });
    expect(done.files[0].error.message).toMatch(/not allowed to send/);
    expect(await noteKinds(c.s)).toContain('telegram_transfer_failed');
    const d = (await call(c.s, 'GET', '/telegram/destinations')).json().destinations[0];
    expect(d.canSend).toBe(false);
    expect(d.problem).toMatch(/not allowed/);
    expect((await send(c, [id])).json().error.code).toBe('destination_not_ready');

    // once the user fixes it in Telegram: revalidate, then retry the same transfer
    fake.setMember(c.chatId, c.botId, { status: 'member' });
    await call(c.s, 'POST', `/telegram/destinations/${c.dest.id}/validate`);
    const retried = await call(c.s, 'POST', `/telegram/transfers/${tr.id}/retry`, {});
    expect(retried.statusCode).toBe(200);
    expect((await waitTransfer(c.s, tr.id, ['sent', 'failed'])).state).toBe('sent');
  });

  it('chat-not-found, too-large and invalid-caption answers map to clear permanent errors', async () => {
    expect((await failing('nf', { method: 'sendDocument', kind: 'status', status: 400, description: 'Bad Request: chat not found' })).file.error.code).toBe('chat_not_found');
    expect((await failing('big', { method: 'sendDocument', kind: 'status', status: 413, description: 'Request Entity Too Large' })).file.error.code).toBe('file_too_large');
    const r = await failing('cap', { method: 'sendDocument', kind: 'status', status: 400, description: 'Bad Request: message caption is too long' });
    expect(r.file.error.code).toBe('invalid_caption');
    const un = await failing('un', { method: 'sendDocument', kind: 'status', status: 400, description: 'Bad Request: wrong file type' });
    expect(un.file).toMatchObject({ state: 'failed', ambiguous: false, error: { code: 'unsupported_media' } }); // already a document: nothing left to fall back to
  });

  it('a send whose outcome is unknown is NEVER retried automatically (no duplicate posts), only after explicit confirmation', async () => {
    const { c, tr, file } = await failing('ambig', { method: 'sendDocument', kind: 'reset-after-body' });
    expect(file).toMatchObject({ state: 'failed', ambiguous: true, error: { code: 'delivery_unknown' }, attempt: 1 });
    expect(file.error.message).toMatch(/Check the chat/);
    const callsAfter = fake.calls.length;
    await sleep(700);
    expect(fake.calls.length).toBe(callsAfter); // nothing at all reached Telegram again: the engine did not retry by itself
    expect(sentTo(c)).toHaveLength(0);

    const noConfirm = await call(c.s, 'POST', `/telegram/transfers/${tr.id}/retry`, {});
    expect(noConfirm.statusCode).toBe(409);
    expect(noConfirm.json().error).toMatchObject({ code: 'confirmation_required', details: { ambiguousFiles: 1 } });
    expect((await fileRows(tr.id))[0].state).toBe('failed');

    const yes = await call(c.s, 'POST', `/telegram/transfers/${tr.id}/retry`, { confirmDuplicateRisk: true });
    expect(yes.statusCode).toBe(200);
    expect((await waitTransfer(c.s, tr.id, ['sent', 'failed'])).state).toBe('sent');
    expect(sentTo(c)).toHaveLength(1);
  });

  it('treats a Telegram 5xx after the upload as unknown delivery, and a missing answer as unknown delivery', async () => {
    const a = await failing('five', { method: 'sendDocument', kind: 'status', status: 502, description: 'Bad Gateway' });
    expect(a.file).toMatchObject({ ambiguous: true, error: { code: 'delivery_unknown' } });
    const b = await failing('hang', { method: 'sendDocument', kind: 'hang-after-body' }, { TELEGRAM_RESPONSE_TIMEOUT_MS: 400 });
    expect(b.file).toMatchObject({ ambiguous: true, error: { code: 'delivery_unknown' } });
  });

  it('retries definite network failures (nothing was delivered) with backoff, then gives up without calling it ambiguous', async () => {
    const c = await setup('net');
    const tr = (await send(c, [await addFile(c.s, 'net.txt', 'x')])).json();
    const offline = mkEngine({ TELEGRAM_API_BASE: 'http://127.0.0.1:1' });
    offline.start();
    const done = await waitTransfer(c.s, tr.id, ['failed', 'sent'], 20000);
    await offline.stop(); // otherwise it would compete with the working engine below for the retried file
    expect(done.files[0]).toMatchObject({ state: 'failed', ambiguous: false, attempt: 3, error: { code: 'network_error' } });
    expect(done.files[0].error.message).toMatch(/giving up after 3 attempts/);
    expect(JSON.stringify(done)).not.toContain(c.token);
    expect(fake.sent.filter((x) => x.chatId === c.chatId)).toHaveLength(0);
    // the failure is retryable on request once the network is back
    const re = await call(c.s, 'POST', `/telegram/transfers/${tr.id}/retry`, {});
    expect(re.statusCode).toBe(200);
    mkEngine().start();
    expect((await waitTransfer(c.s, tr.id, ['sent'])).state).toBe('sent');
  });

  it('fails a file that was deleted before it could be sent, without contacting Telegram', async () => {
    const c = await setup('gone');
    const id = await addFile(c.s, 'gone.txt', 'bye');
    const tr = (await send(c, [id])).json();
    await call(c.s, 'DELETE', `/files/${id}`);
    mkEngine().start();
    const done = await waitTransfer(c.s, tr.id, ['failed', 'sent']);
    expect(done.files[0].error.code).toBe('source_missing');
    expect(sentTo(c)).toHaveLength(0);
  });

  it('partial transfers are reported as partial, and retry only resends what failed', async () => {
    const c = await setup('part');
    const ids = [await addFile(c.s, 'ok1.txt', 'one'), await addFile(c.s, 'gone.txt', 'two'), await addFile(c.s, 'ok3.txt', 'three')];
    const tr = (await send(c, ids)).json();
    await call(c.s, 'DELETE', `/files/${ids[1]}`);
    mkEngine().start();
    const done = await waitTransfer(c.s, tr.id, ['partial', 'failed', 'sent']);
    expect(done.state).toBe('partial');
    expect(done.counts).toMatchObject({ total: 3, sent: 2, failed: 1 });
    expect(sentTo(c).map((x) => x.files[0]!.filename)).toEqual(['ok1.txt', 'ok3.txt']);
    const nothing = await call(c.s, 'POST', `/telegram/transfers/${tr.id}/retry`, {});
    expect(nothing.statusCode).toBe(200); // re-queues only the failed file; the sent ones are untouched
    await waitTransfer(c.s, tr.id, ['partial', 'failed']);
    expect(sentTo(c)).toHaveLength(2); // still only the two originals: no duplicates of sent files
  });
});

// =============================================================== queue management
describe('cancel, retry, resend, delete', () => {
  it('cancels queued files; a second cancel is refused; uploading files cannot be recalled', async () => {
    const c = await setup('cancel');
    const tr = (await send(c, [await addFile(c.s, 'a.txt', 'a'), await addFile(c.s, 'b.txt', 'b')])).json();
    const r = await call(c.s, 'POST', `/telegram/transfers/${tr.id}/cancel`);
    expect(r.json()).toMatchObject({ state: 'cancelled', finishedAt: expect.any(String) });
    expect((await call(c.s, 'POST', `/telegram/transfers/${tr.id}/cancel`)).statusCode).toBe(409);
    mkEngine().start(); await sleep(300);
    expect(sentTo(c)).toHaveLength(0);

    const c2 = await setup('cancel2');
    const t2 = (await send(c2, [await addFile(c2.s, 'u.txt', 'u')])).json();
    await t.db.query(`UPDATE telegram_transfer_files SET state = 'uploading', worker_id = 'w', lease_expires_at = now() + interval '1 hour' WHERE transfer_id = $1`, [t2.id]);
    expect((await call(c2.s, 'POST', `/telegram/transfers/${t2.id}/cancel`)).statusCode).toBe(409);
  });

  it('resend creates a new transfer to the same destination and leaves the original untouched; refuses when sources are gone', async () => {
    const c = await setup('resend');
    const id = await addFile(c.s, 'again.txt', 'again');
    const tr = (await send(c, [id], { caption: 'cap' })).json();
    mkEngine().start();
    await waitTransfer(c.s, tr.id, ['sent']);
    const re = await call(c.s, 'POST', `/telegram/transfers/${tr.id}/resend`);
    expect(re.statusCode).toBe(201);
    expect(re.json().id).not.toBe(tr.id);
    expect(re.json()).toMatchObject({ caption: 'cap', destination: { id: c.dest.id } });
    await waitTransfer(c.s, re.json().id, ['sent']);
    expect(sentTo(c)).toHaveLength(2);
    expect((await getTransfer(c.s, tr.id)).state).toBe('sent');
    await call(c.s, 'DELETE', `/files/${id}`);
    const gone = await call(c.s, 'POST', `/telegram/transfers/${tr.id}/resend`);
    expect([gone.statusCode, gone.json().error.code]).toEqual([409, 'source_missing']);
  });

  it('removes finished transfers from history but not unfinished ones', async () => {
    const c = await setup('histdel');
    const tr = (await send(c, [await addFile(c.s, 'h.txt', 'h')])).json();
    expect((await call(c.s, 'DELETE', `/telegram/transfers/${tr.id}`)).statusCode).toBe(409);
    mkEngine().start();
    await waitTransfer(c.s, tr.id, ['sent']);
    expect((await call(c.s, 'DELETE', `/telegram/transfers/${tr.id}`)).statusCode).toBe(204);
    expect((await call(c.s, 'GET', `/telegram/transfers/${tr.id}`)).statusCode).toBe(404);
  });
});

// =============================================================== history
describe('transfer history', () => {
  it('lists, filters by state, searches by file name / destination / caption, and paginates', async () => {
    const c = await setup('hist');
    const names = ['alpha.txt', 'beta.txt', 'gamma.txt', 'delta.txt', 'epsilon.txt'];
    for (const [i, n] of names.entries()) await send(c, [await addFile(c.s, n, n)], { caption: i === 2 ? 'special caption' : undefined });
    mkEngine().start();
    await waitFor(async () => (await call(c.s, 'GET', '/telegram/transfers?state=sent')).json().transfers.length === 5, 20000, 'all sent');

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = (await call(c.s, 'GET', `/telegram/transfers?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).json();
      seen.push(...r.transfers.map((x: any) => x.firstFileName));
      cursor = r.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(names));
    expect(seen[0]).toBe('epsilon.txt'); // newest first

    const q = async (qs: string) => (await call(c.s, 'GET', `/telegram/transfers?${qs}`)).json().transfers.map((x: any) => x.firstFileName);
    expect(await q('q=gamma')).toEqual(['gamma.txt']);
    expect(await q('q=special')).toEqual(['gamma.txt']);
    expect(await q('q=hist%20chat')).toHaveLength(5);
    expect(await q('q=%25')).toEqual([]); // wildcard characters are literal
    expect(await q('state=failed')).toEqual([]);
    expect((await call(c.s, 'GET', '/telegram/transfers?cursor=garbage')).statusCode).toBe(400);
    expect((await call(c.s, 'GET', '/telegram/transfers?state=weird')).statusCode).toBe(400);
  });

  it('feeds the dashboard with real Telegram figures', async () => {
    const c = await setup('dash');
    const tr = (await send(c, [await addFile(c.s, 'd.txt', 'd')])).json();
    mkEngine().start();
    await waitTransfer(c.s, tr.id, ['sent']);
    const dash = (await call(c.s, 'GET', '/dashboard')).json();
    expect(dash.telegram).toMatchObject({ bots: 1, active: 0, failed: 0 });
    expect(dash.telegram.recent[0]).toMatchObject({ id: tr.id, state: 'sent', destination: 'dash chat', files: 1, firstFileName: 'd.txt' });
  });
});

// =============================================================== crash safety, progress, live updates
describe('recovery, shutdown and live progress', () => {
  /** Serves the stored file slowly so the upload body stays in flight for a measurable time. */
  const slow = (inner: StorageAdapter, chunk: number, delay: number): StorageAdapter => ({
    kind: inner.kind, put: inner.put.bind(inner), stat: inner.stat.bind(inner), delete: inner.delete.bind(inner), health: inner.health.bind(inner), list: inner.list.bind(inner),
    async get(key, range) {
      const src = await inner.get(key, range);
      return Readable.from((async function* () {
        for await (const buf of src as AsyncIterable<Buffer>) {
          for (let i = 0; i < buf.length; i += chunk) { yield buf.subarray(i, i + chunk); await sleep(delay); }
        }
      })());
    },
  });

  it('a worker that died mid-upload leaves the file as delivery-unknown instead of re-sending it', async () => {
    const c = await setup('crash');
    const tr = (await send(c, [await addFile(c.s, 'c.txt', 'crash')])).json();
    await t.db.query(`UPDATE telegram_transfer_files SET state = 'uploading', worker_id = 'dead', lease_expires_at = now() - interval '1 minute' WHERE transfer_id = $1`, [tr.id]);
    await t.db.query(`UPDATE telegram_transfers SET state = 'uploading' WHERE id = $1`, [tr.id]);
    expect(await mkEngine().recoverStale()).toBe(1);
    const after = await getTransfer(c.s, tr.id);
    expect(after.state).toBe('failed');
    expect(after.files[0]).toMatchObject({ state: 'failed', ambiguous: true, error: { code: 'delivery_unknown' } });
    expect(sentTo(c)).toHaveLength(0);
    expect(await noteKinds(c.s)).toContain('telegram_transfer_failed');
    // a lease that is still valid is left alone
    const c2 = await setup('alive');
    const t2 = (await send(c2, [await addFile(c2.s, 'a.txt', 'alive')])).json();
    await t.db.query(`UPDATE telegram_transfer_files SET state = 'uploading', worker_id = 'w', lease_expires_at = now() + interval '1 hour' WHERE transfer_id = $1`, [t2.id]);
    expect(await mkEngine().recoverStale()).toBe(0);
  });

  it('shutdown during the upload requeues the file untouched (nothing was delivered) and a new worker sends it exactly once', async () => {
    const c = await setup('shutdown');
    const tr = (await send(c, [await addFile(c.s, 's.bin', bytes(60000, 4))])).json();
    const first = mkEngine({}, slow(t.storage, 4000, 60));
    first.start();
    await waitFor(async () => (await fileRows(tr.id))[0].state === 'uploading', 8000, 'upload started');
    await first.stop();
    const mid = (await fileRows(tr.id))[0];
    expect(mid).toMatchObject({ state: 'queued', ambiguous: false, attempt: 0, worker_id: null });
    expect(sentTo(c)).toHaveLength(0);
    mkEngine().start();
    expect((await waitTransfer(c.s, tr.id, ['sent'])).state).toBe('sent');
    expect(sentTo(c)).toHaveLength(1);
  });

  it('shutdown after the file was fully sent waits for Telegram\'s answer instead of abandoning it', async () => {
    const c = await setup('graceful');
    fake.setLatency(600);
    const tr = (await send(c, [await addFile(c.s, 'g.txt', 'graceful')])).json();
    const base = fake.received.length;
    const e = mkEngine(); e.start();
    // wait until Telegram has the WHOLE file (not just the headers): only then is stop() required to wait for the answer
    await waitFor(async () => fake.received.slice(base).some((x) => x.method === 'sendDocument'), 15000, 'file fully received by Telegram');
    await e.stop();
    const f = (await fileRows(tr.id))[0];
    expect(f).toMatchObject({ state: 'sent', ambiguous: false });
    expect(sentTo(c)).toHaveLength(1);
  });

  it('reports per-file upload progress while the body is being sent', async () => {
    const c = await setup('progress');
    const tr = (await send(c, [await addFile(c.s, 'p.bin', bytes(60000, 6))])).json();
    mkEngine({}, slow(t.storage, 6000, 100)).start();
    const seen = await waitFor(async () => {
      const f = (await getTransfer(c.s, tr.id)).files[0];
      return f.state === 'uploading' && f.bytesSent > 0 && f.bytesSent < f.size ? f : false;
    }, 10000, 'mid-upload progress');
    expect(seen.percent).toBeGreaterThan(0);
    expect(seen.percent).toBeLessThan(100);
    expect((await waitTransfer(c.s, tr.id, ['sent'])).files[0]).toMatchObject({ percent: 100, bytesSent: 60000 });
  });

  it('streams live transfer updates to the owner only, with a per-user stream limit', async () => {
    const mine = await setup('sse');
    const other = await setup('sse-other');
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (t.app.server.address() as { port: number }).port;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/telegram/transfers/events`, { headers: { cookie: mine.s.cookie }, signal: ac.signal });
    expect([res.status, res.headers.get('content-type')]).toEqual([200, 'text/event-stream']);
    const events: any[] = [];
    const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) return;
          buf += dec.decode(value, { stream: true });
          let i; while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.+)$/m.exec(block)?.[1];
            if (ev && data) events.push({ ev, data: JSON.parse(data) });
          }
        }
      } catch { /* aborted */ }
    })();
    try {
      await waitFor(async () => events.some((e) => e.ev === 'ready'), 5000, 'ready');
      const a = (await send(mine, [await addFile(mine.s, 'live.bin', bytes(30000, 8))])).json();
      const b = (await send(other, [await addFile(other.s, 'theirs.txt', 'theirs')])).json();
      mkEngine().start();
      await waitFor(async () => events.some((e) => e.ev === 'transfer' && e.data.id === a.id && e.data.state === 'sent'), 20000, 'sent event');
      expect(events.some((e) => e.data?.id === b.id)).toBe(false);
      const last = events.filter((e) => e.data?.id === a.id).pop()!;
      expect(last.data.files[0]).toMatchObject({ name: 'live.bin', state: 'sent' });

      const extra: AbortController[] = [];
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) { const x = new AbortController(); extra.push(x); statuses.push((await fetch(`http://127.0.0.1:${port}/api/v1/telegram/transfers/events`, { headers: { cookie: mine.s.cookie }, signal: x.signal })).status); }
      expect(statuses).toEqual([200, 200, 200, 200, 429]); // 1 open + 4 more = the limit of 5
      extra.forEach((x) => x.abort());
    } finally { ac.abort(); await pump; }
  }, 60000);
});

// =============================================================== deployment modes
describe('deployment modes', () => {
  it('reports the limits of the configured Bot API deployment', async () => {
    const s = await login(t, 'tg-status', 'tg-status@example.com');
    const r = (await call(s, 'GET', '/telegram/status')).json();
    expect(r).toMatchObject({ enabled: true, mode: 'hosted', limits: { uploadBytes: 200000, photoBytes: 50000, captionChars: 1024, maxFiles: 100 } });
    expect(r.limits.partBytes).toBeLessThan(200000);
    expect(JSON.stringify(r)).not.toContain(fake.url); // the API base URL is not exposed
  });

  it('an unreachable Telegram API is a clear 502 that does not leak the token', async () => {
    const dead = await createTestEnv({ ENCRYPTION_KEY: ENC_KEY, TELEGRAM_API_BASE: 'http://127.0.0.1:1' });
    try {
      const s = await login(dead, 'dead-user', 'dead-user@example.com');
      const token = tokenFor(777777);
      const r = await dead.app.inject({ method: 'POST', url: '/api/v1/telegram/bots', headers: authed(s), payload: { token } });
      expect([r.statusCode, r.json().error.code]).toEqual([502, 'telegram_unreachable']);
      expect(r.body).not.toContain(token);
    } finally { await dead.close(); }
  });

  it('rate limits the endpoints that submit bot tokens', async () => {
    const lim = await createTestEnv({ ENCRYPTION_KEY: ENC_KEY, TELEGRAM_API_BASE: fake.url });
    try {
      const s = await login(lim, 'lim-user', 'lim-user@example.com');
      // a second app on the same database with a tight limit (login above would otherwise consume the budget)
      const { buildApp } = await import('../src/app.js');
      const tight = await buildApp({ config: { ...lim.config, AUTH_RATE_LIMIT_PER_MIN: 3 }, db: lim.db, storage: lim.storage, oidc: null });
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await tight.inject({ method: 'POST', url: '/api/v1/telegram/bots', headers: authed(s), payload: { token: tokenFor(555555) } })).statusCode);
      expect(codes).toEqual([400, 400, 400, 429, 429]); // unknown token x3, then throttled
      await tight.close();
    } finally { await lim.close(); }
  });

  it('can be disabled entirely: status says so and every other endpoint answers 503', async () => {
    const off = await createTestEnv({ ENCRYPTION_KEY: ENC_KEY, TELEGRAM_ENABLED: 'false' });
    try {
      const s = await login(off, 'off-user', 'off-user@example.com');
      const st = await off.app.inject({ method: 'GET', url: '/api/v1/telegram/status', headers: { cookie: s.cookie } });
      expect(st.json().enabled).toBe(false);
      const r = await off.app.inject({ method: 'GET', url: '/api/v1/telegram/bots', headers: { cookie: s.cookie } });
      expect([r.statusCode, r.json().error.code]).toEqual([503, 'telegram_disabled']);
    } finally { await off.close(); }
  });

  it('a self-hosted Bot API server raises the limit instead of the hosted 50 MB', async () => {
    const sh = await createTestEnv({ ENCRYPTION_KEY: ENC_KEY, TELEGRAM_API_MODE: 'self-hosted', TELEGRAM_API_BASE: fake.url });
    try {
      const s = await login(sh, 'sh-user', 'sh-user@example.com');
      const r = (await sh.app.inject({ method: 'GET', url: '/api/v1/telegram/status', headers: { cookie: s.cookie } })).json();
      expect(r).toMatchObject({ mode: 'self-hosted', limits: { uploadBytes: 2000 * 1024 * 1024 } });
    } finally { await sh.close(); }
  });
});

function randomUUIDLike() { return `${randomBytes(4).toString('hex')}-0000-4000-8000-${randomBytes(6).toString('hex')}`; }
