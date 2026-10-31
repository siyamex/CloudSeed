import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// The bundled test binaries (an old FFmpeg build and a newer ffprobe). Production uses the system FFmpeg.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegPath: string = (await import('@ffmpeg-installer/ffmpeg')).default.path;
const ffprobePath: string = (await import('@ffprobe-installer/ffprobe')).default.path;
export { ffmpegPath, ffprobePath };

export interface Fixtures {
  dir: string;
  /** name -> bytes */
  files: Record<string, Buffer>;
}

const ff = (args: string[]) => exec(ffmpegPath, ['-v', 'error', '-y', ...args], { timeout: 120_000 });

let cached: Promise<Fixtures> | undefined;

/**
 * Real media generated with FFmpeg at test time (no binary fixtures in the repo): a short H.264/AAC MP4, an MP3, an MP3
 * with cover art, an MKV with embedded subtitle tracks and two audio tracks, an AVI (not browser-playable), a "video"
 * that is really an HLS playlist pointing at a local file, and a file of garbage.
 */
export function fixtures(): Promise<Fixtures> {
  cached ??= (async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cloudseed-media-'));
    const p = (n: string) => path.join(dir, n);
    const v = ['-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10'];
    const a = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3'];
    await ff([...v, ...a, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', p('clip.mp4')]);
    await ff([...a, '-c:a', 'libmp3lame', '-metadata', 'title=Test Tone', '-metadata', 'artist=Sine Band', '-metadata', 'album=Hertz', p('tone.mp3')]);
    await ff(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=200x200:rate=1', '-frames:v', '1', p('cover.jpg')]);
    await ff(['-i', p('tone.mp3'), '-i', p('cover.jpg'), '-map', '0:a', '-map', '1:v', '-c', 'copy', '-id3v2_version', '3', '-disposition:v', 'attached_pic', p('covered.mp3')]);
    await writeFile(p('subs.srt'), '1\n00:00:00,500 --> 00:00:01,500\nHello <i>world</i>\n\n2\n00:00:02,000 --> 00:00:02,800\nSecond line\n');
    await writeFile(p('subs2.srt'), '1\n00:00:00,200 --> 00:00:01,000\nBonjour\n');
    await ff([...v, ...a, '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3', '-i', p('subs.srt'), '-i', p('subs2.srt'),
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:0', '-map', '4:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=fra', '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=fra', p('multi.mkv')]);
    await ff([...v, ...a, '-c:v', 'mpeg4', '-c:a', 'libmp3lame', '-shortest', p('old.avi')]);
    // WebM (VP8 + Vorbis) is playable by headless Chromium, which lacks H.264; used by the browser checks.
    await ff([...v, ...a, '-c:v', 'libvpx', '-b:v', '200k', '-c:a', 'libvorbis', '-shortest', p('clip.webm')]);
    await ff(['-f', 'lavfi', '-i', 'testsrc=duration=40:size=240x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=40', '-c:v', 'libvpx', '-b:v', '150k', '-c:a', 'libvorbis', '-shortest', p('long.webm')]);
    await writeFile(p('long.srt'), ['1', '00:00:01,000 --> 00:00:30,000', 'A subtitle that stays on screen', ''].join('\n'));
    await writeFile(p('secret.ts'), 'TOP-SECRET-LOCAL-FILE-CONTENT');
    await writeFile(p('evil.mp4'), `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1.0,\nfile:${p('secret.ts').replace(/\\/g, '/')}\n#EXT-X-ENDLIST\n`);
    await writeFile(p('garbage.mp4'), Buffer.from('this is not a media file at all '.repeat(50)));
    const files: Record<string, Buffer> = {};
    for (const n of ['clip.mp4', 'clip.webm', 'long.webm', 'long.srt', 'tone.mp3', 'covered.mp3', 'multi.mkv', 'old.avi', 'evil.mp4', 'garbage.mp4', 'subs.srt', 'secret.ts']) files[n] = await readFile(p(n));
    await mkdir(dir, { recursive: true });
    return { dir, files };
  })();
  return cached;
}
