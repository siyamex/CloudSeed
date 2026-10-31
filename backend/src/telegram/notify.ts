import type { Config } from '../config.js';
import type { Vault } from '../crypto.js';
import type { Db } from '../db/index.js';
import { TelegramApiError, TelegramNetworkError, sendMessage } from './client.js';
import { botAad } from './engine.js';

export type NotifyOutcome =
  | { ok: true }
  | { ok: false; retry: boolean; retryAfterSeconds?: number; reason: string };

/**
 * Sends one text message to a user's own Telegram destination through that user's own bot.
 * The destination must belong to `userId`; nothing is sent for anyone else's chat. Errors never contain the bot token.
 */
export async function sendToDestination(o: { db: Db; vault: Vault; config: Config; userId: string; destinationId: string; text: string }): Promise<NotifyOutcome> {
  const d = (await o.db.query<{ chat_id: number; can_send: boolean; bot_id: string; tg_bot_id: number; token_enc: Buffer | null; status: string }>(
    `SELECT d.chat_id, d.can_send, b.id AS bot_id, b.tg_bot_id, b.token_enc, b.status
       FROM telegram_destinations d JOIN telegram_bots b ON b.id = d.bot_id WHERE d.id = $1 AND d.user_id = $2`, [o.destinationId, o.userId])).rows[0];
  if (!d) return { ok: false, retry: false, reason: 'The Telegram destination was removed.' };
  if (!d.token_enc || d.status !== 'active') return { ok: false, retry: false, reason: 'The Telegram bot is not connected.' };
  if (!d.can_send) return { ok: false, retry: false, reason: 'The bot is not allowed to post in that chat any more.' };
  let token: string;
  try { token = o.vault.decrypt(d.token_enc, botAad(o.userId, d.tg_bot_id)); } catch { return { ok: false, retry: false, reason: 'The saved bot token cannot be decrypted. Reconnect the bot.' }; }
  try {
    await sendMessage({ base: o.config.TELEGRAM_API_BASE, token }, Number(d.chat_id), o.text.slice(0, 4000));
    return { ok: true };
  } catch (e) {
    if (e instanceof TelegramApiError) {
      if (e.status === 429) return { ok: false, retry: true, retryAfterSeconds: e.retryAfter ?? 30, reason: 'Telegram asked us to slow down.' };
      if (e.status >= 500) return { ok: false, retry: true, reason: `Telegram had a problem (${e.status}).` };
      return { ok: false, retry: false, reason: `Telegram refused the message: ${e.description}` };
    }
    if (e instanceof TelegramNetworkError) return { ok: false, retry: true, reason: e.message };
    return { ok: false, retry: true, reason: 'Unexpected error while contacting Telegram.' };
  }
}
