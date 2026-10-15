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
