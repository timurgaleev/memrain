import { describe, expect, it } from "bun:test";
import { expandAnchors } from "../src/core/search/structural-expand.ts";
import type { Engine } from "../src/core/engine/interface.ts";

describe("bounded read and retry contracts", () => {
  it("orders each capped structural lookup before applying its limit", async () => {
    const queries: string[] = [];
    const engine = {
      kind: "pglite",
      async query(sql: string) {
        queries.push(sql);
        return { rows: sql.includes("FROM chunks") && !sql.includes("JOIN chunks")
          ? [{ id: "anchor", symbol_name_qualified: "Svc::start" }] : [] };
      },
    } as unknown as Engine;
    await expandAnchors(engine, [], { nearSymbol: "Svc::start", walkDepth: 1 });
    const limited = queries.filter(sql => /\bLIMIT\b/.test(sql));
    expect(limited).toHaveLength(4);
    for (const sql of limited) expect(sql).toMatch(/ORDER BY[^;]+LIMIT/s);
  });

});
