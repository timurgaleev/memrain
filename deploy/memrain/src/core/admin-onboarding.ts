/**
 * First-run state for the admin setup checklist, read from rows the brain
 * already keeps. A progress step counts as done once it has ever happened, so
 * revoking a credential later does not untick "connected" and deleting the
 * only page does not untick "first page"; only the credential step reports
 * the current state. An OAuth sign-in that made no call is the one exception:
 * revoking the client deletes its tokens, and nothing else records it.
 */
import type { Engine } from "./engine/interface.ts";
import { AGENT_CALL, NOT_PANEL_ROW } from "./admin-timeseries.ts";

export interface OnboardingSteps {
  /** An active credential exists now. */
  credential: { done: boolean };
  agent_connected: { done: boolean; last_seen: string | null };
  first_page: { done: boolean; pages: number };
  /** "agent" when an agent searched; "any" when only some other search ran. */
  first_search: { done: boolean; source: "agent" | "any" | null };
}

export interface OnboardingStatus {
  /** The MCP endpoint agents connect to. */
  mcp_url: string;
  /** Whether MEMRAIN_PUBLIC_URL declares the public address. */
  public_url_set: boolean;
  steps: OnboardingSteps;
}

export async function onboardingSteps(engine: Engine): Promise<OnboardingSteps> {
  // last_seen takes the newest of: a successful agent call, a PAT that
  // authenticated, and an issued OAuth access token (a completed sign-in).
  // GREATEST skips NULLs.
  const r = await engine.query<{
    credential: boolean;
    last_seen_ms: number | string | null;
    pages: number;
    ever_page: boolean;
    agent_search: boolean;
    any_search: boolean;
  }>(
    `SELECT
       (EXISTS (SELECT 1 FROM access_tokens WHERE revoked_at IS NULL)
        OR EXISTS (SELECT 1 FROM oauth_clients WHERE deleted_at IS NULL)) AS credential,
       (extract(epoch FROM GREATEST(
          (SELECT max(created_at) FROM mcp_request_log
            WHERE ${NOT_PANEL_ROW} AND ${AGENT_CALL} AND status = 'success'),
          (SELECT max(last_used_at) FROM access_tokens),
          (SELECT max(created_at) FROM oauth_tokens WHERE token_type = 'access'))) * 1000)::float8 AS last_seen_ms,
       (SELECT count(*) FROM pages WHERE deleted_at IS NULL)::int AS pages,
       EXISTS (SELECT 1 FROM page_versions) AS ever_page,
       EXISTS (SELECT 1 FROM mcp_request_log
                WHERE (${NOT_PANEL_ROW}) AND (operation IN ('search', 'query')) AND status = 'success') AS agent_search,
       EXISTS (SELECT 1 FROM search_telemetry) AS any_search`,
  );
  const row = r.rows[0];
  const lastSeen = row?.last_seen_ms == null ? null : new Date(Number(row.last_seen_ms)).toISOString();
  const pages = Number(row?.pages ?? 0);
  const source = row?.agent_search ? "agent" : row?.any_search ? "any" : null;
  return {
    credential: { done: row?.credential === true },
    agent_connected: { done: lastSeen !== null, last_seen: lastSeen },
    first_page: { done: pages > 0 || row?.ever_page === true, pages },
    first_search: { done: source !== null, source },
  };
}
