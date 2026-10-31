import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, api, formatBytes, type FileItem, type TgDestination, type TgPlan, type TgStatus } from '../api';
import { Dialog, btnGhost, btnPrimary } from './Dialog';

const SEND_AS: Record<string, string> = { document: 'File', photo: 'Photo', video: 'Video', audio: 'Audio', link: 'Link only' };

/** Review-and-confirm flow for sending selected files to a Telegram destination. */
export function SendToTelegram({ files, onClose }: { files: FileItem[]; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const status = useQuery({ queryKey: ['tg-status'], queryFn: () => api<TgStatus>('/telegram/status') });
  const dests = useQuery({ queryKey: ['tg-destinations'], queryFn: () => api<{ destinations: TgDestination[] }>('/telegram/destinations') });
  const usable = (dests.data?.destinations ?? []).filter((d) => d.canSend);

  const [destinationId, setDestinationId] = useState('');
  const [caption, setCaption] = useState('');
  const [method, setMethod] = useState<'auto' | 'document'>('auto');
  const [album, setAlbum] = useState(false);
  const [split, setSplit] = useState(false);
  const [asLink, setAsLink] = useState(false);
  const [linkHours, setLinkHours] = useState(168);
  const [linkLimit, setLinkLimit] = useState('');
  const [linkPassword, setLinkPassword] = useState('');
  const [linkOk, setLinkOk] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!destinationId && usable.length) setDestinationId((usable.find((d) => d.isDefault) ?? usable[0]!).id);
  }, [usable, destinationId]);

  const body = { destinationId, fileIds: files.map((f) => f.id), method, album, splitLargeFiles: split, caption: caption || null };
  const shareLink = asLink ? { expiresInHours: linkHours, maxDownloads: linkLimit ? Number(linkLimit) : null, password: linkPassword || null, confirmPublic: linkOk as true } : undefined;
  const planBody = { ...body, linkLargeFiles: asLink, shareLink: undefined };
  const sendBody = { ...body, linkLargeFiles: asLink, ...(shareLink ? { shareLink } : {}) };
  const plan = useQuery({
    queryKey: ['tg-plan', destinationId, files.map((f) => f.id).join(), method, album, split, asLink],
    queryFn: () => api<TgPlan>('/telegram/transfers/preview', { method: 'POST', body: planBody }),
    enabled: !!destinationId,
    retry: false,
  });
  const send = useMutation({
    mutationFn: () => api<{ id: string }>('/telegram/transfers', { method: 'POST', body: sendBody }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['tg-transfers'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] }); onClose(); navigate('/telegram'); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not start the transfer'),
  });

  const limits = status.data?.limits;
  const issues = plan.data?.issues ?? [];
  const oversize = issues.filter((i) => i.code === 'file_too_large');
  const tooLong = caption.length > (limits?.captionChars ?? 1024);
  const hasLinkItems = !!plan.data?.items.some((i) => i.sendAs === 'link');
  const linkReady = !hasLinkItems || (linkOk && (linkPassword.length === 0 || linkPassword.length >= 8));
  const canSubmit = !!plan.data && issues.length === 0 && !tooLong && !send.isPending && files.length <= (limits?.maxFiles ?? 100) && linkReady;

  return (
    <Dialog open title="Send to Telegram" onClose={onClose}>
      {status.data && !status.data.enabled ? (
        <p className="text-sm text-muted">The Telegram integration is disabled on this server.</p>
      ) : dests.isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : usable.length === 0 ? (
        <div className="space-y-3 text-sm">
          <p>{(dests.data?.destinations.length ?? 0) > 0 ? 'None of your Telegram destinations can currently receive files.' : 'No Telegram destination is set up yet.'}</p>
          <Link to="/telegram" onClick={onClose} className="text-accent hover:underline">Set up a bot and destination</Link>
          <div className="flex justify-end"><button className={btnGhost} onClick={onClose}>Close</button></div>
        </div>
      ) : (
        <form className="space-y-3 text-sm" onSubmit={(e) => { e.preventDefault(); setError(''); send.mutate(); }}>
          <label className="block"><span className="mb-1 block text-muted">Destination</span>
            <select value={destinationId} onChange={(e) => setDestinationId(e.target.value)} className="w-full rounded-md border border-line bg-bg px-2 py-2">
              {usable.map((d) => <option key={d.id} value={d.id}>{d.title} · {d.type} · via @{d.botUsername}</option>)}
            </select></label>

          <fieldset className="flex flex-wrap gap-4">
            <legend className="mb-1 text-muted">Send as</legend>
            <label className="flex items-center gap-1"><input type="radio" name="m" checked={method === 'auto'} onChange={() => setMethod('auto')} /> Best fit (photos, videos, audio)</label>
            <label className="flex items-center gap-1"><input type="radio" name="m" checked={method === 'document'} onChange={() => setMethod('document')} /> Files (original quality)</label>
          </fieldset>
          <label className="flex items-center gap-2"><input type="checkbox" checked={album} onChange={(e) => setAlbum(e.target.checked)} /> Group compatible items into albums</label>

          <label className="block"><span className="mb-1 block text-muted">Caption (optional, shown on the first message)</span>
            <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={2} className="w-full rounded-md border border-line bg-bg px-3 py-2" />
            <span className={`text-xs ${tooLong ? 'text-danger' : 'text-muted'}`}>{caption.length}/{limits?.captionChars ?? 1024}</span></label>

          {oversize.length > 0 && (
            <div className="rounded-md border border-danger/40 bg-danger/5 p-3" role="alert">
              <div className="mb-1 flex items-center gap-1 font-medium text-danger"><AlertTriangle size={14} aria-hidden /> Too large for Telegram</div>
              <ul className="list-disc pl-5 text-muted">{oversize.map((i) => <li key={i.fileId}>{i.message}</li>)}</ul>
              <label className="mt-2 flex items-start gap-2"><input type="checkbox" className="mt-1" checked={split} onChange={(e) => { setSplit(e.target.checked); if (e.target.checked) setAsLink(false); }} />
                <span>Send as numbered parts (<code>name.001</code>, <code>name.002</code>, …). Join them again with <code>cat</code> or <code>copy /b</code>. Nothing is truncated.</span></label>
              {status.data?.sharing.enabled && (
                <label className="mt-2 flex items-start gap-2"><input type="checkbox" className="mt-1" checked={asLink} onChange={(e) => { setAsLink(e.target.checked); if (e.target.checked) setSplit(false); }} />
                  <span>Send a download link instead. The file is <strong>not uploaded to Telegram</strong>: it stays on CloudSeed, and the message says so.</span></label>
              )}
            </div>
          )}
          {asLink && (
            <div className="space-y-2 rounded-md border border-line p-3">
              <div className="font-medium">Download link settings</div>
              <label className="block"><span className="mb-1 block text-muted">Link expires after</span>
                <select value={linkHours} onChange={(e) => setLinkHours(Number(e.target.value))} className="rounded-md border border-line bg-bg px-2 py-1.5">
                  {[[1, '1 hour'], [24, '24 hours'], [168, '7 days'], [720, '30 days']].filter(([h]) => (h as number) <= (status.data?.sharing.maxDays ?? 365) * 24).map(([h, l]) => <option key={h as number} value={h as number}>{l}</option>)}</select></label>
              <label className="block"><span className="mb-1 block text-muted">Download limit (optional)</span>
                <input type="number" min={1} value={linkLimit} onChange={(e) => setLinkLimit(e.target.value)} className="w-32 rounded-md border border-line bg-bg px-2 py-1.5" /></label>
              <label className="block"><span className="mb-1 block text-muted">Password (optional; share it with the group yourself)</span>
                <input type="password" autoComplete="new-password" value={linkPassword} onChange={(e) => setLinkPassword(e.target.value)} className="w-full rounded-md border border-line bg-bg px-2 py-1.5" /></label>
              <label className="flex items-start gap-2 text-danger"><input type="checkbox" className="mt-1" checked={linkOk} onChange={(e) => setLinkOk(e.target.checked)} />
                <span>I understand that everyone who can read this chat can use the link to download the file.</span></label>
            </div>
          )}
          {issues.filter((i) => i.code !== 'file_too_large').map((i) => <p key={i.fileId} role="alert" className="text-danger">{i.message}</p>)}
          {plan.error && <p role="alert" className="text-danger">{plan.error instanceof ApiError ? plan.error.message : 'Could not check these files'}</p>}

          {plan.data && plan.data.items.length > 0 && (
            <div>
              <div className="mb-1 text-muted">Review: {plan.data.items.length} item(s), {formatBytes(plan.data.totalBytes)}, {plan.data.messages} message(s)</div>
              <ul className="max-h-40 divide-y divide-line overflow-auto rounded-md border border-line">
                {plan.data.items.map((i, n) => (
                  <li key={n} className="flex items-center gap-2 px-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate">{i.name}</span>
                    <span className="shrink-0 text-xs text-muted">{SEND_AS[i.sendAs] ?? i.sendAs}{i.album ? ' · album' : ''}</span>
                    <span className="w-16 shrink-0 text-right text-muted">{formatBytes(i.size)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {error && <p role="alert" className="text-danger">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
            <button type="submit" className={btnPrimary} disabled={!canSubmit}><Send size={14} className="mr-1 inline" aria-hidden />{send.isPending ? 'Starting…' : 'Send'}</button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
