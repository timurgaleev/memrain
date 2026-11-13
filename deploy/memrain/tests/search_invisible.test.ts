/**
 * `search invisible` — which pages the vector arm can never return, and why.
 * Seeds one page per state on each engine and checks the report's state,
 * reason, source scope and bound.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { putPage } from "../src/core/pages.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { logIngest } from "../src/core/ingest-log.ts";
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from "../src/core/synthesis/takes-fence.ts";
import { vectorInvisiblePages } from "../src/core/vector-visibility.ts";
import { runSearchInvisible } from "../src/commands/search-invisible.ts";
import type { Storage } from "../src/core/storage.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

async function mirror(
  storage: Storage,
  slug: string,
  opts: { sourceId?: string; frontmatter?: Record<string, unknown>; vector: boolean },
): Promise<void> {
  const sourceId = opts.sourceId ?? "default";
  const path = sourceId === "default" ? `page://${slug}` : `page://${sourceId}/${slug}`;
  const text = `content of ${slug}`;
  await writeDocumentTransaction(
    storage,
    { documentId: `doc_${slug.replace(/\W/g, "_")}`, sourcePath: path, title: slug,
      frontmatter: opts.frontmatter ?? {}, embeddingModel: "det", sourceId, claimUnowned: true },
    [{ text, entities: [], embedding: opts.vector ? deterministicEmbed(text) : null }],
  );
}

const TAKES_ONLY = [TAKES_FENCE_BEGIN, "## Takes", "", "| row | claim | holder | since |",
  "| --- | --- | --- | --- |", "| 1 | a claim | operator | 2026-01 |", TAKES_FENCE_END, ""].join("\n");

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`vectorInvisiblePages (${name})`, () => {
    let db: Awaited<ReturnType<typeof open>>;

    beforeEach(async () => {
      db = await open();
      const s = db.storage;
      await s.engine().query("INSERT INTO sources (id, kind, path_prefix) VALUES ('work', 'other', '/work') ON CONFLICT DO NOTHING");
      await putPage(s, { slug: "notes/embedded", markdown_body: "visible prose", written_by: "t" });
      await mirror(s, "notes/embedded", { vector: true });
      await putPage(s, { slug: "notes/takes-only", markdown_body: TAKES_ONLY, written_by: "t" });
      await putPage(s, { slug: "notes/skipped", markdown_body: "huge table dump", written_by: "t" });
      await mirror(s, "notes/skipped", { vector: false, frontmatter: { embed_skip: { reason: "oversize" } } });
      await putPage(s, { slug: "notes/unmirrored", markdown_body: "prose with no mirror", written_by: "t" });
      await putPage(s, { slug: "notes/novector", markdown_body: "prose not embedded yet", written_by: "t" });
      await mirror(s, "notes/novector", { vector: false });
      await putPage(s, { slug: "notes/failed", markdown_body: "prose whose mirror failed", written_by: "t" });
      await logIngest(s.engine(), { source_type: "page-mirror-failed", source_ref: "notes/failed",
        pages_updated: ["notes/failed"], summary: "Bedrock access denied" });
      await putPage(s, { slug: "notes/elsewhere", markdown_body: "other tenant prose", written_by: "t", source_id: "work" });
    });
    afterEach(async () => { await db.close(); });

    it("names the state and reason of every page the vector arm cannot return", async () => {
      const r = await vectorInvisiblePages(db.storage.engine(), { sourceId: "default", limit: 50 });
      const bySlug = Object.fromEntries(r.pages.map((p) => [p.slug, p]));
      expect(Object.keys(bySlug).sort()).toEqual([
        "notes/failed", "notes/novector", "notes/skipped", "notes/takes-only", "notes/unmirrored",
      ]);
      expect(bySlug["notes/takes-only"]!.state).toBe("empty");
      expect(bySlug["notes/skipped"]!.state).toBe("skip");
      expect(bySlug["notes/skipped"]!.reason).toContain("embed_skip");
      expect(bySlug["notes/unmirrored"]!.state).toBe("chunkless_healable");
      expect(bySlug["notes/unmirrored"]!.reason).toContain("no search mirror");
      expect(bySlug["notes/novector"]!.state).toBe("chunkless_healable");
      expect(bySlug["notes/novector"]!.reason).toContain("without a vector");
      expect(bySlug["notes/failed"]!.state).toBe("failed");
      expect(bySlug["notes/failed"]!.reason).toContain("Bedrock access denied");
      expect(r.counts).toEqual({ embedded: 1, empty: 1, chunkless_healable: 2, skip: 1, failed: 1 });
      expect(r.truncated).toBe(false);
    });

    it("never offers a paid repair for a deliberately empty or skipped page", async () => {
      const r = await vectorInvisiblePages(db.storage.engine(), { sourceId: "default", limit: 50 });
      for (const p of r.pages.filter((x) => x.state === "empty" || x.state === "skip")) {
        expect(p.hint).not.toMatch(/embed|reindex|mirror/i);
      }
    });

    it("keeps other sources out of a scoped report", async () => {
      const scoped = await vectorInvisiblePages(db.storage.engine(), { sourceId: "work", limit: 50 });
      expect(scoped.pages.map((p) => p.slug)).toEqual(["notes/elsewhere"]);
      const all = await vectorInvisiblePages(db.storage.engine(), { limit: 50 });
      expect(all.pages.map((p) => p.slug)).toContain("notes/elsewhere");
    });

    it("stops at the limit and says the list was cut", async () => {
      const r = await vectorInvisiblePages(db.storage.engine(), { sourceId: "default", limit: 2 });
      expect(r.pages).toHaveLength(2);
      expect(r.truncated).toBe(true);
    });
  });
}

describe("memrain search invisible", () => {
  const [pglite] = storageEngines(undefined);
  let db: Awaited<ReturnType<NonNullable<typeof pglite>["open"]>>;
  beforeEach(async () => {
    db = await pglite!.open();
    await putPage(db.storage, { slug: "notes/unmirrored", markdown_body: "prose with no mirror", written_by: "t" });
  });
  afterEach(async () => { await db.close(); });

  function capture(): { out: string[]; restore: () => void } {
    const out: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
    return { out, restore: () => { console.log = orig; } };
  }

  it("prints the report as JSON", async () => {
    const cap = capture();
    let code: number;
    try {
      code = await runSearchInvisible({ storage: db.storage, json: true, limit: 10 });
    } finally { cap.restore(); }
    expect(code).toBe(0);
    const report = JSON.parse(cap.out.join("\n"));
    expect(report.pages).toEqual([expect.objectContaining({ slug: "notes/unmirrored", state: "chunkless_healable" })]);
  });

  it("refuses a limit outside the bound as a usage error", async () => {
    expect(await runSearchInvisible({ storage: db.storage, limit: 0 })).toBe(2);
    expect(await runSearchInvisible({ storage: db.storage, limit: 1001 })).toBe(2);
  });
});
