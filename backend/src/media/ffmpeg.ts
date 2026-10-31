import { spawn } from 'node:child_process';
import type { Config } from '../config.js';
import { parseProbe, type ParsedProbe } from './classify.js';

/** Where FFmpeg reads from. `file` = absolute local path, `url` = private presigned URL (kept inside this process). */
export type MediaInput = { kind: 'file'; path: string } | { kind: 'url'; url: string };

export class FfmpegError extends Error {
  constructor(public readonly code: 'timeout' | 'spawn_failed' | 'invalid_data' | 'output_too_large' | 'aborted', message: string, public readonly stderr = '') { super(message); }
}

export interface RunResult { code: number | null; stdout: Buffer; stderr: string }

interface RunOptions { timeoutMs: number; maxStdout?: number; signal?: AbortSignal; onStdoutLine?: (line: string) => void }

const STDERR_TAIL = 8 * 1024;

/**
 * Runs a tool without a shell, with a hard timeout, a cap on captured output, a minimal environment, and no stdin.
 * The command line is never logged: it can contain a presigned URL.
 */
export function run(bin: string, args: string[], o: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
        env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', TMPDIR: process.env.TMPDIR ?? '' },
      });
    } catch (e) { return reject(new FfmpegError('spawn_failed', `Could not start ${bin}: ${(e as Error).message}`)); }

    const out: Buffer[] = [];
    let outSize = 0, stderr = '', lineBuf = '', settled = false;
    const max = o.maxStdout ?? 16 * 1024 * 1024;
    const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); fn(); };
    const kill = (err: FfmpegError) => { child.kill('SIGKILL'); done(() => reject(err)); };
    const timer = setTimeout(() => kill(new FfmpegError('timeout', `${bin} timed out after ${Math.round(o.timeoutMs / 1000)}s`, stderr)), o.timeoutMs);
    const onAbort = () => kill(new FfmpegError('aborted', 'aborted'));
    o.signal?.addEventListener('abort', onAbort, { once: true });
    if (o.signal?.aborted) return onAbort();

    child.stdout.on('data', (c: Buffer) => {
      if (o.onStdoutLine) {
        lineBuf += c.toString('utf8');
        let i; while ((i = lineBuf.indexOf('\n')) >= 0) { o.onStdoutLine(lineBuf.slice(0, i).trim()); lineBuf = lineBuf.slice(i + 1); }
        if (lineBuf.length > 4096) lineBuf = '';
        return;
      }
      outSize += c.length;
      if (outSize > max) return kill(new FfmpegError('output_too_large', 'Tool output exceeded the allowed size', stderr));
      out.push(c);
    });
    child.stderr.on('data', (c: Buffer) => { stderr = (stderr + c.toString('utf8')).slice(-STDERR_TAIL); });
    child.on('error', (e) => done(() => reject(new FfmpegError('spawn_failed', `Could not run ${bin}: ${e.message}`))));
    child.on('close', (code) => done(() => resolve({ code, stdout: Buffer.concat(out), stderr })));
  });
}

/**
 * Input arguments. The demuxer is forced from the (validated) file extension, so a hostile file can never make FFmpeg
 * select a playlist/concat/subfile demuxer that reads other files or URLs. The protocol whitelist is the second layer.
 */
export function inputArgs(input: MediaInput, demuxer: string): string[] {
  return input.kind === 'file'
    ? ['-protocol_whitelist', 'file', '-f', demuxer, '-i', `file:${input.path}`]
    : ['-protocol_whitelist', 'http,https,tcp,tls,crypto', '-f', demuxer, '-i', input.url];
}

export class Ffmpeg {
  constructor(private readonly cfg: Pick<Config, 'FFMPEG_PATH' | 'FFPROBE_PATH' | 'MEDIA_PROBE_TIMEOUT_MS' | 'MEDIA_THUMBNAIL_TIMEOUT_MS' | 'MEDIA_THUMBNAIL_WIDTH' | 'MEDIA_TRANSCODE_TIMEOUT_MS'> & Partial<Pick<Config, 'MEDIA_SPRITE_TIMEOUT_MS'>>) {}

