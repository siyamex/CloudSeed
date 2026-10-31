import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import {
  ApiError, api, formatBytes, formatDuration,
  type AdminOverview, type AdminQueues, type BackupConfig, type BackupRun, type AdminReport, type AdminUser, type AdminWorker, type AuditEntry,
} from '../api';
import { btnDanger, btnGhost, btnPrimary } from '../components/Dialog';

const TABS = ['Overview', 'Users', 'Reports', 'Backups', 'Operations', 'Audit log', 'Settings'] as const;
type Tab = (typeof TABS)[number];
const input = 'rounded-md border border-line bg-bg px-3 py-1.5 text-sm';
const errText = (e: unknown) => (e instanceof ApiError ? e.message : e ? 'Request failed' : null);

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-lg border border-line bg-surface p-4"><h2 className="mb-2 text-sm font-semibold text-muted">{title}</h2>{children}</section>;
}
const Loading = () => <div className="animate-pulse space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-12 rounded bg-line/60" />)}</div>;

function Overview() {
  const q = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => api<AdminOverview>('/admin/overview'), refetchInterval: 15_000 });
  if (q.isPending) return <Loading />;
  if (q.error) return <p role="alert" className="text-danger">{q.error.message}</p>;
  const o = q.data;
  const pct = o.storage.quotaBytes ? Math.round((100 * o.storage.usedBytes) / o.storage.quotaBytes) : 0;
  const feat = (on: boolean) => <span className={on ? 'text-accent' : 'text-muted'}>{on ? 'On' : 'Off'}</span>;
  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      <Card title="Users"><p className="text-2xl font-semibold">{o.users.active}</p><p className="text-sm text-muted">active · {o.users.disabled} disabled</p></Card>
      <Card title="Storage"><p className="text-2xl font-semibold">{formatBytes(o.storage.usedBytes)}</p>
        <p className="text-sm text-muted">{o.storage.files} files · {pct}% of {formatBytes(o.storage.quotaBytes)} allocated in quotas</p></Card>
      <Card title="Workers"><p className={`text-2xl font-semibold ${o.workersAlive ? '' : 'text-danger'}`}>{o.workersAlive}</p>
        <p className="text-sm text-muted">{o.workersAlive ? 'running (heard from in the last minute)' : 'none running: downloads, Telegram and media processing are stalled'}</p></Card>
      <Card title="Backups"><BackupSummary b={o.backup} /></Card>
      <Card title="Share links"><p className="text-2xl font-semibold">{o.activeShareLinks}</p><p className="text-sm text-muted">active</p></Card>
      <Card title="Abuse reports"><p className={`text-2xl font-semibold ${o.openAbuseReports ? 'text-danger' : ''}`}>{o.openAbuseReports}</p><p className="text-sm text-muted">waiting for review</p></Card>
      <Card title="Features">
        <ul className="grid grid-cols-2 gap-x-4 text-sm">
          <li>Email {feat(o.features.email)}</li><li>Sharing {feat(o.features.sharing)}</li><li>Telegram {feat(o.features.telegram)}</li>
          <li>Torrents {feat(o.features.torrents)}</li><li>Media {feat(o.features.media)}</li><li>Metrics {feat(o.features.metrics)}</li>
        </ul>
        <p className="mt-2 text-xs text-muted">These are set with environment variables on the server.</p>
      </Card>
    </div>
  );
}

const ago = (iso: string) => {
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
};

function BackupSummary({ b }: { b: AdminOverview['backup'] }) {
  const stale = b.lastSuccessAt === null || (b.enabled && Date.now() - new Date(b.lastSuccessAt).getTime() > b.intervalHours * 2 * 3_600_000);
  return (
    <>
      <p className={`text-2xl font-semibold ${stale ? 'text-danger' : ''}`}>{b.lastSuccessAt ? ago(b.lastSuccessAt) : 'Never'}</p>
      <p className="text-sm text-muted">
        {b.lastSuccessAt ? `last verified backup${b.lastVerified ? '' : ' (not verified)'}` : 'no backup has been made yet'}
        {b.enabled ? ` · every ${b.intervalHours} h` : ' · no schedule'}
      </p>
      {b.lastFailureAt && <p role="alert" className="mt-1 text-xs text-danger">The latest attempt failed ({ago(b.lastFailureAt)}). See the Backups tab.</p>}
      {!b.enabled && !b.lastSuccessAt && <p className="mt-1 text-xs text-muted">Set BACKUP_INTERVAL_HOURS to make backups automatically.</p>}
    </>
  );
}

