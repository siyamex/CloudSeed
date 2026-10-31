import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Link2, Pause, Play, RotateCcw, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, api, formatBytes, formatDuration, type DownloadJob, type JobState, type Preview } from '../api';
import { btnGhost, btnPrimary } from '../components/Dialog';

interface JobList { jobs: DownloadJob[]; nextCursor: string | null }
const FILTERS = [['', 'All'], ['active', 'Active'], ['waiting', 'Waiting'], ['paused', 'Paused'], ['completed', 'Completed'], ['failed', 'Failed']] as const;
const TERMINAL: JobState[] = ['completed', 'failed', 'cancelled'];
const RUNNING: JobState[] = ['resolving', 'downloading', 'verifying'];

const STATE_LABEL: Record<JobState, string> = {
  pending: 'Waiting to retry', queued: 'Queued', resolving: 'Connecting', downloading: 'Downloading', paused: 'Paused',
  verifying: 'Verifying', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
};

/** Merges a live update into every cached list; refetches when a job changed state (it may belong to a different filter now). */
function applyLive(qc: QueryClient, job: DownloadJob) {
  let known = false, stateChanged = false;
  qc.setQueriesData<JobList>({ queryKey: ['downloads'] }, (old) => {
    if (!old) return old;
    return { ...old, jobs: old.jobs.map((j) => { if (j.id !== job.id) return j; known = true; stateChanged ||= j.state !== job.state; return job; }) };
  });
  if (!known || stateChanged) {
    void qc.invalidateQueries({ queryKey: ['downloads'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    if (job.state === 'completed') void qc.invalidateQueries({ queryKey: ['files'] });
  }
}

function useLiveDownloads() {
  const qc = useQueryClient();
  const [live, setLive] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  useEffect(() => {
    const es = new EventSource('/api/v1/downloads/events');
    es.addEventListener('ready', () => { setLive('live'); void qc.invalidateQueries({ queryKey: ['downloads'] }); }); // resync after (re)connect
    es.addEventListener('job', (e) => applyLive(qc, JSON.parse((e as MessageEvent).data) as DownloadJob));
    es.onerror = () => setLive('reconnecting');
    return () => es.close();
  }, [qc]);
  return live;
}

function useFolderOptions() {
  const q = useQuery({ queryKey: ['folder-list'], queryFn: () => api<{ folders: { id: string; parentId: string | null; name: string }[] }>('/folders') });
  return useMemo(() => {
    const byId = new Map((q.data?.folders ?? []).map((f) => [f.id, f]));
    const path = (id: string): string => { const f = byId.get(id); return f ? (f.parentId ? `${path(f.parentId)} / ${f.name}` : f.name) : ''; };
    return [...byId.keys()].map((id) => ({ id, label: path(id) })).sort((a, b) => a.label.localeCompare(b.label));
  }, [q.data]);
}

function AddForm() {
  const qc = useQueryClient();
  const folders = useFolderOptions();
  const [url, setUrl] = useState('');
  const [folderId, setFolderId] = useState('');
  const [priority, setPriority] = useState('normal');
  const [sha256, setSha256] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');

  const check = useMutation({
    mutationFn: () => api<Preview>('/downloads/preview', { method: 'POST', body: { url: url.trim() } }),
    onSuccess: (p) => { setPreview(p); setError(''); },
    onError: (e) => { setPreview(null); setError(e instanceof ApiError ? e.message : 'Could not check that link'); },
  });
  const start = useMutation({
    mutationFn: () => api<DownloadJob>('/downloads', { method: 'POST', body: { url: url.trim(), folderId: folderId || null, priority, ...(sha256.trim() ? { sha256: sha256.trim() } : {}) } }),
    onSuccess: () => { setUrl(''); setSha256(''); setPreview(null); setError(''); void qc.invalidateQueries({ queryKey: ['downloads'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] }); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not start the download'),
  });
  const blocked = preview?.warnings.some((w) => w.code === 'file_too_large' || w.code === 'quota_exceeded');

  return (
    <form className="space-y-3 rounded-lg border border-line bg-surface p-4" onSubmit={(e) => { e.preventDefault(); start.mutate(); }} aria-labelledby="add-h">
      <h2 id="add-h" className="flex items-center gap-2 text-sm font-medium"><Link2 size={16} aria-hidden /> Add a download</h2>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="flex-1"><span className="sr-only">File URL</span>
          <input type="url" required value={url} onChange={(e) => { setUrl(e.target.value); setPreview(null); }} placeholder="https://example.com/file.zip"
            className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm" autoComplete="off" /></label>
        <button type="button" className={btnGhost} disabled={!url.trim() || check.isPending} onClick={() => check.mutate()}>{check.isPending ? 'Checking…' : 'Check link'}</button>
      </div>

      {preview && (
        <div className="rounded-md border border-line bg-bg p-3 text-sm" role="status">
          <div className="font-medium">{preview.filename}</div>
          <div className="text-muted">
            {preview.size !== null ? formatBytes(preview.size) : 'Unknown size'}{preview.contentType ? ` · ${preview.contentType}` : ''}
            {' · '}{preview.resumable ? 'Can be paused and resumed' : 'Cannot resume if interrupted (restarts from the beginning)'}
          </div>
          {preview.warnings.map((w) => (
            <div key={w.code} className={`mt-1 flex items-start gap-1 ${w.code === 'unknown_size' ? 'text-muted' : 'text-danger'}`}><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />{w.message}</div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm"><span className="mb-1 block text-muted">Save to</span>
          <select value={folderId} onChange={(e) => setFolderId(e.target.value)} className="rounded-md border border-line bg-bg px-2 py-2 text-sm">
            <option value="">My Files (root)</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select></label>
        <label className="text-sm"><span className="mb-1 block text-muted">Priority</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className="rounded-md border border-line bg-bg px-2 py-2 text-sm">
            <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option>
          </select></label>
        <details className="text-sm"><summary className="cursor-pointer text-muted">Verify checksum</summary>
          <label className="mt-2 block"><span className="sr-only">Expected SHA-256</span>
            <input value={sha256} onChange={(e) => setSha256(e.target.value)} placeholder="Expected SHA-256 (64 hex characters)" pattern="[0-9a-fA-F]{64}"
              className="w-80 max-w-full rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs" /></label></details>
        <button type="submit" className={`${btnPrimary} ml-auto`} disabled={!url.trim() || start.isPending || !!blocked}>{start.isPending ? 'Starting…' : 'Start download'}</button>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </form>
  );
}

function JobRow({ job }: { job: DownloadJob }) {
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: (a: { path: string; method?: string; body?: unknown }) => api(`/downloads/${job.id}${a.path}`, { method: a.method ?? 'POST', body: a.body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['downloads'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] }); },
  });
  const terminal = TERMINAL.includes(job.state);
  const running = RUNNING.includes(job.state);
  const name = job.filename ?? (() => { try { const u = new URL(job.url); return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? u.host); } catch { return job.url; } })();
  const host = (() => { try { return new URL(job.url).host; } catch { return ''; } })();

  const details: string[] = [];
  if (job.state === 'downloading' || job.state === 'paused' || job.state === 'verifying') {
    details.push(job.totalBytes !== null ? `${formatBytes(job.bytesReceived)} of ${formatBytes(job.totalBytes)}` : formatBytes(job.bytesReceived));
  }
  if (job.state === 'downloading' && job.speedBps > 0) details.push(`${formatBytes(job.speedBps)}/s`);
  if (job.etaSeconds !== null) details.push(`${formatDuration(job.etaSeconds)} left`);
  if (job.elapsedSeconds !== null && !terminal) details.push(`${formatDuration(job.elapsedSeconds)} elapsed`);
  if (job.state === 'completed' && job.totalBytes !== null) details.push(formatBytes(job.totalBytes));
  if (job.state === 'pending' && job.nextAttemptAt) details.push(`retry ${job.attempt}/${job.maxAttempts - 1} at ${new Date(job.nextAttemptAt).toLocaleTimeString()}`);

  return (
    <li className="space-y-2 px-4 py-3 text-sm">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium" title={job.url}>{name}</div>
          <div className="truncate text-xs text-muted">{host}</div>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${job.state === 'failed' ? 'bg-danger/10 text-danger' : job.state === 'completed' ? 'bg-accent/10 text-accent' : 'bg-line/70 text-muted'}`}>
          {job.pendingControl ? (job.pendingControl === 'pause' ? 'Pausing…' : 'Cancelling…') : STATE_LABEL[job.state]}
        </span>
      </div>

      {(running || job.state === 'paused' || job.state === 'queued' || job.state === 'pending') && (
        <div className="h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-label={`Progress for ${name}`}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.percent ?? undefined} aria-valuetext={job.percent === null ? 'Size unknown' : `${job.percent}%`}>
          <div className={`h-full bg-accent ${job.percent === null && job.state === 'downloading' ? 'w-1/3 animate-pulse' : ''}`} style={job.percent === null ? undefined : { width: `${job.percent}%` }} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        {job.percent !== null && !terminal && <span>{job.percent}%</span>}
        {details.map((d) => <span key={d}>{d}</span>)}
        {job.resumable === false && !terminal && <span title="The server does not support resuming">not resumable</span>}
      </div>
      {job.error && <p className="flex items-start gap-1 text-xs text-danger"><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />{job.error.message ?? job.error.code}</p>}
      {act.error && <p role="alert" className="text-xs text-danger">{act.error instanceof ApiError ? act.error.message : 'Action failed'}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {(job.state === 'queued' || job.state === 'pending' || job.state === 'resolving' || job.state === 'downloading') && !job.pendingControl &&
          <button className={btnGhost} disabled={act.isPending} onClick={() => act.mutate({ path: '/pause' })}><Pause size={14} className="mr-1 inline" aria-hidden />Pause</button>}
        {job.state === 'paused' && <button className={btnGhost} disabled={act.isPending} onClick={() => act.mutate({ path: '/resume' })}><Play size={14} className="mr-1 inline" aria-hidden />Resume</button>}
        {!terminal && job.pendingControl !== 'cancel' && <button className={btnGhost} disabled={act.isPending} onClick={() => act.mutate({ path: '/cancel' })}><X size={14} className="mr-1 inline" aria-hidden />Cancel</button>}
        {(job.state === 'failed' || job.state === 'cancelled') && <button className={btnGhost} disabled={act.isPending} onClick={() => act.mutate({ path: '/retry' })}><RotateCcw size={14} className="mr-1 inline" aria-hidden />Retry</button>}
        {job.state === 'completed' && job.fileId && <a className={btnGhost} href={`/api/v1/files/${job.fileId}/content`} download><Check size={14} className="mr-1 inline" aria-hidden />Download file</a>}
        {terminal && <button className={btnGhost} disabled={act.isPending} onClick={() => act.mutate({ path: '', method: 'DELETE' })}><Trash2 size={14} className="mr-1 inline" aria-hidden />Remove from list</button>}
        {!terminal && (
          <label className="ml-auto flex items-center gap-1 text-xs text-muted">Priority
            <select value={job.priority} onChange={(e) => act.mutate({ path: '', method: 'PATCH', body: { priority: e.target.value } })} className="rounded border border-line bg-bg px-1 py-1 text-xs">
              <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option>
            </select></label>
        )}
      </div>
    </li>
  );
}

export function Downloads() {
  const [params, setParams] = useSearchParams();
  const filter = params.get('state') ?? '';
  const live = useLiveDownloads();
  const list = useQuery({ queryKey: ['downloads', filter], queryFn: () => api<JobList>(`/downloads?limit=100${filter ? `&state=${filter}` : ''}`) });

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Downloads</h1>
        <span className="text-xs text-muted" role="status">{live === 'live' ? '● Live' : live === 'connecting' ? 'Connecting…' : 'Reconnecting…'}</span>
      </div>
      <AddForm />
      <div role="tablist" aria-label="Filter downloads" className="flex flex-wrap gap-1">
        {FILTERS.map(([v, label]) => (
          <button key={v} role="tab" aria-selected={filter === v} onClick={() => { const n = new URLSearchParams(params); v ? n.set('state', v) : n.delete('state'); setParams(n, { replace: true }); }}
            className={`rounded-md px-3 py-1.5 text-sm ${filter === v ? 'bg-accent/10 font-medium text-accent' : 'text-muted hover:bg-line/50'}`}>{label}</button>
        ))}
      </div>
      <div className="rounded-lg border border-line bg-surface">
        {list.isPending ? <div className="animate-pulse space-y-2 p-4" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-12 rounded bg-line/60" />)}</div>
          : list.error ? <p role="alert" className="p-6 text-danger">Failed to load downloads: {list.error.message}</p>
          : list.data.jobs.length === 0 ? <p className="p-12 text-center text-sm text-muted">{filter ? 'No downloads in this view.' : 'No downloads yet. Paste a link above to fetch a file straight into your storage.'}</p>
          : <ul className="divide-y divide-line">{list.data.jobs.map((j) => <JobRow key={j.id} job={j} />)}</ul>}
      </div>
    </div>
  );
}
