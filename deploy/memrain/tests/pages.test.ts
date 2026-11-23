/**
 * Pages — DB-canonical page store CRUD tests.
 *
 * Covers slug validation, idempotent put, content versioning, append,
 * soft delete, list filters, and the page_versions audit trail.
 *
 * Uses a fresh PGLite-backed Storage per test — no Bedrock, no HTTP.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { setSlugAlias } from "../src/core/slug-aliases.ts";
import {
  appendPage,
  deletePage,
  getPage,
  KNOWN_PAGE_TYPES,
  listPages,
  pageVersions,
  putPage,
  renamePage,
  validateSlug,
} from "../src/core/pages.ts";

let tmp: string;
let storage: Storage;

/** Fresh store per test, for the describes that touch the database. */
function useStorage(): void {
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-pages-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });
}

// ---------------------------------------------------------------------------
// validateSlug
// ---------------------------------------------------------------------------

describe("validateSlug", () => {
  it("accepts kebab-case", () => {
    expect(() => validateSlug("alice")).not.toThrow();
    expect(() => validateSlug("the-quick-brown-fox")).not.toThrow();
  });

  it("accepts /-namespaces", () => {
    expect(() =>
      validateSlug("journal/2026/05/2026-05-18"),
    ).not.toThrow();
    expect(() => validateSlug("people/alice-smith")).not.toThrow();
  });

  it("rejects uppercase", () => {
    expect(() => validateSlug("Alice")).toThrow(/kebab-case/);
    expect(() => validateSlug("Тимур")).toThrow(/kebab-case/);
  });

  it("accepts non-Latin lowercase slugs", () => {
    expect(() => validateSlug("люди/тимур-галеев")).not.toThrow();
    expect(() => validateSlug("知识/笔记")).not.toThrow();
  });

  it("rejects leading hyphen / slash", () => {
    expect(() => validateSlug("-alice")).toThrow();
    expect(() => validateSlug("/alice")).toThrow();
  });

  it("rejects spaces", () => {
    expect(() => validateSlug("alice smith")).toThrow();
  });

  it("rejects empty", () => {
    expect(() => validateSlug("")).toThrow(/non-empty/);
  });

  it("rejects double-slash", () => {
    expect(() => validateSlug("a//b")).toThrow();
  });

  it("rejects overly long slugs", () => {
    expect(() => validateSlug("a".repeat(257))).toThrow(/exceeds/);
  });
});

// ---------------------------------------------------------------------------
// putPage — first write
// ---------------------------------------------------------------------------

describe("putPage — first write", () => {
  useStorage();
  it("creates a page with version_n=1", async () => {
    const r = await putPage(storage, {
      slug: "alice",
      type: "person",
      title: "Alice",
      markdown_body: "Met Alice at the conference.",
    });
    expect(r.created).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.version_n).toBe(1);
    expect(r.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an unknown type by default", async () => {
    await expect(
      putPage(storage, { slug: "x", type: "spaceship" }),
    ).rejects.toThrow(/KNOWN_PAGE_TYPES/);
  });

  it("accepts an ad-hoc type when allowAdHocType=true", async () => {
    const r = await putPage(storage, {
      slug: "ufo-sighting-2026",
      type: "ufo-report",
      allowAdHocType: true,
    });
    expect(r.created).toBe(true);
  });

  it("normalises type to lowercase", async () => {
    await putPage(storage, { slug: "alice", type: "PERSON" });
    const row = await getPage(storage, "alice");
    expect(row?.type).toBe("person");
  });

  it("every well-known type is accepted", async () => {
    for (const t of KNOWN_PAGE_TYPES) {
      await putPage(storage, { slug: `test-${t}`, type: t });
    }
  });
});

// ---------------------------------------------------------------------------
// putPage — idempotent re-put
// ---------------------------------------------------------------------------

