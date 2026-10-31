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
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-6 text-fg">
      {open && (<><h2 id="dlg-title" className="mb-3 text-lg font-semibold">{title}</h2>{children}</>)}
    </dialog>
  );
}

export const btn = 'rounded-full px-4 py-1.5 text-sm font-medium transition duration-150 active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100';
/** Solid accent pill with a glossy top edge. */
export const btnPrimary = `${btn} bg-accent text-accent-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.4),0_8px_18px_-8px_color-mix(in_srgb,var(--accent)_75%,transparent)] hover:brightness-110`;
/** Clear glass pill. */
export const btnGhost = `${btn} border border-white/70 bg-white/45 text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] backdrop-blur-xl hover:bg-white/70 dark:border-white/12 dark:bg-white/8 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.14)] dark:hover:bg-white/14`;
export const btnDanger = `${btn} bg-danger text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3)] hover:brightness-110 dark:text-[#2a0a07]`;
