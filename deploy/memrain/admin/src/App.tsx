import { useState, useEffect, useCallback } from "react";
import { LoginPage } from "./pages/Login";
import { OverviewPage } from "./pages/Overview.tsx";
import { SearchPage } from "./pages/Search.tsx";
import { PagesPage } from "./pages/Pages.tsx";
import { PageViewPage } from "./pages/PageView.tsx";
import { EntityPage } from "./pages/Entity.tsx";
import { GraphPage } from "./pages/Graph.tsx";
import { TimelinePage } from "./pages/Timeline.tsx";
import { SpendPage } from "./pages/Spend.tsx";
import { AgentsPage } from "./pages/Agents";
import { RequestLogPage } from "./pages/RequestLog";
import { JobsWatchPage } from "./pages/JobsWatch";
import { CalibrationPage } from "./pages/Calibration";
import { GlossaryPage } from "./pages/Glossary.tsx";
import { SetupPage } from "./pages/Setup.tsx";
import { EnrollPage } from "./pages/Enroll.tsx";
import { SecurityPage } from "./pages/Security.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { api, passkeyApi } from "./api";
import type { AuthEvent } from "./api";
import { eventLabel, isPreAuthRoute, listOf, passkeyErrorCopy } from "./lib/passkey.ts";
import { buildHash, parseHash } from "./lib/route.ts";
import type { Route, RouteName } from "./lib/route.ts";

interface PendingResume {
  handle?: string;
  redirect_to: string | null;
  resource?: string | null;
  client_id?: string | null;
  client_name?: string | null;
  redirect_uri?: string | null;
  scope?: string | null;
}

const NAV: { section: string; items: { name: RouteName; label: string; also?: RouteName[] }[] }[] = [
  {
    section: "Brain",
    items: [
      { name: "overview", label: "Overview" },
      { name: "search", label: "Search" },
      { name: "pages", label: "Pages", also: ["page", "entity"] },
      { name: "graph", label: "Graph" },
      { name: "timeline", label: "Timeline" },
    ],
  },
  {
    section: "Operations",
    items: [
      { name: "spend", label: "Spend" },
      { name: "jobs", label: "Jobs" },
      { name: "log", label: "Request Log" },
      { name: "agents", label: "Agents" },
      { name: "calibration", label: "Calibration" },
    ],
  },
  {
    section: "Account",
    items: [
      { name: "security", label: "Security" },
    ],
  },
  {
    section: "Help",
    items: [
      { name: "setup", label: "Setup guide" },
      { name: "glossary", label: "Glossary" },
    ],
  },
];

function isTypingTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/** The origin a callback would deliver the code to — the part worth reading. */
function originOf(uri?: string | null): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).origin;
  } catch {
    return uri;
  }
}

