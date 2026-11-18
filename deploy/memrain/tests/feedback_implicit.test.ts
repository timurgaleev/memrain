/**
 * The implicit feedback signal: a page read with page_get or get_chunks by the
 * same principal within five minutes of the search that returned it counts as
 * one light positive vote. The search response itself does not change.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { RecentHits } from "../src/core/feedback/implicit.ts";
import { principalHash } from "../src/core/feedback/store.ts";
import { deterministicEmbedQuery } from "./det-embed.ts";

setDefaultTimeout(60_000);

const saved = process.env["MEMRAIN_FEEDBACK"];
afterEach(() => {
  if (saved === undefined) delete process.env["MEMRAIN_FEEDBACK"];
  else process.env["MEMRAIN_FEEDBACK"] = saved;
});

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-feedback-implicit-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  for (const [slug, body] of [["notes/alpaca", "The alpaca shearing day is in May."], ["notes/llama", "Llamas guard the alpaca herd."], ["notes/unrelated", "Quarterly tax filing checklist."]]) {
    await putPage(storage, { slug: slug!, markdown_body: body!, title: slug! });
    await indexPageIntoSearch(storage, { slug: slug!, markdown_body: body!, title: slug! }, { embedFn: deterministicEmbedQuery });
  }
  // Written but never indexed: no search returns it.
  await putPage(storage, { slug: "notes/unindexed", markdown_body: "Alpaca shearing notes kept offline.", title: "Offline" });
});
afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const opts = { embedQuery: deterministicEmbedQuery };
const rows = async () => (await storage.engine().query<{ slug: string; signal: string; tier: string; rating: number; principal_hash: string }>(
  `SELECT slug, signal, tier, rating, principal_hash FROM retrieval_feedback ORDER BY id`)).rows;
async function settle(want: number): Promise<void> {
  for (let i = 0; i < 40 && (await rows()).length < want; i++) await Bun.sleep(25);
  await Bun.sleep(50);
}
const call = (name: string, args: Record<string, unknown>) => dispatchTool(storage, { name, arguments: args }, opts);

describe("recent hits", () => {
  it("remembers a search's pages per principal for five minutes, and counts each once", () => {
    const r = new RecentHits();
    r.note("operator", ["notes/a", "notes/b"], 1_000);
    expect(r.take("client:x", "notes/a", 2_000)).toBe(false);
    expect(r.take("operator", "notes/c", 2_000)).toBe(false);
    expect(r.take("operator", "notes/a", 2_000)).toBe(true);
    expect(r.take("operator", "notes/a", 3_000)).toBe(false);
    expect(r.take("operator", "notes/b", 1_000 + 5 * 60_000 + 1)).toBe(false);
  });

  it("stays bounded however many principals and pages it sees", () => {
    const r = new RecentHits();
    for (let i = 0; i < 5000; i++) r.note(`client:${i}`, Array.from({ length: 300 }, (_, j) => `p/${j}`), 1_000);
    expect(r.size()).toBeLessThanOrEqual(1000 * 100);
  });
});

describe("implicit signal through MCP dispatch", () => {
  it("off: a search and a read store nothing", async () => {
    delete process.env["MEMRAIN_FEEDBACK"];
    expect((await call("search", { q: "alpaca shearing" })).isError).toBeFalsy();
    expect((await call("page_get", { slug: "notes/alpaca" })).isError).toBeFalsy();
    await settle(1);
    expect(await rows()).toEqual([]);
  });

  it("on: reading a page the search returned is one implicit positive vote", async () => {
    process.env["MEMRAIN_FEEDBACK"] = "1";
    const off = await call("search", { q: "alpaca shearing" });
    const text = (off.content[0] as { text: string }).text;
    expect(text).toContain("notes/alpaca");
    expect((await call("page_get", { slug: "notes/unindexed" })).isError).toBeFalsy();
    expect((await call("page_get", { slug: "notes/alpaca" })).isError).toBeFalsy();
    expect((await call("get_chunks", { slug: "notes/alpaca" })).isError).toBeFalsy();
    await settle(1);
    expect(await rows()).toEqual([{ slug: "notes/alpaca", signal: "implicit", tier: "owner", rating: 1, principal_hash: principalHash("operator") }]);
  });

  it("the search response is the same with feedback on and off", async () => {
    delete process.env["MEMRAIN_FEEDBACK"];
    const off = await call("search", { q: "llama herd" });
    process.env["MEMRAIN_FEEDBACK"] = "1";
    const on = await call("search", { q: "llama herd" });
    const strip = (r: typeof off) => JSON.parse((r.content[0] as { text: string }).text, (k, v) => (k === "score" || k === "meta" ? undefined : v));
    expect(strip(on)).toEqual(strip(off));
  });
});
