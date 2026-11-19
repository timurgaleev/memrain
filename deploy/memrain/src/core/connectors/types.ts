/**
 * Shared vocabulary of the connector seam: what a provider response means, how
 * a run ended, and what a run leaves behind in `recipe_state`.
 */

/** What one provider response means for the caller. */
export type ResponseClass =
  | "ok"
  | "rate_limited"
  | "auth_required"
  | "forbidden"
  | "challenge"
  | "server_error";

/**
 * How a connector run ended.
 *
 *   success       — every page fetched, every item written, unchanged, or
 *                   refused for a reason a retry cannot fix (kept in the
 *                   connector's refusal ledger);
 *   nothing_new   — the delta was empty;
 *   partial       — an item failed in a way a retry may fix, or the run
 *                   stopped on a rate limit, a challenge page or a server error;
 *   auth_required — the provider refused the credential (expired or revoked);
 *   forbidden     — the credential is valid but may not read the target.
 *
 * Only `success` and `nothing_new` move the watermark: anything else would skip
 * the items the run never saw.
 */
export type ConnectorRunStatus = "success" | "nothing_new" | "partial" | "auth_required" | "forbidden";

export const CONNECTOR_RUN_STATUSES: readonly ConnectorRunStatus[] = [
  "success",
  "nothing_new",
  "partial",
  "auth_required",
  "forbidden",
];

/** A status that means the watermark may advance. */
export function isCleanRun(status: ConnectorRunStatus): boolean {
  return status === "success" || status === "nothing_new";
}

/** A status that means the operator has to fix the credential or its grant. */
export function needsReauth(status: ConnectorRunStatus): boolean {
  return status === "auth_required" || status === "forbidden";
}

export interface ConnectorRunCounts {
  items: number;
  pages_written: number;
  pages_unchanged: number;
  items_rejected: number;
  items_failed: number;
}

/** The `last_run` row a connector leaves in `recipe_state`. Never holds a credential. */
export interface ConnectorRunRecord {
  provider: string;
  target: string;
  source_id: string;
  status: ConnectorRunStatus;
  /** ISO time the run finished. */
  at: string;
  counts: ConnectorRunCounts;
  /** The response class that ended the run early, when one did. */
  error_class: ResponseClass | null;
  /** HTTP status behind `error_class`, when there was a response. */
  http_status: number | null;
  /** ISO time of the most recent clean run, carried forward across failed runs. */
  last_success_at: string | null;
}

/**
 * The provider refused to renew the credential (`invalid_grant`, a revoked
 * refresh token): only the owner reconnecting the account fixes it. A token
 * source throws it; the client reports the request `auth_required` with
 * `reauth`, and the sync engine pauses the account as needing a reconnect.
 */
/**
 * The account's provider has no sync adapter in this process (an OAuth-only
 * provider, or one this build does not ship): there is nothing to run, and
 * a scheduled run skips the account instead of failing its whole source.
 */
export class ProviderCannotSyncError extends Error {
  constructor(readonly provider: string) {
    super(`connector provider '${provider}' cannot sync`);
    this.name = "ProviderCannotSyncError";
  }
}

/**
 * The token endpoint refused the OAuth app itself (`invalid_client`: a wrong
 * or expired client secret, an app the provider no longer knows). No
 * reconnect fixes it and every account of the app fails alike, so it is the
 * operator's to fix: save the app's current secret, or the right app.
 */
export class OAuthClientRejectedError extends Error {
  constructor(readonly code: "invalid_client", readonly serviceCode: number | null = null) {
    super(`the provider refused the OAuth app (${code}${serviceCode === null ? "" : `, code ${serviceCode}`})`);
    this.name = "OAuthClientRejectedError";
  }
}

export class ReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

/**
 * The token endpoint would not renew this one account's access with the app
 * (`unauthorized_client`). With one app for several directories this is the
 * account's own: its organization disabled the app (Microsoft AADSTS7000112)
 * or removed it (AADSTS700016), the app no longer admits this kind of
 * account, or (Google) the token was issued to another app. Its siblings of
 * the same app may renew fine, so only this account waits for a reconnect,
 * and the message, codes only, is the reason shown on its row.
 */
export class AccountAppRefusedError extends ReauthRequiredError {
  constructor(readonly serviceCode: number | null = null) {
    super(`the provider refused to renew this account for the app (unauthorized_client${serviceCode === null ? "" : `, code ${serviceCode}`}): `
      + "its organization may have disabled or removed the app; ask its admin, then reconnect");
    this.name = "AccountAppRefusedError";
  }
}