function currentRoute(): Route {
  return parseHash(window.location.hash);
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" className="icon">
      <path d="M3 5.5h14M3 10h14M3 14.5h14" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" className="icon">
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="M12.3 12.3 17 17" />
    </svg>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(currentRoute);
  const page = route.name;
  const [pending, setPending] = useState<PendingResume | null>(null);
  const [pendingError, setPendingError] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notices, setNotices] = useState<AuthEvent[]>([]);
  const signedIn = !isPreAuthRoute(page);

  useEffect(() => {
    const onHash = () => {
      setRoute(currentRoute());
      setDrawerOpen(false);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (isPreAuthRoute(page)) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget(document.activeElement)) {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === "Escape") {
        setDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page]);

  const closePalette = useCallback(() => setPaletteOpen(false), []);

  // An OAuth connect that bounced here for sign-in leaves its /authorize target
  // parked server-side. It is never followed automatically — a cross-site page
  // can plant one — so it is shown as a confirmation naming who would receive
  // the credential.
  useEffect(() => {
    if (isPreAuthRoute(page)) return;
    api.pendingResume()
      .then((r: PendingResume) => { if (r?.redirect_to) setPending(r); })
      .catch(() => { /* not signed in — the panel appears after login */ });
  }, [page]);

  // Security notices (a passkey added, removed, or a copied one refused) are
  // read once per sign-in. passkeyFetch: a 401 or 503 here must not move the
  // page — pendingResume above already sends an expired session to sign-in.
  const loadNotices = useCallback(() => {
    passkeyApi.notices()
      .then((r) => setNotices(r.ok ? listOf<AuthEvent>(r.body, "notices") : []))
      .catch(() => setNotices([]));
  }, []);

  useEffect(() => {
    if (signedIn) loadNotices();
    else setNotices([]);
  }, [signedIn, loadNotices]);

  const ackNotices = async () => {
    await passkeyApi.ackNotices().catch(() => { /* refused rows stay listed */ });
    loadNotices();
  };

  const navigate = (name: RouteName) => {
    const r: Route = { name, param: null };
    window.location.hash = buildHash(r);
    setRoute(r);
  };

  if (page === "login") {
    return <LoginPage onLogin={() => navigate("overview")} />;
  }
  if (page === "enroll") {
    return <EnrollPage onDone={() => navigate("overview")} />;
  }

  // The click IS the consent: it mints a one-time approval bound to this
  // request, which /authorize demands on top of the session. The returned path
  // is server-validated to a local /authorize; the shape check keeps the
  // navigation same-origin regardless.
  const confirmResume = async () => {
    if (!pending?.handle) return;
    setPendingError("");
    try {
      // The handle names the request on screen: if the parked one changed since
      // it was rendered, the server refuses rather than approving the new one.
      const { redirect_to } = await api.approveResume(pending.handle) as { redirect_to?: string };
      if (redirect_to?.startsWith("/") && !redirect_to.startsWith("//")) window.location.assign(redirect_to);
      else setPendingError("The server returned no destination — start the connection again.");
    } catch (e) {
      // A refused approval must say so; the request it refused may still be
      // pending, so re-read it rather than leaving a stale panel on screen.
      setPendingError(e instanceof Error ? e.message : "Approval failed.");
      api.pendingResume()
        .then((r: PendingResume) => setPending(r?.redirect_to ? r : null))
        .catch(() => setPending(null));
    }
  };

  const dismissResume = async () => {
    setPending(null);
    setPendingError("");
    await api.dismissResume().catch(() => { /* the cookie expires on its own */ });
  };

  const handleSignOutEverywhere = async () => {
    if (!confirm("Sign out every active admin session, including other browsers and tabs? Each one will need to sign in again. Unused setup links are cancelled too.")) {
      return;
    }
    try {
      await api.signOutEverywhere();
    } catch (e) {
      // A passkey in its first 24 hours is refused and stays signed in.
      if (e instanceof Error && e.message === "cooldown") {
        alert(passkeyErrorCopy("cooldown"));
        return;
      }
      // otherwise push to login — the cookie is likely already invalid
    }
    navigate("login");
  };

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-btn" aria-label="Open navigation" aria-expanded={drawerOpen} aria-controls="sidebar" onClick={() => setDrawerOpen(true)}>
          <MenuIcon />
        </button>
        <a className="topbar-logo" href="#overview">memrain</a>
        <button className="icon-btn" aria-label="Search the brain" onClick={() => setPaletteOpen(true)}>
          <SearchIcon />
        </button>
      </header>
      {drawerOpen && <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} aria-hidden="true" />}
      <nav id="sidebar" className={`sidebar${drawerOpen ? " open" : ""}`} aria-label="Main">
        <div className="sidebar-logo">
          <span>memrain</span>
          <button className="kbd-hint" onClick={() => setPaletteOpen(true)} aria-label="Open the command palette" title="Jump to a page">
            <kbd>⌘K</kbd>
          </button>
        </div>
        {NAV.map((group) => (
          <div className="sidebar-nav" key={group.section}>
            <div className="nav-section">{group.section}</div>
            {group.items.map((item) => {
              const current = page === item.name || (item.also?.includes(page) ?? false);
              return (
                <a
                  key={item.name}
                  href={buildHash({ name: item.name, param: null })}
                  className={`nav-item ${current ? "active" : ""}`}
                  aria-current={current ? "page" : undefined}
                >
                  {item.label}
                </a>
              );
            })}
          </div>
        ))}
        <div style={{ marginTop: "auto", padding: "16px 12px", borderTop: "1px solid var(--border)" }}>
          <button
            onClick={handleSignOutEverywhere}
            className="btn btn-secondary"
            style={{ width: "100%", fontSize: 12 }}
            title="Revoke every active admin session — every browser, every tab"
          >
            Sign out everywhere
          </button>
        </div>
      </nav>
      <main className="main">
        {pending && (
          <div style={{
            background: "rgba(136, 170, 255, 0.08)",
            border: "1px solid rgba(136, 170, 255, 0.25)",
            borderRadius: 8,
            padding: "16px 18px",
            marginBottom: 20,
            fontSize: 13,
            lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              Send an authorization code to{" "}
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {originOf(pending.redirect_uri) || "an unregistered callback"}
              </span>?
            </div>
            <div style={{ color: "var(--text-secondary)" }}>
              {/* The callback leads, because that is who actually receives the
                  credential; the name is client-supplied and can be anything. */}
              Requested by <span style={{ fontFamily: "var(--font-mono)" }}>
                {(pending.client_name || pending.client_id || "unknown client").slice(0, 60)}
              </span>
              {pending.scope ? `, granting "${pending.scope}"` : ""}
              {pending.resource ? `, for audience ${pending.resource}` : ""}. Full callback:{" "}
              <span style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
                {pending.redirect_uri}
              </span>. Continue only if you started this.
            </div>
            {pendingError && (
              <div style={{ marginTop: 10, color: "#ff8888" }}>{pendingError}</div>
            )}
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button className="btn btn-primary" onClick={confirmResume}>Continue</button>
              <button className="btn btn-secondary" onClick={dismissResume}>Not now</button>
            </div>
          </div>
        )}
        {notices.length > 0 && (
          <div className="security-banner" role="status">
            {notices.map((n) => (
              <div key={String(n.id)}>
                {eventLabel(n.event)} on {new Date(n.at).toLocaleString()}. Not you?{" "}
                <a href="#security">Open Security.</a>
                {n.ackable === false && (
                  <span className="muted"> Only another of your devices or the operator can dismiss this.</span>
                )}
              </div>
            ))}
            {notices.some((n) => n.ackable !== false) && (
              <button className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={ackNotices}>
                It was me, dismiss
              </button>
            )}
          </div>
        )}
        {page === "overview" && <OverviewPage />}
        {page === "search" && <SearchPage query={route.param} />}
        {page === "pages" && <PagesPage />}
        {page === "page" && <PageViewPage slug={route.param} />}
        {page === "entity" && <EntityPage slug={route.param} />}
        {page === "graph" && <GraphPage slug={route.param} />}
        {page === "timeline" && <TimelinePage param={route.param} />}
        {page === "spend" && <SpendPage />}
        {page === "agents" && <AgentsPage />}
        {page === "log" && <RequestLogPage />}
        {page === "jobs" && <JobsWatchPage />}
        {page === "calibration" && <CalibrationPage />}
        {page === "glossary" && <GlossaryPage term={route.param} />}
        {page === "setup" && <SetupPage />}
        {page === "security" && <SecurityPage />}
      </main>
      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </div>
  );
}
