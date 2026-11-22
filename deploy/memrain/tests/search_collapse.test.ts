/**
 * Redirect and twin folding (collapse.ts): a redirect stub gives its place to
 * its target, a copy of a page in another source folds into the better-ranked
 * one. The unit cases stub the engine and the head-chunk read; the last case
 * runs through hybridSearch on PGLite.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { hybridSearch } from "../src/core/search/hybrid.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { failingEmbed } from "./rank-flags-fixture.ts";
import { collapseResults, redirectTargetSlug, type CollapseOptions, type CollapsibleHit } from "../src/core/search/collapse.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const hit = (slug: string, content: string, score: number, sourceId = "default"): CollapsibleHit => ({
  chunkId: `${sourceId}:${slug}#0`,
  documentId: `${sourceId}:${slug}`,
  sourcePath: sourceId === "default" ? `page://${slug}` : `page://${sourceId}/${slug}`,
  content,
  score,
  source_id: sourceId,
});

/** A stub engine answering the whole-document read: text per document id. */
const docs = (texts: Record<string, string>): Engine => ({
  query: async (_sql: string, params: unknown[]) => ({
    rows: (params[0] as string[]).filter(d => d in texts).map((d) => {
      const t = texts[d]!.trim();
      return { document_id: d, chars: t.length, body: t.length >= 200 ? `h:${t}` : null, lead: t.slice(0, 4000) };
    }),
  }),
}) as unknown as Engine;

const opts = (over: Partial<CollapseOptions> = {}): CollapseOptions => ({
  engine: docs({}),
  intent: "topic",
  frontmatterOf: new Map(),
  fetchHead: async () => null,
  ...over,
});
const slugs = (hits: readonly CollapsibleHit[]) => hits.map(h => h.documentId);

const LONG = "Acme builds industrial widgets for factories across Europe and sells spare parts to plant operators.";

