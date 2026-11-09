/**
 * Deterministic link-extraction fixes:
 *   (a) heading anchors are stripped from wikilink targets,
 *   (b) fenced + inline code spans are masked before the wikilink/gazetteer scan,
 *   (c) `[Name](dir/slug.md)` markdown links become wikilink edges when they
 *       resolve to a real page,
 *   (d) `src/foo.ts:42` code citations become `documents` edges when the code
 *       file is indexed.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import {
  extractCodeRefs,
  extractMarkdownLinks,
  extractWikilinks,
  graphNeighbors,
  stripCodeBlocks,
  syncCodeRefsForPage,
  syncWikilinksForPage,
} from "../src/core/links.ts";
import { buildGazetteer, scanMentions } from "../src/core/gazetteer.ts";
import { registerSource } from "../src/core/sources.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-linkfix-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Insert a minimal indexed code file (documents row, kind='code'). */
async function putCodeDoc(sourcePath: string): Promise<void> {
  await storage.engine().query(
    `INSERT INTO documents (id, source_path, title, frontmatter)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      `doc_${sourcePath}`,
      sourcePath,
      sourcePath.split("/").pop() ?? sourcePath,
      JSON.stringify({ kind: "code", language: "typescript" }),
    ],
  );
}

// ---------------------------------------------------------------------------
// (a) heading-anchor stripping
// ---------------------------------------------------------------------------

describe("extractWikilinks — heading anchors", () => {
  it("strips a #section anchor from the target", () => {
    expect(extractWikilinks("[[people/alice#background]]")).toEqual([
      "people/alice",
    ]);
  });

  it("keeps a |display alias working (no anchor)", () => {
    expect(extractWikilinks("[[a|b]]")).toEqual(["a"]);
  });

  it("strips the anchor even with a display alias", () => {
    expect(extractWikilinks("[[people/alice#bio|Alice]]")).toEqual([
      "people/alice",
    ]);
  });
});

// ---------------------------------------------------------------------------
// (b) code-fence + inline-code masking
// ---------------------------------------------------------------------------

describe("stripCodeBlocks", () => {
  it("blanks fenced + inline spans, preserving length (offsets stable)", () => {
    const src = "a `x` b\n```\ny\n```\nz";
    const out = stripCodeBlocks(src);
    // Length is preserved so positional scans downstream stay valid.
    expect(out.length).toBe(src.length);
    // Prose keeps its offsets; the inline `x` and fenced `y` blank to spaces.
    expect(out).toBe("a" + " ".repeat(5) + "b\n" + " ".repeat(9) + "\nz");
    expect(out.includes("x")).toBe(false);
    expect(out.includes("y")).toBe(false);
  });
});

describe("extractWikilinks — code masking", () => {
  it("ignores a wikilink inside inline code", () => {
    expect(extractWikilinks("`[[x]]` and [[y]]")).toEqual(["y"]);
  });

  it("ignores a wikilink inside a fenced block", () => {
    expect(extractWikilinks("```\n[[x]]\n```\n[[y]]")).toEqual(["y"]);
  });
});

describe("scanMentions — code masking", () => {
  it("does not mention an entity named inside inline code", async () => {
    await putPage(storage, { slug: "people/alice-chen", type: "person", title: "Alice Chen" });
    const entries = await buildGazetteer(storage, "journal/today");
    expect(scanMentions("`Alice Chen` shipped it", entries)).toEqual([]);
    expect(scanMentions("Alice Chen shipped it", entries)).toEqual([
      "people/alice-chen",
    ]);
  });
});

// ---------------------------------------------------------------------------
// (c) markdown-style [Name](dir/slug.md) links
// ---------------------------------------------------------------------------

describe("extractMarkdownLinks", () => {
  it("captures the target, peeling ../ and .md", () => {
    expect(
      extractMarkdownLinks("[A](../people/alice.md) and [B](companies/acme)").sort(),
    ).toEqual(["companies/acme", "people/alice"]);
  });

  it("skips external URLs and code-fenced links", () => {
    expect(
      extractMarkdownLinks("[site](https://x.com) `[C](people/c.md)` [D](people/d.md)"),
    ).toEqual(["people/d"]);
  });
});

describe("syncWikilinksForPage — markdown links", () => {
  it("writes an edge for a markdown link that resolves to a real page", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    await putPage(storage, { slug: "journal/today", type: "journal" });
    const r = await syncWikilinksForPage(
      storage,
      "journal/today",
      "met [Alice](people/alice.md) today",
    );
    expect(r.added).toBe(1);
    const links = await graphNeighbors(storage, "journal/today", {
      type: "wikilink",
      direction: "outbound",
    });
    expect(links.map((l) => l.target_slug)).toEqual(["people/alice"]);
  });

  it("drops a markdown link that does not resolve to a page", async () => {
    await putPage(storage, { slug: "journal/today", type: "journal" });
    const r = await syncWikilinksForPage(
      storage,
      "journal/today",
      "see [X](nope/x.md) for nothing",
    );
    expect(r.added).toBe(0);
    const links = await graphNeighbors(storage, "journal/today", {
      type: "wikilink",
      direction: "outbound",
    });
    expect(links.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (d) code-path citations → documents edges
// ---------------------------------------------------------------------------

describe("extractCodeRefs", () => {
  it("captures repo-layout code paths with optional line numbers", () => {
    expect(extractCodeRefs("edit src/core/sync.ts:42 then lib/util.js")).toEqual([
      { path: "src/core/sync.ts", line: 42 },
      { path: "lib/util.js", line: undefined },
    ]);
  });

  it("ignores paths outside the repo-layout dir anchors", () => {
    expect(extractCodeRefs("random foo/bar.ts reference")).toEqual([]);
  });
});

describe("syncCodeRefsForPage", () => {
  it("writes a documents edge for a cited, indexed code file", async () => {
    await putPage(storage, { slug: "docs/guide", type: "note" });
    await putCodeDoc("/repo/src/core/sync.ts");
    const r = await syncCodeRefsForPage(
      storage,
      "docs/guide",
      "the sync lives in src/core/sync.ts:42",
    );
    expect(r.added).toBe(1);
    const links = await graphNeighbors(storage, "docs/guide", {
      type: "documents",
      direction: "outbound",
    });
    expect(links.map((l) => l.target_slug)).toEqual(["src/core/sync.ts"]);
  });

  it("writes nothing for a cited path with no indexed code file", async () => {
    await putPage(storage, { slug: "docs/guide", type: "note" });
    const r = await syncCodeRefsForPage(
      storage,
      "docs/guide",
      "the sync lives in src/core/sync.ts:42",
    );
    expect(r.added).toBe(0);
    const links = await graphNeighbors(storage, "docs/guide", {
      type: "documents",
      direction: "outbound",
    });
    expect(links.length).toBe(0);
  });

  it("resolves a code file whose document source differs from the page source", async () => {
    // A note in one page source routinely documents code classified under a
    // different document source (path-prefix axis) — the lookup must not scope
    // the code-doc existence check by the page's source_id (regression).
    const e = storage.engine();
    await registerSource(e, { id: "vault", kind: "vault", pathPrefix: "/vault" });
    await registerSource(e, { id: "repo", kind: "vault", pathPrefix: "/repo" });
    await putPage(storage, { slug: "docs/guide", type: "note", source_id: "vault" });
    await e.query(
      `INSERT INTO documents (id, source_id, source_path, title, frontmatter)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        "doc_repo_sync",
        "repo",
        "/repo/src/core/sync.ts",
        "sync.ts",
        JSON.stringify({ kind: "code", language: "typescript" }),
      ],
    );
    const r = await syncCodeRefsForPage(
      storage,
      "docs/guide",
      "src/core/sync.ts:42",
      "vault",
    );
    expect(r.added).toBe(1);
    const links = await graphNeighbors(storage, "docs/guide", {
      type: "documents",
      direction: "outbound",
    });
    expect(links.map((l) => l.target_slug)).toEqual(["src/core/sync.ts"]);
  });

  it("is idempotent and drops a citation once the code file is gone", async () => {
    await putPage(storage, { slug: "docs/guide", type: "note" });
    await putCodeDoc("/repo/src/core/sync.ts");
    await syncCodeRefsForPage(storage, "docs/guide", "src/core/sync.ts");
    // Re-sync with the same body: no churn beyond the DELETE-replace.
    const again = await syncCodeRefsForPage(storage, "docs/guide", "src/core/sync.ts");
    expect(again.added).toBe(1);
    expect(again.removed).toBe(1);
    // Remove the code file → the edge is no longer resolvable.
    await storage.engine().query("DELETE FROM documents");
    const gone = await syncCodeRefsForPage(storage, "docs/guide", "src/core/sync.ts");
    expect(gone.added).toBe(0);
    expect(gone.removed).toBe(1);
  });
});

