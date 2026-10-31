import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';

/**
 * Zero-input installs: the three values nobody should have to invent (the session secret, the encryption key and the database
 * password) are made on first start and kept in a folder that only the containers share (SECRETS_DIR, a Docker volume). Anything the
 * operator sets explicitly wins; `*_FILE` variables point at mounted secret files (Docker/Kubernetes secrets) instead.
 *
 * Several containers start at once and all call this. A file is written to a temporary name and then hard-linked into place, which
 * fails if it already exists, so exactly one writer wins and everyone ends up reading the same content.
 */
export const SECRET_FILES = {
  session_secret: () => randomBytes(48).toString('base64url'),
  encryption_key: () => randomBytes(32).toString('base64'),
  db_password: () => randomBytes(24).toString('base64url'),
} as const;
export type SecretName = keyof typeof SECRET_FILES;

/** The database container must be able to read its own password file; the others stay private to the app's user. */
const MODE: Record<SecretName, number> = { session_secret: 0o600, encryption_key: 0o600, db_password: 0o644 };

export function ensureSecret(dir: string, name: SecretName): { value: string; created: boolean } {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const read = () => readFileSync(file, 'utf8').trim();
  try { const v = read(); if (v) return { value: v, created: false }; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }

  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const value = SECRET_FILES[name]();
  const fd = openSync(tmp, 'wx', MODE[name]);
  try { writeSync(fd, `${value}\n`); } finally { closeSync(fd); }
  try { chmodSync(tmp, MODE[name]); } catch { /* not supported on this filesystem */ }
  try {
    linkSync(tmp, file); // fails if another process got there first
    return { value, created: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      // some filesystems cannot hard-link; a plain rename is the fallback (the race is then only between containers starting in the same instant)
      try { renameSync(tmp, file); return { value, created: true }; } catch { /* fall through to reading */ }
    }
    return { value: read(), created: false };
  } finally { rmSync(tmp, { force: true }); }
}

const fromFile = (p: string | undefined): string | undefined => {
  if (!p) return undefined;
  const v = readFileSync(p, 'utf8').trim();
  if (!v) throw new Error(`The secret file ${p} is empty`);
  return v;
};

/** Returns a copy of the environment with the secrets filled in. Never changes process.env. */
export function resolveSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const dir = env.SECRETS_DIR?.trim();
  const pick = (name: SecretName, key: string, fileKey: string): string | undefined => {
    if (out[key]) return out[key];
    const f = fromFile(env[fileKey]);
    if (f) return (out[key] = f);
    if (dir) return (out[key] = ensureSecret(dir, name).value);
    return undefined;
  };
  pick('session_secret', 'SESSION_SECRET', 'SESSION_SECRET_FILE');
  pick('encryption_key', 'ENCRYPTION_KEY', 'ENCRYPTION_KEY_FILE');
  if (!out.DATABASE_URL && out.DB_HOST) {
    const pw = pick('db_password', 'DB_PASSWORD', 'DB_PASSWORD_FILE') ?? '';
    // encoded by hand: the URL class leaves characters such as % alone, which would corrupt the address
    const host = /^[0-9a-f:]*:[0-9a-f:]*$/i.test(out.DB_HOST) ? `[${out.DB_HOST}]` : out.DB_HOST;
    out.DATABASE_URL = `postgres://${encodeURIComponent(out.DB_USER || 'cloudseed')}:${encodeURIComponent(pw)}@${host}:${out.DB_PORT || '5432'}/${encodeURIComponent(out.DB_NAME || 'cloudseed')}`;
  }
  return out;
}
