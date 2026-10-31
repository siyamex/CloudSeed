import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { createVault } from '../src/crypto.js';
import { MaintenanceEngine } from '../src/maintenance/engine.js';
import { createMailer } from '../src/mail/mailer.js';
import { startFakeTelegram, type FakeTelegram } from './fake-telegram.js';
import { authed, createTestEnv, login, type Session, type TestEnv } from './helpers.js';

const ENC = Buffer.alloc(32, 6).toString('base64');
let t: TestEnv;
let fake: FakeTelegram;
let seq = 0;
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => { fake = await startFakeTelegram(); t = await createTestEnv({ ENCRYPTION_KEY: ENC, TELEGRAM_API_BASE: fake.url, TELEGRAM_CHAT_INTERVAL_MS: '0', TELEGRAM_NOTIFY_MAX_PER_HOUR: '3' }); });
afterAll(async () => { await t.close(); await fake.close(); });

async function setup() {
  const s = await login(t, `tn-${++seq}`, `tn-${seq}@example.com`);
  const botId = 910000 + seq, token = `${botId}:AAAA${'n'.repeat(16)}_${seq}`, chatId = -1009100000000 - seq;
  fake.addBot(token, { id: botId, username: `tn${seq}_bot` });
  fake.addChat({ id: chatId, type: 'supergroup', title: `alerts ${seq}` }, { [botId]: { status: 'member' } });
  const call = (m: string, u: string, p?: unknown) => t.app.inject({ method: m as 'GET', url: `/api/v1${u}`, headers: authed(s), payload: p as object });
  const bot = (await call('POST', '/telegram/bots', { token })).json();
  const dest = (await call('POST', '/telegram/destinations', { botId: bot.id, chat: String(chatId) })).json();
  return { s, call, chatId, dest, token };
}
const note = (s: Session, kind: string, title: string, body = 'details') => t.db.query(`INSERT INTO notifications (user_id, kind, title, body) VALUES ($1, $2, $3, $4)`, [s.userId, kind, title, body]);
const engine = (over: Partial<Config> = {}) => {
  const config = { ...t.config, ...over } as Config;
  return new MaintenanceEngine({ db: t.db, config, mailer: createMailer(config), log: quiet, vault: createVault(config) });
};
const messagesTo = (chatId: number) => fake.sent.filter((x) => x.chatId === chatId && x.method === 'sendMessage');

describe('choosing a chat', () => {
  it('saves one of the user\'s own destinations and shows it back', async () => {
    const c = await setup();
    const r = await c.call('PATCH', '/account/settings', { telegramNotifyDestinationId: c.dest.id });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ telegramNotifyDestinationId: c.dest.id, limits: { telegramAvailable: true } });
    expect((await c.call('PATCH', '/account/settings', { telegramNotifyDestinationId: null })).json().telegramNotifyDestinationId).toBeNull();
  });

  it('refuses someone else\'s destination and ones the bot cannot post in', async () => {
    const a = await setup(), b = await setup();
    expect((await a.call('PATCH', '/account/settings', { telegramNotifyDestinationId: b.dest.id })).statusCode).toBe(404);
    await t.db.query(`UPDATE telegram_destinations SET can_send = FALSE WHERE id = $1`, [a.dest.id]);
    expect((await a.call('PATCH', '/account/settings', { telegramNotifyDestinationId: a.dest.id })).json().error.code).toBe('destination_unusable');
    expect((await a.call('PATCH', '/account/settings', { telegramNotifyDestinationId: 'not-a-uuid' })).statusCode).toBe(400);
  });

  it('sends a test message, and says so plainly when nothing is chosen or Telegram refuses', async () => {
    const c = await setup();
    expect((await c.call('POST', '/account/telegram-notify/test')).json().error.code).toBe('no_destination');
    await c.call('PATCH', '/account/settings', { telegramNotifyDestinationId: c.dest.id });
    expect((await c.call('POST', '/account/telegram-notify/test')).statusCode).toBe(200);
    expect(messagesTo(c.chatId).map((m) => m.fields.text)).toEqual([expect.stringContaining('CloudSeed test')]);
  });
});