  async probe(input: MediaInput, demuxer: string, signal?: AbortSignal): Promise<ParsedProbe> {
    const r = await run(this.cfg.FFPROBE_PATH, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...inputArgs(input, demuxer)],
      { timeoutMs: this.cfg.MEDIA_PROBE_TIMEOUT_MS, maxStdout: 4 * 1024 * 1024, signal });
    if (r.code !== 0) throw new FfmpegError('invalid_data', 'ffprobe could not read this file', r.stderr);
    let json: unknown;
    try { json = JSON.parse(r.stdout.toString('utf8')); } catch { throw new FfmpegError('invalid_data', 'ffprobe returned unreadable output', r.stderr); }
    return parseProbe(json);
  }

  /** A single JPEG frame (video) or the embedded cover (audio), scaled to the configured width. */
  async thumbnail(input: MediaInput, demuxer: string, p: { durationMs: number | null; hasVideo: boolean }, signal?: AbortSignal): Promise<Buffer> {
    const scale = `scale=${this.cfg.MEDIA_THUMBNAIL_WIDTH}:-2`;
    const attempt = async (seconds: number) => {
      const args = ['-v', 'error', '-nostdin'];
      if (p.hasVideo && seconds > 0) args.push('-ss', seconds.toFixed(3));
      args.push(...inputArgs(input, demuxer), '-map', '0:v:0', '-frames:v', '1', '-vf', scale, '-q:v', '4', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1');
      const r = await run(this.cfg.FFMPEG_PATH, args, { timeoutMs: this.cfg.MEDIA_THUMBNAIL_TIMEOUT_MS, maxStdout: 2 * 1024 * 1024, signal });
      if (r.code !== 0 || r.stdout.length < 100) throw new FfmpegError('invalid_data', 'No thumbnail could be produced', r.stderr);
      return r.stdout;
    };
    // A frame a little way in is more representative than the first (often black) one; fall back to the start for short clips.
    const at = p.hasVideo && p.durationMs ? Math.min(p.durationMs / 1000 * 0.1, 10) : 0;
    try { return await attempt(at); } catch (e) { if (at === 0 || (e instanceof FfmpegError && e.code === 'timeout')) throw e; return attempt(0); }
  }

  /**
   * A grid of small frames for the seek-bar preview: one frame every `intervalSec` seconds, `cols` per row, in a single JPEG.
   * Frames are exact for videos up to 10 minutes. Longer ones decode only key frames, which keeps a feature film fast at the cost of
   * showing the nearest earlier key frame (usually within a few seconds).
   */
  async sprite(input: MediaInput, demuxer: string, g: SpriteGeometry, signal?: AbortSignal): Promise<Buffer> {
    const fast = g.intervalSec * g.frames > 600;
    const args = ['-v', 'error', '-nostdin', ...(fast ? ['-skip_frame', 'nokey'] : []), ...inputArgs(input, demuxer), '-map', '0:v:0',
      '-vf', `fps=1/${g.intervalSec},scale=${g.tileWidth}:${g.tileHeight},tile=${g.cols}x${g.rows}`, '-frames:v', '1', '-q:v', '6', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'];
    const r = await run(this.cfg.FFMPEG_PATH, args, { timeoutMs: this.cfg.MEDIA_SPRITE_TIMEOUT_MS ?? 300_000, maxStdout: 4 * 1024 * 1024, signal });
    if (r.code !== 0 || r.stdout.length < 100) throw new FfmpegError('invalid_data', 'No preview sheet could be produced', r.stderr);
    return r.stdout;
  }

  /** One embedded text subtitle stream as WebVTT. */
  async subtitle(input: MediaInput, demuxer: string, streamIndex: number, signal?: AbortSignal): Promise<string> {
    const r = await run(this.cfg.FFMPEG_PATH, ['-v', 'error', '-nostdin', ...inputArgs(input, demuxer), '-map', `0:${streamIndex}`, '-f', 'webvtt', 'pipe:1'],
      { timeoutMs: this.cfg.MEDIA_THUMBNAIL_TIMEOUT_MS, maxStdout: 2 * 1024 * 1024, signal });
    if (r.code !== 0 || r.stdout.length === 0) throw new FfmpegError('invalid_data', 'Subtitle track could not be extracted', r.stderr);
    return r.stdout.toString('utf8');
  }

  /** Converts to a browser-friendly MP4 at `outPath`, reporting progress 0..1. */
  async transcode(input: MediaInput, demuxer: string, profile: TranscodeProfile, outPath: string,
    p: { durationMs: number | null; maxBytes: number; audioIndex?: number }, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
    const args = ['-v', 'error', '-nostdin', '-nostats', '-progress', 'pipe:1', ...inputArgs(input, demuxer), ...profile.args(p.audioIndex),
      '-threads', '2', '-fs', String(p.maxBytes), '-movflags', '+faststart', '-f', 'mp4', '-y', outPath];
    const r = await run(this.cfg.FFMPEG_PATH, args, {
      timeoutMs: this.cfg.MEDIA_TRANSCODE_TIMEOUT_MS, signal,
      onStdoutLine: (line) => {
        const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line); // (the field is named _ms but holds microseconds)
        if (m && p.durationMs) onProgress(Math.min(0.99, Number(m[1]) / 1000 / p.durationMs));
      },
    });
    if (r.code !== 0) throw new FfmpegError('invalid_data', 'The conversion failed', r.stderr);
  }
}