describe("putPage — idempotency", () => {
  useStorage();
  it("identical re-put is a no-op", async () => {
    const a = await putPage(storage, {
      slug: "alice",
      type: "person",
      title: "Alice",
      markdown_body: "Note 1",
    });
    const b = await putPage(storage, {
      slug: "alice",
      type: "person",
      title: "Alice",
      markdown_body: "Note 1",
    });
    expect(b.created).toBe(false);
    expect(b.changed).toBe(false);
    expect(b.version_n).toBe(a.version_n);
    const versions = await pageVersions(storage, "alice");
    expect(versions.length).toBe(1);
  });

  it("re-put with the same truth in another key order is a no-op", async () => {
    await putPage(storage, { slug: "alice", type: "person", markdown_body: "x", compiled_truth: { url: "u", closes: [1], n: { zeta: 1, a: 2 } } });
    const b = await putPage(storage, { slug: "alice", type: "person", markdown_body: "x", compiled_truth: { n: { a: 2, zeta: 1 }, closes: [1], url: "u" } });
    expect(b.changed).toBe(false);
    expect((await pageVersions(storage, "alice")).length).toBe(1);
  });

  it("body change bumps version", async () => {
    await putPage(storage, {
      slug: "alice",
      type: "person",
      markdown_body: "v1",
    });
    const r = await putPage(storage, {
      slug: "alice",
      type: "person",
      markdown_body: "v2",
    });
    expect(r.created).toBe(false);
    expect(r.changed).toBe(true);
    expect(r.version_n).toBe(2);
  });

  it("title change without body change still bumps version", async () => {
    await putPage(storage, { slug: "alice", type: "person", title: "Alice" });
    const r = await putPage(storage, {
      slug: "alice",
      type: "person",
      title: "Alice Smith",
    });
    expect(r.changed).toBe(true);
    expect(r.version_n).toBe(2);
  });

  it("compiled_truth change bumps version", async () => {
    await putPage(storage, {
      slug: "alice",
      type: "person",
      compiled_truth: { tier: 1 },
    });
    const r = await putPage(storage, {
      slug: "alice",
      type: "person",
      compiled_truth: { tier: 2 },
    });
    expect(r.changed).toBe(true);
    expect(r.version_n).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getPage
// ---------------------------------------------------------------------------

describe("getPage", () => {
  useStorage();
  it("returns null for unknown slug", async () => {
    const r = await getPage(storage, "ghost");
    expect(r).toBeNull();
  });

  it("returns the latest row", async () => {
    await putPage(storage, {
      slug: "alice",
      type: "person",
      title: "Alice",
      markdown_body: "Initial note.",
      compiled_truth: { tier: 1 },
    });
    const r = await getPage(storage, "alice");
    expect(r).not.toBeNull();
    expect(r!.slug).toBe("alice");
    expect(r!.type).toBe("person");
    expect(r!.title).toBe("Alice");
    expect(r!.markdown_body).toBe("Initial note.");
    expect(r!.compiled_truth).toEqual({ tier: 1 });
  });

  it("does not return soft-deleted pages", async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    await deletePage(storage, "alice");
    expect(await getPage(storage, "alice")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listPages
// ---------------------------------------------------------------------------

describe("listPages", () => {
  useStorage();
  it("returns newest-first", async () => {
    await putPage(storage, { slug: "old", type: "note", markdown_body: "a" });
    // Force a measurable delta in updated_at.
    await new Promise((r) => setTimeout(r, 10));
    await putPage(storage, { slug: "new", type: "note", markdown_body: "b" });
    const r = await listPages(storage);
    expect(r.length).toBe(2);
    expect(r[0]!.slug).toBe("new");
    expect(r[1]!.slug).toBe("old");
  });

  it("filters by type", async () => {
    await putPage(storage, { slug: "p1", type: "person" });
    await putPage(storage, { slug: "p2", type: "person" });
    await putPage(storage, { slug: "c1", type: "company" });
    const persons = await listPages(storage, { type: "person" });
    expect(persons.length).toBe(2);
    expect(persons.every((p) => p.type === "person")).toBe(true);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      await putPage(storage, { slug: `p-${i}`, type: "note" });
    }
    const r = await listPages(storage, { limit: 3 });
    expect(r.length).toBe(3);
  });

  it("omits soft-deleted pages", async () => {
    await putPage(storage, { slug: "kept", type: "note" });
    await putPage(storage, { slug: "gone", type: "note" });
    await deletePage(storage, "gone");
    const r = await listPages(storage);
    expect(r.length).toBe(1);
    expect(r[0]!.slug).toBe("kept");
  });
});

// ---------------------------------------------------------------------------
// pageVersions
// ---------------------------------------------------------------------------

describe("pageVersions", () => {
  useStorage();
  it("returns descending version_n", async () => {
    await putPage(storage, {
      slug: "alice",
      type: "person",
      markdown_body: "v1",
    });
    await putPage(storage, {
      slug: "alice",
      type: "person",
      markdown_body: "v2",
    });
    await putPage(storage, {
      slug: "alice",
      type: "person",
      markdown_body: "v3",
    });
    const v = await pageVersions(storage, "alice");
    expect(v.map((x) => x.version_n)).toEqual([3, 2, 1]);
    expect(v[0]!.body_snapshot).toBe("v3");
    expect(v[2]!.hash_prev).toBeNull();
    expect(v[1]!.hash_prev).toBe(v[2]!.hash_new);
  });

  it("records written_by", async () => {
    await putPage(storage, {
      slug: "alice",
      type: "person",
      markdown_body: "x",
      written_by: "idea-capture-skill",
    });
    const v = await pageVersions(storage, "alice");
    expect(v[0]!.written_by).toBe("idea-capture-skill");
  });
});

// ---------------------------------------------------------------------------
// appendPage
// ---------------------------------------------------------------------------

describe("appendPage", () => {
  useStorage();
  it("appends to existing body and bumps version", async () => {
    await putPage(storage, {
      slug: "alice",
      type: "person",
      markdown_body: "first line",
    });
    const r = await appendPage(storage, {
      slug: "alice",
      content: "second line",
    });
    expect(r.version_n).toBe(2);
    const got = await getPage(storage, "alice");
    expect(got!.markdown_body).toBe("first line\nsecond line");
  });

  it("does not double-newline when body already ends with \\n", async () => {
    await putPage(storage, {
      slug: "alice",
      type: "person",
      markdown_body: "first line\n",
    });
    await appendPage(storage, { slug: "alice", content: "second line" });
    const got = await getPage(storage, "alice");
    expect(got!.markdown_body).toBe("first line\nsecond line");
  });

  it("rejects appending to a page that does not exist", async () => {
    await expect(
      appendPage(storage, { slug: "ghost", content: "x" }),
    ).rejects.toThrow(/page not found/);
  });

  it("preserves type and compiled_truth across appends", async () => {
    await putPage(storage, {
      slug: "alice",
      type: "person",
      title: "Alice",
      compiled_truth: { tier: 1 },
      markdown_body: "x",
    });
    await appendPage(storage, { slug: "alice", content: "y" });
    const got = await getPage(storage, "alice");
    expect(got!.type).toBe("person");
    expect(got!.title).toBe("Alice");
    expect(got!.compiled_truth).toEqual({ tier: 1 });
  });
});

// ---------------------------------------------------------------------------
// deletePage
// ---------------------------------------------------------------------------

describe("deletePage", () => {
  useStorage();
  it("soft-deletes (page row stays, versions stay)", async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    const r = await deletePage(storage, "alice");
    expect(r.already_deleted).toBe(false);
    expect(await getPage(storage, "alice")).toBeNull();
    // Versions remain — query directly via engine.
    const v = await storage
      .engine()
      .query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM page_versions WHERE slug = $1",
        ["alice"],
      );
    expect(v.rows[0]!.c).toBeGreaterThan(0);
  });

  it("appends a tombstone version row", async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    await deletePage(storage, "alice", "test-suite");
    const r = await storage
      .engine()
      .query<{ version_n: number; written_by: string | null }>(
        "SELECT version_n, written_by FROM page_versions WHERE slug = $1 ORDER BY version_n DESC",
        ["alice"],
      );
    expect(r.rows[0]!.version_n).toBe(2);
    expect(r.rows[0]!.written_by).toBe("test-suite");
  });

  it("re-delete is a no-op", async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    await deletePage(storage, "alice");
    const r = await deletePage(storage, "alice");
    expect(r.already_deleted).toBe(true);
  });

  it("delete of unknown slug returns already_deleted=true", async () => {
    const r = await deletePage(storage, "ghost");
    expect(r.already_deleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// putPage over a soft-deleted slug
// ---------------------------------------------------------------------------

describe("putPage — resurrect a soft-deleted page", () => {
  useStorage();
  const pageRowCount = async (slug: string): Promise<number> => {
    const r = await storage
      .engine()
      .query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM pages WHERE slug = $1",
        [slug],
      );
    return r.rows[0]!.c;
  };

  it("re-put of a deleted slug undeletes it in place", async () => {
    await putPage(storage, {
      slug: "alice",
      type: "person",
      title: "Alice",
      markdown_body: "v1",
    });
    await deletePage(storage, "alice");
    expect(await getPage(storage, "alice")).toBeNull();

    const r = await putPage(storage, {
      slug: "alice",
      type: "person",
      title: "Alice",
      markdown_body: "v2",
    });
    expect(r.created).toBe(false);
    expect(r.changed).toBe(true);

    const got = await getPage(storage, "alice");
    expect(got).not.toBeNull();
    expect(got!.deleted_at).toBeNull();
    expect(got!.markdown_body).toBe("v2");
    expect(await pageRowCount("alice")).toBe(1);
  });

  it("continues the version chain across the delete", async () => {
    await putPage(storage, {
      slug: "alice",
      type: "person",
      markdown_body: "v1",
    });
    await deletePage(storage, "alice");
    const r = await putPage(storage, {
      slug: "alice",
      type: "person",
      markdown_body: "v2",
    });
    // v1, tombstone, v2 — the resurrect appends, it does not restart at 1.
    expect(r.version_n).toBe(3);
    const v = await pageVersions(storage, "alice");
    expect(v.map((x) => x.version_n)).toEqual([3, 2, 1]);
    expect(v[0]!.body_snapshot).toBe("v2");
  });

  it("re-put with identical content still brings the page back", async () => {
    const input = {
      slug: "alice",
      type: "person",
      title: "Alice",
      compiled_truth: { tier: 1 },
      markdown_body: "same body",
    };
    await putPage(storage, input);
    await deletePage(storage, "alice");
    const r = await putPage(storage, input);
    expect(r.changed).toBe(true);

    const got = await getPage(storage, "alice");
    expect(got).not.toBeNull();
    expect(got!.deleted_at).toBeNull();
    expect(await pageRowCount("alice")).toBe(1);
  });

  it("a resurrected page shows up in listPages again", async () => {
    await putPage(storage, { slug: "gone", type: "note", markdown_body: "a" });
    await deletePage(storage, "gone");
    expect(await listPages(storage)).toEqual([]);
    await putPage(storage, {
      slug: "gone",
      type: "note",
      markdown_body: "b",
    });
    const r = await listPages(storage);
    expect(r.map((p) => p.slug)).toEqual(["gone"]);
  });

  it("preserves the deleted page's type when the re-put omits it", async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    await deletePage(storage, "alice");
    await putPage(storage, {
      slug: "alice",
      markdown_body: "back",
    });
    expect((await getPage(storage, "alice"))?.type).toBe("person");
  });

  it("refuses to resurrect a slug owned by another source", async () => {
    for (const id of ["src-a", "src-b"]) {
      await storage
        .engine()
        .query(
          "INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING",
          [id, `/${id}`],
        );
    }
    await putPage(storage, {
      slug: "alice",
      type: "person",
      source_id: "src-a",
    });
    await deletePage(storage, "alice");
    await expect(
      putPage(storage, {
        slug: "alice",
        type: "person",
        source_id: "src-b",
        markdown_body: "hostile",
      }),
    ).rejects.toThrow(/owned by another source/);
  });
});

// ---------------------------------------------------------------------------
// Resurrection is unconditional: ANY re-put of the slug brings the page back,
// including a background writer's, which therefore undoes an operator delete.
// ---------------------------------------------------------------------------

describe("putPage — background re-put of a deleted page", () => {
  useStorage();
  it("resurrects the page and continues its history", async () => {
    await putPage(storage, {
      slug: "takes/hot",
      type: "note",
      title: "Hot take",
      markdown_body: "v1",
    });
    await deletePage(storage, "takes/hot", "operator");

    // The atoms/takes mirror re-deriving the page on the next cycle.
    const r = await putPage(storage, {
      slug: "takes/hot",
      type: "note",
      title: "Hot take",
      markdown_body: "re-derived",
      written_by: "atoms",
    });
    expect(r.changed).toBe(true);
    expect(r.created).toBe(false);
    // v1, tombstone, re-derived — one row, one continuing version chain.
    expect(r.version_n).toBe(3);

    const got = await getPage(storage, "takes/hot");
    expect(got!.deleted_at).toBeNull();
    expect(got!.markdown_body).toBe("re-derived");
    expect((await listPages(storage)).map((p) => p.slug)).toEqual(["takes/hot"]);

    const rows = await storage
      .engine()
      .query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM pages WHERE slug = $1",
        ["takes/hot"],
      );
    expect(rows.rows[0]!.c).toBe(1);
  });

  it("writes a version row for the resurrecting write", async () => {
    await putPage(storage, { slug: "gone", type: "note", markdown_body: "v1" });
    await deletePage(storage, "gone");
    const before = await pageVersions(storage, "gone");

    await putPage(storage, {
      slug: "gone",
      type: "note",
      markdown_body: "re-derived",
    });
    const after = await pageVersions(storage, "gone");
    expect(after.length).toBe(before.length + 1);
    expect(after[0]!.body_snapshot).toBe("re-derived");
  });

  it("still writes normally to a live page", async () => {
    await putPage(storage, { slug: "alive", type: "note", markdown_body: "v1" });
    const r = await putPage(storage, {
      slug: "alive",
      type: "note",
      markdown_body: "v2",
    });
    expect(r.changed).toBe(true);
    expect((await getPage(storage, "alive"))!.markdown_body).toBe("v2");
  });

  it("appendPage to a deleted page fails rather than reviving it", async () => {
    await putPage(storage, { slug: "gone", type: "note", markdown_body: "v1" });
    await deletePage(storage, "gone");
    await expect(
      appendPage(storage, { slug: "gone", content: "more" }),
    ).rejects.toThrow(/page not found/);
    expect(await getPage(storage, "gone")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// putPage over a slug that was MERGED away — the stub row survives soft-deleted
// and carries a redirect, so an unconditional resurrect would shadow the
// canonical page and undo the merge.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// putPage over a slug that was RENAMED away. Unlike a merge, a rename hard-
// deletes the old row and leaves only the redirect — so the re-put takes the
// CREATE branch, and an unfenced insert would drop a live shadow page on a slug
// that reads (exact-match first) ahead of the redirect.
// ---------------------------------------------------------------------------

describe("putPage — renamed-away slug", () => {
  useStorage();
  const countRows = async (slug: string): Promise<number> => {
    const r = await storage
      .engine()
      .query<{ c: number }>(
        "SELECT COUNT(*)::int AS c FROM pages WHERE slug = $1",
        [slug],
      );
    return r.rows[0]!.c;
  };

  it("refuses to create a shadow at the old slug", async () => {
    await putPage(storage, {
      slug: "notes/old",
      type: "note",
      markdown_body: "v1",
    });
    const moved = await renamePage(storage, "notes/old", "notes/new");
    expect(moved.renamed).toBe(true);
    // No row at all survives the rename — this is the create path, not a
    // resurrect.
    expect(await countRows("notes/old")).toBe(0);

    await expect(
      putPage(storage, {
        slug: "notes/old",
        type: "note",
        markdown_body: "shadow",
      }),
    ).rejects.toThrow(/redirects to 'notes\/new'/);

    // Nothing was inserted, and the old slug still forwards to the renamed page.
    expect(await countRows("notes/old")).toBe(0);
    const got = await getPage(storage, "notes/old");
    expect(got!.slug).toBe("notes/new");
    expect(got!.markdown_body).toBe("v1");
  });

  it("still creates the slug once the redirect target is gone", async () => {
    await putPage(storage, {
      slug: "notes/old",
      type: "note",
      markdown_body: "v1",
    });
    expect((await renamePage(storage, "notes/old", "notes/new")).renamed).toBe(
      true,
    );
    await deletePage(storage, "notes/new");

    const r = await putPage(storage, {
      slug: "notes/old",
      type: "note",
      markdown_body: "reborn",
    });
    expect(r.created).toBe(true);
    expect((await getPage(storage, "notes/old"))!.markdown_body).toBe("reborn");
  });
});

// ---------------------------------------------------------------------------
// The fence's canonical probe is source-scoped: a live page at the redirect
// target under ANOTHER tenant is not this tenant's canonical, so it must not
// refuse a write the caller is entitled to make.
// ---------------------------------------------------------------------------

describe("putPage — redirect whose canonical is in another source", () => {
  useStorage();
  const seedSources = async (): Promise<void> => {
    for (const id of ["src-a", "src-b"]) {
      await storage
        .engine()
        .query(
          "INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING",
          [id, `/${id}`],
        );
    }
    // Only src-b holds a live page at the redirect target.
    await putPage(storage, {
      slug: "shared/topic",
      type: "note",
      source_id: "src-b",
      markdown_body: "theirs",
    });
    await setSlugAlias(storage.engine(), {
      alias_slug: "notes/mine",
      canonical_slug: "shared/topic",
      source_id: "src-a",
    });
  };

  it("does not block resurrecting a soft-deleted slug", async () => {
    await seedSources();
    await putPage(storage, {
      slug: "notes/mine",
      type: "note",
      source_id: "src-a",
      markdown_body: "v1",
    });
    await deletePage(storage, "notes/mine");

    const r = await putPage(storage, {
      slug: "notes/mine",
      type: "note",
      source_id: "src-a",
      markdown_body: "v2",
    });
    expect(r.changed).toBe(true);
    expect((await getPage(storage, "notes/mine"))!.markdown_body).toBe("v2");
  });

  it("does not block creating the slug", async () => {
    await seedSources();
    const r = await putPage(storage, {
      slug: "notes/mine",
      type: "note",
      source_id: "src-a",
      markdown_body: "mine",
    });
    expect(r.created).toBe(true);
    expect((await getPage(storage, "notes/mine"))!.markdown_body).toBe("mine");
  });
});

// ---------------------------------------------------------------------------
// Transactional integrity
// ---------------------------------------------------------------------------

describe("putPage — transactional", () => {
  useStorage();
  it("page + page_versions are written atomically", async () => {
    await putPage(storage, { slug: "alice", type: "person" });
    const page = await getPage(storage, "alice");
    const v = await pageVersions(storage, "alice");
    expect(page).not.toBeNull();
    expect(v.length).toBe(1);
    expect(v[0]!.hash_new).toBe(page!.content_hash);
  });
});
