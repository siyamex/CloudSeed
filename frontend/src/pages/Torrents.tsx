import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Folder, Magnet, Pause, Play, RotateCcw, Trash2, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, formatBytes, type TorrentItem, type TorrentStatus } from '../api';
import { Dialog, btnGhost, btnPrimary } from '../components/Dialog';

const input = 'w-full rounded-md border border-line bg-bg px-3 py-2 text-sm';
const LIVE = ['pending', 'metadata', 'queued', 'downloading', 'importing'];

const STATE: Record<string, [string, string]> = {
  pending: ['Looking for the file list…', 'bg-line/70 text-muted'], metadata: ['Looking for the file list…', 'bg-line/70 text-muted'],
  awaiting_selection: ['Choose files', 'bg-accent/10 text-accent'], queued: ['Waiting to start', 'bg-line/70 text-muted'],
  downloading: ['Downloading', 'bg-accent/10 text-accent'], paused: ['Paused', 'bg-line/70 text-muted'], importing: ['Moving into your files…', 'bg-accent/10 text-accent'],
  completed: ['Done', 'bg-accent/10 text-accent'], failed: ['Failed', 'bg-danger/10 text-danger'], cancelled: ['Cancelled', 'bg-line/70 text-muted'],
};
const err = (e: unknown) => (e instanceof ApiError ? e.message : e ? 'Something went wrong' : null);

function FolderSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const q = useQuery({ queryKey: ['folders-all'], queryFn: () => api<{ folders: { id: string; parentId: string | null; name: string }[] }>('/folders') });
  const all = q.data?.folders ?? [];
  const pathOf = (id: string) => { const out: string[] = []; let cur = all.find((f) => f.id === id); while (cur) { out.unshift(cur.name); cur = all.find((f) => f.id === cur!.parentId); } return '/' + out.join('/'); };
  return (
    <select className={input} value={value} onChange={(e) => onChange(e.target.value)} aria-label="Save into">
      <option value="">My Files (top level)</option>
      {all.map((f) => <option key={f.id} value={f.id}>{pathOf(f.id)}</option>)}
    </select>
  );
}

function ChooseFiles({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ['torrent', id], queryFn: () => api<TorrentItem>(`/torrents/${id}`) });
  const [picked, setPicked] = useState<Set<number> | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => api(`/torrents/${id}/start`, { method: 'POST', body: { files: [...(picked ?? new Set(d.data!.files!.map((f) => f.i)))], ...(folder !== null ? { folderId: folder || null } : {}) } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['torrents'] }); onClose(); },
  });
  if (d.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (d.error) return <p role="alert" className="text-sm text-danger">{err(d.error)}</p>;
  const files = d.data.files ?? [];
  const sel = picked ?? new Set(files.map((f) => f.i));
  const bytes = files.filter((f) => sel.has(f.i)).reduce((n, f) => n + f.size, 0);
  const toggle = (i: number) => { const n = new Set(sel); if (n.has(i)) n.delete(i); else n.add(i); setPicked(n); };
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted"><strong className="text-fg">{d.data.name}</strong> · {files.length} file{files.length === 1 ? '' : 's'} · {formatBytes(d.data.totalBytes ?? 0)}</p>
      <div className="flex gap-3 text-xs"><button className="text-accent hover:underline" onClick={() => setPicked(new Set(files.map((f) => f.i)))}>Select all</button><button className="text-accent hover:underline" onClick={() => setPicked(new Set())}>Select none</button></div>
      <ul className="max-h-72 divide-y divide-line overflow-auto rounded-md border border-line" aria-label="Files in this torrent">
        {files.map((f) => (
          <li key={f.i}><label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-line/40">
            <input type="checkbox" checked={sel.has(f.i)} onChange={() => toggle(f.i)} />
            <span className="min-w-0 flex-1 break-all">{f.path}</span><span className="shrink-0 text-xs text-muted">{formatBytes(f.size)}</span>
          </label></li>
        ))}
      </ul>
      <label className="block">Save into<FolderSelect value={folder ?? d.data.folderId ?? ''} onChange={setFolder} /></label>
      <p className={bytes === 0 ? 'text-danger' : 'text-muted'}>{sel.size} selected · {formatBytes(bytes)}</p>
      {start.error && <p role="alert" className="text-danger">{err(start.error)}</p>}
      {d.data.error && <p role="alert" className="text-xs text-danger">{d.data.error.message}</p>}
      <div className="flex justify-end gap-2"><button className={btnGhost} onClick={onClose}>Not now</button><button className={btnPrimary} disabled={start.isPending || sel.size === 0} onClick={() => start.mutate()}>Download {sel.size} file{sel.size === 1 ? '' : 's'}</button></div>
    </div>
  );
}

