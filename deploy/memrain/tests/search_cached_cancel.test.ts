import { expect, it, spyOn } from "bun:test";
import { openRankFixture, runSearch } from "./rank-flags-fixture.ts";

it("honors a cached search's cancellation during content-flag hydration before capture", async () => {
  const fx = await openRankFixture();
  try {
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      ready = (await runSearch(fx.storage, "zephyr rollout", { noCache: false })).meta?.cache === "hit";
      if (!ready) await Bun.sleep(10);
    }
    expect(ready).toBe(true);
    const controller = new AbortController();
    const engine = fx.storage.engine();
    const original = engine.query.bind(engine);
    let captured = false;
    const query = spyOn(engine, "query").mockImplementation(async <T,>(sql: string, params?: unknown[]) => {
      const result = await original<T>(sql, params);
      if (sql.includes("frontmatter -> 'content_flag'")) controller.abort(new Error("caller left during flags"));
      return result;
    });
    try {
      await expect(runSearch(fx.storage, "zephyr rollout", { noCache: false, signal: controller.signal,
        onCapture: () => { captured = true; } })).rejects.toThrow("caller left during flags");
      expect(captured).toBe(false);
    } finally { query.mockRestore(); }
  } finally { await fx.close(); }
});
