import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, LogOut, Monitor, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, api, formatBytes, type AccountSettings, type Me, type SessionItem } from '../api';
import { Dialog, btnDanger, btnGhost, btnPrimary } from '../components/Dialog';

const input = 'w-full rounded-md border border-line bg-bg px-3 py-1.5 text-sm';

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4 md:p-6">
      <h2 className="font-semibold">{title}</h2>
      {hint && <p className="mb-4 mt-1 text-sm text-muted">{hint}</p>}
      <div className={hint ? '' : 'mt-4'}>{children}</div>
    </section>
  );
}

const describeAgent = (ua: string | null) => {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
};

export function Settings({ me }: { me: Me['user'] }) {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ['settings'], queryFn: () => api<AccountSettings>('/account/settings') });
  const folders = useQuery({ queryKey: ['folders-all'], queryFn: () => api<{ folders: { id: string; parentId: string | null; name: string }[] }>('/folders') });
  const kinds = useQuery({ queryKey: ['notif-kinds'], queryFn: () => api<{ kinds: { kind: string; label: string }[] }>('/notifications/kinds') });
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ sessions: SessionItem[] }>('/account/sessions') });

  const [displayName, setDisplayName] = useState('');
  const [concurrency, setConcurrency] = useState('');
  const [bandwidth, setBandwidth] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (!s.data) return;
    setDisplayName(s.data.displayName ?? '');
    setConcurrency(s.data.downloadConcurrency?.toString() ?? '');
    setBandwidth(s.data.downloadBandwidthBps ? String(Math.round(s.data.downloadBandwidthBps / 1024)) : '');
  }, [s.data]);

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api<AccountSettings>('/account/settings', { method: 'PATCH', body: patch }),
    onSuccess: (data) => {
      qc.setQueryData(['settings'], data);
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['notif-count'] }); void qc.invalidateQueries({ queryKey: ['notifs'] });
      setSaved('Saved'); setTimeout(() => setSaved(null), 2500);
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/account/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sessions'] }),
  });
  const revokeOthers = useMutation({
    mutationFn: () => api<{ revoked: number }>('/account/sessions/revoke-others', { method: 'POST', body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sessions'] }),
  });

  const [del, setDel] = useState(false);
  const [confirm, setConfirm] = useState('');
  const remove = useMutation({
    mutationFn: () => api('/account/delete', { method: 'POST', body: { confirmEmail: confirm } }),
    onSuccess: () => { qc.clear(); window.location.assign('/'); },
  });

  if (s.isPending) return <div className="animate-pulse space-y-3" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-32 rounded bg-line/60" />)}</div>;
  if (s.error) return <p role="alert" className="text-danger">Failed to load settings: {s.error.message}</p>;
  const cfg = s.data;
  const pathOf = (id: string): string => {
    const all = folders.data?.folders ?? [];
    const out: string[] = []; let cur = all.find((f) => f.id === id);
    while (cur) { out.unshift(cur.name); cur = all.find((f) => f.id === cur!.parentId); }
    return '/' + out.join('/');
  };
  const err = save.error instanceof ApiError ? save.error.message : save.error ? 'Could not save' : null;
  const toggleMuted = (kind: string) => save.mutate({ mutedKinds: cfg.mutedKinds.includes(kind) ? cfg.mutedKinds.filter((k) => k !== kind) : [...cfg.mutedKinds, kind] });

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div><h1 className="text-xl font-semibold">Settings</h1><p className="text-sm text-muted">{me.email}</p></div>
      <div aria-live="polite" className="min-h-5 text-sm">{err ? <span role="alert" className="text-danger">{err}</span> : saved ? <span className="text-accent">{saved}</span> : null}</div>

      <Section title="Profile">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate({ displayName: displayName.trim() || null }); }}>
          <label className="block text-sm">Display name
            <input className={`${input} mt-1`} value={displayName} maxLength={100} onChange={(e) => setDisplayName(e.target.value)} /></label>
          <fieldset>
            <legend className="text-sm">Theme</legend>
            <div className="mt-1 flex gap-4 text-sm">
              {(['system', 'light', 'dark'] as const).map((t) => (
                <label key={t} className="flex items-center gap-1.5"><input type="radio" name="theme" checked={cfg.theme === t} onChange={() => save.mutate({ theme: t })} />{t[0]!.toUpperCase() + t.slice(1)}</label>
              ))}
            </div>
          </fieldset>
          <button className={btnPrimary} disabled={save.isPending}>Save name</button>
        </form>
      </Section>

      <Section title="Downloads" hint="Your own limits can only be lower than the server's, never higher.">
        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ downloadConcurrency: concurrency ? Number(concurrency) : null, downloadBandwidthBps: bandwidth ? Math.round(Number(bandwidth) * 1024) : null });
        }}>
          <label className="block text-sm">Save new downloads to
            <select className={`${input} mt-1`} value={cfg.defaultDownloadFolderId ?? ''} onChange={(e) => save.mutate({ defaultDownloadFolderId: e.target.value || null })}>
              <option value="">My Files (top level)</option>
              {(folders.data?.folders ?? []).map((f) => <option key={f.id} value={f.id}>{pathOf(f.id)}</option>)}
            </select></label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">Simultaneous downloads (max {cfg.limits.downloadConcurrency})
              <input className={`${input} mt-1`} type="number" min={1} max={cfg.limits.downloadConcurrency} placeholder={`Server default (${cfg.limits.downloadConcurrency})`} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} /></label>
            <label className="block text-sm">Speed limit per download, KB/s
              <input className={`${input} mt-1`} type="number" min={0} placeholder={cfg.limits.downloadBandwidthBps ? `Server limit ${formatBytes(cfg.limits.downloadBandwidthBps)}/s` : 'No limit'} value={bandwidth} onChange={(e) => setBandwidth(e.target.value)} /></label>
          </div>
          <button className={btnPrimary} disabled={save.isPending}>Save download settings</button>
        </form>
      </Section>

      <Section title="Notifications" hint="Notifications always appear in the bell. Email is optional.">
        <label className={`flex items-start gap-2 text-sm ${cfg.limits.emailAvailable ? '' : 'opacity-60'}`}>
          <input type="checkbox" className="mt-0.5" checked={cfg.emailNotifications} disabled={!cfg.limits.emailAvailable || save.isPending} onChange={(e) => save.mutate({ emailNotifications: e.target.checked })} />
          <span>Also email me at {me.email}
            {!cfg.limits.emailAvailable && <span className="block text-xs text-muted">The administrator has not set up an email server, so this is not available.</span>}</span>
        </label>
        <fieldset className="mt-4">
          <legend className="text-sm font-medium">Tell me about</legend>
          <p className="text-xs text-muted">Unticked kinds are hidden and never emailed.</p>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {(kinds.data?.kinds ?? []).map((k) => (
              <label key={k.kind} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!cfg.mutedKinds.includes(k.kind)} disabled={save.isPending} onChange={() => toggleMuted(k.kind)} />{k.label}</label>
            ))}
          </div>
        </fieldset>
      </Section>

      <Section title="Where you are signed in" hint="If you do not recognise a session, sign it out.">
        {sessions.isPending ? <p className="text-sm text-muted">Loading…</p> : sessions.error ? <p role="alert" className="text-sm text-danger">Could not load sessions.</p> : (
          <>
            <ul className="divide-y divide-line">
              {sessions.data.sessions.map((x) => (
                <li key={x.id} className="flex items-center gap-3 py-2 text-sm">
                  <Monitor size={18} className="shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{describeAgent(x.userAgent)}{x.current && <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">This device</span>}</p>
                    <p className="text-xs text-muted">{x.ip ?? 'unknown address'} · active {new Date(x.lastSeenAt).toLocaleString()}</p>
                  </div>
                  {!x.current && <button className={btnGhost} disabled={revoke.isPending} aria-label={`Sign out ${describeAgent(x.userAgent)}`} onClick={() => revoke.mutate(x.id)}><LogOut size={14} aria-hidden /></button>}
                </li>
              ))}
            </ul>
            {sessions.data.sessions.length > 1 && <button className={`${btnGhost} mt-3`} disabled={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>Sign out all other sessions</button>}
          </>
        )}
      </Section>

      <Section title="Your data">
        <p className="mb-3 text-sm text-muted">Download everything CloudSeed holds about your account as a JSON file: file list, folders, share links, downloads, notifications and activity. Secrets such as Telegram bot tokens are never included, and the files themselves are not (download them from My Files).</p>
        <a href="/api/v1/account/export" download className={`${btnGhost} inline-flex items-center gap-2`}><Download size={14} aria-hidden />Export my data</a>
      </Section>

      <section className="rounded-lg border border-danger/40 bg-surface p-4 md:p-6">
        <h2 className="font-semibold text-danger">Delete account</h2>
        <p className="mb-3 mt-1 text-sm text-muted">Permanently deletes your account, all your files, share links, downloads and Telegram connections. This cannot be undone. Consider exporting your data first.</p>
        <button className={btnDanger} onClick={() => { setConfirm(''); remove.reset(); setDel(true); }}><span className="inline-flex items-center gap-2"><Trash2 size={14} aria-hidden />Delete my account…</span></button>
      </section>

      <Dialog open={del} title="Delete your account?" onClose={() => setDel(false)}>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); remove.mutate(); }}>
          <p className="text-sm">Everything you stored here will be erased immediately. Type your email address <strong>{me.email}</strong> to confirm.</p>
          <input className={input} autoFocus autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Your email address" />
          {remove.error && <p role="alert" className="text-sm text-danger">{remove.error instanceof ApiError ? remove.error.message : 'Could not delete the account'}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={btnGhost} onClick={() => setDel(false)}>Cancel</button>
            <button className={btnDanger} disabled={remove.isPending || confirm.trim().toLowerCase() !== me.email.toLowerCase()}>{remove.isPending ? 'Deleting…' : 'Delete everything'}</button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
