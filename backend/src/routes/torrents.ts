import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth, type Deps } from '../app.js';
import { HttpError, badRequest, conflict, notFound } from '../errors.js';
import { checkSelection } from '../torrents/selection.js';
import { torrentsEnabled } from '../torrents/enabled.js';
import { TORRENT_FILE_MAX, TorrentInputError, describeFiles, parseTorrentInput, safeSegment, type TorrentFileInfo } from '../torrents/policy.js';

const uuid = z.string().uuid();
const LIVE = `('pending', 'metadata', 'awaiting_selection', 'queued', 'downloading', 'paused', 'importing')`;

interface Row {
  id: string; source: string; name: string | null; info_hash: string; state: string; folder_id: string | null; result_folder_id: string | null;
  files: TorrentFileInfo[]; total_bytes: number | null; selected_bytes: number | null; bytes_done: number; peers: number; down_bps: number; up_bps: number;
  auto_start: boolean; error_code: string | null; error_message: string | null; imported_files: number; created_at: string; updated_at: string; finished_at: string | null;
  has_metainfo: boolean;
}
const COLS = `id, source, name, info_hash, state, folder_id, result_folder_id, files, total_bytes, selected_bytes, bytes_done, peers, down_bps, up_bps, auto_start,
  error_code, error_message, imported_files, created_at, updated_at, finished_at, (metainfo IS NOT NULL) AS has_metainfo`;

const dto = (r: Row, detail: boolean) => {
  const selected = Number(r.selected_bytes ?? r.total_bytes ?? 0);
  return {
    id: r.id, source: r.source, name: r.name, infoHash: r.info_hash, state: r.state, folderId: r.folder_id, resultFolderId: r.result_folder_id,
    fileCount: r.files.length, selectedCount: r.files.filter((f) => f.selected).length, importedFiles: r.imported_files,
    totalBytes: r.total_bytes === null ? null : Number(r.total_bytes), selectedBytes: r.selected_bytes === null ? null : Number(r.selected_bytes), bytesDone: Number(r.bytes_done),
    percent: selected > 0 ? Math.min(100, Math.round((100 * Number(r.bytes_done)) / selected)) : null,
    peers: r.peers, downBps: Number(r.down_bps), upBps: Number(r.up_bps), autoStart: r.auto_start,
    error: r.error_code ? { code: r.error_code, message: r.error_message } : null,
    createdAt: r.created_at, updatedAt: r.updated_at, finishedAt: r.finished_at,
    ...(detail ? { files: r.files } : {}),
  };
};

