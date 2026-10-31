import { Readable } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { adapterFor, cookieName, requireAuth, type Deps } from '../app.js';
import { HttpError } from '../errors.js';
import { deleteObjects, type ObjectRef } from '../files/ops.js';
import { createVault } from '../crypto.js';
import { checkPasswordPolicy, setPassword, verifyLocalLogin } from '../auth/local.js';
import { isKnownKind } from '../notifications/kinds.js';
import { sendToDestination } from '../telegram/notify.js';

const uuid = z.string().uuid();

const patchBody = z.object({
  theme: z.enum(['system', 'light', 'dark']).optional(),
  displayName: z.string().trim().max(100).nullable().optional(),
  defaultDownloadFolderId: uuid.nullable().optional(),
  /** null = use the server default */
  downloadConcurrency: z.number().int().min(1).max(20).nullable().optional(),
  /** bytes per second; null or 0 = no personal limit */
  downloadBandwidthBps: z.number().int().min(0).nullable().optional(),
  emailNotifications: z.boolean().optional(),
  /** One of the user's own Telegram destinations; null turns Telegram notifications off. */
  telegramNotifyDestinationId: uuid.nullable().optional(),
  mutedKinds: z.array(z.string()).max(50).optional(),
}).strict();

export const accountRoutes = (deps: Deps): FastifyPluginAsync => async (app) => {
  const { db, config } = deps;
  const audit = (userId: string | null, action: string, target: string | null, ip?: string, meta: object = {}) =>
    db.query(`INSERT INTO audit_logs (user_id, action, target, ip, metadata) VALUES ($1, $2, $3, $4, $5)`, [userId, action, target, ip ?? null, JSON.stringify(meta)]).catch(() => undefined);
  const emailAvailable = () => config.SMTP_HOST !== '';
  const vault = deps.vault ?? createVault(config);

  async function readSettings(userId: string) {
    const r = await db.query<{
      theme: string | null; display_name: string | null; folder: string | null; conc: number | null; bps: string | null; email: boolean | null; muted: string[] | null; tg: string | null;
    }>(
      `SELECT p.theme, p.display_name, us.default_download_folder_id AS folder, us.download_concurrency AS conc,
              us.download_bandwidth_bps AS bps, us.email_notifications AS email, us.muted_kinds AS muted, us.telegram_notify_destination_id AS tg
         FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id LEFT JOIN user_settings us ON us.user_id = u.id WHERE u.id = $1`, [userId]);
    const x = r.rows[0]!;
    return {
      theme: x.theme ?? 'system',
      displayName: x.display_name,
      defaultDownloadFolderId: x.folder,
      downloadConcurrency: x.conc,
      downloadBandwidthBps: x.bps === null ? null : Number(x.bps),
      emailNotifications: x.email ?? false,
      telegramNotifyDestinationId: x.tg,
      mutedKinds: x.muted ?? [],
      limits: {
        downloadConcurrency: config.DOWNLOAD_USER_CONCURRENCY,
        downloadBandwidthBps: config.DOWNLOAD_BANDWIDTH_LIMIT_BPS,
        emailAvailable: emailAvailable(),
        telegramAvailable: config.TELEGRAM_ENABLED,
      },
    };
  }

  app.get('/account/settings', async (req) => readSettings(requireAuth(req).userId));

  app.patch('/account/settings', async (req) => {
    const a = requireAuth(req);
    const b = patchBody.parse(req.body);

    if (b.defaultDownloadFolderId) {
      const f = await db.query(`SELECT 1 FROM folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [b.defaultDownloadFolderId, a.userId]);
      if (!f.rowCount) throw new HttpError(404, 'not_found', 'Folder not found');
    }
    if (b.downloadConcurrency != null && b.downloadConcurrency > config.DOWNLOAD_USER_CONCURRENCY) {
      throw new HttpError(422, 'above_server_limit', `The server allows at most ${config.DOWNLOAD_USER_CONCURRENCY} simultaneous downloads per user`);
    }
    const server = config.DOWNLOAD_BANDWIDTH_LIMIT_BPS;
    if (b.downloadBandwidthBps && server > 0 && b.downloadBandwidthBps > server) {
      throw new HttpError(422, 'above_server_limit', `Your limit cannot be higher than the server limit of ${server} bytes per second`);
    }
    if (b.emailNotifications && !emailAvailable()) {
      throw new HttpError(409, 'email_unavailable', 'This server has no email (SMTP) configured, so email notifications cannot be turned on');
    }
    if (b.telegramNotifyDestinationId) {
      if (!config.TELEGRAM_ENABLED) throw new HttpError(409, 'telegram_unavailable', 'Telegram is turned off on this server');
      const d = (await db.query<{ can_send: boolean; status: string }>(
        `SELECT d.can_send, b.status FROM telegram_destinations d JOIN telegram_bots b ON b.id = d.bot_id WHERE d.id = $1 AND d.user_id = $2`, [b.telegramNotifyDestinationId, a.userId])).rows[0];
      if (!d) throw new HttpError(404, 'not_found', 'That Telegram destination was not found');
      if (!d.can_send || d.status !== 'active') throw new HttpError(409, 'destination_unusable', 'The bot cannot post in that chat right now. Check it on the Telegram page.');
    }
    const unknown = (b.mutedKinds ?? []).filter((k) => !isKnownKind(k));
    if (unknown.length) throw new HttpError(422, 'unknown_kind', `Unknown notification kind: ${unknown[0]}`);

    await db.tx(async (t) => {
      if (b.theme !== undefined || b.displayName !== undefined) {
        await t.query(
          `INSERT INTO user_profiles (user_id, theme, display_name) VALUES ($1, COALESCE($2, 'system'), $3)
           ON CONFLICT (user_id) DO UPDATE SET theme = COALESCE($2, user_profiles.theme),
             display_name = CASE WHEN $4::boolean THEN $3 ELSE user_profiles.display_name END, updated_at = now()`,
          [a.userId, b.theme ?? null, b.displayName ?? null, b.displayName !== undefined]);
      }
      await t.query(`INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [a.userId]);
      const sets: string[] = []; const vals: unknown[] = [a.userId];
      const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (b.defaultDownloadFolderId !== undefined) add('default_download_folder_id', b.defaultDownloadFolderId);
      if (b.downloadConcurrency !== undefined) add('download_concurrency', b.downloadConcurrency);
      if (b.downloadBandwidthBps !== undefined) add('download_bandwidth_bps', b.downloadBandwidthBps || null);
      if (b.emailNotifications !== undefined) add('email_notifications', b.emailNotifications);
      if (b.telegramNotifyDestinationId !== undefined) add('telegram_notify_destination_id', b.telegramNotifyDestinationId);
      if (b.mutedKinds !== undefined) add('muted_kinds', [...new Set(b.mutedKinds)]);
      if (sets.length) await t.query(`UPDATE user_settings SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $1`, vals);
    });
    return readSettings(a.userId);
  });

  /** Sends a test message to the chosen destination, so the user finds out now if it works. */
  app.post('/account/telegram-notify/test', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const a = requireAuth(req);
    const dest = (await db.query<{ d: string | null }>(`SELECT telegram_notify_destination_id AS d FROM user_settings WHERE user_id = $1`, [a.userId])).rows[0]?.d;
    if (!dest) throw new HttpError(409, 'no_destination', 'Choose a Telegram chat for notifications first');
    const out = await sendToDestination({ db, vault, config, userId: a.userId, destinationId: dest, text: 'CloudSeed test: notifications will arrive in this chat.' });
    if (!out.ok) throw new HttpError(502, 'telegram_failed', out.reason);
    return { ok: true };
  });

  /** Change the password of an account that has one (the administrator account made during setup). Signs every other session out. */
  app.post('/account/password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const a = requireAuth(req);
    const b = z.object({ currentPassword: z.string().max(500), newPassword: z.string().max(500) }).strict().parse(req.body);
    if (!(await db.query(`SELECT 1 FROM local_credentials WHERE user_id = $1`, [a.userId])).rowCount) {
      throw new HttpError(409, 'no_password', 'This account signs in with Google, so it has no password here.');
    }
    const r = await verifyLocalLogin(db, a.email, b.currentPassword);
    if (!r.ok) {
      if (r.reason === 'locked') { reply.header('retry-after', String(r.retryAfterSeconds)); throw new HttpError(429, 'too_many_attempts', `Too many wrong passwords. Try again in ${Math.ceil(r.retryAfterSeconds / 60)} minute(s).`); }
      throw new HttpError(403, 'wrong_password', 'The current password is not correct.');
    }
    const problem = checkPasswordPolicy(b.newPassword, a.email);
    if (problem) throw new HttpError(422, 'weak_password', problem);
    if (b.newPassword === b.currentPassword) throw new HttpError(422, 'same_password', 'Choose a password that is different from the current one.');
    await setPassword(db, a.userId, b.newPassword);
    const out = await db.query(`DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, [a.userId, a.sessionId]);
    await audit(a.userId, 'account.password_changed', null, req.ip, { otherSessionsEnded: out.rowCount });
    return { ok: true, otherSessionsEnded: out.rowCount };
  });

  // ------------------------------------------------------------------ sessions
  app.get('/account/sessions', async (req) => {
    const a = requireAuth(req);
    const r = await db.query<{ id: string; user_agent: string | null; ip: string | null; created_at: string; last_seen_at: string; expires_at: string }>(
      `SELECT id, user_agent, ip, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC`, [a.userId]);
    return {
      sessions: r.rows.map((s) => ({
        id: s.id, current: s.id === a.sessionId, userAgent: s.user_agent, ip: s.ip,
        createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at,
      })),
    };
  });

  app.post('/account/sessions/revoke-others', async (req) => {
    const a = requireAuth(req);
    const r = await db.query(`DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, [a.userId, a.sessionId]);
    await audit(a.userId, 'session.revoke_others', null, req.ip, { count: r.rowCount });
    return { revoked: r.rowCount };
  });

  app.delete('/account/sessions/:id', async (req, reply) => {
    const a = requireAuth(req);
    const id = uuid.parse((req.params as { id: string }).id);
    const r = await db.query(`DELETE FROM sessions WHERE id = $1 AND user_id = $2`, [id, a.userId]);
    if (!r.rowCount) throw new HttpError(404, 'not_found', 'Session not found');
    await audit(a.userId, 'session.revoke', `session:${id}`, req.ip);
    if (id === a.sessionId) reply.clearCookie(cookieName(config), { path: '/' });
    return { ok: true };
  });

  // ------------------------------------------------------------------ data export
  /**
   * Everything the account owns, as one JSON document. Secrets are left out on purpose: no Telegram bot tokens, no
   * session or share-link secrets, no storage paths. Streamed section by section so a big library does not sit in memory.
   */
  app.get('/account/export', async (req, reply) => {
    const a = requireAuth(req);
    const q = <T extends object>(sql: string) => db.query<T>(sql, [a.userId]).then((r) => r.rows);
    const sections: [string, () => Promise<unknown>][] = [
      ['account', async () => (await q(`SELECT u.id, u.email, u.status, u.created_at, p.display_name, p.theme FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id WHERE u.id = $1`))[0]],
      ['settings', async () => (await q(`SELECT default_download_folder_id, download_concurrency, download_bandwidth_bps, email_notifications, muted_kinds FROM user_settings WHERE user_id = $1`))[0] ?? null],
      ['storageQuota', async () => (await q(`SELECT quota_bytes, used_bytes FROM storage_quotas WHERE user_id = $1`))[0] ?? null],
      ['folders', () => q(`SELECT id, parent_id, name, created_at, deleted_at FROM folders WHERE user_id = $1 ORDER BY created_at`)],
      ['files', () => q(`SELECT id, folder_id, name, size_bytes, mime_type, sha256, status, created_at, deleted_at FROM files WHERE user_id = $1 ORDER BY created_at`)],
      ['shareLinks', () => q(`SELECT id, file_id, folder_id, label, mode, expires_at, max_downloads, download_count, access_count, (password_hash IS NOT NULL) AS password_protected, revoked_at, created_at FROM shared_links WHERE user_id = $1 ORDER BY created_at`)],
      ['downloads', () => q(`SELECT id, url, state, filename, folder_id, total_bytes, bytes_received, error_code, created_at, finished_at FROM download_jobs WHERE user_id = $1 ORDER BY created_at`)],
      ['telegramDestinations', () => q(`SELECT id, title, username, chat_type, created_at FROM telegram_destinations WHERE user_id = $1`)],
      ['telegramTransfers', () => q(`SELECT id, state, created_at FROM telegram_transfers WHERE user_id = $1 ORDER BY created_at`)],
      ['playbackProgress', () => q(`SELECT file_id, position_ms, duration_ms, completed, updated_at FROM media_playback_progress WHERE user_id = $1`)],
      ['notifications', () => q(`SELECT kind, title, body, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at`)],
      ['activity', () => q(`SELECT action, target, ip, created_at FROM audit_logs WHERE user_id = $1 ORDER BY id`)],
    ];
    async function* gen() {
      yield `{"exportedAt":${JSON.stringify(new Date().toISOString())},"format":"cloudseed-export-v1"`;
      for (const [name, load] of sections) {
        try { yield `,${JSON.stringify(name)}:${JSON.stringify(await load())}`; } catch (err) {
          app.log.error({ err, section: name }, 'export section failed');
          yield `,${JSON.stringify(name)}:null,${JSON.stringify(name + 'Error')}:"could not be exported"`;
        }
      }
      yield '}';
    }
    await audit(a.userId, 'account.export', null, req.ip);
    return reply.header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', 'attachment; filename="cloudseed-export.json"')
      .header('cache-control', 'no-store')
      .send(Readable.from(gen()));
  });

  // ------------------------------------------------------------------ account deletion
  app.post('/account/delete', async (req, reply) => {
    const a = requireAuth(req);
    const b = z.object({ confirmEmail: z.string() }).strict().parse(req.body);
    if (b.confirmEmail.trim().toLowerCase() !== a.email.toLowerCase()) {
      throw new HttpError(422, 'confirmation_mismatch', 'Type your account email address to confirm the deletion');
    }
    const refs = await db.tx(async (t) => {
      // lock admins so two admins deleting themselves at once cannot leave the server without one
      if (a.roles.includes('admin')) {
        const admins = await t.query<{ id: string }>(
          `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id AND r.name = 'admin'
            WHERE u.status = 'active' FOR UPDATE OF u`);
        if (admins.rows.every((x) => x.id === a.userId)) {
          throw new HttpError(409, 'last_admin', 'You are the only administrator. Promote another user to administrator before deleting this account.');
        }
      }
      const out: ObjectRef[] = [
        ...(await t.query<{ storage_key: string; storage_provider_kind: string }>(`SELECT storage_key, storage_provider_kind FROM files WHERE user_id = $1`, [a.userId]))
          .rows.map((x) => ({ key: x.storage_key, kind: x.storage_provider_kind })),
        ...(await t.query<{ storage_key: string; storage_provider_kind: string }>(`SELECT storage_key, storage_provider_kind FROM media_assets WHERE user_id = $1 AND storage_key IS NOT NULL AND storage_provider_kind IS NOT NULL`, [a.userId]))
          .rows.map((x) => ({ key: x.storage_key, kind: x.storage_provider_kind })),
      ];
      await t.query(`DELETE FROM users WHERE id = $1`, [a.userId]); // everything the user owns goes with it (ON DELETE CASCADE)
      await t.query(`INSERT INTO audit_logs (user_id, action, target, ip) VALUES (NULL, 'account.deleted', $1, $2)`, [`user:${a.userId}`, req.ip]);
      return out;
    });
    reply.clearCookie(cookieName(config), { path: '/' });
    await deleteObjects(refs, (k) => { try { return adapterFor(deps, k); } catch { return undefined; } },
      (err, key) => app.log.error({ err, key }, 'object delete failed after account deletion; reconciliation will find it'));
    return reply.status(200).send({ deleted: true, objectsRemoved: refs.length });
  });
};
