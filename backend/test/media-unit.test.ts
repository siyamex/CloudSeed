import { describe, expect, it } from 'vitest';
import { FfmpegError, inputArgs, run } from '../src/media/ffmpeg.js';
import { formatFor, isMediaName, isSubtitleName, matchSubtitle, parseProbe, playability, srtToVtt, type ProbeSummary } from '../src/media/classify.js';

const P = (o: Partial<ProbeSummary> = {}): ProbeSummary => ({ container: null, videoCodec: 'h264', audioCodec: 'aac', hasVideo: true, hasAudio: true, ...o });

describe('media type detection', () => {
  it.each([
    ['a.mp4', 'video'], ['A.MKV', 'video'], ['a.webm', 'video'], ['a.mov', 'video'], ['a.avi', 'video'],
    ['a.mp3', 'audio'], ['a.m4a', 'audio'], ['a.flac', 'audio'], ['a.wav', 'audio'], ['a.ogg', 'audio'], ['a.opus', 'audio'],
  ])('%s is %s', (name, kind) => { expect(formatFor(name)?.kind).toBe(kind); });

  it.each(['a.txt', 'a.m3u8', 'a.pls', 'a.sdp', 'a.concat', 'a.ffconcat', 'a.mp4.txt', 'mp4', 'a.exe', 'a.svg', ''])('%j is not media (playlists and scripts are never handed to FFmpeg)', (name) => {
    expect(isMediaName(name)).toBe(false);
  });

  it('forces a fixed demuxer per extension so a file cannot choose its own', () => {
    expect(formatFor('x.mp4')!.demuxer).toBe('mov');
    expect(formatFor('x.mkv')!.demuxer).toBe('matroska');
    for (const ext of ['mp4', 'mkv', 'webm', 'avi', 'mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac']) {
      expect(formatFor(`x.${ext}`)!.demuxer).not.toMatch(/hls|concat|subfile|pipe|sdp|rtsp|image2/i);
    }
  });
});

describe('FFmpeg input arguments', () => {
  it('pins the demuxer and restricts protocols', () => {
    expect(inputArgs({ kind: 'file', path: '/data/x' }, 'mov')).toEqual(['-protocol_whitelist', 'file', '-f', 'mov', '-i', 'file:/data/x']);
    const u = inputArgs({ kind: 'url', url: 'https://bucket/obj?sig=1' }, 'matroska');
    expect(u.slice(0, 4)).toEqual(['-protocol_whitelist', 'http,https,tcp,tls,crypto', '-f', 'matroska']);
    expect(u.join(' ')).not.toMatch(/\bfile\b/);
  });
});

describe('browser playability', () => {
  it('plays H.264/AAC MP4 and VP9/Opus WebM directly', () => {
    expect(playability('a.mp4', P()).mode).toBe('direct');
    expect(playability('a.webm', P({ videoCodec: 'vp9', audioCodec: 'opus' })).mode).toBe('direct');
  });
  it('flags HEVC, AVI, odd codecs and silent-playback audio codecs with a reason', () => {
    expect(playability('a.mp4', P({ videoCodec: 'hevc' }))).toMatchObject({ mode: 'transcode', reason: expect.stringMatching(/HEVC/) });
    expect(playability('a.avi', P({ videoCodec: 'mpeg4' }))).toMatchObject({ mode: 'transcode', reason: expect.stringMatching(/AVI/) });
    expect(playability('a.mp4', P({ videoCodec: 'mpeg4' })).mode).toBe('transcode');
    expect(playability('a.mp4', P({ audioCodec: 'ac3' }))).toMatchObject({ mode: 'transcode', reason: expect.stringMatching(/without sound/) });
    expect(playability('a.webm', P({ videoCodec: 'h264' })).mode).toBe('transcode');
  });
  it('marks Matroska and Ogg as browser-dependent rather than promising playback', () => {
    expect(playability('a.mkv', P()).mode).toBe('maybe');
    expect(playability('a.ogg', P({ hasVideo: false, audioCodec: 'vorbis', videoCodec: null })).mode).toBe('maybe');
  });
  it('plays common audio and rejects exotic audio codecs', () => {
    for (const [n, c] of [['a.mp3', 'mp3'], ['a.m4a', 'aac'], ['a.flac', 'flac'], ['a.wav', 'pcm_s16le']] as const) {
      expect(playability(n, P({ hasVideo: false, videoCodec: null, audioCodec: c })).mode, n).toBe('direct');
    }
    expect(playability('a.mp3', P({ hasVideo: false, videoCodec: null, audioCodec: 'wmav2' })).mode).toBe('transcode');
  });
  it('handles files without streams', () => {
    expect(playability('a.mp4', P({ hasVideo: false, hasAudio: false })).reason).toMatch(/No audio or video/);
  });
});

