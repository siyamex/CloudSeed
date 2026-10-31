import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.js';

export const sha256 = (s: string) => createHash('sha256').update(s).digest();
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface AuthContext {
  userId: string;
  email: string;
  roles: string[];
  sessionId: string;
  csrfToken: string;
}

export async function createSession(db: Db, userId: string, ttlHours: number, meta: { ua?: string; ip?: string }) {
  const token = randomToken();
  const csrf = randomToken(24);
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, csrf_token, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))`,
    [sha256(token), userId, csrf, meta.ua?.slice(0, 300) ?? null, meta.ip ?? null, ttlHours],
  );
  return token;
}

export async function loadSession(db: Db, token: string): Promise<AuthContext | null> {
  const r = await db.query<{ id: string; user_id: string; email: string; csrf_token: string; roles: string[] }>(
    `SELECT s.id, s.user_id, u.email, s.csrf_token,
            COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.status = 'active'
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
      WHERE s.token_hash = $1 AND s.expires_at > now()
      GROUP BY s.id, u.email`,
    [sha256(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  // "Last active" for the sessions list; at most once a minute so reads stay cheap.
  await db.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`, [row.id]).catch(() => undefined);
  return { userId: row.user_id, email: row.email, roles: row.roles, sessionId: row.id, csrfToken: row.csrf_token };
}
