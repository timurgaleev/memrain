// A stand-in for the admin routes behind the Connections, Autonomy and
// Approvals pages. Each check sets `automation.state` to the scenario it
// needs; every POST lands in `automation.posts` for the check to assert on.

interface Account {
  id: string;
  source_id: string;
  provider: string;
  services: string[];
  account_label: string;
  status: string;
  status_reason: string | null;
  enabled: boolean;
  spend_cap_usd_daily: number;
  item_cap_daily: number;
  last_success_at: string | null;
  held_items: number;
  held_deletes: number;
  notices: Array<{ kind: string; detail: string; created_at: string }>;
  credential: { scopes: string[]; expires_at: string | null; granted_at: string } | null;
  last_run: Record<string, unknown> | null;
  needs_reconnect: boolean;
  grant_expiry: { granted_at: string; expires_at: string; days: number; state: string; due_soon: boolean } | null;
}

export interface Calendar { id: string; summary: string; primary: boolean; access_role: string; selected: boolean }

export interface AutomationState {
  connectors: {
    enabled: boolean;
    reason: string | null;
    kek_id: string | null;
    providers: Array<{ id: string; services: string[]; service_kinds: Record<string, string[]>; auth: string; callback_uri: string | null }>;
    sources: Array<{ id: string; kind: string }>;
    accounts: Account[];
    clients: Array<{ provider: string; client_id: string; updated_at: string }>;
  };
  failConnectors: number;
  calendars: { calendars: Calendar[]; history_days: number };
  daemons: unknown;
  pausedSpend: unknown[];
  holds: Array<Record<string, unknown>>;
}

export const OWNER = "owner@example.test";

export function account(over: Partial<Account> = {}): Account {
  return {
    id: "6f1c1f4e-3a2b-4c5d-8e9f-0a1b2c3d4e5f", source_id: "cal", provider: "google", services: ["calendar"],
    account_label: OWNER, status: "active", status_reason: null, enabled: true, spend_cap_usd_daily: 1, item_cap_daily: 5000,
    last_success_at: "2026-11-09T11:00:00Z", held_items: 0, held_deletes: 0, notices: [],
    credential: { scopes: ["https://www.googleapis.com/auth/calendar.readonly"], expires_at: null, granted_at: "2026-11-08T12:00:00.000Z" },
    last_run: { status: "success", stop_reason: null, at: "2026-11-09T11:00:00Z", http_status: null, error: null, items: 49, pages_written: 49, items_failed: 0 },
    needs_reconnect: false, grant_expiry: null, ...over,
  };
}

export function scenario(over: Partial<AutomationState["connectors"]> = {}): AutomationState {
  return {
    connectors: {
      enabled: true, reason: null, kek_id: "k1",
      providers: [{
        id: "google", services: ["calendar"], service_kinds: { calendar: ["calendar"] }, auth: "oauth",
        callback_uri: "https://brain.example.test/admin/connectors/callback/google",
      }],
      sources: [{ id: "default", kind: "other" }, { id: "cal", kind: "calendar" }],
      accounts: [account()],
      clients: [],
      ...over,
    },
    failConnectors: 0,
    calendars: {
      calendars: [
        { id: "primary-id@example.test", summary: OWNER, primary: true, access_role: "owner", selected: true },
        { id: "team@group.calendar.example.test", summary: "Team", primary: false, access_role: "reader", selected: false },
        { id: "holidays@group.calendar.example.test", summary: "Holidays", primary: false, access_role: "reader", selected: true },
      ],
      history_days: 90,
    },
    daemons: {
      scheduler: { enabled_here: true, leader: { holder: "brain-1:42", tick_age_s: 12, live: true } },
      paused_all: null,
      daemons: [
        { name: "briefing", kind: "brain", schedule: "0 7 * * *", lane: "slow", paid: false, enabled: true, env_disabled: false, paused: null,
          next_window: "2026-11-10", last_window: "2026-11-09", last_run_at: "2026-11-09T07:00:05Z", last_outcome: "succeeded", consecutive_failures: 0, sources: [] },
        { name: "connector_sync", kind: "brain", schedule: "*/15 * * * *", lane: "fast", paid: false, enabled: true, env_disabled: false,
          paused: { by: "operator", reason: "noisy", at: "2026-11-09T10:00:00Z" },
          next_window: null, last_window: null, last_run_at: null, last_outcome: null, consecutive_failures: 0, sources: [] },
      ],
    },
    pausedSpend: [],
    holds: [],
  };
}

