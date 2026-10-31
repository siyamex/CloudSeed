import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Link2, Lock, Trash2, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ApiError, api, formatBytes, type ShareItem } from '../api';
import { btnGhost } from '../components/Dialog';

const STATUS: Record<ShareItem['status'], [string, string]> = {
  active: ['Active', 'bg-accent/10 text-accent'], expired: ['Expired', 'bg-line/70 text-muted'], revoked: ['Revoked', 'bg-line/70 text-muted'],
  exhausted: ['Limit reached', 'bg-line/70 text-muted'], disabled: ['Disabled by an administrator', 'bg-danger/10 text-danger'],
};

export function Shares() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['shares'], queryFn: () => api<{ enabled: boolean; maxDays: number; shares: ShareItem[] }>('/shares') });
  const act = useMutation({
    mutationFn: (a: { id: string; path: string; method?: string; body?: unknown }) => api(`/shares/${a.id}${a.path}`, { method: a.method ?? 'POST', body: a.body ?? {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['shares'] }),
  });

  if (q.isPending) return <div className="animate-pulse space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-16 rounded bg-line/60" />)}</div>;
  if (q.error) return <p role="alert" className="text-danger">Failed to load share links: {q.error.message}</p>;
  const { shares, enabled } = q.data;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Shared Links</h1>
        <p className="text-sm text-muted">Create links from <Link to="/files" className="text-accent hover:underline">My Files</Link> (the share icon on a file). For security a link is shown only once, when it is created.</p>
      </div>
      {!enabled && <p role="alert" className="rounded-md border border-danger/40 bg-danger/5 p-3 text-sm text-danger">Sharing is turned off on this server. Existing links do not work.</p>}
      {act.error && <p role="alert" className="text-sm text-danger">{act.error instanceof ApiError ? act.error.message : 'Action failed'}</p>}

      <div className="rounded-lg border border-line bg-surface">
        {shares.length === 0 ? <p className="p-12 text-center text-sm text-muted">No links yet.</p> : (
          <ul className="divide-y divide-line">
            {shares.map((s) => (
              <li key={s.id} className="space-y-1 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{s.fileName}{s.label ? <span className="font-normal text-muted"> · {s.label}</span> : null}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS[s.status][1]}`}>{STATUS[s.status][0]}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  <span className="flex items-center gap-1">{s.mode === 'public' ? <><Link2 size={12} aria-hidden />Anyone with the link</> : <><Users size={12} aria-hidden />Signed-in users</>}</span>
                  {s.passwordProtected && <span className="flex items-center gap-1"><Lock size={12} aria-hidden />Password</span>}
                  <span>{formatBytes(s.fileSize)}</span>
                  <span>{s.status === 'active' ? 'Expires' : 'Expired/ended'} {new Date(s.expiresAt).toLocaleString()}</span>
                  <span>{s.downloadCount}{s.maxDownloads ? ` of ${s.maxDownloads}` : ''} downloads</span>
                  <span>{s.accessCount} views</span>
                  {s.lastAccessedAt && <span>last {new Date(s.lastAccessedAt).toLocaleString()}</span>}
                </div>
                {s.fileInTrash && <p className="flex items-center gap-1 text-xs text-danger"><AlertTriangle size={12} aria-hidden />The file is in the trash, so this link does not work until it is restored.</p>}
                <div className="flex flex-wrap gap-2 pt-1">
                  {s.status === 'active' && <button className={btnGhost} disabled={act.isPending} onClick={() => act.mutate({ id: s.id, path: '/revoke' })}>Revoke</button>}
                  {(s.status === 'expired' || s.status === 'exhausted') && (
                    <button className={btnGhost} disabled={act.isPending} onClick={() => act.mutate({ id: s.id, path: '', method: 'PATCH', body: { expiresInHours: 168, maxDownloads: null } })}>Extend 7 days</button>
                  )}
                  <button className={btnGhost} disabled={act.isPending} aria-label={`Delete the link record for ${s.fileName}`} onClick={() => act.mutate({ id: s.id, path: '', method: 'DELETE' })}><Trash2 size={14} aria-hidden /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