describe("encoded, relative and commented links", () => {
  it("decodes spaces and anchors relative paths to the source page directory", async () => {
    await putPage(storage, { slug: "projects/alpha/people/alice-smith", type: "person", title: "Alice Smith" });
    await putPage(storage, { slug: "projects/alpha/notes/sibling", type: "note" });
    await putPage(storage, { slug: "projects/alpha/notes/today", type: "note" });
    await syncWikilinksForPage(storage, "projects/alpha/notes/today",
      "[Alice](../people/Alice%20Smith.md#bio) and [Sibling](./sibling.md)");
    const links = await graphNeighbors(storage, "projects/alpha/notes/today", { direction: "outbound" });
    expect(links.map(l => l.target_slug).sort()).toEqual(["projects/alpha/notes/sibling", "projects/alpha/people/alice-smith"]);
  });
  it("masks HTML comments across scanners while preserving offsets and visible text", () => {
    const body = "visible <!-- [[hidden]] [Secret](people/secret) src/secret.ts:4 --> [[shown]]";
    expect(stripCodeBlocks(body).length).toBe(body.length);
    expect(extractWikilinks(body)).toEqual(["shown"]);
    expect(extractMarkdownLinks(body)).toEqual([]);
    expect(extractCodeRefs(body)).toEqual([]);
    expect(extractWikilinks("[[shown]] <!-- [[hidden]]")).toEqual(["shown"]);
  });
  it("masks a long unclosed comment in one bounded scan", () => {
    const body = "before <!-- " + "<!-- [[hidden]] ".repeat(60_000);
    const start = performance.now();
    const masked = stripCodeBlocks(body);
    expect(masked.length).toBe(body.length);
    expect(masked.trim()).toBe("before");
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
