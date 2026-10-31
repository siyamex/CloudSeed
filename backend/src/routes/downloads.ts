import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, type Deps } from '../app.js';
import { HttpError, badRequest, conflict, notFound } from '../errors.js';
import { validateName } from '../files/util.js';
import { FetchError, guardedFetch } from '../downloads/http.js';
import { BlockedDestinationError, createGuard } from '../downloads/ssrf.js';
import { createSse } from '../sse.js';
import { PRIORITIES, TERMINAL_STATES, deriveFilename, priorityName } from '../downloads/state.js';

const uuid = z.string().uuid();
const TERMINAL_SQL = TERMINAL_STATES.map((s) => `'${s}'`).join(',');

interface JobDb {
  id: string; url: string; state: string; priority: number; control: string | null; filename: string | null; folder_id: string | null;
  bytes_received: number; total_bytes: number | null; speed_bps: number; attempt: number; max_attempts: number;
  next_attempt_at: string; error_code: string | null; error_message: string | null; file_id: string | null;
  accepts_ranges: boolean | null; created_at: string; started_at: string | null; finished_at: string | null;
  updated_at: string; elapsed: number | null;
}

const COLS = `id, url, state, priority, control, filename, folder_id, bytes_received, total_bytes, speed_bps, attempt, max_attempts,
  next_attempt_at, error_code, error_message, file_id, accepts_ranges, created_at, started_at, finished_at, updated_at::text AS updated_at,
  CASE WHEN started_at IS NULL THEN NULL ELSE extract(epoch FROM (COALESCE(finished_at, now()) - started_at))::float END AS elapsed`;

export function jobDto(j: JobDb) {
  const total = j.total_bytes === null ? null : Number(j.total_bytes);
  const got = Number(j.bytes_received);
  const speed = Number(j.speed_bps);
  const downloading = j.state === 'downloading';
  return {
    id: j.id, url: j.url, state: j.state, priority: priorityName(j.priority), filename: j.filename, folderId: j.folder_id,
    bytesReceived: got, totalBytes: total,
    percent: j.state === 'completed' ? 100 : total && total > 0 ? Math.min(100, Math.round((got / total) * 1000) / 10) : null,
    speedBps: downloading ? speed : 0,
    elapsedSeconds: j.elapsed === null ? null : Math.round(Number(j.elapsed)),
    etaSeconds: downloading && total !== null && speed > 0 ? Math.ceil((total - got) / speed) : null,
    attempt: j.attempt, maxAttempts: j.max_attempts,
    nextAttemptAt: j.state === 'pending' ? j.next_attempt_at : null,
    error: j.error_code ? { code: j.error_code, message: j.error_message } : null,
    fileId: j.file_id, resumable: j.accepts_ranges,
    pendingControl: j.control, // a pause/cancel request a worker has not acted on yet
    createdAt: j.created_at, startedAt: j.started_at, finishedAt: j.finished_at, updatedAt: j.updated_at,
  };
}

