import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, type Deps } from '../app.js';
import { telegramLimits } from '../config.js';
import type { Vault } from '../crypto.js';
import { HttpError, badRequest, conflict, notFound } from '../errors.js';
import { hashPassword } from '../auth/password.js';
import { sha256 } from '../auth/session.js';
import { createSse } from '../sse.js';
import { STATUS_SQL, newShareToken, shareUrl } from './shares.js';
import {
  TelegramApiError, TelegramNetworkError, getChat, getChatMember, getMe, sendMessage,
  type ApiConfig, type TgChat, type TgMember,
} from '../telegram/client.js';
import { botAad } from '../telegram/engine.js';
import { MAX_CAPTION, MAX_FILES_PER_TRANSFER, linkMessage, messageLink, planTransfer, type PlanIssue } from '../telegram/plan.js';
import { recomputeTransfer } from '../telegram/state.js';

const uuid = z.string().uuid();
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const MAX_OPEN_TRANSFERS = 50;

interface BotRow { id: string; tg_bot_id: number; username: string; display_name: string | null; status: string; last_checked_at: string | null; created_at: string; token_enc: Buffer | null }
const botDto = (b: BotRow) => ({ id: b.id, username: b.username, name: b.display_name, status: b.status, lastCheckedAt: b.last_checked_at, createdAt: b.created_at });

interface DestRow {
  id: string; bot_id: string; chat_id: number; username: string | null; title: string; chat_type: string; can_send: boolean;
  permissions: Record<string, unknown>; problem: string | null; is_default: boolean; checked_at: string | null; created_at: string; bot_username?: string; bot_status?: string;
}
const destDto = (d: DestRow) => ({
  id: d.id, botId: d.bot_id, botUsername: d.bot_username ?? null, botStatus: d.bot_status ?? null,
  chatId: Number(d.chat_id), username: d.username, title: d.title, type: d.chat_type,
  canSend: d.can_send && d.bot_status !== 'invalid' && d.bot_status !== 'disconnected', problem: d.problem, permissions: d.permissions,
  isDefault: d.is_default, checkedAt: d.checked_at, createdAt: d.created_at,
});

/** Works out whether the bot can post in the chat, from Telegram's own membership/permission data. */
export function evaluateAccess(chat: TgChat, m: TgMember): { canSend: boolean; problem: string | null; permissions: Record<string, unknown> } {
  const permissions: Record<string, unknown> = { status: m.status };
  for (const k of ['can_post_messages', 'can_send_messages', 'can_send_documents', 'can_send_photos', 'can_send_videos', 'can_send_audios'] as const) {
    if (m[k] !== undefined) permissions[k] = m[k];
  }
  const no = (problem: string) => ({ canSend: false, problem, permissions });
  if (m.status === 'left' || m.status === 'kicked') return no(m.status === 'kicked' ? 'The bot was removed (banned) from this chat.' : 'The bot is not a member of this chat. Add it first.');
  if (chat.type === 'channel') {
    if (m.status === 'creator' || (m.status === 'administrator' && m.can_post_messages)) return { canSend: true, problem: null, permissions };
    return no("In channels the bot must be an administrator with the 'Post messages' permission.");
  }
  if (m.status === 'restricted') {
    if (m.is_member === false) return no('The bot is not a member of this chat. Add it first.');
    const denied = (['can_send_messages', 'can_send_documents'] as const).filter((k) => m[k] === false);
    if (denied.length) return no(`The bot is restricted in this group (${denied.map((d) => d.replace('can_send_', 'cannot send ')).join(', ')}). Lift the restriction or make it an administrator.`);
  }
  return { canSend: true, problem: null, permissions };
}

