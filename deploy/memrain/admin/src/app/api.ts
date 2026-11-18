// The member app's calls. Every route lives under /app and answers JSON;
// a refusal keeps its code so the page can word it. No DOM here.

export class AppError extends Error {
  constructor(readonly code: string, readonly status: number, readonly body: Record<string, unknown>) {
    super(typeof body.message === "string" ? body.message : code);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  if (!res.ok) throw new AppError(typeof body.error === "string" ? body.error : `http_${res.status}`, res.status, body);
  return body as T;
}

const post = <T>(path: string, body: unknown = {}) => call<T>(path, { method: "POST", body: JSON.stringify(body) });

export interface Me { member_id: string; display_name: string | null; ready: boolean; read_sources: string[] }
export type Step = "connect" | "fill" | "ask" | "done";
export interface Onboarding {
  step: Step;
  connected_at: string | null;
  first_write_at: string | null;
  first_answer_at: string | null;
  opened_at: string | null;
  demo_loaded: boolean;
}
export interface ConnectInfo { mcp_url: string; client_id: string | null }
export interface Enrollment { code: string; client_id: string; expires_at: string; mcp_url: string }
export interface MintedKey { name: string; token: string; surface: string; note: string }
export interface KeyRow { name: string; created_at: string | null; last_used_at: string | null; surface: string }
export interface ImportReport { format: string; sessions: number; parts_written: number; parts_unchanged: number; sessions_rejected: number; sessions_failed: number }

export const appApi = {
  me: () => call<Me>("/app/api/me"),
  logout: () => post<{ ok: true }>("/app/logout"),

  inviteOpen: (token: string) => post<{ member: { id: string; display_name: string | null } }>("/app/invite/open", { token }),
  inviteRegisterOptions: (token: string) => post<{ optionsJSON: unknown }>("/app/invite/passkey/options", { token }),
  inviteRegisterVerify: (token: string, response: unknown, label: string) => post<{ ok: true }>("/app/invite/passkey/verify", { token, response, label }),
  inviteWithoutPasskey: (token: string) => post<{ ok: true }>("/app/invite/session", { token }),
  loginOptions: () => post<{ optionsJSON: unknown }>("/app/login/options"),
  loginVerify: (response: unknown) => post<{ ok: true }>("/app/login/verify", { response }),

  onboarding: () => call<Onboarding>("/app/api/onboarding"),
  paste: (title: string, text: string) => post<{ slug: string }>("/app/api/onboarding/paste", { title, text }),
  importExport: (file: Blob, confirm: boolean) =>
    call<ImportReport>(`/app/api/onboarding/import${confirm ? "?confirm=1" : ""}`, { method: "POST", body: file }),
  loadDemo: () => post<{ pages: number }>("/app/api/onboarding/demo"),
  removeDemo: () => call<{ removed: boolean }>("/app/api/onboarding/demo", { method: "DELETE" }),

  connect: () => call<ConnectInfo>("/app/api/connect"),
  enrollment: () => post<Enrollment>("/app/api/connect/enrollment"),
  mintKey: (label: string) => post<MintedKey>("/app/api/connect/token", { label }),
  keys: () => call<{ tokens: KeyRow[] }>("/app/api/connect/tokens"),
  revokeKey: (name: string) => call<{ ok: true }>(`/app/api/connect/token/${encodeURIComponent(name)}`, { method: "DELETE" }),

  threads: () => call<{ threads: Array<{ id: string; title: string | null }> }>("/app/api/chat/threads"),
  thread: (id: string) => call<unknown>(`/app/api/chat/threads/${encodeURIComponent(id)}`),
  deleteThread: (id: string) => call<unknown>(`/app/api/chat/threads/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

/** Plain words for the refusals a member can meet. */
export function errorText(e: unknown): string {
  if (!(e instanceof AppError)) return "Something went wrong. Try again.";
  switch (e.code) {
    case "invite_invalid": return "This invite link was used, revoked or has expired. Ask for a new one.";
    case "invite_in_use": return "This invite is open in another browser. Try again in 15 minutes, or ask for a new link.";
    case "invite_not_open": return "Open the invite link again in this browser.";
    case "passkey_failed": return "That passkey did not sign you in.";
    case "passkeys_unavailable": return "Passkeys are not set up on this server.";
    case "credential_exists": return "This device already holds a passkey for you. Sign in instead.";
    case "rate_limited": return "Too many attempts. Wait a minute and try again.";
    case "member_not_ready": return "Your account has no personal space yet. Ask the brain operator to finish setting it up.";
    case "connector_not_configured": return "Claude.ai and ChatGPT are not set up on this server yet. Use a key instead.";
    case "too_many_keys": return "You hold the most keys allowed. Revoke one first.";
    case "tenant_suspended": return "This brain is paused. Reading still works.";
    case "unauthorized": return "Your session ended. Sign in again.";
    default: return e.message || "Something went wrong. Try again.";
  }
}