describe('parseProbe (ffprobe JSON is untrusted)', () => {
  const sample = {
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.345', bit_rate: '800000', tags: { title: 'Movie', ARTIST: 'Someone' } },
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, disposition: { default: 1 } },
      { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'eng' }, disposition: { default: 1 } },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'fra', title: 'Français' } },
      { index: 3, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' },
    ],
  };
  it('extracts the summary, tracks and tags', () => {
    const p = parseProbe(sample);
    expect(p).toMatchObject({ durationMs: 12345, width: 1920, height: 1080, videoCodec: 'h264', audioCodec: 'aac', bitrate: 800000, hasVideo: true, hasAudio: true, title: 'Movie', hasCover: false });
    expect(p.tags).toEqual({ title: 'Movie', artist: 'Someone' });
    expect(p.streams.map((s) => [s.index, s.type, s.language])).toEqual([[0, 'video', null], [1, 'audio', 'eng'], [2, 'subtitle', 'fra'], [3, 'subtitle', null]]);
  });
  it('knows which subtitle tracks can be shown in a browser', () => {
    const subs = parseProbe(sample).streams.filter((s) => s.type === 'subtitle');
    expect(subs.map((s) => s.extractable)).toEqual([true, false]);
  });
  it('treats embedded cover art as a cover, not as a video stream', () => {
    const p = parseProbe({ format: { duration: '3' }, streams: [{ index: 0, codec_type: 'audio', codec_name: 'mp3' }, { index: 1, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } }] });
    expect(p).toMatchObject({ hasVideo: false, hasCover: true, hasAudio: true });
  });
  it('survives garbage without throwing and bounds what it keeps', () => {
    expect(parseProbe(null)).toMatchObject({ hasVideo: false, hasAudio: false, durationMs: null, streams: [] });
    expect(parseProbe({ format: { duration: 'NaN', bit_rate: -5 }, streams: 'nope' })).toMatchObject({ durationMs: null, bitrate: null });
    const many = parseProbe({ format: {}, streams: Array.from({ length: 500 }, (_, i) => ({ index: i, codec_type: 'audio', codec_name: 'x'.repeat(500), tags: { title: 'y'.repeat(5000) } })) });
    expect(many.streams.length).toBeLessThanOrEqual(64);
    expect(many.streams[0]!.codec!.length).toBeLessThanOrEqual(40);
    expect(many.streams[0]!.title!.length).toBeLessThanOrEqual(200);
  });
});

describe('subtitles', () => {
  it('converts SRT to WebVTT (timestamps use a dot, header added, text kept)', () => {
    const vtt = srtToVtt('﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello, world\r\n\r\n2\r\n00:01:00,5 --> 00:01:02,250\r\nBye\r\n');
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    expect(vtt).toContain('00:00:01.000 --> 00:00:02.500');
    expect(vtt).toContain('00:01:00.5 --> 00:01:02.250');
    expect(vtt).toContain('Hello, world'); // commas in the text are untouched
    expect(vtt).not.toContain('\r');
  });
  it('passes WebVTT through unchanged', () => {
    expect(srtToVtt('WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n')).toBe('WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n');
  });
  it('matches subtitles to a video by name', () => {
    expect(matchSubtitle('Movie.mp4', 'Movie.srt')).toEqual({ language: null });
    expect(matchSubtitle('Movie.mp4', 'movie.EN.vtt')).toEqual({ language: 'EN' });
    expect(matchSubtitle('Movie.mp4', 'Movie.English.srt')).toEqual({ language: 'English' });
    expect(matchSubtitle('Movie.mp4', 'Movie 2.srt')).toBeNull();
    expect(matchSubtitle('Movie.mp4', 'Movies.srt')).toBeNull();
    expect(matchSubtitle('Movie.mp4', 'Other.srt')).toBeNull();
    expect(matchSubtitle('Movie.mp4', 'Movie.txt')).toBeNull();
    expect(isSubtitleName('a.SRT')).toBe(true);
    expect(isSubtitleName('a.ass')).toBe(false);
  });
});

describe('process runner', () => {
  const node = process.execPath;
  it('captures output and exit codes', async () => {
    const r = await run(node, ['-e', 'process.stdout.write("hi"); process.stderr.write("err"); process.exit(3)'], { timeoutMs: 10_000 });
    expect(r).toMatchObject({ code: 3, stderr: 'err' });
    expect(r.stdout.toString()).toBe('hi');
  });
  it('kills a process that runs too long', async () => {
    const t0 = Date.now();
    await expect(run(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 400 })).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it('stops a process that prints too much', async () => {
    await expect(run(node, ['-e', 'for(;;) process.stdout.write("x".repeat(65536))'], { timeoutMs: 10_000, maxStdout: 100_000 })).rejects.toMatchObject({ code: 'output_too_large' });
  });
  it('reports a missing binary clearly', async () => {
    await expect(run('definitely-not-installed-ffmpeg', [], { timeoutMs: 5000 })).rejects.toBeInstanceOf(FfmpegError);
    await expect(run('definitely-not-installed-ffmpeg', [], { timeoutMs: 5000 })).rejects.toMatchObject({ code: 'spawn_failed' });
  });
  it('can be aborted', async () => {
    const ac = new AbortController();
    const p = run(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 30_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
  });
  it('never goes through a shell: metacharacters in arguments are inert', async () => {
    const arg = 'a; echo PWNED & b | c > d $(e)';
    const r = await run(node, ['-e', 'process.stdout.write(process.argv[1])', arg], { timeoutMs: 10_000 });
    expect(r.stdout.toString()).toBe(arg);
  });
  it('gives the child a minimal environment (no secrets inherited)', async () => {
    process.env.SESSION_SECRET_FOR_TEST = 'leak-me';
    const r = await run(node, ['-e', 'process.stdout.write(String(process.env.SESSION_SECRET_FOR_TEST))'], { timeoutMs: 10_000 });
    expect(r.stdout.toString()).toBe('undefined');
    delete process.env.SESSION_SECRET_FOR_TEST;
  });
});
