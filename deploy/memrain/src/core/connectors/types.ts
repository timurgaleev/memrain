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
export class ReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReauthRequiredError";
  }
}
