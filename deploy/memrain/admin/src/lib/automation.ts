// Shapes and readings for the Connections, Autonomy and Approvals pages.
// No DOM or React, so the root test runner can load it.
import { fmtInt } from "./format.ts";

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
  /** `granted_at`: the last consent. */
  credential: { scopes: string[]; expires_at: string | null; granted_at: string } | null;
  last_run: AccountRunView | null;
  needs_reconnect: boolean;
  grant_expiry: GrantExpiryView | null;
}

export interface AccountRunView {
  status: "success" | "nothing_new" | "partial" | "auth_required" | "forbidden" | "skipped";
  stop_reason: string | null;
  at: string;
  http_status: number | null;
  error: string | null;
  items: number;
  pages_written: number;
  items_failed: number;
  /** Absent from a run recorded before these were kept. */
  pages_unchanged?: number;
  items_held?: number;
  deletions_applied?: number;
  deletions_held?: number;
}

/** When a provider's test-mode grant ends (Google: 7 days after consent while the app is in Testing). */
export interface GrantExpiryView {
  granted_at: string;
  expires_at: string;
  days: number;
  state: "upcoming" | "lapsed";
  due_soon: boolean;
}

/** A calendar the account can read, as the picker lists it. */
export interface CalendarView {
  id: string;
  summary: string;
  primary: boolean;
  access_role: string;
  selected: boolean;
}

export interface CalendarsReport {
  calendars: CalendarView[];
  history_days: number;
}

/** The longest history window the server accepts, in days. */
export const MAX_HISTORY_DAYS = 3650;

export interface ChannelView {
  id: string;
  name: string;
  is_private: boolean;
  /** The bot was invited to it; only such a channel can sync. */
  is_member: boolean;
  selected: boolean;
}

export interface ChannelsReport {
  channels: ChannelView[];
  history_days: number;
  /** The account was granted private channels. */
  private_channels: boolean;
}

/** The longest Slack history window the server accepts, in days. */
export const MAX_SLACK_HISTORY_DAYS = 365;

export interface ConnectorProviderView {
  id: string;
  services: string[];
  service_kinds: Record<string, string[]>;
  auth: "oauth" | "api_key";
  /** The redirect a bring-your-own app must allow; null until MEMRAIN_PUBLIC_URL can receive one. */
  callback_uri: string | null;
  /** The tenant an app of this provider signs in to unless it names one; null when the provider has no tenants. */
  tenant_default: string | null;
  /** Whether a disconnect can withdraw the grant at the provider. */
  can_revoke: boolean;
  /** The provider refused its OAuth app on a renewal; null when it did not, or the app was saved since. */
  client_rejected?: ClientRejectedView | null;
  /** The provider also takes a token the owner pastes (a Slack internal app's bot token). */
  pasted_token?: boolean;
  /** Services left unticked until the owner asks for them. */
  opt_in_services?: string[];
}

export interface ClientRejectedView {
  reason: "invalid_client";
  /** Microsoft's AADSTS number, when it sent one. */
  service_code: number | null;
  since: string;
  /** Until then the provider's accounts do not try again. */
  held_until: string;
}

export interface SourceView {
  id: string;
  kind: string;
}

