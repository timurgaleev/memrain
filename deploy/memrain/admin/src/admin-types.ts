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
    facts?: number;
    entities?: number;
    links?: number;
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

export interface SpendGroup {
  key: string | null;
  calls: number;
  usd: number;
  input_tokens: number;
  output_tokens: number;
}

export interface SpendReport {
  since: string;
  days: number;
  total_usd: number;
  calls: number;
  by_model: SpendGroup[];
  by_operation: SpendGroup[];
  by_client: SpendGroup[];
  outcomes: SpendGroup[];
  latency?: { operation: string; calls: number; p50_ms: number; p95_ms: number }[];
  coverage: {
    unpriced_calls: number;
    unpriced_models: string[];
    no_usage_calls: number;
    tokens_unrecorded_calls: number;
  };
  today: {
    brain_usd: number;
    brain_cap_usd: number | null;
    cycle_usd: number;
    cycle_cap_usd: number | null;
  };
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

export interface JobsWatch {
  counts: { status: string; n: number }[];
  recent: {
    id: string;
    kind: string;
    status: string;
    retry_count: number;
    last_error: string | null;
    created_at: string;
    finished_at: string | null;
  }[];
}

export interface FeedEvent {
  agent: string;
  operation: string;
  latency_ms: number;
  status: string;
  timestamp: string;
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

// GET /admin/api/timeseries (core/admin-timeseries.ts). Per-day arrays hold one
// entry per bucket, in bucket order; days are UTC.
export interface TsTotals {
  requests: number; errors: number; searches: number;
  usd: number; priced_calls: number; unpriced_calls: number;
  pages_created: number; page_edits: number; facts_added: number;
}

export interface AdminTimeseries {
  days: 7 | 30 | 90;
  since: string;
  generated_at: string;
  buckets: string[];
  requests: { day: string; requests: number; errors: number }[];
  searches: { day: string; searches: number }[];
  spend: { day: string; usd: number; priced_calls: number; unpriced_calls: number; by_model: Record<string, number> }[];
  spend_models: { key: string; label: string }[];
  content: { day: string; pages_created: number; page_edits: number; facts_added: number }[];
  corpus_now: { pages: number; facts: number };
  top_tools: { operation: string; calls: number; errors: number }[];
  top_agents: { id: string; agent: string; calls: number }[];
  totals: TsTotals;
  /** The equal-length window just before; searches cover completed days only. */
  previous: TsTotals;
  request_log: { db_enabled: boolean; rows_in_window: number; retention_days: number | null };
  brain_cap_usd: number | null;
}

// GET /admin/api/graph/hubs (core/links.ts graphHubs)
export interface GraphHubs {
  hubs: { slug: string; title: string | null; type: string; in_degree: number; out_degree: number; degree: number }[];
  linked_pages: number;
  total_links: number;
  total_pages: number;
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
