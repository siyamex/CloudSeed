import { createHash } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { buildAuthUrl, exchangeAndVerify, type IdentityClaims } from '../auth/oidc.js';
import { createSession, randomToken, sha256 } from '../auth/session.js';
import { MIN_PASSWORD_LENGTH, checkPasswordPolicy, setPassword, verifyLocalLogin } from '../auth/local.js';
import { codeMatches, isLocalRequest, needsSetup, setupCode } from '../auth/setup.js';
import { cookieName, publicBase, requireAuth, type Deps } from '../app.js';
import type { Db } from '../db/index.js';
import { HttpError, forbidden } from '../errors.js';

const PROVIDER = 'google';

/** Only same-site relative paths are allowed as post-login destinations. */
export function safeRedirect(p: unknown): string {
  return typeof p === 'string' && /^\/(?![/\\])[^\r\n]*$/.test(p) ? p : '/';
}

type Outcome = { userId: string } | { error: string };

async function resolveUser(db: Db, deps: Deps, c: IdentityClaims, ip?: string): Promise<Outcome> {
  const { config } = deps;
  const existing = await db.query<{ user_id: string; status: string }>(
    `SELECT a.user_id, u.status FROM oauth_accounts a JOIN users u ON u.id = a.user_id
      WHERE a.provider = $1 AND a.subject = $2`, [PROVIDER, c.sub]);
  if (existing.rows[0]) {
    return existing.rows[0].status === 'active' ? { userId: existing.rows[0].user_id } : { error: 'account_disabled' };
  }

  // Never auto-link by email: an unknown identity with a taken email is rejected.
  const taken = await db.query(`SELECT 1 FROM users WHERE lower(email) = lower($1) AND status <> 'deleted'`, [c.email]);
  if (taken.rowCount > 0) return { error: 'email_in_use' };

  const isAdmin = config.adminEmails.includes(c.email.toLowerCase());
  const policy = await db.query<{ value: string }>(`SELECT value FROM application_settings WHERE key = 'registration_policy'`);
  const closed = (policy.rows[0]?.value ?? config.REGISTRATION_POLICY) === 'closed';
  if (closed && !isAdmin) return { error: 'registration_closed' };

  const userId = await db.tx(async (t) => {
    const u = await t.query<{ id: string }>(
      `INSERT INTO users (email, email_verified) VALUES ($1, TRUE) RETURNING id`, [c.email]);
    const id = u.rows[0]!.id;
    await t.query(`INSERT INTO user_profiles (user_id, display_name, avatar_url) VALUES ($1, $2, $3)`, [id, c.name ?? null, c.picture ?? null]);
    await t.query(`INSERT INTO oauth_accounts (user_id, provider, subject) VALUES ($1, $2, $3)`, [id, PROVIDER, c.sub]);
    await t.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 1)`, [id]);
    if (isAdmin) await t.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 2)`, [id]);
    const q = await t.query<{ value: number }>(`SELECT value FROM application_settings WHERE key = 'default_quota_bytes'`);
    await t.query(`INSERT INTO storage_quotas (user_id, quota_bytes) VALUES ($1, $2)`, [id, Number(q.rows[0]?.value ?? config.DEFAULT_USER_QUOTA_BYTES)]);
    await t.query(`INSERT INTO audit_logs (user_id, action, ip) VALUES ($1, 'user.register', $2)`, [id, ip ?? null]);
    return id;
  });
  return { userId };
}

