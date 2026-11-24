// Response shapes of the plain admin JSON routes (http/admin-api.ts). These
// are the panel's own routes, so they are typed rather than guarded field by
// field; tool results go through lib/tool-result.ts instead.

export interface FullStats {
  health: {
    embed_coverage_pct: number;
    embeddable_chunks: number;
    embedded_chunks: number;
    lag_seconds: number | null;
    queue_depth: number;
    failed_jobs_24h: number;
  } | null;
  counts: {
    documents: number;
    pages: number;
    chunks: number;
    links: number;
  } | null;
}

export interface HealthBody {
  ok: boolean;
  version?: string;
  maintenance?: boolean;
  [k: string]: unknown;
}

export interface Stats {
  connected_agents?: number;
  active_tokens?: number;
  active_api_keys?: number;
  requests_today?: number;
}

export interface HealthIndicators {
  tokens_expiring_24h: number;
  error_rate_24h: number;
}

export interface AgentSpendRow {
  client_id: string;
  client_name: string | null;
  cap_usd_per_day: number | string | null;
  spent_cents_today: number | string;
  pending_cents: number | string;
}

export interface AgentUsageRow {
  auth_type: "oauth" | "api_key";
  id: string;
  name: string;
  status: string;
  usage: { requests_today: number; total_requests: number; last_used_at: string | null };
}

/**
 * Fraction of today's cap an agent has committed, or null when it has no cap.
 * Live reservations count, as they do when the budget is enforced.
 */
export function capUse(row: AgentSpendRow): number | null {
  const cap = Number(row.cap_usd_per_day);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  const committed = (Number(row.spent_cents_today) + Number(row.pending_cents)) / 100;
  return Number.isFinite(committed) ? committed / cap : null;
}

// GET /admin/api/onboarding
export interface OnboardingStatus {
  mcp_url: string;
  public_url_set: boolean;
  steps: {
    credential: { done: boolean };
    agent_connected: { done: boolean; last_seen: string | null };
    first_page: { done: boolean; pages: number };
    first_search: { done: boolean; source: "agent" | "any" | null };
  };
}

// GET /admin/api/health-report (core/admin-health.ts)
export interface HealthReport {
  migrations: { head: number; applied: number; files_readable: boolean; pending: number[]; ahead: number[]; gaps: number[] };
  housekeeping: { finished_at: string; errors: number } | null;
  spend_today: { usd: number; cap_usd: number | null };
  review: { write_gate_holds: number; row_holds: number; quarantined: number };
}

/**
 * What waits for the operator, each with the command that works it. There is
 * no review page in the panel: holds and quarantine are decided on the server.
 */
export function reviewItems(r: HealthReport["review"]): { label: string; command: string }[] {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const out: { label: string; command: string }[] = [];
  if (r.write_gate_holds > 0) {
    out.push({ label: `${plural(r.write_gate_holds, "write held", "writes held")} by the write gate`, command: "memrain write-gate list" });
  }
  if (r.row_holds > 0) out.push({ label: `${plural(r.row_holds, "row held", "rows held")} by the write gate`, command: "memrain write-gate rows" });
  if (r.quarantined > 0) {
    out.push({ label: `${plural(r.quarantined, "page", "pages")} in quarantine, hidden from search`, command: "memrain quarantine list" });
  }
  return out;
}