/** Accepts @name, t.me/name links, bare usernames and numeric ids. */
export function parseChatRef(raw: string): string | number | null {
  const s = raw.trim().replace(/^(?:https?:\/\/)?(?:www\.)?t(?:elegram)?\.me\//i, '');
  if (/^-?\d{5,}$/.test(s)) return Number(s);
  const m = /^@?([A-Za-z][A-Za-z0-9_]{4,31})$/.exec(s);
  return m ? `@${m[1]}` : null;
}

export const telegramRoutes = (deps: Deps & { vault: Vault }): FastifyPluginAsync => async (app) => {
  const { db, config, vault } = deps;
  const limits = telegramLimits(config);
  // Endpoints that talk to Telegram with a user-supplied token share the sign-in abuse limit.
  const tokenLimit = { config: { rateLimit: { max: config.AUTH_RATE_LIMIT_PER_MIN, timeWindow: '1 minute' } } };
  const base = config.TELEGRAM_API_BASE;

  app.addHook('preHandler', async (req) => {
    if (!config.TELEGRAM_ENABLED && req.url.startsWith('/api/v1/telegram') && !req.url.startsWith('/api/v1/telegram/status')) {
      throw new HttpError(503, 'telegram_disabled', 'The Telegram integration is disabled on this server');
    }
  });

  const audit = (userId: string, action: string, target: string, ip?: string) =>
    db.query(`INSERT INTO audit_logs (user_id, action, target, ip) VALUES ($1, $2, $3, $4)`, [userId, action, target, ip ?? null]).catch(() => undefined);

  /** Converts Telegram failures into API errors a user can act on. */
  const tg = async <T>(fn: () => Promise<T>, onUnauthorized?: () => Promise<void>): Promise<T> => {
    try { return await fn(); } catch (e) {
      if (e instanceof TelegramApiError) {
        if (e.status === 401) { await onUnauthorized?.(); throw new HttpError(400, 'invalid_token', 'Telegram rejected the bot token. Check it with @BotFather.'); }
        if (e.status === 429) throw new HttpError(429, 'telegram_rate_limited', `Telegram is rate limiting this bot; try again in ${e.retryAfter ?? 'a few'} seconds`);
        if (/chat not found/i.test(e.description)) throw new HttpError(400, 'chat_not_found', 'Telegram cannot find that chat. The bot must already be a member; use the numeric chat ID for private groups and channels.');
        if (e.status === 403 || /not a member|kicked|forbidden|not enough rights/i.test(e.description)) throw new HttpError(400, 'not_a_member', 'The bot has no access to that chat. Add it as a member (or channel administrator) first.');
        throw new HttpError(502, 'telegram_error', `Telegram said: ${e.description}`);
      }
      if (e instanceof TelegramNetworkError) throw new HttpError(502, 'telegram_unreachable', 'Could not reach the Telegram API. Try again shortly.');
      throw e;
    }
  };

  async function ownedBot(userId: string, id: string): Promise<BotRow> {
    const r = await db.query<BotRow>(`SELECT * FROM telegram_bots WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (!r.rows[0]) throw notFound('Bot not found');
    return r.rows[0];
  }
  const apiFor = (userId: string, b: BotRow): ApiConfig => {
    if (!b.token_enc || b.status === 'disconnected') throw new HttpError(409, 'bot_disconnected', 'This bot is disconnected. Connect it again with its token.');
    try { return { base, token: vault.decrypt(b.token_enc, botAad(userId, b.tg_bot_id)) }; }
    catch { throw new HttpError(409, 'token_unreadable', 'The stored token cannot be decrypted. Reconnect the bot with a fresh token.'); }
  };
  const markInvalid = (id: string) => async () => { await db.query(`UPDATE telegram_bots SET status = 'invalid', updated_at = now() WHERE id = $1 AND status = 'active'`, [id]); };

  // ---------------------------------------------------------------- status
  app.get('/telegram/status', async (req) => {
    requireAuth(req);
    return {
      enabled: config.TELEGRAM_ENABLED, mode: limits.mode,
      limits: { uploadBytes: limits.upload, photoBytes: limits.photo, partBytes: limits.part, captionChars: MAX_CAPTION, maxFiles: MAX_FILES_PER_TRANSFER },
      sharing: { enabled: config.SHARING_ENABLED, maxDays: config.SHARING_MAX_DAYS },
    };
  });

  // ---------------------------------------------------------------- bots
  app.get('/telegram/bots', async (req) => {
    const a = requireAuth(req);
    const r = await db.query<BotRow>(`SELECT * FROM telegram_bots WHERE user_id = $1 ORDER BY created_at`, [a.userId]);
    return { bots: r.rows.map(botDto) };
  });

  app.post('/telegram/bots', tokenLimit, async (req, reply) => {
    const a = requireAuth(req);
    const { token } = z.object({ token: z.string().trim().regex(TOKEN_RE, 'That does not look like a bot token (expected 123456789:AA...)') }).parse(req.body);
    const me = await tg(() => getMe({ base, token }));
    if (!me.is_bot) throw badRequest('That token does not belong to a bot', 'not_a_bot');
    const existing = (await db.query<BotRow>(`SELECT * FROM telegram_bots WHERE user_id = $1 AND tg_bot_id = $2`, [a.userId, me.id])).rows[0];
    if (existing && existing.status === 'active') throw conflict('This bot is already connected. Use "Rotate token" to replace its token.', 'already_connected');
    const enc = vault.encrypt(token, botAad(a.userId, me.id));
    const row = existing
      ? (await db.query<BotRow>(`UPDATE telegram_bots SET token_enc = $2, status = 'active', username = $3, display_name = $4, blocked_until = NULL,
                last_checked_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [existing.id, enc, me.username ?? String(me.id), me.first_name])).rows[0]!
      : (await db.query<BotRow>(`INSERT INTO telegram_bots (user_id, tg_bot_id, username, display_name, token_enc, last_checked_at)
                VALUES ($1, $2, $3, $4, $5, now()) RETURNING *`, [a.userId, me.id, me.username ?? String(me.id), me.first_name, enc])).rows[0]!;
    await audit(a.userId, 'telegram.bot_connected', `bot:${me.id}`, req.ip);
    return reply.status(201).send(botDto(row));
  });

  /** Replaces the token of an existing bot (e.g. after revoking it in BotFather). Must be the same bot. */
  app.put('/telegram/bots/:id/token', tokenLimit, async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { token } = z.object({ token: z.string().trim().regex(TOKEN_RE, 'That does not look like a bot token') }).parse(req.body);
    const bot = await ownedBot(a.userId, id);
    if (bot.status === 'disconnected') throw conflict('This bot is disconnected. Connect it again instead.', 'bot_disconnected');
    const me = await tg(() => getMe({ base, token }));
    if (me.id !== Number(bot.tg_bot_id)) throw badRequest('That token belongs to a different bot', 'different_bot');
    const row = (await db.query<BotRow>(
      `UPDATE telegram_bots SET token_enc = $2, status = 'active', blocked_until = NULL, last_checked_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [id, vault.encrypt(token, botAad(a.userId, me.id))])).rows[0]!;
    await audit(a.userId, 'telegram.bot_token_rotated', `bot:${me.id}`, req.ip);
    return botDto(row);
  });

  /** Connection test: asks Telegram who this token is right now. */
  app.post('/telegram/bots/:id/test', tokenLimit, async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const bot = await ownedBot(a.userId, id);
    const me = await tg(() => getMe(apiFor(a.userId, bot)), markInvalid(id));
    const row = (await db.query<BotRow>(`UPDATE telegram_bots SET status = 'active', username = $2, display_name = $3, last_checked_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [id, me.username ?? bot.username, me.first_name])).rows[0]!;
    return { ok: true, bot: botDto(row) };
  });

  /** Disconnect: the token is erased; history is kept; queued files are cancelled. */
  app.delete('/telegram/bots/:id', async (req, reply) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const bot = await ownedBot(a.userId, id);
    const affected = await db.tx(async (t) => {
      await t.query(`UPDATE telegram_bots SET token_enc = NULL, status = 'disconnected', updated_at = now() WHERE id = $1`, [id]);
      await t.query(`UPDATE telegram_destinations SET can_send = FALSE, problem = 'The bot is disconnected', is_default = FALSE WHERE bot_id = $1`, [id]);
      const r = await t.query<{ transfer_id: string }>(
        `UPDATE telegram_transfer_files f SET state = 'cancelled', error_code = 'bot_disconnected', error_message = 'The bot was disconnected', updated_at = now()
           FROM telegram_transfers tr WHERE f.transfer_id = tr.id AND tr.bot_id = $1 AND f.state = 'queued' RETURNING f.transfer_id`, [id]);
      return [...new Set(r.rows.map((x) => x.transfer_id))];
    });
    for (const tid of affected) await recomputeTransfer(db, tid);
    await db.query(`INSERT INTO notifications (user_id, kind, title, body) VALUES ($1, 'integration_disconnected', 'Telegram bot disconnected', $2)`, [a.userId, `@${bot.username} was disconnected`]);
    await audit(a.userId, 'telegram.bot_disconnected', `bot:${bot.tg_bot_id}`, req.ip);
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- destinations
  const destSql = `SELECT d.*, b.username AS bot_username, b.status AS bot_status FROM telegram_destinations d JOIN telegram_bots b ON b.id = d.bot_id`;
  async function ownedDest(userId: string, id: string): Promise<DestRow> {
    const r = await db.query<DestRow>(`${destSql} WHERE d.id = $1 AND d.user_id = $2`, [id, userId]);
    if (!r.rows[0]) throw notFound('Destination not found');
    return r.rows[0];
  }

  /** Resolves the chat and checks the bot's real membership/permissions. */
  async function inspect(api: ApiConfig, botTgId: number, ref: string | number, onUnauthorized: () => Promise<void>) {
    const chat = await tg(() => getChat(api, ref), onUnauthorized);
    if (chat.type === 'private') throw badRequest('Only groups, supergroups and channels are supported as destinations', 'unsupported_chat');
    const member = await tg(() => getChatMember(api, chat.id, botTgId), onUnauthorized);
    return { chat, ...evaluateAccess(chat, member) };
  }

  app.get('/telegram/destinations', async (req) => {
    const a = requireAuth(req);
    const r = await db.query<DestRow>(`${destSql} WHERE d.user_id = $1 ORDER BY d.is_default DESC, lower(d.title)`, [a.userId]);
    return { destinations: r.rows.map(destDto) };
  });

  app.post('/telegram/destinations', async (req, reply) => {
    const a = requireAuth(req);
    const b = z.object({ botId: uuid, chat: z.string().min(1).max(200) }).parse(req.body);
    const ref = parseChatRef(b.chat);
    if (ref === null) throw badRequest('Enter a chat ID (e.g. -1001234567890), an @username or a t.me link', 'invalid_chat');
    const bot = await ownedBot(a.userId, b.botId);
    const api = apiFor(a.userId, bot);
    const r = await inspect(api, Number(bot.tg_bot_id), ref, markInvalid(bot.id));
    const type = r.chat.type as 'group' | 'supergroup' | 'channel';
    const dup = await db.query(`SELECT 1 FROM telegram_destinations WHERE bot_id = $1 AND chat_id = $2`, [bot.id, r.chat.id]);
    if (dup.rowCount > 0) throw conflict('That chat is already added for this bot', 'already_added');
    const hasDefault = (await db.query(`SELECT 1 FROM telegram_destinations WHERE user_id = $1 AND is_default`, [a.userId])).rowCount > 0;
    const ins = await db.query<{ id: string }>(
      `INSERT INTO telegram_destinations (user_id, bot_id, chat_id, username, title, chat_type, can_send, permissions, problem, is_default, checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now()) RETURNING id`,
      [a.userId, bot.id, r.chat.id, r.chat.username ?? null, r.chat.title ?? r.chat.username ?? String(r.chat.id), type, r.canSend, JSON.stringify(r.permissions), r.problem, !hasDefault && r.canSend]);
    await audit(a.userId, 'telegram.destination_added', `chat:${r.chat.id}`, req.ip);
    return reply.status(201).send(destDto(await ownedDest(a.userId, ins.rows[0]!.id)));
  });

  app.post('/telegram/destinations/:id/validate', async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = await ownedDest(a.userId, id);
    const bot = await ownedBot(a.userId, d.bot_id);
    const r = await inspect(apiFor(a.userId, bot), Number(bot.tg_bot_id), Number(d.chat_id), markInvalid(bot.id));
    await db.query(`UPDATE telegram_destinations SET title = $2, username = $3, chat_type = $4, can_send = $5, permissions = $6, problem = $7, checked_at = now() WHERE id = $1`,
      [id, r.chat.title ?? d.title, r.chat.username ?? null, r.chat.type, r.canSend, JSON.stringify(r.permissions), r.problem]);
    return destDto(await ownedDest(a.userId, id));
  });

  /** Sends a short message to prove the bot can really post there. */
  app.post('/telegram/destinations/:id/test', tokenLimit, async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const d = await ownedDest(a.userId, id);
    const bot = await ownedBot(a.userId, d.bot_id);
    const api = apiFor(a.userId, bot);
    try {
      const m = await tg(() => sendMessage(api, Number(d.chat_id), 'CloudSeed test message: this chat is connected.'), markInvalid(bot.id));
      await db.query(`UPDATE telegram_destinations SET can_send = TRUE, problem = NULL, checked_at = now(), next_send_at = GREATEST(next_send_at, now() + make_interval(secs => $2)) WHERE id = $1`,
        [id, config.TELEGRAM_CHAT_INTERVAL_MS / 1000]);
      return { ok: true, messageId: m.message_id, link: messageLink({ chatId: Number(d.chat_id), username: d.username, type: d.chat_type }, m.message_id) };
    } catch (e) {
      if (e instanceof HttpError && (e.code === 'not_a_member' || e.code === 'chat_not_found')) {
        await db.query(`UPDATE telegram_destinations SET can_send = FALSE, problem = $2, checked_at = now() WHERE id = $1`, [id, e.message]);
      }
      throw e;
    }
  });

  app.patch('/telegram/destinations/:id', async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ isDefault: z.literal(true) }).parse(req.body);
    void b;
    const d = await ownedDest(a.userId, id);
    if (!d.can_send) throw conflict('A destination the bot cannot post to cannot be the default', 'destination_not_ready');
    await db.tx(async (t) => {
      await t.query(`UPDATE telegram_destinations SET is_default = FALSE WHERE user_id = $1 AND is_default`, [a.userId]);
      await t.query(`UPDATE telegram_destinations SET is_default = TRUE WHERE id = $1`, [id]);
    });
    return destDto(await ownedDest(a.userId, id));
  });

  app.delete('/telegram/destinations/:id', async (req, reply) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await ownedDest(a.userId, id);
    const busy = await db.query(`SELECT 1 FROM telegram_transfers WHERE destination_id = $1 AND state IN ('queued','uploading')`, [id]);
    if (busy.rowCount > 0) throw conflict('This destination has transfers in progress. Cancel them first.', 'destination_busy');
    await db.query(`DELETE FROM telegram_destinations WHERE id = $1`, [id]);
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- transfers: planning + creation
  const planBody = z.object({
    destinationId: uuid,
    fileIds: z.array(uuid).min(1).max(MAX_FILES_PER_TRANSFER),
    caption: z.string().max(5000).nullish(),
    method: z.enum(['auto', 'document']).default('auto'),
    album: z.boolean().default(false),
    splitLargeFiles: z.boolean().default(false),
    /** Send a message with a CloudSeed download link for files over Telegram's limit (needs `shareLink`). */
    linkLargeFiles: z.boolean().default(false),
    shareLink: z.object({
      expiresInHours: z.number().int().min(1).max(config.SHARING_MAX_DAYS * 24),
      maxDownloads: z.number().int().min(1).max(1_000_000).nullish(),
      password: z.string().min(8).max(200).nullish(),
      /** Anyone who sees the link in the chat can download the file; the caller must confirm they understand. */
      confirmPublic: z.literal(true),
    }).optional(),
  });

  async function prepare(userId: string, raw: unknown) {
    const b = planBody.parse(raw);
    if (new Set(b.fileIds).size !== b.fileIds.length) throw badRequest('The same file was selected twice', 'duplicate_files');
    if (b.caption && b.caption.length > MAX_CAPTION) throw badRequest(`Caption is ${b.caption.length} characters; Telegram allows up to ${MAX_CAPTION}`, 'caption_too_long');
    const dest = await ownedDest(userId, b.destinationId);
    const rows = (await db.query<{ id: string; name: string; size_bytes: number; mime_type: string }>(
      `SELECT id, name, size_bytes, mime_type FROM files WHERE user_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL AND status = 'ready'`, [userId, b.fileIds])).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    if (byId.size !== b.fileIds.length) throw notFound('One or more files were not found');
    const files = b.fileIds.map((id) => { const f = byId.get(id)!; return { id, name: f.name, size: Number(f.size_bytes), mime: f.mime_type }; });
    if (b.splitLargeFiles && b.linkLargeFiles) throw badRequest('Choose either splitting large files or sending a link, not both', 'conflicting_options');
    const plan = planTransfer(files, { method: b.method, album: b.album, split: b.splitLargeFiles, link: b.linkLargeFiles, sharingEnabled: config.SHARING_ENABLED, limits });
    return { b, dest, files, plan };
  }

  const planDto = (p: ReturnType<typeof planTransfer>) => ({
    items: p.items.map((i) => ({ fileId: i.fileId, name: i.name, size: i.size, sendAs: i.sendAs, partIndex: i.partIndex, partCount: i.partCount, album: i.albumKey !== null })),
    messages: new Set(p.items.map((i) => i.albumKey ?? randomUUID())).size,
    totalBytes: p.items.reduce((n, i) => n + i.size, 0),
    issues: p.issues,
  });

  /** Review step: what would be sent, how, and what cannot be sent as chosen (with alternatives). */
  app.post('/telegram/transfers/preview', async (req) => {
    const a = requireAuth(req);
    const { dest, plan } = await prepare(a.userId, req.body);
    return { ...planDto(plan), destination: { id: dest.id, title: dest.title, canSend: destDto(dest).canSend, problem: dest.problem }, limits: { uploadBytes: limits.upload, photoBytes: limits.photo } };
  });

  app.post('/telegram/transfers', async (req, reply) => {
    const a = requireAuth(req);
    const { b, dest, plan } = await prepare(a.userId, req.body);
    const d = destDto(dest);
    if (!d.canSend) throw conflict(dest.problem ?? 'The bot cannot post to this destination. Revalidate it first.', 'destination_not_ready');
    if (plan.issues.length) {
      const first = plan.issues[0] as PlanIssue;
      throw new HttpError(422, 'transfer_not_possible', plan.issues.length === 1 ? first.message : `${plan.issues.length} files cannot be sent as chosen`, { issues: plan.issues });
    }
    const open = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM telegram_transfers WHERE user_id = $1 AND state IN ('queued','uploading')`, [a.userId])).rows[0]!.n;
    if (open >= MAX_OPEN_TRANSFERS) throw new HttpError(429, 'too_many_transfers', 'You have too many unfinished Telegram transfers. Wait for some to finish.');

    // Large files sent as a link: one share link per file, created in the same transaction as the transfer.
    const linkItems = plan.items.filter((i) => i.sendAs === 'link');
    if (linkItems.length) {
      if (!b.shareLink) throw new HttpError(422, 'share_link_required', 'Choose how long the download link should work, and confirm that anyone with it can download the file', { files: linkItems.map((i) => i.name) });
      const blocked = (await db.query<{ name: string }>(`SELECT name FROM files WHERE user_id = $1 AND id = ANY($2::uuid[]) AND sharing_disabled`, [a.userId, linkItems.map((i) => i.fileId)])).rows;
      if (blocked.length) throw conflict(`Sharing is turned off for ${blocked.map((x) => x.name).join(', ')}`, 'file_sharing_disabled');
      const active = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM shared_links s WHERE s.user_id = $1 AND ${STATUS_SQL} = 'active'`, [a.userId])).rows[0]!.n;
      if (active + linkItems.length > config.SHARING_MAX_ACTIVE_PER_USER) throw new HttpError(429, 'too_many_shares', 'That would exceed your limit of active share links. Revoke some first.');
    }
    const passwordHash = linkItems.length && b.shareLink?.password ? await hashPassword(b.shareLink.password) : null;
    const id = await db.tx(async (t) => {
      const tr = (await t.query<{ id: string }>(
        `INSERT INTO telegram_transfers (user_id, bot_id, destination_id, bot_username, destination_title, destination_chat_id, destination_username, destination_type, caption, method, album)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [a.userId, dest.bot_id, dest.id, dest.bot_username, dest.title, dest.chat_id, dest.username, dest.chat_type, b.caption || null, b.method, b.album])).rows[0]!;
      let pos = 0;
      for (const i of plan.items) {
        let caption = pos === 0 ? (b.caption || null) : null;
        let shareId: string | null = null;
        if (i.sendAs === 'link' && b.shareLink) {
          const token = newShareToken();
          const sh = (await t.query<{ id: string; expires_at: string }>(
            `INSERT INTO shared_links (user_id, file_id, token_hash, label, mode, expires_at, max_downloads, password_hash)
             VALUES ($1, $2, $3, $4, 'public', now() + make_interval(hours => $5), $6, $7) RETURNING id, expires_at`,
            [a.userId, i.fileId, sha256(token), `Telegram: ${dest.title}`.slice(0, 100), b.shareLink.expiresInHours, b.shareLink.maxDownloads ?? null, passwordHash])).rows[0]!;
          shareId = sh.id;
          caption = linkMessage({ name: i.name, size: i.size, url: shareUrl(config.PUBLIC_URL, token), expiresAt: new Date(sh.expires_at), maxDownloads: b.shareLink.maxDownloads ?? null, passwordProtected: !!passwordHash, intro: caption });
          await t.query(`INSERT INTO audit_logs (user_id, action, target, ip) VALUES ($1, 'share.created', $2, $3)`, [a.userId, `share:${sh.id}`, req.ip]);
        }
        await t.query(
          `INSERT INTO telegram_transfer_files (transfer_id, user_id, position, file_id, name, size_bytes, mime_type, part_offset, part_index, part_count, send_as, album_key, caption, share_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [tr.id, a.userId, pos, i.fileId, i.name, i.size, i.mime, i.offset, i.partIndex, i.partCount, i.sendAs, i.albumKey, caption, shareId]);
        pos++;
      }
      return tr.id;
    });
    return reply.status(201).send((await loadTransfers(a.userId, [id], true))[0]);
  });

  // ---------------------------------------------------------------- transfers: reading
  interface TransferRow {
    id: string; state: string; caption: string | null; method: string; album: boolean; bot_id: string | null; destination_id: string | null; bot_username: string | null;
    bot_status: string | null; destination_title: string; destination_chat_id: number; destination_username: string | null; destination_type: string;
    created_at: string; updated_at: string; finished_at: string | null; total: number; sent: number; failed: number; bytes: number; first_name: string | null; created_raw: string;
  }
  interface FileRowDb {
    id: string; transfer_id: string; position: number; name: string; size_bytes: number; send_as: string; state: string; bytes_sent: number; message_id: number | null;
    ambiguous: boolean; error_code: string | null; error_message: string | null; part_index: number | null; part_count: number | null; attempt: number;
    next_attempt_at: string; sent_at: string | null; album_key: string | null;
  }
  const SUMMARY = `SELECT t.id, t.state, t.caption, t.method, t.album, t.bot_id, t.destination_id, t.bot_username, b.status AS bot_status, t.destination_title,
      t.destination_chat_id, t.destination_username, t.destination_type, t.created_at, t.finished_at, t.created_at::text AS created_raw,
      GREATEST(t.updated_at, s.max_upd)::text AS updated_at, s.total, s.sent, s.failed, s.bytes, s.first_name
    FROM telegram_transfers t LEFT JOIN telegram_bots b ON b.id = t.bot_id
    LEFT JOIN LATERAL (SELECT count(*)::int AS total, count(*) FILTER (WHERE state = 'sent')::int AS sent, count(*) FILTER (WHERE state = 'failed')::int AS failed,
        COALESCE(sum(size_bytes), 0)::bigint AS bytes, min(name) FILTER (WHERE position = 0) AS first_name, max(updated_at) AS max_upd
        FROM telegram_transfer_files WHERE transfer_id = t.id) s ON TRUE`;

  const fileDto = (f: FileRowDb, t: TransferRow) => ({
    id: f.id, position: f.position, name: f.name, size: Number(f.size_bytes), sendAs: f.send_as, state: f.state,
    bytesSent: Number(f.bytes_sent), percent: f.state === 'sent' ? 100 : Number(f.size_bytes) > 0 ? Math.min(100, Math.round((Number(f.bytes_sent) / Number(f.size_bytes)) * 1000) / 10) : null,
    messageId: f.message_id === null ? null : Number(f.message_id),
    link: messageLink({ chatId: Number(t.destination_chat_id), username: t.destination_username, type: t.destination_type }, f.message_id === null ? null : Number(f.message_id)),
    ambiguous: f.ambiguous, error: f.error_code ? { code: f.error_code, message: f.error_message } : null,
    partIndex: f.part_index, partCount: f.part_count, album: f.album_key !== null, attempt: f.attempt,
    nextAttemptAt: f.state === 'queued' && f.error_code === 'rate_limited' || f.state === 'queued' && f.attempt > 0 ? f.next_attempt_at : null, sentAt: f.sent_at,
  });

  const transferDto = (t: TransferRow, files?: ReturnType<typeof fileDto>[]) => ({
    id: t.id, state: t.state, caption: t.caption, method: t.method, album: t.album,
    bot: { id: t.bot_id, username: t.bot_username, status: t.bot_status },
    destination: { id: t.destination_id, title: t.destination_title, type: t.destination_type, username: t.destination_username },
    counts: { total: t.total, sent: t.sent, failed: t.failed }, totalBytes: Number(t.bytes), firstFileName: t.first_name,
    createdAt: t.created_at, updatedAt: t.updated_at, finishedAt: t.finished_at, ...(files ? { files } : {}),
  });

  async function loadTransfers(userId: string, ids: string[], withFiles: boolean) {
    const rows = (await db.query<TransferRow>(`${SUMMARY} WHERE t.user_id = $1 AND t.id = ANY($2::uuid[]) ORDER BY t.created_at DESC, t.id DESC`, [userId, ids])).rows;
    if (!withFiles) return rows.map((t) => transferDto(t));
    const files = (await db.query<FileRowDb>(
      `SELECT id, transfer_id, position, name, size_bytes, send_as, state, bytes_sent, message_id, ambiguous, error_code, error_message, part_index, part_count, attempt,
              next_attempt_at, sent_at, album_key FROM telegram_transfer_files WHERE user_id = $1 AND transfer_id = ANY($2::uuid[]) ORDER BY position`, [userId, ids])).rows;
    return rows.map((t) => transferDto(t, files.filter((f) => f.transfer_id === t.id).map((f) => fileDto(f, t))));
  }

  app.get('/telegram/transfers', async (req) => {
    const a = requireAuth(req);
    const q = z.object({
      state: z.enum(['queued', 'uploading', 'sent', 'partial', 'failed', 'cancelled']).optional(),
      q: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      cursor: z.string().max(300).optional(),
    }).parse(req.query);
    const params: unknown[] = [a.userId];
    const where = ['t.user_id = $1'];
    if (q.state) { params.push(q.state); where.push(`t.state = $${params.length}`); }
    if (q.q) {
      params.push(`%${q.q.replace(/[\\%_]/g, '\\$&')}%`);
      const n = params.length;
      where.push(`(t.destination_title ILIKE $${n} OR t.caption ILIKE $${n} OR EXISTS (SELECT 1 FROM telegram_transfer_files f WHERE f.transfer_id = t.id AND f.name ILIKE $${n}))`);
    }
    if (q.cursor) {
      let c: { t: string; id: string };
      try { c = z.object({ t: z.string(), id: uuid }).parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString())); }
      catch { throw badRequest('Invalid cursor', 'invalid_cursor'); }
      params.push(c.t, c.id);
      where.push(`(t.created_at::text, t.id) < ($${params.length - 1}, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    const rows = (await db.query<TransferRow>(`${SUMMARY} WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC, t.id DESC LIMIT $${params.length}`, params)).rows;
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      transfers: page.map((t) => transferDto(t)),
      nextCursor: rows.length > q.limit && last ? Buffer.from(JSON.stringify({ t: last.created_raw, id: last.id })).toString('base64url') : null,
    };
  });

  const stream = createSse(app);
  app.get('/telegram/transfers/events', async (req, reply) => {
    const a = requireAuth(req);
    await stream(req, reply, {
      userId: a.userId, eventName: 'transfer',
      now: async () => (await db.query<{ t: string }>(`SELECT (now() - interval '2 seconds')::text AS t`)).rows[0]!.t,
      fetch: async (since) => {
        const rows = (await db.query<{ id: string; updated_at: string }>(
          `SELECT id, updated_at FROM (${SUMMARY} WHERE t.user_id = $1) x WHERE updated_at::timestamptz > $2::timestamptz ORDER BY updated_at LIMIT 100`, [a.userId, since])).rows;
        if (rows.length === 0) return [];
        const dtos = await loadTransfers(a.userId, rows.map((r) => r.id), true);
        return rows.map((r) => ({ id: r.id, updated_at: r.updated_at, dto: dtos.find((d) => d.id === r.id) }));
      },
      toEvent: (r) => r.dto,
    });
  });

  app.get('/telegram/transfers/:id', async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const t = (await loadTransfers(a.userId, [id], true))[0];
    if (!t) throw notFound('Transfer not found');
    return t;
  });

  // ---------------------------------------------------------------- transfers: actions
  async function ownedTransfer(userId: string, id: string) {
    const r = await db.query<{ id: string; state: string; bot_id: string | null; destination_id: string | null }>(
      `SELECT id, state, bot_id, destination_id FROM telegram_transfers WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (!r.rows[0]) throw notFound('Transfer not found');
    return r.rows[0];
  }

  /** Only files that have not started uploading can be cancelled; an upload in flight cannot be recalled. */
  app.post('/telegram/transfers/:id/cancel', async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await ownedTransfer(a.userId, id);
    const r = await db.query(`UPDATE telegram_transfer_files SET state = 'cancelled', updated_at = now(), error_code = NULL, error_message = NULL WHERE transfer_id = $1 AND state = 'queued'`, [id]);
    if (r.rowCount === 0) throw conflict('Nothing in this transfer is waiting to be sent. Uploads already in progress cannot be cancelled.', 'invalid_state');
    await recomputeTransfer(db, id);
    return (await loadTransfers(a.userId, [id], true))[0];
  });

  /**
   * Re-queues failed files. Files whose delivery is unknown ("ambiguous") are only re-sent when the caller
   * explicitly accepts that Telegram may then contain a duplicate.
   */
  app.post('/telegram/transfers/:id/retry', async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { confirmDuplicateRisk } = z.object({ confirmDuplicateRisk: z.boolean().default(false) }).parse(req.body ?? {});
    const tr = await ownedTransfer(a.userId, id);
    if (tr.destination_id === null || tr.bot_id === null) throw conflict('The destination or bot of this transfer no longer exists. Use "Send again" from the file manager.', 'destination_gone');
    const counts = (await db.query<{ plain: number; amb: number }>(
      `SELECT count(*) FILTER (WHERE NOT ambiguous)::int AS plain, count(*) FILTER (WHERE ambiguous)::int AS amb FROM telegram_transfer_files WHERE transfer_id = $1 AND state = 'failed'`, [id])).rows[0]!;
    if (counts.plain + counts.amb === 0) throw conflict('This transfer has no failed files to retry', 'invalid_state');
    if (counts.amb > 0 && counts.plain === 0 && !confirmDuplicateRisk) {
      throw new HttpError(409, 'confirmation_required', `${counts.amb} file(s) may already have been delivered to Telegram. Check the chat; sending again can create duplicates.`, { ambiguousFiles: counts.amb });
    }
    await db.query(
      `UPDATE telegram_transfer_files SET state = 'queued', attempt = 0, next_attempt_at = now(), ambiguous = FALSE, error_code = NULL, error_message = NULL, bytes_sent = 0, updated_at = now()
        WHERE transfer_id = $1 AND state = 'failed' AND (NOT ambiguous OR $2)`, [id, confirmDuplicateRisk]);
    await db.query(`UPDATE telegram_transfers SET state = 'queued', finished_at = NULL, updated_at = now() WHERE id = $1`, [id]);
    await recomputeTransfer(db, id);
    return (await loadTransfers(a.userId, [id], true))[0];
  });

  /** A brand-new transfer of the same files to the same destination (history is untouched). */
  app.post('/telegram/transfers/:id/resend', async (req, reply) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const tr = await ownedTransfer(a.userId, id);
    if (tr.destination_id === null) throw conflict('The destination of this transfer no longer exists', 'destination_gone');
    const dest = destDto(await ownedDest(a.userId, tr.destination_id));
    if (!dest.canSend) throw conflict(dest.problem ?? 'The bot cannot post to this destination. Revalidate it first.', 'destination_not_ready');
    const src = (await db.query<Record<string, unknown> & { file_id: string | null; live: boolean }>(
      `SELECT f.*, (fi.id IS NOT NULL AND fi.deleted_at IS NULL) AS live FROM telegram_transfer_files f LEFT JOIN files fi ON fi.id = f.file_id WHERE f.transfer_id = $1 ORDER BY f.position`, [id])).rows;
    if (src.some((s) => s.send_as === 'link')) throw conflict('A transfer that sent download links cannot be repeated as it is: create a new one so new links are made', 'link_transfer');
    if (src.some((s) => !s.live)) throw conflict('Some of the original files were deleted, so this transfer cannot be repeated', 'source_missing');
    const keyMap = new Map<string, string>();
    const newId = await db.tx(async (t) => {
      const n = (await t.query<{ id: string }>(
        `INSERT INTO telegram_transfers (user_id, bot_id, destination_id, bot_username, destination_title, destination_chat_id, destination_username, destination_type, caption, method, album)
         SELECT user_id, bot_id, destination_id, bot_username, $2, $3, $4, $5, caption, method, album FROM telegram_transfers WHERE id = $1 RETURNING id`,
        [id, dest.title, dest.chatId, dest.username, dest.type])).rows[0]!;
      for (const s of src) {
        const ak = s.album_key as string | null;
        if (ak && !keyMap.has(ak)) keyMap.set(ak, randomUUID());
        await t.query(
          `INSERT INTO telegram_transfer_files (transfer_id, user_id, position, file_id, name, size_bytes, mime_type, part_offset, part_index, part_count, send_as, album_key, caption)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [n.id, a.userId, s.position, s.file_id, s.name, s.size_bytes, s.mime_type, s.part_offset, s.part_index, s.part_count, s.send_as, ak ? keyMap.get(ak) : null, s.caption]);
      }
      return n.id;
    });
    return reply.status(201).send((await loadTransfers(a.userId, [newId], true))[0]);
  });

  app.delete('/telegram/transfers/:id', async (req, reply) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const tr = await ownedTransfer(a.userId, id);
    if (tr.state === 'queued' || tr.state === 'uploading') throw conflict('Cancel the transfer before removing it from the history', 'invalid_state');
    await db.query(`DELETE FROM telegram_transfers WHERE id = $1`, [id]);
    return reply.status(204).send();
  });
};
