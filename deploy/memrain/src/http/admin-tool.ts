/**
 * http/admin-tool.ts — `POST /admin/api/tool`, the admin panel's brain explorer.
 *
 * Runs one allowlisted MCP tool for the logged-in operator. The route sits
 * behind the shared admin session + same-origin gate in admin-api.ts and adds
 * its own: exact JSON media type, a small body cap, a fixed tool allowlist
 * (reads plus the reversible tag writes), per-tool argument allowlists with
 * clamps, and one rate-limit bucket for the calls that embed a query.
 *
 * Dispatch runs with `adminPanel: true`, so the operator's browsing touches no
 * retrieval signal, captures no eval candidates and spends nothing generative.
 * Every call is logged as agent `admin-panel` with a NULL token name, which
 * keeps it apart from every PAT and OAuth row.
 */
import { dispatchTool } from "../mcp/dispatch.ts";
import type { SearchOptions } from "../core/search/hybrid.ts";
import { logToolCallToDb } from "../mcp/request-log-db.ts";
import { publishToolCallEvent } from "./admin-events.ts";
import { readBodyWithCap } from "./body_limit.ts";
import { RateLimiter } from "../mcp/rate_limit.ts";
import { extractErrorMessage } from "../mcp/http_transport.ts";
import type { Storage } from "../core/storage.ts";

export const ADMIN_TOOL_BODY_CAP = 16_384;
export const ADMIN_TOOL_RESPONSE_CAP = 1_048_576; // chars of content[0].text
export const ADMIN_PANEL_AGENT = "admin-panel";

export interface AdminToolDeps {
  storage: Storage;
  /** Shared bucket for embedding-producing calls. Tests inject their own. */
  toolLimiter?: RateLimiter;
  /** Hermetic query-embedder seam, forwarded to dispatch (tests only). */
  embedQuery?: SearchOptions["embedQuery"];
}

type ArgRule =
  | { kind: "str"; max: number }
  | { kind: "int"; lo: number; hi: number }
  | { kind: "bool" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "factId" };

const str = (max: number): ArgRule => ({ kind: "str", max });
const int = (lo: number, hi: number): ArgRule => ({ kind: "int", lo, hi });
const bool: ArgRule = { kind: "bool" };
const oneOf = (...values: string[]): ArgRule => ({ kind: "enum", values });

// The only keys each tool may receive. Anything else is dropped before
// dispatch, so `mode`, `expand`, `include_deleted`, `narrative` and friends
// never reach a handler whatever MEMRAIN_MCP_LENIENT_ARGS says.
const ARG_RULES = new Map<string, Readonly<Record<string, ArgRule>>>([
  ["search", { q: str(200), k: int(1, 20), offset: int(0, 100), since: str(40), until: str(40) }],
  ["resolve_slugs", { query: str(200), limit: int(1, 10) }],
  ["page_get", { slug: str(512), fuzzy: bool }],
  [
    "page_list",
    {
      type: str(64),
      tag: str(100),
      since: str(40),
      sort: oneOf("updated_desc", "updated_asc", "created_desc", "slug"),
      limit: int(1, 50),
    },
  ],
  ["page_versions", { slug: str(512), limit: int(1, 10) }],
  ["get_links", { slug: str(512), limit: int(1, 200) }],
  ["get_tags", { slug: str(512) }],
  ["graph_neighbors", { slug: str(512), type: str(64), direction: oneOf("outbound", "inbound", "both"), limit: int(1, 60) }],
  ["entity_recall", { slug: str(512), query: str(200), fact_limit: int(1, 50), timeline_limit: int(1, 50) }],
  ["entity_facts", { entity_slug: str(512), order: oneOf("confidence", "recency"), since: str(40), limit: int(1, 100) }],
  ["entity_timeline", { slug: str(512), since: str(40), until: str(40), limit: int(1, 100) }],
  ["fact_supersessions", { entity_slug: str(512), limit: int(1, 100) }],
  ["recall", { id: { kind: "factId" } }],
  ["chronicle_since", { since: str(40), kind: str(64), limit: int(1, 100) }],
  ["chronicle_day", { date: str(40), week: bool, kind: str(64), limit: int(1, 100) }],
  ["chronicle_on_this_day", { date: str(40), limit: int(1, 100) }],
  ["add_tag", { slug: str(512), tag: str(100) }],
  ["remove_tag", { slug: str(512), tag: str(100) }],
]);

export const ADMIN_TOOLS: ReadonlySet<string> = new Set(ARG_RULES.keys());

const FACT_ID = /^[1-9]\d{0,15}$/;

/**
 * Build a fresh argument object holding only the tool's allowlisted keys,
 * with numbers clamped. A value of the wrong type is dropped; an over-long
 * string fails the whole call.
 */
export function sanitizeAdminToolArgs(
  name: string,
  args: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const rules = ARG_RULES.get(name);
  if (!rules) return { ok: false, error: `tool '${name}' is not allowed` };
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(rules)) {
    if (!Object.hasOwn(args, key)) continue;
    const v = args[key];
    switch (rule.kind) {
      case "str":
        if (typeof v !== "string") break;
        if (v.length > rule.max) return { ok: false, error: `\`${key}\` exceeds ${rule.max} characters` };
        out[key] = v;
        break;
      case "int":
        if (typeof v !== "number" || !Number.isFinite(v)) break;
        out[key] = Math.min(rule.hi, Math.max(rule.lo, Math.trunc(v)));
        break;
      case "bool":
        if (typeof v === "boolean") out[key] = v;
        break;
      case "enum":
        if (typeof v === "string" && rule.values.includes(v)) out[key] = v;
        break;
      case "factId":
        if (typeof v === "number" && Number.isFinite(v)) {
          out[key] = Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.trunc(v)));
        } else if (typeof v === "string" && FACT_ID.test(v) && Number.isSafeInteger(Number(v))) {
          // recall takes an integer id; a JSON client may hold it as text.
          out[key] = Number(v);
        }
        break;
    }
  }
  return { ok: true, args: out };
}