describe("collapseResults", () => {
  it("parses redirect values as slugs", () => {
    expect(redirectTargetSlug("[[people/x|X]]")).toBe("people/x");
    expect(redirectTargetSlug("[X](/people/x.md#a)")).toBe("people/x");
    expect(redirectTargetSlug("people/x.md")).toBe("people/x");
    expect(redirectTargetSlug("https://example.com/x")).toBeNull();
  });

  // Value: protects=a redirect stub does not take a result place from its target;
  // fails_when=stubs stay in the results next to the page they point at.
  it("gives a frontmatter redirect stub's place to its target", async () => {
    const stub = hit("companies/acme-old", "Old Acme page.", 3);
    const pool = [stub, hit("notes/a", "a note", 2), hit("companies/acme", LONG, 1)];
    const out = await collapseResults(pool, opts({ frontmatterOf: new Map([[stub.chunkId, { redirect_to: "[[companies/acme]]" }]]) }));
    expect(slugs(out)).toEqual(["default:companies/acme", "default:notes/a"]);
    expect(out[0]!.collapsed).toEqual([{ slug: "companies/acme-old", source_id: "default", reason: "redirect" }]);
  });

  it("reads a missing target in through the caller's scope, never for a remote caller", async () => {
    const stub = hit("companies/acme-old", "Old Acme page.", 3);
    const pool = [stub, hit("notes/a", "a note", 2)];
    const frontmatterOf = new Map([[stub.chunkId, { merged_into: "companies/acme" }]]);
    const asked: string[] = [];
    const fetchHead = async (slug: string, sourceId: string) => {
      asked.push(`${sourceId}:${slug}`);
      return hit(slug, LONG, 0);
    };
    const out = await collapseResults(pool, opts({ frontmatterOf, fetchHead }));
    expect(asked).toEqual(["default:companies/acme"]);
    expect(slugs(out)).toEqual(["default:companies/acme", "default:notes/a"]);
    expect(out[0]!.score).toBe(3);
    const remote = await collapseResults(pool, opts({ frontmatterOf, fetchHead, remote: true }));
    expect(slugs(remote)).toEqual(slugs(pool));
    expect(remote[0]!.redirect_to).toBeUndefined();
  });

  it("keeps a stub whose target cannot be shown, naming the target as written", async () => {
    const stub = hit("companies/acme-old", "Old Acme page.", 3);
    const out = await collapseResults([stub], opts({ frontmatterOf: new Map([[stub.chunkId, { redirect_to: "[[companies/acme]]" }]]) }));
    expect(slugs(out)).toEqual(["default:companies/acme-old"]);
    expect(out[0]!.redirect_to).toBe("[[companies/acme]]");
  });

  it("folds a short body stub, not a long page that mentions a move", async () => {
    const body = "This page has been merged into [[companies/acme]].";
    const pool = [hit("companies/acme-old", body, 3), hit("companies/acme", LONG, 1)];
    const short = await collapseResults(pool, opts({ engine: docs({ "default:companies/acme-old": body }) }));
    expect(slugs(short)).toEqual(["default:companies/acme"]);
    const long = await collapseResults(pool, opts({ engine: docs({ "default:companies/acme-old": `${body} ${"more text ".repeat(100)}` }) }));
    expect(slugs(long)).toEqual(slugs(pool));
  });

  it("resolves a bare-word target only to the one page in the results ending in it", async () => {
    const stub = hit("people/bob-old", "stub", 3);
    const pool = [stub, hit("people/bob", LONG, 1)];
    const out = await collapseResults(pool, opts({ frontmatterOf: new Map([[stub.chunkId, { redirect: "bob" }]]) }));
    expect(slugs(out)).toEqual(["default:people/bob"]);
  });

  // Value: protects=the same page copied into two sources takes one place;
  // fails_when=cross-source copies each keep a slot.
  it("folds a copy of a page in another source into the better-ranked one", async () => {
    const pool = [hit("companies/acme", "chunk one", 3), hit("notes/a", "a note", 2), hit("companies/acme", "chunk nine", 1, "tenant-b")];
    const engine = docs({ "default:companies/acme": LONG, "tenant-b:companies/acme": `${LONG} Updated.` });
    const out = await collapseResults(pool, opts({ engine }));
    expect(slugs(out)).toEqual(["default:companies/acme", "default:notes/a"]);
    expect(out[0]!.collapsed).toEqual([{ slug: "companies/acme", source_id: "tenant-b", reason: "twin" }]);
    const different = docs({ "default:companies/acme": LONG, "tenant-b:companies/acme": "A different company entirely, based in Lisbon, making ceramic tiles and pottery." });
    expect(slugs(await collapseResults(pool, opts({ engine: different })))).toEqual(slugs(pool));
  });

  // Value: protects=copies are judged on the whole documents, in both directions;
  // fails_when=the ranked chunks decide, or a short page inside a long one counts as its copy.
  it("judges copies on the documents, not the chunks that ranked, and in both directions", async () => {
    const pool = [hit("companies/acme", LONG, 3), hit("companies/acme", LONG, 1, "tenant-b")];
    const sameChunkDifferentDocs = docs({
      "default:companies/acme": `${LONG} ${"Ledger reconciliation quarterly audit payroll invoices treasury. ".repeat(20)}`,
      "tenant-b:companies/acme": "A different company entirely, based in Lisbon, making ceramic tiles and pottery.",
    });
    expect(slugs(await collapseResults(pool, opts({ engine: sameChunkDifferentDocs })))).toEqual(slugs(pool));
    const shortInsideLong = docs({
      "default:companies/acme": `${LONG} ${"Ledger reconciliation quarterly audit payroll invoices treasury budgets forecasting hiring onboarding laptops vendors contracts renewals pricing discounts margins logistics shipping warehouses. "}`,
      "tenant-b:companies/acme": LONG,
    });
    expect(slugs(await collapseResults(pool, opts({ engine: shortInsideLong })))).toEqual(slugs(pool));
  });

  // Value: protects=a page the caller's fences drop is never named nor absorbs a visible copy;
  // fails_when=a diary or owner-only page folds before the response fences run.
  it("leaves pages the caller will not be shown out of every fold", async () => {
    const engine = docs({ "default:companies/acme": LONG, "tenant-b:companies/acme": LONG });
    const hiddenFirst = [hit("companies/acme", "x", 3), hit("companies/acme", "y", 1, "tenant-b")];
    const fencedChunks = async () => new Set([hiddenFirst[0]!.chunkId]);
    const out = await collapseResults(hiddenFirst, opts({ engine, fencedChunks }));
    expect(slugs(out)).toEqual(slugs(hiddenFirst));
    expect(out.every(h => h.collapsed === undefined)).toBe(true);
    const hiddenSecond = [hiddenFirst[0]!, hiddenFirst[1]!];
    const named = await collapseResults(hiddenSecond, opts({ engine, fencedChunks: async () => new Set([hiddenSecond[1]!.chunkId]) }));
    expect(named[0]!.collapsed).toBeUndefined();
    expect(slugs(named)).toEqual(slugs(hiddenSecond));
    const stub = hit("companies/acme-old", "Old Acme page.", 3);
    const redirect = await collapseResults([stub, hit("companies/acme", LONG, 1)], opts({
      frontmatterOf: new Map([[stub.chunkId, { redirect_to: "[[companies/acme]]" }]]),
      fencedChunks: async () => new Set([stub.chunkId]),
    }));
    expect(redirect.map(h => h.collapsed)).toEqual([undefined, undefined]);
    // A visible stub never folds into a target the fences will drop.
    const visibleStub = hit("companies/acme-old", "Old Acme page.", 3);
    const hiddenTarget = hit("companies/acme", LONG, 1);
    const kept = await collapseResults([visibleStub, hiddenTarget], opts({
      frontmatterOf: new Map([[visibleStub.chunkId, { redirect_to: "[[companies/acme]]" }]]),
      fencedChunks: async () => new Set([hiddenTarget.chunkId]),
    }));
    expect(slugs(kept)).toEqual([visibleStub.documentId, hiddenTarget.documentId]);
  });

  it("returns the input order when nothing folds", async () => {
    const pool = [hit("notes/a", "a", 2), hit("notes/b", "b", 1)];
    expect(await collapseResults(pool, opts())).toEqual(pool);
  });
});