export const authRoutes = (deps: Deps): FastifyPluginAsync => async (app) => {
  const { db, config } = deps;
  const google = deps.google!;
  const authLimit = { config: { rateLimit: { max: config.AUTH_RATE_LIMIT_PER_MIN, timeWindow: '1 minute' } } };
  /** The Google configuration for this request: a test-injected one, else what the administrator saved (or the environment). */
  const getOidc = (req: Parameters<typeof publicBase>[1]) => (deps.oidc ? Promise.resolve(deps.oidc) : google.get(publicBase(config, req)));
  const secureContext = (req: { headers: Record<string, string | string[] | undefined>; protocol: string }) =>
    String(req.headers['x-forwarded-proto'] ?? req.protocol).split(',')[0]!.trim() === 'https' || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(req.headers.host ?? ''));

  const startSession = async (req: { headers: Record<string, string | string[] | undefined>; ip: string }, reply: { setCookie: (n: string, v: string, o: object) => unknown }, userId: string, action: string) => {
    const token = await createSession(db, userId, config.SESSION_TTL_HOURS, { ua: req.headers['user-agent'] as string | undefined, ip: req.ip });
    await db.query(`INSERT INTO audit_logs (user_id, action, ip) VALUES ($1, $2, $3)`, [userId, action, req.ip]);
    reply.setCookie(cookieName(config), token, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge: config.SESSION_TTL_HOURS * 3600 });
  };

  app.get('/config', async (req) => {
    const setup = await needsSetup(db);
    return {
      googleConfigured: (await getOidc(req)) !== null,
      registrationPolicy: config.REGISTRATION_POLICY,
      devLogin: config.DEV_LOGIN,
      needsSetup: setup,
      // Only meaningful during first-run setup: whether this particular visitor must type the code from the server log.
      setupCodeRequired: setup && !isLocalRequest(req),
      localLogin: (await db.query(`SELECT 1 FROM local_credentials LIMIT 1`)).rowCount > 0,
      secureContext: secureContext(req),
      minPasswordLength: MIN_PASSWORD_LENGTH,
    };
  });

  /** Sign in with an email and password (the administrator account made during setup). */
  app.post('/login', authLimit, async (req, reply) => {
    const b = z.object({ email: z.string().trim().min(3).max(320), password: z.string().min(1).max(500) }).parse(req.body);
    const r = await verifyLocalLogin(db, b.email, b.password);
    if (!r.ok) {
      await db.query(`INSERT INTO audit_logs (user_id, action, ip, metadata) VALUES (NULL, 'auth.login_failed', $1, $2)`, [req.ip, JSON.stringify({ reason: r.reason })]);
      if (r.reason === 'locked') {
        reply.header('retry-after', String(r.retryAfterSeconds));
        throw new HttpError(429, 'too_many_attempts', `Too many wrong passwords. Try again in ${Math.ceil(r.retryAfterSeconds / 60)} minute(s).`);
      }
      if (r.reason === 'disabled') throw new HttpError(403, 'account_disabled', 'This account has been disabled. Contact the administrator.');
      throw new HttpError(401, 'invalid_credentials', 'That email and password do not match.');
    }
    await startSession(req, reply, r.userId, 'auth.login_password');
    return { ok: true };
  });

  /**
   * First-run setup: creates the administrator. Works exactly once, while there are no users at all. From outside the owner's own
   * network it also needs the setup code that the server prints in its log.
   */
  app.post('/setup', authLimit, async (req, reply) => {
    const b = z.object({
      email: z.string().trim().toLowerCase().email().max(320), password: z.string().max(500), displayName: z.string().trim().max(100).optional(), setupCode: z.string().max(40).optional(),
    }).parse(req.body);
    if (!(await needsSetup(db))) throw new HttpError(409, 'setup_done', 'This server has already been set up. Sign in instead.');
    if (!isLocalRequest(req) && !codeMatches(b.setupCode)) {
      throw new HttpError(403, 'setup_code_required', 'You are not on the same network as the server, so enter the setup code from its log. (Docker: "docker compose logs api"; CasaOS: open the app log.)');
    }
    const problem = checkPasswordPolicy(b.password, b.email);
    if (problem) throw new HttpError(422, 'weak_password', problem);
    const userId = await db.tx(async (t) => {
      await t.query('SELECT pg_advisory_xact_lock(7304)'); // two people finishing setup at once: only the first wins
      if ((await t.query(`SELECT 1 FROM users WHERE status <> 'deleted' LIMIT 1`)).rowCount > 0) throw new HttpError(409, 'setup_done', 'This server has already been set up. Sign in instead.');
      const id = (await t.query<{ id: string }>(`INSERT INTO users (email, email_verified) VALUES ($1, TRUE) RETURNING id`, [b.email])).rows[0]!.id;
      await t.query(`INSERT INTO user_profiles (user_id, display_name) VALUES ($1, $2)`, [id, b.displayName || null]);
      await t.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 1), ($1, 2)`, [id]);
      const q = await t.query<{ value: number }>(`SELECT value FROM application_settings WHERE key = 'default_quota_bytes'`);
      await t.query(`INSERT INTO storage_quotas (user_id, quota_bytes) VALUES ($1, $2)`, [id, Number(q.rows[0]?.value ?? config.DEFAULT_USER_QUOTA_BYTES)]);
      await setPassword(t, id, b.password);
      await t.query(`INSERT INTO audit_logs (user_id, action, ip) VALUES ($1, 'admin.setup', $2)`, [id, req.ip]);
      return id;
    });
    await startSession(req, reply, userId, 'auth.login_password');
    return reply.status(201).send({ ok: true });
  });

  if (config.DEV_LOGIN) {
    app.log.warn('DEV_LOGIN is on: anyone at this computer can sign in without Google. Development use only.');
    /** Signs in the configured test user. Only for requests that come from this very machine. */
    app.get('/dev-login', async (req, reply) => {
      const from = req.socket.remoteAddress ?? '';
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(from) || req.headers['x-forwarded-for']) throw forbidden('Dev login only works from the computer the server runs on');
      const email = config.DEV_LOGIN_EMAIL.trim().toLowerCase();
      let userId = (await db.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1 AND status = 'active'`, [email])).rows[0]?.id;
      if (!userId) {
        const out = await resolveUser(db, deps, { sub: 'dev-login', email, emailVerified: true, name: 'Dev User' }, req.ip);
        if ('error' in out) return reply.redirect(`/?auth_error=${out.error}`);
        userId = out.userId;
      }
      const token = await createSession(db, userId, config.SESSION_TTL_HOURS, { ua: req.headers['user-agent'], ip: req.ip });
      await db.query(`INSERT INTO audit_logs (user_id, action, ip) VALUES ($1, 'auth.dev_login', $2)`, [userId, req.ip]);
      reply.setCookie(cookieName(config), token, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge: config.SESSION_TTL_HOURS * 3600 });
      return reply.redirect('/');
    });
  }

  app.get('/google/login', authLimit, async (req, reply) => {
    const oidc = await getOidc(req);
    if (!oidc) throw new HttpError(503, 'oauth_not_configured', 'Google sign-in is not configured on this server');
    const { next } = z.object({ next: z.string().optional() }).parse(req.query);
    const state = randomToken(), nonce = randomToken(), verifier = randomToken(48);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await db.query(`DELETE FROM oauth_login_states WHERE expires_at < now()`);
    await db.query(
      `INSERT INTO oauth_login_states (state_hash, nonce, code_verifier, redirect_to, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
      [sha256(state), nonce, verifier, safeRedirect(next)]);
    return reply.redirect(buildAuthUrl(oidc, { state, nonce, challenge }));
  });

  app.get('/google/callback', authLimit, async (req, reply) => {
    const fail = (e: string) => reply.redirect(`/?auth_error=${e}`);
    const q = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(req.query);
    const oidc = await getOidc(req);
    if (!oidc) return fail('oauth_not_configured');
    if (q.error || !q.code || !q.state) return fail('oauth_denied');

    // Single-use: the row is consumed whether or not the rest succeeds.
    const st = await db.query<{ nonce: string; code_verifier: string; redirect_to: string }>(
      `DELETE FROM oauth_login_states WHERE state_hash = $1 AND expires_at > now()
       RETURNING nonce, code_verifier, redirect_to`, [sha256(q.state)]);
    const login = st.rows[0];
    if (!login) return fail('invalid_state');

    let claims: IdentityClaims;
    try { claims = await exchangeAndVerify(oidc, q.code, login.code_verifier, login.nonce); }
    catch (e) { req.log.warn({ err: (e as Error).message }, 'oidc verification failed'); return fail('oidc_failed'); }
    if (!claims.emailVerified) return fail('email_unverified');

    const out = await resolveUser(db, deps, claims, req.ip);
    if ('error' in out) return fail(out.error);

    const token = await createSession(db, out.userId, config.SESSION_TTL_HOURS, { ua: req.headers['user-agent'], ip: req.ip });
    await db.query(`INSERT INTO audit_logs (user_id, action, ip) VALUES ($1, 'auth.login', $2)`, [out.userId, req.ip]);
    reply.setCookie(cookieName(config), token, {
      httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge: config.SESSION_TTL_HOURS * 3600,
    });
    return reply.redirect(login.redirect_to);
  });

  app.get('/me', async (req) => {
    const a = requireAuth(req);
    const r = await db.query<{ display_name: string | null; avatar_url: string | null; theme: string }>(
      `SELECT display_name, avatar_url, theme FROM user_profiles WHERE user_id = $1`, [a.userId]);
    const p = r.rows[0];
    return {
      user: { id: a.userId, email: a.email, roles: a.roles, displayName: p?.display_name ?? null, avatarUrl: p?.avatar_url ?? null, theme: p?.theme ?? 'system',
        hasPassword: (await db.query(`SELECT 1 FROM local_credentials WHERE user_id = $1`, [a.userId])).rowCount > 0 },
      insecure: !config.cookieSecure && config.PUBLIC_URL.startsWith('http://') && a.roles.includes('admin'),
      csrfToken: a.csrfToken,
    };
  });

  app.post('/logout', async (req, reply) => {
    const a = requireAuth(req);
    await db.query(`DELETE FROM sessions WHERE id = $1`, [a.sessionId]);
    reply.clearCookie(cookieName(config), { path: '/' });
    return reply.status(204).send();
  });
};
