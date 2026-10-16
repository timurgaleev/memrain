import { useCallback, useRef, useState } from "react";
import { copyText } from "../lib/clipboard.ts";
import { Toast } from "./Toast.tsx";
import type { ToastSpec } from "./Toast.tsx";

// A value with a Copy button. When the browser blocks the clipboard the value
// is selected instead, so the person can copy it by hand.
export function CopyField({ value, label, multiline = false }: { value: string; label: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<ToastSpec | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const closeToast = useCallback(() => setToast(null), []);

  const selectAll = () => {
    if (input.current) {
      input.current.focus();
      input.current.select();
    } else if (pre.current) {
      const range = document.createRange();
      range.selectNodeContents(pre.current);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  };

  const copy = async () => {
    if (await copyText(value)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      selectAll();
      setToast({ id: Date.now(), message: "Copy failed — select the text" });
    }
  };

  return (
    <div className={`copy-field${multiline ? " copy-field-multi" : ""}`}>
      {multiline ? (
        <pre ref={pre} className="copy-value mono" tabIndex={0} aria-label={label}>{value}</pre>
      ) : (
        <input ref={input} className="copy-value mono" readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
      )}
      <button type="button" className="btn btn-secondary btn-sm" onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? "Copied" : "Copy"}
      </button>
      <Toast toast={toast} onClose={closeToast} />
    </div>
  );
}
