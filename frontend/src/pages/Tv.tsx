import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Film, Music, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, formatClock, type MediaDetail, type MediaItem } from '../api';

/**
 * "TV mode": a big-type, remote-friendly view of the media library for smart-TV browsers (and any large screen).
 * Everything is a focusable tile moved with the arrow keys / D-pad; Enter plays; Back (or Esc / Backspace) goes back.
 * It uses only the browser's own video player, which is what smart-TV browsers support best.
 */

const BACK_KEYS = new Set(['Escape', 'Backspace', 'BrowserBack', 'GoBack', 'XF86Back']);
const BACK_CODES = new Set([10009, 461, 27]); // Samsung Tizen, LG webOS, Esc

/** Moves focus to the nearest focusable tile in the pressed direction (browsers on TVs have no good built-in spatial navigation). */
function moveFocus(dir: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'): boolean {
  const items = [...document.querySelectorAll<HTMLElement>('[data-tv]')];
  const cur = document.activeElement as HTMLElement | null;
  if (!items.length) return false;
  if (!cur || !items.includes(cur)) { items[0]!.focus(); return true; }
  const c = cur.getBoundingClientRect(); const cx = c.left + c.width / 2, cy = c.top + c.height / 2;
  let best: HTMLElement | null = null; let bestScore = Infinity;
  for (const el of items) {
    if (el === cur) continue;
    const r = el.getBoundingClientRect(); const x = r.left + r.width / 2 - cx, y = r.top + r.height / 2 - cy;
    const along = dir === 'ArrowLeft' ? -x : dir === 'ArrowRight' ? x : dir === 'ArrowUp' ? -y : y;
    if (along <= 4) continue; // not in that direction
    const across = dir === 'ArrowLeft' || dir === 'ArrowRight' ? Math.abs(y) : Math.abs(x);
    const score = along + across * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (!best) return false;
  best.focus(); best.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  return true;
}

function useRemote(onBack: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'VIDEO' || t.tagName === 'AUDIO') { if (BACK_KEYS.has(e.key) || BACK_CODES.has(e.keyCode)) { e.preventDefault(); onBack(); } return; }
      if (e.key.startsWith('Arrow') && moveFocus(e.key as 'ArrowLeft')) e.preventDefault();
      else if (BACK_KEYS.has(e.key) || BACK_CODES.has(e.keyCode)) { e.preventDefault(); onBack(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);
}

function Tile({ m }: { m: MediaItem }) {
  const pct = m.progress?.durationMs ? Math.min(100, (m.progress.positionMs / m.progress.durationMs) * 100) : 0;
  const bad = m.status === 'failed' || m.status === 'unsupported';
  return (
    <Link to={`/tv/${m.id}`} data-tv className="group block w-72 shrink-0 rounded-3xl border border-line bg-surface p-3 outline-none transition focus:scale-105 focus:border-accent focus:ring-4 focus:ring-accent/50 sm:w-80">
      <div className="relative aspect-video overflow-hidden rounded-2xl bg-line/50">
        {m.hasThumbnail ? <img src={`/api/v1/media/${m.id}/thumbnail`} alt="" className="h-full w-full object-cover" />
          : <div className="grid h-full place-items-center text-muted">{m.kind === 'video' ? <Film size={48} aria-hidden /> : <Music size={48} aria-hidden />}</div>}
        {pct > 0 && !m.progress?.completed && <div className="absolute inset-x-0 bottom-0 h-1.5 bg-black/40"><div className="h-full bg-accent" style={{ width: `${pct}%` }} /></div>}
        {bad && <span className="absolute left-2 top-2 rounded bg-danger px-2 py-0.5 text-sm text-white">Can’t play</span>}
      </div>
      <div className="mt-3 truncate text-xl font-medium">{m.title}</div>
      <div className="text-base text-muted">{formatClock(m.durationMs)}{m.progress?.completed ? ' · watched' : ''}</div>
    </Link>
  );
}

function Row({ title, items }: { title: string; items: MediaItem[] }) {
  if (!items.length) return null;
  return (
    <section aria-label={title} className="mb-8">
      <h2 className="mb-3 px-2 text-2xl font-semibold">{title}</h2>
      <div className="flex gap-5 overflow-x-auto px-2 py-4">{items.map((m) => <Tile key={m.id} m={m} />)}</div>
    </section>
  );
}

export function TvHome() {
  const nav = useNavigate();
  const recent = useInfiniteQuery({
    queryKey: ['tv-media'], initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<{ items: MediaItem[]; nextCursor: string | null }>(`/media?sort=date&dir=desc&limit=40${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (l) => l.nextCursor,
  });
  const cont = useQuery({ queryKey: ['tv-continue'], queryFn: () => api<{ items: MediaItem[] }>('/media?progress=inprogress&sort=date&dir=desc&limit=20') });
  const all = recent.data?.pages.flatMap((p) => p.items).filter((m) => m.status !== 'failed' && m.status !== 'unsupported') ?? [];
  const videos = all.filter((m) => m.kind === 'video'); const music = all.filter((m) => m.kind === 'audio');
  useRemote(() => nav('/'));
  useEffect(() => { document.querySelector<HTMLElement>('section [data-tv]')?.focus(); }, [recent.data, cont.data]);

  return (
    <div className="min-h-screen px-6 py-8 text-fg">
      <header className="mb-6 flex items-center justify-between px-2">
        <h1 className="text-4xl font-bold">CloudSeed</h1>
        <Link to="/" onClick={() => { try { sessionStorage.setItem('tv-optout', '1'); } catch { /* storage unavailable */ } }} data-tv className="rounded-full border border-line bg-surface px-6 py-3 text-lg outline-none focus:border-accent focus:ring-4 focus:ring-accent/50">Normal view</Link>
      </header>
      {recent.isPending ? <p role="status" className="px-2 text-2xl text-muted">Loading…</p>
        : all.length === 0 ? <p className="px-2 text-2xl text-muted">No videos or music yet. Upload some from your computer or phone, then come back.</p>
        : <>
          <Row title="Continue watching" items={cont.data?.items ?? []} />
          <Row title="Videos" items={videos} />
          <Row title="Music" items={music} />
          {recent.hasNextPage && <button data-tv onClick={() => void recent.fetchNextPage()} className="ml-2 rounded-full border border-line bg-surface px-6 py-3 text-lg outline-none focus:border-accent focus:ring-4 focus:ring-accent/50">Show more</button>}
        </>}
    </div>
  );
}

export function TvPlayer() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState(false);
  const pos = useRef({ t: 0, d: 0 });
  const detail = useQuery({ queryKey: ['media-item', id], queryFn: () => api<MediaDetail>(`/media/${id}`) });
  const d = detail.data;
  // Same rule as the normal player: a finished converted copy when the original is not browser-playable
  const ready = d?.renditions.find((r) => r.status === 'ready');
  const rendition = d && d.playback.mode === 'transcode' && ready ? ready.profile : null;
  const src = `/api/v1/media/${id}/stream${rendition ? `?rendition=${encodeURIComponent(rendition)}` : ''}`;
  const save = () => {
    if (pos.current.t <= 0) return;
    api(`/media/${id}/progress`, { method: 'PUT', keepalive: true, body: { positionMs: Math.round(pos.current.t * 1000), durationMs: pos.current.d > 0 && Number.isFinite(pos.current.d) ? Math.round(pos.current.d * 1000) : null } }).catch(() => undefined);
  };
  const back = () => { save(); nav('/tv'); };
  useRemote(back);
  useEffect(() => { const i = setInterval(save, 10_000); return () => { clearInterval(i); save(); }; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);
  const cantPlay = error || (d && d.playback.mode === 'transcode' && !rendition);

  return (
    <div className="grid min-h-screen place-items-center bg-black p-4 text-white">
      {detail.isPending ? <p role="status" className="text-2xl">Loading…</p>
        : !d ? <p role="alert" className="text-2xl">Could not load this item.</p>
        : cantPlay ? (
          <div className="max-w-xl space-y-4 text-center">
            <p role="alert" className="text-2xl">This file can’t be played on this device as it is.</p>
            <p className="text-lg text-white/70">Open it on a computer or phone and create a converted copy (Quality menu), then it will play here.</p>
            <Link to="/tv" data-tv autoFocus className="inline-block rounded-full bg-white/15 px-8 py-3 text-xl outline-none focus:ring-4 focus:ring-white/60">Back</Link>
          </div>
        ) : (
          <div className="w-full">
            <h1 className="mb-2 truncate text-2xl font-semibold">{d.title}</h1>
            {d.kind === 'audio' && d.hasThumbnail && <img src={`/api/v1/media/${id}/thumbnail`} alt="" className="mx-auto mb-4 max-h-64 rounded-2xl" />}
            <video ref={ref} key={src} src={src} controls autoPlay playsInline crossOrigin="use-credentials" className="max-h-[85vh] w-full rounded-2xl bg-black outline-none focus:ring-4 focus:ring-white/60"
              onLoadedMetadata={(e) => {
                const el = e.currentTarget; pos.current.d = el.duration;
                const p = d.progress;
                if (p && !p.completed && p.positionMs > 5000 && Number.isFinite(el.duration) && p.positionMs < el.duration * 1000 - 5000) el.currentTime = p.positionMs / 1000;
                el.focus();
              }}
              onTimeUpdate={(e) => { pos.current.t = e.currentTarget.currentTime; }}
              onError={() => setError(true)} onEnded={back} />
            <p className="mt-3 flex items-center gap-2 text-base text-white/70"><Play size={16} aria-hidden /> Press OK to play or pause, left/right to skip, Back to return.</p>
          </div>
        )}
    </div>
  );
}
