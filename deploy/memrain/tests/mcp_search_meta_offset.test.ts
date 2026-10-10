/**
 * The operator's `meta.confidence` on `search` grades the hits it returns:
 * with `offset`, the head the search graded is sliced away, so the grade has
 * to be read again from what is left.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { gradeConfidence } from "../src/core/search/confidence-grade.ts";
import { deterministicEmbed } from "./det-embed.ts";

let tmp: string;
let storage: Storage;
const embedQuery = async (text: string) => deterministicEmbed(text);

function payload(result: ToolCallResult): any {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text);
}

const search = async (args: Record<string, unknown>) =>
  payload(await dispatchTool(storage, { name: "search", arguments: args }, { embedQuery }));

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-search-meta-offset-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await indexPageIntoSearch(
    storage,
    { slug: "projects/quillmoss", title: "Quillmoss", markdown_body: "Quillmoss is the garden project." },
    { embedFn: embedQuery },
  );
  for (let i = 0; i < 4; i++) {
    await indexPageIntoSearch(
      storage,
      { slug: `notes/n${i}`, title: `Note ${i}`, markdown_body: `Unrelated note ${i} about soil and rain.` },
      { embedFn: embedQuery },
    );
  }
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("search meta.confidence", () => {
  it("grades the returned hits, before and after an offset", async () => {
    const head = await search({ q: "Quillmoss", explain: true });
    expect(head.meta.confidence).toEqual(gradeConfidence(head.hits));
    expect(head.meta.confidence.grade).toBe("strong");

    const tail = await search({ q: "Quillmoss", offset: 1, explain: true });
    expect(tail.hits.length).toBeGreaterThan(0);
    expect(tail.meta.returned).toBe(tail.hits.length);
    expect(tail.meta.confidence).toEqual(gradeConfidence(tail.hits));
    expect(tail.meta.confidence.grade).not.toBe("strong");
  });
});
