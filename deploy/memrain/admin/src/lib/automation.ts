// Shapes and readings for the Connections, Autonomy and Approvals pages.
// No DOM or React, so the root test runner can load it.

export type Tone = "ok" | "warn" | "error" | "idle";

export interface ConnectorNotice {
  kind: "needs_reconnect" | "mass_delete_held" | "items_held";
  detail: string;
  created_at: string;
}

export interface ConnectorAccountView {
  id: string;
  source_id: string;
  provider: string;
  services: string[];
  account_label: string;
  status: "active" | "paused" | "needs_reconnect" | "revoked" | "error";
  status_reason: string | null;
  enabled: boolean;
  spend_cap_usd_daily: number;
  item_cap_daily: number;
  last_success_at: string | null;
  held_items: number;
  held_deletes: number;
  notices: ConnectorNotice[];
  credential: { scopes: string[]; expires_at: string | null } | null;
}

export interface ConnectorProviderView {
  id: string;
  services: string[];
  service_kinds: Record<string, string[]>;
  auth: "oauth" | "api_key";
  /** The redirect a bring-your-own app must allow; null until MEMRAIN_PUBLIC_URL can receive one. */
  callback_uri: string | null;
}

export interface SourceView {
  id: string;
  kind: string;
}

export interface OAuthClientView {
  provider: string;
  client_id: string;
  updated_at: string;
}

export interface ConnectorsReport {
  enabled: boolean;
  reason: string | null;
  kek_id: string | null;
  providers: ConnectorProviderView[];
  sources: SourceView[];
  accounts: ConnectorAccountView[];
  clients: OAuthClientView[];
}

export interface DataPreview {
  pages: number;
  chunks: number;
  facts: number;
  timeline_events: number;
  plan_hash: string;
}

const PROVIDER_LABELS: Record<string, string> = { google: "Google", fireflies: "Fireflies", microsoft: "Microsoft", slack: "Slack" };

/** A provider's display name; an id the panel does not know stays as it is. */
export function providerLabel(id: string): string {
  return Object.hasOwn(PROVIDER_LABELS, id) ? PROVIDER_LABELS[id]! : id;
}

/** The provider's consent page, followed only when it is a plain https address. */
export function safeAuthorizeUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the account's state means for the owner, and what it lets them do. */
export function accountView(a: ConnectorAccountView): {
  tone: Tone;
  label: string;
  canToggleSync: boolean;
  canReconnect: boolean;
  canDisconnect: boolean;
  canDeleteData: boolean;
  attention: string[];
} {
  const revokeFailed = a.status === "error" && a.status_reason === "revoke_failed";
  const disconnected = a.status === "revoked" || revokeFailed;
  const attention: string[] = [];
  if (a.held_deletes > 0) attention.push(`${plural(a.held_deletes, "deletion", "deletions")} held`);
  if (a.held_items > 0) attention.push(`${plural(a.held_items, "item", "items")} held`);
  const [tone, label]: [Tone, string] = a.status === "needs_reconnect" ? ["warn", "Needs reconnect"]
    : a.status === "revoked" ? ["idle", "Disconnected"]
    : revokeFailed ? ["error", "Revoke failed"]
    : a.status === "error" ? ["error", "Error"]
    : a.status === "paused" ? ["idle", "Paused"]
    : a.enabled ? ["ok", "Syncing"]
    : ["idle", "Connected, sync off"];
  return {
    tone,
    label,
    canToggleSync: !disconnected,
    canReconnect: a.status === "needs_reconnect",
    canDisconnect: a.status !== "revoked",
    canDeleteData: disconnected,
    attention,
  };
}

/** The typed confirmation names the account exactly, surrounding spaces aside. */
export function confirmMatches(typed: string, accountLabel: string): boolean {
  return typed.trim() !== "" && typed.trim() === accountLabel;
}

/** The sources every chosen service may write into. */
export function sourcesFor(serviceKinds: Record<string, string[]>, services: readonly string[], sources: readonly SourceView[]): SourceView[] {
  if (services.length === 0) return [];
  return sources.filter((s) => services.every((svc) => (serviceKinds[svc] ?? []).includes(s.kind)));
}

