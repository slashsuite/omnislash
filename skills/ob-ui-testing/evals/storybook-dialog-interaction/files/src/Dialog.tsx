import { useEffect, useRef } from "react";
export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (!d) return; if (open && !d.open) d.showModal(); if (!open && d.open) d.close(); }, [open]);
  return (
    <dialog ref={ref} aria-labelledby="dlg-title" onCancel={(e) => { e.preventDefault(); onClose(); }} className="rounded-xl bg-surface p-6 shadow-lg">
      <h2 id="dlg-title" className="text-lg font-semibold">{title}</h2>
      {children}
      <button type="button" onClick={onClose} className="mt-4 text-sm">Close</button>
    </dialog>
  );
}