export function Torrents() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['torrent-status'], queryFn: () => api<TorrentStatus>('/torrents/status') });
  const list = useQuery({
    queryKey: ['torrents'], queryFn: () => api<{ torrents: TorrentItem[] }>('/torrents'), enabled: status.data !== undefined,
    refetchInterval: (q) => (q.state.data?.torrents.some((t) => LIVE.includes(t.state)) ? 2000 : 10_000),
  });
  const [magnet, setMagnet] = useState('');
  const [folder, setFolder] = useState('');
  const [auto, setAuto] = useState(false);
  const [mode, setMode] = useState<'magnet' | 'file'>('magnet');
  const [choose, setChoose] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['torrents'] });

  const addMagnet = useMutation({
    mutationFn: () => api<TorrentItem>('/torrents/magnet', { method: 'POST', body: { magnet: magnet.trim(), folderId: folder || null, autoStart: auto } }),
    onSuccess: () => { setMagnet(''); refresh(); },
  });
  const addFile = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData(); fd.append('file', file);
      const csrf = (await api<{ csrfToken: string }>('/auth/me')).csrfToken;
      const res = await fetch(`/api/v1/torrents/file?folder=${folder || 'root'}&autoStart=${auto}`, { method: 'POST', headers: { 'x-csrf-token': csrf }, credentials: 'same-origin', body: fd });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? 'error', body?.error?.message ?? 'Upload failed');
      return body as TorrentItem;
    },
    onSuccess: (t) => { refresh(); if (t.state === 'awaiting_selection') setChoose(t.id); if (fileInput.current) fileInput.current.value = ''; },
  });
  const act = useMutation({
    mutationFn: (a: { id: string; what: 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' }) =>
      a.what === 'remove' ? api(`/torrents/${a.id}`, { method: 'DELETE' }) : api(`/torrents/${a.id}/${a.what}`, { method: 'POST', body: {} }),
    onSuccess: refresh,
  });

  if (status.isPending) return <div className="animate-pulse space-y-2" aria-busy="true">{[0, 1].map((i) => <div key={i} className="h-24 rounded bg-line/60" />)}</div>;
  if (status.error) return <p role="alert" className="text-danger">{err(status.error)}</p>;
  const s = status.data;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div><h1 className="text-xl font-semibold">Torrents</h1><p className="text-sm text-muted">Download from a magnet link or a .torrent file straight into your files.</p></div>

      {!s.enabled ? (
        <p role="status" className="rounded-lg border border-line bg-surface p-4 text-sm text-muted">Torrent downloads are turned off on this server. An administrator can turn them on under <strong>Administration → Settings</strong>.</p>
      ) : (
        <>
          <p className="flex gap-2 rounded-lg border border-line bg-surface p-3 text-xs text-muted"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden /><span>{s.notice}</span></p>
          <section className="space-y-3 rounded-lg border border-line bg-surface p-4" aria-label="Add a torrent">
            <div className="flex gap-1" role="tablist">
              {([['magnet', 'Magnet link', Magnet], ['file', '.torrent file', Upload]] as const).map(([k, label, Icon]) => (
                <button key={k} role="tab" aria-selected={mode === k} onClick={() => setMode(k)} className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm ${mode === k ? 'bg-accent/10 font-medium text-accent' : 'text-muted hover:bg-line/50'}`}><Icon size={14} aria-hidden />{label}</button>
              ))}
            </div>
            {mode === 'magnet' ? (
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); addMagnet.mutate(); }}>
                <textarea className={input} rows={2} placeholder="magnet:?xt=urn:btih:…" value={magnet} onChange={(e) => setMagnet(e.target.value)} aria-label="Magnet link" spellCheck={false} />
                <Options folder={folder} setFolder={setFolder} auto={auto} setAuto={setAuto} />
                <button className={btnPrimary} disabled={addMagnet.isPending || !magnet.trim().startsWith('magnet:')}>{addMagnet.isPending ? 'Adding…' : 'Add magnet link'}</button>
                {addMagnet.error && <p role="alert" className="text-sm text-danger">{err(addMagnet.error)}</p>}
              </form>
            ) : (
              <div className="space-y-3">
                <input ref={fileInput} type="file" accept=".torrent,application/x-bittorrent" aria-label="Torrent file" className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-bg file:px-3 file:py-1.5" />
                <Options folder={folder} setFolder={setFolder} auto={auto} setAuto={setAuto} />
                <button className={btnPrimary} disabled={addFile.isPending} onClick={() => { const f = fileInput.current?.files?.[0]; if (f) addFile.mutate(f); }}>{addFile.isPending ? 'Reading…' : 'Add torrent file'}</button>
                {addFile.error && <p role="alert" className="text-sm text-danger">{err(addFile.error)}</p>}
              </div>
            )}
          </section>
        </>
      )}

      {act.error && <p role="alert" className="text-sm text-danger">{err(act.error)}</p>}
      <div className="rounded-lg border border-line bg-surface">
        {list.isPending ? <p className="p-6 text-sm text-muted">Loading…</p> : list.data && list.data.torrents.length === 0 ? <p className="p-10 text-center text-sm text-muted">No torrents yet.</p> : (
          <ul className="divide-y divide-line">
            {(list.data?.torrents ?? []).map((t) => {
              const [label, cls] = STATE[t.state] ?? [t.state, 'bg-line/70 text-muted'];
              const running = t.state === 'downloading';
              return (
                <li key={t.id} className="space-y-2 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 break-all font-medium">{t.name ?? 'Magnet link'}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{label}</span>
                  </div>
                  {(running || t.state === 'paused' || t.state === 'importing') && t.percent !== null && (
                    <div><div className="h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={t.percent} aria-valuemin={0} aria-valuemax={100} aria-label={`Progress of ${t.name ?? 'torrent'}`}><div className="h-full rounded-full bg-accent" style={{ width: `${t.percent}%` }} /></div>
                      <p className="mt-1 text-xs text-muted">{t.percent}% · {formatBytes(t.bytesDone)} of {formatBytes(t.selectedBytes ?? 0)}{running ? ` · ${t.peers} peer${t.peers === 1 ? '' : 's'} · ↓ ${formatBytes(t.downBps)}/s ↑ ${formatBytes(t.upBps)}/s` : ''}</p></div>
                  )}
                  {t.state === 'completed' && <p className="flex items-center gap-1.5 text-xs text-muted"><Folder size={12} aria-hidden />{t.importedFiles} file{t.importedFiles === 1 ? '' : 's'} saved · <Link className="text-accent hover:underline" to={`/files${t.resultFolderId ?? t.folderId ? `?folder=${t.resultFolderId ?? t.folderId}` : ''}`}>Open in My Files</Link></p>}
                  {t.error && <p role="alert" className="text-xs text-danger">{t.error.message}</p>}
                  <div className="flex flex-wrap gap-2">
                    {t.state === 'awaiting_selection' && <button className={btnPrimary} onClick={() => setChoose(t.id)}>Choose files</button>}
                    {['pending', 'metadata', 'queued', 'downloading'].includes(t.state) && <button className={btnGhost} onClick={() => act.mutate({ id: t.id, what: 'pause' })}><Pause size={14} className="mr-1 inline" aria-hidden />Pause</button>}
                    {t.state === 'paused' && <button className={btnGhost} onClick={() => act.mutate({ id: t.id, what: 'resume' })}><Play size={14} className="mr-1 inline" aria-hidden />Resume</button>}
                    {['pending', 'metadata', 'queued', 'downloading', 'paused', 'awaiting_selection'].includes(t.state) && <button className={btnGhost} onClick={() => act.mutate({ id: t.id, what: 'cancel' })}><X size={14} className="mr-1 inline" aria-hidden />Cancel</button>}
                    {(t.state === 'failed' || t.state === 'cancelled') && <button className={btnGhost} onClick={() => act.mutate({ id: t.id, what: 'retry' })}><RotateCcw size={14} className="mr-1 inline" aria-hidden />Try again</button>}
                    {['completed', 'failed', 'cancelled'].includes(t.state) && <button className={btnGhost} aria-label={`Remove ${t.name ?? 'torrent'} from the list`} onClick={() => act.mutate({ id: t.id, what: 'remove' })}><Trash2 size={14} aria-hidden /></button>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="text-xs text-muted">Torrents are not kept seeding: once a download finishes it stops sharing. Files are copied into your storage and count toward your quota.</p>

      <Dialog open={choose !== null} title="Choose what to download" onClose={() => setChoose(null)}>{choose && <ChooseFiles id={choose} onClose={() => setChoose(null)} />}</Dialog>
    </div>
  );
}

function Options({ folder, setFolder, auto, setAuto }: { folder: string; setFolder: (v: string) => void; auto: boolean; setAuto: (v: boolean) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block text-sm">Save into<FolderSelect value={folder} onChange={setFolder} /></label>
      <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />Download everything as soon as the file list is known</label>
    </div>
  );
}