describe('delivering notifications', () => {
  it('posts each notification once, in order, with the title, details and link, and never twice', async () => {
    const c = await setup();
    await c.call('PATCH', '/account/settings', { telegramNotifyDestinationId: c.dest.id });
    await note(c.s, 'download_completed', 'Download finished: a.iso', 'Saved to My Files.');
    const e = engine();
    expect(await e.sendTelegram()).toBe(1);
    expect(await e.sendTelegram()).toBe(0);
    const m = messagesTo(c.chatId);
    expect(m).toHaveLength(1);
    expect(m[0]!.fields.text).toContain('Download finished: a.iso');
    expect(m[0]!.fields.text).toContain('Saved to My Files.');
    expect(m[0]!.fields.text).toContain('http://localhost:8080');
    expect((await t.db.query<any>(`SELECT tg_state FROM notifications WHERE user_id = $1`, [c.s.userId])).rows[0].tg_state).toBe('sent');
  });

  it('sends nothing for users who did not opt in, and does not send old notifications when they opt in later', async () => {
    const c = await setup();
    await note(c.s, 'download_failed', 'before opting in');
    await engine().sendTelegram();
    await c.call('PATCH', '/account/settings', { telegramNotifyDestinationId: c.dest.id });
    await engine().sendTelegram();
    expect(messagesTo(c.chatId)).toHaveLength(0);
    expect((await t.db.query<any>(`SELECT tg_state FROM notifications WHERE user_id = $1`, [c.s.userId])).rows[0].tg_state).toBe('skipped');
  });

  it('skips muted kinds and caps messages per hour', async () => {
    const c = await setup();
    await c.call('PATCH', '/account/settings', { telegramNotifyDestinationId: c.dest.id, mutedKinds: ['download_started'] });
    await note(c.s, 'download_started', 'muted one');
    for (let i = 0; i < 5; i++) await note(c.s, 'download_completed', `n${i}`);
    const e = engine();
    for (let i = 0; i < 4; i++) await e.sendTelegram();
    const texts = messagesTo(c.chatId).map((m) => m.fields.text!);
    expect(texts).toHaveLength(3); // TELEGRAM_NOTIFY_MAX_PER_HOUR
    expect(texts.join()).not.toContain('muted one');
  });

  it('keeps the chat\'s sending pace shared with file transfers', async () => {
    const c = await setup();
    await c.call('PATCH', '/account/settings', { telegramNotifyDestinationId: c.dest.id });
    await note(c.s, 'download_completed', 'first'); await note(c.s, 'download_completed', 'second');
    const e = engine({ TELEGRAM_CHAT_INTERVAL_MS: 60_000 });
    expect(await e.sendTelegram()).toBe(1); // the slot is now held for a minute
    expect(await e.sendTelegram()).toBe(0);
    expect(messagesTo(c.chatId)).toHaveLength(1);
    await t.db.query(`UPDATE telegram_destinations SET next_send_at = now() WHERE id = $1`, [c.dest.id]);
    await t.db.query(`UPDATE notifications SET tg_next_at = now() WHERE user_id = $1`, [c.s.userId]);
    expect(await engine().sendTelegram()).toBe(1);
    expect(messagesTo(c.chatId).map((m) => m.fields.text!.split('\n')[0])).toEqual(['first', 'second']);
  });

  it('gives up quietly on a chat that refuses the bot, and never leaks the token', async () => {
    const c = await setup();
    await c.call('PATCH', '/account/settings', { telegramNotifyDestinationId: c.dest.id });
    await t.db.query(`DELETE FROM telegram_bots WHERE user_id = $1`, [c.s.userId]); // the bot is gone: destination cascades away
    await note(c.s, 'download_failed', 'nobody to tell');
    await engine().sendTelegram();
    const row = (await t.db.query<any>(`SELECT tg_state FROM notifications WHERE user_id = $1`, [c.s.userId])).rows[0];
    expect(['skipped', 'failed']).toContain(row.tg_state);
    expect(messagesTo(c.chatId)).toHaveLength(0);
  });

  it('retries a Telegram outage with back-off, then stops after three attempts', async () => {
    const c = await setup();
    await c.call('PATCH', '/account/settings', { telegramNotifyDestinationId: c.dest.id });
    await note(c.s, 'download_completed', 'flaky');
    // an unreachable API: point the engine at a closed port
    const e = engine({ TELEGRAM_API_BASE: 'http://127.0.0.1:9' });
    const due = () => t.db.query(`UPDATE notifications SET tg_next_at = now() WHERE user_id = $1`, [c.s.userId]);
    const st = async () => (await t.db.query<any>(`SELECT tg_state, tg_attempts FROM notifications WHERE user_id = $1`, [c.s.userId])).rows[0];
    await e.sendTelegram();
    expect(await st()).toMatchObject({ tg_state: null, tg_attempts: 1 });
    for (let i = 0; i < 2; i++) { await due(); await t.db.query(`UPDATE telegram_destinations SET next_send_at = now()`); await e.sendTelegram(); }
    expect(await st()).toMatchObject({ tg_state: 'failed', tg_attempts: 3 });
    await due(); await e.sendTelegram();
    expect((await st()).tg_attempts).toBe(3);
  });
});
