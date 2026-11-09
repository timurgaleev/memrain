import { afterAll, beforeAll, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { dispatchTool, type DispatchOptions } from "../src/mcp/dispatch.ts";
import { parseHash } from "../admin/src/lib/route.ts";
let opened: Awaited<ReturnType<ReturnType<typeof storageEngines>[number]["open"]>>;
beforeAll(async () => { opened = await storageEngines(undefined)[0]!.open(); });
afterAll(async () => { await opened?.close(); });
async function put(slug: string, opts: DispatchOptions) {
  const result = await dispatchTool(opened.storage, { name: "page_put", arguments: { slug, markdown_body: "A normal short note.", expected_version: 0 } }, { issuer: "https://brain.example.com", ...opts });
  return { ...JSON.parse(result.content[0]!.text), isError: result.isError };
}
it("operator and admin writes link to the resulting page using the admin hash route", async () => {
  const op = await put("notes/operator", {});
  expect(op.admin_url).toBe("https://brain.example.com/admin/#page/notes%2Foperator");
  expect(parseHash(new URL(op.admin_url).hash)).toEqual({ name: "page", param: "notes/operator" });
  const admin = await put("notes/admin", { authInfo: { token: "fixture", clientId: "admin", scopes: ["admin"], sourceId: "default", allowedSources: ["default"], isPublic: false } });
  expect(admin.admin_url).toBe("https://brain.example.com/admin/#page/notes%2Fadmin");
});
it("tenant, public and failed writes carry no admin link", async () => {
  const tenant = await put("notes/tenant", { authInfo: { token: "fixture", clientId: "tenant", scopes: ["write"], sourceId: "default", allowedSources: ["default"], isPublic: false } });
  expect(tenant.ok).toBe(true);
  expect(tenant.admin_url).toBeUndefined();
  expect((await put("notes/public", { isPublic: true })).admin_url).toBeUndefined();
  const failed = await put("notes/operator", {});
  expect(failed.isError).toBe(true);
  expect(failed.admin_url).toBeUndefined();
});

it("preserves internal slashes without a quadratic issuer suffix scan", async () => {
  const issuer = `https://brain.example.com/${"/".repeat(64000)}keep///`;
  const before = process.cpuUsage();
  const result = await put("notes/issuer-slashes", { issuer });
  const { user, system } = process.cpuUsage(before);
  expect(result.admin_url).toBe(`${issuer.slice(0, -3)}/admin/#page/notes%2Fissuer-slashes`);
  expect((user + system) / 1000).toBeLessThan(500);
}, 10000);
