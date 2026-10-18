/**
 * mcp/request-log-db.ts — DB sink for the MCP request log
 * (`mcp_request_log`, migration 046), the table the admin Request Log page
 * reads. memrain's default request observability is the JSONL audit trail +
 * console line (param-redaction.ts `logToolCall`); this adds a THIRD sink — a
 * redacted row per tool call — for the in-dashboard feed.
 *
 * Two enablement paths:
 *   - `MEMRAIN_REQUEST_LOG_DB=1` turns the sink on for ALL ingress classes
 *     (opt-in, default OFF — the hot path takes no extra write).
 *   - `force: true` on an entry logs it regardless of the flag. The MCP
 *     transport passes this for every caller with a credential (OAuth or
 *     personal access token), including REJECTIONS (scope, public-forbidden,
 *     internal-token, rate-limit), and the admin panel for its own tool
 *     calls, so those rows are written on every install. The purge phase
 *     prunes them (core/request-log-retention.ts).
 *
 * Fire-and-forget + fully swallowed: a logging failure must never turn a
 * successful tool call into an error. Redacted: only the param SUMMARY
 * (`summarizeMcpParams`) and a known-only operation name are stored — never
 * raw param values, never an unknown caller-controlled name.
 */
import type { Engine } from "../core/engine/interface.ts";
import { summarizeMcpParams, isKnownTool } from "./param-redaction.ts";

/** Whether the DB request-log sink is enabled for every ingress class. */
export function requestLogDbEnabled(): boolean {
  return process.env["MEMRAIN_REQUEST_LOG_DB"] === "1";
}

/**
 * Server-side operation labels that are not MCP tools but must survive the
 * known-name gate: JSON-RPC method logging and transport-level rejections.
 */
const INTERNAL_OPERATIONS: ReadonlySet<string> = new Set([
  "tools/list",
  "rate_limited",
  "webhook_ingest",
]);

export interface RequestLogEntry {
  /** The MCP tool name (stored only when declared; else "unknown"). */
  tool: string;
  /** Caller identity — an OAuth client id, else the ingress class. */
  agentName: string;
  /** Credential identity (OAuth client id) for the `token_name` column. */
  tokenName?: string;
  /** Wall-clock dispatch latency in ms. */
  latencyMs: number;
  /** Whether the tool call succeeded. */
  ok: boolean;
  /** Raw params — redacted to a summary before storage, never stored raw. */
  params: unknown;
  /** Short failure description for the `error_message` column. */
  errorMessage?: string;
  /** Log even when MEMRAIN_REQUEST_LOG_DB is off (credentialed callers, admin panel). */
  force?: boolean;
}

/**
 * Insert one redacted row into `mcp_request_log`. No-op unless the sink is
 * enabled (env flag) or the entry is forced (OAuth ingress). Fire-and-forget:
 * returns immediately; the insert runs detached and any fault (including a
 * missing table on a pre-046 brain) is swallowed.
 */
export function logToolCallToDb(engine: Engine, e: RequestLogEntry): void {
  if (!requestLogDbEnabled() && e.force !== true) return;
  const operation =
    isKnownTool(e.tool) || INTERNAL_OPERATIONS.has(e.tool) ? e.tool : "unknown";
  const summary = summarizeMcpParams(e.tool, e.params);
  void engine
    .query(
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, error_message, params)
       VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb)`,
      [
        e.tokenName ?? null,
        e.agentName,
        operation,
        Math.round(e.latencyMs),
        e.ok ? "success" : "error",
        // Cap defensively — the admin reader truncates at 300 chars anyway.
        e.errorMessage != null ? e.errorMessage.slice(0, 500) : null,
        JSON.stringify(summary),
      ],
    )
    .catch(() => {
      /* best-effort — never break request handling */
    });
}
