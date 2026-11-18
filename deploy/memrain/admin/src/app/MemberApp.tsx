import { useCallback, useEffect, useState } from "react";
import { startAuthentication, startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { ChatView } from "../chat/ChatView.tsx";
import { appApi, AppError, errorText, type Me } from "./api.ts";
import { parseAppHash, type AppRoute } from "./route.ts";
import { Wizard } from "./Wizard.tsx";
import { MyData } from "./MyData.tsx";

function useHashRoute(): AppRoute {
  const [route, setRoute] = useState(() => parseAppHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseAppHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

const passkeysHere = () => window.isSecureContext && browserSupportsWebAuthn();
const cancelled = (e: unknown) => e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError");

export function MemberApp({ inviteToken }: { inviteToken: string | null }) {
  const route = useHashRoute();
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setMe(await appApi.me());
    } catch {
      setMe(null);
    } finally {
      setChecked(true);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  if (route.name === "invite" && inviteToken) {
    return <InvitePage token={inviteToken} onDone={() => { window.location.hash = "#start"; void refresh(); }} />;
  }
  if (!checked) return <div className="login-page"><div className="login-box" aria-busy="true">Loading…</div></div>;
  if (!me || route.name === "login") {
    return <SignInPage onDone={() => { window.location.hash = "#start"; void refresh(); }} />;
  }

  const signOut = async () => {
    await appApi.logout().catch(() => undefined);
    setMe(null);
    window.location.hash = "#login";
  };
  const nav: Array<[AppRoute["name"], string]> = [["start", "Get started"], ["ask", "Ask"], ["data", "My data"]];
  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar-logo">memrain</span>
      </header>
      <nav className="sidebar" aria-label="Main">
        <div className="sidebar-logo"><span className="brand">memrain</span></div>
        <div className="sidebar-nav">
          {nav.map(([name, label]) => (
            <a key={name} href={`#${name}`} className={`nav-item ${route.name === name ? "active" : ""}`} aria-current={route.name === name ? "page" : undefined}>
              {label}
            </a>
          ))}
        </div>
        <div className="sidebar-nav">
          <div className="nav-section">{me.display_name ?? me.member_id}</div>
          <button className="btn btn-secondary btn-sm" onClick={signOut}>Sign out</button>
        </div>
      </nav>
      <main className="main">
        {!me.ready && <div className="notice" role="alert">{errorText(new AppError("member_not_ready", 409, {}))}</div>}
        {me.ready && route.name === "ask" && <ChatView threadId={route.param} />}
        {me.ready && route.name === "data" && <MyData />}
        {me.ready && route.name !== "ask" && route.name !== "data" && <Wizard />}
      </main>
    </div>
  );
}

function SignInPage({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const signIn = async () => {
    setError("");
    setBusy(true);
    try {
      const { optionsJSON } = await appApi.loginOptions();
      const response = await startAuthentication({ optionsJSON: optionsJSON as PublicKeyCredentialRequestOptionsJSON });
      await appApi.loginVerify(response);
      onDone();
    } catch (e) {
      setError(cancelled(e) ? "Sign-in was cancelled." : errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      <div className="login-box">
        <div className="login-logo">memrain</div>
        {passkeysHere() ? (
          <button className="btn btn-primary" style={{ width: "100%" }} onClick={signIn} disabled={busy}>
            {busy ? "Waiting for your passkey…" : "Sign in with a passkey"}
          </button>
        ) : (
          <div className="notice">This browser cannot use passkeys. Open your invite link here to get a session.</div>
        )}
        {error && <div className="login-error" role="alert">{error}</div>}
        <div className="login-hint">Uses your device's fingerprint, face or screen lock.</div>
        <div className="login-hint">First time here? Open the invite link you were sent.</div>
      </div>
    </div>
  );
}

function InvitePage({ token, onDone }: { token: string; onDone: () => void }) {
  const [who, setWho] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    appApi.inviteOpen(token)
      .then((r) => { if (live) setWho(r.member.display_name ?? r.member.id); })
      .catch((e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [token]);

  const createPasskey = async () => {
    setError("");
    setBusy(true);
    try {
      const { optionsJSON } = await appApi.inviteRegisterOptions(token);
      const response = await startRegistration({ optionsJSON: optionsJSON as PublicKeyCredentialCreationOptionsJSON });
      await appApi.inviteRegisterVerify(token, response, "This device");
      onDone();
    } catch (e) {
      setError(cancelled(e) ? "Creating the passkey was cancelled. Try again." : errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const withoutPasskey = async () => {
    setError("");
    setBusy(true);
    try {
      await appApi.inviteWithoutPasskey(token);
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-box">
        <div className="login-logo">memrain</div>
        <h1 className="enroll-title">{who ? `Welcome, ${who}` : "Welcome"}</h1>
        <p className="login-hint">Create a passkey on this device. You sign in with it from now on; there is no password.</p>
        <button className="btn btn-primary" style={{ width: "100%" }} onClick={createPasskey} disabled={busy || who === null || !passkeysHere()}>
          {busy ? "Waiting for your device…" : "Create a passkey"}
        </button>
        <button className="btn btn-link" onClick={withoutPasskey} disabled={busy || who === null}>
          This device has no passkey: continue for 7 days
        </button>
        {error && <div className="login-error" role="alert">{error}</div>}
      </div>
    </div>
  );
}
