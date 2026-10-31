import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { File as FileIcon, Folder, RotateCcw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, formatBytes } from '../api';
import { Dialog, btnDanger, btnGhost } from '../components/Dialog';

interface TrashData {
  retentionDays: number;
  folders: { id: string; name: string; deletedAt: string; expiresAt: string | null }[];
  files: { id: string; name: string; size: number; deletedAt: string; expiresAt: string | null }[];
}
type Target = { kind: 'purge'; fileIds: string[]; folderIds: string[]; label: string } | { kind: 'empty' };

export function Trash() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['trash'], queryFn: () => api<TrashData>('/trash') });
  const [confirm, setConfirm] = useState<Target | null>(null);
  const [error, setError] = useState('');

  const done = () => {
    setConfirm(null); setError('');
    for (const k of ['trash', 'files', 'dashboard']) void qc.invalidateQueries({ queryKey: [k] });
  };
  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : 'Something went wrong');
  const restore = useMutation({
    mutationFn: (b: { fileIds?: string[]; folderIds?: string[] }) => api('/trash/restore', { method: 'POST', body: b }),
    onSuccess: done, onError: fail,
  });
  const purge = useMutation({
    mutationFn: (t: Target) => t.kind === 'empty' ? api('/trash/empty', { method: 'POST', body: {} })
      : api('/trash/purge', { method: 'POST', body: { fileIds: t.fileIds, folderIds: t.folderIds } }),
    onSuccess: done, onError: fail,
  });

  if (q.isPending) return <div className="animate-pulse space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-10 rounded bg-line/60" />)}</div>;
  if (q.error) return <p role="alert" className="text-danger">Failed to load trash: {q.error.message}</p>;

  const d = q.data;
  const empty = d.files.length === 0 && d.folders.length === 0;
  const when = (e: string | null, at: string) =>
    e ? `Deleted ${new Date(at).toLocaleDateString()} · removed permanently ${new Date(e).toLocaleDateString()}` : `Deleted ${new Date(at).toLocaleDateString()}`;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Trash</h1>
          <p className="text-sm text-muted">
            {d.retentionDays > 0 ? `Items are deleted permanently after ${d.retentionDays} days.` : 'Items stay here until you delete them permanently.'} Trashed items still count toward your storage.
          </p>
        </div>
        <button className={btnDanger} disabled={empty} onClick={() => { setError(''); setConfirm({ kind: 'empty' }); }}>Empty trash</button>
      </div>

      <div className="rounded-lg border border-line bg-surface">
        {empty ? <p className="p-12 text-center text-sm text-muted">Trash is empty.</p> : (
          <ul className="divide-y divide-line">
            {[...d.folders.map((f) => ({ ...f, kind: 'folder' as const, size: 0 })), ...d.files.map((f) => ({ ...f, kind: 'file' as const }))].map((i) => (
              <li key={`${i.kind}${i.id}`} className="flex items-center gap-3 px-4 py-3 text-sm">
                {i.kind === 'folder' ? <Folder size={16} className="shrink-0 text-accent" aria-hidden /> : <FileIcon size={16} className="shrink-0 text-muted" aria-hidden />}
                <div className="min-w-0 flex-1">
                  <div className="truncate">{i.name}</div>
                  <div className="text-xs text-muted">{when(i.expiresAt, i.deletedAt)}</div>
                </div>
                {i.kind === 'file' && <span className="hidden text-muted sm:block">{formatBytes(i.size)}</span>}
                <button className={btnGhost} disabled={restore.isPending} aria-label={`Restore ${i.name}`}
                  onClick={() => restore.mutate(i.kind === 'file' ? { fileIds: [i.id] } : { folderIds: [i.id] })}><RotateCcw size={14} className="mr-1 inline" aria-hidden />Restore</button>
                <button className="rounded p-1.5 text-muted hover:bg-line/60" aria-label={`Delete ${i.name} permanently`}
                  onClick={() => { setError(''); setConfirm({ kind: 'purge', label: i.name, fileIds: i.kind === 'file' ? [i.id] : [], folderIds: i.kind === 'folder' ? [i.id] : [] }); }}><Trash2 size={16} /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {restore.isError && <p role="alert" className="text-sm text-danger">{error}</p>}

      <Dialog open={confirm !== null} title="Delete permanently?" onClose={() => setConfirm(null)}>
        <p className="text-sm text-muted">
          {confirm?.kind === 'empty' ? 'Everything in the trash' : `“${confirm?.kind === 'purge' ? confirm.label : ''}”`} will be deleted permanently and the space freed. This cannot be undone.
        </p>
        {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button className={btnGhost} onClick={() => setConfirm(null)}>Cancel</button>
          <button className={btnDanger} disabled={purge.isPending} onClick={() => confirm && purge.mutate(confirm)}>Delete permanently</button>
        </div>
      </Dialog>
    </div>
  );
}
