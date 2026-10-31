import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { adapterFor, cookieName, requireAuth, type Deps } from '../app.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { randomToken, sha256 } from '../auth/session.js';
import { HttpError, badRequest, conflict, notFound } from '../errors.js';
import { serveObject } from '../files/serve.js';
import { contentDisposition, mimeFromName, parseRange } from '../files/util.js';

const uuid = z.string().uuid();
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const RESUME_GRACE_MS = 30 * 60_000; // a download that has used up its count may still be resumed for this long

export const STATUS_SQL = `CASE WHEN s.disabled_by_admin THEN 'disabled' WHEN s.revoked_at IS NOT NULL THEN 'revoked' WHEN s.expires_at <= now() THEN 'expired'
  WHEN s.max_downloads IS NOT NULL AND s.download_count >= s.max_downloads THEN 'exhausted' ELSE 'active' END`;

export const newShareToken = () => randomToken(32);
export const shareUrl = (publicUrl: string, token: string) => `${publicUrl.replace(/\/+$/, '')}/s/${token}`;
const SAFE_TYPES = new Set(['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/xml']);
const downloadMime = (name: string) => { const m = mimeFromName(name); return SAFE_TYPES.has(m) ? 'application/octet-stream' : m; };

interface ShareRow {
  id: string; user_id: string; file_id: string; label: string | null; mode: 'public' | 'private'; expires_at: string; max_downloads: number | null;
  download_count: number; access_count: number; password_hash: string | null; revoked_at: string | null; disabled_by_admin: boolean;
  last_accessed_at: string | null; created_at: string; status: 'active' | 'expired' | 'revoked' | 'exhausted' | 'disabled';
  file_name: string; file_size: number; file_deleted: boolean; sharing_disabled: boolean; storage_key: string; storage_provider_kind: string; sha256: string | null;
  last_download_at: string | null;
}

const ownerDto = (r: ShareRow) => ({
  id: r.id, fileId: r.file_id, fileName: r.file_name, fileSize: Number(r.file_size), label: r.label, mode: r.mode, status: r.status,
  expiresAt: r.expires_at, maxDownloads: r.max_downloads, downloadCount: r.download_count, accessCount: r.access_count,
  passwordProtected: r.password_hash !== null, createdAt: r.created_at, lastAccessedAt: r.last_accessed_at, revokedAt: r.revoked_at,
  fileInTrash: r.file_deleted,
});

const SELECT = `SELECT s.*, ${STATUS_SQL} AS status, f.name AS file_name, f.size_bytes AS file_size, (f.deleted_at IS NOT NULL) AS file_deleted, f.sharing_disabled,
    f.storage_key, f.storage_provider_kind, f.sha256
  FROM shared_links s JOIN files f ON f.id = s.file_id`;

