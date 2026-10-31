import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Check, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type NotificationItem } from '../api';

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};

export function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const count = useQuery({ queryKey: ['notif-count'], queryFn: () => api<{ unread: number }>('/notifications/unread-count'), refetchInterval: 30_000, refetchOnWindowFocus: true });
  const list = useQuery({ queryKey: ['notifs'], queryFn: () => api<{ items: NotificationItem[] }>('/notifications?limit=15'), enabled: open });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['notif-count'] }); void qc.invalidateQueries({ queryKey: ['notifs'] }); };
  const readAll = useMutation({ mutationFn: () => api('/notifications/read-all', { method: 'POST', body: {} }), onSuccess: refresh });
  const readOne = useMutation({ mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'POST', body: {} }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api(`/notifications/${id}`, { method: 'DELETE' }), onSuccess: refresh });

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const unread = count.data?.unread ?? 0;
  return (
    <div className="relative" ref={box}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="true"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} className="relative rounded-md p-2 text-muted hover:bg-line/50">
        <Bell size={18} aria-hidden />
        {unread > 0 && <span className="absolute right-0.5 top-0.5 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div role="region" aria-label="Notifications" className="fixed inset-x-2 top-14 z-40 max-h-[70vh] overflow-auto rounded-lg border border-line bg-surface shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-1 sm:w-96">
          <div className="flex items-center justify-between border-b border-line px-4 py-2">
            <h2 className="text-sm font-semibold">Notifications</h2>
            <button className="flex items-center gap-1 text-xs text-accent hover:underline disabled:opacity-50" disabled={unread === 0 || readAll.isPending} onClick={() => readAll.mutate()}><Check size={12} aria-hidden />Mark all read</button>
          </div>
          {list.isPending ? <p className="p-4 text-sm text-muted">Loading…</p>
            : list.error ? <p role="alert" className="p-4 text-sm text-danger">Could not load notifications.</p>
            : list.data.items.length === 0 ? <p className="p-6 text-center text-sm text-muted">Nothing here yet.</p> : (
              <ul className="divide-y divide-line">
                {list.data.items.map((n) => (
                  <li key={n.id} className={`flex gap-2 px-4 py-3 text-sm ${n.read ? '' : 'bg-accent/5'}`}>
                    <button className="min-w-0 flex-1 text-left" onClick={() => !n.read && readOne.mutate(n.id)} aria-label={`${n.title}${n.read ? '' : ' (unread, click to mark as read)'}`}>
                      <span className={`block ${n.read ? 'text-muted' : 'font-medium'}`}>{n.title}</span>
                      {n.body && <span className="mt-0.5 block break-words text-xs text-muted">{n.body}</span>}
                      <span className="mt-1 block text-xs text-muted">{ago(n.createdAt)}</span>
                    </button>
                    <button onClick={() => remove.mutate(n.id)} aria-label={`Delete notification: ${n.title}`} className="h-fit rounded p-1 text-muted hover:bg-line/50"><X size={14} aria-hidden /></button>
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}
    </div>
  );
}
