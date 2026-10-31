import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import { hashPassword, verifyPassword } from './password.js';

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;
const FAILS_BEFORE_LOCK = 5;
const BASE_LOCK_MINUTES = 15;
const MAX_LOCK_MINUTES = 24 * 60;

/** null when the password is acceptable, otherwise a sentence to show the person choosing it. */
export function checkPasswordPolicy(password: string, email?: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (new Set(password).size < 4) return 'That password is too repetitive. Mix more different characters.';
  const lower = password.toLowerCase();
  if (email && (lower === email.toLowerCase() || lower.includes(email.toLowerCase().split('@')[0]!) && email.split('@')[0]!.length >= 4)) return 'The password should not contain your email address.';
  if (['password', '1234567890', 'qwertyuiop', 'cloudseed', 'letmein123', 'administrator'].some((w) => lower.includes(w))) return 'That password is too easy to guess.';
  return null;
}

// A real hash to compare against when the email is unknown, so "no such account" costs the same time as "wrong password".
let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= hashPassword('not-a-real-password-for-timing-only'));

/** Failed tries for emails that do not exist (those have no row to keep a counter in), so unknown and known accounts behave alike. */
const unknownTries = new Map<string, { count: number; until: number }>();
const emailKey = (email: string) => createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 24);
const lockMinutes = (fails: number) => Math.min(MAX_LOCK_MINUTES, BASE_LOCK_MINUTES * 2 ** Math.floor((fails - FAILS_BEFORE_LOCK) / FAILS_BEFORE_LOCK));

export type LoginResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'locked'; retryAfterSeconds: number }
  | { ok: false; reason: 'disabled' };

/**
 * Checks an email and password. Wrong email and wrong password give the same answer in about the same time; after five wrong tries the
 * account (or the email, if it does not exist) is locked for 15 minutes, doubling with every further five, up to a day.
 */
export async function verifyLocalLogin(db: Db, email: string, password: string): Promise<LoginResult> {
  const key = emailKey(email);
  const row = (await db.query<{ id: string; status: string; password_hash: string; failed_attempts: number; locked_until: string | null }>(
    `SELECT u.id, u.status, c.password_hash, c.failed_attempts, c.locked_until FROM users u JOIN local_credentials c ON c.user_id = u.id
      WHERE lower(u.email) = lower($1) AND u.status <> 'deleted'`, [email])).rows[0];

  if (!row) {
    const t = unknownTries.get(key);
    if (t && t.until > Date.now()) return { ok: false, reason: 'locked', retryAfterSeconds: Math.ceil((t.until - Date.now()) / 1000) };
    await verifyPassword(password, await dummyHash());
    const count = (t?.count ?? 0) + 1;
    unknownTries.set(key, { count, until: count >= FAILS_BEFORE_LOCK ? Date.now() + lockMinutes(count) * 60_000 : 0 });
    if (unknownTries.size > 5000) for (const [k, v] of unknownTries) if (v.until < Date.now() && v.count < FAILS_BEFORE_LOCK) unknownTries.delete(k);
    return { ok: false, reason: 'invalid' };
  }

  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    return { ok: false, reason: 'locked', retryAfterSeconds: Math.ceil((new Date(row.locked_until).getTime() - Date.now()) / 1000) };
  }
  if (!(await verifyPassword(password, row.password_hash))) {
    const fails = row.failed_attempts + 1;
    await db.query(
      `UPDATE local_credentials SET failed_attempts = $2::int, locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(mins => $4::int) ELSE locked_until END WHERE user_id = $1`,
      [row.id, fails, FAILS_BEFORE_LOCK, fails >= FAILS_BEFORE_LOCK ? lockMinutes(fails) : 0]);
    return { ok: false, reason: 'invalid' };
  }
  if (row.failed_attempts > 0 || row.locked_until) await db.query(`UPDATE local_credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1`, [row.id]);
  unknownTries.delete(key);
  if (row.status !== 'active') return { ok: false, reason: 'disabled' }; // only said after the right password, so it reveals nothing to a guesser
  return { ok: true, userId: row.id };
}

/** Sets (or replaces) a user's password and clears any lock. */
export async function setPassword(db: Db, userId: string, password: string): Promise<void> {
  const hash = await hashPassword(password);
  await db.query(
    `INSERT INTO local_credentials (user_id, password_hash) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_attempts = 0, locked_until = NULL, updated_at = now()`, [userId, hash]);
}