export const torrentRoutes = (deps: Deps): FastifyPluginAsync => async (app) => {
  const { db, config } = deps;

  const owned = async (userId: string, id: string): Promise<Row> => {
    const r = (await db.query<Row>(`SELECT ${COLS} FROM torrent_jobs WHERE id = $1 AND user_id = $2`, [id, userId])).rows[0];
    if (!r) throw notFound('Torrent not found');
    return r;
  };
  const needEnabled = async () => {
    if (!(await torrentsEnabled(db, config))) throw new HttpError(409, 'torrents_disabled', 'Torrent downloads are turned off on this server. An administrator can turn them on.');
  };
  const checkFolder = async (userId: string, folderId: string | null | undefined) => {
    if (folderId && !(await db.query(`SELECT 1 FROM folders WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [folderId, userId])).rowCount) throw notFound('Folder not found');
  };
  const checkRoom = async (userId: string) => {
    const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM torrent_jobs WHERE user_id = $1 AND state IN ${LIVE}`, [userId])).rows[0]!.n;
    if (n >= config.TORRENT_MAX_ACTIVE_PER_USER) throw new HttpError(429, 'too_many_torrents', `You already have ${n} unfinished torrents. Finish or cancel some first.`);
  };
  const asInputError = (e: unknown) => (e instanceof TorrentInputError ? badRequest(e.message, e.code) : e);
  const isDup = (e: unknown) => (e as { code?: string })?.code === '23505';

  app.get('/torrents/status', async (req) => {
    requireAuth(req);
    return {
      enabled: await torrentsEnabled(db, config),
      limits: { maxFiles: config.TORRENT_MAX_FILES, maxActivePerUser: config.TORRENT_MAX_ACTIVE_PER_USER, maxFileBytes: config.MAX_FILE_SIZE_BYTES, torrentFileMaxBytes: TORRENT_FILE_MAX },
      notice: 'Torrent downloads connect your server to strangers\' computers: they can see this server\'s internet address and which torrent it is downloading. Only download what you are allowed to, and consider a VPN.',
    };
  });

  app.get('/torrents', async (req) => {
    const a = requireAuth(req);
    const r = await db.query<Row>(`SELECT ${COLS} FROM torrent_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, [a.userId]);
    return { torrents: r.rows.map((x) => dto(x, false)) };
  });

  app.get('/torrents/:id', async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return dto(await owned(a.userId, id), true);
  });

  app.post('/torrents/magnet', async (req, reply) => {
    const a = requireAuth(req);
    await needEnabled();
    const b = z.object({ magnet: z.string().max(5000), folderId: uuid.nullish(), autoStart: z.boolean().default(false) }).parse(req.body);
    const parsed = await parseTorrentInput(b.magnet).catch((e) => { throw asInputError(e); });
    await checkFolder(a.userId, b.folderId);
    await checkRoom(a.userId);
    try {
      const r = await db.query<Row>(
        `INSERT INTO torrent_jobs (user_id, source, magnet, info_hash, name, folder_id, auto_start) VALUES ($1, 'magnet', $2, $3, $4, $5, $6) RETURNING ${COLS}`,
        [a.userId, b.magnet.trim(), parsed.infoHash.toLowerCase(), parsed.name ? safeSegment(parsed.name) : null, b.folderId ?? null, b.autoStart]);
      return reply.status(201).send(dto(r.rows[0]!, true));
    } catch (e) {
      if (isDup(e)) throw conflict('You are already downloading this torrent.', 'already_added');
      throw e;
    }
  });

  app.post('/torrents/file', async (req, reply) => {
    const a = requireAuth(req);
    await needEnabled();
    const q = z.object({ folder: z.union([z.literal('root'), uuid]).default('root'), autoStart: z.enum(['true', 'false']).default('false') }).parse(req.query);
    const folderId = q.folder === 'root' ? null : q.folder;
    await checkFolder(a.userId, folderId);
    await checkRoom(a.userId);
    if (!req.isMultipart()) throw badRequest('Send the .torrent file as a multipart upload', 'no_file');
    const part = await req.file();
    if (!part) throw badRequest('No file provided', 'no_file');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of part.file) {
      size += (c as Buffer).length;
      if (size > TORRENT_FILE_MAX) { part.file.resume(); throw badRequest(`A .torrent file can be at most ${TORRENT_FILE_MAX / 1024 / 1024} MB.`, 'torrent_too_large'); }
      chunks.push(c as Buffer);
    }
    const bytes = Buffer.concat(chunks);
    const parsed = await parseTorrentInput(bytes).catch((e) => { throw asInputError(e); });
    if (!parsed.files?.length) throw badRequest('That torrent has no files.', 'empty_torrent');
    if (parsed.files.length > config.TORRENT_MAX_FILES) throw new HttpError(422, 'too_many_files', `This torrent has ${parsed.files.length} files; the limit is ${config.TORRENT_MAX_FILES}.`);
    const files = describeFiles(parsed.files);
    const total = files.reduce((n, f) => n + f.size, 0);
    const verdict = await checkSelection(db, config, a.userId, files);
    const go = q.autoStart === 'true' && verdict === null;
    try {
      const r = await db.query<Row>(
        `INSERT INTO torrent_jobs (user_id, source, metainfo, info_hash, name, folder_id, auto_start, files, total_bytes, selected_bytes, state, error_code, error_message)
         VALUES ($1, 'file', $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11) RETURNING ${COLS}`,
        [a.userId, bytes, parsed.infoHash.toLowerCase(), safeSegment(parsed.name || 'Torrent'), folderId, q.autoStart === 'true', JSON.stringify(files), total,
          go ? 'queued' : 'awaiting_selection', q.autoStart === 'true' && verdict ? verdict.code : null, q.autoStart === 'true' && verdict ? verdict.message : null]);
      return reply.status(201).send(dto(r.rows[0]!, true));
    } catch (e) {
      if (isDup(e)) throw conflict('You are already downloading this torrent.', 'already_added');
      throw e;
    }
  });

  app.post('/torrents/:id/start', async (req) => {
    const a = requireAuth(req);
    await needEnabled();
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ files: z.array(z.number().int().min(0)).max(100_000).optional(), folderId: uuid.nullish() }).parse(req.body ?? {});
    const cur = await owned(a.userId, id);
    if (cur.state !== 'awaiting_selection') throw conflict('This torrent is not waiting for a choice of files.', 'invalid_state');
    await checkFolder(a.userId, b.folderId);
    const pick = b.files ? new Set(b.files) : null;
    if (pick) for (const i of pick) if (i >= cur.files.length) throw badRequest(`There is no file number ${i}.`, 'invalid_file');
    const files = cur.files.map((f) => ({ ...f, selected: pick ? pick.has(f.i) : true }));
    const verdict = await checkSelection(db, config, a.userId, files);
    if (verdict) throw new HttpError(422, verdict.code, verdict.message);
    const bytes = files.filter((f) => f.selected).reduce((n, f) => n + f.size, 0);
    await db.query(
      `UPDATE torrent_jobs SET files = $3, selected_bytes = $4, state = 'queued', folder_id = CASE WHEN $5::boolean THEN $6::uuid ELSE folder_id END, error_code = NULL, error_message = NULL,
              next_attempt_at = now(), updated_at = now() WHERE id = $1 AND user_id = $2 AND state = 'awaiting_selection'`,
      [id, a.userId, JSON.stringify(files), bytes, b.folderId !== undefined, b.folderId ?? null]);
    return dto(await owned(a.userId, id), true);
  });

  const RUNNING = ['metadata', 'downloading'];
  app.post('/torrents/:id/pause', async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const cur = await owned(a.userId, id);
    if (RUNNING.includes(cur.state)) await db.query(`UPDATE torrent_jobs SET control = 'pause', updated_at = now() WHERE id = $1 AND user_id = $2 AND state = ANY($3)`, [id, a.userId, RUNNING]);
    else if (cur.state === 'pending' || cur.state === 'queued') await db.query(`UPDATE torrent_jobs SET state = 'paused', updated_at = now() WHERE id = $1 AND user_id = $2 AND state IN ('pending', 'queued')`, [id, a.userId]);
    else throw conflict(`A ${cur.state.replace('_', ' ')} torrent cannot be paused.`, 'invalid_state');
    return dto(await owned(a.userId, id), false);
  });

  app.post('/torrents/:id/resume', async (req) => {
    const a = requireAuth(req);
    await needEnabled();
    const { id } = z.object({ id: uuid }).parse(req.params);
    const cur = await owned(a.userId, id);
    if (cur.state !== 'paused') throw conflict('Only a paused torrent can be resumed.', 'invalid_state');
    await db.query(`UPDATE torrent_jobs SET state = CASE WHEN metainfo IS NULL THEN 'pending' ELSE 'queued' END, next_attempt_at = now(), updated_at = now() WHERE id = $1 AND user_id = $2 AND state = 'paused'`, [id, a.userId]);
    return dto(await owned(a.userId, id), false);
  });

  app.post('/torrents/:id/cancel', async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const cur = await owned(a.userId, id);
    if (['completed', 'failed', 'cancelled'].includes(cur.state)) throw conflict('This torrent has already finished.', 'invalid_state');
    if (RUNNING.includes(cur.state)) await db.query(`UPDATE torrent_jobs SET control = 'cancel', updated_at = now() WHERE id = $1 AND user_id = $2 AND state = ANY($3)`, [id, a.userId, RUNNING]);
    else if (cur.state === 'importing') throw conflict('The files are being moved into your storage; this cannot be cancelled now.', 'invalid_state');
    else await db.query(`UPDATE torrent_jobs SET state = 'cancelled', finished_at = now(), updated_at = now() WHERE id = $1 AND user_id = $2 AND state IN ('pending', 'queued', 'paused', 'awaiting_selection')`, [id, a.userId]);
    return dto(await owned(a.userId, id), false);
  });

  app.post('/torrents/:id/retry', async (req) => {
    const a = requireAuth(req);
    await needEnabled();
    const { id } = z.object({ id: uuid }).parse(req.params);
    const cur = await owned(a.userId, id);
    if (cur.state !== 'failed' && cur.state !== 'cancelled') throw conflict('Only a failed or cancelled torrent can be retried.', 'invalid_state');
    const next = !cur.has_metainfo ? 'pending' : cur.files.some((f) => f.selected) && cur.error_code !== 'nothing_selected' && cur.error_code !== 'quota_exceeded' && cur.error_code !== 'file_too_large' ? 'queued' : 'awaiting_selection';
    try {
      await db.query(
        `UPDATE torrent_jobs SET state = $3, attempt = 0, error_code = NULL, error_message = NULL, finished_at = NULL, control = NULL, next_attempt_at = now(), updated_at = now()
          WHERE id = $1 AND user_id = $2 AND state IN ('failed', 'cancelled')`, [id, a.userId, next]);
    } catch (e) {
      if (isDup(e)) throw conflict('You are already downloading this torrent.', 'already_added');
      throw e;
    }
    return dto(await owned(a.userId, id), true);
  });

  app.delete('/torrents/:id', async (req, reply) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const cur = await owned(a.userId, id);
    if (!['completed', 'failed', 'cancelled'].includes(cur.state)) throw conflict('Cancel the torrent before removing it.', 'invalid_state');
    await db.query(`DELETE FROM torrent_jobs WHERE id = $1 AND user_id = $2`, [id, a.userId]);
    return reply.status(204).send();
  });
};
