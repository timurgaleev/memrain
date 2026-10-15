/**
 * The admin SPA's pure modules (admin/src/lib/*): hash routing, link
 * sanitising, the markdown reader, the tool-route response normaliser and
 * parsers, and formatting. They carry no DOM or React, so the root runner
 * loads them directly.
 */
import { describe, expect, it } from "bun:test";
import { buildHash, parseHash } from "../admin/src/lib/route.ts";
import { safeHref } from "../admin/src/lib/href.ts";
import { MARKDOWN_MAX_CHARS, parseMarkdown, type Block, type Inline } from "../admin/src/lib/markdown.ts";
import {
  ToolError,
  ToolShapeError,
  normalizeToolResponse,
  pageHitSlug,
  parseChronicle,
  parseEntityRecall,
  parseEntityTimeline,
  parseFacts,
  parseGetLinks,
  parseGetTags,
  parseGraphNeighbors,
  parsePageGet,
  parsePageList,
  parsePageVersions,
  parseResolveSlugs,
  parseSearch,
  parseTagWrite,
} from "../admin/src/lib/tool-result.ts";
import { fmtAgo, fmtInt, fmtUsd, lastSegment } from "../admin/src/lib/format.ts";
import { capUse } from "../admin/src/admin-types.ts";

describe("route", () => {
  it("round-trips params that need encoding", () => {
    for (const param of ["people/alice", "a b c", "100%", "naïve/ünïcødé", "日本/語"]) {
      for (const name of ["page", "entity", "graph", "search"] as const) {
        const hash = buildHash({ name, param });
        expect(parseHash(hash)).toEqual({ name, param });
      }
    }
    expect(buildHash({ name: "page", param: "people/alice" })).toBe("#page/people%2Falice");
    expect(parseHash("#page/people%2Falice")).toEqual({ name: "page", param: "people/alice" });
  });

  it("maps empty, dashboard and unknown routes to overview", () => {
    expect(parseHash("")).toEqual({ name: "overview", param: null });
    expect(parseHash("#")).toEqual({ name: "overview", param: null });
    expect(parseHash("#dashboard")).toEqual({ name: "overview", param: null });
    expect(parseHash("#/dashboard")).toEqual({ name: "overview", param: null });
    expect(parseHash("#nope")).toEqual({ name: "overview", param: null });
    expect(parseHash("#/spend")).toEqual({ name: "spend", param: null });
  });

  it("returns a null param when decoding fails", () => {
    expect(parseHash("#page/%E0%A4%A")).toEqual({ name: "page", param: null });
  });
});

describe("safeHref", () => {
  it("refuses script schemes and host tricks", () => {
    for (const raw of [
      "javascript:alert(1)",
      "JaVaScRiPt:x",
      "java\tscript:x",
      "\u0001javascript:x",
      "&#106;avascript:x",
      "data:text/html,x",
      "vbscript:x",
      "//evil.example",
      "\\\\evil.example",
      "/etc/passwd",
    ]) {
      const h = safeHref(raw);
      expect(h === null || h.kind === "internal").toBe(true);
    }
  });

  it("keeps http(s) and mailto, encoding quotes", () => {
    const q = safeHref("https://example.test/a\"b");
    expect(q?.kind).toBe("external");
    if (q?.kind === "external") {
      expect(q.href).not.toContain("\"");
      expect(q.href).toContain("%22");
    }
    expect(safeHref("mailto:a@example.test")).toEqual({ kind: "external", href: "mailto:a@example.test" });
  });

  it("turns a slug into an internal page link", () => {
    expect(safeHref("people/alice")).toEqual({ kind: "internal", hash: "#page/people%2Falice" });
    expect(safeHref("")).toBeNull();
    expect(safeHref("x".repeat(2049))).toBeNull();
  });
});

function inlines(blocks: Block[]): Inline[] {
  const out: Inline[] = [];
  const walkInline = (list: Inline[]): void => {
    for (const n of list) {
      out.push(n);
      if (n.t === "strong" || n.t === "em" || n.t === "link") walkInline(n.c);
    }
  };
  const walkBlock = (list: Block[]): void => {
    for (const b of list) {
      if (b.t === "heading" || b.t === "para") walkInline(b.c);
      else if (b.t === "list") for (const item of b.items) walkInline(item);
      else if (b.t === "quote") walkBlock(b.c);
    }
  };
  walkBlock(blocks);
  return out;
}

