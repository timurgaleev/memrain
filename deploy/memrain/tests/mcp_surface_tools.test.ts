/**
 * MCP surface tools — takes_scorecard, takes_calibration,
 * extract_facts, list_skills, get_skill, get_recent_transcripts. Drives the real
 * `dispatchTool` path over PGLite (no Bedrock): each op is registered in TOOL_DEFS,
 * returns real data, and (for the tenant-scoped ones) is a no-op for a
 * cross-tenant caller.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { TOOL_DEFS } from "../src/mcp/tool_defs.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import { getBrainSkill } from "../src/core/skillpack/brain-resident.ts";
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

async function call(
  name: string,
  args: Record<string, unknown>,
  authInfo?: AuthInfo,
): Promise<ToolCallResult> {
  return dispatchTool(storage, { name, arguments: args }, authInfo ? { authInfo } : {});
}

async function seedGradedTake(docId: string, source: string, weight: number, key: string) {
  const e = storage.engine();
  await e.query(
    `INSERT INTO documents (id, source_path, title, source_id) VALUES ($1, $2, $3, $4)`,
    [docId, `/${source}/${docId}.md`, docId, source],
  );
  const r = await e.query<{ id: number }>(
    `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id)
     VALUES ($1, $2, 'h', 'v1', $1, 'bet', $3, 'queued', 'fake') RETURNING id`,
    [key, docId, weight],
  );
  await e.query(
    `INSERT INTO synth_take_grades (take_id, prompt_version, evidence_signature, verdict, confidence, model_id)
     VALUES ($1, 'v1', $2, 'correct', 0.9, 'fake')`,
    [r.rows[0]!.id, `sig-${key}`],
  );
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

  // Graded takes, one per tenant (both correct — so a tenant-scoped scorecard
  // that leaked the other tenant would show 2 correct instead of 1).
  await seedGradedTake("doc-a", A, 0.8, "t/a");
  await seedGradedTake("doc-b", B, 0.9, "t/b");
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("tool registration", () => {
  it("registers all six new tools in TOOL_DEFS", () => {
    const names = new Set(TOOL_DEFS.map((t) => t.name));
    for (const n of [
      "takes_scorecard",
      "takes_calibration",
      "extract_facts",
      "list_skills",
      "get_skill",
      "get_recent_transcripts",
    ]) {
      expect(names.has(n)).toBe(true);
    }
  });
});

describe("takes_scorecard dispatch", () => {
  it("returns a real scorecard for an unscoped caller", async () => {
    const p = payload(await call("takes_scorecard", {}));
    expect(p.ok).toBe(true);
    expect(p.scorecard.total_takes).toBe(2);
    expect(p.scorecard.correct).toBe(2);
  });

  it("is a no-op for the other tenant's takes", async () => {
    const p = payload(await call("takes_scorecard", {}, auth(A)));
    expect(p.scorecard.total_takes).toBe(1); // only tenant A's take
    expect(p.scorecard.correct).toBe(1);
  });
});

describe("takes_calibration dispatch", () => {
  it("returns bucket rows", async () => {
    const p = payload(await call("takes_calibration", {}));
    expect(p.ok).toBe(true);
    expect(Array.isArray(p.buckets)).toBe(true);
    expect(p.buckets.length).toBeGreaterThanOrEqual(1);
  });
});

describe("extract_facts dispatch", () => {
  it("returns the default-OFF envelope with a text arg (no spend)", async () => {
    const p = payload(await call("extract_facts", { text: "Alice: I like tea" }));
    expect(p.ok).toBe(true);
    expect(p.enabled).toBe(false);
    expect(p.facts).toEqual([]);
  });

  it("is a not-found no-op for a cross-tenant source_ref", async () => {
    // note-b belongs to tenant B; a tenant-A caller must not read its body.
    const r = await call("extract_facts", { source_ref: "note-b" }, auth(A));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).not.toContain("BBB_TRANSCRIPT_BODY");
  });
});

describe("list_skills / get_skill dispatch", () => {
  it("list_skills returns a well-formed pack", async () => {
    const p = payload(await call("list_skills", {}));
    expect(p.ok).toBe(true);
    expect(p.pack).toBe("memrain-skillpack");
    expect(Array.isArray(p.skills)).toBe(true);
  });

  it("get_skill errors on an unknown slug", async () => {
    const r = await call("get_skill", { name: "no-such-skill" });
    expect(r.isError).toBe(true);
  });

  it("getBrainSkill fetches a real skill body from a fixture dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "memrain-skill-fx-"));
    writeFileSync(
      join(dir, "demo.md"),
      "---\ntitle: demo\ndescription: A demo skill.\n---\n# demo\nbody text\n",
    );
    const s = getBrainSkill("demo", { skillsDir: dir });
    expect(s?.slug).toBe("demo");
    expect(s?.description).toBe("A demo skill.");
    expect(s?.body).toContain("body text");
    // Path traversal is rejected before touching disk.
    expect(getBrainSkill("../secret", { skillsDir: dir })).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("get_recent_transcripts dispatch", () => {
  it("returns transcript pages for an unscoped caller", async () => {
    const p = payload(await call("get_recent_transcripts", {}));
    expect(p.ok).toBe(true);
    const slugs = p.transcripts.map((t: any) => t.slug);
    expect(slugs).toContain("meet-a");
    expect(slugs).toContain("note-b");
  });

  it("scopes to one tenant and never leaks the other's body", async () => {
    const p = payload(await call("get_recent_transcripts", {}, auth(A)));
    const slugs = p.transcripts.map((t: any) => t.slug);
    expect(slugs).toContain("meet-a");
    expect(slugs).not.toContain("note-b");
    const blob = JSON.stringify(p);
    expect(blob).not.toContain("BBB_TRANSCRIPT_BODY");
    expect(blob).toContain("AAA_TRANSCRIPT_BODY");
  });
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
    expect(listed(verbsCred)).toEqual([...VERB_TOOLS].sort());
    expect(listed(auth(A)).every((n) => STARTER_TOOLS.has(n))).toBe(true);
    force("full");
    expect(listed(verbsCred)).toEqual([...VERB_TOOLS].sort());
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
    expect(tools).toEqual([...VERB_TOOLS].sort());
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