export const shareRoutes = (deps: Deps): FastifyPluginAsync => async (app) => {
  const { db, config } = deps;

  const grantKey = createHmac('sha256', `share-grant:${config.SESSION_SECRET}`).update('v1').digest();
  const sign = (payload: string) => createHmac('sha256', grantKey).update(payload).digest('base64url');
  const makeGrant = (shareId: string, ttlSeconds = 600) => { const p = `${shareId}.${Math.floor(Date.now() / 1000) + ttlSeconds}`; return `${p}.${sign(p)}`; };
  const grantValid = (value: string | undefined, shareId: string) => {
    if (!value) return false;
    const [id, exp, sig] = value.split('.');
    if (id !== shareId || !exp || !sig || Number(exp) < Date.now() / 1000) return false;
    const want = Buffer.from(sign(`${id}.${exp}`)), got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
  };

  const audit = (userId: string | null, action: string, target: string, ip?: string, meta: object = {}) =>
    db.query(`INSERT INTO audit_logs (user_id, action, target, ip, metadata) VALUES ($1, $2, $3, $4, $5)`, [userId, action, target, ip ?? null, JSON.stringify(meta)]).catch(() => undefined);

  const enabled = () => { if (!config.SHARING_ENABLED) throw new HttpError(409, 'sharing_disabled', 'Sharing is turned off on this server'); };

  // ================================================================ owner API
  app.get('/shares', async (req) => {
    const a = requireAuth(req);
    const q = z.object({ fileId: uuid.optional(), status: z.enum(['active', 'expired', 'revoked', 'exhausted', 'disabled']).optional() }).parse(req.query);
    const params: unknown[] = [a.userId];
    const where = ['s.user_id = $1'];
    if (q.fileId) { params.push(q.fileId); where.push(`s.file_id = $${params.length}`); }
    const rows = (await db.query<ShareRow>(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC LIMIT 500`, params)).rows;
    return { enabled: config.SHARING_ENABLED, maxDays: config.SHARING_MAX_DAYS, shares: rows.map(ownerDto).filter((s) => !q.status || s.status === q.status) };
  });

  app.post('/shares', async (req, reply) => {
    const a = requireAuth(req);
    enabled();
    const b = z.object({
      fileId: uuid,
      expiresInHours: z.number().int().min(1).max(config.SHARING_MAX_DAYS * 24),
      maxDownloads: z.number().int().min(1).max(1_000_000).nullish(),
      password: z.string().min(8, 'A link password needs at least 8 characters').max(200).nullish(),
      mode: z.enum(['public', 'private']).default('public'),
      label: z.string().trim().max(100).nullish(),
      /** Public links can be opened by anyone who has the URL; the caller must say they understand that. */
      acknowledgePublic: z.boolean().optional(),
    }).parse(req.body);
    if (b.mode === 'public' && b.acknowledgePublic !== true) throw badRequest('Confirm that anyone with this link will be able to download the file', 'public_not_acknowledged');

    const f = (await db.query<{ name: string; sharing_disabled: boolean }>(
      `SELECT name, sharing_disabled FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL AND status = 'ready'`, [b.fileId, a.userId])).rows[0];
    if (!f) throw notFound('File not found');
    if (f.sharing_disabled) throw conflict('Sharing is turned off for this file', 'file_sharing_disabled');
    const active = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM shared_links s WHERE s.user_id = $1 AND ${STATUS_SQL} = 'active'`, [a.userId])).rows[0]!.n;
    if (active >= config.SHARING_MAX_ACTIVE_PER_USER) throw new HttpError(429, 'too_many_shares', `You already have ${active} active share links. Revoke some first.`);

    const token = newShareToken();
    const passwordHash = b.password ? await hashPassword(b.password) : null;
    const id = (await db.query<{ id: string }>(
      `INSERT INTO shared_links (user_id, file_id, token_hash, label, mode, expires_at, max_downloads, password_hash)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6), $7, $8) RETURNING id`,
      [a.userId, b.fileId, sha256(token), b.label ?? null, b.mode, b.expiresInHours, b.maxDownloads ?? null, passwordHash])).rows[0]!.id;
    await audit(a.userId, 'share.created', `share:${id}`, req.ip, { file: b.fileId, mode: b.mode, passwordProtected: !!passwordHash });
    const row = (await db.query<ShareRow>(`${SELECT} WHERE s.id = $1`, [id])).rows[0]!;
    // The token exists only in this response. It is not stored, so it cannot be shown again.
    return reply.status(201).send({ ...ownerDto(row), token, url: shareUrl(config.PUBLIC_URL, token) });
  });

  async function owned(userId: string, id: string): Promise<ShareRow> {
    const r = (await db.query<ShareRow>(`${SELECT} WHERE s.id = $1 AND s.user_id = $2`, [id, userId])).rows[0];
    if (!r) throw notFound('Share link not found');
    return r;
  }

  app.patch('/shares/:id', async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      expiresInHours: z.number().int().min(1).max(config.SHARING_MAX_DAYS * 24).optional(),
      maxDownloads: z.number().int().min(1).max(1_000_000).nullable().optional(),
      label: z.string().trim().max(100).nullable().optional(),
    }).parse(req.body);
    const cur = await owned(a.userId, id);
    if (cur.status === 'revoked' || cur.status === 'disabled') throw conflict(`A ${cur.status} link cannot be changed. Create a new one.`, 'invalid_state');
    await db.query(
      `UPDATE shared_links SET expires_at = CASE WHEN $2::int IS NULL THEN expires_at ELSE now() + make_interval(hours => $2::int) END,
              expiry_notified = CASE WHEN $2::int IS NULL THEN expiry_notified ELSE FALSE END,
              max_downloads = CASE WHEN $3::boolean THEN $4::int ELSE max_downloads END, label = CASE WHEN $5::boolean THEN $6 ELSE label END WHERE id = $1`,
      [id, b.expiresInHours ?? null, b.maxDownloads !== undefined, b.maxDownloads ?? null, b.label !== undefined, b.label ?? null]);
    return ownerDto(await owned(a.userId, id));
  });

  app.post('/shares/:id/revoke', async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await owned(a.userId, id);
    await db.query(`UPDATE shared_links SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1`, [id]);
    await audit(a.userId, 'share.revoked', `share:${id}`, req.ip);
    return ownerDto(await owned(a.userId, id));
  });

  app.delete('/shares/:id', async (req, reply) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await owned(a.userId, id);
    await db.query(`DELETE FROM shared_links WHERE id = $1`, [id]);
    await audit(a.userId, 'share.deleted', `share:${id}`, req.ip);
    return reply.status(204).send();
  });

  // ================================================================ public API (no session required)
  const noIndex = (reply: { header(k: string, v: string): unknown }) => {
    reply.header('referrer-policy', 'no-referrer'); reply.header('x-robots-tag', 'noindex, nofollow, noarchive'); reply.header('cache-control', 'no-store');
  };

  async function lookup(rawToken: string): Promise<ShareRow> {
    if (!TOKEN_RE.test(rawToken)) throw new HttpError(404, 'share_not_found', 'This link does not exist');
    const r = (await db.query<ShareRow>(`${SELECT} WHERE s.token_hash = $1`, [sha256(rawToken)])).rows[0];
    if (!r) throw new HttpError(404, 'share_not_found', 'This link does not exist');
    return r;
  }

  const unavailable = (r: ShareRow) => {
    if (r.status === 'disabled') return new HttpError(410, 'share_disabled', 'This link was disabled by an administrator');
    if (r.status === 'revoked') return new HttpError(410, 'share_revoked', 'The owner has turned this link off');
    if (r.status === 'expired') return new HttpError(410, 'share_expired', 'This link has expired');
    if (r.file_deleted || r.sharing_disabled) return new HttpError(410, 'file_unavailable', 'The file is no longer available');
    if (r.status === 'exhausted') return new HttpError(410, 'share_exhausted', 'This link has reached its download limit');
    return null;
  };

  const needsLogin = (r: ShareRow, req: FastifyRequest) => r.mode === 'private' && !req.auth;
  const hasGrant = (r: ShareRow, req: FastifyRequest) => r.password_hash === null || grantValid(req.cookies.cs_sg, r.id);

  app.get('/public/shares/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().max(100) }).parse(req.params);
    noIndex(reply);
    if (!config.SHARING_ENABLED) throw new HttpError(404, 'share_not_found', 'This link does not exist');
    const r = await lookup(token);
    const bad = unavailable(r);
    if (bad) throw bad;
    if (needsLogin(r, req)) throw new HttpError(401, 'login_required', 'Sign in to CloudSeed to open this link', { mode: 'private' });
    await db.query(`UPDATE shared_links SET access_count = access_count + 1, last_accessed_at = now() WHERE id = $1`, [r.id]);
    return {
      name: r.file_name, size: Number(r.file_size), mode: r.mode, passwordRequired: r.password_hash !== null, unlocked: hasGrant(r, req),
      expiresAt: r.expires_at, downloadsLeft: r.max_downloads === null ? null : Math.max(0, r.max_downloads - r.download_count),
    };
  });

  // Failed password attempts per link, over all addresses: stops a botnet from guessing one link's password.
  const failures = new Map<string, number[]>();
  const tooManyFailures = (id: string) => {
    const now = Date.now();
    const recent = (failures.get(id) ?? []).filter((t) => now - t < 60_000);
    failures.set(id, recent);
    return recent.length >= 30;
  };

  app.post('/public/shares/:token/unlock', {
    config: { rateLimit: { max: config.SHARE_UNLOCK_RATE_PER_MIN, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => `${req.ip}:${String((req.params as { token?: string }).token ?? '').slice(0, 12)}` } },
  }, async (req, reply) => {
    const { token } = z.object({ token: z.string().max(100) }).parse(req.params);
    const { password } = z.object({ password: z.string().min(1).max(200) }).parse(req.body);
    noIndex(reply);
    const r = await lookup(token);
    const bad = unavailable(r);
    if (bad) throw bad;
    if (needsLogin(r, req)) throw new HttpError(401, 'login_required', 'Sign in to CloudSeed to open this link', { mode: 'private' });
    if (r.password_hash === null) return { unlocked: true };
    if (tooManyFailures(r.id)) throw new HttpError(429, 'too_many_attempts', 'Too many wrong passwords for this link. Try again in a minute.');
    if (!(await verifyPassword(password, r.password_hash))) {
      failures.get(r.id)!.push(Date.now());
      throw new HttpError(403, 'wrong_password', 'That password is not correct');
    }
    reply.setCookie('cs_sg', makeGrant(r.id), { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: `/api/v1/public/shares/${token}`, maxAge: 600 });
    return { unlocked: true };
  });

  app.get('/public/shares/:token/download', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().max(100) }).parse(req.params);
    noIndex(reply);
    if (!config.SHARING_ENABLED) throw new HttpError(404, 'share_not_found', 'This link does not exist');
    const r = await lookup(token);
    // Exhausted links may still *continue* a download that was already counted (a resumed Range request) for a short while.
    const size = Number(r.file_size);
    const range = parseRange(req.headers.range, size);
    const counted = range === null || (range !== 'invalid' && range.start === 0);
    const resuming = !counted && r.status === 'exhausted' && r.last_download_at !== null && Date.now() - new Date(r.last_download_at).getTime() < RESUME_GRACE_MS;
    const bad = resuming ? (r.file_deleted || r.sharing_disabled ? unavailable(r) : null) : unavailable(r);
    if (bad) throw bad;
    if (needsLogin(r, req)) throw new HttpError(401, 'login_required', 'Sign in to CloudSeed to open this link', { mode: 'private' });
    if (!hasGrant(r, req)) throw new HttpError(403, 'password_required', 'This link needs its password');

    if (counted) {
      // Atomic: two simultaneous downloads cannot both take the last slot.
      const upd = await db.query(
        `UPDATE shared_links s SET download_count = download_count + 1, last_download_at = now(), last_accessed_at = now()
          WHERE s.id = $1 AND s.revoked_at IS NULL AND NOT s.disabled_by_admin AND s.expires_at > now() AND (s.max_downloads IS NULL OR s.download_count < s.max_downloads)`, [r.id]);
      if (upd.rowCount === 0) throw new HttpError(410, 'share_exhausted', 'This link has reached its download limit');
    }
    // Always an attachment: a shared file can never be rendered as a page on this origin.
    return serveObject(reply, adapterFor(deps, r.storage_provider_kind), r.storage_key, {
      size, mime: downloadMime(r.file_name), etag: null, disposition: contentDisposition(r.file_name), rangeHeader: req.headers.range, cacheControl: 'no-store',
    });
  });

  app.post('/public/shares/:token/report', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().max(100) }).parse(req.params);
    const b = z.object({ reason: z.enum(['illegal', 'malware', 'copyright', 'privacy', 'other']), details: z.string().trim().max(2000).optional() }).parse(req.body);
    noIndex(reply);
    const r = await lookup(token);
    const reporter = createHash('sha256').update(`${req.ip}|${config.SESSION_SECRET}`).digest('hex').slice(0, 16);
    await db.query(`INSERT INTO abuse_reports (share_id, file_name, owner_id, reason, details, reporter_hash) VALUES ($1, $2, $3, $4, $5, $6)`,
      [r.id, r.file_name, r.user_id, b.reason, b.details ?? null, reporter]);
    await audit(null, 'share.reported', `share:${r.id}`, undefined, { reason: b.reason });
    return reply.status(201).send({ received: true });
  });

  // keep cookieName referenced so a future change to session cookies is seen here too
  void cookieName;
};
