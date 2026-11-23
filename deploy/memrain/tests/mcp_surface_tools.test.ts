/**
 * MEMRAIN_MCP_FORCE_SURFACE over the real `dispatchTool` and /mcp paths on
 * PGLite: the operator's switch narrows every connection and never widens one.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { visibleToolDefs } from "../src/mcp/visibility.ts";
import { isPublicMcpToolForbidden } from "../src/http/public_guard.ts";
import { makeMcpHandler } from "../src/mcp/http_transport.ts";
import { readForceSurfaceEnv, STARTER_TOOLS, VERB_TOOLS } from "../src/mcp/surface.ts";

let tmp: string;
let storage: Storage;

const A = "tenantA";
const B = "tenantB";
const A_BODY = "AAA_TRANSCRIPT_BODY_alpha meeting notes here for the record";
const B_BODY = "BBB_TRANSCRIPT_BODY_beta meeting notes here for the record";

function auth(sourceId: string): AuthInfo {
  return {
    token: `tok-${sourceId}`,
    clientId: `client-${sourceId}`,
    scopes: ["read", "write"],
    sourceId,
    allowedSources: [sourceId],
    isPublic: false,
  };
}

function payload(result: ToolCallResult): any {
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-surface-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: A, kind: "vault", pathPrefix: "/tenant-a" });
  await registerSource(storage.engine(), { id: B, kind: "vault", pathPrefix: "/tenant-b" });

  // Transcript-typed pages, one per tenant.
  await putPage(storage, { slug: "meet-a", type: "meeting", title: "Meeting A", markdown_body: A_BODY, source_id: A });
  await putPage(storage, { slug: "note-b", type: "note", title: "Note B", markdown_body: B_BODY, source_id: B });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("MEMRAIN_MCP_FORCE_SURFACE", () => {
  const prior = process.env["MEMRAIN_MCP_FORCE_SURFACE"];
  afterEach(() => {
    if (prior === undefined) delete process.env["MEMRAIN_MCP_FORCE_SURFACE"];
    else process.env["MEMRAIN_MCP_FORCE_SURFACE"] = prior;
  });
  const force = (v: string | undefined) => {
    if (v === undefined) delete process.env["MEMRAIN_MCP_FORCE_SURFACE"];
    else process.env["MEMRAIN_MCP_FORCE_SURFACE"] = v;
  };
  const listed = (authInfo?: AuthInfo) =>
    visibleToolDefs({ isPublic: false, ...(authInfo ? { authInfo } : {}) }, isPublicMcpToolForbidden).map((t) => t.name).sort();
  const viaMcp = (name: string, args: Record<string, unknown>, authInfo?: AuthInfo) =>
    dispatchTool(storage, { name, arguments: args }, { ...(authInfo ? { authInfo } : {}), mcpIngress: true });
  const verbsCred: AuthInfo = { ...auth(A), toolSurface: "verbs" };

  // Value: protects=the incident switch clamps a full credential; fails_when=a forced surface is not applied to list or call.
  it("verbs narrows a full credential's list and call to the verbs it may use", async () => {
    force(undefined);
    const full = listed(auth(A));
    force("verbs");
    expect(listed(auth(A))).toEqual(full.filter((n) => VERB_TOOLS.has(n)));
    const refused = payload(await viaMcp("page_put", { slug: "x", markdown_body: "y" }, auth(A)));
    expect(refused.error).toBe("permission_denied");
    expect(refused.message).toContain("'verbs' tool surface");
    expect(refused.suggestion).toContain("narrowed every connection to the 'verbs' surface");
  });

  // Value: protects=narrow-only; fails_when=a wider forced surface widens a narrower credential.
  it("never widens: starter leaves a verbs credential on verbs", async () => {
    force("starter");
    expect(listed(verbsCred)).toEqual([]);
    expect(listed(auth(A)).length).toBeGreaterThan(0);
    expect(listed(auth(A)).every((n) => STARTER_TOOLS.has(n))).toBe(true);
    force("full");
    expect(listed(verbsCred)).toEqual([]);
  });

  // Value: protects=an incident value typed with spaces or capitals still clamps; fails_when=" Verbs " is ignored as unknown.
  it("accepts the value with surrounding spaces and in any case", () => {
    force(" Verbs ");
    expect(readForceSurfaceEnv(() => {})).toBe("verbs");
    expect(listed(auth(A)).every((n) => VERB_TOOLS.has(n))).toBe(true);
    force("FULL");
    expect(readForceSurfaceEnv(() => {})).toBeNull();
  });

  // Value: protects=a typo in an incident cannot change surfaces; fails_when=an unknown value narrows, widens or warns per request.
  it("ignores an unknown value and warns once", () => {
    force(undefined);
    const before = listed(auth(A));
    force("bogus");
    const warnings: string[] = [];
    expect(readForceSurfaceEnv((m) => warnings.push(m))).toBeNull();
    expect(readForceSurfaceEnv((m) => warnings.push(m))).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("MEMRAIN_MCP_FORCE_SURFACE");
    expect(listed(auth(A))).toEqual(before);
  });

  // Value: protects=the switch binds the operator bearer on /mcp but not the local CLI; fails_when=it misses /mcp or leaks into in-process dispatch.
  it("applies to the operator bearer over /mcp, not to dispatch without the transport", async () => {
    force("verbs");
    const handler = makeMcpHandler({ storage, clientKey: () => "ip-0" });
    const rpc = async (method: string, params: unknown) => (await (await handler(
      new Request("http://x/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }),
      { isPublic: false },
    )).json()) as { result: { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> } };
    const tools = (await rpc("tools/list", {})).result.tools!.map((t) => t.name).sort();
    expect(tools).toEqual([]);
    const call = (await rpc("tools/call", { name: "page_list", arguments: {} })).result;
    expect(call.isError).toBe(true);
    expect(call.content![0]!.text).toContain("permission_denied");
    const local = await dispatchTool(storage, { name: "page_list", arguments: {} });
    expect(local.isError).toBeFalsy();
  });

  // Value: protects=a refused caller learns where a surface is widened; fails_when=the old generic text comes back.
  it("names admin, Credentials for a per-credential surface", async () => {
    force(undefined);
    const refused = payload(await viaMcp("page_get", { slug: "meet-a" }, verbsCred));
    expect(refused.error).toBe("permission_denied");
    expect(refused.suggestion).toBe("Ask the brain owner to widen this credential's tool surface in admin \u2192 Credentials.");
  });
});
