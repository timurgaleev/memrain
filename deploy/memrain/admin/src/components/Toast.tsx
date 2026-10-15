import { useEffect } from "react";

export interface ToastSpec {
  id: number;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

// One transient notice with an optional action (Undo). It dismisses itself
// after `timeoutMs`; the action also dismisses it.
export function Toast({ toast, onClose, timeoutMs = 5000 }: { toast: ToastSpec | null; onClose: () => void; timeoutMs?: number }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onClose, timeoutMs);
    return () => clearTimeout(t);
  }, [toast, onClose, timeoutMs]);
  if (!toast) return null;
  return (
    <div className="toast" role="status" aria-live="polite">
      <span>{toast.message}</span>
      {toast.actionLabel && toast.onAction && (
        <button className="toast-action" onClick={() => { toast.onAction?.(); onClose(); }}>{toast.actionLabel}</button>
      )}
      <button className="toast-close" aria-label="Dismiss" onClick={onClose}>×</button>
    </div>
  );
}
