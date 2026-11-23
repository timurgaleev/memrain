/**
 * The tool surface this build serves is exactly the 29 tools it keeps: the
 * contract, the operator's tools/list over the HTTP transport, a call to a
 * dropped tool, and a starter-surface credential all agree on it.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import { isPublicMcpToolForbidden } from "../src/http/public_guard.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { STARTER_TOOLS } from "../src/mcp/surface.ts";
import { TOOL_DEFS } from "../src/mcp/tool_defs.ts";
import { visibleToolDefs } from "../src/mcp/visibility.ts";

const KEEP = [
  "add_tag", "backlinks", "get_brain_identity", "get_chunks", "get_links", "get_tags", "index", "link",
  "page_append", "page_delete", "page_edit", "page_get", "page_list", "page_put", "page_rename", "page_restore",
  "page_revert", "page_versions", "purge_deleted_pages", "remove_tag", "resolve_slugs", "run_doctor", "search",
  "search_exact", "sources_list", "sources_status", "stats", "unlink", "whoami",
];

let tmp: string;
let storage: Storage;
let server: ServerHandle;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-lite-tools-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  server = startServer({ host: "127.0.0.1", port: 0, storage });
});

afterAll(async () => {
  await server.stop();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("the kept tool surface", () => {
  // Value: protects=the served tool contract is the 29-tool keep list; fails_when=a tool is
  // added back or one is dropped from operations.ts; why_new=the cut defines it; seam=none
  it("TOOL_DEFS names are exactly the keep list", () => {
    expect(KEEP.length).toBe(29);
    expect(TOOL_DEFS.map((t) => t.name).sort()).toEqual(KEEP);
  });

  // Value: protects=the operator's tools/list advertises every kept tool and nothing else;
  // fails_when=the transport filters a kept tool or lists a dropped one; why_new=same; seam=none
  it("the operator's tools/list over HTTP returns the same list", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual(KEEP);
  });

  // Value: protects=a client calling a 2.7-only tool gets a clean unknown-tool error, not a
  // half-working handler; fails_when=a dropped handler still answers; why_new=same; seam=none
  it("tools/call on a dropped tool answers unknown tool", async () => {
    for (const name of ["think", "add_fact", "query", "jobs_list"]) {
      const r = await dispatchTool(storage, { name, arguments: {} });
      expect(r.isError).toBe(true);
      const env = JSON.parse(r.content[0]!.text) as { error: string; message?: string };
      expect(env.error).toBe("not_found");
      expect(env.message).toBe(`unknown tool: ${name}`);
    }
  });

  // Value: protects=a starter-surface credential sees only starter tools that still exist;
  // fails_when=the surface filter stops applying, or a starter name outlives its tool;
  // why_new=the starter set predates the cut; seam=none
  it("a starter-surface token sees the starter set intersected with the keep list", () => {
    const auth: AuthInfo = { token: "t", clientId: "starter-client", scopes: ["read", "write"], toolSurface: "starter", isPublic: false };
    const visible = visibleToolDefs({ isPublic: false, authInfo: auth }, isPublicMcpToolForbidden).map((t) => t.name).sort();
    const expected = [...STARTER_TOOLS].filter((n) => KEEP.includes(n) && n !== "stats" && n !== "run_doctor").sort();
    expect(visible).toEqual(expected);
    expect(visible.length).toBeGreaterThan(0);
  });
});