export const automation = {
  state: scenario(),
  posts: [] as Array<{ path: string; body: Record<string, unknown> }>,
  reset(next: AutomationState) {
    this.state = next;
    this.posts = [];
  },
};

const OWNED = ["/admin/api/connectors", "/admin/api/daemons", "/admin/api/spend/", "/admin/api/write-gate/"];
const PREVIEW = { pages: 3, chunks: 9, facts: 2, timeline_events: 1, plan_hash: "0123456789abcdef" };

/** Answers an automation route, or null for a path it does not own. */
export async function automationRoute(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const st = automation.state;
  if (!OWNED.some((prefix) => path.startsWith(prefix))) return null;
  if (request.method === "GET") {
    if (path === "/admin/api/connectors") {
      if (st.failConnectors > 0) {
        st.failConnectors -= 1;
        return Response.json({ error: "temporarily unavailable" }, { status: 503 });
      }
      return Response.json(st.connectors);
    }
    if (/\/accounts\/[^/]+\/preview$/.test(path)) return Response.json(PREVIEW);
    if (/\/accounts\/[^/]+\/calendars$/.test(path)) return Response.json(st.calendars);
    if (path === "/admin/api/daemons") return Response.json(st.daemons);
    if (path === "/admin/api/spend/paused") return Response.json({ paths: st.pausedSpend });
    if (path === "/admin/api/write-gate/holds") return Response.json({ holds: st.holds });
    return null;
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  automation.posts.push({ path, body });
  const acct = /^\/admin\/api\/connectors\/accounts\/([^/]+)\/(.+)$/.exec(path);
  if (acct) {
    const a = st.connectors.accounts.find((x) => x.id === acct[1]);
    if (!a) return Response.json({ error: "account_not_found" }, { status: 404 });
    switch (acct[2]) {
      case "enable": case "disable":
        a.enabled = acct[2] === "enable";
        return Response.json({ ok: true, enabled: a.enabled });
      case "disconnect":
        if (body.confirm_label !== a.account_label) return Response.json({ error: "confirm_mismatch" }, { status: 400 });
        a.status = "revoked";
        a.enabled = false;
        return Response.json({ ok: true, revoked: true, credential_kept: false });
      case "delete-data":
        return Response.json({ ok: true, deleted: PREVIEW.pages, changed: 0 });
      case "deletions/confirm": {
        const confirmed = a.held_deletes;
        a.held_deletes = 0;
        return Response.json({ ok: true, confirmed });
      }
      case "deletions/reject": {
        const kept = a.held_deletes;
        a.held_deletes = 0;
        return Response.json({ ok: true, kept });
      }
      case "calendars": {
        const chosen = new Set(Array.isArray(body.calendars) ? body.calendars as string[] : []);
        st.calendars.calendars = st.calendars.calendars.map((c) => ({ ...c, selected: c.primary || chosen.has(c.id) }));
        if (typeof body.history_days === "number") st.calendars.history_days = body.history_days;
        return Response.json({ ok: true, calendars: [...chosen], history_days: st.calendars.history_days });
      }
      case "retry-held": {
        const retried = a.held_items;
        a.held_items = 0;
        return Response.json({ ok: true, retried });
      }
    }
  }
  if (/^\/admin\/api\/connectors\/[^/]+\/start$/.test(path)) {
    if (!st.connectors.enabled) return Response.json({ error: "connectors_disabled" }, { status: 403 });
    return Response.json({ authorize_url: "https://accounts.example.test/o/oauth2/auth?state=fixture", expires_at: "2026-11-09T12:10:00Z" });
  }
  if (/^\/admin\/api\/connectors\/[^/]+\/client$/.test(path)) return Response.json({ ok: true, client_id: body.client_id });
  if (/^\/admin\/api\/connectors\/[^/]+\/client\/delete$/.test(path)) return Response.json({ ok: true, deleted: true });
  if (path === "/admin/api/daemons/control") return Response.json({ ok: true, action: body.action, daemon: body.daemon, source_id: "*" });
  if (path === "/admin/api/spend/resume") {
    st.pausedSpend = [];
    return Response.json({ ok: true, resumed: true });
  }
  const decide = /^\/admin\/api\/write-gate\/holds\/(\d+)\/decide$/.exec(path);
  if (decide) {
    const hold = st.holds.find((h) => String(h.id) === decide[1]);
    if (!hold) return Response.json({ status: "not_found" }, { status: 404 });
    hold.decision = body.decision === "approve" ? "approved" : "rejected";
    return Response.json({ status: hold.decision });
  }
  return null;
}
