import React, { useEffect, useState } from "react";
import { api, passkeyApi } from "../api";
import { errorCodeOf, normalizeRecoveryInput, passkeyErrorCopy, setEnrollSource } from "../lib/passkey.ts";
import { authenticate, failureCode, passkeysUsableHere } from "../lib/passkey-ceremony.ts";

type PasskeyState = "checking" | "ready" | "unconfigured" | "unsupported";

// Trust model: the bootstrap token is NEVER stored in browser JS state (no
// localStorage/sessionStorage, no React state past the submit). After a
// successful POST /admin/login it lives only in the HttpOnly cookie the server
// sets. Magic-link URLs use single-use server nonces, not the token itself.
export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [passkey, setPasskey] = useState<PasskeyState>("checking");
  const [passkeyError, setPasskeyError] = useState("");
  const [signingIn, setSigningIn] = useState(false);

  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);

  useEffect(() => {
    let live = true;
    passkeyApi.status()
      .then((r) => {
        if (!live) return;
        if (r.ok && r.body.available === true) setPasskey(passkeysUsableHere() ? "ready" : "unsupported");
        else setPasskey("unconfigured");
      })
      .catch(() => { if (live) setPasskey("unconfigured"); });
    return () => { live = false; };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.login(token);
      setToken(""); // don't persist — the cookie is the session now
      onLogin();
    } catch {
      setError("Invalid token.");
    } finally {
      setLoading(false);
    }
  };

  const signInWithPasskey = async () => {
    setPasskeyError("");
    setSigningIn(true);
    try {
      const opts = await passkeyApi.loginOptions();
      if (!opts.ok) throw new Error(errorCodeOf(opts.status, opts.body));
      const response = await authenticate(opts.body.optionsJSON);
      const verified = await passkeyApi.loginVerify(response);
      if (!verified.ok) throw new Error(errorCodeOf(verified.status, verified.body));
      onLogin();
    } catch (e) {
      const c = failureCode(e);
      const code = c === "unknown" && e instanceof Error ? e.message : c;
      setPasskeyError(passkeyErrorCopy(code === "cancelled" ? "login_cancelled" : code));
    } finally {
      setSigningIn(false);
    }
  };

  const useRecoveryCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setCodeError("");
    const normalized = normalizeRecoveryInput(code);
    if (normalized === "") return;
    setCodeBusy(true);
    try {
      const r = await passkeyApi.recovery(normalized);
      if (!r.ok) {
        setCodeError(passkeyErrorCopy(errorCodeOf(r.status, r.body)));
        return;
      }
      setCode("");
      setEnrollSource("recovery");
      window.location.hash = "#enroll";
    } catch {
      setCodeError(passkeyErrorCopy("network"));
    } finally {
      setCodeBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-box">
        <div className="login-logo">memrain</div>

        {passkey === "ready" && (
          <div style={{ marginBottom: 20 }}>
            <button className="btn btn-primary" style={{ width: "100%" }} onClick={signInWithPasskey} disabled={signingIn}>
              {signingIn ? "Waiting for your passkey..." : "Sign in with passkey"}
            </button>
            {passkeyError && <div className="login-error" role="alert">{passkeyError}</div>}
            <div className="login-hint">Uses your device's fingerprint, face or screen lock. Nothing to type.</div>
            <div className="login-hint" style={{ marginTop: 4 }}>First time here? Open the setup link your operator sent you.</div>
          </div>
        )}
        {passkey === "unconfigured" && (
          <div className="notice" style={{ marginBottom: 20 }}>
            Passkey sign-in is not set up on this server yet. The operator needs to set MEMRAIN_PUBLIC_URL.
          </div>
        )}
        {passkey === "unsupported" && (
          <div className="notice" style={{ marginBottom: 20 }}>
            This browser cannot use passkeys here. Open this page in Safari or Chrome over https, or use the options below.
          </div>
        )}

        {passkey !== "unconfigured" && (
          <details style={{ marginBottom: 16 }}>
            <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text-muted)" }}>
              Use a recovery code
            </summary>
            <form onSubmit={useRecoveryCode} style={{ marginTop: 12 }}>
              <div style={{ marginBottom: 12 }}>
                <input
                  className="mono"
                  aria-label="Recovery code"
                  placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={40}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </div>
              <button className="btn btn-secondary" style={{ width: "100%", justifyContent: "center" }} disabled={codeBusy || code.trim() === ""}>
                {codeBusy ? "Checking..." : "Continue"}
              </button>
              {codeError && <div className="login-error" role="alert">{codeError}</div>}
              <div className="login-hint">You will create a new passkey next. The code is used up once the passkey is created.</div>
            </form>
          </details>
        )}

        <details style={{ marginBottom: 16 }} open={passkey === "unconfigured" || undefined}>
          <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text-muted)" }}>
            Operator access
          </summary>
          <div style={{ marginTop: 12 }}>
            <div style={{
              background: "rgba(136, 170, 255, 0.08)",
              border: "1px solid rgba(136, 170, 255, 0.2)",
              borderRadius: 8,
              padding: "14px 16px",
              marginBottom: 20,
              fontSize: 13,
              lineHeight: 1.5,
              color: "var(--text-secondary)",
            }}>
              <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>
                🔒 This is a protected dashboard
              </div>
              Ask your AI agent for the admin login link:
              <div style={{
                background: "rgba(0,0,0,0.3)",
                borderRadius: 6,
                padding: "8px 12px",
                marginTop: 8,
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: "#88aaff",
                wordBreak: "break-all",
              }}>
                "Give me the memrain admin login link"
              </div>
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-muted)" }}>
                Each link is single-use. Your agent generates a fresh one each time.
              </div>
            </div>

            <details style={{ marginBottom: 16 }}>
              <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text-muted)" }}>
                Or paste bootstrap token manually
              </summary>
              <form onSubmit={handleSubmit} style={{ marginTop: 12 }}>
                <div style={{ marginBottom: 12 }}>
                  <input
                    type="password"
                    placeholder="Admin Token"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                </div>
                <button className="btn btn-primary" style={{ width: "100%" }} disabled={loading}>
                  {loading ? "Authenticating..." : "Submit"}
                </button>
                {error && <div className="login-error">{error}</div>}
              </form>
            </details>
          </div>
        </details>
      </div>
    </div>
  );
}
