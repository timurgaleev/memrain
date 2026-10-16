import { normalizeToolResponse, ToolError } from "./lib/tool-result.ts";
import { expectOk, passkeyFetch, ApiError } from "./lib/passkey-fetch.ts";

const BASE = "";

// Trust model: the admin UI does NOT cache the bootstrap token in browser JS
// state. On 401, redirect to login — no auto-reauth, no localStorage. The
// HttpOnly cookie set by /admin/login is the only session credential.
async function apiFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (res.status === 401) {
    window.location.hash = "#login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

// Explorer reads go through the allowlisted tool route. The route answers
// {ok:true,data} or {ok:false,error,...}; normalizeToolResponse turns the
// latter into a ToolError so callers handle one failure type.
export async function tool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${BASE}/admin/api/tool`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, arguments: args }),
    ...(signal ? { signal } : {}),
  });
  const body: unknown = await res.json().catch(() => ({}));
  try {
    return normalizeToolResponse(res.status, body);
  } catch (e) {
    if (e instanceof ToolError && e.code === "unauthorized") window.location.hash = "#login";
    throw e;
  }
}

// memrain A2 endpoints (http/admin-api.ts). Separate stats/health/oauth-client
// endpoints collapse onto memrain's full-stats + credentials surface; the
// feed/calibration endpoints (B3) are added with their pages.
export const api = {
  login: (token: string) => apiFetch("/admin/login", { method: "POST", body: JSON.stringify({ token }) }),
  signOutEverywhere: () => apiFetch("/admin/api/sign-out-everywhere", { method: "POST" }),
  pendingResume: () => apiFetch("/admin/api/pending-resume"),
  approveResume: (handle: string) =>
    apiFetch("/admin/api/approve-resume", { method: "POST", body: JSON.stringify({ handle }) }),
  dismissResume: () => apiFetch("/admin/api/dismiss-resume", { method: "POST" }),
  // The corpus counts scan whole tables; the 30 s health poll leaves them out.
  fullStats: (counts = true) => apiFetch(counts ? "/admin/api/full-stats" : "/admin/api/full-stats?counts=0"),
  agents: () => apiFetch("/admin/api/agents"),
  mintApiKey: (name: string) =>
    apiFetch("/admin/api/api-keys", { method: "POST", body: JSON.stringify({ name }) }),
  revokeApiKey: (name: string) =>
    apiFetch("/admin/api/api-keys/revoke", { method: "POST", body: JSON.stringify({ name }) }),
  registerClient: (payload: Record<string, unknown>) =>
    apiFetch("/admin/api/register-client", { method: "POST", body: JSON.stringify(payload) }),
  updateClientTtl: (client_id: string, token_ttl: number | null) =>
    apiFetch("/admin/api/update-client-ttl", { method: "POST", body: JSON.stringify({ client_id, token_ttl }) }),
  rescopeClient: (client_id: string, source: string, read?: string[]) =>
    apiFetch("/admin/api/rescope-client", { method: "POST", body: JSON.stringify({ client_id, source, ...(read ? { read } : {}) }) }),
  revokeClient: (client_id: string) =>
    apiFetch("/admin/api/revoke-client", { method: "POST", body: JSON.stringify({ client_id }) }),
  setRedirectUris: (client_id: string, redirect_uris: string[], expected_revision?: number) =>
    apiFetch("/admin/api/set-redirect-uris", {
      method: "POST",
      body: JSON.stringify({ client_id, redirect_uris, ...(expected_revision !== undefined ? { expected_revision } : {}) }),
    }),
  enrollments: (client_id: string) =>
    apiFetch(`/admin/api/enrollments?client_id=${encodeURIComponent(client_id)}`),
  issueEnrollment: (payload: Record<string, unknown>) =>
    apiFetch("/admin/api/enrollments", { method: "POST", body: JSON.stringify(payload) }),
  revokeEnrollment: (id: string) =>
    apiFetch("/admin/api/revoke-enrollment", { method: "POST", body: JSON.stringify({ id }) }),
  revokeGrant: (id: string) =>
    apiFetch("/admin/api/revoke-grant", { method: "POST", body: JSON.stringify({ id }) }),
  requests: (page = 1, agent?: string) =>
    apiFetch(`/admin/api/requests?page=${page}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`),
  // /health answers 503 with {ok:false} while degraded; that body is still
  // what the status strip shows.
  health: () =>
    fetch(`${BASE}/health`, { credentials: "same-origin" }).then(async (r) => {
      const body = await r.json().catch(() => null);
      if (body === null || typeof body !== "object") throw new Error(`HTTP ${r.status}`);
      return body;
    }),
  stats: () => apiFetch("/admin/api/stats"),
  healthIndicators: () => apiFetch("/admin/api/health-indicators"),
  spendReport: (days: number) => apiFetch(`/admin/api/spend/report?days=${days}`),
  agentsSpend: () => apiFetch("/admin/api/agents/spend"),
  jobsWatch: () => apiFetch("/admin/api/jobs/watch"),
  calibrationProfile: () => apiFetch("/admin/api/calibration/profile"),
  timeseries: (days: number, signal?: AbortSignal) => apiFetch(`/admin/api/timeseries?days=${days}`, signal ? { signal } : undefined),
  graphHubs: (limit = 20, signal?: AbortSignal) => apiFetch(`/admin/api/graph/hubs?limit=${limit}`, signal ? { signal } : undefined),
  onboarding: (signal?: AbortSignal) => apiFetch("/admin/api/onboarding", signal ? { signal } : undefined),
};

export { ApiError, expectOk, passkeyFetch } from "./lib/passkey-fetch.ts";
export type { PasskeyResponse } from "./lib/passkey-fetch.ts";

// Security-page calls need a session: a 401 there means it ended, so they go
// to sign-in like apiFetch does, but keep the typed code (reauth_required,
// cooldown with its end time) instead of flattening it to a message.
async function sessionCall<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<T> {
  const r = await passkeyFetch<T>(path, init);
  if (r.status === 401) {
    window.location.hash = "#login";
    throw new ApiError("unauthorized", 401, r.body as Record<string, unknown>);
  }
  return expectOk(r);
}

const post = (body: unknown = {}): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const passkeyApi = {
  status: () => passkeyFetch<{ available?: boolean; reason?: string }>("/admin/api/passkey/status"),
  redeem: (token: string) => passkeyFetch("/admin/api/passkey/enroll/redeem", post({ token })),
  recovery: (code: string) => passkeyFetch("/admin/api/passkey/recovery", post({ code })),
  registerOptions: () => passkeyFetch<{ optionsJSON?: unknown }>("/admin/api/passkey/register/options", post()),
  registerVerify: (response: unknown, label: string) =>
    passkeyFetch<{ recovery_codes?: string[] }>("/admin/api/passkey/register/verify", post({ response, label })),
  loginOptions: () => passkeyFetch<{ optionsJSON?: unknown }>("/admin/api/passkey/login/options", post()),
  loginVerify: (response: unknown) => passkeyFetch<{ notices?: number }>("/admin/api/passkey/login/verify", post({ response })),
  reauthOptions: () => passkeyFetch<{ optionsJSON?: unknown }>("/admin/api/passkey/reauth/options", post()),
  reauthVerify: (response: unknown) => passkeyFetch("/admin/api/passkey/reauth/verify", post({ response })),
  // Session-side registration ("Add another passkey") needs fresh re-auth.
  sessionRegisterOptions: () => sessionCall<{ optionsJSON?: unknown }>("/admin/api/passkey/register/options", post()),

  passkeys: () => sessionCall<PasskeyList>("/admin/api/passkeys"),
  rename: (id: string, label: string) => sessionCall("/admin/api/passkeys/rename", post({ id, label })),
  revoke: (id: string, confirmLast = false) =>
    sessionCall("/admin/api/passkeys/revoke", post(confirmLast ? { id, confirm_last: true } : { id })),
  regenerateCodes: () => sessionCall<{ recovery_codes: string[] }>("/admin/api/recovery-codes/regenerate", post()),
  mintSetupLink: (ttl_hours?: number) =>
    sessionCall<{ url: string; expires_at: string }>("/admin/api/setup-links", post(ttl_hours === undefined ? {} : { ttl_hours })),
  events: (limit = 20) => sessionCall<unknown>(`/admin/api/security/events?limit=${limit}`),
  notices: () => passkeyFetch<unknown>("/admin/api/security/notices"),
  ackNotices: () => sessionCall<{ acknowledged?: number; refused?: number }>("/admin/api/security/notices/ack", post()),
};

export interface PasskeyRow {
  id_hint?: string;
  id: string;
  label: string;
  device_type: "singleDevice" | "multiDevice";
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
  created_via: string;
  in_cooldown: boolean;
}

export interface PasskeyList {
  passkeys: PasskeyRow[];
  recovery_codes_left: number;
  single_device_only_warning: boolean;
  session_in_cooldown: boolean;
  cooldown_until?: string | null;
}

export interface AuthEvent {
  id: number | string;
  at: string;
  event: string;
  outcome: "ok" | "fail";
  reason?: string | null;
  via?: string | null;
  credential?: string | null;
  client_key?: string | null;
  user_agent?: string | null;
  notice?: boolean;
  noticed_at?: string | null;
  ackable?: boolean;
}
