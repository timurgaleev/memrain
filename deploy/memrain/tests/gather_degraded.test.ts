import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { runThink } from "../src/core/synthesis/think.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { putPage } from "../src/core/pages.ts";
import { deterministicEmbed } from "./det-embed.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import type { SearchHit } from "../src/core/search/hybrid.ts";

let db: Awaited<ReturnType<ReturnType<typeof storageEngines>[number]["open"]>>;
const sonnetFn: SonnetFn = async () => ({ text: JSON.stringify({ answer: "Available evidence [notes/plan.md].", citations: [{ ref: "notes/plan.md", kind: "page" }], gaps: [] }),
  modelId: "eu.anthropic.claude-sonnet-4-6", usage: { inputTokens: 100, outputTokens: 50 } });
const hit: SearchHit = { chunkId: "test-chunk", documentId: "test-doc", sourcePath: "notes/plan.md", title: "Plan", content: "Available evidence.", score: 1, intent: "topic" };
beforeAll(async () => {
  db = await storageEngines(undefined)[0]!.open();
  await putPage(db.storage, { slug: "people/alice", type: "person", title: "Alice", markdown_body: "Planning work." });
});
afterAll(async () => { await db.close(); });

describe("partial gather diagnostics", () => {
  for (const [pattern, reason] of [
    ["claim_text ILIKE", "takes_keyword_failed"],
    ["ORDER BY embedding <=>", "takes_vector_failed"],
    ["effective_date_source", "page_dates_failed"],
    ["FROM synth_calibration_profile", "calibration_failed"],
  ]) it(`reports ${reason} while keeping available pages`, async () => {
    const e = db.storage.engine();
    const original = e.query.bind(e);
    const query = spyOn(e, "query").mockImplementation(async (sql, params) => {
      if (sql.includes(pattern!)) throw Object.assign(new Error("private database detail"), { code: "57014" });
      return original(sql, params);
    });
    try {
      const r = await runThink(db.storage, { question: "Explain the plan", pagesFn: async () => [hit], sonnetFn,
        embedFn: async () => deterministicEmbed("plan"), withCalibration: true });
      expect(r.pagesGathered).toBe(1);
      expect(r.synthesisStatus).toBe("ok");
      expect((r as any).gather_degraded).toContain(reason);
      expect(JSON.stringify(r)).not.toContain("private database detail");
    } finally { query.mockRestore(); }
  });

  it("propagates safe search arm failures without corpus-dependent reasons", async () => {
    const r = await runThink(db.storage, { question: "unmatched phrase", sonnetFn, embedFn: null,
      embedQuery: async () => { throw new Error("offline"); } });
    expect((r as any).gather_degraded).toContain("vector_arm_failed");
    expect((r as any).gather_degraded).not.toContain("keyword_zero");
  });

  for (const tool of ["context_pack", "volunteer_context"]) it(`${tool} exposes resolver failures`, async () => {
    const e = db.storage.engine();
    const original = e.query.bind(e);
    const query = spyOn(e, "query").mockImplementation(async (sql, params) => {
      if (sql.includes("lower(title) = ANY")) throw Object.assign(new Error("private database detail"), { code: "57014" });
      return original(sql, params);
    });
    try {
      const r = await dispatchTool(db.storage, { name: tool, arguments: { window: "user: Ask Alice about planning." } });
      expect(r.isError).toBeFalsy();
      const data = JSON.parse(r.content[0]!.text);
      expect(data.gather_degraded).toContain("entity_lookup_failed");
      expect(r.content[0]!.text).not.toContain("private database detail");
    } finally { query.mockRestore(); }
  });

  it("keeps successful response shapes free of failure metadata", async () => {
    const r = await runThink(db.storage, { question: "Explain the plan", pagesFn: async () => [hit], sonnetFn, embedFn: null });
    expect((r as any).gather_degraded).toBeUndefined();
  });
});