function allText(blocks: Block[]): string {
  return inlines(blocks)
    .map((n) => (n.t === "text" || n.t === "code" ? n.v : ""))
    .join("");
}

function expectInert(src: string): void {
  const { blocks } = parseMarkdown(src);
  for (const n of inlines(blocks)) {
    if (n.t !== "link") continue;
    const h = n.href;
    if (h === null) continue;
    if (h.kind === "internal") {
      expect(h.hash.startsWith("#page/")).toBe(true);
    } else {
      expect(["http:", "https:", "mailto:"]).toContain(new URL(h.href).protocol);
      expect(h.href).not.toContain("\"");
    }
  }
}

describe("parseMarkdown", () => {
  it("renders raw HTML as literal text", () => {
    const script = parseMarkdown("<script>alert(1)</script>");
    expect(allText(script.blocks)).toContain("<script>alert(1)</script>");
    const img = parseMarkdown("<img src=x onerror=alert(1)>");
    expect(allText(img.blocks)).toContain("onerror=alert(1)");
  });

  it("neutralises every hostile link body", () => {
    for (const body of [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "[x](javascript:alert(1))",
      "[x](JaVa\tScript:alert(1))",
      "[x](//evil.example)",
      "[x](\\\\evil.example)",
      "[x](https://example.test/a\"b)",
      "# heading <script>alert(1)</script>\n\n- item <script>x</script>",
    ]) {
      expectInert(body);
    }
    const js = inlines(parseMarkdown("[x](javascript:alert(1))").blocks).filter((n) => n.t === "link");
    for (const l of js) if (l.t === "link") expect(l.href).toBeNull();
  });

  it("parses headings, lists, fences, quotes and wikilinks", () => {
    const { blocks, truncated } = parseMarkdown(
      "# Title\n\nSome **bold** and *em* text.\n\n- one\n- two\n\n1. first\n2. second\n\n```ts\nconst x = 1;\n```\n\n> quoted\n\n---\n\nSee [[people/alice|Alice]].",
    );
    expect(truncated).toBe(false);
    const kinds = blocks.map((b) => b.t);
    expect(kinds).toContain("heading");
    expect(kinds).toContain("list");
    expect(kinds).toContain("code");
    expect(kinds).toContain("quote");
    expect(kinds).toContain("hr");
    const h = blocks.find((b) => b.t === "heading");
    expect(h?.t === "heading" && h.level).toBe(1);
    const lists = blocks.filter((b) => b.t === "list");
    expect(lists.map((l) => l.t === "list" && l.ordered)).toEqual([false, true]);
    const code = blocks.find((b) => b.t === "code");
    expect(code?.t === "code" && code.lang).toBe("ts");
    expect(code?.t === "code" && code.v).toContain("const x = 1;");
    const nodes = inlines(blocks);
    expect(nodes.some((n) => n.t === "strong")).toBe(true);
    expect(nodes.some((n) => n.t === "em")).toBe(true);
    expect(nodes.find((n) => n.t === "wikilink")).toEqual({ t: "wikilink", slug: "people/alice", label: "Alice" });
  });

  it("renders images as alt text only", () => {
    const nodes = inlines(parseMarkdown("![a cat](https://example.test/cat.png)").blocks);
    expect(nodes.find((n) => n.t === "image")).toEqual({ t: "image", alt: "a cat" });
  });

  it("caps the input", () => {
    const r = parseMarkdown("a".repeat(MARKDOWN_MAX_CHARS + 10));
    expect(r.truncated).toBe(true);
  });

  it("stays linear on pathological input", () => {
    const time = (src: string): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        parseMarkdown(src);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    for (const ch of ["[", "*", "`", "_"]) {
      const small = time(ch.repeat(50_000));
      const big = time(ch.repeat(100_000));
      expect(big).toBeLessThan(200);
      // Floor the base so timer noise on a fast run cannot fake a ratio.
      expect(big / Math.max(small, 5)).toBeLessThan(3);
    }
  });
});

