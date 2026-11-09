/**
 * Compiled-truth mirror (G3) + page-signal boosts, end to end on PGLite:
 *   - serializeCompiledTruth / truth mirror indexing + reconcile + removal
 *   - hybridSearch ×2 compiled-truth boost (and its temporal bypass)
 *   - explain wiring through hybridSearch (G28 engine path)
 *   - alias-resolved + mattering-salience joins against live tables
 * No Bedrock: det-embed seam for indexing, a throwing embedQuery for search
 * (keyword-only), zero-LLM intent classification.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import {
  indexPageIntoSearch,
  indexPageTruthIntoSearch,
  removePageFromSearch,
  reconcilePageMirrors,
  serializeCompiledTruth,
  pageSourcePath,
  pageTruthSourcePath,
  isPageSourcePath,
} from "../src/core/page-index.ts";
import { hybridSearch } from "../src/core/search/index.ts";
import { keywordSearch } from "../src/core/search/keyword.ts";
import { applyAliasResolvedBoost } from "../src/core/search/alias-resolved.ts";
import { applyMatteringBoost, matteringSalienceFactor } from "../src/core/search/salience.ts";
import { deterministicEmbed } from "./det-embed.ts";

const embedFn = async (text: string) => deterministicEmbed(text);
const nullVec = async (): Promise<number[]> => {
  throw new Error("keyword-only in this test");
};

let tmp: string;
let storage: Storage;

const docId = async (path: string): Promise<string | null> => {
  const r = await storage
    .engine()
    .query<{ id: string }>("SELECT id FROM documents WHERE source_path = $1", [path]);
  return r.rows[0]?.id ?? null;
};

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-page-truth-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("serializeCompiledTruth", () => {
  it("renders a deterministic, key-sorted readable block", () => {
    const a = serializeCompiledTruth("Alice", "people/alice", {
      role: "engineer",
      tags: ["friend", "sf"],
    });
    const b = serializeCompiledTruth("Alice", "people/alice", {
      tags: ["friend", "sf"],
      role: "engineer",
    });
    expect(a).toBe(b);
    expect(a).toContain("# Alice — compiled truth");
    expect(a).toContain("role: engineer");
    expect(a).toContain("tags: friend, sf");
  });

  it("returns empty for empty/non-object truth", () => {
    expect(serializeCompiledTruth("T", "s", {})).toBe("");
    expect(serializeCompiledTruth("T", "s", null)).toBe("");
    expect(serializeCompiledTruth("T", "s", [1])).toBe("");
  });

  it("both mirror namespaces count as page source paths (redaction contract)", () => {
    expect(isPageSourcePath(pageSourcePath("x"))).toBe(true);
    expect(isPageSourcePath(pageTruthSourcePath("x"))).toBe(true);
    expect(isPageSourcePath("people/x.md")).toBe(false);
  });
});

describe("compiled-truth mirror lifecycle", () => {
  it("indexes truth as its own document, findable by keyword", async () => {
    const slug = "people/quorbin";
    await putPage(storage, {
      slug,
      type: "person",
      title: "Quorbin",
      markdown_body: "Body prose without the magic word.",
      compiled_truth: { specialty: "flurbotron calibration" },
    });
    await indexPageIntoSearch(
      storage,
      {
        slug,
        title: "Quorbin",
        markdown_body: "Body prose without the magic word.",
        compiled_truth: { specialty: "flurbotron calibration" },
      },
      { embedFn },
    );
    const truthDoc = await docId(pageTruthSourcePath(slug));
    expect(truthDoc).not.toBeNull();
    expect((await storage.engine().query("SELECT source_id FROM documents WHERE id = $1", [truthDoc])).rows)
      .toEqual([{ source_id: "default" }]);
    expect((await storage.engine().query("SELECT DISTINCT source_id FROM chunks WHERE document_id = $1", [truthDoc])).rows)
      .toEqual([{ source_id: "default" }]);
    const hits = await keywordSearch(storage.engine(), "flurbotron", 10);
    expect(hits.some((id) => id.startsWith(truthDoc!))).toBe(true);
  });

  it("leaves the truth mirror alone when compiled_truth is omitted", async () => {
    const slug = "people/quorbin";
    const before = await docId(pageTruthSourcePath(slug));
    expect(before).not.toBeNull();
    await indexPageIntoSearch(
      storage,
      { slug, title: "Quorbin", markdown_body: "Edited body only." },
      { embedFn },
    );
    expect(await docId(pageTruthSourcePath(slug))).toBe(before);
  });

  it("empty truth removes the mirror", async () => {
    const slug = "people/quorbin-empty";
    await indexPageTruthIntoSearch(
      storage,
      { slug, title: "X", compiled_truth: { a: "b" } },
      { embedFn },
    );
    expect(await docId(pageTruthSourcePath(slug))).not.toBeNull();
    await indexPageTruthIntoSearch(
      storage,
      { slug, title: "X", compiled_truth: {} },
      { embedFn },
    );
    expect(await docId(pageTruthSourcePath(slug))).toBeNull();
  });

  it("reconcile backfills a missing truth mirror and drops orphans", async () => {
    const slug = "companies/vexlar";
    await putPage(storage, {
      slug,
      type: "company",
      title: "Vexlar",
      markdown_body: "A company page.",
      compiled_truth: { sector: "grommet logistics" },
    });
    // No explicit truth indexing — the backstop must create it.
    expect(await docId(pageTruthSourcePath(slug))).toBeNull();
    const r1 = await reconcilePageMirrors(storage, { embedFn });
    expect(r1.errors).toEqual([]);
    expect(await docId(pageTruthSourcePath(slug))).not.toBeNull();

    // Reconcile is idempotent once fresh (no churn on the truth mirror).
    const r2 = await reconcilePageMirrors(storage, { embedFn });
    expect(r2.errors).toEqual([]);
    expect(await docId(pageTruthSourcePath(slug))).not.toBeNull();
  });

  it("removePageFromSearch drops BOTH mirrors", async () => {
    const slug = "people/quorbin";
    await removePageFromSearch(storage, slug);
    expect(await docId(pageSourcePath(slug))).toBeNull();
    expect(await docId(pageTruthSourcePath(slug))).toBeNull();
  });
});

describe("hybridSearch compiled-truth boost + explain", () => {
  const SLUG = "concepts/zorblaxium";
  beforeAll(async () => {
    // A body mirror and a truth mirror sharing vocabulary, so both compete
    // in the keyword arm and the ×2 boost decides the order.
    await indexPageIntoSearch(
      storage,
      {
        slug: SLUG,
        title: "Zorblaxium",
        markdown_body: "zorblaxium history and prose notes about the element.",
        compiled_truth: { summary: "zorblaxium history distilled canonical answer" },
      },
      { embedFn },
    );
  });

  it("boosts the truth chunk ONLY at detail=low (v7 rescope)", async () => {
    // Default detail (this query classifies 'general' → medium): the ×2 is
    // NOT applied — post-RRF it displaced other pages' best chunks.
    const def = await hybridSearch(storage, "zorblaxium", {
      k: 5,
      intent: "topic",
      embedQuery: nullVec,
      noCache: true,
      explain: true,
    });
    expect(def.length).toBeGreaterThanOrEqual(2);
    for (const h of def) expect(h.explain!.compiled_truth).toBeUndefined();

    // detail=low (one chunk per document — the distilled-answer view): the
    // truth chunk wins and carries the ×2 explain stamp.
    const low = await hybridSearch(storage, "zorblaxium", {
      k: 5,
      intent: "topic",
      embedQuery: nullVec,
      noCache: true,
      explain: true,
      detail: "low",
    });
    expect(low.length).toBeGreaterThanOrEqual(1);
    expect(low[0]!.sourcePath).toBe(pageTruthSourcePath(SLUG));
    expect(low[0]!.explain).toBeDefined();
    expect(low[0]!.explain!.compiled_truth).toBe(2.0);
  });

  it("bypasses the boost for temporal queries (detail=high gate)", async () => {
    // "zorblaxium history" matches both docs lexically AND classifies
    // temporal (history) → suggestedDetail 'high' → no truth boost.
    const hits = await hybridSearch(storage, "zorblaxium history", {
      k: 5,
      intent: "topic",
      embedQuery: nullVec,
      noCache: true,
      explain: true,
    });
    for (const h of hits) {
      expect(h.explain?.compiled_truth).toBeUndefined();
    }
  });
});

describe("page-signal boosts against live tables", () => {
  it("alias-resolved canonical pages get ×1.05", async () => {
    await storage
      .engine()
      .query(
        `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug)
         VALUES ('default', 'people/old-alice', 'people/alice-canonical')`,
      );
    const scored = [
      { score: 1, payload: { sourcePath: "page://people/alice-canonical", source_id: null } },
      { score: 1, payload: { sourcePath: "page://people/bob", source_id: null } },
    ];
    const touched = await applyAliasResolvedBoost(scored, storage.engine());
    expect([...touched]).toEqual([0]);
    expect(scored[0]!.score).toBeCloseTo(1.05, 10);
    expect(scored[1]!.score).toBe(1);
  });

  it("mattering-salience joins pages.salience into the multiplier", async () => {
    const slug = "people/salient-sam";
    await putPage(storage, {
      slug,
      type: "person",
      title: "Salient Sam",
      markdown_body: "A person who matters.",
    });
    await storage
      .engine()
      .query(`UPDATE pages SET salience = 0.8 WHERE slug = $1`, [slug]);
    const scored = [
      { score: 1, payload: { sourcePath: `page://${slug}`, source_id: null } },
      { score: 1, payload: { sourcePath: "page://people/nobody", source_id: null } },
    ];
    await applyMatteringBoost(scored, storage.engine(), { strength: "on" });
    expect(scored[0]!.score).toBeCloseTo(matteringSalienceFactor(0.8, "on"), 10);
    expect(scored[1]!.score).toBe(1);
  });
});
