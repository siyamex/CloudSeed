import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Copy, Download, FolderInput, PackageOpen, Link2, Send, File as FileIcon, Folder, FolderPlus, Pencil, Search, Trash2, Upload, X } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, api, formatBytes, uploadFile, type FileItem, type FolderItem, type Listing } from '../api';
import { Dialog, btnDanger, btnGhost, btnPrimary } from '../components/Dialog';
import { SendToTelegram } from '../components/SendToTelegram';
import { ShareDialog } from '../components/ShareDialog';

type Entry = { kind: 'folder'; item: FolderItem } | { kind: 'file'; item: FileItem };
interface UploadJob { id: number; name: string; loaded: number; total: number; state: 'uploading' | 'done' | 'error'; error?: string; abort: () => void }
interface Conflict { file: File; folderId: string | null }

let jobSeq = 0;

export function Files() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const folder = params.get('folder') ?? 'root';
  const q = params.get('q') ?? '';
  const type = params.get('type') ?? '';
  const sort = params.get('sort') ?? 'name';
  const dir = params.get('dir') ?? 'asc';
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setParams(next, { replace: true });
  };

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<null | { kind: 'mkdir' } | { kind: 'rename'; entry: Entry } | { kind: 'delete'; entries: Entry[] } | { kind: 'move' | 'copy'; entries: Entry[] }>(null);
  const [dest, setDest] = useState<string>('root');
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [telegramFiles, setTelegramFiles] = useState<FileItem[] | null>(null);
  const [shareFile, setShareFile] = useState<{ item: Pick<FileItem, 'id' | 'name' | 'sharingDisabled'>; kind: 'file' | 'folder' } | null>(null);
  const [name, setName] = useState('');
  const [formError, setFormError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const list = useInfiniteQuery({
    queryKey: ['files', folder, q, type, sort, dir],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ folder, sort, dir, limit: '50' });
      if (q) p.set('q', q);
      if (type) p.set('type', type);
      if (pageParam) p.set('cursor', pageParam);
      return api<Listing>(`/files?${p}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });

  const allFolders = useQuery({ queryKey: ['folders-all'], queryFn: () => api<{ folders: { id: string; parentId: string | null; name: string }[] }>('/folders'), enabled: dialog?.kind === 'move' || dialog?.kind === 'copy' });
  const first = list.data?.pages[0];
  const entries: Entry[] = list.data
    ? [...(first?.folders ?? []).map((item): Entry => ({ kind: 'folder', item })),
       ...list.data.pages.flatMap((p) => p.files).map((item): Entry => ({ kind: 'file', item }))]
    : [];
  const keyOf = (e: Entry) => `${e.kind}:${e.item.id}`;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['files'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] }); void qc.invalidateQueries({ queryKey: ['trash'] }); };
  const currentFolder = folder === 'root' ? null : folder;

  const mutate = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { refresh(); setDialog(null); setSelected(new Set()); setFormError(''); },
    onError: (e) => setFormError(e instanceof ApiError ? e.message : 'Something went wrong'),
  });

  function startUpload(file: File, folderId: string | null, onConflict: 'reject' | 'rename' | 'replace' = 'reject') {
    const id = ++jobSeq;
    const { promise, abort } = uploadFile(file, folderId, onConflict, (loaded, total) =>
      setJobs((js) => js.map((j) => (j.id === id ? { ...j, loaded, total } : j))));
    setJobs((js) => [...js, { id, name: file.name, loaded: 0, total: file.size, state: 'uploading', abort }]);
    promise.then(() => { setJobs((js) => js.map((j) => (j.id === id ? { ...j, state: 'done', loaded: j.total } : j))); refresh(); })
      .catch((e: ApiError) => {
        if (e.code === 'name_conflict') { setJobs((js) => js.filter((j) => j.id !== id)); setConflict({ file, folderId }); return; }
        setJobs((js) => js.map((j) => (j.id === id ? { ...j, state: 'error', error: e.message } : j)));
      });
  }

  const onFiles = (files: FileList | File[]) => { for (const f of Array.from(files)) startUpload(f, currentFolder); };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files); };

  const toggle = (e: Entry) => setSelected((s) => { const n = new Set(s); n.has(keyOf(e)) ? n.delete(keyOf(e)) : n.add(keyOf(e)); return n; });
  const selectedEntries = entries.filter((e) => selected.has(keyOf(e)));
  const crumbs = first?.breadcrumbs ?? [];

  const submitName = () => {
    if (!dialog) return;
    if (dialog.kind === 'mkdir') mutate.mutate(() => api('/folders', { method: 'POST', body: { name, parentId: currentFolder } }));
    if (dialog.kind === 'rename') {
      const e = dialog.entry;
      mutate.mutate(() => api(`/${e.kind === 'folder' ? 'folders' : 'files'}/${e.item.id}`, { method: 'PATCH', body: { name } }));
    }
  };
  /** Folder paths for the destination picker; folders being moved/copied (and their children) are left out. */
  const destinations = (() => {
    const fs = allFolders.data?.folders ?? [];
    const byId = new Map(fs.map((f) => [f.id, f]));
    const pathOf = (id: string): string => { const f = byId.get(id); return f ? (f.parentId ? `${pathOf(f.parentId)} / ` : '') + f.name : ''; };
    const blocked = new Set<string>();
    if (dialog?.kind === 'move' || dialog?.kind === 'copy') {
      const roots = dialog.entries.filter((e) => e.kind === 'folder').map((e) => e.item.id);
      const down = (id: string) => { blocked.add(id); fs.filter((f) => f.parentId === id).forEach((f) => down(f.id)); };
      roots.forEach(down);
    }
    return fs.filter((f) => !blocked.has(f.id)).map((f) => ({ id: f.id, path: pathOf(f.id) })).sort((a, b) => a.path.localeCompare(b.path));
  })();
  const confirmTransfer = () => {
    if (dialog?.kind !== 'move' && dialog?.kind !== 'copy') return;
    const { kind, entries: items } = dialog;
    const target = dest === 'root' ? null : dest;
    if (kind === 'copy') {
      mutate.mutate(() => api('/files/copy', { method: 'POST', body: {
        fileIds: items.filter((e) => e.kind === 'file').map((e) => e.item.id),
        folderIds: items.filter((e) => e.kind === 'folder').map((e) => e.item.id), targetFolderId: target } }));
    } else {
      mutate.mutate(async () => {
        for (const e of items) await api(`/${e.kind === 'folder' ? 'folders' : 'files'}/${e.item.id}`, e.kind === 'folder'
          ? { method: 'PATCH', body: { parentId: target } } : { method: 'PATCH', body: { folderId: target } });
      });
    }
  };
  const confirmDelete = () => {
    if (dialog?.kind !== 'delete') return;
    const entriesToDelete = dialog.entries;
    mutate.mutate(() => api('/files/bulk-delete', { method: 'POST', body: {
      fileIds: entriesToDelete.filter((e) => e.kind === 'file').map((e) => e.item.id),
      folderIds: entriesToDelete.filter((e) => e.kind === 'folder').map((e) => e.item.id),
    } }));
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }} onDrop={onDrop}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm">
          <button className="font-medium hover:underline" onClick={() => set({ folder: null, q: null })}>My Files</button>
          {!q && crumbs.map((c) => (
            <span key={c.id} className="flex items-center gap-1"><ChevronRight size={14} className="text-muted" aria-hidden />
              <button className="hover:underline" onClick={() => set({ folder: c.id })}>{c.name}</button></span>
          ))}
          {q && <span className="text-muted"> / search results</span>}
        </nav>
        <div className="flex gap-2">
          <button className={btnGhost} onClick={() => { setName(''); setFormError(''); setDialog({ kind: 'mkdir' }); }}><FolderPlus size={16} className="mr-1 inline" aria-hidden />New folder</button>
          <button className={btnPrimary} onClick={() => fileInput.current?.click()}><Upload size={16} className="mr-1 inline" aria-hidden />Upload</button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) onFiles(e.target.files); e.target.value = ''; }} aria-label="Choose files to upload" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative flex-1 min-w-48">
          <span className="sr-only">Search files by name</span>
          <Search size={16} className="absolute left-3 top-2.5 text-muted" aria-hidden />
          <input type="search" defaultValue={q} placeholder="Search by filename"
            onKeyDown={(e) => { if (e.key === 'Enter') set({ q: e.currentTarget.value.trim() || null }); }}
            className="w-full rounded-md border border-line bg-surface py-2 pl-9 pr-3 text-sm" />
        </label>
        <label className="text-sm"><span className="sr-only">Filter by type</span>
          <select value={type} onChange={(e) => set({ type: e.target.value || null })} className="rounded-md border border-line bg-surface px-2 py-2 text-sm">
            <option value="">All types</option>
            {['image', 'video', 'audio', 'text', 'pdf', 'archive'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select></label>
        <label className="text-sm"><span className="sr-only">Sort by</span>
          <select value={`${sort}:${dir}`} onChange={(e) => { const [s, d] = e.target.value.split(':'); set({ sort: s ?? null, dir: d ?? null }); }} className="rounded-md border border-line bg-surface px-2 py-2 text-sm">
            <option value="name:asc">Name A–Z</option><option value="name:desc">Name Z–A</option>
            <option value="date:desc">Newest</option><option value="date:asc">Oldest</option>
            <option value="size:desc">Largest</option><option value="size:asc">Smallest</option>
            <option value="type:asc">Type</option>
          </select></label>
      </div>

      {selected.size > 0 && (
        <div className="flex items-center justify-between rounded-md border border-line bg-surface px-3 py-2 text-sm" role="region" aria-label="Selection actions">
          <span>{selected.size} selected</span>
          <div className="flex gap-2">
            <button className={btnGhost} onClick={() => setSelected(new Set())}>Clear</button>
            <button className={btnGhost} disabled={!selectedEntries.some((e) => e.kind === 'file')}
              title={selectedEntries.some((e) => e.kind === 'folder') ? 'Folders are skipped: only files can be sent' : undefined}
              onClick={() => setTelegramFiles(selectedEntries.flatMap((e) => (e.kind === 'file' ? [e.item] : [])))}><Send size={14} className="mr-1 inline" aria-hidden />Send to Telegram</button>
            <button className={btnGhost} onClick={() => { setFormError(''); setDest('root'); setDialog({ kind: 'move', entries: selectedEntries }); }}><FolderInput size={14} className="mr-1 inline" aria-hidden />Move to…</button>
            <button className={btnGhost} onClick={() => { setFormError(''); setDest('root'); setDialog({ kind: 'copy', entries: selectedEntries }); }}><Copy size={14} className="mr-1 inline" aria-hidden />Copy to…</button>
            <button className={btnDanger} onClick={() => { setFormError(''); setDialog({ kind: 'delete', entries: selectedEntries }); }}>Move to trash</button>
          </div>
        </div>
      )}

      <div className={`relative rounded-lg border bg-surface ${dragging ? 'border-accent ring-2 ring-accent/30' : 'border-line'}`}>
        {dragging && <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-lg bg-accent/10 text-sm font-medium text-accent">Drop files to upload here</div>}
        {list.isPending ? (
          <div className="animate-pulse space-y-2 p-4" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="h-8 rounded bg-line/60" />)}</div>
        ) : list.error ? (
          <p role="alert" className="p-6 text-danger">Failed to load files: {list.error.message}</p>
        ) : entries.length === 0 ? (
          <div className="p-12 text-center text-sm text-muted">{q || type ? 'No matching files.' : 'This folder is empty. Drag files here or use Upload.'}</div>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Files and folders</caption>
            <thead className="border-b border-line text-left text-xs uppercase text-muted">
              <tr><th className="w-10 p-3"><span className="sr-only">Select</span></th><th className="p-3">Name</th><th className="hidden p-3 sm:table-cell">Size</th><th className="hidden p-3 md:table-cell">Created</th><th className="w-28 p-3"><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {entries.map((e) => (
                <tr key={keyOf(e)} className={selected.has(keyOf(e)) ? 'bg-accent/5' : 'hover:bg-line/30'}>
                  <td className="p-3"><input type="checkbox" checked={selected.has(keyOf(e))} onChange={() => toggle(e)} aria-label={`Select ${e.item.name}`} /></td>
                  <td className="p-3">
                    {e.kind === 'folder'
                      ? <button className="flex items-center gap-2 hover:underline" onClick={() => set({ folder: e.item.id, q: null })}><Folder size={16} className="text-accent" aria-hidden />{e.item.name}</button>
                      : <span className="flex items-center gap-2"><FileIcon size={16} className="shrink-0 text-muted" aria-hidden /><span className="truncate">{e.item.name}</span></span>}
                  </td>
                  <td className="hidden p-3 text-muted sm:table-cell">{e.kind === 'file' ? formatBytes(e.item.size) : '—'}</td>
                  <td className="hidden p-3 text-muted md:table-cell">{new Date(e.item.createdAt).toLocaleDateString()}</td>
                  <td className="p-3">
                    <div className="flex justify-end gap-1">
                      {e.kind === 'file' && /\.(zip|7z|rar|cbz|cbr)$/i.test(e.item.name) && <Link to={`/archive/${e.item.id}`} aria-label={`Browse inside ${e.item.name}`} title="Browse inside" className="rounded p-1.5 text-muted hover:bg-line/60"><PackageOpen size={16} /></Link>}
                      {e.kind === 'file' && <a href={`/api/v1/files/${e.item.id}/content`} download aria-label={`Download ${e.item.name}`} className="rounded p-1.5 text-muted hover:bg-line/60"><Download size={16} /></a>}
                      {e.kind === 'file' && <button aria-label={`Share ${e.item.name}`} className="rounded p-1.5 text-muted hover:bg-line/60" onClick={() => setShareFile({ item: e.item, kind: 'file' })}><Link2 size={16} /></button>}
                      {e.kind === 'folder' && <button aria-label={`Share folder ${e.item.name}`} className="rounded p-1.5 text-muted hover:bg-line/60" onClick={() => setShareFile({ item: e.item, kind: 'folder' })}><Link2 size={16} /></button>}
                      {e.kind === 'file' && <button aria-label={`Send ${e.item.name} to Telegram`} className="rounded p-1.5 text-muted hover:bg-line/60" onClick={() => setTelegramFiles([e.item])}><Send size={16} /></button>}
                      <button aria-label={`Copy ${e.item.name}`} className="rounded p-1.5 text-muted hover:bg-line/60" onClick={() => { setFormError(''); setDest('root'); setDialog({ kind: 'copy', entries: [e] }); }}><Copy size={16} /></button>
                      <button aria-label={`Move ${e.item.name}`} className="rounded p-1.5 text-muted hover:bg-line/60" onClick={() => { setFormError(''); setDest('root'); setDialog({ kind: 'move', entries: [e] }); }}><FolderInput size={16} /></button>
                      <button aria-label={`Rename ${e.item.name}`} className="rounded p-1.5 text-muted hover:bg-line/60" onClick={() => { setName(e.item.name); setFormError(''); setDialog({ kind: 'rename', entry: e }); }}><Pencil size={16} /></button>
                      <button aria-label={`Move ${e.item.name} to trash`} className="rounded p-1.5 text-muted hover:bg-line/60" onClick={() => { setFormError(''); setDialog({ kind: 'delete', entries: [e] }); }}><Trash2 size={16} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {list.hasNextPage && (
          <div className="border-t border-line p-3 text-center">
            <button className={btnGhost} disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading…' : 'Load more'}</button>
          </div>
        )}
      </div>

      {jobs.length > 0 && (
        <section className="rounded-lg border border-line bg-surface p-3" aria-label="Uploads" aria-live="polite">
          <div className="mb-2 flex items-center justify-between text-sm font-medium">Uploads
            <button className="text-xs text-muted hover:underline" onClick={() => setJobs((js) => js.filter((j) => j.state === 'uploading'))}>Clear finished</button></div>
          <ul className="space-y-2 text-sm">
            {jobs.map((j) => (
              <li key={j.id}>
                <div className="flex items-center justify-between gap-2"><span className="truncate">{j.name}</span>
                  {j.state === 'uploading' ? <button aria-label={`Cancel upload of ${j.name}`} onClick={j.abort}><X size={14} /></button>
                    : <span className={j.state === 'error' ? 'text-danger' : 'text-muted'}>{j.state === 'done' ? 'Done' : j.error}</span>}</div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line"><div className={`h-full ${j.state === 'error' ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${j.total ? (j.loaded / j.total) * 100 : 0}%` }} /></div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Dialog open={dialog?.kind === 'mkdir' || dialog?.kind === 'rename'} title={dialog?.kind === 'rename' ? 'Rename' : 'New folder'} onClose={() => setDialog(null)}>
        <form onSubmit={(e) => { e.preventDefault(); submitName(); }}>
          <label className="mb-1 block text-sm" htmlFor="name-input">Name</label>
          <input id="name-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={255} className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm" />
          {formError && <p role="alert" className="mt-2 text-sm text-danger">{formError}</p>}
          <div className="mt-4 flex justify-end gap-2"><button type="button" className={btnGhost} onClick={() => setDialog(null)}>Cancel</button>
            <button type="submit" className={btnPrimary} disabled={mutate.isPending || !name.trim()}>Save</button></div>
        </form>
      </Dialog>

      <Dialog open={dialog?.kind === 'move' || dialog?.kind === 'copy'} title={dialog?.kind === 'copy' ? 'Copy to…' : 'Move to…'} onClose={() => setDialog(null)}>
        <label className="mb-1 block text-sm" htmlFor="dest-select">
          {dialog?.kind === 'move' || dialog?.kind === 'copy' ? (dialog.entries.length === 1 ? `“${dialog.entries[0]!.item.name}”` : `${dialog.entries.length} items`) : ''} → destination folder</label>
        <select id="dest-select" value={dest} onChange={(e) => setDest(e.target.value)} className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm">
          <option value="root">My Files (top level)</option>
          {destinations.map((d) => <option key={d.id} value={d.id}>{d.path}</option>)}
        </select>
        {dialog?.kind === 'copy' && <p className="mt-2 text-xs text-muted">Copies use extra storage. If a name is taken, the copy gets a number.</p>}
        {formError && <p role="alert" className="mt-2 text-sm text-danger">{formError}</p>}
        <div className="mt-4 flex justify-end gap-2"><button className={btnGhost} onClick={() => setDialog(null)}>Cancel</button>
          <button className={btnPrimary} disabled={mutate.isPending} onClick={confirmTransfer}>{dialog?.kind === 'copy' ? 'Copy here' : 'Move here'}</button></div>
      </Dialog>

      <Dialog open={dialog?.kind === 'delete'} title="Move to trash?" onClose={() => setDialog(null)}>
        <p className="text-sm text-muted">
          {dialog?.kind === 'delete' && (dialog.entries.length === 1 ? `“${dialog.entries[0]!.item.name}”` : `${dialog.entries.length} items`)} will be moved to
          the trash{dialog?.kind === 'delete' && dialog.entries.some((e) => e.kind === 'folder') ? ', including everything inside any folders' : ''}. You can restore {dialog?.kind === 'delete' && dialog.entries.length === 1 ? 'it' : 'them'} from the Trash page.
        </p>
        {formError && <p role="alert" className="mt-2 text-sm text-danger">{formError}</p>}
        <div className="mt-4 flex justify-end gap-2"><button className={btnGhost} onClick={() => setDialog(null)}>Cancel</button>
          <button className={btnDanger} disabled={mutate.isPending} onClick={confirmDelete}>Move to trash</button></div>
      </Dialog>

      {shareFile && <ShareDialog file={shareFile.item} kind={shareFile.kind} maxDays={365} onClose={() => setShareFile(null)} onChanged={refresh} />}
      {telegramFiles && <SendToTelegram files={telegramFiles} onClose={() => setTelegramFiles(null)} />}

      <Dialog open={conflict !== null} title="File already exists" onClose={() => setConflict(null)}>
        <p className="text-sm text-muted">A file named “{conflict?.file.name}” already exists in this folder.</p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button className={btnGhost} onClick={() => setConflict(null)}>Skip</button>
          <button className={btnGhost} onClick={() => { if (conflict) startUpload(conflict.file, conflict.folderId, 'rename'); setConflict(null); }}>Keep both</button>
          <button className={btnDanger} onClick={() => { if (conflict) startUpload(conflict.file, conflict.folderId, 'replace'); setConflict(null); }}>Replace</button>
        </div>
      </Dialog>
    </div>
  );
}