export interface SpriteGeometry { intervalSec: number; cols: number; rows: number; frames: number; tileWidth: number; tileHeight: number }

/**
 * Picks the grid for a video: at most 100 frames, no more often than every 2 seconds, 160 px wide tiles in the video's own
 * shape. Returns null for videos too short to need previews.
 */
export function spriteGeometry(durationMs: number | null, width: number | null, height: number | null): SpriteGeometry | null {
  if (!durationMs || !width || !height || durationMs < 20_000) return null;
  const seconds = durationMs / 1000;
  const intervalSec = Math.max(2, Math.ceil(seconds / 100));
  const frames = Math.min(100, Math.ceil(seconds / intervalSec));
  const tileWidth = 160;
  const tileHeight = Math.max(2, Math.round((tileWidth * height) / width / 2) * 2); // even, as H.264-family scalers prefer
  const cols = Math.min(10, frames);
  return { intervalSec, cols, rows: Math.ceil(frames / cols), frames, tileWidth, tileHeight };
}

export interface TranscodeProfile { name: string; kind: 'video' | 'audio'; description: string; args(audioIndex?: number): string[] }

export const TRANSCODE_PROFILES: Record<string, TranscodeProfile> = {
  'web-720p': {
    name: 'web-720p', kind: 'video', description: 'H.264 + AAC MP4, at most 720p, plays in every browser',
    args: (a) => ['-map', '0:v:0', '-map', a === undefined ? '0:a:0?' : `0:${a}`, '-vf', 'scale=-2:min(720\\,ih)', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ac', '2'],
  },
  'web-480p': {
    name: 'web-480p', kind: 'video', description: 'H.264 + AAC MP4, at most 480p, small and fast',
    args: (a) => ['-map', '0:v:0', '-map', a === undefined ? '0:a:0?' : `0:${a}`, '-vf', 'scale=-2:min(480\\,ih)', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-ac', '2'],
  },
  'audio-aac': {
    name: 'audio-aac', kind: 'audio', description: 'AAC (.m4a), plays in every browser',
    args: (a) => ['-vn', '-map', a === undefined ? '0:a:0' : `0:${a}`, '-c:a', 'aac', '-b:a', '160k'],
  },
};
