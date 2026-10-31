import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Cloud, Download, Flag, Lock } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, api, formatBytes, setCsrf, type Me, type PublicShare as Share } from '../api';
import { btnGhost, btnPrimary } from '../components/Dialog';

/** The page behind a share link. It works without signing in (except for "signed-in users only" links). */
export function PublicShare() {
  const { token = '' } = useParams();
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(false);
  const [reason, setReason] = useState('illegal');
  const [details, setDetails] = useState('');
  const [reported, setReported] = useState(false);

  // If the visitor happens to be signed in, writes need the CSRF token.
  useQuery({ queryKey: ['me-public'], queryFn: async () => { const m = await api<Me>('/auth/me'); setCsrf(m.csrfToken); return m; }, retry: false });
  const info = useQuery({ queryKey: ['public-share', token], queryFn: () => api<Share>(`/public/shares/${token}`), retry: false });

  const err = info.error instanceof ApiError ? info.error : null;
  const unlock = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api(`/public/shares/${token}/unlock`, { method: 'POST', body: { password } }); setPassword(''); await qc.invalidateQueries({ queryKey: ['public-share', token] }); }
    catch (x) { setError(x instanceof ApiError ? x.message : 'Could not check the password'); }
    finally { setBusy(false); }
  };
  const sendReport = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api(`/public/shares/${token}/report`, { method: 'POST', body: { reason, details: details || undefined } }); setReported(true); setReport(false); }
    catch (x) { setError(x instanceof ApiError ? x.message : 'Could not send the report'); }
    finally { setBusy(false); }
  };

  const s = info.data;
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <main className="w-full max-w-md rounded-xl border border-line bg-surface p-8">
        <div className="mb-6 flex items-center gap-2 font-semibold"><Cloud className="text-accent" aria-hidden /> CloudSeed</div>

        {info.isPending && <p role="status" className="text-muted">Loading…</p>}

        {err && err.code === 'login_required' && (
          <div className="space-y-3">
            <h1 className="text-lg font-semibold">Sign in to open this link</h1>
            <p className="text-sm text-muted">This file was shared with CloudSeed users only.</p>
            <a className={`${btnPrimary} inline-block`} href={`/api/v1/auth/google/login?next=${encodeURIComponent(`/s/${token}`)}`}>Continue with Google</a>
          </div>
        )}
        {err && err.code !== 'login_required' && (
          <div role="alert" className="space-y-2">
            <h1 className="flex items-center gap-2 text-lg font-semibold"><AlertTriangle size={18} className="text-danger" aria-hidden />This link does not work</h1>
            <p className="text-sm text-muted">{err.message}.</p>
          </div>
        )}

        {s && (
          <div className="space-y-4">
            <div>
              <h1 className="break-words text-lg font-semibold">{s.name}</h1>
              <p className="text-sm text-muted">{formatBytes(s.size)} · available until {new Date(s.expiresAt).toLocaleString()}{s.downloadsLeft !== null ? ` · ${s.downloadsLeft} download${s.downloadsLeft === 1 ? '' : 's'} left` : ''}</p>
            </div>

            {s.passwordRequired && !s.unlocked ? (
              <form onSubmit={unlock} className="space-y-2">
                <label className="block text-sm"><span className="mb-1 flex items-center gap-1 text-muted"><Lock size={14} aria-hidden />This file is protected by a password</span>
                  <input type="password" autoFocus autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-md border border-line bg-bg px-3 py-2" /></label>
                <button type="submit" className={btnPrimary} disabled={busy || !password}>Unlock</button>
              </form>
            ) : (
              <a className={`${btnPrimary} inline-flex items-center gap-1`} href={`/api/v1/public/shares/${token}/download`}><Download size={14} aria-hidden />Download</a>
            )}
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}

            <p className="border-t border-line pt-3 text-xs text-muted">Someone shared this file with you through CloudSeed. CloudSeed has not checked it. Only open files from people you trust.</p>
            {reported ? <p role="status" className="text-xs text-muted">Thank you. The report was sent to the administrator.</p>
              : !report ? <button className="flex items-center gap-1 text-xs text-muted hover:underline" onClick={() => setReport(true)}><Flag size={12} aria-hidden />Report this file</button>
              : (
                <form onSubmit={sendReport} className="space-y-2 text-sm">
                  <label className="block"><span className="mb-1 block text-muted">What is wrong with it?</span>
                    <select value={reason} onChange={(e) => setReason(e.target.value)} className="rounded-md border border-line bg-bg px-2 py-2">
                      <option value="illegal">Illegal content</option><option value="malware">Malware or a scam</option><option value="copyright">Copyright</option><option value="privacy">Private information</option><option value="other">Something else</option></select></label>
                  <label className="block"><span className="sr-only">Details</span>
                    <textarea value={details} onChange={(e) => setDetails(e.target.value)} maxLength={2000} rows={3} placeholder="Details (optional)" className="w-full rounded-md border border-line bg-bg px-3 py-2" /></label>
                  <div className="flex gap-2"><button type="submit" className={btnPrimary} disabled={busy}>Send report</button><button type="button" className={btnGhost} onClick={() => setReport(false)}>Cancel</button></div>
                </form>
              )}
          </div>
        )}
      </main>
    </div>
  );
}