export const downloadRoutes = (deps: Deps): FastifyPluginAsync => async (app) => {
  const { db, config } = deps;
  const guard = deps.guard ?? createGuard({ allowedCidrs: config.DOWNLOAD_ALLOWED_CIDRS, allowedPorts: config.DOWNLOAD_ALLOWED_PORTS });

  /** Fast feedback before queueing. The worker re-validates every connection regardless. */
  async function checkUrl(raw: string): Promise<URL> {
    let u: URL;
    try { u = guard.assertUrl(raw); await guard.assertResolvable(u); }
    catch (e) {
      if (e instanceof BlockedDestinationError) throw badRequest(e.message, 'blocked_destination');
      if (e instanceof TypeError) throw badRequest('That is not a valid URL', 'invalid_url');
      throw badRequest('Could not resolve that host', 'unresolvable_host');
    }
    return u;
  }

  const log = (jobId: string, kind: string, message: string) =>
    db.query(`INSERT INTO download_job_events (job_id, kind, message) VALUES ($1, $2, $3)`, [jobId, kind, message]);

  async function ownedJob(userId: string, id: string): Promise<JobDb> {
    const r = await db.query<JobDb>(`SELECT ${COLS} FROM download_jobs WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (!r.rows[0]) throw notFound('Download not found');
    return r.rows[0];
  }

  // ---- metadata preview ----
  app.post('/downloads/preview', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const a = requireAuth(req);
    const { url } = z.object({ url: z.string().min(1).max(2048) }).parse(req.body);
    await checkUrl(url);

    const opts = { guard, connectTimeoutMs: config.DOWNLOAD_CONNECT_TIMEOUT_MS, maxRedirects: config.DOWNLOAD_MAX_REDIRECTS };
    let res, finalUrl: URL;
    try {
      ({ res, url: finalUrl } = await guardedFetch(url, { ...opts, method: 'HEAD' }));
      if (res.statusCode! >= 400) { // many servers reject HEAD: probe with a 1-byte ranged GET instead
        res.resume();
        ({ res, url: finalUrl } = await guardedFetch(url, { ...opts, method: 'GET', headers: { range: 'bytes=0-0' } }));
      }
    } catch (e) {
      if (e instanceof BlockedDestinationError) throw badRequest(e.message, 'blocked_destination');
      if (e instanceof FetchError) throw new HttpError(502, 'source_unreachable', `Could not reach the source (${e.code})`);
      throw e;
    }
    res.destroy(); // we only need headers
    const status = res.statusCode ?? 0;
    if (status >= 400) throw new HttpError(502, 'source_error', `The source responded with HTTP ${status}`);

    let size: number | null = null;
    const cr = /\/(\d+)$/.exec(String(res.headers['content-range'] ?? ''));
    if (status === 206 && cr) size = Number(cr[1]);
    else if (res.headers['content-length'] !== undefined && Number.isFinite(Number(res.headers['content-length']))) size = Number(res.headers['content-length']);
    const acceptsRanges = status === 206 || String(res.headers['accept-ranges'] ?? '').toLowerCase() === 'bytes';
    const hasValidator = !!(res.headers.etag && !String(res.headers.etag).startsWith('W/')) || !!res.headers['last-modified'];

    const q = (await db.query<{ quota_bytes: number; used_bytes: number }>(`SELECT quota_bytes, used_bytes FROM storage_quotas WHERE user_id = $1`, [a.userId])).rows[0];
    const free = Math.max(0, (q?.quota_bytes ?? 0) - (q?.used_bytes ?? 0));
    const warnings: { code: string; message: string }[] = [];
    if (size !== null && size > config.MAX_FILE_SIZE_BYTES) warnings.push({ code: 'file_too_large', message: 'This file exceeds the maximum allowed download size' });
    else if (size !== null && size > free) warnings.push({ code: 'quota_exceeded', message: 'This file is larger than your free storage' });
    if (size === null) warnings.push({ code: 'unknown_size', message: 'The server did not report a size; the size limit is enforced while downloading' });

    return {
      finalUrl: finalUrl.href,
      filename: deriveFilename({ disposition: res.headers['content-disposition'] as string | undefined, url: finalUrl }),
      size, contentType: String(res.headers['content-type'] ?? '').split(';')[0] || null,
      acceptsRanges,
      resumable: acceptsRanges && hasValidator,
      warnings,
    };
  });

  // ---- create / list / get ----
  app.post('/downloads', async (req, reply) => {
    const a = requireAuth(req);
    const b = z.object({
      url: z.string().min(1).max(2048),
      folderId: uuid.nullable().optional(), // omitted = the user's default download folder, null = the root
      priority: z.enum(['low', 'normal', 'high']).default('normal'),
      filename: z.string().max(255).optional(),
      sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be a 64-character hex SHA-256').optional(),
      onConflict: z.enum(['reject', 'rename', 'replace']).default('rename'),
    }).parse(req.body);
    await checkUrl(b.url);
    const filename = b.filename ? validateName(b.filename) : null;

    let folderId = b.folderId ?? null;
    if (b.folderId === undefined) { // the default folder may since have been trashed; then the root is used
      const d = await db.query<{ id: string }>(
        `SELECT f.id FROM user_settings us JOIN folders f ON f.id = us.default_download_folder_id AND f.user_id = us.user_id AND f.deleted_at IS NULL WHERE us.user_id = $1`, [a.userId]);
      folderId = d.rows[0]?.id ?? null;
    } else if (b.folderId) {
      const f = await db.query(`SELECT 1 FROM folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [b.folderId, a.userId]);
      if (f.rowCount === 0) throw notFound('Folder not found');
    }
    const active = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM download_jobs WHERE user_id = $1 AND state NOT IN (${TERMINAL_SQL})`, [a.userId])).rows[0]!.n;
    if (active >= config.DOWNLOAD_MAX_ACTIVE_PER_USER) {
      throw new HttpError(429, 'too_many_downloads', `You already have ${active} unfinished downloads. Wait for some to finish or cancel them.`);
    }

    const r = await db.query<JobDb>(
      `INSERT INTO download_jobs (user_id, url, folder_id, filename, priority, expected_sha256, on_conflict, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLS}`,
      [a.userId, b.url, folderId, filename, PRIORITIES[b.priority], b.sha256?.toLowerCase() ?? null, b.onConflict, config.DOWNLOAD_MAX_ATTEMPTS]);
    await log(r.rows[0]!.id, 'created', 'queued');
    return reply.status(201).send(jobDto(r.rows[0]!));
  });

  app.get('/downloads', async (req) => {
    const a = requireAuth(req);
    const q = z.object({
      state: z.enum(['active', 'waiting', 'completed', 'failed', 'cancelled', 'paused']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().max(200).optional(),
    }).parse(req.query);
    const groups: Record<string, string> = {
      active: `state IN ('resolving','downloading','verifying')`, waiting: `state IN ('pending','queued')`,
      completed: `state = 'completed'`, failed: `state = 'failed'`, cancelled: `state = 'cancelled'`, paused: `state = 'paused'`,
    };
    const params: unknown[] = [a.userId];
    const where = ['user_id = $1'];
    if (q.state) where.push(groups[q.state]!);
    if (q.cursor) {
      let c: { t: string; id: string };
      try { c = z.object({ t: z.string(), id: uuid }).parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString())); }
      catch { throw badRequest('Invalid cursor', 'invalid_cursor'); }
      params.push(c.t, c.id);
      where.push(`(created_at::text, id) < ($${params.length - 1}, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    const rows = (await db.query<JobDb & { created_raw: string }>(
      `SELECT ${COLS}, created_at::text AS created_raw FROM download_jobs WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC LIMIT $${params.length}`, params)).rows;
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      jobs: page.map(jobDto),
      nextCursor: rows.length > q.limit && last ? Buffer.from(JSON.stringify({ t: last.created_raw, id: last.id })).toString('base64url') : null,
    };
  });

  // Live progress. Authenticated by the session cookie; each connection only ever sees its own user's jobs.
  const stream = createSse(app);
  app.get('/downloads/events', async (req, reply) => {
    const a = requireAuth(req);
    await stream(req, reply, {
      userId: a.userId, eventName: 'job',
      now: async () => (await db.query<{ t: string }>(`SELECT (now() - interval '2 seconds')::text AS t`)).rows[0]!.t,
      fetch: async (since) => (await db.query<JobDb>(
        `SELECT ${COLS} FROM download_jobs WHERE user_id = $1 AND updated_at > $2::timestamptz ORDER BY updated_at LIMIT 200`, [a.userId, since])).rows,
      toEvent: jobDto,
    });
  });

  app.get('/downloads/:id', async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const j = await ownedJob(a.userId, id);
    const ev = await db.query<{ kind: string; message: string; created_at: string }>(
      `SELECT kind, message, created_at FROM download_job_events WHERE job_id = $1 ORDER BY id DESC LIMIT 50`, [id]);
    return { ...jobDto(j), events: ev.rows.reverse().map((e) => ({ kind: e.kind, message: e.message, at: e.created_at })) };
  });

  // ---- controls ----
  const idParam = (req: { params: unknown }) => z.object({ id: uuid }).parse(req.params).id;

  app.post('/downloads/:id/pause', async (req) => {
    const a = requireAuth(req); const id = idParam(req);
    const direct = await db.query(`UPDATE download_jobs SET state = 'paused', updated_at = now() WHERE id = $1 AND user_id = $2 AND state IN ('queued','pending')`, [id, a.userId]);
    if (direct.rowCount === 0) {
      // Running: ask the owning worker, which acts within about a second and keeps the partial file.
      const ask = await db.query(`UPDATE download_jobs SET control = 'pause', updated_at = now() WHERE id = $1 AND user_id = $2 AND state IN ('resolving','downloading') AND control IS NULL`, [id, a.userId]);
      if (ask.rowCount === 0) {
        const j = await ownedJob(a.userId, id);
        throw conflict(j.state === 'verifying' ? 'The download is being finalised and can no longer be paused' : `A ${j.state} download cannot be paused`, 'invalid_state');
      }
    }
    await log(id, 'user', 'pause requested');
    return jobDto(await ownedJob(a.userId, id));
  });

  app.post('/downloads/:id/resume', async (req) => {
    const a = requireAuth(req); const id = idParam(req);
    const r = await db.query(`UPDATE download_jobs SET state = 'queued', next_attempt_at = now(), updated_at = now() WHERE id = $1 AND user_id = $2 AND state = 'paused'`, [id, a.userId]);
    if (r.rowCount === 0) { const j = await ownedJob(a.userId, id); throw conflict(`A ${j.state} download cannot be resumed`, 'invalid_state'); }
    await log(id, 'user', 'resumed');
    return jobDto(await ownedJob(a.userId, id));
  });

  app.post('/downloads/:id/cancel', async (req) => {
    const a = requireAuth(req); const id = idParam(req);
    const direct = await db.query(
      `UPDATE download_jobs SET state = 'cancelled', finished_at = now(), updated_at = now(), control = NULL WHERE id = $1 AND user_id = $2 AND state IN ('queued','pending','paused')`, [id, a.userId]);
    if (direct.rowCount === 0) {
      const ask = await db.query(`UPDATE download_jobs SET control = 'cancel', updated_at = now() WHERE id = $1 AND user_id = $2 AND state IN ('resolving','downloading','verifying')`, [id, a.userId]);
      if (ask.rowCount === 0) { const j = await ownedJob(a.userId, id); throw conflict(`A ${j.state} download cannot be cancelled`, 'invalid_state'); }
    }
    await log(id, 'user', 'cancel requested');
    return jobDto(await ownedJob(a.userId, id));
  });

  app.post('/downloads/:id/retry', async (req) => {
    const a = requireAuth(req); const id = idParam(req);
    const r = await db.query(
      `UPDATE download_jobs SET state = 'queued', attempt = 0, next_attempt_at = now(), error_code = NULL, error_message = NULL, finished_at = NULL,
              control = NULL, updated_at = now() WHERE id = $1 AND user_id = $2 AND state IN ('failed','cancelled')`, [id, a.userId]);
    if (r.rowCount === 0) { const j = await ownedJob(a.userId, id); throw conflict(`A ${j.state} download cannot be retried`, 'invalid_state'); }
    await log(id, 'user', 'retry requested');
    return jobDto(await ownedJob(a.userId, id));
  });

  app.patch('/downloads/:id', async (req) => {
    const a = requireAuth(req); const id = idParam(req);
    const b = z.object({ priority: z.enum(['low', 'normal', 'high']) }).parse(req.body);
    const r = await db.query(`UPDATE download_jobs SET priority = $3, updated_at = now() WHERE id = $1 AND user_id = $2 AND state NOT IN (${TERMINAL_SQL})`, [id, a.userId, PRIORITIES[b.priority]]);
    if (r.rowCount === 0) { const j = await ownedJob(a.userId, id); throw conflict(`The priority of a ${j.state} download cannot be changed`, 'invalid_state'); }
    return jobDto(await ownedJob(a.userId, id));
  });

  /** Removes the record of a finished download. A completed download's file is not touched. */
  app.delete('/downloads/:id', async (req, reply) => {
    const a = requireAuth(req); const id = idParam(req);
    const r = await db.query(`DELETE FROM download_jobs WHERE id = $1 AND user_id = $2 AND state IN (${TERMINAL_SQL})`, [id, a.userId]);
    if (r.rowCount === 0) { const j = await ownedJob(a.userId, id); throw conflict(`A ${j.state} download must finish or be cancelled before its record can be deleted`, 'invalid_state'); }
    return reply.status(204).send();
  });
};
