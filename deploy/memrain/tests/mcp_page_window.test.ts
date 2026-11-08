import { afterAll, beforeAll, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { getPage, putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { dispatchTool, type DispatchOptions } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

const body = "# First section\n" + "Useful page content.\n".repeat(16000);
const auth: AuthInfo = { token: "test", clientId: "test", scopes: ["read", "write"],
  sourceId: "window-a", allowedSources: ["window-a"], isPublic: false };
let db: Awaited<ReturnType<ReturnType<typeof storageEngines>[number]["open"]>>;
const call = async (args: Record<string, unknown>, opts: DispatchOptions = {}) => {
  const result = await dispatchTool(db.storage, { name: "page_get", arguments: args }, opts);
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text);
};
beforeAll(async () => {
  db = await storageEngines(undefined)[0]!.open();
  await registerSource(db.storage.engine(), { id: "window-a", kind: "vault", pathPrefix: "/window-a" });
  await putPage(db.storage, { slug: "notes/large", source_id: "window-a", markdown_body: body });
  await putPage(db.storage, { slug: "notes/small", markdown_body: "Small complete page." });
  const held = await dispatchTool(db.storage, { name: "page_put", arguments: {
    slug: "notes/held", markdown_body: "Checking your browser before accessing example.com. Cloudflare Ray ID: 8badf00d\n# Hidden heading\n" + body,
  } }, { authInfo: auth });
  expect(held.isError).toBeFalsy();
});
afterAll(async () => { await db.close(); });

it("keeps small reads unchanged and puts large excerpts in a separate field", async () => {
  const small = await call({ slug: "notes/small" });
  expect(small.page.markdown_body).toBe("Small complete page.");
  expect(small.partial).toBeUndefined();
  const large = await call({ slug: "notes/large" });
  expect("markdown_body" in large.page).toBe(false);
  expect(Buffer.byteLength(large.page.body_window)).toBeLessThanOrEqual(262144);
  expect(large).toMatchObject({ partial: true, total_bytes: Buffer.byteLength(body), next_offset: 262144, version: 1 });
  expect(large.headings[0]).toEqual({ text: "First section", level: 1, offset: 0 });
  expect(large.notice).toContain("page_edit");
});

it("reads successive explicit byte windows without changing the stored page", async () => {
  const first = await call({ slug: "notes/large", max_bytes: 20 });
  const next = await call({ slug: "notes/large", offset: first.next_offset, max_bytes: 20 });
  expect(first.page.body_window + next.page.body_window).toBe(body.slice(0, 40));
  expect((await getPage(db.storage, "notes/large"))!.markdown_body).toBe(body);
});

it("does not expose window text or headings through public or quarantined reads", async () => {
  for (const [slug, opts] of [["notes/large", { isPublic: true }], ["notes/held", { authInfo: auth }]] as const) {
    const result = await call({ slug, max_bytes: 50 }, opts);
    expect(result.page.body_window).toBeUndefined();
    expect(result.headings).toBeUndefined();
    expect(result.total_bytes).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("First section");
    expect(JSON.stringify(result)).not.toContain("Hidden heading");
  }
});

it("refuses a returned body_window as page_put input without changing the body", async () => {
  const window = await call({ slug: "notes/large", max_bytes: 20 });
  const result = await dispatchTool(db.storage, { name: "page_put", arguments: {
    slug: "notes/large", body_window: window.page.body_window, expected_version: window.version,
  } });
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0]!.text).error).toBe("invalid_params");
  expect((await getPage(db.storage, "notes/large"))!.markdown_body).toBe(body);
});
