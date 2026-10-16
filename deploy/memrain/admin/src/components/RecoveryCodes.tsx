import { useCallback, useState } from "react";
import { copyText } from "../lib/clipboard.ts";
import { formatRecoveryCodes } from "../lib/passkey.ts";
import { Toast } from "./Toast.tsx";
import type { ToastSpec } from "./Toast.tsx";

// Shown once, right after the server issues a set. Only hashes are stored, so
// closing this without saving leaves "Regenerate" as the only way back.
export function RecoveryCodes({ codes, onContinue, continueLabel = "Continue" }: {
  codes: readonly string[];
  onContinue: () => void;
  continueLabel?: string;
}) {
  const [saved, setSaved] = useState(false);
  const [toast, setToast] = useState<ToastSpec | null>(null);
  const closeToast = useCallback(() => setToast(null), []);
  const text = formatRecoveryCodes(codes);

  const copyAll = async () => {
    setToast({ id: Date.now(), message: (await copyText(text)) ? "Codes copied" : "Copy failed — use Download instead" });
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "memrain-recovery-codes.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="recovery-codes">
      <div className="section-title" style={{ marginTop: 0 }}>Recovery codes</div>
      <p className="hint" style={{ marginTop: 0 }}>
        Each code works once. Use one if you lose access to all your passkeys. You will not be able to see these codes again.
      </p>
      <ol className="recovery-grid mono" aria-label="Recovery codes">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ol>
      <div className="filter-bar" style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={copyAll}>Copy all</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={download}>Download .txt</button>
      </div>
      <label className="checkbox-label" style={{ margin: "4px 0 16px" }}>
        <input type="checkbox" style={{ width: "auto" }} checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I saved these codes somewhere safe
      </label>
      <button type="button" className="btn btn-primary" style={{ width: "100%" }} disabled={!saved} onClick={onContinue}>
        {continueLabel}
      </button>
      <Toast toast={toast} onClose={closeToast} />
    </div>
  );
}
