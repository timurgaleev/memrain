import { ApiError, expectOk, passkeyFetch } from "./lib/passkey-fetch.ts";
import type {
  CalendarsReport,
  ConnectorsReport,
  DaemonsReport,
  DataPreview,
  HoldDecisionStatus,
  PausedSpendPath,
  WriteGateHold,
} from "./lib/automation.ts";

// Calls behind the Connections, Autonomy and Approvals pages. A 401 means the
// session ended, so it goes to sign-in like every panel call; any other
// refusal keeps its code and body (ApiError) for the page to put into words.
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await passkeyFetch<T>(path, init);
  if (r.status === 401) {
    window.location.hash = "#login";
    throw new ApiError("unauthorized", 401, r.body as Record<string, unknown>);
  }
  return expectOk(r);
}

const post = (body: unknown = {}): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const account = (id: string, action: string) => `/admin/api/connectors/accounts/${encodeURIComponent(id)}/${action}`;
const provider = (id: string, action: string) => `/admin/api/connectors/${encodeURIComponent(id)}/${action}`;

export const automationApi = {
  connectors: () => call<ConnectorsReport>("/admin/api/connectors"),
  startConnect: (providerId: string, sourceId: string, services: string[]) =>
    call<{ authorize_url: string; expires_at: string }>(provider(providerId, "start"), post({ source_id: sourceId, services })),
  saveClient: (providerId: string, clientId: string, clientSecret: string, tenant?: string) =>
    call<{ ok: true }>(provider(providerId, "client"), post({ client_id: clientId, client_secret: clientSecret, ...(tenant ? { tenant } : {}) })),
  deleteClient: (providerId: string) => call<{ ok: true; deleted: boolean }>(provider(providerId, "client/delete"), post()),
  saveApiKey: (providerId: string, sourceId: string, services: string[], apiKey: string) =>
    call<{ ok: true }>(provider(providerId, "key"), post({ source_id: sourceId, services, api_key: apiKey })),
  setSync: (id: string, on: boolean) => call<{ ok: true; enabled: boolean }>(account(id, on ? "enable" : "disable"), post()),
  disconnect: (id: string, confirmLabel: string) =>
    call<{ ok: true; revoked: boolean; credential_kept: boolean; consent_urls?: string[] }>(account(id, "disconnect"), post({ confirm_label: confirmLabel })),
  preview: (id: string) => call<DataPreview>(account(id, "preview")),
  deleteData: (id: string, confirmLabel: string, planHash: string) =>
    call<{ ok: true; deleted: number; changed: number }>(account(id, "delete-data"), post({ confirm_label: confirmLabel, plan_hash: planHash })),
  retryHeld: (id: string) => call<{ ok: true; retried: number }>(account(id, "retry-held"), post()),
  confirmDeletes: (id: string) => call<{ ok: true; confirmed: number }>(account(id, "deletions/confirm"), post()),
  rejectDeletes: (id: string) => call<{ ok: true; kept: number }>(account(id, "deletions/reject"), post()),
  calendars: (id: string) => call<CalendarsReport>(account(id, "calendars")),
  saveCalendars: (id: string, calendars: string[], historyDays: number) =>
    call<{ ok: true; calendars: string[]; history_days: number }>(account(id, "calendars"), post({ calendars, history_days: historyDays })),

  daemons: () => call<DaemonsReport>("/admin/api/daemons"),
  controlDaemon: (action: "pause" | "resume" | "enable" | "disable", daemon: string, reason?: string) =>
    call<{ ok: true }>("/admin/api/daemons/control", post({ action, daemon, ...(reason ? { reason } : {}) })),
  pausedSpend: () => call<{ paths: PausedSpendPath[] }>("/admin/api/spend/paused"),
  resumeSpend: (path: string) => call<{ ok: true; resumed: boolean }>("/admin/api/spend/resume", post({ path })),

  holds: (status: "open" | "all") => call<{ holds: WriteGateHold[] }>(`/admin/api/write-gate/holds?status=${status}`),
  decideHold: async (id: number, decision: "approve" | "reject"): Promise<HoldDecisionStatus> => {
    // 404 and 409 still carry a status the page explains; only other failures throw.
    const r = await passkeyFetch<{ status?: HoldDecisionStatus }>(`/admin/api/write-gate/holds/${id}/decide`, post({ decision }));
    if (r.status === 401) {
      window.location.hash = "#login";
      throw new ApiError("unauthorized", 401, r.body as Record<string, unknown>);
    }
    if (r.body.status) return r.body.status;
    return expectOk(r) as never;
  },
};
