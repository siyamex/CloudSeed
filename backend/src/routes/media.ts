import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { adapterFor, requireAuth, type Deps } from '../app.js';
import { HttpError, badRequest, conflict, notFound } from '../errors.js';
import { serveObject } from '../files/serve.js';
import { contentDisposition } from '../files/util.js';
import { MAX_SUBTITLE_BYTES, formatFor, matchSubtitle, playability, srtToVtt, type StreamInfo } from '../media/classify.js';
import { TRANSCODE_PROFILES } from '../media/ffmpeg.js';

const uuid = z.string().uuid();
const SORTS: Record<string, { expr: string; cast: string }> = {
  date: { expr: 'f.created_at', cast: 'timestamptz' },
  title: { expr: "lower(COALESCE(m.title, f.name))", cast: 'text' },
  duration: { expr: 'COALESCE(m.duration_ms, 0)', cast: 'bigint' },
  size: { expr: 'f.size_bytes', cast: 'bigint' },
};

interface ListRow {
  file_id: string; name: string; size_bytes: number; folder_id: string | null; created_at: string; kind: string; status: string; error_message: string | null;
  duration_ms: number | null; width: number | null; height: number | null; container: string | null; video_codec: string | null; audio_codec: string | null; bitrate: number | null;
  title: string | null; tags: Record<string, string>; has_thumb: boolean; position_ms: number | null; p_duration: number | null; completed: boolean | null; watched_at: string | null; sort_v: string;
}

const BASE = `SELECT m.file_id, f.name, f.size_bytes, f.folder_id, f.created_at, m.kind, m.status, m.error_message, m.duration_ms, m.width, m.height, m.container,
    m.video_codec, m.audio_codec, m.bitrate, m.title, m.tags,
    EXISTS (SELECT 1 FROM media_assets a WHERE a.file_id = m.file_id AND a.kind = 'thumbnail' AND a.status = 'ready') AS has_thumb,
    p.position_ms, p.duration_ms AS p_duration, p.completed, p.updated_at AS watched_at
  FROM media_metadata m JOIN files f ON f.id = m.file_id
  LEFT JOIN media_playback_progress p ON p.file_id = m.file_id AND p.user_id = m.user_id`;

const listDto = (r: ListRow) => ({
  id: r.file_id, name: r.name, title: r.title ?? r.name, kind: r.kind, status: r.status, error: r.status === 'failed' || r.status === 'unsupported' ? r.error_message : null,
  size: Number(r.size_bytes), folderId: r.folder_id, createdAt: r.created_at,
  durationMs: r.duration_ms === null ? null : Number(r.duration_ms), width: r.width, height: r.height, container: r.container, videoCodec: r.video_codec, audioCodec: r.audio_codec,
  bitrate: r.bitrate === null ? null : Number(r.bitrate), artist: r.tags?.artist ?? null, album: r.tags?.album ?? null, hasThumbnail: r.has_thumb,
  progress: r.position_ms === null ? null : { positionMs: Number(r.position_ms), durationMs: r.p_duration === null ? null : Number(r.p_duration), completed: !!r.completed, updatedAt: r.watched_at },
});

