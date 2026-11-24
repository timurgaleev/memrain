/**
 * The admin brain explorer's page_get passes `version` through, so the Page
 * view's version picker shows the stored body of that version.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { handleAdminTool, sanitizeAdminToolArgs } from "../src/http/admin-tool.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-admin-tool-version-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const pageGet = async (args: Record<string, unknown>) => {
  const res = await handleAdminTool(
    new Request("http://x/admin/api/tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "page_get", arguments: args }),
    }),
    { storage },
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { page: { markdown_body: string } } }).data.page;
};

describe("admin page_get version", () => {
  // Value: protects=viewing an old version in the panel shows that version's text;
  // fails_when=the admin argument allowlist drops `version` again and the call reads the
  // current body; why_new=the allowlist silently dropped it; seam=none
  it("returns the stored body of the requested version, not the current one", async () => {
    await putPage(storage, { slug: "notes/history", markdown_body: "first body\n" });
    await putPage(storage, { slug: "notes/history", markdown_body: "second body\n" });

    expect((await pageGet({ slug: "notes/history" })).markdown_body).toContain("second body");
    expect((await pageGet({ slug: "notes/history", version: 1 })).markdown_body).toContain("first body");
  });

  // Value: protects=the clamp keeps a hostile version inside the tool's schema range;
  // fails_when=the rule is loosened to an unbounded number; why_new=same; seam=none
  it("clamps version into the tool's range", () => {
    const out = sanitizeAdminToolArgs("page_get", { slug: "a", version: 0 });
    expect(out).toEqual({ ok: true, args: { slug: "a", version: 1 } });
  });
});
