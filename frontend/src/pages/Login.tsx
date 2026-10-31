import { useQuery } from '@tanstack/react-query';
import { Cloud, Moon, Sun } from 'lucide-react';
import { api } from '../api';

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

export function Login({ dark, toggleDark }: { dark: boolean; toggleDark: () => void }) {
  const cfg = useQuery({ queryKey: ['auth-config'], queryFn: () => api<{ googleConfigured: boolean; devLogin?: boolean }>('/auth/config') });
  const err = new URLSearchParams(location.search).get('auth_error');
  const configured = cfg.data?.googleConfigured;

  return (
    <div className="grid min-h-screen place-items-center p-4">
      <button onClick={toggleDark} aria-label="Toggle theme" className="fixed right-4 top-4 rounded-md p-2 text-muted hover:bg-line/50">
        {dark ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-8">
        <div className="mb-6 flex items-center gap-2 text-lg font-semibold"><Cloud className="text-accent" aria-hidden /> CloudSeed</div>
        <h1 className="mb-1 text-xl font-semibold">Sign in</h1>
        <p className="mb-6 text-sm text-muted">Your cloud downloader and file manager.</p>
        {err && <p role="alert" className="mb-4 rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{ERRORS[err] ?? 'Sign-in failed.'}</p>}
        {configured === false ? (
          <p role="status" className="rounded-md border border-line p-3 text-sm text-muted">
            Google sign-in is not configured. Set <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> and <code>GOOGLE_REDIRECT_URI</code>, then restart the API.
          </p>
        ) : (
          <a href="/api/v1/auth/google/login" aria-disabled={!configured}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-accent-fg hover:opacity-90">
            Continue with Google
          </a>
        )}
        {cfg.data?.devLogin && (
          <div className="mt-4 border-t border-line pt-4">
            <a href="/api/v1/auth/dev-login" className="flex w-full items-center justify-center rounded-md border border-line px-4 py-2.5 text-sm font-medium hover:bg-line/50">Sign in as the local test user</a>
            <p className="mt-2 text-xs text-muted">Development mode: this works only on the computer running the server and is never available in production.</p>
          </div>
        )}
      </div>
    </div>
  );
}
