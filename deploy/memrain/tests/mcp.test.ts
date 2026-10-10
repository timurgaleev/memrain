/**
 * MCP HTTP transport tests — exercise initialize / tools/list / tools/call
 * over a real Bun.serve and a fresh PGLite. Avoids Bedrock by seeding the
 * DB directly and only testing the cheap tools (stats, backlinks).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import { RateLimiter } from "../src/mcp/rate_limit.ts";
import { TOOL_DEFS } from "../src/mcp/tool_defs.ts";
import { VERSION } from "../src/version.ts";

let tmp: string;
let storage: Storage;
let server: ServerHandle;
let url: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-mcp-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  server = startServer({ host: "127.0.0.1", port: 0, storage });
  url = `http://127.0.0.1:${server.port}/mcp`;
});

afterEach(async () => {
  await server.stop();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function rpc(body: unknown): Promise<any> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

describe("MCP HTTP transport", () => {
  it("rejects GET", async () => {
    const r = await fetch(url, { method: "GET" });
    expect(r.status).toBe(405);
  });

  it("returns parse error on bad JSON", async () => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("initialize returns server info + protocol version", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(r.result.serverInfo.name).toBe("memrain");
    expect(r.result.protocolVersion).toBeTruthy();
    expect(r.result.capabilities.tools).toBeDefined();
    expect(r.result.serverInfo.version).toBe(VERSION);
    expect(r.result.serverInfo.version).not.toBe("0.1.0");
    expect(typeof r.result.instructions).toBe("string");
    expect(r.result.instructions).toContain("page_put");
    expect(r.result.instructions).toContain("whoami");
    expect(r.result._meta.memexResponseVersion).toBeDefined();
  });

  it("initialize echoes a supported protocolVersion and answers anything else with the latest", async () => {
    for (const v of ["2025-03-26", "2025-06-18", "2025-11-25"]) {
      const r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v } });
      expect(r.result.protocolVersion).toBe(v);
    }
    for (const params of [{ protocolVersion: "2024-11-05" }, { protocolVersion: 7 }, {}]) {
      const r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params });
      expect(r.result.protocolVersion).toBe("2025-11-25");
    }
    // Nothing else in the 2025-03-26 handshake changes.
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    expect(Object.keys(r.result).sort()).toEqual(
      ["_meta", "capabilities", "instructions", "protocolVersion", "serverInfo"],
    );
    expect(r.result.capabilities).toEqual({ tools: {} });
  });

  it("refuses an unsupported MCP-Protocol-Version header after initialize, accepts a supported or absent one", async () => {
    const call = (version: string | null, method = "ping") =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(version ? { "MCP-Protocol-Version": version } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { protocolVersion: "2025-06-18" } }),
      });
    expect((await call("1999-01-01")).status).toBe(400);
    expect((await call("2025-06-18")).status).toBe(200);
    expect((await call("2025-03-26")).status).toBe(200);
    expect((await call(null)).status).toBe(200);
    // initialize itself is where the version is negotiated, so it is not judged by the header.
    expect((await call("1999-01-01", "initialize")).status).toBe(200);
  });

  it("tools/list returns the registered tools", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(r.result.tools.length).toBe(TOOL_DEFS.length);
    const names = r.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      "add_fact",
      "add_tag",
      "add_timeline_event",
      "advisor",
      "backlinks",
      "chronicle_backfill",
      "chronicle_day",
      "chronicle_last_seen",
      "chronicle_on_this_day",
      "chronicle_since",
      "code_blast",
      "code_callees",
      "code_callers",
      "code_def",
      "code_flow",
      "code_refs",
      "context_pack",
      "entity_facts",
      "entity_recall",
      "entity_timeline",
      "extract_facts",
      "fact_supersessions",
      "find_anomalies",
      "find_contradictions",
      "find_experts",
      "find_orphans",
      "find_trajectory",
      "forget_fact",
      "get_agent_job",
      "get_brain_identity",
      "get_calibration_profile",
      "get_chunks",
      "get_ingest_log",
      "get_job_progress",
      "get_links",
      "get_raw_data",
      "get_recent_salience",
      "get_recent_transcripts",
      "get_skill",
      "get_status_snapshot",
      "get_tags",
      "graph_neighbors",
      "graph_query",
      "index",
      "jobs_cancel",
      "jobs_get",
      "jobs_list",
      "jobs_logs",
      "jobs_submit",
      "link",
      "list_brain_skillpack",
      "list_concepts",
      "list_link_sources",
      "list_skills",
      "list_takes",
      "log_friction",
      "log_ingest",
      "ontology_conflicts",
      "ontology_dimensions",
      "ontology_get",
      "ontology_propose",
      "page_append",
      "page_delete",
      "page_edit",
      "page_get",
      "page_list",
      "page_put",
      "page_restore",
      "page_revert",
      "page_versions",
      "purge_deleted_pages",
      "put_raw_data",
      "query",
      "recall",
      "relational_recall",
      "remove_tag",
      "resolve_slugs",
      "retry_job",
      "run_doctor",
      "search",
      "set_take_status",
      "source_health",
      "sources_list",
      "sources_status",
      "stats",
      "submit_agent",
      "takes_calibration",
      "takes_scorecard",
      "takes_search",
      "think",
      "traverse_graph",
      "unlink",
      "volunteer_chronicle",
      "volunteer_context",
      "whoami",
    ]);
  });

  it("tools/call stats returns counts", async () => {
    const r = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "stats" },
    });
    expect(r.result.content[0].type).toBe("text");
    const parsed = JSON.parse(r.result.content[0].text);
    expect(parsed.documents).toBe(0);
    expect(parsed.chunks).toBe(0);
  });

  it("tools/call unknown returns isError content (not JSON-RPC error)", async () => {
    const r = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "no-such-tool" },
    });
    expect(r.result.isError).toBe(true);
    // The stable contract is the structured `error` code, not the prose — this
    // request is internal ingress (no bearer) so the message is also present,
    // but assert on the code so the test survives the public message-drop.
    const env = JSON.parse(r.result.content[0].text);
    expect(env.error).toBe("not_found");
    expect(env.message).toMatch(/unknown tool/);
  });

  it("unknown method returns -32601", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 5, method: "no-method" });
    expect(r.error.code).toBe(-32601);
  });

  it("malformed JSON-RPC envelope returns -32600", async () => {
    const r = await rpc({ id: 6, method: "tools/list" }); // no jsonrpc field
    expect(r.error.code).toBe(-32600);
  });

  it("batch request returns batch response", async () => {
    const r = await rpc([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBe(2);
    expect(r[0].result).toEqual({});
    expect(r[1].result.tools.length).toBe(TOOL_DEFS.length);
  });
});

describe("RateLimiter", () => {
  it("allows up to capacity, then blocks", () => {
    const r = new RateLimiter({ capacity: 3, refillPerSecond: 0 });
    expect(r.allow("a")).toBe(true);
    expect(r.allow("a")).toBe(true);
    expect(r.allow("a")).toBe(true);
    expect(r.allow("a")).toBe(false);
  });

  it("isolates buckets per key", () => {
    const r = new RateLimiter({ capacity: 1, refillPerSecond: 0 });
    expect(r.allow("a")).toBe(true);
    expect(r.allow("a")).toBe(false);
    expect(r.allow("b")).toBe(true);
  });

  it("refills over time", () => {
    const r = new RateLimiter({ capacity: 1, refillPerSecond: 1 });
    expect(r.allow("x", 1000)).toBe(true);
    expect(r.allow("x", 1500)).toBe(false); // 0.5 token, not enough
    expect(r.allow("x", 2100)).toBe(true); // 1.1 → enough
  });
});
