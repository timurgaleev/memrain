import { useEffect, useState } from "react";
import { passkeyApi } from "../api";
import { CopyField } from "../components/CopyField.tsx";
import { RecoveryCodes } from "../components/RecoveryCodes.tsx";
import {
  enrollSourceValue,
  errorCodeOf,
  passkeyErrorCopy,
  pendingEnrollTokenValue,
  setEnrollSource,
  setPendingEnrollToken,
} from "../lib/passkey.ts";
import { failureCode, passkeysUsableHere, register } from "../lib/passkey-ceremony.ts";

type Step = "checking" | "unsupported" | "unconfigured" | "ready" | "codes";

// Opening the page spends nothing: the setup link is redeemed only when the
// person clicks "Create passkey", after the checks below have passed, so a
// link preview or an in-app browser cannot use it up.
export function EnrollPage({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>("checking");
  const [label, setLabel] = useState("This device");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [heldToken] = useState(pendingEnrollTokenValue);
  const source = enrollSourceValue();

  useEffect(() => {
    let live = true;
    passkeyApi.status()
      .then((r) => {
        if (!live) return;
        if (!(r.ok && r.body.available === true)) setStep("unconfigured");
        else setStep(passkeysUsableHere() ? "ready" : "unsupported");
      })
      .catch(() => { if (live) setStep("unconfigured"); });
    return () => { live = false; };
  }, []);

  const finish = () => {
    setEnrollSource(null);
    onDone();
  };

  const create = async () => {
    setError("");
    setBusy(true);
    try {
      const token = pendingEnrollTokenValue();
      if (token !== null) {
        const r = await passkeyApi.redeem(token);
        // Redeemed or refused, the token is done: a second redeem inside the
        // reservation is refused, and retries run on the grant cookie.
        setPendingEnrollToken(null);
        if (!r.ok) {
          setError(passkeyErrorCopy(errorCodeOf(r.status, r.body)));
          return;
        }
      }
      const opts = await passkeyApi.registerOptions();
      if (!opts.ok) {
        setError(passkeyErrorCopy(opts.status === 401 ? "no_grant" : errorCodeOf(opts.status, opts.body)));
        return;
      }
      const response = await register(opts.body.optionsJSON);
      const verified = await passkeyApi.registerVerify(response, label.trim() || "This device");
      if (!verified.ok) {
        const code = errorCodeOf(verified.status, verified.body);
        setError(passkeyErrorCopy(verified.status === 401 && code === "http_401" ? "no_grant" : code));
        return;
      }
      const issued = verified.body.recovery_codes;
      if (Array.isArray(issued) && issued.length > 0) {
        setCodes(issued);
        setStep("codes");
      } else {
        finish();
      }
    } catch (e) {
      setError(passkeyErrorCopy(failureCode(e)));
    } finally {
      setBusy(false);
    }
  };

  const linkForCopy = heldToken !== null
    ? `${window.location.origin}${window.location.pathname}#enroll/${heldToken}`
    : null;

  return (
    <div className="login-page">
      <div className="login-box enroll-box">
        <div className="login-logo">memrain</div>

        {step === "checking" && <div className="muted small">Checking this browser...</div>}

        {step === "unconfigured" && (
          <div className="notice">
            Passkey sign-in is not set up on this server yet. The operator needs to set MEMRAIN_PUBLIC_URL.
          </div>
        )}

        {step === "unsupported" && (
          <>
            <h1 className="enroll-title">Open this link in Safari or Chrome</h1>
            <p className="hint">
              This browser cannot create a passkey here. Open the link in Safari or Chrome on the device you want to use.
              Nothing has been used up yet.
            </p>
            {linkForCopy !== null && <CopyField value={linkForCopy} label="setup link" />}
          </>
        )}

        {step === "ready" && (
          <>
            <h1 className="enroll-title">Create your passkey</h1>
            {source === "recovery" && heldToken === null && (
              <div className="notice">
                Your recovery code was accepted. Create a new passkey to finish signing in.
                The code is used up once the passkey is created.
              </div>
            )}
            <p className="hint enroll-explainer">
              <strong>What is a passkey?</strong> A passkey replaces a password. It is stored on this device (or in your
              phone's or computer's password manager) and is unlocked with your fingerprint, face or screen lock.
              Nobody — including this server — ever sees it. You can add more devices later.
            </p>
            <label htmlFor="passkey-label">Name for this passkey</label>
            <input
              id="passkey-label"
              maxLength={64}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              style={{ marginBottom: 12 }}
            />
            <button className="btn btn-primary" style={{ width: "100%" }} onClick={create} disabled={busy}>
              {busy ? "Waiting for your device..." : "Create passkey"}
            </button>
            {error && <div className="login-error" role="alert">{error}</div>}
            <div className="login-hint">
              <a href="#login">Back to sign in</a>
            </div>
          </>
        )}

        {step === "codes" && (
          <RecoveryCodes codes={codes} onContinue={finish} continueLabel="Go to the dashboard" />
        )}
      </div>
    </div>
  );
}
