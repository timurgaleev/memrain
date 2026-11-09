/**
 * Page → search bridge (core/page-index.ts).
 *
 * Proves a page mirrored into the search store via `indexPageIntoSearch`
 * becomes findable by the keyword arm, carries embeddings (offline, via the
 * det-embed seam), and is dropped by `removePageFromSearch`. This is the wire
 * that makes a `page_put` body searchable — without it the `pages` table is
 * invisible to search.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage, getPage, deletePage } from "../src/core/pages.ts";
import {
  indexPageIntoSearch,
  removePageFromSearch,
  reconcilePageMirrors,
  pageSourcePath,
} from "../src/core/page-index.ts";
import { keywordSearch } from "../src/core/search/keyword.ts";
import { deterministicEmbed } from "./det-embed.ts";

// Inject the deterministic embedder so the bridge never calls Bedrock.
const embedFn = async (text: string) => deterministicEmbed(text);

let tmp: string;
let storage: Storage;

async function docIdForSlug(slug: string): Promise<string | null> {
  const r = await storage
    .engine()
    .query<{ id: string }>("SELECT id FROM documents WHERE source_path = $1", [
      pageSourcePath(slug),
    ]);
  return r.rows[0]?.id ?? null;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-page-bridge-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("page → search bridge", () => {
  it("makes a page body findable by keyword search", async () => {
    const slug = "notes/bridge-found";
    await putPage(storage, {
      slug,
      type: "note",
      title: "Quarterly review",
      markdown_body: "The zorblax migration shipped on schedule.",
    });
    const res = await indexPageIntoSearch(
      storage,
      { slug, title: "Quarterly review", markdown_body: "The zorblax migration shipped on schedule." },
      { embedFn },
    );
    expect(res).not.toBeNull();

    const docId = await docIdForSlug(slug);
    expect(docId).not.toBeNull();
    expect((await storage.engine().query("SELECT source_id FROM documents WHERE id = $1", [docId])).rows)
      .toEqual([{ source_id: "default" }]);
    expect((await storage.engine().query("SELECT DISTINCT source_id FROM chunks WHERE document_id = $1", [docId])).rows)
      .toEqual([{ source_id: "default" }]);

    const hits = await keywordSearch(storage.engine(), "zorblax", 10);
    expect(hits.some((id) => id.startsWith(docId!))).toBe(true);
  });

  it("indexes the title so a title term is findable", async () => {
    const slug = "notes/title-find";
    await putPage(storage, {
      slug,
      type: "note",
      title: "Plutonium logistics",
      markdown_body: "Body without the title word.",
    });
    await indexPageIntoSearch(
      storage,
      { slug, title: "Plutonium logistics", markdown_body: "Body without the title word." },
      { embedFn },
    );
    const hits = await keywordSearch(storage.engine(), "plutonium", 10);
    const docId = await docIdForSlug(slug);
    expect(hits.some((id) => id.startsWith(docId!))).toBe(true);
  });

  it("writes embeddings for the mirrored chunks", async () => {
    const slug = "notes/has-embeddings";
    await indexPageIntoSearch(
      storage,
      { slug, title: "Vectors", markdown_body: "Quiver of arrows pointing somewhere." },
      { embedFn },
    );
    const docId = await docIdForSlug(slug);
    const r = await storage
      .engine()
      .query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM embeddings e
           JOIN chunks c ON c.id = e.chunk_id
          WHERE c.document_id = $1`,
        [docId],
      );
    expect(r.rows[0]!.n).toBeGreaterThan(0);
  });

  it("re-indexing the same slug stays a single document (idempotent)", async () => {
    const slug = "notes/idem";
    const page = { slug, title: "Idem", markdown_body: "wibble wobble first" };
    await indexPageIntoSearch(storage, page, { embedFn });
    await indexPageIntoSearch(
      storage,
      { ...page, markdown_body: "wibble wobble second revised" },
      { embedFn },
    );
    const r = await storage
      .engine()
      .query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM documents WHERE source_path = $1",
        [pageSourcePath(slug)],
      );
    expect(r.rows[0]!.n).toBe(1);
    // Latest body wins.
    const hits = await keywordSearch(storage.engine(), "revised", 10);
    const docId = await docIdForSlug(slug);
    expect(hits.some((id) => id.startsWith(docId!))).toBe(true);
  });

  it("removePageFromSearch drops the mirror", async () => {
    const slug = "notes/to-remove";
    await indexPageIntoSearch(
      storage,
      { slug, title: "Ephemeral", markdown_body: "snorfle grackle transient" },
      { embedFn },
    );
    expect(await docIdForSlug(slug)).not.toBeNull();

    const out = await removePageFromSearch(storage, slug);
    expect(out.removed).toBe(true);
    expect(await docIdForSlug(slug)).toBeNull();

    const hits = await keywordSearch(storage.engine(), "snorfle", 10);
    expect(hits.length).toBe(0);
  });

  it("an empty page removes any existing mirror instead of indexing a husk", async () => {
    const slug = "notes/emptied";
    await indexPageIntoSearch(
      storage,
      { slug, title: "Had content", markdown_body: "fleeting words here" },
      { embedFn },
    );
    expect(await docIdForSlug(slug)).not.toBeNull();

    const res = await indexPageIntoSearch(
      storage,
      { slug, title: null, markdown_body: "   " },
      { embedFn },
    );
    expect(res).toBeNull();
    expect(await docIdForSlug(slug)).toBeNull();
  });
});

describe("reconcilePageMirrors backstop", () => {
  it("mirrors a page whose mirror is missing (write-time embed failed)", async () => {
    const slug = "notes/never-mirrored";
    await putPage(storage, {
      slug,
      type: "note",
      title: "Orphaned write",
      markdown_body: "The grobnax was never embedded on write.",
    });
    expect(await docIdForSlug(slug)).toBeNull(); // putPage alone does not mirror

    const res = await reconcilePageMirrors(storage, { embedFn });
    expect(res.mirrored).toBeGreaterThanOrEqual(1);
    expect(await docIdForSlug(slug)).not.toBeNull();

    const hits = await keywordSearch(storage.engine(), "grobnax", 10);
    const docId = await docIdForSlug(slug);
    expect(hits.some((id) => id.startsWith(docId!))).toBe(true);
  });

  it("re-mirrors a stale page (body changed, mirror not updated)", async () => {
    const slug = "notes/stale-mirror";
    const r1 = await putPage(storage, {
      slug,
      type: "note",
      title: "Stale",
      markdown_body: "first body fizgig",
    });
    await indexPageIntoSearch(
      storage,
      { slug, title: "Stale", markdown_body: "first body fizgig", content_hash: r1.content_hash },
      { embedFn },
    );
    // Change the body without re-mirroring → mirror is now stale.
    await putPage(storage, {
      slug,
      type: "note",
      title: "Stale",
      markdown_body: "second body wuxtable",
    });

    const res = await reconcilePageMirrors(storage, { embedFn });
    expect(res.mirrored).toBeGreaterThanOrEqual(1);

    const docId = await docIdForSlug(slug);
    const fresh = await keywordSearch(storage.engine(), "wuxtable", 10);
    expect(fresh.some((id) => id.startsWith(docId!))).toBe(true);
  });

  it("drops an orphan mirror after the page is soft-deleted", async () => {
    const slug = "notes/will-be-deleted";
    const r = await putPage(storage, {
      slug,
      type: "note",
      title: "Doomed",
      markdown_body: "snibbly content here",
    });
    await indexPageIntoSearch(
      storage,
      { slug, title: "Doomed", markdown_body: "snibbly content here", content_hash: r.content_hash },
      { embedFn },
    );
    expect(await docIdForSlug(slug)).not.toBeNull();

    await deletePage(storage, slug);
    const res = await reconcilePageMirrors(storage, { embedFn });
    expect(res.removed).toBeGreaterThanOrEqual(1);
    expect(await docIdForSlug(slug)).toBeNull();
  });

  it("re-mirrors after a title-only edit (body hash unchanged)", async () => {
    const slug = "notes/title-only-edit";
    const body = "constantbody zonkforty unchanged across edits";
    const r1 = await putPage(storage, {
      slug,
      type: "note",
      title: "Old Title",
      markdown_body: body,
    });
    await indexPageIntoSearch(
      storage,
      { slug, title: "Old Title", markdown_body: body, content_hash: r1.content_hash },
      { embedFn },
    );
    // Change ONLY the title — body (and thus content_hash) is identical.
    await putPage(storage, {
      slug,
      type: "note",
      title: "New Title Quibblezap",
      markdown_body: body,
    });

    const res = await reconcilePageMirrors(storage, { embedFn });
    expect(res.mirrored).toBeGreaterThanOrEqual(1);

    const docId = await docIdForSlug(slug);
    const hits = await keywordSearch(storage.engine(), "quibblezap", 10);
    expect(hits.some((id) => id.startsWith(docId!))).toBe(true);
  });

  it("a fully reconciled corpus is a no-op (no missing/stale/orphan)", async () => {
    // Reconcile twice; the second pass should mirror nothing new.
    await reconcilePageMirrors(storage, { embedFn });
    const res = await reconcilePageMirrors(storage, { embedFn });
    expect(res.mirrored).toBe(0);
    expect(res.removed).toBe(0);
    expect(res.errors).toEqual([]);
  });
});