export interface OAuthClientView {
  provider: string;
  client_id: string;
  /** Who may sign in to the app; null is the provider's default. */
  tenant: string | null;
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

const SERVICE_LABELS: Record<string, string> = {
  "google:calendar": "Google Calendar",
  "google:gmail": "Gmail",
  "microsoft:outlook_mail": "Outlook mail",
  "microsoft:outlook_calendar": "Outlook calendar",
  "slack:slack": "Public channels",
  "slack:slack_private": "Private channels too",
  "microsoft:teams_chat": "Teams chats",
  "microsoft:teams_transcripts": "Teams meeting transcripts",
};

/** A service as the owner knows it (Outlook mail, Gmail); an id the page does not know stays as it is. */
export function serviceLabel(provider: string, service: string): string {
  const key = `${provider}:${service}`;
  return Object.hasOwn(SERVICE_LABELS, key) ? SERVICE_LABELS[key]! : service;
}

const TEAMS_SERVICES: readonly string[] = ["teams_chat", "teams_transcripts"];

/**
 * The connect button's words. Teams is added to a Microsoft app on its own:
 * it asks for its own permissions, one of which an administrator consents to.
 */
export function connectButtonLabel(provider: string, services: readonly string[]): string {
  if (provider === "microsoft" && services.length > 0 && services.every((s) => TEAMS_SERVICES.includes(s))) return "Add Teams";
  return `Connect ${providerLabel(provider)}`;
}

export type TenantChoice = "common" | "organizations" | "consumers" | "tenant";
const TENANT_AUDIENCES: readonly string[] = ["common", "organizations", "consumers"];
const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The tenant picker's option for a saved tenant: one of the audiences, or a single directory. */
export function tenantChoice(tenant: string | null, fallback: string): TenantChoice {
  const t = tenant ?? fallback;
  return TENANT_AUDIENCES.includes(t) ? t as TenantChoice : "tenant";
}

/**
 * The tenant the form sends: the chosen audience, or the typed directory id
 * or domain in lower case. Null when the typed value is neither; the server
 * applies the same rule.
 */
export function tenantFromForm(choice: TenantChoice, typed: string): string | null {
  if (choice !== "tenant") return choice;
  const t = typed.trim().toLowerCase();
  if (TENANT_ID_RE.test(t)) return t;
  const labels = t.split(".");
  return t.length <= 253 && labels.length >= 2 && labels.every((l) => DOMAIN_LABEL_RE.test(l)) ? t : null;
}

/**
 * What a provider's refusal of its OAuth app means and how the owner fixes
 * it: a new secret for the same app, never a reconnect. Null when nothing
 * was refused.
 */
export function clientRejectedNote(provider: string, rejected: ClientRejectedView | null | undefined): string | null {
  if (!rejected) return null;
  const name = providerLabel(provider);
  const code = rejected.service_code === null ? rejected.reason : `${rejected.reason}, AADSTS${rejected.service_code}`;
  return `${name} refused your app when renewing access (${code}): its client secret has expired or is wrong, or the app was deleted. Create a new client secret for the app, then save it with the same client ID below, under Use your own OAuth app. `
    + `No reconnect is needed: every ${name} account syncs again once it is saved. Until then they try once an hour.`;
}

/**
 * Who can no longer sign in once a Microsoft app names `to` as its tenant:
 * an account that cannot sign in there can neither renew nor reconnect.
 */
export function tenantChangeEffect(to: string): string {
  const mixed = " To read a personal and a work account with one app, keep Work, school and personal accounts (common).";
  if (to === "common") return "Personal, work and school accounts can all sign in through common.";
  if (to === "organizations") {
    return "Personal Microsoft accounts (outlook.com, hotmail.com, live.com) cannot sign in through organizations: they stop syncing and cannot reconnect." + mixed;
  }
  if (to === "consumers") return "Work and school accounts cannot sign in through consumers: they stop syncing and cannot reconnect." + mixed;
  return `Only accounts of the directory ${to} can sign in: personal accounts and accounts of any other organization stop syncing and cannot reconnect.${mixed}`;
}

/**
 * What a disconnect cannot do for the owner: withdraw a consent the provider
 * gives the app no way to withdraw. Null when the disconnect revokes it.
 */
export function disconnectConsentNote(provider: string, canRevoke: boolean): string | null {
  if (canRevoke) return null;
  if (provider === "microsoft") {
    return "Microsoft gives Memrain no way to withdraw the consent you gave, so it stays listed until you remove it: for a personal "
      + "account at account.microsoft.com/privacy/app-access, for a work or school account at myapplications.microsoft.com (the app's "
      + "… menu, Manage your application, Revoke permissions). Consent your IT admin gave for the whole organization only the IT admin can remove.";
  }
  return `${providerLabel(provider)} gives Memrain no way to withdraw the consent you gave; remove it in the provider's own settings.`;
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

/** How the account's last sync run ended, what it read and why it stopped: the detail `connectors status` prints. */
export function lastRunText(run: AccountRunView | null): string {
  if (run === null) return "none yet";
  const why = [run.stop_reason, run.http_status !== null ? `HTTP ${run.http_status}` : null].filter((x) => x !== null);
  const parts = [`${fmtInt(run.items)} items`, `${fmtInt(run.pages_written)} written`];
  const more: Array<[number | undefined, string]> = [
    [run.pages_unchanged, "unchanged"],
    [run.items_failed, "failed"],
    [run.items_held, "held"],
    [run.deletions_applied, "deletion(s) applied"],
    [run.deletions_held, "held for confirmation"],
  ];
  for (const [n, what] of more) if (n !== undefined && n > 0) parts.push(`${fmtInt(n)} ${what}`);
  return `${run.status}${why.length > 0 ? ` (${why.join(", ")})` : ""} · ${parts.join(", ")}${run.error ? ` — ${run.error}` : ""}`;
}

const DAY_MS = 86_400_000;
/**
 * Microsoft refresh tokens live 90 days and replace themselves on every use
 * (learn.microsoft.com/entra/identity-platform/refresh-tokens), and Memrain
 * uses one only when a sync needs a fresh access token. A grant that syncs
 * never runs out; one whose sync is off ends 90 days after its last use.
 * The last use is estimated from the last consent and the last run that got
 * a token; a run may use an access token renewed up to about an hour before,
 * which is noise against 90 days.
 */
const IDLE_GRANT_DAYS = 90;
const IDLE_WARN_DAYS = 15;
/** Run outcomes that prove the run got an access token, so the grant was used. */
const USED_RUNS: ReadonlySet<string> = new Set(["success", "nothing_new", "partial", "forbidden"]);

function lastGrantUse(a: ConnectorAccountView): number {
  const used = [a.credential?.granted_at, a.last_success_at, a.last_run && USED_RUNS.has(a.last_run.status) ? a.last_run.at : null]
    .map((t) => (t ? Date.parse(t) : Number.NaN))
    .filter((t) => Number.isFinite(t));
  return used.length > 0 ? Math.max(...used) : Number.NaN;
}

function idleGrantNote(a: ConnectorAccountView, now: number): { warn: boolean; text: string } | null {
  if (a.credential === null || a.status === "revoked") return null;
  const used = lastGrantUse(a);
  if (!Number.isFinite(used)) return null;
  const ends = used + IDLE_GRANT_DAYS * DAY_MS;
  const day = new Date(ends).toISOString().slice(0, 10);
  const limit = `Microsoft ends access that goes unused for ${IDLE_GRANT_DAYS} days`;
  if (a.status === "needs_reconnect") {
    return now >= ends
      ? { warn: true, text: `${limit}, and this account was last used on ${new Date(used).toISOString().slice(0, 10)}. Reconnect to renew it.` }
      : null;
  }
  const soon = now >= ends - IDLE_WARN_DAYS * DAY_MS;
  // Sync on renews the grant, unless nothing runs (scheduler off, daemon paused): then it lapses all the same.
  if (a.enabled && a.status === "active" && !soon) return null;
  const why = !a.enabled ? "and sync is off"
    : a.status === "active" ? `and this account has not synced since ${new Date(used).toISOString().slice(0, 10)}`
    : "and this account is not syncing";
  return soon
    ? { warn: true, text: `Around ${day}: ${limit}, ${why}. Turn sync on or reconnect before then to renew it.` }
    : { warn: false, text: `Around ${day}: ${limit}, ${why}. Turn sync on to keep it renewed.` };
}

/**
 * What the owner should know about when a grant ends: a test-mode grant's
 * expected end (Google), or an idle grant's (Microsoft), or that either likely
 * ended the account's access. `warn` asks for action.
 */
export function grantNote(a: ConnectorAccountView, now: number = Date.now()): { warn: boolean; text: string } | null {
  if (a.provider === "microsoft") return idleGrantNote(a, now);
  const g = a.grant_expiry;
  if (g === null) return null;
  const day = g.expires_at.slice(0, 10);
  if (g.state === "lapsed") {
    return {
      warn: true,
      text: `${providerLabel(a.provider)} ends a grant ${g.days} days after consent while its OAuth app is in Testing, and this one was granted on ${g.granted_at.slice(0, 10)}. Reconnect, or publish the app to stop the weekly expiry.`,
    };
  }
  const base = `Around ${day} if the ${providerLabel(a.provider)} app is in Testing (${g.days} days after consent).`;
  return g.due_soon ? { warn: true, text: `${base} Reconnect before then to keep syncing, or publish the app.` } : { warn: false, text: base };
}

/** Each calendar provider's calendar service, whose accounts have calendars to pick. */
const CALENDAR_SERVICES: Readonly<Record<string, string>> = { google: "calendar", microsoft: "outlook_calendar" };

/** The calendar picker is for a connected Google or Outlook calendar account, and needs connectors on to read the list. */
export function hasCalendarPicker(a: ConnectorAccountView, connectorsOn: boolean): boolean {
  const service = Object.hasOwn(CALENDAR_SERVICES, a.provider) ? CALENDAR_SERVICES[a.provider]! : null;
  return connectorsOn && service !== null && a.services.includes(service) && a.status === "active";
}

/** The channel picker is for a connected Slack account, and needs connectors on to read the list. */
export function hasChannelPicker(a: ConnectorAccountView, connectorsOn: boolean): boolean {
  return connectorsOn && a.provider === "slack" && a.services.includes("slack") && a.status === "active";
}

/** The typed confirmation names the account exactly, surrounding spaces aside. */
export function confirmMatches(typed: string, accountLabel: string): boolean {
  return typed.trim() !== "" && typed.trim() === accountLabel;
}

type ServicePicker = Pick<ConnectorProviderView, "services" | "service_kinds" | "opt_in_services">;

/** No one source can hold two of the services: they connect one at a time, a single choice. */
export function exclusiveServices(p: ServicePicker): boolean {
  return p.services.every((a, i) => p.services.slice(i + 1).every((b) => !shareKind(p, a, b)));
}

/** Whether one source kind can hold both services. */
function shareKind(p: ServicePicker, a: string, b: string): boolean {
  const kinds = p.service_kinds[b] ?? [];
  return (p.service_kinds[a] ?? []).some((k) => kinds.includes(k));
}

/** The services first offered: the first one, and every other one a source of its kind can hold too, unless it waits to be asked for. */
export function initialServices(p: ServicePicker): string[] {
  const first = p.services[0];
  const optIn = p.opt_in_services ?? [];
  return first === undefined ? [] : p.services.filter((s) => shareKind(p, first, s) && (s === first || !optIn.includes(s)));
}

/**
 * Switch a service on or off. Switching one on drops the chosen services no
 * source could hold with it (Gmail and Calendar go into sources of different
 * kinds), so the choice always leaves a source to pick.
 */
export function toggleService(p: ServicePicker, current: readonly string[], svc: string, on: boolean): string[] {
  if (!on) return current.filter((s) => s !== svc);
  return p.services.filter((s) => s === svc || (current.includes(s) && shareKind(p, s, svc)));
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
  invalid_tenant: "That is not a tenant. Use common, organizations, consumers, a directory ID (a GUID) or a domain such as contoso.onmicrosoft.com.",
  tenant_unsupported: "This provider does not take a tenant. Save the app without one.",
  state_invalid: "The connect link was not recognised. Start again.",
  state_used: "That connect link was already used. Start again.",
  state_expired: "The connect link expired. Start again.",
  state_session: "The connect was started in another sign-in. Start again from this browser.",
  state_provider: "The connect was started for another provider. Start again.",
  provider_denied: "The provider refused access, or you cancelled. Nothing was connected.",
  code_missing: "The provider sent no authorization code. Start again.",
  token_exchange: "The provider refused the authorization code. Start again.",
  scope_mismatch: "The provider granted different access than Memrain asks for, so the grant was refused and returned.",
  scope_mismatch_not_revoked: "The provider granted different access than Memrain asks for. Nothing was saved. The grant was left in place, because another connected account of this provider may share it. Start again and allow every access listed.",
  identity: "Memrain could not read which account this is. Nothing was connected.",
  identity_not_revoked: "Memrain could not read which account this is. Nothing was saved. The grant was left in place, because another connected account may share it. Start again.",
  vault: "The connector key could not seal the credential. Check the key, then start again.",
  refresh_in_progress: "A sync is renewing this account's access. Try again in a minute.",
  account_not_found: "That account no longer exists.",
  confirm_mismatch: "The name you typed does not match the account.",
  still_connected: "Disconnect the account first, so a sync cannot write the pages back.",
  conflict: "The account's data changed since the preview. Review the new counts.",
  shared_owner: "Another account in this source writes pages under the same name, so they cannot be told apart. Remove that account first.",
  not_connected: "Reconnect the account before switching its sync on.",
  key_invalid: "That does not look like an API key. Copy the whole key from the provider and paste it again.",
  key_rejected: "The provider refused the key. Copy the current key from the provider and try again.",
  provider_unavailable: "The provider could not be reached to check the key. Nothing was saved; try again in a minute.",
  delete_incomplete: "Deleting stopped part-way. Preview again and delete what is left.",
  admin_consent_required: "The account's organization lets only an administrator approve this app. Ask your Microsoft 365 admin to grant consent, then connect again.",
  identity_mismatch: "You signed in with a different account than the one this row belongs to (a personal and a work Microsoft account can even share one address). Nothing was changed. Choose Reconnect again and pick the account named on the row (for Microsoft: Personal account, or Work or school account).",
  consent_declined: "Microsoft says the access was not granted. If you chose Cancel, connect again and choose Accept. If you asked an administrator to approve the app, wait until IT has approved it, then choose Connect again.",
};

/** Copy for an error code the connector routes answer; unknown codes get the fallback, never the code itself. */
export function connectorErrorCopy(code: string, fallback = "The connect did not finish. Start again."): string {
  return Object.hasOwn(CONNECT_ERRORS, code) ? CONNECT_ERRORS[code]! : fallback;
}

/** The outcome a finished connect left in the page's query string, if any. */
export function connectOutcome(search: string): { ok: boolean; message: string } | null {
  const q = new URLSearchParams(search);
  if (q.get("connector") === "reconnected") {
    return { ok: true, message: "Account reconnected. Its pages and sync position were kept, and its sync stays on or off as it was." };
  }
  if (q.get("connector") === "connected") {
    const connected = "Account connected. Sync stays off until you switch it on.";
    if (q.get("connector_note") !== "no_address") return { ok: true, message: connected };
    return {
      ok: true,
      message: `${connected} Microsoft gave no email address for this account (it signs in with a phone number), so it is listed under its sign-in name or ID, `
        + "and mail and invitations cannot be told apart as its own.",
    };
  }
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

/**
 * What a delete-everything did. Pages edited after the preview are kept, not
 * deleted, so the run is not done until the owner previews them again.
 */
export function deleteOutcome(r: { deleted: number; changed: number }, accountLabel: string): { done: boolean; message: string } {
  const deleted = `Deleted ${fmtInt(r.deleted)} ${r.deleted === 1 ? "page" : "pages"} from ${accountLabel}.`;
  if (r.changed === 0) return { done: true, message: deleted };
  const kept = r.changed === 1
    ? "1 page changed after the preview and was kept: preview again to review it."
    : `${fmtInt(r.changed)} pages changed after the preview and were kept: preview again to review them.`;
  return { done: false, message: `${deleted} ${kept}` };
}