describe("normalizeToolResponse", () => {
  const thrown = (status: number, body: unknown): unknown => {
    try {
      normalizeToolResponse(status, body);
    } catch (e) {
      return e;
    }
    return undefined;
  };

  it("returns data on success", () => {
    expect(normalizeToolResponse(200, { ok: true, data: { ok: true, tags: [] } })).toEqual({ ok: true, tags: [] });
  });

  it("maps 401, 429 and error envelopes to ToolError", () => {
    const u = thrown(401, {});
    expect(u).toBeInstanceOf(ToolError);
    expect((u as ToolError).code).toBe("unauthorized");
    const r = thrown(429, { ok: false, error: "rate_limited", retry_after_s: 2 });
    expect((r as ToolError).code).toBe("rate_limited");
    expect((r as ToolError).retryAfterS).toBe(2);
    const nf = thrown(422, { ok: false, error: "not_found", message: "page not found: x", suggestion: "try y" });
    expect(nf).toMatchObject({ code: "not_found", message: "page not found: x", status: 422, suggestion: "try y" });
    const bare = thrown(500, {});
    expect((bare as ToolError).code).toBe("http_500");
    const notOk = thrown(200, { ok: false, error: "x" });
    expect((notOk as ToolError).code).toBe("x");
  });

  it("throws ToolShapeError for a non-object body", () => {
    for (const body of [null, "text", 7, []]) expect(thrown(200, body)).toBeInstanceOf(ToolShapeError);
  });
});

describe("tool-result parsers", () => {
  const fact = {
    id: 3,
    entity_slug: "people/alice",
    fact: "likes graphs",
    confidence: 0.9,
    source_slug: null,
    written_by: "op",
    written_at: "2026-10-01T00:00:00Z",
    kind: "fact",
    notability: null,
    valid_from: null,
    valid_until: null,
    visibility: "private",
    superseded_by: null,
    consolidated_into: null,
    context: null,
    attributed_to: null,
    forgotten_at: null,
  };
  const page = {
    slug: "people/alice",
    type: "person",
    title: "Alice",
    compiled_truth: {},
    markdown_body: "# Alice",
    content_hash: "h",
    created_at: "2026-10-01",
    updated_at: "2026-10-02",
    deleted_at: null,
    source_id: "default",
  };
  const link = { id: 1, source_slug: "a", target_slug: "b", type: "mentions", inferred_confidence: 0.5, written_at: "2026-10-01" };
  const event = { date: "2026-10-01", summary: "shipped", detail: null, slug: "notes/a", event_slug: null, kind: null };

  it("pageHitSlug reads page:// paths only", () => {
    expect(pageHitSlug("page://a/b")).toBe("a/b");
    expect(pageHitSlug("/docs/a.md")).toBeNull();
  });

  it("parses the documented shapes", () => {
    const search = parseSearch({
      ok: true,
      hits: [{ chunkId: 1, documentId: "d", sourcePath: "page://people/alice", title: null, content: "x", score: 0.5, intent: "topic" }],
    });
    expect(search.hits).toHaveLength(1);
    expect(parseResolveSlugs({ ok: true, query: "a", hits: [{ slug: "people/alice", title: "Alice", score: 0.8 }] })).toHaveLength(1);
    const pg = parsePageGet({ ok: true, page, version: 4 });
    expect(pg.kind).toBe("page");
    if (pg.kind === "page") {
      expect(pg.page.slug).toBe("people/alice");
      expect(pg.version).toBe(4);
      expect(pg.quarantined).toBe(false);
    }
    // page_get sends the gate's verdict object, not a boolean.
    const held = parsePageGet({ ok: true, page, version: 4, quarantined: { reason: "x", detail: "y" } });
    expect(held.kind === "page" && held.quarantined).toBe(true);
    expect(parsePageGet({ ok: false, error: "ambiguous_slug", candidates: ["a", "b"] })).toEqual({ kind: "ambiguous", candidates: ["a", "b"] });
    expect(parsePageList({ ok: true, pages: [{ slug: "a", type: null, title: null }] })).toHaveLength(1);
    expect(parsePageVersions({ ok: true, versions: [{ slug: "a", version_n: 1, body_snapshot: "x", written_by: "op", written_at: "t" }] })).toHaveLength(1);
    const groups = parseGetLinks({ ok: true, slug: "a", groups: [{ type: "mentions", direction: "outbound", links: [link] }] });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.links).toHaveLength(1);
    expect(parseGetTags({ ok: true, slug: "a", tags: ["x", 7, "y"] })).toEqual(["x", "y"]);
    expect(parseGraphNeighbors({ ok: true, slug: "a", links: [{ ...link, direction: "outbound" }] })).toHaveLength(1);
    const recall = parseEntityRecall({ ok: true, slug: "people/alice", page, facts: [fact], timeline: [] });
    expect(recall.facts).toHaveLength(1);
    expect(parseFacts({ ok: true, entity_slug: null, facts: [fact] }, "facts")).toHaveLength(1);
    expect(parseFacts({ ok: true, supersessions: [fact] }, "supersessions")).toHaveLength(1);
    expect(parseEntityTimeline({ ok: true, slug: "a", timeline: [{ id: 1, slug: "a", occurred_at: "t", event: "e", detail: null, source_label: null, written_at: "t" }] })).toHaveLength(1);
    expect(parseChronicle({ ok: true, since: "2026-10-01", events: [event] })).toHaveLength(1);
    expect(parseTagWrite({ ok: true, slug: "a", tag: "t" })).toEqual({ slug: "a", tag: "t" });
  });

  it("returns defaults for empty and mistyped input without throwing", () => {
    const wrong = { ok: true, hits: "x", pages: 3, versions: {}, groups: null, tags: "t", links: 1, facts: "f", supersessions: 2, timeline: {}, events: "e", page: 5 };
    for (const d of [{}, wrong]) {
      expect(parseSearch(d).hits).toEqual([]);
      expect(parseResolveSlugs(d)).toEqual([]);
      expect(parsePageList(d)).toEqual([]);
      expect(parsePageVersions(d)).toEqual([]);
      expect(parseGetLinks(d)).toEqual([]);
      expect(parseGetTags(d)).toEqual([]);
      expect(parseGraphNeighbors(d)).toEqual([]);
      expect(parseFacts(d, "facts")).toEqual([]);
      expect(parseFacts(d, "supersessions")).toEqual([]);
      expect(parseEntityTimeline(d)).toEqual([]);
      expect(parseChronicle(d)).toEqual([]);
      const er = parseEntityRecall(d);
      expect(er.page).toBeNull();
      expect(er.facts).toEqual([]);
      expect(er.timeline).toEqual([]);
      expect(() => parsePageGet(d)).not.toThrow();
      expect(() => parseTagWrite(d)).not.toThrow();
    }
    const mixed = parsePageList({ pages: [{ slug: 7, title: 3 }, "x", null] });
    for (const row of mixed) expect(typeof row.slug).toBe("string");
  });

  it("throws ToolShapeError only for a non-object root", () => {
    expect(() => parseSearch(null)).toThrow(ToolShapeError);
    expect(() => parsePageList("x")).toThrow(ToolShapeError);
  });
});

