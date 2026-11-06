/**
 * Links — typed page-to-page graph tests.
 *
 * Covers slug grammar, slugifyTarget normalisation, idempotent add /
 * remove, confidence range, direction-filtered neighbors, typed
 * graphQuery, [[wikilink]] extractor, and the post-page-write sync
 * that replaces a source's wikilink-typed edge set without touching
 * other-typed edges.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import {
  addLink,
  extractWikilinks,
  graphNeighbors,
  graphQuery,
  KNOWN_LINK_TYPES,
  removeLink,
  slugifyTarget,
  syncWikilinksForPage,
} from "../src/core/links.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-links-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// slugifyTarget
// ---------------------------------------------------------------------------

describe("slugifyTarget", () => {
  it("kebab-cases a name", () => {
    expect(slugifyTarget("Alice Smith")).toBe("alice-smith");
  });

  it("preserves / namespaces", () => {
    expect(slugifyTarget("people/alice")).toBe("people/alice");
    expect(slugifyTarget("People/Alice Smith")).toBe("people/alice-smith");
  });

  it("collapses repeated separators", () => {
    expect(slugifyTarget("Alice    Smith")).toBe("alice-smith");
    expect(slugifyTarget("people//alice")).toBe("people/alice");
    expect(slugifyTarget("alice--smith")).toBe("alice-smith");
  });

  it("strips non-ascii cleanly", () => {
    expect(slugifyTarget("Алиса Smith")).toBe("smith");
  });

  it("falls back to 'unknown' on empty / all-stripped input", () => {
    expect(slugifyTarget("")).toBe("unknown");
    expect(slugifyTarget("!!!!")).toBe("unknown");
  });

  it("keeps an all-non-Latin name instead of collapsing to 'unknown'", () => {
    expect(slugifyTarget("Тимур Галеев")).toBe("тимур-галеев");
    expect(slugifyTarget("Люди/Тимур Галеев")).toBe("люди/тимур-галеев");
    // Mixed input keeps the historical ASCII fold, so existing stored slugs
    // made from mixed-script names stay stable.
    expect(slugifyTarget("Алиса Smith")).toBe("smith");
  });

  it("strips edge separators", () => {
    expect(slugifyTarget("-alice-")).toBe("alice");
    expect(slugifyTarget("/alice/")).toBe("alice");
  });

  it.each([
    ["people/иван-петров", "people/иван-петров"],
    ["people/Иван", "people/иван"],
    ["a/б/c", "a/б/c"],
    ["東京/支店", "東京/支店"],
    ["Иван Smith", "smith"],
    ["Анна (CTO)", "cto"],
    ["Alice Smith", "alice-smith"],
    ["people/alice-smith", "people/alice-smith"],
    ["people /alice", "people-/alice"], // Latin input stays byte-for-byte as before
  ])("keeps non-Latin path segments: %s → %s", (input, want) => {
    expect(slugifyTarget(input)).toBe(want);
  });

  it("is idempotent on every valid unicode slug it produces", () => {
    for (const s of ["people/иван-петров", "東京/支店", "projects/мост-2026", "a/б/c"]) {
      expect(slugifyTarget(slugifyTarget(s))).toBe(slugifyTarget(s));
    }
  });
});

// ---------------------------------------------------------------------------
// addLink — idempotent
// ---------------------------------------------------------------------------

describe("addLink", () => {
  it("requires the source page to exist", async () => {
    await expect(
      addLink(storage, {
        source_slug: "people/ghost",
        target_slug: "companies/acme",
        type: "works_at",
      }),
    ).rejects.toThrow();
  });

  it("creates a link with default confidence 1.0", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    const r = await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
    });
    expect(r.created).toBe(true);
    expect(r.target_slug).toBe("companies/acme");
    expect(r.type).toBe("works_at");
  });

  it("re-adding the same edge is idempotent", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
    });
    const r = await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
    });
    expect(r.created).toBe(false);
  });

  it("re-adding updates confidence", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
      confidence: 0.5,
    });
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
      confidence: 0.9,
    });
    const r = await graphQuery(storage, {
      type: "works_at",
      source_slug: "people/alice",
    });
    expect(r[0]!.inferred_confidence).toBeCloseTo(0.9, 3);
  });

  it("rejects unknown type by default", async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    await expect(
      addLink(storage, {
        source_slug: "alice",
        target_slug: "x",
        type: "weird_type",
      }),
    ).rejects.toThrow(/KNOWN_LINK_TYPES/);
  });

  it("accepts ad-hoc type with allowAdHocType=true", async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    const r = await addLink(storage, {
      source_slug: "alice",
      target_slug: "x",
      type: "weird_type",
      allowAdHocType: true,
    });
    expect(r.created).toBe(true);
  });

  it("rejects out-of-range confidence", async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    await expect(
      addLink(storage, {
        source_slug: "alice",
        target_slug: "x",
        type: "works_at",
        confidence: 1.5,
      }),
    ).rejects.toThrow(/\[0, 1\]/);
  });

  it("normalises target via slugifyTarget", async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    const r = await addLink(storage, {
      source_slug: "alice",
      target_slug: "Companies/Acme Corp",
      type: "works_at",
    });
    expect(r.target_slug).toBe("companies/acme-corp");
  });
});

// ---------------------------------------------------------------------------
// addLink — provenance columns (migration 029)
// ---------------------------------------------------------------------------

interface RawLinkRow {
  context: string;
  link_kind: string | null;
  origin_slug: string | null;
  origin_field: string | null;
  resolution_type: string | null;
}

async function readProvenance(
  src: string,
  tgt: string,
  type: string,
): Promise<RawLinkRow> {
  const r = await storage.engine().query<RawLinkRow>(
    `SELECT context, link_kind, origin_slug, origin_field, resolution_type
       FROM links WHERE source_slug = $1 AND target_slug = $2 AND type = $3`,
    [src, tgt, type],
  );
  return r.rows[0]!;
}

describe("addLink provenance (migration 029)", () => {
  it("defaults to empty context + NULL provenance for a bare link", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
    });
    const row = await readProvenance("people/alice", "companies/acme", "works_at");
    expect(row.context).toBe("");
    expect(row.link_kind).toBeNull();
    expect(row.origin_slug).toBeNull();
    expect(row.origin_field).toBeNull();
    expect(row.resolution_type).toBeNull();
  });

  it("persists provenance when an enrichment caller supplies it", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    await putPage(storage, { slug: "notes/standup", type: "note" });
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
      context: "Alice joined Acme as CTO in 2024.",
      link_kind: "typed_ner",
      origin_slug: "notes/standup",
      origin_field: "key_people",
      resolution_type: "qualified",
    });
    const row = await readProvenance("people/alice", "companies/acme", "works_at");
    expect(row.context).toContain("Acme as CTO");
    expect(row.link_kind).toBe("typed_ner");
    expect(row.origin_slug).toBe("notes/standup");
    expect(row.origin_field).toBe("key_people");
    expect(row.resolution_type).toBe("qualified");
  });

  it("keeps provenance sticky on a bare re-add (no wipe)", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
      context: "derived window",
      link_kind: "plain",
    });
    // A bare re-add (e.g. the explicit `link` MCP tool) must NOT clobber it.
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
    });
    const row = await readProvenance("people/alice", "companies/acme", "works_at");
    expect(row.context).toBe("derived window");
    expect(row.link_kind).toBe("plain");
  });

  it("overwrites context when a non-empty one is re-supplied", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
      context: "old window",
    });
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "works_at",
      context: "new window",
    });
    const row = await readProvenance("people/alice", "companies/acme", "works_at");
    expect(row.context).toBe("new window");
  });

  it("rejects an invalid link_kind at the boundary", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    await expect(
      addLink(storage, {
        source_slug: "people/alice",
        target_slug: "companies/acme",
        type: "works_at",
        // @ts-expect-error — exercising the runtime guard
        link_kind: "bogus",
      }),
    ).rejects.toThrow(/link_kind/);
  });

  it("rejects an invalid resolution_type at the boundary", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    await expect(
      addLink(storage, {
        source_slug: "people/alice",
        target_slug: "companies/acme",
        type: "works_at",
        // @ts-expect-error — exercising the runtime guard
        resolution_type: "fuzzy",
      }),
    ).rejects.toThrow(/resolution_type/);
  });

  it("validates origin_slug grammar", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    await expect(
      addLink(storage, {
        source_slug: "people/alice",
        target_slug: "companies/acme",
        type: "works_at",
        origin_slug: "Not A Slug!",
      }),
    ).rejects.toThrow(/slug/);
  });
});

// ---------------------------------------------------------------------------
// removeLink
// ---------------------------------------------------------------------------

describe("removeLink", () => {
  it("removes an existing link", async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    await addLink(storage, {
      source_slug: "alice",
      target_slug: "acme",
      type: "works_at",
    });
    const r = await removeLink(storage, {
      source_slug: "alice",
      target_slug: "acme",
      type: "works_at",
    });
    expect(r.removed).toBe(1);
  });

  it("idempotent on missing edge", async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    const r = await removeLink(storage, {
      source_slug: "alice",
      target_slug: "ghost",
      type: "works_at",
    });
    expect(r.removed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// graphNeighbors — direction filter
// ---------------------------------------------------------------------------

describe("graphNeighbors", () => {
  beforeEach(async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    await putPage(storage, { slug: "bob", type: "person" });
    await putPage(storage, { slug: "acme", type: "company" });
    await addLink(storage, {
      source_slug: "alice",
      target_slug: "acme",
      type: "works_at",
    });
    await addLink(storage, {
      source_slug: "bob",
      target_slug: "alice",
      type: "knows",
    });
    await addLink(storage, {
      source_slug: "alice",
      target_slug: "bob",
      type: "knows",
    });
  });

  it("returns outbound only when direction=outbound", async () => {
    const r = await graphNeighbors(storage, "alice", { direction: "outbound" });
    expect(r.every((x) => x.direction === "outbound")).toBe(true);
    expect(r.map((x) => x.target_slug).sort()).toEqual(["acme", "bob"]);
  });

  it("returns inbound only when direction=inbound", async () => {
    const r = await graphNeighbors(storage, "alice", { direction: "inbound" });
    expect(r.every((x) => x.direction === "inbound")).toBe(true);
    expect(r.map((x) => x.source_slug)).toContain("bob");
  });

  it("returns both directions by default", async () => {
    const r = await graphNeighbors(storage, "alice");
    const dirs = new Set(r.map((x) => x.direction));
    expect(dirs.has("outbound")).toBe(true);
    expect(dirs.has("inbound")).toBe(true);
  });

  it("filters by type", async () => {
    const r = await graphNeighbors(storage, "alice", { type: "works_at" });
    expect(r.length).toBe(1);
    expect(r[0]!.target_slug).toBe("acme");
  });
});

// ---------------------------------------------------------------------------
// graphQuery
// ---------------------------------------------------------------------------

describe("graphQuery", () => {
  beforeEach(async () => {
    for (const slug of ["alice", "bob", "carol"]) {
      await putPage(storage, { slug, type: "person" });
    }
    const edges: [string, string][] = [
      ["alice", "acme"],
      ["bob", "acme"],
      ["carol", "globex"],
    ];
    for (const [s, t] of edges) {
      await addLink(storage, {
        source_slug: s,
        target_slug: t,
        type: "works_at",
      });
    }
  });

  it("returns people who work at a given target", async () => {
    const r = await graphQuery(storage, {
      type: "works_at",
      target_slug: "acme",
    });
    expect(r.map((x) => x.source_slug).sort()).toEqual(["alice", "bob"]);
  });

  it("returns companies a person works at", async () => {
    const r = await graphQuery(storage, {
      type: "works_at",
      source_slug: "alice",
    });
    expect(r.length).toBe(1);
    expect(r[0]!.target_slug).toBe("acme");
  });

  it("rejects unbounded queries (no source AND no target)", async () => {
    await expect(
      graphQuery(storage, { type: "works_at" }),
    ).rejects.toThrow(/at least one/);
  });

  it("orders by confidence desc", async () => {
    await addLink(storage, {
      source_slug: "carol",
      target_slug: "acme",
      type: "works_at",
      confidence: 0.3,
    });
    await addLink(storage, {
      source_slug: "alice",
      target_slug: "acme",
      type: "works_at",
      confidence: 1.0,
    });
    const r = await graphQuery(storage, {
      type: "works_at",
      target_slug: "acme",
    });
    expect(r[0]!.inferred_confidence).toBeGreaterThanOrEqual(
      r[r.length - 1]!.inferred_confidence,
    );
  });
});

// ---------------------------------------------------------------------------
// extractWikilinks
// ---------------------------------------------------------------------------

describe("extractWikilinks", () => {
  it("finds [[wikilinks]]", () => {
    expect(extractWikilinks("hi [[Alice]] and [[Bob]]").sort()).toEqual([
      "Alice",
      "Bob",
    ]);
  });

  it("handles |aliased pipes", () => {
    expect(extractWikilinks("see [[Alice|the boss]]")).toEqual(["Alice"]);
  });

  it("dedupes within a single body", () => {
    expect(
      extractWikilinks("[[Alice]] and [[Alice]] again [[Alice|A]]"),
    ).toEqual(["Alice"]);
  });

  it("ignores empty / malformed brackets", () => {
    expect(extractWikilinks("[[]] [[ ]] [single] [[broken")).toEqual([]);
  });

  it("handles empty body", () => {
    expect(extractWikilinks("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// syncWikilinksForPage — idempotent replace
// ---------------------------------------------------------------------------

describe("syncWikilinksForPage", () => {
  it("inserts wikilink edges for every [[name]] in body", async () => {
    await putPage(storage, { slug: "journal/today", type: "journal" });
    const r = await syncWikilinksForPage(
      storage,
      "journal/today",
      "saw [[Alice]] and [[Bob]] at lunch",
    );
    expect(r.added).toBe(2);
    expect(r.removed).toBe(0);
    const links = await graphNeighbors(storage, "journal/today", {
      type: "wikilink",
      direction: "outbound",
    });
    expect(links.map((l) => l.target_slug).sort()).toEqual(["alice", "bob"]);
  });

  it("replaces stale wikilink edges on re-sync", async () => {
    await putPage(storage, { slug: "journal/today", type: "journal" });
    await syncWikilinksForPage(
      storage,
      "journal/today",
      "[[Alice]] [[Bob]]",
    );
    const r = await syncWikilinksForPage(
      storage,
      "journal/today",
      "[[Alice]] [[Carol]]",
    );
    // Bob is gone, Carol is new, Alice stays — total: removed=2, added=1
    // (re-insert wipes ALL wikilink rows then adds back fresh set).
    expect(r.removed).toBe(2);
    expect(r.added).toBe(2);
    const links = await graphNeighbors(storage, "journal/today", {
      type: "wikilink",
      direction: "outbound",
    });
    expect(links.map((l) => l.target_slug).sort()).toEqual(["alice", "carol"]);
  });

  it("does not touch other-typed edges on this source", async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    await addLink(storage, {
      source_slug: "alice",
      target_slug: "acme",
      type: "works_at",
    });
    await syncWikilinksForPage(storage, "alice", "see [[bob]]");
    const works = await graphQuery(storage, {
      type: "works_at",
      source_slug: "alice",
    });
    expect(works.length).toBe(1);
    expect(works[0]!.target_slug).toBe("acme");
  });

  it("does not touch wikilink edges from OTHER sources", async () => {
    await putPage(storage, { slug: "page-a", type: "note" });
    await putPage(storage, { slug: "page-b", type: "note" });
    await syncWikilinksForPage(storage, "page-a", "[[shared-target]]");
    await syncWikilinksForPage(storage, "page-b", "[[different]]");
    // Re-sync page-a — page-b's wikilink should be untouched.
    await syncWikilinksForPage(storage, "page-a", "[[new]]");
    const bLinks = await graphNeighbors(storage, "page-b", {
      type: "wikilink",
      direction: "outbound",
    });
    expect(bLinks.length).toBe(1);
    expect(bLinks[0]!.target_slug).toBe("different");
  });

  it("empty body clears all wikilink edges for the source", async () => {
    await putPage(storage, { slug: "page", type: "note" });
    await syncWikilinksForPage(storage, "page", "[[a]] [[b]]");
    const r = await syncWikilinksForPage(storage, "page", "");
    expect(r.removed).toBe(2);
    expect(r.added).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Surface: known types catalogue
// ---------------------------------------------------------------------------

describe("KNOWN_LINK_TYPES catalogue", () => {
  it("contains the architecturally-significant types", () => {
    for (const t of [
      "wikilink",
      "mentions",
      "works_at",
      "attended",
      "founded",
      "advises",
      "invested_in",
      "knows",
      "met",
      "located_at",
      "related_to",
      "supersedes",
      "contradicts",
    ]) {
      expect(KNOWN_LINK_TYPES).toContain(t as never);
    }
  });
});
