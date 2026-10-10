/**
 * MEMRAIN_SEARCH_SNIPPET_CHARS: `search` and `query` cut each hit's content at
 * a word boundary and point a page hit at `page_get`. Unset leaves the hits
 * exactly as the search returned them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import {
  capHitSnippets,
  cutAtWordBoundary,
  pageSlugForHit,
  searchSnippetChars,
} from "../src/core/search/snippet-cap.ts";
import { deterministicEmbed } from "./det-embed.ts";

const ENV = "MEMRAIN_SEARCH_SNIPPET_CHARS";
const SLUG = "projects/zephyr";
const BODY =
  "Zephyrquartz launch notes. " +
  Array.from({ length: 60 }, (_, i) => `sentence${i} about the zephyrquartz rollout plan`).join(" ");

let tmp: string;
let storage: Storage;
const embedQuery = async (text: string) => deterministicEmbed(text);

function payload(result: ToolCallResult): any {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text);
}

const call = async (name: string, args: Record<string, unknown>) =>
  payload(await dispatchTool(storage, { name, arguments: args }, { embedQuery }));

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-snippet-cap-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await indexPageIntoSearch(storage, { slug: SLUG, title: "Zephyr", markdown_body: BODY }, { embedFn: embedQuery });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env[ENV];
});

describe("snippet cap helpers", () => {
  it("cuts at the last word boundary inside the window", () => {
    expect(cutAtWordBoundary("alpha beta gamma", 13)).toBe("alpha beta");
    expect(cutAtWordBoundary("alpha beta gamma", 10)).toBe("alpha beta");
    expect(cutAtWordBoundary("alphabetagamma", 5)).toBe("alpha");
    expect(cutAtWordBoundary("short", 50)).toBe("short");
  });

  it("names a page slug only for page mirrors, stripping the caller's tenant prefix", () => {
    expect(pageSlugForHit("page://people/alice")).toBe("people/alice");
    expect(pageSlugForHit("page-truth://people/alice")).toBe("people/alice");
    expect(pageSlugForHit("page://team-a/people/alice", ["team-a"])).toBe("people/alice");
    expect(pageSlugForHit("/vault/notes/a.md")).toBeNull();
  });

  it("copies the hits it cuts and leaves the input alone", () => {
    const hits = [{ content: "one two three four", sourcePath: "/code/a.ts" }];
    const out = capHitSnippets(hits, 8);
    expect(out[0]).toEqual({ content: "one two", sourcePath: "/code/a.ts", truncated: true });
    expect(hits[0]!.content).toBe("one two three four");
    expect(capHitSnippets(hits, 0)).toBe(hits);
  });

  it("reads 0 for an unset or malformed knob", () => {
    expect(searchSnippetChars()).toBe(0);
    process.env[ENV] = "abc";
    expect(searchSnippetChars()).toBe(0);
    process.env[ENV] = "120";
    expect(searchSnippetChars()).toBe(120);
  });
});

describe("search and query results", () => {
  for (const tool of ["search", "query"]) {
    it(`${tool}: unset returns full content`, async () => {
      const { hits } = await call(tool, { q: "zephyrquartz" });
      const hit = hits.find((h: { sourcePath: string }) => h.sourcePath === `page://${SLUG}`);
      expect(hit).toBeDefined();
      expect(hit.content.length).toBeGreaterThan(100);
      expect(hit.full).toBeUndefined();
    });

    it(`${tool}: a cap cuts the content and points at page_get`, async () => {
      process.env[ENV] = "60";
      const { hits } = await call(tool, { q: "zephyrquartz" });
      const hit = hits.find((h: { sourcePath: string }) => h.sourcePath === `page://${SLUG}`);
      expect(hit).toBeDefined();
      expect(hit.content.length).toBeLessThanOrEqual(60);
      expect(hit.content.endsWith(" ")).toBe(false);
      expect(hit.truncated).toBe(true);
      expect(hit.full).toBe(`page_get ${SLUG}`);
    });
  }
});
