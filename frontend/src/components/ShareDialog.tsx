import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, type FileItem, type ShareItem } from '../api';
import { Dialog, btnGhost, btnPrimary } from './Dialog';

const LIFETIMES: [string, number][] = [['1 hour', 1], ['24 hours', 24], ['7 days', 168], ['30 days', 720], ['90 days', 2160]];
type Created = ShareItem & { token: string; url: string };

/** Creates a share link. The link itself is shown once: the server keeps only a hash of it. */
export function ShareDialog({ file, kind = 'file', maxDays, onClose, onChanged }: { file: Pick<FileItem, 'id' | 'name' | 'sharingDisabled'>; kind?: 'file' | 'folder'; maxDays: number; onClose: () => void; onChanged: () => void }) {
  const noun = kind === 'folder' ? 'folder' : 'file';
  const qc = useQueryClient();
  const [mode, setMode] = useState<'public' | 'private'>('public');
  const [hours, setHours] = useState(168);
  const [limit, setLimit] = useState('');
  const [password, setPassword] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useMutation({
    mutationFn: () => api<Created>('/shares', { method: 'POST', body: {
      ...(kind === 'folder' ? { folderId: file.id } : { fileId: file.id }), expiresInHours: hours, mode, acknowledgePublic: mode === 'public' ? ack : undefined,
      maxDownloads: limit ? Number(limit) : null, password: password || null,
    } }),
    onSuccess: (c) => { setCreated(c); void qc.invalidateQueries({ queryKey: ['shares'] }); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not create the link'),
  });
  const setSharing = useMutation({
    mutationFn: (disabled: boolean) => api(`/files/${file.id}`, { method: 'PATCH', body: { sharingDisabled: disabled } }),
    onSuccess: () => { onChanged(); void qc.invalidateQueries({ queryKey: ['shares'] }); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not change sharing'),
  });
  const lifetimes = LIFETIMES.filter(([, h]) => h <= maxDays * 24);

  if (created) {
    return (
      <Dialog open title="Link created" onClose={onClose}>
        <div className="space-y-3 text-sm">
          <p className="flex items-start gap-2 text-danger"><AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />Copy it now. For security CloudSeed does not keep the link, so it cannot be shown again. You can revoke it any time, or create a new one.</p>
          <div className="flex gap-2">
            <input readOnly value={created.url} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" className="min-w-0 flex-1 rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs" />
            <button className={btnPrimary} onClick={() => { void navigator.clipboard?.writeText(created.url).then(() => setCopied(true)).catch(() => undefined); }}>
              {copied ? <><Check size={14} className="mr-1 inline" aria-hidden />Copied</> : <><Copy size={14} className="mr-1 inline" aria-hidden />Copy</>}</button>
          </div>
          <p className="text-muted">{created.mode === 'public' ? `Anyone with this link can ${kind === 'folder' ? 'browse and download this folder' : 'download the file'}` : 'Only people signed in to this CloudSeed can open it'}{created.passwordProtected ? ', after entering the password' : ''}, until {new Date(created.expiresAt).toLocaleString()}{created.maxDownloads ? ` or ${created.maxDownloads} download(s)` : ''}.</p>
          <div className="flex justify-end"><button className={btnGhost} onClick={onClose}>Done</button></div>
        </div>
      </Dialog>
    );
  }

  if (kind === 'file' && file.sharingDisabled) {
    return (
      <Dialog open title="Sharing is off for this file" onClose={onClose}>
        <p className="text-sm text-muted">“{file.name}” cannot be shared and has no active links.</p>
        {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2"><button className={btnGhost} onClick={onClose}>Close</button>
          <button className={btnPrimary} disabled={setSharing.isPending} onClick={() => setSharing.mutate(false)}>Allow sharing</button></div>
      </Dialog>
    );
  }

  return (
    <Dialog open title={`Share “${file.name}”`} onClose={onClose}>
      <form className="space-y-3 text-sm" onSubmit={(e) => { e.preventDefault(); setError(''); create.mutate(); }}>
        <fieldset className="space-y-1">
          <legend className="mb-1 text-muted">Who can open it</legend>
          <label className="flex items-start gap-2"><input type="radio" name="mode" className="mt-1" checked={mode === 'public'} onChange={() => setMode('public')} /><span><strong>Anyone with the link</strong>: no sign-in needed</span></label>
          <label className="flex items-start gap-2"><input type="radio" name="mode" className="mt-1" checked={mode === 'private'} onChange={() => setMode('private')} /><span><strong>Signed-in CloudSeed users only</strong></span></label>
        </fieldset>
        {mode === 'public' && (
          <label className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/5 p-2"><input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>I understand that anyone who gets this link can download {kind === 'folder' ? 'everything in this folder, including files added later' : 'the file'}. A public link is not private.</span></label>
        )}
        <label className="block"><span className="mb-1 block text-muted">Expires after</span>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="rounded-md border border-line bg-bg px-2 py-2">
            {lifetimes.map(([l, h]) => <option key={h} value={h}>{l}</option>)}</select></label>
        <label className="block"><span className="mb-1 block text-muted">Download limit (optional)</span>
          <input type="number" min={1} max={1000000} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Unlimited until it expires" className="w-full rounded-md border border-line bg-bg px-3 py-2" /></label>
        <label className="block"><span className="mb-1 block text-muted">Password (optional, at least 8 characters)</span>
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-md border border-line bg-bg px-3 py-2" /></label>
        {error && <p role="alert" className="text-danger">{error}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          {kind === 'file' ? <button type="button" className="text-xs text-muted hover:underline" onClick={() => setSharing.mutate(true)}>Never allow sharing this file</button> : <span className="text-xs text-muted">Files with sharing turned off are left out.</span>}
          <span className="flex gap-2"><button type="button" className={btnGhost} onClick={onClose}>Cancel</button>
            <button type="submit" className={btnPrimary} disabled={create.isPending || (mode === 'public' && !ack) || (password.length > 0 && password.length < 8)}>{create.isPending ? 'Creating…' : 'Create link'}</button></span>
        </div>
      </form>
    </Dialog>
  );
}