describe("collapse in hybridSearch", () => {
  let dir: string;
  let storage: Storage;
  const saved = process.env["MEMRAIN_SEARCH_COLLAPSE"];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "memrain-collapse-"));
    storage = new Storage({ dbPath: join(dir, "db") });
    await storage.init();
    const docs: Array<{ id: string; fm: Record<string, unknown>; text: string }> = [
      { id: "concepts/ledger-old", fm: { redirect_to: "[[concepts/ledger]]" }, text: "ledger reconciliation ledger reconciliation (moved)" },
      { id: "concepts/ledger", fm: {}, text: "ledger reconciliation runbook for the finance team" },
    ];
    for (const d of docs) {
      await writeDocumentTransaction(
        storage,
        { documentId: d.id, sourcePath: d.id, title: d.id, frontmatter: d.fm, embeddingModel: "deterministic-test" },
        [{ text: d.text, entities: [], embedding: deterministicEmbed(d.text) }],
      );
    }
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env["MEMRAIN_SEARCH_COLLAPSE"];
    else process.env["MEMRAIN_SEARCH_COLLAPSE"] = saved;
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const ids = async () => (await hybridSearch(storage, "ledger reconciliation", { embedQuery: failingEmbed, noCache: true, noTelemetry: true, k: 5 }))
    .map(h => h.documentId);

  // Value: protects=the stub's frontmatter reaches the fold inside a real search;
  // fails_when=the stage is not wired or reads no frontmatter.
  it("folds a redirect stub into its target", async () => {
    delete process.env["MEMRAIN_SEARCH_COLLAPSE"];
    expect(await ids()).toEqual(["concepts/ledger"]);
    process.env["MEMRAIN_SEARCH_COLLAPSE"] = "0";
    expect((await ids()).sort()).toEqual(["concepts/ledger", "concepts/ledger-old"]);
  });
});
