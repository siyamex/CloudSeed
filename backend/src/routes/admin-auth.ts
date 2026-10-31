import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { publicBase, requireAdmin, type Deps } from '../app.js';
import { applyRuntimeSettings, redirectUriFor } from '../auth/providers.js';
import { HttpError } from '../errors.js';

const CLIENT_ID = /^[A-Za-z0-9_.-]{6,200}\.apps\.googleusercontent\.com$/;

/** Sign-in settings for administrators: Google credentials (the secret is kept encrypted and never shown again) and the public address. */
export const adminAuthRoutes = (deps: Deps): FastifyPluginAsync => async (app) => {
  const { db, config } = deps;
  const google = deps.google!;
  app.addHook('preHandler', async (req) => { if (req.url.includes('/admin/auth')) requireAdmin(req); });
  const audit = (adminId: string, action: string, ip: string, meta: object = {}) =>
    db.query(`INSERT INTO audit_logs (user_id, action, ip, metadata) VALUES ($1, $2, $3, $4)`, [adminId, action, ip, JSON.stringify(meta)]);

  const view = async (req: Parameters<typeof publicBase>[1]) => {
    const g = await google.state();
    const base = publicBase(config, req);
    return {
      publicUrl: { value: config.publicUrlConfigured ? config.PUBLIC_URL : null, inUse: base, secure: base.startsWith('https://'), fromEnvironment: !!process.env.PUBLIC_URL && !(await db.query(`SELECT 1 FROM application_settings WHERE key = 'public_url'`)).rowCount },
      google: {
        enabled: g.enabled, source: g.source, clientId: g.clientId, secretSet: g.secretSet,
        redirectUri: g.source === 'environment' && config.GOOGLE_REDIRECT_URI ? config.GOOGLE_REDIRECT_URI : redirectUriFor(base),
      },
      local: { accounts: (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM local_credentials`)).rows[0]!.n },
    };
  };

  app.get('/admin/auth', async (req) => view(req));

  app.put('/admin/auth/google', async (req) => {
    const admin = requireAdmin(req);
    const b = z.object({ clientId: z.string().trim().max(250), clientSecret: z.string().trim().max(500).optional(), enabled: z.boolean() }).strict().parse(req.body);
    const cur = await google.state();
    if (b.clientId && !CLIENT_ID.test(b.clientId)) throw new HttpError(422, 'invalid_client_id', 'That does not look like a Google client ID. It ends with ".apps.googleusercontent.com".');
    if (b.clientSecret !== undefined && b.clientSecret !== '' && b.clientSecret.length < 10) throw new HttpError(422, 'invalid_client_secret', 'That client secret looks too short.');
    const secretWillExist = !!b.clientSecret || (cur.secretSet && cur.clientId === b.clientId);
    if (b.enabled && (!b.clientId || !secretWillExist)) throw new HttpError(422, 'incomplete', 'To turn Google sign-in on, enter both the client ID and the client secret.');
    // a different client ID without a new secret would pair the old secret with the wrong ID
    await google.save({ clientId: b.clientId, clientSecret: b.clientSecret || (cur.clientId === b.clientId ? undefined : ''), enabled: b.enabled });
    await audit(admin.userId, 'admin.google_config', req.ip, { enabled: b.enabled, clientId: b.clientId, secretChanged: !!b.clientSecret }); // never the secret itself
    return view(req);
  });

  /** Forget the saved Google settings (the environment's, if any, apply again). */
  app.delete('/admin/auth/google', async (req) => {
    const admin = requireAdmin(req);
    await google.clear();
    await audit(admin.userId, 'admin.google_config_cleared', req.ip);
    return view(req);
  });

  app.put('/admin/auth/public-url', async (req) => {
    const admin = requireAdmin(req);
    const b = z.object({ url: z.string().trim().max(200) }).strict().parse(req.body);
    if (b.url === '') {
      await db.query(`DELETE FROM application_settings WHERE key = 'public_url'`);
    } else {
      let u: URL;
      try { u = new URL(b.url); } catch { throw new HttpError(422, 'invalid_url', 'Enter a full address such as https://cloud.example.com'); }
      if (!['http:', 'https:'].includes(u.protocol) || u.pathname !== '/' || u.search || u.hash || u.username) {
        throw new HttpError(422, 'invalid_url', 'Enter just the address, with no path: for example https://cloud.example.com or http://192.168.1.50:8080');
      }
      await db.query(`INSERT INTO application_settings (key, value) VALUES ('public_url', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(u.origin)]);
    }
    await applyRuntimeSettings(db, config);
    google.invalidate();
    await audit(admin.userId, 'admin.public_url', req.ip, { url: b.url });
    return view(req);
  });

  /**
   * Checks what can be checked without signing in: the client ID's shape, that Google's servers can be reached from here, and the
   * redirect address to register. (The secret can only be proven by a real sign-in.)
   */
  app.post('/admin/auth/google/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    requireAdmin(req);
    const g = await google.state();
    const base = publicBase(config, req);
    let reachable = false;
    try { reachable = (await fetch('https://accounts.google.com/.well-known/openid-configuration', { signal: AbortSignal.timeout(6000) })).ok; } catch { reachable = false; }
    const problems: string[] = [];
    if (!g.clientId) problems.push('No client ID is saved yet.');
    else if (!CLIENT_ID.test(g.clientId)) problems.push('The client ID does not look like a Google client ID.');
    if (!g.secretSet) problems.push('No client secret is saved (or it can no longer be read because ENCRYPTION_KEY changed): enter it again.');
    if (!reachable) problems.push('This server could not reach accounts.google.com. Sign-in needs outbound internet access.');
    if (base.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(base)) problems.push('Google only accepts http redirect addresses for localhost. Use an https address (Administration > Sign-in > Public address) for anyone else.');
    return { ok: problems.length === 0, problems, redirectUri: redirectUriFor(base), reachable, note: 'The client secret itself can only be confirmed by actually signing in with Google once.' };
  });
};
