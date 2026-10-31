import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bot, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, KeyRound, RotateCcw, Send, Star, Trash2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, api, formatBytes, type TgBot, type TgDestination, type TgFile, type TgState, type TgStatus, type TgTransfer } from '../api';
import { Dialog, btnDanger, btnGhost, btnPrimary } from '../components/Dialog';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong');
const STATE_STYLE: Record<TgState, string> = {
  queued: 'bg-line/70 text-muted', uploading: 'bg-accent/10 text-accent', sent: 'bg-accent/10 text-accent',
  partial: 'bg-danger/10 text-danger', failed: 'bg-danger/10 text-danger', cancelled: 'bg-line/70 text-muted',
};
const STATE_LABEL: Record<TgState, string> = { queued: 'Queued', uploading: 'Sending', sent: 'Sent', partial: 'Partly sent', failed: 'Failed', cancelled: 'Cancelled' };

function Section({ id, title, icon, children, action }: { id: string; title: string; icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-lg border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line p-4">
        <h2 id={id} className="flex items-center gap-2 text-sm font-medium">{icon}{title}</h2>{action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

// ------------------------------------------------------------------ bots
function BotsSection({ bots }: { bots: TgBot[] }) {
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [rotate, setRotate] = useState<TgBot | null>(null);
  const [rotateToken, setRotateToken] = useState('');
  const [disconnect, setDisconnect] = useState<TgBot | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['tg-bots'] }); void qc.invalidateQueries({ queryKey: ['tg-destinations'] }); void qc.invalidateQueries({ queryKey: ['tg-transfers'] }); };

  const connect = useMutation({
    mutationFn: () => api('/telegram/bots', { method: 'POST', body: { token: token.trim() } }),
    onSuccess: () => { setToken(''); setError(''); refresh(); }, onError: (e) => setError(errText(e)),
  });
  const test = useMutation({
    mutationFn: (b: TgBot) => api(`/telegram/bots/${b.id}/test`, { method: 'POST' }),
    onSuccess: (_d, b) => { setNote((n) => ({ ...n, [b.id]: 'Connection OK' })); refresh(); },
    onError: (e, b) => { setNote((n) => ({ ...n, [b.id]: errText(e) })); refresh(); },
  });
  const doRotate = useMutation({
    mutationFn: () => api(`/telegram/bots/${rotate!.id}/token`, { method: 'PUT', body: { token: rotateToken.trim() } }),
    onSuccess: () => { setRotate(null); setRotateToken(''); setError(''); refresh(); }, onError: (e) => setError(errText(e)),
  });
  const doDisconnect = useMutation({
    mutationFn: () => api(`/telegram/bots/${disconnect!.id}`, { method: 'DELETE' }),
    onSuccess: () => { setDisconnect(null); refresh(); }, onError: (e) => setError(errText(e)),
  });

  const live = bots.filter((b) => b.status !== 'disconnected');
  return (
    <Section id="bots-h" title="Bots" icon={<Bot size={16} aria-hidden />}>
      {live.length === 0 && <p className="mb-3 text-sm text-muted">No bot connected. Telegram is shown as disconnected until you add one below.</p>}
      <ul className="mb-4 divide-y divide-line">
        {bots.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">@{b.username}</div>
              <div className="text-xs text-muted">{b.name}</div>
              {note[b.id] && <div role="status" className="text-xs text-muted">{note[b.id]}</div>}
            </div>
            <span className={`rounded-full px-2 py-0.5 text-xs ${b.status === 'active' ? 'bg-accent/10 text-accent' : b.status === 'invalid' ? 'bg-danger/10 text-danger' : 'bg-line/70 text-muted'}`}>
              {b.status === 'active' ? 'Connected' : b.status === 'invalid' ? 'Token rejected' : 'Disconnected'}
            </span>
            {b.status !== 'disconnected' && (
              <div className="flex gap-2">
                <button className={btnGhost} onClick={() => test.mutate(b)} disabled={test.isPending}>Test connection</button>
                <button className={btnGhost} onClick={() => { setRotate(b); setError(''); }}><KeyRound size={14} className="mr-1 inline" aria-hidden />Rotate token</button>
                <button className={btnGhost} onClick={() => setDisconnect(b)}>Disconnect</button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <form onSubmit={(e) => { e.preventDefault(); connect.mutate(); }} className="space-y-2">
        <label className="block text-sm"><span className="mb-1 block text-muted">{live.length > 0 ? 'Connect another bot (token)' : 'Bot token'}</span>
          <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456789:AA…"
            className="w-full rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs" /></label>
        <p className="text-xs text-muted">The token is encrypted on the server and is never shown again after you save it.</p>
        {error && !rotate && <p role="alert" className="text-sm text-danger">{error}</p>}
        <button type="submit" className={btnPrimary} disabled={!token.trim() || connect.isPending}>{connect.isPending ? 'Checking with Telegram…' : 'Connect bot'}</button>
      </form>

      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-accent">How do I create a bot?</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted">
          <li>In Telegram, open <a className="text-accent hover:underline" href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather <ExternalLink size={11} className="inline" aria-hidden /></a> and send <code>/newbot</code>.</li>
          <li>Choose a name and a username ending in <code>bot</code>. BotFather replies with a token.</li>
          <li>Paste the token above. Nobody needs your Telegram password, and CloudSeed never asks for it.</li>
        </ol>
      </details>

      <Dialog open={rotate !== null} title={`Rotate token for @${rotate?.username ?? ''}`} onClose={() => setRotate(null)}>
        <form onSubmit={(e) => { e.preventDefault(); doRotate.mutate(); }} className="space-y-3 text-sm">
          <p className="text-muted">Revoke the old token with <code>/revoke</code> in BotFather, then paste the new one. It must belong to the same bot. Queued files are kept and continue afterwards.</p>
          <input type="password" autoComplete="off" autoFocus value={rotateToken} onChange={(e) => setRotateToken(e.target.value)} placeholder="New token" aria-label="New bot token"
            className="w-full rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs" />
          {error && <p role="alert" className="text-danger">{error}</p>}
          <div className="flex justify-end gap-2"><button type="button" className={btnGhost} onClick={() => setRotate(null)}>Cancel</button>
            <button type="submit" className={btnPrimary} disabled={!rotateToken.trim() || doRotate.isPending}>Replace token</button></div>
        </form>
      </Dialog>
      <Dialog open={disconnect !== null} title="Disconnect this bot?" onClose={() => setDisconnect(null)}>
        <p className="text-sm text-muted">The stored token is erased and anything still queued for @{disconnect?.username} is cancelled. History is kept. You can connect it again later with a token.</p>
        {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2"><button className={btnGhost} onClick={() => setDisconnect(null)}>Cancel</button>
          <button className={btnDanger} onClick={() => doDisconnect.mutate()} disabled={doDisconnect.isPending}>Disconnect</button></div>
      </Dialog>
    </Section>
  );
}

// ------------------------------------------------------------------ destinations
function DestinationsSection({ bots, dests }: { bots: TgBot[]; dests: TgDestination[] }) {
  const qc = useQueryClient();
  const active = bots.filter((b) => b.status === 'active');
  const [botId, setBotId] = useState('');
  const [chat, setChat] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState<Record<string, string>>({});
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['tg-destinations'] }); void qc.invalidateQueries({ queryKey: ['tg-transfers'] }); };
  useEffect(() => { if (!botId && active[0]) setBotId(active[0].id); }, [active, botId]);

  const add = useMutation({
    mutationFn: () => api('/telegram/destinations', { method: 'POST', body: { botId, chat: chat.trim() } }),
    onSuccess: () => { setChat(''); setError(''); refresh(); }, onError: (e) => setError(errText(e)),
  });
  const act = useMutation({
    mutationFn: (a: { d: TgDestination; path: string; method?: string; body?: unknown; label?: string }) =>
      api<{ link?: { url: string } | null }>(`/telegram/destinations/${a.d.id}${a.path}`, { method: a.method ?? 'POST', body: a.body }),
    onSuccess: (r, a) => { setNote((n) => ({ ...n, [a.d.id]: a.label === 'test' ? `Test message sent${r?.link ? ` (${r.link.url})` : ''}` : '' })); refresh(); },
    onError: (e, a) => { setNote((n) => ({ ...n, [a.d.id]: errText(e) })); refresh(); },
  });

  return (
    <Section id="dest-h" title="Destinations" icon={<Send size={16} aria-hidden />}>
      {dests.length === 0 && <p className="mb-3 text-sm text-muted">No destinations yet. Add the bot to a group or channel in Telegram, then register it here.</p>}
      <ul className="mb-4 divide-y divide-line">
        {dests.map((d) => (
          <li key={d.id} className="space-y-1 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{d.title}</span>
              {d.isDefault && <span className="flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent"><Star size={11} aria-hidden />Default</span>}
              <span className="rounded-full bg-line/70 px-2 py-0.5 text-xs text-muted">{d.type}</span>
              <span className="text-xs text-muted">{d.username ? `@${d.username} · ` : ''}ID {d.chatId} · via @{d.botUsername}</span>
              <span className={`ml-auto flex items-center gap-1 text-xs ${d.canSend ? 'text-accent' : 'text-danger'}`}>
                {d.canSend ? <><CheckCircle2 size={13} aria-hidden />Can post</> : <><XCircle size={13} aria-hidden />Cannot post</>}
              </span>
            </div>
            {d.problem && <p className="flex items-start gap-1 text-xs text-danger"><AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />{d.problem}</p>}
            {note[d.id] && <p role="status" className="break-all text-xs text-muted">{note[d.id]}</p>}
            <div className="flex flex-wrap gap-2 pt-1">
              <button className={btnGhost} disabled={act.isPending || !d.canSend} onClick={() => act.mutate({ d, path: '/test', label: 'test' })}>Send test message</button>
              <button className={btnGhost} disabled={act.isPending} onClick={() => act.mutate({ d, path: '/validate' })}>Recheck permissions</button>
              {!d.isDefault && d.canSend && <button className={btnGhost} disabled={act.isPending} onClick={() => act.mutate({ d, path: '', method: 'PATCH', body: { isDefault: true } })}>Make default</button>}
              <button className={btnGhost} disabled={act.isPending} aria-label={`Remove ${d.title}`} onClick={() => act.mutate({ d, path: '', method: 'DELETE' })}><Trash2 size={14} aria-hidden /></button>
            </div>
          </li>
        ))}
      </ul>

      {active.length > 0 ? (
        <form onSubmit={(e) => { e.preventDefault(); add.mutate(); }} className="flex flex-wrap items-end gap-2 text-sm">
          <label><span className="mb-1 block text-muted">Bot</span>
            <select value={botId} onChange={(e) => setBotId(e.target.value)} className="rounded-md border border-line bg-bg px-2 py-2">
              {active.map((b) => <option key={b.id} value={b.id}>@{b.username}</option>)}
            </select></label>
          <label className="min-w-56 flex-1"><span className="mb-1 block text-muted">Chat ID, @username or t.me link</span>
            <input value={chat} onChange={(e) => setChat(e.target.value)} placeholder="-1001234567890 or @mychannel" className="w-full rounded-md border border-line bg-bg px-3 py-2" /></label>
          <button type="submit" className={btnPrimary} disabled={!chat.trim() || !botId || add.isPending}>{add.isPending ? 'Checking…' : 'Add destination'}</button>
          {error && <p role="alert" className="w-full text-danger">{error}</p>}
        </form>
      ) : <p className="text-sm text-muted">Connect a bot first.</p>}

      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-accent">How do I let the bot post to my group or channel?</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
          <li><strong>Group:</strong> add the bot as a member. It can then send messages and files. If the group restricts members, allow sending messages and files, or make the bot an administrator.</li>
          <li><strong>Channel:</strong> add the bot as an <em>administrator</em> with <em>Post messages</em> enabled. A plain member cannot post to a channel.</li>
          <li>Public chats can be added by <code>@username</code>. For private ones use the numeric chat ID (it starts with <code>-100</code> for supergroups and channels). Add <code>@RawDataBot</code> or <code>@getidsbot</code> to read it.</li>
          <li>CloudSeed checks the bot's real membership and permissions with Telegram when you add a destination, and again whenever you press <em>Recheck permissions</em>.</li>
        </ul>
      </details>
    </Section>
  );
}

// ------------------------------------------------------------------ transfers
function FileRow({ f }: { f: TgFile }) {
  return (
    <li className="space-y-1 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{f.name}</span>
        <span className="text-muted">{f.sendAs}{f.album ? ' · album' : ''}</span>
        <span className="w-16 text-right text-muted">{formatBytes(f.size)}</span>
        <span className={`w-16 text-right ${f.state === 'failed' ? 'text-danger' : f.state === 'sent' ? 'text-accent' : 'text-muted'}`}>{f.state === 'queued' && f.attempt > 0 ? 'retrying' : f.state}</span>
      </div>
      {f.state === 'uploading' && (
        <div className="h-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-label={`Upload progress for ${f.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={f.percent ?? 0}>
          <div className="h-full bg-accent" style={{ width: `${f.percent ?? 0}%` }} />
        </div>
      )}
      {f.error && <p className="flex items-start gap-1 text-danger"><AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />{f.error.message ?? f.error.code}{f.ambiguous ? ' (delivery unknown)' : ''}</p>}
      {f.link && <a className="text-accent hover:underline" href={f.link.url} target="_blank" rel="noreferrer">Open message{f.link.membersOnly ? ' (members only)' : ''}</a>}
    </li>
  );
}

function TransfersSection() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<TgTransfer | null>(null);
  const [error, setError] = useState('');
  const list = useQuery({
    queryKey: ['tg-transfers', q, state],
    queryFn: () => api<{ transfers: TgTransfer[]; nextCursor: string | null }>(`/telegram/transfers?limit=50${state ? `&state=${state}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  });
  const detail = useQuery({ queryKey: ['tg-transfer', open], enabled: !!open, queryFn: () => api<TgTransfer>(`/telegram/transfers/${open}`) });

  // Live updates over SSE; on every event refresh the list and the open detail.
  useEffect(() => {
    const es = new EventSource('/api/v1/telegram/transfers/events');
    const bump = () => { void qc.invalidateQueries({ queryKey: ['tg-transfers'] }); void qc.invalidateQueries({ queryKey: ['tg-transfer'] }); };
    es.addEventListener('transfer', bump); es.addEventListener('ready', bump);
    return () => es.close();
  }, [qc]);

  const act = useMutation({
    mutationFn: (a: { id: string; path: string; method?: string; body?: unknown }) => api(`/telegram/transfers/${a.id}${a.path}`, { method: a.method ?? 'POST', body: a.body ?? {} }),
    onSuccess: () => { setConfirm(null); setError(''); void qc.invalidateQueries({ queryKey: ['tg-transfers'] }); void qc.invalidateQueries({ queryKey: ['tg-transfer'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] }); },
    onError: (e) => setError(errText(e)),
  });
  const retry = (t: TgTransfer) => {
    const ambiguous = (detail.data?.id === t.id ? detail.data.files : undefined)?.some((f) => f.ambiguous);
    if (ambiguous) setConfirm(t); else act.mutate({ id: t.id, path: '/retry' });
  };

  return (
    <Section id="tr-h" title="Transfers" icon={<Send size={16} aria-hidden />}>
      <div className="mb-3 flex flex-wrap gap-2 text-sm">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search files, destinations, captions" aria-label="Search transfers"
          className="min-w-52 flex-1 rounded-md border border-line bg-bg px-3 py-2" />
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="Filter by status" className="rounded-md border border-line bg-bg px-2 py-2">
          <option value="">All</option>{(Object.keys(STATE_LABEL) as TgState[]).map((s) => <option key={s} value={s}>{STATE_LABEL[s]}</option>)}
        </select>
      </div>
      {error && <p role="alert" className="mb-2 text-sm text-danger">{error}</p>}
      {list.isPending ? <div className="animate-pulse space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="h-10 rounded bg-line/60" />)}</div>
        : list.error ? <p role="alert" className="text-danger">Failed to load transfers: {list.error.message}</p>
        : list.data.transfers.length === 0 ? <p className="py-6 text-center text-sm text-muted">{q || state ? 'No matching transfers.' : 'Nothing sent yet. Select files in My Files and choose “Send to Telegram”.'}</p>
        : (
          <ul className="divide-y divide-line">
            {list.data.transfers.map((t) => {
              const expanded = open === t.id;
              const finished = t.state === 'sent' || t.state === 'failed' || t.state === 'partial' || t.state === 'cancelled';
              return (
                <li key={t.id} className="py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <button className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : t.id)}>
                      {expanded ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                      <span className="min-w-0"><span className="block truncate font-medium">{t.firstFileName ?? 'Transfer'}{t.counts.total > 1 ? ` + ${t.counts.total - 1} more` : ''}</span>
                        <span className="block truncate text-xs text-muted">to {t.destination.title} · {formatBytes(t.totalBytes)} · {new Date(t.createdAt).toLocaleString()}</span></span>
                    </button>
                    <span className="text-xs text-muted">{t.counts.sent}/{t.counts.total} sent{t.counts.failed ? `, ${t.counts.failed} failed` : ''}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${STATE_STYLE[t.state]}`}>{STATE_LABEL[t.state]}</span>
                  </div>
                  {t.bot.status === 'invalid' && !finished && <p className="mt-1 flex items-center gap-1 text-xs text-danger"><AlertTriangle size={12} aria-hidden />Waiting: Telegram rejected the bot token. Rotate it to continue.</p>}
                  {expanded && (
                    <div className="mt-2 space-y-2">
                      {t.caption && <p className="text-xs text-muted">Caption: {t.caption}</p>}
                      {detail.data?.files ? <ul className="divide-y divide-line rounded-md border border-line">{detail.data.files.map((f) => <FileRow key={f.id} f={f} />)}</ul> : <p className="text-xs text-muted">Loading…</p>}
                      <div className="flex flex-wrap gap-2">
                        {(t.state === 'failed' || t.state === 'partial') && <button className={btnGhost} disabled={act.isPending} onClick={() => retry(t)}><RotateCcw size={14} className="mr-1 inline" aria-hidden />Retry failed files</button>}
                        {t.state === 'queued' || t.state === 'uploading' ? <button className={btnGhost} disabled={act.isPending} onClick={() => act.mutate({ id: t.id, path: '/cancel' })}>Cancel waiting files</button> : null}
                        {finished && <button className={btnGhost} disabled={act.isPending} onClick={() => act.mutate({ id: t.id, path: '/resend' })}><Send size={14} className="mr-1 inline" aria-hidden />Send again</button>}
                        {finished && <button className={btnGhost} disabled={act.isPending} onClick={() => act.mutate({ id: t.id, path: '', method: 'DELETE' })}><Trash2 size={14} className="mr-1 inline" aria-hidden />Remove</button>}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

      <Dialog open={confirm !== null} title="This may create duplicates" onClose={() => setConfirm(null)}>
        <p className="text-sm text-muted">The connection dropped after some files were sent, so it is unknown whether Telegram received them. Check the chat first. Sending again can post the same file twice.</p>
        {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2"><button className={btnGhost} onClick={() => setConfirm(null)}>Cancel</button>
          <button className={btnDanger} disabled={act.isPending} onClick={() => confirm && act.mutate({ id: confirm.id, path: '/retry', body: { confirmDuplicateRisk: true } })}>Send anyway</button></div>
      </Dialog>
    </Section>
  );
}

// ------------------------------------------------------------------ page
export function Telegram() {
  const status = useQuery({ queryKey: ['tg-status'], queryFn: () => api<TgStatus>('/telegram/status') });
  const bots = useQuery({ queryKey: ['tg-bots'], queryFn: () => api<{ bots: TgBot[] }>('/telegram/bots'), enabled: status.data?.enabled });
  const dests = useQuery({ queryKey: ['tg-destinations'], queryFn: () => api<{ destinations: TgDestination[] }>('/telegram/destinations'), enabled: status.data?.enabled });

  if (status.isPending) return <div className="animate-pulse space-y-3" aria-busy="true"><div className="h-24 rounded bg-line/60" /><div className="h-40 rounded bg-line/60" /></div>;
  if (status.error) return <p role="alert" className="text-danger">Failed to load: {status.error.message}</p>;
  if (!status.data.enabled) return <p className="rounded-md border border-line p-4 text-sm text-muted">The Telegram integration is disabled on this server (<code>TELEGRAM_ENABLED=false</code>).</p>;

  const l = status.data.limits;
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Telegram</h1>
        <p className="text-sm text-muted">
          {status.data.mode === 'hosted' ? 'Using the official Telegram Bot API' : 'Using your own Bot API server'}: files up to {formatBytes(l.uploadBytes)} each, photos up to {formatBytes(l.photoBytes)}.
          Larger files can be sent as numbered parts.
        </p>
      </div>
      {bots.error || dests.error ? <p role="alert" className="text-danger">Failed to load Telegram settings.</p> : (
        <>
          <BotsSection bots={bots.data?.bots ?? []} />
          <DestinationsSection bots={bots.data?.bots ?? []} dests={dests.data?.destinations ?? []} />
        </>
      )}
      <TransfersSection />
    </div>
  );
}
