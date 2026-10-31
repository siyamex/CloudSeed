import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Cloud, Moon, Sun } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ApiError, api, type AuthConfig } from '../api';
import { btnPrimary } from '../components/Dialog';

const ERRORS: Record<string, string> = {
  oauth_denied: 'Sign-in was cancelled or denied.',
  invalid_state: 'The sign-in attempt expired or was already used. Please try again.',
  oidc_failed: 'Google sign-in could not be verified. Please try again.',
  email_unverified: 'Your Google account email is not verified.',
  email_in_use: 'An account with this email already exists under a different Google identity, so it was not linked.',
  account_disabled: 'This account has been disabled. Contact the administrator.',
  registration_closed: 'Registration is closed. Ask the administrator for access.',
  oauth_not_configured: 'Google sign-in is not configured on this server.',
};
const input = 'w-full rounded-md border border-line bg-bg px-3 py-2 text-sm';

function Shell({ dark, toggleDark, children }: { dark: boolean; toggleDark: () => void; children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <button onClick={toggleDark} aria-label="Toggle theme" className="fixed right-4 top-4 rounded-md p-2 text-muted hover:bg-line/50">{dark ? <Sun size={18} /> : <Moon size={18} />}</button>
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-8">
        <div className="mb-6 flex items-center gap-2 text-lg font-semibold"><Cloud className="text-accent" aria-hidden /> CloudSeed</div>
        {children}
      </div>
    </div>
  );
}

/** Shown once, on a brand-new server: whoever completes it becomes the administrator. */
function Setup({ cfg }: { cfg: AuthConfig }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mismatch = pw2.length > 0 && pw !== pw2;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setBusy(true);
    try { await api('/auth/setup', { method: 'POST', body: { email, password: pw, displayName: name || undefined, setupCode: code || undefined } }); window.location.assign('/'); }
    catch (x) { setError(x instanceof ApiError ? x.message : 'Setup failed'); setBusy(false); }
  };
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Welcome. Let's set up your server</h1>
      <p className="mb-5 text-sm text-muted">Create the administrator account. You will use this email and password to sign in; you can add Google sign-in afterwards in the admin pages.</p>
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm">Your email<input className={`${input} mt-1`} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="block text-sm">Name (optional)<input className={`${input} mt-1`} autoComplete="name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label>
        <label className="block text-sm">Password<input className={`${input} mt-1`} type="password" autoComplete="new-password" required minLength={cfg.minPasswordLength} value={pw} onChange={(e) => setPw(e.target.value)} />
          <span className="mt-1 block text-xs text-muted">At least {cfg.minPasswordLength} characters. A few random words is a good password.</span></label>
        <label className="block text-sm">Repeat the password<input className={`${input} mt-1`} type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} aria-invalid={mismatch} />
          {mismatch && <span role="alert" className="mt-1 block text-xs text-danger">The two passwords are different.</span>}</label>
        {cfg.setupCodeRequired && (
          <label className="block text-sm">Setup code<input className={`${input} mt-1 font-mono uppercase`} required autoComplete="off" placeholder="XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} />
            <span className="mt-1 block text-xs text-muted">You are not on the same network as the server, so it needs proof that you own it. The code is printed in the server's log (Docker: <code>docker compose logs api</code>; CasaOS: open the app's log).</span></label>
        )}
        {!cfg.secureContext && <p className="flex gap-2 rounded-md border border-danger/30 bg-danger/5 p-2 text-xs text-danger"><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />This page is not using https, so the password you type can be read by anyone on the same network. Fine at home; for the internet, put https in front first.</p>}
        {error && <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</p>}
        <button className={`${btnPrimary} w-full py-2.5`} disabled={busy || mismatch || !email || pw.length < cfg.minPasswordLength}>{busy ? 'Creating…' : 'Create the administrator account'}</button>
      </form>
    </>
  );
}

export function Login({ dark, toggleDark }: { dark: boolean; toggleDark: () => void }) {
  const cfg = useQuery({ queryKey: ['auth-config'], queryFn: () => api<AuthConfig>('/auth/config') });
  const err = new URLSearchParams(location.search).get('auth_error');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (cfg.isPending) return <Shell dark={dark} toggleDark={toggleDark}><p role="status" className="text-sm text-muted">Loading…</p></Shell>;
  if (cfg.error) return <Shell dark={dark} toggleDark={toggleDark}><p role="alert" className="text-sm text-danger">Could not reach the server: {cfg.error.message}</p></Shell>;
  const c = cfg.data;
  if (c.needsSetup) return <Shell dark={dark} toggleDark={toggleDark}><Setup cfg={c} /></Shell>;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setBusy(true);
    try { await api('/auth/login', { method: 'POST', body: { email, password: pw } }); window.location.assign('/'); }
    catch (x) { setError(x instanceof ApiError ? x.message : 'Sign-in failed'); setBusy(false); }
  };
  const nothing = !c.localLogin && !c.googleConfigured && !c.devLogin;

  return (
    <Shell dark={dark} toggleDark={toggleDark}>
      <h1 className="mb-1 text-xl font-semibold">Sign in</h1>
      <p className="mb-5 text-sm text-muted">Your cloud downloader and file manager.</p>
      {err && <p role="alert" className="mb-4 rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{ERRORS[err] ?? 'Sign-in failed.'}</p>}

      {c.localLogin && (
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-sm">Email<input className={`${input} mt-1`} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="block text-sm">Password<input className={`${input} mt-1`} type="password" autoComplete="current-password" required value={pw} onChange={(e) => setPw(e.target.value)} /></label>
          {!c.secureContext && <p className="flex gap-2 text-xs text-muted"><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />This connection is not encrypted (http). Only sign in on a network you trust.</p>}
          {error && <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</p>}
          <button className={`${btnPrimary} w-full py-2.5`} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      )}

      {c.localLogin && c.googleConfigured && <div className="my-4 flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" /></div>}
      {c.googleConfigured && (
        <a href="/api/v1/auth/google/login" className="flex w-full items-center justify-center gap-2 rounded-md border border-line px-4 py-2.5 text-sm font-medium hover:bg-line/50">Continue with Google</a>
      )}
      {nothing && <p role="status" className="rounded-md border border-line p-3 text-sm text-muted">No way to sign in is set up yet. Ask the administrator.</p>}
      {c.devLogin && (
        <div className="mt-4 border-t border-line pt-4">
          <a href="/api/v1/auth/dev-login" className="flex w-full items-center justify-center rounded-md border border-line px-4 py-2.5 text-sm font-medium hover:bg-line/50">Sign in as the local test user</a>
          <p className="mt-2 text-xs text-muted">Development mode: this works only on the computer running the server and is never available in production.</p>
        </div>
      )}
    </Shell>
  );
}
