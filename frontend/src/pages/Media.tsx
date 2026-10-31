import { useInfiniteQuery } from '@tanstack/react-query';
import { AlertTriangle, Film, Loader2, Music, Play, Search } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, formatBytes, formatClock, type MediaItem } from '../api';

interface Page { items: MediaItem[]; nextCursor: string | null }

function Card({ m }: { m: MediaItem }) {
  const busy = m.status === 'pending' || m.status === 'processing';
  const pct = m.progress && m.progress.durationMs ? Math.min(100, (m.progress.positionMs / m.progress.durationMs) * 100) : 0;
  const bad = m.status === 'failed' || m.status === 'unsupported';
  return (
    <li className="overflow-hidden rounded-lg border border-line bg-surface">
      <Link to={`/media/${m.id}`} className="block" aria-label={`Play ${m.title}`}>
        <div className="relative aspect-video bg-line/50">
          {m.hasThumbnail
            ? <img src={`/api/v1/media/${m.id}/thumbnail`} alt="" loading="lazy" className="h-full w-full object-cover" />
            : <div className="grid h-full place-items-center text-muted">{m.kind === 'video' ? <Film size={32} aria-hidden /> : <Music size={32} aria-hidden />}</div>}
          <span className="absolute right-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white">{formatClock(m.durationMs)}</span>
          {busy && <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white"><Loader2 size={11} className="animate-spin" aria-hidden />Preparing</span>}
          {bad && <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded bg-danger px-1.5 py-0.5 text-xs text-white"><AlertTriangle size={11} aria-hidden />{m.status === 'failed' ? 'Failed' : 'Unreadable'}</span>}
          <span className="absolute inset-0 grid place-items-center opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100"><Play size={36} className="rounded-full bg-black/60 p-2 text-white" aria-hidden /></span>
          {pct > 0 && !m.progress?.completed && <div className="absolute inset-x-0 bottom-0 h-1 bg-black/40"><div className="h-full bg-accent" style={{ width: `${pct}%` }} /></div>}
        </div>
        <div className="p-3">
          <div className="truncate text-sm font-medium" title={m.title}>{m.title}</div>
          <div className="truncate text-xs text-muted">
            {m.artist ? `${m.artist}${m.album ? ` · ${m.album}` : ''}` : m.kind === 'video' && m.width ? `${m.width}×${m.height}` : m.kind}
            {' · '}{formatBytes(m.size)}{m.progress?.completed ? ' · watched' : ''}
          </div>
        </div>
      </Link>
    </li>
  );
}

export function Media() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const type = params.get('type') ?? '';
  const sort = params.get('sort') ?? 'date:desc';
  const view = params.get('view') ?? '';
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setParams(next, { replace: true });
  };

  const list = useInfiniteQuery({
    queryKey: ['media', q, type, sort, view],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const [s, d] = sort.split(':');
      const p = new URLSearchParams({ sort: s ?? 'date', dir: d ?? 'desc', limit: '40' });
      if (q) p.set('q', q);
      if (type) p.set('type', type);
      if (view === 'continue') p.set('progress', 'inprogress');
      if (pageParam) p.set('cursor', pageParam);
      return api<Page>(`/media?${p}`);
    },
    getNextPageParam: (last) => last.nextCursor,
    // Items are indexed in the background; keep refreshing while any is still being prepared.
    refetchInterval: (query) => (query.state.data?.pages.some((pg) => pg.items.some((i) => i.status === 'pending' || i.status === 'processing')) ? 3000 : false),
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <h1 className="text-xl font-semibold">Media Library</h1>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <div role="tablist" aria-label="View" className="flex gap-1">
          {([['', 'All'], ['continue', 'Continue watching']] as const).map(([v, label]) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => set({ view: v || null })}
              className={`rounded-md px-3 py-1.5 ${view === v ? 'bg-accent/10 font-medium text-accent' : 'text-muted hover:bg-line/50'}`}>{label}</button>
          ))}
        </div>
        <label className="relative min-w-52 flex-1"><span className="sr-only">Search the media library</span>
          <Search size={16} className="absolute left-3 top-2.5 text-muted" aria-hidden />
          <input type="search" defaultValue={q} placeholder="Search title, artist or album" onKeyDown={(e) => { if (e.key === 'Enter') set({ q: e.currentTarget.value.trim() || null }); }}
            className="w-full rounded-md border border-line bg-surface py-2 pl-9 pr-3" /></label>
        <label><span className="sr-only">Type</span>
          <select value={type} onChange={(e) => set({ type: e.target.value || null })} className="rounded-md border border-line bg-surface px-2 py-2">
            <option value="">Video and audio</option><option value="video">Video</option><option value="audio">Audio</option></select></label>
        <label><span className="sr-only">Sort by</span>
          <select value={sort} onChange={(e) => set({ sort: e.target.value })} className="rounded-md border border-line bg-surface px-2 py-2">
            <option value="date:desc">Newest</option><option value="date:asc">Oldest</option><option value="title:asc">Title A–Z</option>
            <option value="duration:desc">Longest</option><option value="size:desc">Largest</option></select></label>
      </div>

      {list.isPending ? <div className="grid animate-pulse gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">{Array.from({ length: 8 }, (_, i) => <div key={i} className="aspect-video rounded-lg bg-line/60" />)}</div>
        : list.error ? <p role="alert" className="text-danger">Failed to load the library: {list.error.message}</p>
        : items.length === 0 ? (
          <p className="rounded-lg border border-line bg-surface p-12 text-center text-sm text-muted">
            {q || type || view ? 'Nothing matches.' : <>No media yet. Upload audio or video files in <Link to="/files" className="text-accent hover:underline">My Files</Link>, or fetch one in <Link to="/downloads" className="text-accent hover:underline">Downloads</Link>: they appear here automatically.</>}
          </p>
        ) : (
          <>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{items.map((m) => <Card key={m.id} m={m} />)}</ul>
            {list.hasNextPage && <div className="text-center"><button className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-line/50" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading…' : 'Load more'}</button></div>}
          </>
        )}
    </div>
  );
}
