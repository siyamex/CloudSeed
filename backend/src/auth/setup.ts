import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { createIpPolicy } from '../downloads/ssrf.js';
import type { Db } from '../db/index.js';

/**
 * First-run setup: whoever finishes it becomes the administrator, so it must not be claimable by a stranger who reaches a fresh server
 * before its owner. On a private network (every address the request passed through is private) no code is needed. From anywhere else the
 * person must enter a code that is printed in the server's log, which only the owner can read.
 */
let code: string | null = null;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I)

export function setupCode(): string {
  if (!code) {
    const b = randomBytes(8);
    const c = [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('');
    code = `${c.slice(0, 4)}-${c.slice(4)}`;
  }
  return code;
}

export function codeMatches(given: string | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(given.trim().toUpperCase()), b = Buffer.from(setupCode());
  return a.length === b.length && timingSafeEqual(a, b);
}

const priv = createIpPolicy(''); // "blocked" here means private, loopback or otherwise not a public internet address
const clean = (raw: string): string => {
  let ip = raw.trim().replace(/^::ffff:/i, '');
  const bracket = /^\[(.+)\](?::\d+)?$/.exec(ip);
  if (bracket) ip = bracket[1]!.replace(/^::ffff:/i, '');
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(ip);
  return v4port ? v4port[1]! : ip;
};
/** Only a real address inside a private range counts; anything unreadable is treated as "could be anywhere". */
const isPrivate = (ip: string) => isIP(ip) !== 0 && priv.isBlocked(ip);

/** Every address the request claims to have come through, plus the connection itself. */
export function requestChain(req: FastifyRequest): string[] {
  const out: string[] = [];
  for (const h of ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'forwarded']) {
    const v = req.headers[h];
    if (typeof v !== 'string') continue;
    if (h === 'forwarded') { for (const m of v.matchAll(/for="?\[?([^\];,"\s]+)/gi)) out.push(m[1]!); continue; }
    out.push(...v.split(',').map((s) => s.trim()).filter(Boolean));
  }
  out.push(req.socket.remoteAddress ?? '');
  return out.map(clean);
}

/** True when the request comes from inside the owner's own network, so no setup code is asked for. */
export function isLocalRequest(req: FastifyRequest): boolean {
  const chain = requestChain(req);
  return chain.length > 0 && chain.every(isPrivate);
}

export async function needsSetup(db: Db): Promise<boolean> {
  return (await db.query(`SELECT 1 FROM users WHERE status <> 'deleted' LIMIT 1`)).rowCount === 0;
}
