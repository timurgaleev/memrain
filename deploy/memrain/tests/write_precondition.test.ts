/**
 * MEMRAIN_REQUIRE_WRITE_PRECONDITION: an MCP page_put that overwrites a live
 * page without naming the version it read is warned about or refused. A
 * create, `force: true` and a matching `expected_version` always pass, and
 * putPage's internal callers never see the policy.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { deletePage, getPage, putPage } from "../src/core/pages.ts";

setDefaultTimeout(60000);
let tmp: string;
let storage: Storage;

function payload(result: ToolCallResult): any {
  return JSON.parse(result.content[0]!.text);
}

async function put(args: Record<string, unknown>): Promise<ToolCallResult> {
  return dispatchTool(storage, { name: "page_put", arguments: args });
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-precondition-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  delete process.env["MEMRAIN_REQUIRE_WRITE_PRECONDITION"];
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("off (default)", () => {
  it("overwrites without a version and without a warning", async () => {
    await putPage(storage, { slug: "notes/a", markdown_body: "one" });
    const r = payload(await put({ slug: "notes/a", markdown_body: "two" }));
    expect(r.ok).toBe(true);
    expect(r.warnings).toBeUndefined();
  });
});

describe("warn", () => {
  it("writes and reports an unconditional overwrite of a live page", async () => {
    process.env["MEMRAIN_REQUIRE_WRITE_PRECONDITION"] = "warn";
    await putPage(storage, { slug: "notes/a", markdown_body: "one" });
    const r = payload(await put({ slug: "notes/a", markdown_body: "two" }));
    expect(r.ok).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("precondition_missing");
    expect((await getPage(storage, "notes/a"))!.markdown_body).toBe("two");
  });

  it("does not warn on a create, a forced write or a versioned write", async () => {
    process.env["MEMRAIN_REQUIRE_WRITE_PRECONDITION"] = "warn";
    expect(payload(await put({ slug: "notes/b", markdown_body: "new" })).warnings).toBeUndefined();
    expect(payload(await put({ slug: "notes/b", markdown_body: "forced", force: true })).warnings).toBeUndefined();
    expect(payload(await put({ slug: "notes/b", markdown_body: "v3", expected_version: 2 })).warnings).toBeUndefined();
  });
});

describe("refuse", () => {
  it("refuses an unconditional overwrite of a live page with its current version", async () => {
    process.env["MEMRAIN_REQUIRE_WRITE_PRECONDITION"] = "refuse";
    await putPage(storage, { slug: "notes/a", markdown_body: "one" });
    await putPage(storage, { slug: "notes/a", markdown_body: "two" });
    const r = await put({ slug: "notes/a", markdown_body: "lost update" });
    expect(r.isError).toBe(true);
    expect(payload(r)).toMatchObject({ error: "precondition_required", current_version: 2 });
    expect((await getPage(storage, "notes/a"))!.markdown_body).toBe("two");
  });

  it("lets a create, force, a matching version and a deleted page's resurrection through", async () => {
    process.env["MEMRAIN_REQUIRE_WRITE_PRECONDITION"] = "refuse";
    expect(payload(await put({ slug: "notes/c", markdown_body: "new" })).ok).toBe(true);
    expect(payload(await put({ slug: "notes/c", markdown_body: "forced", force: true })).ok).toBe(true);
    expect(payload(await put({ slug: "notes/c", markdown_body: "v3", expected_version: 2 })).ok).toBe(true);
    await deletePage(storage, "notes/c");
    expect(payload(await put({ slug: "notes/c", markdown_body: "back" })).ok).toBe(true);
  });

  it("never reaches putPage's internal callers", async () => {
    process.env["MEMRAIN_REQUIRE_WRITE_PRECONDITION"] = "refuse";
    await putPage(storage, { slug: "notes/d", markdown_body: "one" });
    const r = await putPage(storage, { slug: "notes/d", markdown_body: "two" });
    expect(r.changed).toBe(true);
    expect(r.warnings).toBeUndefined();
  });

  it("does not apply to page_append", async () => {
    process.env["MEMRAIN_REQUIRE_WRITE_PRECONDITION"] = "refuse";
    await putPage(storage, { slug: "notes/e", markdown_body: "one" });
    const r = await dispatchTool(storage, { name: "page_append", arguments: { slug: "notes/e", content: "two" } });
    expect(payload(r).ok).toBe(true);
  });
});
