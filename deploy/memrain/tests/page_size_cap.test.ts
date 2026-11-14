/**
 * Page body cap (MEMRAIN_PAGE_MAX_BYTES) and splitLargeDocument().
 *
 * Off by default: an unset cap leaves every write path as it was. Set, every
 * putPage write whose resulting body grows past it is refused with
 * `page_too_large`, on both engines and through the MCP tool. Connector-sized
 * documents are split into parts that each fit, deterministically, so a
 * re-ingest with text appended rewrites only the tail.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { putPage } from "../src/core/pages.ts";
import { OperationError } from "../src/core/operation-error.ts";
import { DEFAULT_SPLIT_PART_BYTES, pageMaxBytes, splitLargeDocument } from "../src/core/page-size.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

setDefaultTimeout(60000);

const ENV = "MEMRAIN_PAGE_MAX_BYTES";
afterEach(() => { delete process.env[ENV]; });

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("pageMaxBytes", () => {
  it("is off when unset or blank", () => {
    expect(pageMaxBytes()).toBeNull();
    process.env[ENV] = " ";
    expect(pageMaxBytes()).toBeNull();
  });

  it("reads a positive byte count", () => {
    process.env[ENV] = "2097152";
    expect(pageMaxBytes()).toBe(2097152);
  });

  it("refuses a malformed value instead of silently running uncapped", () => {
    for (const v of ["abc", "0", "-5", "1.5", "2MiB"]) {
      process.env[ENV] = v;
      expect(() => pageMaxBytes()).toThrow(ENV);
    }
  });
});

for (const engine of storageEngines(process.env["MEMRAIN_TEST_POSTGRES_URL"])) {
  describe(`page cap on ${engine.name}`, () => {
    it("writes any size with the cap unset", async () => {
      const { storage, close } = await engine.open();
      try {
        const body = "x".repeat(300_000);
        const r = await putPage(storage, { slug: "notes/big", markdown_body: body });
        expect(r.version_n).toBeGreaterThan(0);
      } finally {
        await close();
      }
    });

    it("refuses a body one byte over the cap and accepts one at it", async () => {
      const { storage, close } = await engine.open();
      try {
        process.env[ENV] = "1024";
        const err = await putPage(storage, { slug: "notes/over", markdown_body: "y".repeat(1025) }).catch(e => e);
        expect(err).toBeInstanceOf(OperationError);
        expect((err as OperationError).code).toBe("page_too_large");
        expect((err as OperationError).suggestion).toContain("part");
        const ok = await putPage(storage, { slug: "notes/at", markdown_body: "y".repeat(1024) });
        expect(ok.version_n).toBeGreaterThan(0);
      } finally {
        await close();
      }
    });

    it("counts bytes, not characters", async () => {
      const { storage, close } = await engine.open();
      try {
        process.env[ENV] = "1024";
        // 400 two-byte characters: 400 chars, 800 bytes, then 600 more = 1400 bytes.
        const body = "é".repeat(700);
        expect(body.length).toBeLessThan(1024);
        const err = await putPage(storage, { slug: "notes/utf8", markdown_body: body }).catch(e => e);
        expect((err as OperationError).code).toBe("page_too_large");
      } finally {
        await close();
      }
    });

    it("refuses an append that would carry the page past the cap", async () => {
      const { storage, close } = await engine.open();
      try {
        await putPage(storage, { slug: "notes/grow", markdown_body: "z".repeat(900) });
        process.env[ENV] = "1024";
        const err = await putPage(storage, { slug: "notes/grow", appendContent: "w".repeat(200) }).catch(e => e);
        expect((err as OperationError).code).toBe("page_too_large");
      } finally {
        await close();
      }
    });

    it("still lets a title change through on a page already over the cap", async () => {
      const { storage, close } = await engine.open();
      try {
        await putPage(storage, { slug: "notes/legacy", markdown_body: "q".repeat(5000) });
        process.env[ENV] = "1024";
        const r = await putPage(storage, { slug: "notes/legacy", title: "Renamed" });
        expect(r.version_n).toBeGreaterThan(1);
      } finally {
        await close();
      }
    });

    it("refuses over MCP page_put with the structured code", async () => {
      const { storage, close } = await engine.open();
      try {
        process.env[ENV] = "1024";
        const res = await dispatchTool(storage, { name: "page_put", arguments: { slug: "notes/mcp", markdown_body: "m".repeat(2048) } }, {});
        expect(res.isError).toBe(true);
        expect(JSON.parse(res.content[0]!.text).error).toBe("page_too_large");
      } finally {
        await close();
      }
    });
  });
}

describe("splitLargeDocument", () => {
  const section = (n: number, size: number) => `## Section ${n}\n\n${"lorem ipsum ".repeat(Math.ceil(size / 12)).slice(0, size)}\n`;

  it("returns the document unchanged when it fits", () => {
    const doc = splitLargeDocument({ slug: "meetings/standup", title: "Standup", body: "short body" });
    expect(doc.parts).toEqual([]);
    expect(doc.parent).toEqual({ slug: "meetings/standup", title: "Standup", body: "short body" });
  });

  it("defaults to the 2 MiB connector part size", () => {
    expect(DEFAULT_SPLIT_PART_BYTES).toBe(2 * 1024 * 1024);
  });

  it("splits into parts that each fit, at heading boundaries, with a contents page", () => {
    const body = Array.from({ length: 6 }, (_, i) => section(i + 1, 300)).join("\n");
    const doc = splitLargeDocument({ slug: "meetings/allhands", title: "All hands", body, maxPartBytes: 700 });
    expect(doc.parts.length).toBeGreaterThan(1);
    for (const p of doc.parts) expect(bytes(p.body)).toBeLessThanOrEqual(700);
    expect(doc.parts.map(p => p.slug)).toEqual(doc.parts.map((_, i) => `meetings/allhands/part-${String(i + 1).padStart(3, "0")}`));
    for (const p of doc.parts.slice(1)) expect(p.body.startsWith("## Section")).toBe(true);
    for (const p of doc.parts) expect(doc.parent.body).toContain(`[[${p.slug}]]`);
    expect(doc.parts.map(p => p.body).join("")).toBe(body);
  });

  it("is deterministic and rewrites only the tail when text is appended", () => {
    const body = Array.from({ length: 8 }, (_, i) => section(i + 1, 250)).join("\n");
    const a = splitLargeDocument({ slug: "chat/thread", title: "Thread", body, maxPartBytes: 600 });
    const b = splitLargeDocument({ slug: "chat/thread", title: "Thread", body, maxPartBytes: 600 });
    expect(b).toEqual(a);
    const grown = splitLargeDocument({ slug: "chat/thread", title: "Thread", body: `${body}\n${section(9, 250)}`, maxPartBytes: 600 });
    const stable = a.parts.slice(0, -1);
    expect(grown.parts.slice(0, stable.length)).toEqual(stable);
  });

  it("hard-splits one oversized paragraph without cutting a multi-byte character", () => {
    const body = "ж".repeat(1000); // 2000 bytes, no newline
    const doc = splitLargeDocument({ slug: "notes/wall", title: "Wall", body, maxPartBytes: 301 });
    for (const p of doc.parts) {
      expect(bytes(p.body)).toBeLessThanOrEqual(301);
      expect(p.body).not.toContain("�");
    }
    expect(doc.parts.map(p => p.body).join("")).toBe(body);
  });

  it("refuses a part size too small to hold anything", () => {
    expect(() => splitLargeDocument({ slug: "a/b", title: "B", body: "text", maxPartBytes: 3 })).toThrow();
  });
});
