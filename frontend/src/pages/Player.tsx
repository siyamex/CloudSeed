import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Download, Info, Keyboard, Maximize, PictureInPicture2, RefreshCw, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PreviewTimeline } from '../components/PreviewTimeline';
import { ApiError, api, formatBytes, formatClock, type MediaDetail } from '../api';
import { btnGhost, btnPrimary } from '../components/Dialog';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const SHORTCUTS: [string, string][] = [
  ['Space / K', 'Play or pause'], ['← / →', 'Back / forward 5 s'], ['J / L', 'Back / forward 10 s'], ['↑ / ↓', 'Volume'], ['M', 'Mute'],
  ['F', 'Full screen'], ['C', 'Next subtitle track'], ['< / >', 'Slower / faster'], ['P', 'Picture in picture'], ['0–9', 'Jump to 0–90 %'], ['Home / End', 'Start / end'],
];

type MediaEl = HTMLVideoElement & { audioTracks?: { length: number; [i: number]: { enabled: boolean } } };
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

export function Player() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const ref = useRef<MediaEl>(null);
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef({ pos: 0, dur: 0 });
  const lastSaved = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const started = useRef(false);

  const [source, setSource] = useState('original');
  const [subtitle, setSubtitle] = useState('off');
  const [speed, setSpeed] = useState(() => Number(lsGet('media.speed')) || 1);
  const [playError, setPlayError] = useState(false);
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  const [help, setHelp] = useState(false);
  const [pip, setPip] = useState(false);

  const detail = useQuery({
    queryKey: ['media-item', id],
    queryFn: () => api<MediaDetail>(`/media/${id}`),
    refetchInterval: (q) => {
      const d = q.state.data;
      return d && (d.status === 'pending' || d.status === 'processing' || d.renditions.some((r) => r.status === 'queued' || r.status === 'processing')) ? 2000 : false;
    },
  });
  const d = detail.data;

  // Prefer a finished converted copy when the original is not browser-playable.
  useEffect(() => {
    if (!d || started.current) return;
    const ready = d.renditions.find((r) => r.status === 'ready');
    if (d.playback.mode === 'transcode' && ready) setSource(ready.profile);
  }, [d]);

  const src = `/api/v1/media/${id}/stream${source === 'original' ? '' : `?rendition=${encodeURIComponent(source)}`}`;
  const tracks = (d?.subtitles ?? []).filter((s) => s.available);

  const save = useCallback((keepalive = false) => {
    const { pos, dur } = latest.current;
    if (pos <= 0) return;
    lastSaved.current = Date.now();
    api(`/media/${id}/progress`, { method: 'PUT', keepalive, body: { positionMs: Math.round(pos * 1000), durationMs: dur > 0 && Number.isFinite(dur) ? Math.round(dur * 1000) : null } }).catch(() => undefined);
  }, [id]);

  // Save on tab hide and on leaving the page, so "resume" works even if the tab is simply closed.
  useEffect(() => {
    const hide = () => { if (document.visibilityState === 'hidden') save(true); };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', () => save(true));
    return () => {
      document.removeEventListener('visibilitychange', hide);
      save(true);
      void qc.invalidateQueries({ queryKey: ['media'] });
    };
  }, [save, qc]);

  // Apply the chosen subtitle track (<track> elements appear in the order of `tracks`).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => Array.from(el.textTracks).forEach((t, i) => { t.mode = tracks[i] && tracks[i].id === subtitle ? 'showing' : 'disabled'; });
    apply();
    el.textTracks.addEventListener?.('addtrack', apply);
    return () => el.textTracks.removeEventListener?.('addtrack', apply);
  }, [subtitle, tracks.map((t) => t.id).join(), source]);

  useEffect(() => { if (ref.current) ref.current.playbackRate = speed; }, [speed, source, d?.status]);

  // React has no props for the picture-in-picture events, so listen natively.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => setPip(true), off = () => setPip(false);
    el.addEventListener('enterpictureinpicture', on); el.addEventListener('leavepictureinpicture', off);
    return () => { el.removeEventListener('enterpictureinpicture', on); el.removeEventListener('leavepictureinpicture', off); };
  }, [source, d?.status]);

  const toggleFullscreen = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void box.current?.requestFullscreen?.(); };
  const togglePip = async () => {
    const el = ref.current;
    if (!el || d?.kind !== 'video') return;
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await el.requestPictureInPicture(); } catch { /* not allowed right now */ }
  };
  const cycleSubtitle = () => {
    const order = ['off', ...tracks.map((t) => t.id)];
    setSubtitle(order[(order.indexOf(subtitle) + 1) % order.length]!);
  };

  const onKey = (e: KeyboardEvent) => {
    const el = ref.current;
    const tag = (e.target as HTMLElement).tagName;
    if (!el || e.ctrlKey || e.metaKey || e.altKey || tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA' || (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Enter'))) return;
    const seek = (to: number) => { el.currentTime = Math.min(Math.max(0, to), Number.isFinite(el.duration) ? el.duration : to); };
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    let handled = true;
    if (k === ' ' || k === 'k') { if (el.paused) void el.play(); else el.pause(); }
    else if (k === 'ArrowLeft') seek(el.currentTime - 5);
    else if (k === 'ArrowRight') seek(el.currentTime + 5);
    else if (k === 'j') seek(el.currentTime - 10);
    else if (k === 'l') seek(el.currentTime + 10);
    else if (k === 'ArrowUp') el.volume = Math.min(1, el.volume + 0.05);
    else if (k === 'ArrowDown') el.volume = Math.max(0, el.volume - 0.05);
    else if (k === 'm') el.muted = !el.muted;
    else if (k === 'f') toggleFullscreen();
    else if (k === 'c') cycleSubtitle();
    else if (k === '<' || k === ',') { const n = SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)]!; setSpeed(n); lsSet('media.speed', String(n)); }
    else if (k === '>' || k === '.') { const n = SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)]!; setSpeed(n); lsSet('media.speed', String(n)); }
    else if (k === 'p') void togglePip();
    else if (k === 'Home') seek(0);
    else if (k === 'End') seek(el.duration);
    else if (/^[0-9]$/.test(k) && Number.isFinite(el.duration)) seek((Number(k) / 10) * el.duration);
    else if (k === '?') setHelp((h) => !h);
    else handled = false;
    if (handled) e.preventDefault(); // stops the browser's own handling from running twice
  };

  const convert = useMutation({
    mutationFn: (profile: string) => api(`/media/${id}/renditions`, { method: 'POST', body: { profile } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['media-item', id] }),
  });
  const reprobe = useMutation({
    mutationFn: () => api(`/media/${id}/reprobe`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['media-item', id] }),
  });

  if (detail.isPending) return <div className="mx-auto max-w-4xl animate-pulse space-y-3" aria-busy="true"><div className="h-6 w-1/3 rounded bg-line/60" /><div className="aspect-video rounded-lg bg-line/60" /></div>;
  if (detail.error || !d) {
    const missing = detail.error instanceof ApiError && detail.error.status === 404;
    return <div className="mx-auto max-w-4xl space-y-3"><Link to="/media" className="text-sm text-accent hover:underline">← Back to the library</Link>
      <p role="alert" className="text-danger">{missing ? 'This file does not exist or is not media.' : `Failed to load: ${detail.error?.message ?? 'unknown error'}`}</p></div>;
  }

  const isVideo = d.kind === 'video';
  const unreadable = d.status === 'unsupported' || d.status === 'failed';
  const viewingOriginal = source === 'original';
  // The original's compatibility only matters while the original is what is being played.
  const cantPlay = playError || (viewingOriginal && d.playback.mode === 'transcode');
  const audioMulti = d.audioTracks.length > 1;
  const supportsAudioSwitch = !!ref.current?.audioTracks && (ref.current.audioTracks.length ?? 0) > 1;

  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <Link to="/media" className="inline-flex items-center gap-1 text-sm text-accent hover:underline"><ArrowLeft size={14} aria-hidden />Library</Link>
      <div>
        <h1 className="break-words text-xl font-semibold">{d.title}</h1>
        <p className="text-sm text-muted">
          {[d.artist, d.album, d.kind === 'video' && d.width ? `${d.width}×${d.height}` : null, d.container?.split(',')[0], d.videoCodec, d.audioCodec, formatClock(d.durationMs), formatBytes(d.size)].filter(Boolean).join(' · ')}
        </p>
      </div>

      {(d.status === 'pending' || d.status === 'processing') && <p role="status" className="flex items-center gap-2 text-xs text-muted"><RefreshCw size={12} className="animate-spin" aria-hidden />Still analysing this file. You can play it already.</p>}

      {unreadable && (
        <div role="alert" className="space-y-2 rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm">
          <div className="flex items-start gap-2 text-danger"><AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />{d.error ?? 'This file could not be analysed.'}</div>
          <div className="flex gap-2">
            <a className={btnGhost} href={`/api/v1/files/${id}/content`} download><Download size={14} className="mr-1 inline" aria-hidden />Download original</a>
            <button className={btnGhost} onClick={() => reprobe.mutate()} disabled={reprobe.isPending}><RefreshCw size={14} className="mr-1 inline" aria-hidden />Try again</button>
          </div>
        </div>
      )}

      {!unreadable && (
        <div ref={box} tabIndex={0} onKeyDown={onKey} aria-label="Media player. Press ? for keyboard shortcuts." className="rounded-lg bg-black outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent">
          {isVideo ? (
            <video key={src} ref={ref} src={src} controls playsInline preload="metadata" tabIndex={-1} className="max-h-[70vh] w-full" crossOrigin="use-credentials"
              onError={() => setPlayError(true)}
              onLoadedMetadata={(e) => {
                const el = e.currentTarget; latest.current.dur = el.duration; el.playbackRate = speed;
                if (pendingSeek.current !== null) { el.currentTime = pendingSeek.current; pendingSeek.current = null; return; }
                const p = d.progress;
                if (!started.current && p && !p.completed && p.positionMs > 5000 && p.positionMs < el.duration * 1000 - 5000) { el.currentTime = p.positionMs / 1000; setResumedAt(p.positionMs); }
                started.current = true;
              }}
              onTimeUpdate={(e) => { latest.current.pos = e.currentTarget.currentTime; if (!e.currentTarget.paused && Date.now() - lastSaved.current > 5000) save(); }}
              onPause={() => save()} onEnded={() => save()}>
              {tracks.map((t) => <track key={t.id} kind="subtitles" label={t.label} src={`/api/v1/media/${id}/subtitles/${t.id}.vtt`} {...(t.language && /^[A-Za-z]{2,3}$/.test(t.language) ? { srcLang: t.language.toLowerCase() } : {})} />)}
            </video>
          ) : (
            <div className="space-y-3 p-4">
              {d.hasThumbnail && <img src={`/api/v1/media/${id}/thumbnail`} alt="" className="mx-auto max-h-64 rounded-md" />}
              <audio key={src} ref={ref as unknown as React.RefObject<HTMLAudioElement>} src={src} controls preload="metadata" className="w-full" crossOrigin="use-credentials"
                onError={() => setPlayError(true)}
                onLoadedMetadata={(e) => {
                  const el = e.currentTarget; latest.current.dur = el.duration; el.playbackRate = speed;
                  const p = d.progress;
                  if (!started.current && p && !p.completed && p.positionMs > 5000 && p.positionMs < el.duration * 1000 - 5000) { el.currentTime = p.positionMs / 1000; setResumedAt(p.positionMs); }
                  started.current = true;
                }}
                onTimeUpdate={(e) => { latest.current.pos = e.currentTarget.currentTime; if (!e.currentTarget.paused && Date.now() - lastSaved.current > 5000) save(); }}
                onPause={() => save()} onEnded={() => save()} />
            </div>
          )}
        </div>
      )}
      {!unreadable && isVideo && d.sprite && <PreviewTimeline media={ref} spriteUrl={`/api/v1/media/${id}/sprite`} sprite={d.sprite} fallbackDurationMs={d.durationMs} />}

      {resumedAt !== null && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">Resumed from {formatClock(resumedAt)}.
          <button className="text-accent hover:underline" onClick={() => { if (ref.current) ref.current.currentTime = 0; setResumedAt(null); }}>Start over</button></p>
      )}

      {cantPlay && !unreadable && (
        <div role="alert" className="space-y-2 rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm">
          <div className="flex items-start gap-2 text-danger"><AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
            {playError ? 'Your browser could not play this file.' : 'This file will probably not play in your browser.'} {viewingOriginal ? d.playback.reason : 'Try the original, or download it.'}</div>
          <p className="text-muted">{viewingOriginal && d.renditions.some((r) => r.status === 'ready') ? 'A converted copy is ready: choose it under Version.' : <>You can download the original{d.transcoding.enabled ? ' or create a copy that plays everywhere' : ''}.</>}</p>
        </div>
      )}
      {d.playback.mode === 'maybe' && !cantPlay && <p className="flex items-start gap-2 text-sm text-muted"><Info size={14} className="mt-0.5 shrink-0" aria-hidden />{d.playback.reason}</p>}

      {!unreadable && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface p-3 text-sm">
          <label className="flex items-center gap-1">Speed
            <select value={speed} onChange={(e) => { setSpeed(Number(e.target.value)); lsSet('media.speed', e.target.value); }} className="rounded-md border border-line bg-bg px-1.5 py-1">
              {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}</select></label>
          {isVideo && (
            <label className="flex items-center gap-1">Subtitles
              <select value={subtitle} onChange={(e) => setSubtitle(e.target.value)} className="rounded-md border border-line bg-bg px-1.5 py-1">
                <option value="off">Off</option>{tracks.map((t) => <option key={t.id} value={t.id}>{t.label}{t.language && t.label !== t.language ? ` (${t.language})` : ''}</option>)}</select></label>
          )}
          {audioMulti && (
            <label className="flex items-center gap-1" title={supportsAudioSwitch ? undefined : 'Your browser cannot switch audio tracks in a web page. Convert the file or use a desktop player.'}>Audio
              <select disabled={!supportsAudioSwitch} defaultValue={d.audioTracks.findIndex((a) => a.default) < 0 ? 0 : d.audioTracks.findIndex((a) => a.default)}
                onChange={(e) => { const at = ref.current?.audioTracks; if (at) for (let i = 0; i < at.length; i++) at[i]!.enabled = i === Number(e.target.value); }} className="rounded-md border border-line bg-bg px-1.5 py-1 disabled:opacity-60">
                {d.audioTracks.map((a, i) => <option key={a.index} value={i}>{a.title ?? a.language ?? `Track ${i + 1}`}{a.channels ? ` · ${a.channels}ch` : ''}</option>)}</select></label>
          )}
          {(d.renditions.some((r) => r.status === 'ready') || (isVideo && d.transcoding.enabled)) && (
            <label className="flex items-center gap-1">Quality
              <select value={source} onChange={(e) => {
                  const v = e.target.value;
                  if (v.startsWith('create:')) { convert.mutate(v.slice(7)); return; } // not made yet: start the conversion, keep playing
                  pendingSeek.current = latest.current.pos; setSource(v); setPlayError(false);
                }} className="rounded-md border border-line bg-bg px-1.5 py-1">
                <option value="original">Original{d.kind === 'video' && d.width ? ` (${d.height}p)` : ''}</option>
                {d.renditions.filter((r) => r.status === 'ready').map((r) => <option key={r.profile} value={r.profile}>{r.profile.replace(/^web-/, '')} (converted)</option>)}
                {isVideo && d.transcoding.enabled && d.transcoding.profiles
                  .filter((p) => !d.renditions.some((r) => r.profile === p.name && (r.status === 'ready' || r.status === 'queued' || r.status === 'processing')))
                  .map((p) => <option key={p.name} value={`create:${p.name}`}>{p.name.replace(/^web-/, '')} — create…</option>)}
              </select></label>
          )}
          <span className="ml-auto flex gap-2">
            {isVideo && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled && <button className={btnGhost} onClick={() => void togglePip()} aria-pressed={pip}><PictureInPicture2 size={14} className="mr-1 inline" aria-hidden />Pop out</button>}
            {isVideo && <button className={btnGhost} onClick={toggleFullscreen}><Maximize size={14} className="mr-1 inline" aria-hidden />Full screen</button>}
            <button className={btnGhost} onClick={() => setHelp((h) => !h)} aria-expanded={help}><Keyboard size={14} className="mr-1 inline" aria-hidden />Shortcuts</button>
          </span>
        </div>
      )}

      {help && (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 rounded-lg border border-line bg-surface p-3 text-sm sm:grid-cols-2">
          {SHORTCUTS.map(([k, v]) => <div key={k} className="flex justify-between gap-2"><dt className="font-mono text-xs">{k}</dt><dd className="text-muted">{v}</dd></div>)}
          <p className="col-span-full text-xs text-muted">Click the player first so it has the keyboard focus.</p>
        </dl>
      )}

      {d.subtitles.some((s) => !s.available && s.reason) && (
        <p className="text-xs text-muted">{d.subtitles.filter((s) => !s.available).map((s) => `${s.label}: ${s.reason}`).join(' · ')}</p>
      )}

      {!unreadable && (
        <section aria-label="Download and convert" className="flex flex-wrap items-center gap-2 text-sm">
          <a className={btnGhost} href={`/api/v1/files/${id}/content`} download><Download size={14} className="mr-1 inline" aria-hidden />Download original</a>
          {d.transcoding.enabled && d.transcoding.profiles.map((p) => {
            const r = d.renditions.find((x) => x.profile === p.name);
            if (r?.status === 'ready') return <button key={p.name} className={btnGhost} onClick={() => { pendingSeek.current = latest.current.pos; setSource(p.name); setPlayError(false); }}>Play converted ({p.name})</button>;
            if (r && (r.status === 'queued' || r.status === 'processing')) return <span key={p.name} role="status" className="text-muted">Converting ({p.name}): {r.status === 'queued' ? 'waiting' : `${Math.round(r.progress * 100)}%`}</span>;
            return (
              <button key={p.name} className={cantPlay ? btnPrimary : btnGhost} title={p.description} disabled={convert.isPending} onClick={() => convert.mutate(p.name)}>
                <Wand2 size={14} className="mr-1 inline" aria-hidden />{r?.status === 'failed' ? `Retry conversion (${p.name})` : `Convert (${p.name})`}</button>
            );
          })}
          {d.renditions.filter((r) => r.status === 'failed').map((r) => <span key={r.profile} role="alert" className="text-danger">{r.profile}: {r.error}</span>)}
          {convert.error && <span role="alert" className="text-danger">{convert.error instanceof ApiError ? convert.error.message : 'Could not start the conversion'}</span>}
        </section>
      )}
    </div>
  );
}