const CONNECT_ERRORS: Record<string, string> = {
  connectors_disabled: "Connectors are off or the connector key is missing.",
  unknown_provider: "That provider is not installed on this server.",
  unknown_service: "Choose at least one thing to read.",
  source_not_found: "That source no longer exists.",
  source_kind: "That source cannot hold this kind of data. Pick another source.",
  redirect_uri: "MEMRAIN_PUBLIC_URL must be an https address before a provider can send you back.",
  no_client: "No OAuth app is set up for this provider. Add your own client below.",
  state_invalid: "The connect link was not recognised. Start again.",
  state_used: "That connect link was already used. Start again.",
  state_expired: "The connect link expired. Start again.",
  state_session: "The connect was started in another sign-in. Start again from this browser.",
  state_provider: "The connect was started for another provider. Start again.",
  provider_denied: "The provider refused access, or you cancelled. Nothing was connected.",
  code_missing: "The provider sent no authorization code. Start again.",
  token_exchange: "The provider refused the authorization code. Start again.",
  scope_mismatch: "The provider granted different access than Memrain asks for, so the grant was refused and returned.",
  identity: "Memrain could not read which account this is. Nothing was connected.",
  vault: "The connector key could not seal the credential. Check the key, then start again.",
  refresh_in_progress: "A sync is renewing this account's access. Try again in a minute.",
  account_not_found: "That account no longer exists.",
  confirm_mismatch: "The name you typed does not match the account.",
  still_connected: "Disconnect the account first, so a sync cannot write the pages back.",
  conflict: "The account's data changed since the preview. Review the new counts.",
};

/** Copy for an error code the connector routes answer; unknown codes get the fallback, never the code itself. */
export function connectorErrorCopy(code: string, fallback = "The connect did not finish. Start again."): string {
  return Object.hasOwn(CONNECT_ERRORS, code) ? CONNECT_ERRORS[code]! : fallback;
}

/** The outcome a finished connect left in the page's query string, if any. */
export function connectOutcome(search: string): { ok: boolean; message: string } | null {
  const q = new URLSearchParams(search);
  if (q.get("connector") === "connected") return { ok: true, message: "Account connected. Sync stays off until you switch it on." };
  const err = q.get("connector_error");
  if (err !== null) return { ok: false, message: connectorErrorCopy(err) };
  return null;
}

export interface PauseInfo {
  by: string | null;
  reason: string | null;
  at: string | null;
}

export interface DaemonView {
  name: string;
  enabled: boolean;
  env_disabled: boolean;
  paused: PauseInfo | null;
  last_outcome: string | null;
  consecutive_failures: number;
}

export interface DaemonRow extends DaemonView {
  kind: string;
  schedule: string;
  lane: string;
  paid: boolean;
  next_window: string | null;
  last_window: string | null;
  last_run_at: string | null;
  sources: Array<{ source_id: string; enabled: boolean | null; paused: PauseInfo | null }>;
}

export interface DaemonsReport {
  scheduler: {
    enabled_here: boolean;
    leader: { holder: string; tick_age_s: number | null; live: boolean } | null;
  };
  paused_all: PauseInfo | null;
  daemons: DaemonRow[];
}

/** A failure streak this long reads as failing (the scheduler auto-pauses at five). */
const FAILING_AFTER = 3;

/** How one daemon reads at a glance; a brain-wide pause wins over its own state. */
export function daemonView(d: DaemonView, pausedAll: PauseInfo | null): { tone: Tone; label: string } {
  if (d.env_disabled) return { tone: "idle", label: "Off (environment)" };
  if (!d.enabled) return { tone: "idle", label: "Off" };
  if (pausedAll) return { tone: "warn", label: "Paused (all daemons)" };
  if (d.paused) return { tone: "warn", label: d.paused.by ? `Paused by ${d.paused.by}` : "Paused" };
  if (d.consecutive_failures >= FAILING_AFTER) return { tone: "error", label: `Failing (${d.consecutive_failures} in a row)` };
  return { tone: "ok", label: "On" };
}

export interface PausedSpendPath {
  path: string;
  reason: string;
  model: string | null;
  heldUsd: number | null;
  actualUsd: number | null;
  pausedAt: string;
}

export interface WriteGateHold {
  id: number;
  source_id: string;
  document_id: string;
  target_ref: string;
  origin: "external" | "agent";
  families: string[];
  detector_version: string;
  excerpt: string;
  created_at: string;
  decision: "approved" | "rejected" | "superseded" | null;
  decided_at: string | null;
  decided_by: string | null;
  current: boolean;
}

export type HoldDecisionStatus = "approved" | "rejected" | "stale" | "already_decided" | "not_found";

/** What a write-gate decision did, in one sentence. */
export function decisionMessage(status: HoldDecisionStatus): string {
  switch (status) {
    case "approved": return "Approved: the document is released into search, still marked as outside text.";
    case "rejected": return "Rejected: the document stays hidden from search.";
    case "stale": return "The document changed since it was held, so nothing was released. The new text is assessed on its own.";
    case "already_decided": return "Someone already decided this hold.";
    case "not_found": return "That hold no longer exists.";
  }
}
