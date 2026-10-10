/**
 * The operator's reads must not move when tenant scoping changes underneath
 * them. For a fixed two-tenant brain, every read below runs UNSCOPED through
 * `dispatchTool` and its SQL text, bound params and response are compared with
 * a recorded fixture.
 *
 * Re-record deliberately (and review the diff) with:
 *   MEMRAIN_RECORD_OPERATOR_PARITY=1 bun test tests/operator_scope_parity.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import {
  A, auth, B, CODE_SYM, ENTITY_SLUG, GATEWAY, KEYWORD, SHARED_PATH, SHARED_TITLE, seedTenantContract, WIKI_NAME,
} from "./helpers/tenant_seed.ts";

setDefaultTimeout(60000);

const FIXTURE = join(import.meta.dir, "fixtures", "operator_scope_parity.json");
const RECORD = process.env["MEMRAIN_RECORD_OPERATOR_PARITY"] === "1";

const CALLS: Array<[string, Record<string, unknown>]> = [
  ["search", { q: KEYWORD }],
  ["search", { q: SHARED_TITLE }],
  ["query", { q: KEYWORD }],
  ["get_chunks", { source_path: SHARED_PATH }],
  ["page_list", {}],
  ["page_get", { slug: GATEWAY }],
  ["get_links", { slug: GATEWAY }],
  ["backlinks", { name: WIKI_NAME }],
  ["get_tags", { slug: GATEWAY }],
  ["graph_neighbors", { slug: GATEWAY }],
  ["graph_query", { type: "mentions", source_slug: GATEWAY }],
  ["traverse_graph", { start_slug: GATEWAY, direction: "outbound", max_depth: 3 }],
  ["list_link_sources", {}],
  ["find_experts", { limit: 5 }],
  ["find_contradictions", {}],
  ["find_trajectory", { entity_slug: ENTITY_SLUG }],
  ["find_anomalies", { sigma: 1, limit: 50 }],
  ["find_orphans", {}],
  ["get_recent_salience", { limit: 100 }],
  ["entity_recall", { slug: ENTITY_SLUG }],
  ["entity_facts", { entity_slug: ENTITY_SLUG }],
  ["entity_timeline", { slug: ENTITY_SLUG }],
  ["resolve_slugs", { query: SHARED_TITLE }],
  ["code_def", { name: CODE_SYM }],
  ["code_refs", { name: CODE_SYM }],
  ["code_callers", { name: CODE_SYM }],
  ["code_callees", { target: `${SHARED_PATH}:2` }],
  ["code_flow", { symbol: CODE_SYM, exact: true }],
  ["code_blast", { symbol: CODE_SYM, exact: true }],
  ["list_takes", {}],
  ["takes_search", { q: "claim" }],
  ["list_concepts", {}],
  ["chronicle_since", { since: "2020-01-01" }],
  ["volunteer_context", { window: KEYWORD }],
  ["sources_list", {}],
  ["whoami", {}],
  ["page_versions", { slug: "team-b/alice" }],
  ["get_raw_data", { slug: "team-b/alice" }],
  ["get_ingest_log", {}],
  ["fact_supersessions", { limit: 500 }],
  ["recall", { id: "$factIdB" }],
  ["get_recent_transcripts", { days: 36500 }],
  ["source_health", {}],
  ["chronicle_day", { date: "2026-01-02" }],
  ["chronicle_on_this_day", { date: "2027-01-02" }],
  ["ontology_get", { entity: ENTITY_SLUG }],
];

type Recorded = { call: string; sql: Array<{ text: string; params: unknown }>; result: unknown };

let tmp: string;
let storage: Storage;
let factIdB = 0;

// Wall-clock values differ between runs, and recency decay moves scores in the
// ninth decimal as the clock ticks; everything else must be identical.
// The spend ledger binds latency_ms positionally, which the keyed scrub misses.
function scrubLatencyParam(text: string, params: unknown): unknown {
  const cols = /^INSERT INTO mcp_spend_log \(([^)]*)\)/.exec(text)?.[1];
  if (!cols || !Array.isArray(params)) return params;
  const i = cols.split(",").map((c) => c.trim()).indexOf("latency_ms");
  return i < 0 ? params : params.map((p, j) => (j === i && typeof p === "number" ? 0 : p));
}

function scrub(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value ?? null)
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/g, "<ts>")
      // Writes stamp today's date (valid_from, since windows); fixed seed dates stay 2026-01-0x.
      .replace(/20(?!26-01-0)\d{2}-\d{2}-\d{2}/g, "<date>")
      .replace(/(latency_?[mM]s|elapsed_?[mM]s|took_?[mM]s|durationMs|lag_seconds)(\\?"):\s*\d+(?:\.\d+)?/g, "$1$2:0")
      // Scores also sit inside the serialized tool text, out of a reviver's reach.
      .replace(/(\d\.\d{6})\d+/g, "$1"),
  );
}

async function record(): Promise<Recorded[]> {
  const engine = storage.engine();
  const original = engine.query.bind(engine);
  const out: Recorded[] = [];
  let current: Recorded | undefined;
  (engine as { query: typeof engine.query }).query = async (text, params) => {
    const flat = text.replace(/\s+/g, " ").trim();
    current?.sql.push({ text: flat, params: scrub(scrubLatencyParam(flat, params)) });
    return original(text, params);
  };
  try {
    for (const [name, args] of CALLS) {
      const resolved = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v === "$factIdB" ? factIdB : v]));
      current = { call: `${name} ${JSON.stringify(args)}`, sql: [], result: null };
      const res = await dispatchTool(storage, { name, arguments: resolved });
      current.result = scrub(res);
      out.push(current);
    }
  } finally {
    (engine as { query: typeof engine.query }).query = original;
  }
  return out;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-operator-parity-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  ({ factIdB } = await seedTenantContract(storage));
  const write = (name: string, args: Record<string, unknown>, who: AuthInfo): Promise<ToolCallResult> =>
    dispatchTool(storage, { name, arguments: args }, { authInfo: who });
  for (const [who, tag, slug] of [[A, "AAA", "team-a/alice"], [B, "BBB", "team-b/alice"]] as const) {
    await write("put_raw_data", { slug, source: "parity", data: { note: `${tag}_RAW_note` } }, auth(who));
    await write("log_ingest", { source_type: "parity", source_ref: `${tag}_INGEST_ref` }, auth(who));
    await write("ontology_propose", { entity: ENTITY_SLUG, dimension: "role", value: `${tag}_ONTO`, visibility: "world" }, auth(who));
    await write("add_timeline_event", { slug, occurred_at: "2026-01-02T12:00:00Z", event: `${tag}_EVENT_fixed` }, auth(who));
    await write("page_append", { slug, content: `${tag}_APPENDED` }, auth(who));
  }
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("operator scope parity", () => {
  it("unscoped reads issue the recorded SQL and return the recorded responses", async () => {
    const actual = await record();
    if (RECORD || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
      if (!RECORD) throw new Error(`fixture was missing and has been written to ${FIXTURE}; review and re-run`);
      return;
    }
    const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as Recorded[];
    expect(actual.map(r => r.call)).toEqual(expected.map(r => r.call));
    for (let i = 0; i < expected.length; i++) {
      expect({ call: actual[i]!.call, sql: actual[i]!.sql }).toEqual({ call: expected[i]!.call, sql: expected[i]!.sql });
      expect({ call: actual[i]!.call, result: actual[i]!.result }).toEqual({ call: expected[i]!.call, result: expected[i]!.result });
    }
  });
});
