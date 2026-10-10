/**
 * The `wanted_pages` MCP op: missing link targets in the caller's read scope,
 * with the diary fence for non-operator callers, a bounded limit, and no
 * route from the public ingress.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { syncWikilinksForPage } from "../src/core/links.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { isPublicMcpToolForbidden } from "../src/http/public_guard.ts";
import { OPERATIONS } from "../src/mcp/operations.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

let tmp: string;
let storage: Storage;

const tenant = (sourceId: string): AuthInfo => ({
  token: `tok-${sourceId}`,
  clientId: `client-${sourceId}`,
  scopes: ["read"],
  sourceId,
  allowedSources: [sourceId],
  isPublic: false,
});

function payload(result: ToolCallResult): any {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text);
}

const call = async (args: Record<string, unknown>, authInfo?: AuthInfo) =>
  await dispatchTool(storage, { name: "wanted_pages", arguments: args }, authInfo ? { authInfo } : {});

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-mcp-wanted-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: "wa", kind: "vault", pathPrefix: "/wa" });
  await registerSource(storage.engine(), { id: "wb", kind: "vault", pathPrefix: "/wb" });
  const pages: Array<[string, string, string]> = [
    ["wa/one", "[[Orbit]] and [[Comet]]", "wa"],
    ["wa/two", "[[Orbit]]", "wa"],
    ["life/diary/2026-07-01", "[[Orbit]] [[life/diary/later]]", "wa"],
    ["wb/one", "[[Nebula]]", "wb"],
  ];
  for (const [slug, body, source] of pages) {
    await putPage(storage, { slug, markdown_body: body, source_id: source });
    await syncWikilinksForPage(storage, slug, body, source);
  }
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("wanted_pages", () => {
  it("lists every missing target, most-referenced first, for the operator", async () => {
    const { pages } = payload(await call({}));
    const targets = pages.map((p: { target_slug: string }) => p.target_slug);
    expect(targets[0]).toBe("orbit");
    expect(pages[0].referenced_by).toBe(3);
    expect(targets).toContain("nebula");
    expect(targets).toContain("life/diary/later");
  });

  it("keeps a tenant inside its own sources and out of diary slugs", async () => {
    const { pages } = payload(await call({}, tenant("wa")));
    const targets = pages.map((p: { target_slug: string }) => p.target_slug).sort();
    expect(targets).toEqual(["comet", "orbit"]);
    const orbit = pages.find((p: { target_slug: string }) => p.target_slug === "orbit");
    expect(orbit.sample_from).toEqual(["wa/one", "wa/two"]);
    expect(payload(await call({}, tenant("wb"))).pages.map((p: { target_slug: string }) => p.target_slug)).toEqual([
      "nebula",
    ]);
  });

  it("honours limit and refuses one above 200", async () => {
    expect(payload(await call({ limit: 1 })).pages).toHaveLength(1);
    const refused = await call({ limit: 201 });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("invalid_params");
  });

  it("is a read op the public ingress may not call", () => {
    const op = OPERATIONS.find((o) => o.name === "wanted_pages");
    expect(op?.scope ?? "read").toBe("read");
    expect(isPublicMcpToolForbidden("wanted_pages")).toBe(true);
  });
});