export const mediaRoutes = (deps: Deps): FastifyPluginAsync => async (app) => {
  const { db, config } = deps;
  const ad = (kind: string) => adapterFor(deps, kind);

  /** The caller's own, non-trashed media file that has an index row; anything else is a 404. */
  async function ownedMedia(userId: string, id: string) {
    const r = await db.query<{ name: string; size_bytes: number; storage_key: string; storage_provider_kind: string; sha256: string | null; folder_id: string | null; kind: string; status: string }>(
      `SELECT f.name, f.size_bytes, f.storage_key, f.storage_provider_kind, f.sha256, f.folder_id, m.kind, m.status
         FROM files f JOIN media_metadata m ON m.file_id = f.id WHERE f.id = $1 AND f.user_id = $2 AND f.deleted_at IS NULL AND f.status = 'ready'`, [id, userId]);
    if (!r.rows[0]) throw notFound('Media file not found');
    return r.rows[0];
  }

  // ---------------------------------------------------------------- library
  app.get('/media', async (req) => {
    const a = requireAuth(req);
    const q = z.object({
      type: z.enum(['video', 'audio']).optional(),
      q: z.string().max(200).optional(),
      sort: z.enum(['date', 'title', 'duration', 'size']).default('date'),
      dir: z.enum(['asc', 'desc']).default('desc'),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      progress: z.enum(['inprogress', 'completed', 'unwatched']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(40),
      cursor: z.string().max(500).optional(),
    }).parse(req.query);
    const s = SORTS[q.sort]!;
    const params: unknown[] = [a.userId];
    const where = ['m.user_id = $1', 'f.deleted_at IS NULL'];
    if (q.type) { params.push(q.type); where.push(`m.kind = $${params.length}`); }
    if (q.q) { params.push(`%${q.q.replace(/[\\%_]/g, '\\$&')}%`); where.push(`(f.name ILIKE $${params.length} OR m.title ILIKE $${params.length} OR m.tags->>'artist' ILIKE $${params.length} OR m.tags->>'album' ILIKE $${params.length})`); }
    if (q.from) { params.push(q.from); where.push(`f.created_at >= $${params.length}::timestamptz`); }
    if (q.to) { params.push(q.to); where.push(`f.created_at <= $${params.length}::timestamptz`); }
    if (q.progress === 'inprogress') where.push('p.position_ms > 0 AND NOT COALESCE(p.completed, FALSE)');
    if (q.progress === 'completed') where.push('p.completed');
    if (q.progress === 'unwatched') where.push('p.position_ms IS NULL');
    if (q.cursor) {
      let c: { v: string; id: string };
      try { c = z.object({ v: z.string(), id: uuid }).parse(JSON.parse(Buffer.from(q.cursor, 'base64url').toString())); }
      catch { throw badRequest('Invalid cursor', 'invalid_cursor'); }
      params.push(c.v, c.id);
      where.push(`(${s.expr}, m.file_id) ${q.dir === 'asc' ? '>' : '<'} ($${params.length - 1}::${s.cast}, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);
    const rows = (await db.query<ListRow>(
      `${BASE.replace('SELECT m.file_id,', `SELECT (${s.expr})::text AS sort_v, m.file_id,`)} WHERE ${where.join(' AND ')}
        ORDER BY ${s.expr} ${q.dir}, m.file_id ${q.dir} LIMIT $${params.length}`, params)).rows;
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(listDto),
      nextCursor: rows.length > q.limit && last ? Buffer.from(JSON.stringify({ v: last.sort_v, id: last.file_id })).toString('base64url') : null,
    };
  });

  // ---------------------------------------------------------------- one item
  app.get('/media/:id', async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = (await db.query<ListRow & { streams: StreamInfo[] }>(`${BASE.replace('m.container,', 'm.streams, m.container,')} WHERE m.file_id = $1 AND m.user_id = $2 AND f.deleted_at IS NULL`, [id, a.userId])).rows[0];
    if (!r) throw notFound('Media file not found');
    const item = listDto(r);
    const streams: StreamInfo[] = Array.isArray(r.streams) ? r.streams : [];

    const assets = (await db.query<{ id: string; kind: string; variant: string; status: string; progress: number; size_bytes: number; error_message: string | null }>(
      `SELECT id, kind, variant, status, progress, size_bytes, error_message FROM media_assets WHERE file_id = $1 AND user_id = $2`, [id, a.userId])).rows;
    const ready = (kind: string, variant: string) => assets.find((x) => x.kind === kind && x.variant === variant && x.status === 'ready');

    const subtitles: { id: string; source: 'embedded' | 'file'; label: string; language: string | null; available: boolean; reason?: string; linkId?: string }[] = [];
    for (const s of streams.filter((x) => x.type === 'subtitle')) {
      const ok = !!ready('subtitle', String(s.index));
      subtitles.push({
        id: `emb-${s.index}`, source: 'embedded', label: s.title ?? s.language ?? `Track ${s.index}`, language: s.language, available: ok,
        ...(ok ? {} : { reason: s.extractable ? 'Not extracted yet' : 'Image-based subtitles (e.g. PGS/VobSub) cannot be shown in a browser' }),
      });
    }
    const links = (await db.query<{ id: string; subtitle_file_id: string; label: string | null; language: string | null; name: string }>(
      `SELECT l.id, l.subtitle_file_id, l.label, l.language, f.name FROM media_subtitle_links l JOIN files f ON f.id = l.subtitle_file_id AND f.deleted_at IS NULL
        WHERE l.media_file_id = $1 AND l.user_id = $2`, [id, a.userId])).rows;
    const seen = new Set<string>();
    for (const l of links) { seen.add(l.subtitle_file_id); subtitles.push({ id: `ext-${l.subtitle_file_id}`, source: 'file', label: l.label ?? l.name, language: l.language, available: true, linkId: l.id }); }
    const siblings = (await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM files WHERE user_id = $1 AND deleted_at IS NULL AND status = 'ready' AND COALESCE(folder_id, '00000000-0000-0000-0000-000000000000') = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000') AND id <> $3 LIMIT 500`,
      [a.userId, (await db.query<{ folder_id: string | null }>('SELECT folder_id FROM files WHERE id = $1', [id])).rows[0]!.folder_id, id])).rows;
    for (const f of siblings) {
      const m = matchSubtitle(r.name, f.name);
      if (m && !seen.has(f.id)) subtitles.push({ id: `ext-${f.id}`, source: 'file', label: f.name, language: m.language, available: true });
    }

    const probe = { container: r.container, videoCodec: r.video_codec, audioCodec: r.audio_codec, hasVideo: r.kind === 'video' && r.video_codec !== null, hasAudio: r.audio_codec !== null };
    return {
      ...item,
      audioTracks: streams.filter((x) => x.type === 'audio').map((x) => ({ index: x.index, codec: x.codec, language: x.language, title: x.title, channels: x.channels ?? null, default: x.default })),
      subtitles,
      playback: r.status === 'ready' ? playability(r.name, probe) : { mode: r.status === 'pending' || r.status === 'processing' ? 'direct' : 'transcode', reason: r.status === 'unsupported' ? r.error_message : null },
      renditions: assets.filter((x) => x.kind === 'rendition').map((x) => ({ profile: x.variant, status: x.status, progress: x.progress, size: Number(x.size_bytes), error: x.error_message })),
      transcoding: { enabled: config.MEDIA_TRANSCODING_ENABLED, profiles: Object.values(TRANSCODE_PROFILES).filter((p) => p.kind === r.kind).map((p) => ({ name: p.name, description: p.description })) },
    };
  });

  // ---------------------------------------------------------------- bytes
  /** Streams the original (or a converted copy) with Range support, authorised on every request. */
  app.get('/media/:id/stream', async (req, reply) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { rendition } = z.object({ rendition: z.string().max(40).optional() }).parse(req.query);
    const f = await ownedMedia(a.userId, id);
    const fmt = formatFor(f.name);
    if (!fmt) throw new HttpError(415, 'not_media', 'This file is not a supported media type');

    if (rendition) {
      const asset = (await db.query<{ storage_key: string; storage_provider_kind: string; size_bytes: number }>(
        `SELECT storage_key, storage_provider_kind, size_bytes FROM media_assets WHERE file_id = $1 AND user_id = $2 AND kind = 'rendition' AND variant = $3 AND status = 'ready'`, [id, a.userId, rendition])).rows[0];
      if (!asset) throw notFound('That converted copy does not exist');
      return serveObject(reply, ad(asset.storage_provider_kind), asset.storage_key, {
        size: Number(asset.size_bytes), mime: fmt.kind === 'audio' ? 'audio/mp4' : 'video/mp4', disposition: contentDisposition(f.name).replace('attachment', 'inline'),
        rangeHeader: req.headers.range, cacheControl: 'private, no-cache',
      });
    }
    return serveObject(reply, ad(f.storage_provider_kind), f.storage_key, {
      size: Number(f.size_bytes), mime: fmt.mime, etag: f.sha256, disposition: contentDisposition(f.name).replace('attachment', 'inline'),
      rangeHeader: req.headers.range, cacheControl: 'private, no-cache',
    });
  });

  app.get('/media/:id/thumbnail', async (req, reply) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await ownedMedia(a.userId, id);
    const t = (await db.query<{ storage_key: string; storage_provider_kind: string; size_bytes: number }>(
      `SELECT storage_key, storage_provider_kind, size_bytes FROM media_assets WHERE file_id = $1 AND user_id = $2 AND kind = 'thumbnail' AND status = 'ready'`, [id, a.userId])).rows[0];
    if (!t) throw notFound('No thumbnail');
    return serveObject(reply, ad(t.storage_provider_kind), t.storage_key, {
      size: Number(t.size_bytes), mime: 'image/jpeg', disposition: 'inline', rangeHeader: undefined, cacheControl: 'private, max-age=3600',
    });
  });

  // ---------------------------------------------------------------- subtitles
  const readAll = async (adapter: ReturnType<typeof ad>, key: string, size: number) => {
    const chunks: Buffer[] = [];
    for await (const c of await adapter.get(key)) { chunks.push(c as Buffer); if (chunks.reduce((n, b) => n + b.length, 0) > size + 16) break; }
    return Buffer.concat(chunks);
  };
  const decode = (b: Buffer) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return new TextDecoder('windows-1252').decode(b); } };

  app.get('/media/:id/subtitles/:track', async (req, reply) => {
    const a = requireAuth(req);
    const { id, track } = z.object({ id: uuid, track: z.string().max(60).regex(/^(emb-\d{1,3}|ext-[0-9a-f-]{36})(\.vtt)?$/) }).parse(req.params);
    const f = await ownedMedia(a.userId, id);
    const name = track.replace(/\.vtt$/, '');
    let vtt: string;
    if (name.startsWith('emb-')) {
      const asset = (await db.query<{ storage_key: string; storage_provider_kind: string; size_bytes: number }>(
        `SELECT storage_key, storage_provider_kind, size_bytes FROM media_assets WHERE file_id = $1 AND user_id = $2 AND kind = 'subtitle' AND variant = $3 AND status = 'ready'`, [id, a.userId, name.slice(4)])).rows[0];
      if (!asset) throw notFound('Subtitle track not found');
      vtt = (await readAll(ad(asset.storage_provider_kind), asset.storage_key, Number(asset.size_bytes))).toString('utf8');
    } else {
      const sid = name.slice(4);
      const sub = (await db.query<{ name: string; size_bytes: number; storage_key: string; storage_provider_kind: string; folder_id: string | null }>(
        `SELECT name, size_bytes, storage_key, storage_provider_kind, folder_id FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL AND status = 'ready'`, [sid, a.userId])).rows[0];
      if (!sub) throw notFound('Subtitle file not found');
      // Only subtitles that belong to this video: explicitly linked, or named like it in the same folder.
      const linked = (await db.query(`SELECT 1 FROM media_subtitle_links WHERE media_file_id = $1 AND subtitle_file_id = $2 AND user_id = $3`, [id, sid, a.userId])).rowCount > 0;
      if (!linked && !(sub.folder_id === f.folder_id && matchSubtitle(f.name, sub.name))) throw notFound('Subtitle file not found');
      if (Number(sub.size_bytes) > MAX_SUBTITLE_BYTES) throw new HttpError(413, 'subtitle_too_large', 'That subtitle file is too large');
      vtt = srtToVtt(decode(await readAll(ad(sub.storage_provider_kind), sub.storage_key, Number(sub.size_bytes))));
    }
    return reply.header('content-type', 'text/vtt; charset=utf-8').header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox").header('cache-control', 'private, no-cache').send(vtt);
  });

  app.post('/media/:id/subtitles', async (req, reply) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ fileId: uuid, label: z.string().trim().max(100).optional(), language: z.string().trim().max(20).optional() }).parse(req.body);
    await ownedMedia(a.userId, id);
    const sub = (await db.query<{ name: string }>(`SELECT name FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL AND status = 'ready'`, [b.fileId, a.userId])).rows[0];
    if (!sub) throw notFound('Subtitle file not found');
    if (!/\.(srt|vtt)$/i.test(sub.name)) throw badRequest('Only .srt and .vtt subtitle files are supported', 'unsupported_subtitle');
    const r = await db.query<{ id: string }>(
      `INSERT INTO media_subtitle_links (user_id, media_file_id, subtitle_file_id, label, language) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (media_file_id, subtitle_file_id) DO UPDATE SET label = EXCLUDED.label, language = EXCLUDED.language RETURNING id`,
      [a.userId, id, b.fileId, b.label ?? null, b.language ?? null]);
    return reply.status(201).send({ id: r.rows[0]!.id, trackId: `ext-${b.fileId}` });
  });

  app.delete('/media/:id/subtitles/:linkId', async (req, reply) => {
    const a = requireAuth(req);
    const { id, linkId } = z.object({ id: uuid, linkId: uuid }).parse(req.params);
    const r = await db.query(`DELETE FROM media_subtitle_links WHERE id = $1 AND media_file_id = $2 AND user_id = $3`, [linkId, id, a.userId]);
    if (r.rowCount === 0) throw notFound('Subtitle link not found');
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- playback progress
  app.put('/media/:id/progress', async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ positionMs: z.number().int().min(0).max(1e11), durationMs: z.number().int().min(0).max(1e11).nullish() }).parse(req.body);
    await ownedMedia(a.userId, id);
    const dur = b.durationMs && b.durationMs > 0 ? b.durationMs : null;
    // "Finished" = past 95%, or within the last 20 s of anything longer than two minutes (end credits); for short clips
    // only the percentage counts. The position is kept, but the player restarts from the beginning.
    const completed = dur !== null && (b.positionMs >= dur * 0.95 || (dur > 120_000 && dur - b.positionMs <= 20_000));
    await db.query(
      `INSERT INTO media_playback_progress (user_id, file_id, position_ms, duration_ms, completed) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, file_id) DO UPDATE SET position_ms = EXCLUDED.position_ms, duration_ms = COALESCE(EXCLUDED.duration_ms, media_playback_progress.duration_ms),
         completed = EXCLUDED.completed, updated_at = now()`, [a.userId, id, b.positionMs, dur, completed]);
    return { positionMs: b.positionMs, completed };
  });

  app.delete('/media/:id/progress', async (req, reply) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await ownedMedia(a.userId, id);
    await db.query(`DELETE FROM media_playback_progress WHERE user_id = $1 AND file_id = $2`, [a.userId, id]);
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- maintenance + conversions
  app.post('/media/:id/reprobe', async (req) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await ownedMedia(a.userId, id);
    const r = await db.query(`UPDATE media_metadata SET status = 'pending', attempt = 0, error_message = NULL, next_attempt_at = now(), updated_at = now()
                               WHERE file_id = $1 AND user_id = $2 AND status IN ('failed','unsupported')`, [id, a.userId]);
    if (r.rowCount === 0) throw conflict('Only files that failed to be indexed can be retried', 'invalid_state');
    return { status: 'pending' };
  });

  app.post('/media/:id/renditions', async (req, reply) => {
    const a = requireAuth(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { profile } = z.object({ profile: z.string().max(40) }).parse(req.body);
    if (!config.MEDIA_TRANSCODING_ENABLED) throw conflict('Converting media is disabled on this server (MEDIA_TRANSCODING_ENABLED=false)', 'transcoding_disabled');
    const p = TRANSCODE_PROFILES[profile];
    if (!p) throw badRequest('Unknown conversion profile', 'unknown_profile');
    const f = await ownedMedia(a.userId, id);
    const meta = (await db.query<{ kind: string; status: string }>(`SELECT kind, status FROM media_metadata WHERE file_id = $1`, [id])).rows[0]!;
    if (meta.status !== 'ready') throw conflict('The file has not been analysed yet', 'not_ready');
    if (p.kind !== meta.kind) throw badRequest(`The ${profile} profile is for ${p.kind} files`, 'profile_mismatch');
    if (Number(f.size_bytes) > config.MEDIA_TRANSCODE_MAX_SOURCE_BYTES) throw new HttpError(413, 'file_too_large', 'This file is too large to convert');
    const q = (await db.query<{ quota_bytes: number; used_bytes: number }>(`SELECT quota_bytes, used_bytes FROM storage_quotas WHERE user_id = $1`, [a.userId])).rows[0];
    if (!q || Number(q.quota_bytes) - Number(q.used_bytes) < 1024 * 1024) throw new HttpError(413, 'quota_exceeded', 'Not enough free storage for a converted copy');
    const r = await db.query<{ id: string; status: string }>(
      `INSERT INTO media_assets (file_id, user_id, kind, variant, status) VALUES ($1, $2, 'rendition', $3, 'queued')
       ON CONFLICT (file_id, kind, variant) DO UPDATE SET status = 'queued', progress = 0, error_message = NULL, updated_at = now() WHERE media_assets.status = 'failed'
       RETURNING id, status`, [id, a.userId, profile]);
    if (r.rowCount === 0) throw conflict('That conversion already exists or is in progress', 'already_exists');
    return reply.status(202).send({ profile, status: 'queued' });
  });

  app.delete('/media/:id/renditions/:profile', async (req, reply) => {
    const a = requireAuth(req);
    const { id, profile } = z.object({ id: uuid, profile: z.string().max(40) }).parse(req.params);
    await ownedMedia(a.userId, id);
    const old = await db.tx(async (t) => {
      const r = await t.query<{ size_bytes: number; storage_key: string | null; storage_provider_kind: string | null; status: string }>(
        `DELETE FROM media_assets WHERE file_id = $1 AND user_id = $2 AND kind = 'rendition' AND variant = $3 AND status IN ('ready','failed') RETURNING size_bytes, storage_key, storage_provider_kind, status`, [id, a.userId, profile]);
      if (r.rowCount === 0) return null;
      if (Number(r.rows[0]!.size_bytes) > 0) await t.query(`UPDATE storage_quotas SET used_bytes = GREATEST(0, used_bytes - $2) WHERE user_id = $1`, [a.userId, r.rows[0]!.size_bytes]);
      return r.rows[0]!;
    });
    if (!old) throw conflict('There is no finished conversion with that name to delete', 'invalid_state');
    if (old.storage_key && old.storage_provider_kind) await ad(old.storage_provider_kind).delete(old.storage_key).catch(() => undefined);
    return reply.status(204).send();
  });
};