const defaultLimiter = new RateLimiter({ capacity: 30, refillPerSecond: 0.5 });

const fail = (status: number, error: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>): Response =>
  Response.json({ ok: false, error, ...extra }, { status, ...(headers ? { headers } : {}) });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Calls that spend a query embedding go through the bucket. */
function embeds(name: string, args: Record<string, unknown>): boolean {
  if (name === "search") return true;
  return name === "entity_recall" && typeof args["query"] === "string" && args["query"].trim() !== "";
}

/** page_list rows without the heavy body fields; the list view never shows them. */
function projectPageList(data: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(data["pages"])) return data;
  const pages = data["pages"].map((row: unknown) => {
    if (!isPlainObject(row)) return row;
    const { markdown_body: _body, compiled_truth: _truth, ...rest } = row;
    return rest;
  });
  return { ...data, pages };
}

/** Map a tool error result to a 422 that carries validated envelope text only. */
function toolErrorResponse(name: string, text: string): Response {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (isPlainObject(parsed) && typeof parsed["error"] === "string") {
    return fail(422, parsed["error"], {
      ...(typeof parsed["message"] === "string" ? { message: parsed["message"] } : {}),
      ...(typeof parsed["suggestion"] === "string" ? { suggestion: parsed["suggestion"] } : {}),
    });
  }
  // Plain or raw exception text can carry SQL; it stays in the server log.
  console.error(`[admin-api] tool ${name} failed:`, text.slice(0, 500));
  return fail(422, "tool_error");
}

export async function handleAdminTool(req: Request, deps: AdminToolDeps): Promise<Response> {
  if (req.method !== "POST") return fail(405, "method_not_allowed");

  const essence = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (essence !== "application/json") return fail(415, "unsupported_media_type");

  const read = await readBodyWithCap(req, ADMIN_TOOL_BODY_CAP);
  if (!read.ok) return read.response;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(read.buf));
  } catch {
    return fail(400, "invalid_json");
  }

  if (!isPlainObject(body) || typeof body["name"] !== "string") return fail(400, "invalid_request");
  const rawArgs = body["arguments"] === undefined ? {} : body["arguments"];
  if (!isPlainObject(rawArgs)) return fail(400, "invalid_request");
  const name = body["name"];

  const engine = deps.storage.engine();
  const started = Date.now();
  // Refused calls are audited too; the tool name is caller-supplied until the
  // allowlist check passes, so it is cut to a bounded length.
  const audit = (tool: string, params: Record<string, unknown>, ok: boolean, errorMessage?: string): void => {
    const latencyMs = Date.now() - started;
    logToolCallToDb(engine, {
      tool,
      agentName: ADMIN_PANEL_AGENT,
      latencyMs,
      ok,
      params,
      force: true,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    });
    publishToolCallEvent({ tool, agent: ADMIN_PANEL_AGENT, latencyMs, ok });
  };

  if (!ADMIN_TOOLS.has(name)) {
    audit(name.slice(0, 64), {}, false, "tool_not_allowed");
    return fail(403, "tool_not_allowed");
  }

  const sanitized = sanitizeAdminToolArgs(name, rawArgs);
  if (!sanitized.ok) {
    audit(name, {}, false, "invalid_arguments");
    return fail(400, "invalid_arguments", { message: sanitized.error });
  }
  const args = sanitized.args;
  const record = (ok: boolean, errorMessage?: string): void => audit(name, args, ok, errorMessage);

  const limiter = deps.toolLimiter ?? defaultLimiter;
  if (embeds(name, args) && !limiter.allow(ADMIN_PANEL_AGENT)) {
    record(false, "rate_limited");
    return fail(429, "rate_limited", { retry_after_s: 2 }, { "Retry-After": "2" });
  }

  let result: Awaited<ReturnType<typeof dispatchTool>>;
  try {
    result = await dispatchTool(
      deps.storage,
      { name, arguments: args },
      { adminPanel: true, signal: req.signal, ...(deps.embedQuery ? { embedQuery: deps.embedQuery } : {}) },
    );
  } catch (e) {
    if (req.signal.aborted) {
      record(false, "client_aborted");
      return fail(499, "client_aborted");
    }
    console.error(`[admin-api] tool ${name} threw:`, e instanceof Error ? e.message : e);
    record(false, "internal error");
    return fail(500, "internal error");
  }
  if (req.signal.aborted) {
    record(false, "client_aborted");
    return fail(499, "client_aborted");
  }

  const text = result.content?.[0]?.text ?? "";
  // Logged once the outcome is known, so a result the route refuses is an error.
  if (text.length > ADMIN_TOOL_RESPONSE_CAP) {
    record(false, "response_too_large");
    return fail(422, "response_too_large");
  }
  if (result.isError) {
    record(false, extractErrorMessage(text));
    return toolErrorResponse(name, text);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    record(false, "bad_tool_output");
    return fail(502, "bad_tool_output");
  }
  record(true);
  if (name === "page_list" && isPlainObject(data)) data = projectPageList(data);
  return Response.json({ ok: true, data });
}
