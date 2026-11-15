/**
 * What each connector account is doing, for `connectors status`, doctor
 * connector-health and the Connections page: its state, last clean sync, the
 * outcome of its last run and whether it waits on a reconnect.
 *
 * The last run is kept in `recipe_state` under `connector-account:<id>`
 * (outside the `connector:` prefix the recipe connectors use, so the recipe
 * listing never mistakes it for one). It holds the run's status, stop reason,
 * HTTP status, counts and its printable error, never a token or an address.
 *
 * Grant expiry. While a Google OAuth app is External and in "Testing", Google
 * ends a refresh token 7 days after consent when the grant holds anything
 * beyond openid, email and profile (developers.google.com/identity/protocols/
 * oauth2, "Refresh token expiration"). Nothing in the token response says
 * whether the app is in Testing, so the reading is inferred: the clock starts
 * at the last consent (the credential's created_at, reset by every reconnect),
 * a grant that is still syncing well after the limit proves the app is not in
 * Testing and is left alone, and a refusal six or more days after consent is
 * named as the likely cause.
 */
import type { Engine } from "../engine/interface.ts";
import { getRecipeState, setRecipeState } from "../recipe-state.ts";
import { listAccounts, type ConnectorAccount, type ConnectorAccountStatus } from "./accounts.ts";
import { listOpenNotices } from "./sync-store.ts";
import type { SyncRunResult, SyncStopReason } from "./sync-engine.ts";

export const ACCOUNT_RUN_RECIPE_PREFIX = "connector-account:";
const LAST_RUN_KEY = "last_run";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_ERROR = 300;

/** Days a provider's test-mode grant lasts after consent. */
export const TEST_MODE_GRANT_DAYS: Readonly<Record<string, number>> = { google: 7 };
/** From this many days after consent a test-mode grant is about to end: re-consent now. */
export const GRANT_WARN_DAYS = 5;
/** A refusal this many days or more after consent is put down to the test-mode limit. */
export const GRANT_LAPSE_MIN_DAYS = 6;
/** An access token issued just before the limit still works for up to an hour after it. */
const SURVIVAL_MARGIN_MS = 2 * HOUR_MS;
/** Past the limit with no proof either way, the reading says nothing rather than guess. */
const UPCOMING_GRACE_MS = DAY_MS;

export interface AccountRunRecord {
  status: SyncRunResult["status"];
  stop_reason: SyncStopReason | null;
  /** ISO time the run was recorded. */
  at: string;
  http_status: number | null;
  /** The run's printable error (status codes and classes, tokens scrubbed). */
  error: string | null;
  items: number;
  pages_written: number;
  items_failed: number;
}

export function accountRunRecipeId(accountId: string): string {
  return `${ACCOUNT_RUN_RECIPE_PREFIX}${accountId}`;
}

export async function recordAccountRun(engine: Engine, accountId: string, result: SyncRunResult, at: Date = new Date()): Promise<void> {
  const record: AccountRunRecord = {
    status: result.status,
    stop_reason: result.stop_reason,
    at: at.toISOString(),
    http_status: result.http_status,
    error: result.error === null ? null : result.error.slice(0, MAX_ERROR),
    items: result.counts.items,
    pages_written: result.counts.pages_written,
    items_failed: result.counts.items_failed,
  };
  await setRecipeState(engine, accountRunRecipeId(accountId), LAST_RUN_KEY, record);
}

export async function readAccountRun(engine: Engine, accountId: string): Promise<AccountRunRecord | null> {
  return getRecipeState<AccountRunRecord>(engine, accountRunRecipeId(accountId), LAST_RUN_KEY);
}

export async function forgetAccountRun(engine: Engine, accountId: string): Promise<void> {
  await engine.query(`DELETE FROM recipe_state WHERE recipe_id = $1`, [accountRunRecipeId(accountId)]);
}

export interface GrantExpiry {
  /** The last consent: when the current grant was issued. */
  granted_at: string;
  /** When the provider's test-mode limit would end it. */
  expires_at: string;
  days: number;
  /** `upcoming`: still running; `lapsed`: the account went to needs_reconnect, likely because of the limit. */
  state: "upcoming" | "lapsed";
  /** An upcoming end GRANT_WARN_DAYS or more after consent. */
  due_soon: boolean;
}

export interface GrantExpiryInput {
  provider: string;
  status: ConnectorAccountStatus;
  last_success_at: string | null;
  /** When the account started waiting on a reconnect, if it is. */
  reconnect_since: string | null;
}

