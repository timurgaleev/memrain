import { afterAll, beforeAll, expect, it, spyOn } from "bun:test";
import { openRankFixture, runSearch, type RankFixture } from "./rank-flags-fixture.ts";
import { vectorSearch } from "../src/core/search/vector.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { makeMcpHandler } from "../src/mcp/http_transport.ts";

let fx: RankFixture;
beforeAll(async () => { fx = await openRankFixture(); });
afterAll(async () => { await fx.close(); });

for (const cached of [false, true]) {
  it(`does not wait for eval capture (${cached ? "cache" : "fresh"})`, async () => {
    if (cached) {
      let ready = false;
      for (let i = 0; i < 40 && !ready; i++) {
        ready = (await runSearch(fx.storage, "zephyr rollout", { noCache: false })).meta?.cache === "hit";
        if (!ready) await Bun.sleep(10);
      }
      expect(ready).toBe(true);
    }
    let release!: () => void;
    const capture = new Promise<void>(resolve => { release = resolve; });
    let finished = false;
    const result = runSearch(fx.storage, "zephyr rollout", { noCache: !cached, onCapture: () => capture })
      .then(value => { finished = true; return value; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([result, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
      expect(finished).toBe(true);
    } finally { clearTimeout(timer); release(); await result; }
  });
}

it("stops after hydrate when the caller aborts and never captures the abandoned result", async () => {
  const controller = new AbortController();
  const e = fx.storage.engine();
  const original = e.query.bind(e);
  let captured = false;
  const query = spyOn(e, "query").mockImplementation(async <T,>(sql: string, params?: unknown[]) => {
    const result = await original<T>(sql, params);
    if (sql.includes("SELECT c.id, c.document_id, c.content")) controller.abort(new Error("caller left"));
    return result;
  });
  try {
    await expect(runSearch(fx.storage, "zephyr rollout", { signal: controller.signal, onCapture: () => { captured = true; } }))
      .rejects.toThrow("caller left");
    expect(captured).toBe(false);
  } finally { query.mockRestore(); }
});

it("makes the vector settings transaction read-only before any statement", async () => {
  const statements: string[] = [];
  const engine = {
    kind: "postgres",
    async exec(sql: string) { statements.push(sql); },
    async query(sql: string) { statements.push(sql); return { rows: [{ chunk_id: "chunk" }] }; },
    async transaction(fn: (tx: Engine) => Promise<unknown>) { return fn(engine as unknown as Engine); },
  } as unknown as Engine;
  await vectorSearch(engine, [1, 0], 50);
  expect(statements[0]).toBe("SET TRANSACTION READ ONLY");
});

it("carries the HTTP request cancellation into MCP dispatch", async () => {
  const controller = new AbortController();
  controller.abort(new Error("caller left"));
  const config = spyOn(fx.storage, "config").mockImplementation(() => { throw new Error("uncancelled config read"); });
  try {
    const handler = makeMcpHandler({ storage: fx.storage });
    const response = await handler(new Request("http://localhost/mcp", {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { q: "zephyr" } } }),
    }));
    const body = await response.json() as { result?: { isError?: boolean; content?: { text: string }[] } };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("caller left");
    expect(config).not.toHaveBeenCalled();
  } finally { config.mockRestore(); }
});
