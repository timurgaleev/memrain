/**
 * Neighbour chunk windows (chunk-windows.ts): one query for many hits, own
 * document only, re-authorized per hit, framed like the hit. PGLite.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { DEFAULT_WINDOW_SIDE_CHARS, readChunkWindows, withChunkWindows } from "../src/core/search/chunk-windows.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { estTokens } from "../src/core/search/token-budget.ts";

let tmp: string;
let storage: Storage;

async function doc(id: string, sourceId: string, n: number): Promise<void> {
  await storage.engine().query(`INSERT INTO documents (id, source_path, title, source_id) VALUES ($1, $2, $1, $3)`,
    [id, `notes/${id}.md`, sourceId]);
  for (let i = 0; i < n; i++) {
    await storage.engine().query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ($1, $2, $3, $4)`,
      [`${id}-${i}`, id, i, `${id} part ${i}`]);
  }
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-windows-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await storage.engine().query(`INSERT INTO sources (id, kind, path_prefix) VALUES ('other', 'other', 'other/') ON CONFLICT DO NOTHING`);
  await doc("a", "default", 5);
  await doc("b", "default", 2);
  await doc("x", "other", 3);
  await doc("gone", "default", 3);
  await doc("long", "default", 3);
  await storage.engine().query(`UPDATE chunks SET content = $1 WHERE id = 'long-0'`, ["word ".repeat(1000)]);
  await storage.engine().query(`UPDATE documents SET archived = true WHERE id = 'gone'`);
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("readChunkWindows", () => {
  it("reads neighbours either side in document order, in one query for every hit", async () => {
    let calls = 0;
    const engine = new Proxy(storage.engine(), {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop !== "query" || typeof v !== "function") return v;
        return (...args: unknown[]) => {
          calls += 1;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as Engine;
    const w = await readChunkWindows(engine, ["a-2", "b-0"], 2);
    expect(calls).toBe(1);
    expect(w.get("a-2")).toEqual({ before: "a part 0\n\na part 1", after: "a part 3\n\na part 4" });
    expect(w.get("b-0")).toEqual({ before: "", after: "b part 1" });
    expect((await readChunkWindows(storage.engine(), ["a-2"], 1)).get("a-2")).toEqual({ before: "a part 1", after: "a part 3" });
  });

  it("gives no window outside the caller's scope or for a hidden document", async () => {
    expect((await readChunkWindows(storage.engine(), ["x-1"], 1, { sourceIds: ["default"] })).size).toBe(0);
    expect((await readChunkWindows(storage.engine(), ["a-1"], 1, { sourceIds: [] })).size).toBe(0);
    expect((await readChunkWindows(storage.engine(), ["gone-1"], 1)).size).toBe(0);
    expect((await readChunkWindows(storage.engine(), ["a-1"], 0)).size).toBe(0);
  });
});

describe("withChunkWindows", () => {
  it("caps each side by default when no snippet cap is configured", async () => {
    const [h] = await withChunkWindows(storage.engine(), [{ chunkId: "long-1" }], 1);
    expect(h!.window!.before.length).toBeLessThanOrEqual(DEFAULT_WINDOW_SIDE_CHARS);
    expect(h!.window!.after).toBe("long part 2");
  });

  it("charges a window what the hit trim charges: its text, nothing else", async () => {
    const room = estTokens("a part 1") + estTokens("a part 3");
    const [h] = await withChunkWindows(storage.engine(), [{ chunkId: "a-2" }], 1, { tokenRoom: room });
    expect(h!.window).toEqual({ before: "a part 1", after: "a part 3" });
  });

  it("query refuses window together with refine instead of ignoring it", async () => {
    const r = await dispatchTool(storage, { name: "query", arguments: { q: "alpha", refine: "beta", window: 1 } }, {});
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("invalid_params");
    expect(r.content[0]!.text).toContain("window");
  });

  it("frames window text the way the hit is framed and cuts each side", async () => {
    const hits = [{ chunkId: "a-2", trust: "external" as const }, { chunkId: "b-1" }];
    const out = await withChunkWindows(storage.engine(), hits, 1, { maxChars: 6 });
    expect(out[0]!.window!.before).toContain("<external_content");
    expect(out[0]!.window!.before).toContain("a part");
    expect(out[0]!.window!.before).not.toContain("part 1");
    expect(out[1]!.window).toEqual({ before: "b part", after: "" });
  });

  it("under a token budget attaches windows in rank order until one does not fit", async () => {
    const hits = [{ chunkId: "a-2" }, { chunkId: "b-1" }];
    const roomy = await withChunkWindows(storage.engine(), hits, 1, { tokenRoom: 1000 });
    expect(roomy.every(h => h.window !== undefined)).toBe(true);
    const tight = await withChunkWindows(storage.engine(), hits, 1, { tokenRoom: 3 });
    expect(tight[0]!.window).toBeUndefined();
    expect(tight[1]!.window).toBeUndefined();
    expect(await withChunkWindows(storage.engine(), hits, 1, { tokenRoom: 0 })).toEqual(hits);
  });
});
