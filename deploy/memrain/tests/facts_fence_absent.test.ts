/**
 * A page whose body no longer carries a `## Facts` fence keeps the facts that
 * fence projected: losing the markers (an agent rewriting the page as prose, a
 * bad merge) must not silently delete them. Removal is a struck row or
 * `forget_fact`. The Postgres twin runs when MEMRAIN_TEST_POSTGRES_URL is set.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { renderFactsFence, type ParsedFact } from "../src/core/facts-fence.ts";
import { reconcileFactsForPage } from "../src/core/facts-reconcile.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

const URL_ = process.env.MEMRAIN_TEST_POSTGRES_URL;

function withFence(claims: string[], struck: string[] = []): string {
  const rows: ParsedFact[] = [
    ...claims.map((claim) => ({ claim, active: true })),
    ...struck.map((claim) => ({ claim, active: false })),
  ].map((r, i) => ({ rowNum: i + 1, claim: r.claim, confidence: 1, active: r.active }));
  return `# A\n\nSome prose.\n\n## Facts\n${renderFactsFence(rows)}\n`;
}

async function putAndReconcile(storage: Storage, slug: string, body: string) {
  const r = await putPage(storage, { slug, type: "person", markdown_body: body });
  return reconcileFactsForPage(storage, slug, r.content_hash);
}

async function liveFenceFacts(storage: Storage, slug: string) {
  const r = await storage.engine().query<{ id: string; fact: string; written_at: string }>(
    `SELECT id::text AS id, fact, written_at::text AS written_at FROM entity_facts
      WHERE source_markdown_slug = $1 AND forgotten_at IS NULL ORDER BY row_num`,
    [slug],
  );
  return r.rows;
}

function cases(ctx: { storage: () => Storage; slug: () => string }): void {
  it("re-putting the page without the fence keeps the projected facts and their ids", async () => {
    const storage = ctx.storage();
    const slug = ctx.slug();
    await putAndReconcile(storage, slug, withFence(["Likes tea.", "Born 1990."]));
    const before = await liveFenceFacts(storage, slug);
    expect(before).toHaveLength(2);
    const rec = await putAndReconcile(storage, slug, "Just prose now.");
    expect(rec).toMatchObject({ fenceAbsent: true, retained: 2, removed: 0, added: 0 });
    expect(await liveFenceFacts(storage, slug)).toEqual(before);
  });
}

describe("facts fence absent (PGLite)", () => {
  let tmp: string;
  let storage: Storage;
  let n = 0;
  const savedMirror = process.env.MEMRAIN_PAGE_MIRROR_SYNC;

  beforeEach(async () => {
    // Queue the search mirror instead of embedding through Bedrock.
    process.env.MEMRAIN_PAGE_MIRROR_SYNC = "0";
    tmp = mkdtempSync(join(tmpdir(), "memrain-fence-absent-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });
  afterEach(async () => {
    if (savedMirror === undefined) delete process.env.MEMRAIN_PAGE_MIRROR_SYNC;
    else process.env.MEMRAIN_PAGE_MIRROR_SYNC = savedMirror;
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  cases({ storage: () => storage, slug: () => `people/a${++n}` });

  it("a struck row still removes its fact", async () => {
    await putAndReconcile(storage, "people/a", withFence(["Likes tea.", "Born 1990."]));
    await putAndReconcile(storage, "people/a", withFence(["Born 1990."], ["Likes tea."]));
    expect((await liveFenceFacts(storage, "people/a")).map((f) => f.fact)).toEqual(["Born 1990."]);
  });

  it("page_put through MCP reports facts_fence_absent", async () => {
    const put = (markdown_body: string) =>
      dispatchTool(storage, {
        name: "page_put",
        arguments: { slug: "people/a", type: "person", markdown_body },
      });
    await put(withFence(["Likes tea.", "Born 1990."]));
    const r = JSON.parse((await put("prose")).content[0]!.text);
    expect(r.facts_fence_absent).toBe(2);
    expect(await liveFenceFacts(storage, "people/a")).toHaveLength(2);
  });

  it("page_put through MCP leaves facts_fence_absent out when nothing is retained", async () => {
    const r = await dispatchTool(storage, {
      name: "page_put",
      arguments: { slug: "people/b", type: "person", markdown_body: "prose" },
    });
    expect(JSON.parse(r.content[0]!.text)).not.toHaveProperty("facts_fence_absent");
  });
});

describe.skipIf(!URL_)("facts fence absent (Postgres)", () => {
  let pg: PostgresEngine;
  let storage: Storage;
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let n = 0;

  beforeAll(async () => {
    pg = new PostgresEngine({ url: URL_! });
    storage = new Storage(pg);
    await storage.init();
  });
  afterAll(async () => {
    await pg.close();
  });

  cases({ storage: () => storage, slug: () => `people/fence-absent-${run}-${++n}` });
});
