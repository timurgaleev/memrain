import { afterAll, beforeAll, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { makeMcpHandler, type McpRequestContext } from "../src/mcp/http_transport.ts";
import { isPublicMcpToolForbidden } from "../src/http/public_guard.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";

let db: Awaited<ReturnType<ReturnType<typeof storageEngines>[number]["open"]>>;
let handler: ReturnType<typeof makeMcpHandler>;
const reader: McpRequestContext = { isPublic: false, authInfo: { token: "fixture", clientId: "context-reader", scopes: ["read"], sourceId: "default", allowedSources: ["default"], isPublic: false } };
beforeAll(async () => {
  db = await storageEngines(undefined)[0]!.open();
  await registerSource(db.storage.engine(), { id: "foreign", kind: "other", pathPrefix: "/foreign" });
  await putPage(db.storage, { slug: "notes/context-allowed", markdown_body: "Allowed", source_id: "default" });
  await putPage(db.storage, { slug: "notes/context-hidden", markdown_body: "Hidden", source_id: "foreign" });
  handler = makeMcpHandler({ storage: db.storage, forbidPublicTool: isPublicMcpToolForbidden });
});
afterAll(async () => { await db.close(); });
async function rpc(method: string, params: Record<string, unknown>, ctx: McpRequestContext) {
  const response = await handler(new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), ctx);
  return await response.json() as { result?: any; error?: { code: number } };
}
const tools = ["context_delta", "quarantine_list", "extraction_review"];
it("advertises all helpers to the operator and restricts tenant metadata lists", async () => {
  const local = await rpc("tools/list", {}, { isPublic: false });
  for (const name of tools) expect(local.result.tools.map((tool: any) => tool.name)).toContain(name);
  const remote = await rpc("tools/list", {}, reader);
  const names = remote.result.tools.map((tool: any) => tool.name);
  expect(names).toContain("context_delta");
  expect(names).not.toContain("quarantine_list");
  expect(names).not.toContain("extraction_review");
});
it("denies public and unauthenticated internal calls and refuses admin-scoped tenant lists", async () => {
  for (const ctx of [{ isPublic: true }, { isPublic: false, internalAuthOk: false }]) {
    for (const name of tools) expect((await rpc("tools/call", { name, arguments: { since: "2025-01-01" } }, ctx)).error).toBeDefined();
  }
  for (const name of ["quarantine_list", "extraction_review"]) {
    const denied = await rpc("tools/call", { name }, { ...reader, authInfo: { ...reader.authInfo!, scopes: ["admin"] } });
    expect(denied.result?.isError).toBe(true);
    expect(JSON.parse(denied.result.content[0].text).error).toBe("permission_denied");
  }
});
it("scopes context delta and returns read-only operator metadata lists", async () => {
  const response = await rpc("tools/call", { name: "context_delta", arguments: { since: "2025-01-01", limit: 100 } }, reader);
  expect(response.result?.isError).toBeFalsy();
  const result = JSON.parse(response.result.content[0].text);
  expect(result.pages.items.map((row: any) => row.slug)).toEqual(["notes/context-allowed"]);
  expect(JSON.stringify(result)).not.toContain("context-hidden");
  const empty = await rpc("tools/call", { name: "context_delta", arguments: { since: "2025-01-01", source_ids: [] } }, reader);
  expect(JSON.parse(empty.result.content[0].text).pages.items).toEqual([]);
  const forbidden = await rpc("tools/call", { name: "context_delta", arguments: { since: "2025-01-01", source_ids: ["foreign"] } }, reader);
  expect(forbidden.result?.isError).toBe(true);
  for (const name of ["quarantine_list", "extraction_review"]) {
    const result = await rpc("tools/call", { name, arguments: {} }, { isPublic: false });
    expect(result.result?.isError).toBeFalsy();
    expect(JSON.parse(result.result.content[0].text).ok).toBe(true);
  }
});
