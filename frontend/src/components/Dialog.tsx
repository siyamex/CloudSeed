import { useEffect, useRef, type ReactNode } from 'react';

/** Accessible modal built on the native <dialog> element (focus trap, Esc to close, inert background). */
export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="dlg-title"
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-6 text-fg backdrop:bg-black/50">
      {open && (<><h2 id="dlg-title" className="mb-3 text-lg font-semibold">{title}</h2>{children}</>)}
    </dialog>
  );
}

export const btn = 'rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50';
export const btnPrimary = `${btn} bg-accent text-accent-fg hover:opacity-90`;
export const btnGhost = `${btn} border border-line hover:bg-line/50`;
export const btnDanger = `${btn} bg-danger text-white hover:opacity-90`;
