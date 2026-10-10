/**
 * purge_deleted_pages over MCP: `slugs` narrows the purge, `dry_run` returns
 * the plan and its hash, and `expected_plan_hash` purges exactly the reviewed
 * set or refuses.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { deletePage, putPage } from "../src/core/pages.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-purge-mcp-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function deletedPage(slug: string): Promise<void> {
  await putPage(storage, { slug, type: "note", markdown_body: `body of ${slug}` });
  await deletePage(storage, slug);
  await storage.engine().query(`UPDATE pages SET deleted_at = NOW() - interval '100 hours' WHERE slug = $1`, [slug]);
}

async function remaining(): Promise<string[]> {
  const r = await storage.engine().query<{ slug: string }>(`SELECT slug FROM pages ORDER BY slug`);
  return r.rows.map((x) => x.slug);
}

const purge = (args: Record<string, unknown>) =>
  dispatchTool(storage, { name: "purge_deleted_pages", arguments: args });

describe("purge_deleted_pages params", () => {
  it("slugs reaps only the named pages", async () => {
    await deletedPage("notes/a");
    await deletedPage("notes/b");
    const r = JSON.parse((await purge({ slugs: ["notes/a"] })).content[0]!.text);
    expect(r.slugs).toEqual(["notes/a"]);
    expect(await remaining()).toEqual(["notes/b"]);
  });

  it("dry_run plans without deleting, and the plan hash purges exactly that set", async () => {
    await deletedPage("notes/a");
    await deletedPage("notes/b");
    const plan = JSON.parse((await purge({ dry_run: true })).content[0]!.text);
    expect(plan.dry_run).toBe(true);
    expect(plan.planned).toEqual(["notes/a", "notes/b"]);
    expect(plan.plan_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(await remaining()).toEqual(["notes/a", "notes/b"]);

    const r = JSON.parse((await purge({ expected_plan_hash: plan.plan_hash })).content[0]!.text);
    expect(r.slugs).toEqual(["notes/a", "notes/b"]);
    expect(await remaining()).toEqual([]);
  });

  it("a stale plan hash is refused and nothing is deleted", async () => {
    await deletedPage("notes/a");
    const plan = JSON.parse((await purge({ dry_run: true })).content[0]!.text);
    await deletedPage("notes/b");
    const r = await purge({ expected_plan_hash: plan.plan_hash });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("conflict");
    expect(await remaining()).toEqual(["notes/a", "notes/b"]);
  });

  it("refuses an admin token that holds no write source instead of purging every tenant", async () => {
    // MEMRAIN_TENANT_FAIL_CLOSED unset: the tool gate lets this client through.
    await deletedPage("notes/a");
    const authInfo = { token: "tok-admin", clientId: "client-admin", scopes: ["admin"], isPublic: false };
    for (const args of [{ slugs: ["notes/a"] }, {}]) {
      const r = await dispatchTool(storage, { name: "purge_deleted_pages", arguments: args }, { authInfo });
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0]!.text).error).toBe("permission_denied");
    }
    expect(await remaining()).toEqual(["notes/a"]);
  });

  it("refuses a slug list that is not all strings", async () => {
    const r = await purge({ slugs: ["notes/a", 3] });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("`slugs` must be an array of strings");
  });
});
