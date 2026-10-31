import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, Download, Film, Tv as TvIcon, Magnet, Link2, FolderOpen, Send, LayoutDashboard, LogOut, Menu, Moon, Settings as SettingsIcon, ShieldCheck, Sun, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ApiError, api, setCsrf, type Me } from './api';
import { NotificationBell } from './components/NotificationBell';
import { Admin } from './pages/Admin';
import { Dashboard } from './pages/Dashboard';
import { Downloads } from './pages/Downloads';
import { Archive } from './pages/Archive';
import { Files } from './pages/Files';
import { Login } from './pages/Login';
import { Media } from './pages/Media';
import { Player } from './pages/Player';
import { PublicShare } from './pages/PublicShare';
import { Settings } from './pages/Settings';
import { Shares } from './pages/Shares';
import { Telegram } from './pages/Telegram';
import { Torrents } from './pages/Torrents';
import { Trash } from './pages/Trash';
import { TvHome, TvPlayer } from './pages/Tv';

function useTheme() {
  const [dark, setDark] = useState(() => {
    try { return localStorage.getItem('theme') ? localStorage.getItem('theme') === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; }
    catch { return false; }
  });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch { /* storage unavailable */ }
  }, [dark]);
  return [dark, () => setDark((d) => !d), setDark] as const;
}

// Only features that exist are listed; the rest of the planned navigation appears as each is implemented.
const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/files', label: 'My Files', icon: FolderOpen, end: false },
  { to: '/media', label: 'Media Library', icon: Film, end: false },
  { to: '/tv', label: 'TV mode', icon: TvIcon, end: false },
  { to: '/downloads', label: 'Downloads', icon: Download, end: false },
  { to: '/torrents', label: 'Torrents', icon: Magnet, end: false },
  { to: '/telegram', label: 'Telegram', icon: Send, end: false },
  { to: '/shares', label: 'Shared Links', icon: Link2, end: false },
  { to: '/trash', label: 'Trash', icon: Trash2, end: false },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, end: false },
];
const ADMIN_NAV = { to: '/admin', label: 'Administration', icon: ShieldCheck, end: false };

const isSmartTv = () => /SMART-TV|SmartTV|Tizen|Web0S|WebOS|NetCast|HbbTV|AFTB|AFTM|AFTT|Android TV|BRAVIA|CrKey|Roku|VIDAA|Hisense|PHILIPSTV|GoogleTV/i.test(navigator.userAgent);
const tvOptOut = () => { try { return sessionStorage.getItem('tv-optout') === '1'; } catch { return false; } };

function AuthedApp() {
  const { pathname } = useLocation();
  const qc = useQueryClient();
  const [dark, toggleDark, setDark] = useTheme();
  const [menu, setMenu] = useState(false);
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => { const m = await api<Me>('/auth/me'); setCsrf(m.csrfToken); return m; },
  });

  // an explicit theme chosen in Settings follows the account to other devices; 'system' leaves this device's choice alone
  const serverTheme = me.data?.user.theme;
  useEffect(() => { if (serverTheme === 'dark') setDark(true); else if (serverTheme === 'light') setDark(false); }, [serverTheme, setDark]);

  if (me.isPending) return <div className="grid min-h-screen place-items-center text-muted" role="status">Loading…</div>;
  if (me.error instanceof ApiError && me.error.status === 401) return <Login dark={dark} toggleDark={toggleDark} />;
  if (me.error) return <div className="grid min-h-screen place-items-center p-6 text-danger" role="alert">Could not reach the server: {me.error.message}</div>;

  const user = me.data.user;
  // Smart-TV browsers get the big remote-friendly view automatically once per visit; "Normal view" there opts out.
  if (pathname.startsWith('/tv')) return <Routes><Route path="/tv" element={<TvHome />} /><Route path="/tv/:id" element={<TvPlayer />} /><Route path="*" element={<Navigate to="/tv" replace />} /></Routes>;
  if (pathname === '/' && isSmartTv() && !tvOptOut()) return <Navigate to="/tv" replace />;
  const logout = async () => { await api('/auth/logout', { method: 'POST' }); qc.clear(); await qc.invalidateQueries({ queryKey: ['me'] }); };

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-1 px-3">
      {[...NAV, ...(user.roles.includes('admin') ? [ADMIN_NAV] : [])].map(({ to, label, icon: Icon, end }) => (
        <NavLink key={to} to={to} end={end} onClick={() => setMenu(false)}
          className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition ${isActive ? 'border border-white/70 bg-white/55 font-medium text-accent shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_4px_14px_-6px_rgba(40,56,120,0.35)] dark:border-white/15 dark:bg-white/12 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]' : 'border border-transparent text-muted hover:bg-white/35 hover:text-fg dark:hover:bg-white/8'}`}>
          <Icon size={18} aria-hidden /> {label}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen md:grid md:grid-cols-[264px_1fr] md:gap-4 md:p-4">
      <aside className="hidden rounded-3xl border border-line bg-surface md:sticky md:top-4 md:block md:h-[calc(100vh-2rem)] md:overflow-y-auto">
        <div className="flex h-14 items-center gap-2 px-6 font-semibold"><Cloud size={20} className="text-accent" aria-hidden /> CloudSeed</div>
        {nav}
      </aside>

      {menu && (
        <div className="fixed inset-0 z-30 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button className="absolute inset-0 bg-black/40" aria-label="Close menu" onClick={() => setMenu(false)} />
          <div className="relative h-full w-64 bg-surface">
            <div className="flex h-14 items-center justify-between px-6 font-semibold">CloudSeed
              <button onClick={() => setMenu(false)} aria-label="Close menu"><X size={18} /></button></div>
            {nav}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-col md:gap-4">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-line bg-surface px-4 md:top-4 md:rounded-2xl md:border">
          <button className="md:hidden" onClick={() => setMenu(true)} aria-label="Open menu"><Menu size={20} /></button>
          <div className="hidden md:block" />
          <div className="flex items-center gap-3 text-sm">
            <NotificationBell />
            <button onClick={toggleDark} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} className="rounded-md p-2 text-muted hover:bg-line/50">
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <span className="hidden text-muted sm:inline">{user.displayName ?? user.email}</span>
            <button onClick={logout} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-muted hover:bg-line/50"><LogOut size={16} aria-hidden /> Sign out</button>
          </div>
        </header>
        {me.data.insecure && (
          <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger backdrop-blur-xl md:rounded-2xl md:border">
            <span>This server is using plain http: passwords and sign-in cookies can be read on the network. Fine at home; before opening it to the internet, add https.</span>
            <NavLink to="/admin?tab=signin" className="font-medium underline">Set the public address</NavLink>
          </div>
        )}
        <main className="min-w-0 flex-1 p-4 md:px-4 md:py-2">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/files" element={<Files />} />
            <Route path="/archive/:id" element={<Archive />} />
            <Route path="/media" element={<Media />} />
            <Route path="/media/:id" element={<Player />} />
            <Route path="/downloads" element={<Downloads />} />
            <Route path="/torrents" element={<Torrents />} />
            <Route path="/telegram" element={<Telegram />} />
            <Route path="/shares" element={<Shares />} />
            <Route path="/trash" element={<Trash />} />
            <Route path="/settings" element={<Settings me={user} />} />
            {user.roles.includes('admin') && <Route path="/admin" element={<Admin selfId={user.id} />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

/** Public share pages must work without signing in, so they sit outside the login gate. */
export function App() {
  const { pathname } = useLocation();
  const m = /^\/s\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  if (m) return <Routes><Route path="/s/:token" element={<PublicShare />} /></Routes>;
  return <AuthedApp />;
}
