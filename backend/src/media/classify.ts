import path from 'node:path';

export type MediaKind = 'video' | 'audio';

interface Format { kind: MediaKind; /** FFmpeg demuxer forced with -f, so a file cannot make FFmpeg pick a dangerous one (HLS/concat/subfile...). */ demuxer: string; mime: string }

const FORMATS: Record<string, Format> = {
  '.mp4': { kind: 'video', demuxer: 'mov', mime: 'video/mp4' },
  '.m4v': { kind: 'video', demuxer: 'mov', mime: 'video/mp4' },
  '.mov': { kind: 'video', demuxer: 'mov', mime: 'video/mp4' },
  '.webm': { kind: 'video', demuxer: 'matroska', mime: 'video/webm' },
  '.mkv': { kind: 'video', demuxer: 'matroska', mime: 'video/x-matroska' },
  '.avi': { kind: 'video', demuxer: 'avi', mime: 'video/x-msvideo' },
  '.ogv': { kind: 'video', demuxer: 'ogg', mime: 'video/ogg' },
  '.mp3': { kind: 'audio', demuxer: 'mp3', mime: 'audio/mpeg' },
  '.m4a': { kind: 'audio', demuxer: 'mov', mime: 'audio/mp4' },
  '.aac': { kind: 'audio', demuxer: 'aac', mime: 'audio/aac' },
  '.flac': { kind: 'audio', demuxer: 'flac', mime: 'audio/flac' },
  '.wav': { kind: 'audio', demuxer: 'wav', mime: 'audio/wav' },
  '.ogg': { kind: 'audio', demuxer: 'ogg', mime: 'audio/ogg' },
  '.oga': { kind: 'audio', demuxer: 'ogg', mime: 'audio/ogg' },
  '.opus': { kind: 'audio', demuxer: 'ogg', mime: 'audio/ogg' },
};

export const formatFor = (name: string): Format | null => FORMATS[path.extname(name).toLowerCase()] ?? null;
export const isMediaName = (name: string) => formatFor(name) !== null;

/** Extensions served as inline media. Everything is by extension: client-declared types are never trusted. */
export const MEDIA_EXTENSIONS = Object.keys(FORMATS);

export type Playability = { mode: 'direct' | 'maybe' | 'transcode'; reason: string | null };

export interface ProbeSummary {
  container: string | null; videoCodec: string | null; audioCodec: string | null; hasVideo: boolean; hasAudio: boolean;
}

const WEB_VIDEO: Record<string, Set<string>> = {
  mp4: new Set(['h264', 'vp9', 'av1']),
  webm: new Set(['vp8', 'vp9', 'av1']),
};
const WEB_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

/**
 * Can an ordinary browser play this file as is? 'direct' = yes in current browsers, 'maybe' = depends on the browser,
 * 'transcode' = needs a converted copy (or a download). This is a heuristic, not a guarantee.
 */
export function playability(name: string, p: ProbeSummary): Playability {
  const fmt = formatFor(name);
  if (!fmt) return { mode: 'transcode', reason: 'This file type cannot be streamed in the browser.' };
  const ext = path.extname(name).toLowerCase();
  if (!p.hasVideo && !p.hasAudio) return { mode: 'transcode', reason: 'No audio or video stream was found in this file.' };

  if (!p.hasVideo) { // audio file
    if (ext === '.ogg' || ext === '.oga' || ext === '.opus') return { mode: 'maybe', reason: 'Ogg audio does not play in Safari.' };
    if (p.audioCodec && !WEB_AUDIO.has(p.audioCodec) && p.audioCodec !== 'pcm_s16le' && p.audioCodec !== 'pcm_s24le') {
      return { mode: 'transcode', reason: `The audio codec (${p.audioCodec}) is not supported by browsers.` };
    }
    return { mode: 'direct', reason: null };
  }

  const family = ext === '.webm' ? 'webm' : ext === '.mkv' ? 'mkv' : ext === '.avi' || ext === '.ogv' ? 'other' : 'mp4';
  if (family === 'other') return { mode: 'transcode', reason: `${ext.slice(1).toUpperCase()} files are not supported by browsers.` };
  if (p.videoCodec === 'hevc') return { mode: 'transcode', reason: 'H.265/HEVC video only plays in some browsers (mostly Safari).' };
  if (family !== 'mkv' && p.videoCodec && !(WEB_VIDEO[family]?.has(p.videoCodec))) {
    return { mode: 'transcode', reason: `The video codec (${p.videoCodec}) is not supported in this container by browsers.` };
  }
  if (p.audioCodec && !WEB_AUDIO.has(p.audioCodec)) {
    return { mode: 'transcode', reason: `The audio codec (${p.audioCodec}) is not supported by browsers, so it would play without sound.` };
  }
  if (family === 'mkv') return { mode: 'maybe', reason: 'Matroska (.mkv) plays in Chrome and Edge but not in Safari or Firefox.' };
  return { mode: 'direct', reason: null };
}

