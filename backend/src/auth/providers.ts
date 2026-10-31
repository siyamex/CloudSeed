import type { Config } from '../config.js';
import { deriveCookieSecure } from '../config.js';
import type { Vault } from '../crypto.js';
import type { Db } from '../db/index.js';
import { googleOidc, type OidcConfig } from './oidc.js';

/** Where the Google sign-in settings come from: the administrator's page (database) first, then the environment. */
export type GoogleSource = 'database' | 'environment' | 'none';

export interface GoogleState {
  source: GoogleSource;
  /** False when an administrator switched it off (even if the environment still has values). */
  enabled: boolean;
  clientId: string;
  secretSet: boolean;
}

const AAD = 'setting:google_client_secret';
const CALLBACK_PATH = '/api/v1/auth/google/callback';
export const redirectUriFor = (base: string) => `${base.replace(/\/+$/, '')}${CALLBACK_PATH}`;

async function readSettings(db: Db, keys: string[]): Promise<Map<string, unknown>> {
  const r = await db.query<{ key: string; value: unknown }>(`SELECT key, value FROM application_settings WHERE key = ANY($1)`, [keys]);
  return new Map(r.rows.map((x) => [x.key, x.value]));
}

export interface GoogleStore {
  /** The configuration to sign in with, or null when Google sign-in is not available. `base` is the address people reach this server on. */
  get(base: string): Promise<OidcConfig | null>;
  state(): Promise<GoogleState>;
  save(input: { clientId: string; clientSecret?: string; enabled: boolean }): Promise<void>;
  clear(): Promise<void>;
  /** Drop cached values (other processes pick changes up within seconds). */
  invalidate(): void;
}

export function createGoogleStore(db: Db, vault: Vault, config: Config): GoogleStore {
  let cache: { at: number; value: { id: string; secret: string; enabled: boolean; source: GoogleSource } } | null = null;
  const TTL = 10_000;

  async function load() {
    if (cache && Date.now() - cache.at < TTL) return cache.value;
    const m = await readSettings(db, ['google_client_id', 'google_client_secret_enc', 'google_enabled']);
    let value: NonNullable<typeof cache>['value'];
    const id = m.get('google_client_id'), enc = m.get('google_client_secret_enc'), enabled = m.get('google_enabled');
    if (typeof id === 'string' && id) {
      let secret = '';
      if (typeof enc === 'string' && enc) {
        try { secret = vault.decrypt(Buffer.from(enc, 'base64'), AAD); } catch { secret = ''; } // ENCRYPTION_KEY changed: treated as "no secret"
      }
      value = { id, secret, enabled: typeof enabled === 'boolean' ? enabled : true, source: 'database' };
    } else if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
      value = { id: config.GOOGLE_CLIENT_ID, secret: config.GOOGLE_CLIENT_SECRET, enabled: typeof enabled === 'boolean' ? enabled : true, source: 'environment' };
    } else {
      value = { id: '', secret: '', enabled: false, source: 'none' };
    }
    cache = { at: Date.now(), value };
    return value;
  }

  return {
    async get(base) {
      const v = await load();
      if (!v.enabled || !v.id || !v.secret) return null;
      // An address typed into GOOGLE_REDIRECT_URI wins for the environment's own credentials; otherwise it follows the public address.
      const redirect = v.source === 'environment' && config.GOOGLE_REDIRECT_URI ? config.GOOGLE_REDIRECT_URI : redirectUriFor(base);
      return googleOidc(v.id, v.secret, redirect);
    },
    async state() {
      const v = await load();
      return { source: v.source, enabled: v.enabled && !!v.id && !!v.secret, clientId: v.id, secretSet: !!v.secret };
    },
    async save({ clientId, clientSecret, enabled }) {
      const cur = await readSettings(db, ['google_client_secret_enc']);
      const enc = clientSecret ? vault.encrypt(clientSecret, AAD).toString('base64') : (cur.get('google_client_secret_enc') as string | undefined) ?? '';
      await db.tx(async (t) => {
        for (const [k, v] of [['google_client_id', clientId], ['google_client_secret_enc', enc], ['google_enabled', enabled]] as const) {
          await t.query(`INSERT INTO application_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [k, JSON.stringify(v)]);
        }
      });
      cache = null;
    },
    async clear() {
      await db.query(`DELETE FROM application_settings WHERE key IN ('google_client_id', 'google_client_secret_enc', 'google_enabled')`);
      cache = null;
    },
    invalidate() { cache = null; },
  };
}

// ------------------------------------------------------------------ the public address
/**
 * Reads the administrator's "public address" setting and applies it to the running configuration: links in emails and shares, the
 * redirect address for Google, and whether sign-in cookies are marked Secure. Called at start-up and every half minute, so every
 * process (API and worker) follows a change made in the admin panel.
 */
const original = new WeakMap<Config, { url: string; configured: boolean; secure: boolean }>();
export async function applyRuntimeSettings(db: Db, config: Config): Promise<void> {
  if (!original.has(config)) original.set(config, { url: config.PUBLIC_URL, configured: config.publicUrlConfigured, secure: config.cookieSecure });
  const base = original.get(config)!;
  const r = await db.query<{ value: unknown }>(`SELECT value FROM application_settings WHERE key = 'public_url'`);
  const v = r.rows[0]?.value;
  if (typeof v === 'string' && /^https?:\/\//.test(v)) {
    config.PUBLIC_URL = v;
    config.publicUrlConfigured = true;
    config.cookieSecure = deriveCookieSecure(config);
  } else { // no saved address (or it was cleared): back to what the environment said
    config.PUBLIC_URL = base.url;
    config.publicUrlConfigured = base.configured;
    config.cookieSecure = base.secure;
  }
}

export function watchRuntimeSettings(db: Db, config: Config, onError: (e: unknown) => void = () => undefined): NodeJS.Timeout {
  void applyRuntimeSettings(db, config).catch(onError);
  const t = setInterval(() => void applyRuntimeSettings(db, config).catch(onError), 30_000);
  t.unref();
  return t;
}