function Backups() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['admin', 'backups'], queryFn: () => api<{ config: BackupConfig; runs: BackupRun[] }>('/admin/backups'),
    refetchInterval: (query) => (query.state.data?.runs.some((r) => r.status === 'requested' || r.status === 'running') ? 3_000 : 20_000),
  });
  const run = useMutation({
    mutationFn: () => api('/admin/backups/run', { method: 'POST', body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin'] }),
  });
  if (q.isPending) return <Loading />;
  if (q.error) return <p role="alert" className="text-danger">{q.error.message}</p>;
  const { config: c, runs } = q.data;
  const busy = runs.some((r) => r.status === 'requested' || r.status === 'running');
  const state = (r: BackupRun) => r.status === 'succeeded' ? (r.missing || r.corrupt ? ['Done with warnings', 'bg-danger/10 text-danger'] : ['Verified', 'bg-accent/10 text-accent'])
    : r.status === 'failed' ? ['Failed', 'bg-danger/10 text-danger'] : [r.status === 'running' ? 'Running…' : 'Waiting for a worker…', 'bg-line/70 text-muted'];
  return (
    <div className="space-y-3">
      <Card title="Settings">
        <ul className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <li>Schedule: <strong>{c.enabled ? `every ${c.intervalHours} h` : 'off'}</strong></li>
          <li>Keeps the last <strong>{c.keep}</strong> backups</li>
          <li>Stored files included: <strong>{c.includeObjects ? 'yes' : 'no (database only)'}</strong></li>
          <li>Encryption passphrase: <strong className={c.passphraseConfigured ? '' : 'text-danger'}>{c.passphraseConfigured ? 'set' : 'not set'}</strong></li>
          <li className="sm:col-span-2">Folder on the worker: <code className="text-xs">{c.directory}</code></li>
        </ul>
        <p className="mt-2 text-xs text-muted">Backups are encrypted files. <strong>Copy them off this machine</strong> (another disk, another site); a backup on the same disk does not survive the disk failing. They do not contain ENCRYPTION_KEY, so keep that safe too.</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button className={btnPrimary} disabled={run.isPending || busy || !c.passphraseConfigured} onClick={() => run.mutate()}>{busy ? 'A backup is in progress…' : 'Back up now'}</button>
          {!c.passphraseConfigured && <span className="text-xs text-danger">Set BACKUP_PASSPHRASE_FILE (or BACKUP_PASSPHRASE) on the worker first.</span>}
          {run.error && <span role="alert" className="text-xs text-danger">{errText(run.error)}</span>}
        </div>
      </Card>
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="text-left text-xs text-muted"><tr><th className="px-3 py-2 font-medium">When</th><th className="font-medium">How</th><th className="font-medium">Result</th><th className="font-medium">Contents</th><th className="font-medium">File</th></tr></thead>
          <tbody>
            {runs.map((r) => {
              const [label, cls] = state(r);
              return (
                <tr key={r.id} className="border-t border-line align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted">{new Date(r.requestedAt).toLocaleString()}</td>
                  <td>{r.trigger === 'schedule' ? 'Scheduled' : 'By hand'}</td>
                  <td><span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{label}</span>
                    {r.error && <p className="mt-1 max-w-72 break-words text-xs text-danger">{r.error}</p>}
                    {(r.missing > 0 || r.corrupt > 0) && <p className="mt-1 text-xs text-danger">{r.missing} stored file(s) missing, {r.corrupt} damaged when it was made</p>}</td>
                  <td className="text-xs text-muted">{r.rows !== null ? `${r.rows} rows, ${r.objects} files, ${formatBytes(r.bytes ?? 0)}` : ''}</td>
                  <td className="max-w-48 truncate font-mono text-xs text-muted" title={r.fileName ?? undefined}>{r.pruned ? 'deleted (older than the keep limit)' : r.fileName ?? ''}</td>
                </tr>
              );
            })}
            {runs.length === 0 && <tr><td colSpan={5} className="p-8 text-center text-muted">No backups yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">To check that a backup really restores, run <code>cli restore-test &lt;file&gt;</code>: it restores into a throwaway database and deletes it again.</p>
    </div>
  );
}

function Users({ selfId }: { selfId: string }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: ['admin', 'users', search, status, offset],
    queryFn: () => api<{ total: number; users: AdminUser[] }>(`/admin/users?limit=25&offset=${offset}${search ? `&q=${encodeURIComponent(search)}` : ''}${status ? `&status=${status}` : ''}`),
  });
  const patch = useMutation({
    mutationFn: (a: { id: string; body: Record<string, unknown> }) => api(`/admin/users/${a.id}`, { method: 'PATCH', body: a.body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin'] }),
  });
  const [editQuota, setEditQuota] = useState<{ id: string; gb: string } | null>(null);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input className={`${input} min-w-0 flex-1`} type="search" placeholder="Search by email" aria-label="Search users by email" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} />
        <select className={input} aria-label="Filter by status" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
          <option value="">All users</option><option value="active">Active</option><option value="disabled">Disabled</option>
        </select>
      </div>
      {patch.error && <p role="alert" className="text-sm text-danger">{errText(patch.error)}</p>}
      {q.isPending ? <Loading /> : q.error ? <p role="alert" className="text-danger">{q.error.message}</p> : (
        <div className="rounded-lg border border-line bg-surface">
          {q.data.users.length === 0 ? <p className="p-8 text-center text-sm text-muted">No users match.</p> : (
            <ul className="divide-y divide-line">
              {q.data.users.map((u) => {
                const isAdmin = u.roles.includes('admin'), me = u.id === selfId;
                return (
                  <li key={u.id} className="space-y-1 px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium">{u.email}{me && <span className="ml-2 text-xs font-normal text-muted">(you)</span>}</span>
                      {isAdmin && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">Admin</span>}
                      <span className={`rounded-full px-2 py-0.5 text-xs ${u.status === 'active' ? 'bg-line/70 text-muted' : 'bg-danger/10 text-danger'}`}>{u.status === 'active' ? 'Active' : 'Disabled'}</span>
                    </div>
                    <p className="text-xs text-muted">
                      {u.files} files · {formatBytes(u.usedBytes ?? 0)} of {formatBytes(u.quotaBytes ?? 0)} · joined {new Date(u.createdAt).toLocaleDateString()}
                      {u.lastSeenAt ? ` · last seen ${new Date(u.lastSeenAt).toLocaleString()}` : ''}
                    </p>
                    <div className="flex flex-wrap gap-2 pt-1">
                      {!me && <button className={u.status === 'active' ? btnDanger : btnGhost} disabled={patch.isPending} onClick={() => patch.mutate({ id: u.id, body: { status: u.status === 'active' ? 'disabled' : 'active' } })}>{u.status === 'active' ? 'Disable' : 'Enable'}</button>}
                      {!me && <button className={btnGhost} disabled={patch.isPending} onClick={() => patch.mutate({ id: u.id, body: { admin: !isAdmin } })}>{isAdmin ? 'Remove admin' : 'Make admin'}</button>}
                      {editQuota?.id === u.id ? (
                        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); patch.mutate({ id: u.id, body: { quotaBytes: Math.round(Number(editQuota.gb) * 1024 ** 3) } }); setEditQuota(null); }}>
                          <input className={`${input} w-24`} type="number" min={0} step="0.1" autoFocus aria-label="Quota in GB" value={editQuota.gb} onChange={(e) => setEditQuota({ id: u.id, gb: e.target.value })} /><span>GB</span>
                          <button className={btnPrimary}>Set</button><button type="button" className={btnGhost} onClick={() => setEditQuota(null)}>Cancel</button>
                        </form>
                      ) : <button className={btnGhost} onClick={() => setEditQuota({ id: u.id, gb: String(+((u.quotaBytes ?? 0) / 1024 ** 3).toFixed(2)) })}>Change quota</button>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {q.data && q.data.total > 25 && (
        <div className="flex items-center justify-between text-sm text-muted">
          <span>{offset + 1}–{Math.min(offset + 25, q.data.total)} of {q.data.total}</span>
          <span className="flex gap-2"><button className={btnGhost} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous</button>
            <button className={btnGhost} disabled={offset + 25 >= q.data.total} onClick={() => setOffset(offset + 25)}>Next</button></span>
        </div>
      )}
    </div>
  );
}

function Reports() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'open' | 'actioned' | 'dismissed'>('open');
  const q = useQuery({ queryKey: ['admin', 'reports', status], queryFn: () => api<{ total: number; reports: AdminReport[] }>(`/admin/reports?status=${status}`) });
  const [note, setNote] = useState<Record<string, string>>({});
  const resolve = useMutation({
    mutationFn: (a: { id: string; action: string }) => api(`/admin/reports/${a.id}/resolve`, { method: 'POST', body: { action: a.action, note: note[a.id]?.trim() || undefined } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin'] }),
  });
  return (
    <div className="space-y-3">
      <div className="flex gap-2" role="tablist" aria-label="Report status">
        {(['open', 'actioned', 'dismissed'] as const).map((s) => (
          <button key={s} role="tab" aria-selected={status === s} onClick={() => setStatus(s)} className={`rounded-md px-3 py-1.5 text-sm ${status === s ? 'bg-accent/10 font-medium text-accent' : 'text-muted hover:bg-line/50'}`}>{s[0]!.toUpperCase() + s.slice(1)}</button>
        ))}
      </div>
      {resolve.error && <p role="alert" className="text-sm text-danger">{errText(resolve.error)}</p>}
      {q.isPending ? <Loading /> : q.error ? <p role="alert" className="text-danger">{q.error.message}</p> : q.data.reports.length === 0 ? <p className="rounded-lg border border-line bg-surface p-8 text-center text-sm text-muted">No {status} reports.</p> : (
        <ul className="space-y-3">
          {q.data.reports.map((r) => (
            <li key={r.id} className="rounded-lg border border-line bg-surface p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">{r.fileName ?? 'Unknown file'}</span>
                <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs text-danger">{r.reason}</span>
                {r.linkDisabled && <span className="rounded-full bg-line/70 px-2 py-0.5 text-xs text-muted">Link already disabled</span>}
              </div>
              <p className="mt-1 text-xs text-muted">Owner: {r.ownerEmail ?? 'deleted account'}{r.ownerActionedReports > 0 ? ` · ${r.ownerActionedReports} earlier action${r.ownerActionedReports > 1 ? 's' : ''} against this owner` : ''} · reported {new Date(r.createdAt).toLocaleString()}</p>
              {r.details && <blockquote className="mt-2 whitespace-pre-wrap break-words border-l-2 border-line pl-3 text-muted">{r.details}</blockquote>}
              {r.status === 'open' ? (
                <div className="mt-3 space-y-2">
                  <input className={`${input} w-full`} placeholder="Note for the record (optional)" aria-label="Resolution note" maxLength={1000} value={note[r.id] ?? ''} onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} />
                  <div className="flex flex-wrap gap-2">
                    <button className={btnGhost} disabled={resolve.isPending} onClick={() => resolve.mutate({ id: r.id, action: 'dismiss' })}>Dismiss</button>
                    <button className={btnDanger} disabled={resolve.isPending} onClick={() => resolve.mutate({ id: r.id, action: 'disable_link' })}>Disable this link</button>
                    <button className={btnDanger} disabled={resolve.isPending} onClick={() => resolve.mutate({ id: r.id, action: 'disable_link_and_file' })}>Disable link and block sharing of the file</button>
                  </div>
                  <p className="text-xs text-muted">The owner is notified when a link is disabled. Administrators cannot see file contents.</p>
                </div>
              ) : <p className="mt-2 text-xs text-muted">{r.status === 'actioned' ? 'Actioned' : 'Dismissed'} {r.resolvedAt ? new Date(r.resolvedAt).toLocaleString() : ''}{r.resolutionNote ? ` — ${r.resolutionNote}` : ''}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Operations() {
  const queues = useQuery({ queryKey: ['admin', 'queues'], queryFn: () => api<AdminQueues>('/admin/queues'), refetchInterval: 10_000 });
  const workers = useQuery({ queryKey: ['admin', 'workers'], queryFn: () => api<{ workers: AdminWorker[] }>('/admin/workers'), refetchInterval: 10_000 });
  const table = (rows: { state: string; count: number; oldestSeconds: number | null; expiredLeases?: number }[]) => rows.length === 0 ? <p className="text-sm text-muted">Nothing queued or recent.</p> : (
    <table className="w-full text-sm"><thead className="text-left text-xs text-muted"><tr><th className="py-1 font-medium">State</th><th className="font-medium">Count</th><th className="font-medium">Oldest</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.state} className="border-t border-line"><td className="py-1">{r.state}</td><td>{r.count}</td>
          <td>{r.oldestSeconds === null ? '–' : formatDuration(r.oldestSeconds)}{r.expiredLeases ? <span className="ml-2 text-danger">{r.expiredLeases} stuck</span> : null}</td></tr>
      ))}</tbody></table>
  );
  return (
    <div className="space-y-3">
      <Card title="Worker processes">
        {workers.isPending ? <Loading /> : workers.error ? <p role="alert" className="text-danger">{workers.error.message}</p> : workers.data.workers.length === 0 ? (
          <p role="alert" className="text-sm text-danger">No worker has reported in. Background work (downloads, Telegram, media, email) will not run until one starts.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {workers.data.workers.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                <span className={`rounded-full px-2 py-0.5 text-xs ${w.alive ? 'bg-accent/10 text-accent' : 'bg-danger/10 text-danger'}`}>{w.alive ? 'Alive' : 'Silent'}</span>
                <span className="font-mono text-xs">{w.id}</span>
                <span className="text-xs text-muted">{w.host ?? ''} · started {new Date(w.startedAt).toLocaleString()} · last heard {new Date(w.lastSeenAt).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {queues.isPending ? <Loading /> : queues.error ? <p role="alert" className="text-danger">{queues.error.message}</p> : (
        <div className="grid gap-3 lg:grid-cols-3">
          <Card title="Downloads">{table(queues.data.downloads)}</Card>
          <Card title="Telegram transfers">{table(queues.data.telegram)}</Card>
          <Card title="Media processing">{table(queues.data.media)}</Card>
          <Card title="Torrents">{table(queues.data.torrents)}</Card>
          <div className="lg:col-span-3"><Card title="Recent download failures (error codes only)">
            {queues.data.recentDownloadFailures.length === 0 ? <p className="text-sm text-muted">None.</p> : (
              <ul className="grid gap-x-6 text-sm sm:grid-cols-2">{queues.data.recentDownloadFailures.map((f) => <li key={f.id} className="flex justify-between border-t border-line py-1"><span className="font-mono text-xs">{f.code ?? 'unknown'}</span><span className="text-xs text-muted">{new Date(f.at).toLocaleString()}</span></li>)}</ul>
            )}
          </Card></div>
        </div>
      )}
      <p className="text-xs text-muted">For privacy, administrators see job states and error codes, never users' URLs or file names.</p>
    </div>
  );
}

function Audit() {
  const [action, setAction] = useState('');
  const [pages, setPages] = useState<(number | null)[]>([null]);
  const before = pages[pages.length - 1];
  const q = useQuery({
    queryKey: ['admin', 'audit', action, before],
    queryFn: () => api<{ entries: AuditEntry[]; nextBefore: number | null }>(`/admin/audit?limit=50${before ? `&before=${before}` : ''}${action ? `&action=${encodeURIComponent(action)}` : ''}`),
  });
  return (
    <div className="space-y-3">
      <select className={input} aria-label="Filter by action" value={action} onChange={(e) => { setAction(e.target.value); setPages([null]); }}>
        <option value="">All activity</option><option value="auth.">Sign-ins</option><option value="user.">Registrations</option><option value="admin.">Administrator actions</option>
        <option value="share.">Sharing</option><option value="session.">Sessions</option><option value="account.">Account changes</option>
      </select>
      {q.isPending ? <Loading /> : q.error ? <p role="alert" className="text-danger">{q.error.message}</p> : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="text-left text-xs text-muted"><tr><th className="px-3 py-2 font-medium">When</th><th className="font-medium">Who</th><th className="font-medium">Action</th><th className="font-medium">Target</th><th className="font-medium">Address</th></tr></thead>
            <tbody>
              {q.data.entries.map((e) => (
                <tr key={e.id} className="border-t border-line align-top">
                  <td className="whitespace-nowrap px-3 py-1.5 text-xs text-muted">{new Date(e.at).toLocaleString()}</td>
                  <td className="max-w-48 truncate" title={e.email ?? undefined}>{e.email ?? <span className="text-muted">–</span>}</td>
                  <td className="font-mono text-xs">{e.action}</td>
                  <td className="max-w-56 truncate font-mono text-xs text-muted" title={e.target ?? undefined}>{e.target ?? ''}</td>
                  <td className="text-xs text-muted">{e.ip ?? ''}</td>
                </tr>
              ))}
              {q.data.entries.length === 0 && <tr><td colSpan={5} className="p-8 text-center text-muted">No entries.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex gap-2">
        <button className={btnGhost} disabled={pages.length === 1} onClick={() => setPages(pages.slice(0, -1))}>Newer</button>
        <button className={btnGhost} disabled={!q.data?.nextBefore} onClick={() => q.data?.nextBefore && setPages([...pages, q.data.nextBefore])}>Older</button>
      </div>
    </div>
  );
}

function ServerSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api<{ settings: { registration_policy: 'open' | 'closed'; default_quota_bytes: number; torrents_enabled: boolean } }>('/admin/settings') });
  const [gb, setGb] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/admin/settings', { method: 'PATCH', body }),
    onSuccess: () => { setGb(null); void qc.invalidateQueries({ queryKey: ['admin', 'settings'] }); },
  });
  if (q.isPending) return <Loading />;
  if (q.error) return <p role="alert" className="text-danger">{q.error.message}</p>;
  const s = q.data.settings;
  return (
    <div className="space-y-3">
      {save.error && <p role="alert" className="text-sm text-danger">{errText(save.error)}</p>}
      <Card title="Who can sign up">
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={s.registration_policy === 'open'} disabled={save.isPending} onChange={(e) => save.mutate({ registration_policy: e.target.checked ? 'open' : 'closed' })} />
          <span>Anyone with a Google account can create an account<span className="block text-xs text-muted">When off, only existing users and the addresses in ADMIN_EMAILS can sign in.</span></span></label>
      </Card>
      <Card title="Torrent downloads">
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={s.torrents_enabled} disabled={save.isPending} onChange={(e) => save.mutate({ torrents_enabled: e.target.checked })} />
          <span>Let users download from magnet links and .torrent files
            <span className="block text-xs text-muted">Off by default. Turning it on makes this server connect to other people's computers, who can see its internet address and what it downloads, and who may be breaking copyright law if you let users fetch what they should not. Consider running the server behind a VPN. Peers on private networks, trackers on private networks and web seeds are never contacted.</span></span></label>
      </Card>
      <Card title="Storage quota for new users">
        <form className="flex flex-wrap items-center gap-2 text-sm" onSubmit={(e) => { e.preventDefault(); save.mutate({ default_quota_bytes: Math.round(Number(gb) * 1024 ** 3) }); }}>
          <input className={`${input} w-28`} type="number" min={0} step="0.1" aria-label="Default quota in GB" value={gb ?? +(s.default_quota_bytes / 1024 ** 3).toFixed(2)} onChange={(e) => setGb(e.target.value)} /> GB
          <button className={btnPrimary} disabled={gb === null || save.isPending}>Save</button>
          <span className="w-full text-xs text-muted">Applies to accounts created from now on. Change an existing user's quota on the Users tab.</span>
        </form>
      </Card>
      <p className="text-xs text-muted">Everything else (storage backend, email, Telegram, limits) is configured through environment variables, so secrets never pass through the browser.</p>
    </div>
  );
}

export function Admin({ selfId }: { selfId: string }) {
  const [tab, setTab] = useState<Tab>('Overview');
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <h1 className="text-xl font-semibold">Administration</h1>
      <div role="tablist" aria-label="Administration sections" className="flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-accent font-medium text-accent' : 'border-transparent text-muted hover:text-fg'}`}>{t}</button>
        ))}
      </div>
      <div role="tabpanel" aria-label={tab}>
        {tab === 'Overview' && <Overview />}
        {tab === 'Users' && <Users selfId={selfId} />}
        {tab === 'Reports' && <Reports />}
        {tab === 'Backups' && <Backups />}
        {tab === 'Operations' && <Operations />}
        {tab === 'Audit log' && <Audit />}
        {tab === 'Settings' && <ServerSettings />}
      </div>
    </div>
  );
}