// ---------------------------------------------------------------- ffprobe parsing
export interface StreamInfo {
  index: number; type: 'video' | 'audio' | 'subtitle'; codec: string | null; language: string | null; title: string | null;
  channels?: number; default: boolean; width?: number; height?: number;
  /** subtitles only: text formats can be converted to WebVTT, image formats (PGS, VobSub) cannot */
  extractable?: boolean;
}

export interface ParsedProbe extends ProbeSummary {
  durationMs: number | null; width: number | null; height: number | null; bitrate: number | null;
  streams: StreamInfo[]; tags: Record<string, string>; title: string | null;
  /** An audio file with embedded cover art (usable as a thumbnail). */
  hasCover: boolean;
}

const TEXT_SUBTITLES = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** Turns ffprobe's JSON into the small, bounded record we store. Never trusts field types or sizes. */
export function parseProbe(json: unknown): ParsedProbe {
  const j = (json ?? {}) as { format?: Record<string, any>; streams?: Record<string, any>[] };
  const fmt = j.format ?? {};
  const raw = Array.isArray(j.streams) ? j.streams.slice(0, 64) : [];
  const streams: StreamInfo[] = [];
  let video: Record<string, any> | undefined, audio: Record<string, any> | undefined;
  let hasCover = false;

  for (const s of raw) {
    const type = s.codec_type;
    const tags = (s.tags ?? {}) as Record<string, unknown>;
    const attachedPic = s.disposition?.attached_pic === 1; // cover art, not a real video stream
    if (type === 'video' && attachedPic) hasCover = true;
    if (type === 'video' && !attachedPic) {
      video ??= s;
      streams.push({ index: Number(s.index), type: 'video', codec: str(s.codec_name, 40), language: str(tags.language, 20), title: str(tags.title), default: s.disposition?.default === 1, width: num(s.width) ?? undefined, height: num(s.height) ?? undefined });
    } else if (type === 'audio') {
      audio ??= s;
      streams.push({ index: Number(s.index), type: 'audio', codec: str(s.codec_name, 40), language: str(tags.language, 20), title: str(tags.title), channels: num(s.channels) ?? undefined, default: s.disposition?.default === 1 });
    } else if (type === 'subtitle') {
      const codec = str(s.codec_name, 40);
      streams.push({ index: Number(s.index), type: 'subtitle', codec, language: str(tags.language, 20), title: str(tags.title), default: s.disposition?.default === 1, extractable: !!codec && TEXT_SUBTITLES.has(codec) });
    }
  }

  const ftags = (fmt.tags ?? {}) as Record<string, unknown>;
  const tags: Record<string, string> = {};
  for (const k of ['title', 'artist', 'album', 'album_artist', 'genre', 'date', 'track']) {
    const v = str(ftags[k] ?? ftags[k.toUpperCase()]);
    if (v) tags[k] = v;
  }
  const dur = num(fmt.duration) ?? num(video?.duration) ?? num(audio?.duration);
  const container = str(fmt.format_name, 80);
  return {
    container, hasVideo: !!video, hasAudio: !!audio, videoCodec: str(video?.codec_name, 40), audioCodec: str(audio?.codec_name, 40),
    durationMs: dur === null ? null : Math.round(dur * 1000), width: num(video?.width), height: num(video?.height),
    bitrate: num(fmt.bit_rate), streams, tags, title: tags.title ?? null, hasCover,
  };
}

// ---------------------------------------------------------------- subtitles
export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

/** SubRip (.srt) to WebVTT. Input that already is WebVTT is returned unchanged (normalised line endings). */
export function srtToVtt(input: string): string {
  let t = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (/^WEBVTT/.test(t)) return t + '\n';
  // 00:00:01,000 --> 00:00:02,500  =>  00:00:01.000 --> 00:00:02.500 (only on cue timing lines)
  t = t.split('\n').map((line) => (/-->/.test(line) ? line.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2') : line)).join('\n');
  return `WEBVTT\n\n${t}\n`;
}

const SUBTITLE_EXT = new Set(['.srt', '.vtt']);
export const isSubtitleName = (name: string) => SUBTITLE_EXT.has(path.extname(name).toLowerCase());

/**
 * Finds subtitle files belonging to a media file by name: movie.mp4 -> movie.srt, movie.en.srt, movie.English.vtt.
 * `language` is the token between the media name and the extension, when there is one.
 */
export function matchSubtitle(mediaName: string, candidate: string): { language: string | null } | null {
  if (!isSubtitleName(candidate)) return null;
  const base = mediaName.slice(0, mediaName.length - path.extname(mediaName).length).toLowerCase();
  const sub = candidate.slice(0, candidate.length - path.extname(candidate).length);
  const lower = sub.toLowerCase();
  if (lower === base) return { language: null };
  if (lower.startsWith(base + '.')) {
    const tag = sub.slice(base.length + 1);
    return /^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(tag) ? { language: tag } : { language: null };
  }
  return null;
}
