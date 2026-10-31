import { sanitizeName } from '../files/util.js';

export const JOB_STATES = ['pending', 'queued', 'resolving', 'downloading', 'paused', 'verifying', 'completed', 'failed', 'cancelled'] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Being executed by a worker right now (holds a lease). */
export const ACTIVE_STATES: JobState[] = ['resolving', 'downloading', 'verifying'];
/** Waiting for a worker: `queued` is ready, `pending` is waiting out a retry backoff. */
export const WAITING_STATES: JobState[] = ['pending', 'queued'];
export const TERMINAL_STATES: JobState[] = ['completed', 'failed', 'cancelled'];

const TRANSITIONS: Record<JobState, JobState[]> = {
  pending: ['queued', 'paused', 'cancelled', 'resolving'],
  queued: ['pending', 'paused', 'cancelled', 'resolving'],
  resolving: ['downloading', 'pending', 'queued', 'paused', 'failed', 'cancelled'],
  downloading: ['verifying', 'pending', 'queued', 'paused', 'failed', 'cancelled'],
  verifying: ['completed', 'pending', 'queued', 'failed', 'cancelled'],
  paused: ['queued', 'cancelled'],
  failed: ['queued'], // manual retry
  cancelled: ['queued'], // manual retry
  completed: [],
};

export const canTransition = (from: JobState, to: JobState) => TRANSITIONS[from].includes(to);
export const statesAllowedBefore = (to: JobState): JobState[] => JOB_STATES.filter((s) => canTransition(s, to));
export const isTerminal = (s: JobState) => TERMINAL_STATES.includes(s);

export const PRIORITIES = { low: 0, normal: 1, high: 2 } as const;
export const priorityName = (n: number) => (n >= 2 ? 'high' : n <= 0 ? 'low' : 'normal');

/** Raised for failures the engine understands; `permanent` failures are never retried automatically. */
export class DownloadError extends Error {
  constructor(public readonly code: string, message: string, public readonly permanent = false, public readonly retryAfterMs?: number) {
    super(message);
  }
}

/** Exponential backoff with jitter: base * 2^(attempt-1), scaled by a random factor in [0.5, 1.5), capped at max. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number, rand: () => number = Math.random): number {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(maxMs, Math.round(exp * (0.5 + rand())));
}

/** Retry-After as seconds or an HTTP date -> milliseconds (capped at one hour). */
export function parseRetryAfter(v: string | undefined, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(v) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 3_600_000) : undefined;
}

/** HTTP status -> retry policy. 408/425/429 and 5xx are transient; other 4xx are permanent. */
export function classifyStatus(status: number, retryAfter?: string): DownloadError {
  const ra = parseRetryAfter(retryAfter);
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return new DownloadError(status === 429 ? 'rate_limited' : 'http_error', `Server responded with HTTP ${status}`, false, ra);
  }
  const msg = status === 404 ? 'File not found (HTTP 404)' : status === 401 || status === 403 ? `Access denied (HTTP ${status}); authenticated sources are not supported` : `Server responded with HTTP ${status}`;
  return new DownloadError(status === 404 ? 'not_found' : status === 401 || status === 403 ? 'access_denied' : 'http_error', msg, true);
}

/** Extracts a filename from Content-Disposition (RFC 6266, filename* preferred). */
export function filenameFromDisposition(h: string | undefined): string | null {
  if (!h) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(h);
  if (star) { try { return decodeURIComponent(star[1]!.trim()); } catch { /* fall through */ } }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(h);
  if (quoted) return quoted[1]!.replace(/\\(.)/g, '$1');
  const bare = /filename\s*=\s*([^;]+)/i.exec(h);
  return bare ? bare[1]!.trim() : null;
}

/** Chooses a safe filename: explicit > Content-Disposition > last URL path segment > "download". */
export function deriveFilename(opts: { explicit?: string | null; disposition?: string; url: URL }): string {
  const candidates = [opts.explicit, filenameFromDisposition(opts.disposition)];
  try { candidates.push(decodeURIComponent(opts.url.pathname.split('/').filter(Boolean).pop() ?? '')); } catch { /* ignore */ }
  for (const c of candidates) {
    if (!c) continue;
    try { return sanitizeName(c); } catch { /* try next */ }
  }
  return 'download';
}
