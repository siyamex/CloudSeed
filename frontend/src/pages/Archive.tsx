import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Download, File as FileIcon, Folder, PackageOpen, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, formatBytes } from '../api';
import { btnGhost, btnPrimary } from '../components/Dialog';

interface Entry { path: string; size: number; isDir: boolean; encrypted: boolean; modifiedAt: string | null }
interface Listing { name: string; kind: 'zip' | '7z' | 'rar'; folderId: string | null; entries: Entry[]; hidden: number }
interface Extracted { folderId: string; folderName: string; files: number; skipped: { path: string; reason: string }[]; skippedCount: number }

/** Looks inside a ZIP, 7Z or RAR file: the table of contents is read without unpacking anything. */
export function Archive() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [dir, setDir] = useState('');
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const listing = useQuery({ queryKey: ['archive', id], queryFn: () => api<Listing>(`/files/${id}/archive`), retry: false, staleTime: 60_000 });
  const extract = useMutation({
    mutationFn: (paths?: string[]) => api<Extracted>(`/files/${id}/archive/extract`, { method: 'POST', body: { ...(paths ? { paths } : {}), targetFolderId: listing.data?.folderId ?? null } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['files'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] }); setPicked(new Set()); },
  });

  // The archive stores flat paths; build the one folder level being looked at from them
  const rows = useMemo(() => {
    const all = listing.data?.entries ?? [];
    const f = filter.trim().toLowerCase();
    if (f) return all.filter((e) => !e.isDir && e.path.toLowerCase().includes(f)).slice(0, 500)
      .map((e) => ({ name: e.path, path: e.path, isDir: false, size: e.size, encrypted: e.encrypted }));
    const prefix = dir ? `${dir}/` : '';
    const seen = new Map<string, { name: string; path: string; isDir: boolean; size: number; encrypted: boolean }>();
    for (const e of all) {
      if (!e.path.startsWith(prefix)) continue;
      const rest = e.path.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash === -1 && !e.isDir) seen.set(rest, { name: rest, path: e.path, isDir: false, size: e.size, encrypted: e.encrypted });
      else { const n = slash === -1 ? rest : rest.slice(0, slash); if (!seen.has(n) || !seen.get(n)!.isDir) seen.set(n, { name: n, path: prefix + n, isDir: true, size: 0, encrypted: false }); }
    }
    return [...seen.values()].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  }, [listing.data, dir, filter]);

  const toggle = (p: string) => setPicked((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; });
  const crumbs = dir ? dir.split('/') : [];
  const err = listing.error instanceof ApiError ? listing.error : null;
  const fileCount = listing.data?.entries.filter((e) => !e.isDir).length ?? 0;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Link to="/files" className="text-sm text-accent hover:underline">← My Files</Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold"><PackageOpen size={20} aria-hidden />{listing.data?.name ?? 'Archive'}</h1>
          {listing.data && <p className="text-sm text-muted">{listing.data.kind.toUpperCase()} · {fileCount} files. Browsing only reads the contents list; nothing is unpacked.</p>}
        </div>
        {listing.data && (
          <div className="flex gap-2">
            <button className={btnGhost} disabled={picked.size === 0 || extract.isPending} onClick={() => extract.mutate([...picked])}>Extract selected ({picked.size})</button>
            <button className={btnPrimary} disabled={extract.isPending || fileCount === 0} onClick={() => extract.mutate(undefined)}>{extract.isPending ? 'Extracting…' : 'Extract all'}</button>
          </div>
        )}
      </div>

      {extract.error && <p role="alert" className="rounded-lg border border-line bg-surface p-3 text-sm text-danger">{extract.error instanceof ApiError ? extract.error.message : 'Extraction failed'}</p>}
      {extract.data && (
        <p role="status" className="rounded-lg border border-line bg-surface p-3 text-sm">
          Extracted {extract.data.files} file{extract.data.files === 1 ? '' : 's'} into <Link className="text-accent hover:underline" to={`/files?folder=${extract.data.folderId}`}>“{extract.data.folderName}”</Link>.
          {extract.data.skippedCount > 0 && <span className="text-muted"> {extract.data.skippedCount} skipped ({[...new Set(extract.data.skipped.map((s) => s.reason))].join(', ')}).</span>}
        </p>
      )}

      {listing.isPending ? <div className="animate-pulse space-y-2 rounded-lg border border-line bg-surface p-4" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-8 rounded bg-line/60" />)}</div>
        : err ? <p role="alert" className="rounded-lg border border-line bg-surface p-6 text-sm text-danger">{err.message}</p>
        : listing.data && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <nav aria-label="Folder inside the archive" className="flex flex-wrap items-center gap-1 text-sm">
                <button className="font-medium hover:underline" onClick={() => { setDir(''); setFilter(''); }}>{listing.data.name}</button>
                {crumbs.map((c, i) => <span key={i} className="flex items-center gap-1"><ChevronRight size={14} className="text-muted" aria-hidden />
                  <button className="hover:underline" onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}>{c}</button></span>)}
              </nav>
              <label className="relative ml-auto min-w-48 flex-1 sm:max-w-xs"><span className="sr-only">Search inside the archive</span>
                <Search size={16} className="absolute left-3 top-2.5 text-muted" aria-hidden />
                <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search inside" className="w-full rounded-full border border-line bg-bg py-2 pl-9 pr-3 text-sm" /></label>
            </div>
            <div className="rounded-lg border border-line bg-surface">
              {rows.length === 0 ? <p className="p-8 text-center text-sm text-muted">{filter ? 'No matching files.' : 'Empty folder.'}</p> : (
                <table className="w-full text-sm"><caption className="sr-only">Archive contents</caption>
                  <tbody className="divide-y divide-line">
                    {rows.map((r) => (
                      <tr key={r.path} className={picked.has(r.path) ? 'bg-accent/5' : 'hover:bg-line/30'}>
                        <td className="w-10 p-3"><input type="checkbox" checked={picked.has(r.path)} onChange={() => toggle(r.path)} aria-label={`Select ${r.name}`} /></td>
                        <td className="p-3">{r.isDir
                          ? <button className="flex items-center gap-2 hover:underline" onClick={() => { setDir(r.path); setFilter(''); }}><Folder size={16} className="text-accent" aria-hidden />{r.name}</button>
                          : <span className="flex items-center gap-2"><FileIcon size={16} className="shrink-0 text-muted" aria-hidden /><span className="break-all">{r.name}</span>{r.encrypted && <span className="rounded-full border border-line px-2 text-xs text-muted">password</span>}</span>}</td>
                        <td className="hidden p-3 text-muted sm:table-cell">{r.isDir ? '' : formatBytes(r.size)}</td>
                        <td className="w-12 p-3 text-right">{!r.isDir && !r.encrypted && (
                          <a href={`/api/v1/files/${id}/archive/entry?path=${encodeURIComponent(r.path)}`} download aria-label={`Download ${r.name}`} className="inline-block rounded p-1.5 text-muted hover:bg-line/60"><Download size={16} /></a>)}</td>
                      </tr>))}
                  </tbody></table>)}
            </div>
            {listing.data.hidden > 0 && <p className="text-xs text-muted">{listing.data.hidden} entr{listing.data.hidden === 1 ? 'y was' : 'ies were'} hidden because of an unsafe name or because they are links.</p>}
          </>)}
    </div>
  );
}
