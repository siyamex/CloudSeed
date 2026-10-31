import { useQuery } from '@tanstack/react-query';
import { Download, File as FileIcon, FolderOpen, HardDrive, Send } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, formatBytes, type Dashboard as DashboardData } from '../api';

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Dashboard() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api<DashboardData>('/dashboard') });

  if (q.isPending) return <div className="grid animate-pulse gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="h-24 rounded-lg bg-line/60" />)}</div>;
  if (q.error) return <p role="alert" className="text-danger">Failed to load dashboard: {q.error.message}</p>;

  const d = q.data;
  const pct = d.storage.quotaBytes ? Math.min(100, (d.storage.usedBytes / d.storage.quotaBytes) * 100) : 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Quota" value={formatBytes(d.storage.quotaBytes)} sub={`${d.storage.backend} storage`} />
        <Stat label="Used" value={formatBytes(d.storage.usedBytes)} sub={`${pct.toFixed(1)}% of quota`} />
        <Stat label="Available" value={formatBytes(d.storage.availableBytes)} />
        <Stat label="Files / folders" value={`${d.counts.files} / ${d.counts.folders}`} />
      </div>

      <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="dl-h">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="dl-h" className="flex items-center gap-2 text-sm font-medium"><Download size={16} aria-hidden /> Downloads</h2>
          <Link to="/downloads" className="text-sm text-accent hover:underline">Add a download</Link>
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
          {([['Active', d.downloads.active], ['Waiting', d.downloads.waiting], ['Paused', d.downloads.paused], ['Completed', d.downloads.completed], ['Failed', d.downloads.failed]] as const).map(([k, v]) => (
            <div key={k}><dt className="text-muted">{k}</dt><dd className={`text-lg font-semibold ${k === 'Failed' && v > 0 ? 'text-danger' : ''}`}>{v}</dd></div>
          ))}
        </dl>
      </section>

      <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="tg-h">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="tg-h" className="flex items-center gap-2 text-sm font-medium"><Send size={16} aria-hidden /> Telegram</h2>
          <Link to="/telegram" className="text-sm text-accent hover:underline">{d.telegram.bots > 0 ? 'Open Telegram' : 'Connect a bot'}</Link>
        </div>
        {d.telegram.bots === 0 ? <p className="text-sm text-muted">Not connected. Add a bot to send files to your groups and channels.</p> : (
          <>
            <p className="mb-2 text-sm text-muted">{d.telegram.active} in progress{d.telegram.failed > 0 ? <>, <span className="text-danger">{d.telegram.failed} need attention</span></> : ''}</p>
            {d.telegram.recent.length === 0 ? <p className="text-sm text-muted">No transfers yet.</p> : (
              <ul className="divide-y divide-line text-sm">
                {d.telegram.recent.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 py-2">
                    <span className="min-w-0 flex-1 truncate">{t.firstFileName}{t.files > 1 ? ` + ${t.files - 1} more` : ''} <span className="text-muted">to {t.destination}</span></span>
                    <span className="text-xs capitalize text-muted">{t.state}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="rounded-lg border border-line bg-surface p-4" aria-labelledby="usage-h">
        <h2 id="usage-h" className="mb-3 flex items-center gap-2 text-sm font-medium"><HardDrive size={16} aria-hidden /> Storage usage</h2>
        <div className="h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Storage used">
          <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
        {d.storage.trashFiles > 0 && (
          <p className="mt-2 text-sm text-muted">Includes {formatBytes(d.storage.trashBytes)} in the <Link to="/trash" className="text-accent hover:underline">trash</Link> ({d.storage.trashFiles} files). Empty it to free the space.</p>
        )}
        {!d.storage.healthy && <p role="alert" className="mt-2 text-sm text-danger">Storage backend health check is failing.</p>}
        {d.usageByType.length > 0 ? (
          <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            {d.usageByType.map((u) => (
              <li key={u.category} className="flex justify-between"><span className="capitalize text-muted">{u.category}</span><span>{formatBytes(u.bytes)} · {u.files} files</span></li>
            ))}
          </ul>
        ) : <p className="mt-3 text-sm text-muted">No files yet.</p>}
      </section>

      <section className="rounded-lg border border-line bg-surface" aria-labelledby="recent-h">
        <div className="flex items-center justify-between border-b border-line p-4">
          <h2 id="recent-h" className="flex items-center gap-2 text-sm font-medium"><FolderOpen size={16} aria-hidden /> Recent files</h2>
          <Link to="/files" className="text-sm text-accent hover:underline">Open My Files</Link>
        </div>
        {d.recentFiles.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted">Nothing here yet. <Link to="/files" className="text-accent hover:underline">Upload your first file</Link>.</p>
        ) : (
          <ul className="divide-y divide-line">
            {d.recentFiles.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <FileIcon size={16} className="shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="text-muted">{formatBytes(f.size)}</span>
                <time className="hidden text-muted sm:block" dateTime={f.createdAt}>{new Date(f.createdAt).toLocaleDateString()}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