describe("format", () => {
  it("formats numbers and money", () => {
    expect(fmtInt(1234567)).toBe("1,234,567");
    expect(fmtInt(Number.NaN)).toBe("—");
    expect(fmtInt("x")).toBe("—");
    expect(fmtUsd(0.004)).toBe("<$0.01");
    expect(fmtUsd(12.5)).toBe("$12.50");
    expect(fmtUsd(0)).toBe("$0.00");
  });

  it("formats relative time", () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    expect(fmtAgo("2026-10-15T11:59:48Z", now)).toBe("12s ago");
    expect(fmtAgo("2026-10-15T11:57:00Z", now)).toBe("3m ago");
    expect(fmtAgo("2026-10-15T10:00:00Z", now)).toBe("2h ago");
    expect(fmtAgo("2026-10-11T12:00:00Z", now)).toBe("4d ago");
  });

  it("shortens a slug to its last segment", () => {
    expect(lastSegment("people/alice-smith")).toBe("alice-smith");
    const long = lastSegment("notes/a-very-long-segment-name-indeed");
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(18);
  });
});

describe("capUse", () => {
  const row = { client_id: "c", client_name: null, cap_usd_per_day: "1.00" };
  it("counts live reservations against the cap", () => {
    expect(capUse({ ...row, spent_cents_today: "40", pending_cents: "60" })).toBe(1);
    expect(capUse({ ...row, spent_cents_today: 0, pending_cents: "90" })).toBeCloseTo(0.9);
  });
  it("is null for an uncapped agent", () => {
    expect(capUse({ ...row, cap_usd_per_day: null, spent_cents_today: "40", pending_cents: "0" })).toBeNull();
  });
});