export function grantExpiry(a: GrantExpiryInput, grantedAt: string | null, now: number): GrantExpiry | null {
  const days = TEST_MODE_GRANT_DAYS[a.provider];
  const granted = grantedAt === null ? Number.NaN : Date.parse(grantedAt);
  if (days === undefined || !Number.isFinite(granted)) return null;
  const expires = granted + days * DAY_MS;
  const lastSuccess = a.last_success_at === null ? Number.NaN : Date.parse(a.last_success_at);
  // A clean sync after the limit means the grant outlived it: not a test-mode app.
  if (Number.isFinite(lastSuccess) && lastSuccess > expires + SURVIVAL_MARGIN_MS) return null;
  const base = { granted_at: new Date(granted).toISOString(), expires_at: new Date(expires).toISOString(), days };
  if (a.status === "active") {
    if (now > expires + UPCOMING_GRACE_MS) return null;
    return { ...base, state: "upcoming", due_soon: now - granted >= GRANT_WARN_DAYS * DAY_MS };
  }
  if (a.status === "needs_reconnect") {
    const since = a.reconnect_since === null ? Number.NaN : Date.parse(a.reconnect_since);
    if (!Number.isFinite(since) || since - granted < GRANT_LAPSE_MIN_DAYS * DAY_MS) return null;
    return { ...base, state: "lapsed", due_soon: false };
  }
  return null;
}

export type AccountState = "sync on" | "sync off" | "needs a reconnect" | "paused" | "disconnected" | "revoke failed" | "error";

export interface AccountStatus {
  id: string;
  provider: string;
  source_id: string;
  services: string[];
  account_label: string;
  status: ConnectorAccountStatus;
  status_reason: string | null;
  enabled: boolean;
  state: AccountState;
  last_success_at: string | null;
  last_run: AccountRunRecord | null;
  needs_reconnect: boolean;
  /** When it started waiting on a reconnect: the sync engine's notice, else the status change. */
  reconnect_since: string | null;
  grant_expiry: GrantExpiry | null;
}

function stateOf(a: ConnectorAccount, needsReconnect: boolean): AccountState {
  if (needsReconnect) return "needs a reconnect";
  if (a.status === "revoked") return "disconnected";
  if (a.status === "error") return a.status_reason === "revoke_failed" ? "revoke failed" : "error";
  if (a.status === "paused") return "paused";
  return a.enabled ? "sync on" : "sync off";
}

/** Every account's status. Operator surfaces only: it covers every source. */
export async function listAccountStatus(engine: Engine, now: number = Date.now()): Promise<AccountStatus[]> {
  const accounts = await listAccounts(engine);
  if (accounts.length === 0) return [];
  const notices = await listOpenNotices(engine);
  // scope: operator-only the status surfaces date every account's grant
  const grants = await engine.query<{ account_id: string; created_at: Date | string }>(
    `SELECT account_id::text AS account_id, created_at FROM connector_credentials`,
  );
  const grantedAt = new Map(grants.rows.map((g) => [g.account_id, new Date(g.created_at).toISOString()]));
  const out: AccountStatus[] = [];
  for (const a of accounts) {
    const notice = notices.find((n) => n.account_id === a.id && n.kind === "needs_reconnect");
    const needsReconnect = a.status === "needs_reconnect" || notice !== undefined;
    const reconnectSince = !needsReconnect ? null : notice ? new Date(notice.created_at).toISOString() : a.updated_at;
    out.push({
      id: a.id,
      provider: a.provider,
      source_id: a.source_id,
      services: a.services,
      account_label: a.account_label,
      status: a.status,
      status_reason: a.status_reason,
      enabled: a.enabled,
      state: stateOf(a, needsReconnect),
      last_success_at: a.last_success_at,
      last_run: await readAccountRun(engine, a.id),
      needs_reconnect: needsReconnect,
      reconnect_since: reconnectSince,
      grant_expiry: grantExpiry(
        { provider: a.provider, status: needsReconnect ? "needs_reconnect" : a.status, last_success_at: a.last_success_at, reconnect_since: reconnectSince },
        grantedAt.get(a.id) ?? null,
        now,
      ),
    });
  }
  return out;
}

/** One sentence on a test-mode grant, for the CLI, doctor and notifications. */
export function grantExpiryText(g: GrantExpiry): string {
  const day = g.expires_at.slice(0, 10);
  const limit = `Google ends a Testing-mode grant ${g.days} days after consent`;
  return g.state === "lapsed"
    ? `likely the ${g.days}-day Testing-mode limit (granted ${g.granted_at.slice(0, 10)}): reconnect, or publish the Google app to stop the weekly expiry`
    : `${limit}; if the Google app is in Testing this grant ends around ${day}: reconnect before then, or publish the app`;
}
