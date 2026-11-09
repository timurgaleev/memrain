/**
 * G32 think persistence + gather widening — hermetic (no Bedrock; injected
 * sonnetFn/pagesFn/embedFn).
 *   - persistThinkSynthesis: synthesis page + synthesis_evidence citation rows
 *   - saveThinkTake: queued synth_takes row (idempotent)
 *   - withCalibration opt-in flag (calibration block absent by default)
 *   - anchor-subgraph gather stream (traverseGraph reuse + RRF fusion)
 *   - rounds: gaps feed a second gather + synthesize
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { runThink, gatherGraphPages, fusePageStreams, type ThinkResult } from "../src/core/synthesis/think.ts";
import {
  persistThinkSynthesis,
  saveThinkTake,
  synthesisSlugFor,
} from "../src/core/synthesis/think-persist.ts";
import { putPage } from "../src/core/pages.ts";
import { addLink } from "../src/core/links.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import type { SearchHit } from "../src/core/search/hybrid.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-think-persist-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const hit = (path: string, content = "some page content"): SearchHit => ({
  chunkId: `c-${path}`,
  documentId: `d-${path}`,
  sourcePath: path,
  title: path,
  content,
  score: 1,
  intent: "topic",
});

const sonnetOf = (payloads: string[]): { fn: SonnetFn; calls: () => number; users: string[] } => {
  let i = 0;
  const users: string[] = [];
  const fn: SonnetFn = async (input) => {
    users.push(input.user);
    return {
      text: payloads[Math.min(i++, payloads.length - 1)]!,
      modelId: "eu.anthropic.claude-sonnet-4-6",
      usage: { inputTokens: 200, outputTokens: 100 },
    };
  };
  return { fn, calls: () => i, users };
};

describe("synthesisSlugFor", () => {
  it("slugifies the question with a date suffix", () => {
    const slug = synthesisSlugFor("What changed in Q3?!", new Date("2026-07-05T10:00:00Z"));
    expect(slug).toBe("synthesis/what-changed-in-q3-2026-07-05");
  });
});

describe("persistThinkSynthesis", () => {
  const result = (answer: string): ThinkResult => ({
    ran: true,
    synthesisStatus: "ok",
    synthesis: {
      answer,
      citations: [
        { ref: "notes/plan.md", kind: "page" },
        { ref: "take-key-123", kind: "take" },
      ],
      gaps: ["missing revenue data"],
    },
    pagesGathered: 1,
    takesGathered: 1,
    spentUsd: 0.01,
    modelId: "m",
    budgetExhausted: false,
  });

  it("writes a synthesis page + evidence rows", async () => {
    const r = await persistThinkSynthesis(storage, {
      question: "what changed",
      result: result("Things changed [notes/plan.md]."),
    });
    expect(r.slug.startsWith("synthesis/what-changed-")).toBe(true);
    expect(r.evidenceInserted).toBe(2);
    expect((await engine.query<{ written_by_principal: string }>(
      "SELECT written_by_principal FROM page_versions WHERE slug=$1 ORDER BY version_n DESC LIMIT 1", [r.slug])).rows[0]?.written_by_principal).toBe("operator");

    const { rows: pages } = await engine.query<{ slug: string; type: string; markdown_body: string }>(
      `SELECT slug, type, markdown_body FROM pages WHERE slug = $1`,
      [r.slug],
    );
    expect(pages.length).toBe(1);
    expect(pages[0]?.type).toBe("synthesis");
    expect(pages[0]?.markdown_body).toContain("missing revenue data");

    const { rows: ev } = await engine.query<{ ref: string; kind: string; citation_index: number }>(
      `SELECT ref, kind, citation_index FROM synthesis_evidence WHERE synthesis_slug = $1 ORDER BY citation_index`,
      [r.slug],
    );
    expect(ev.map((e) => [e.ref, e.kind])).toEqual([
      ["notes/plan.md", "page"],
      ["take-key-123", "take"],
    ]);

    // Re-persist is idempotent (no duplicate evidence).
    const again = await persistThinkSynthesis(storage, {
      question: "what changed",
      result: result("Things changed [notes/plan.md]."),
    });
    expect(again.evidenceInserted).toBe(0);
  });

  it("refuses to persist an empty synthesis", async () => {
    const r = await persistThinkSynthesis(storage, {
      question: "q",
      result: { ...result(""), synthesis: { answer: "", citations: [], gaps: [] } },
    });
    expect(r.slug).toBe("");
    expect(r.warnings).toContain("SYNTHESIS_EMPTY_NOT_PERSISTED");
  });
});

describe("saveThinkTake", () => {
  it("queues an idempotent take pinned to the anchor", async () => {
    const first = await saveThinkTake(engine, {
      claim: "memrain will outgrow its current scope",
      anchorSlug: "projects/memrain",
      weight: 0.8,
      domain: "product",
    });
    expect(first.inserted).toBe(true);
    const second = await saveThinkTake(engine, {
      claim: "memrain will outgrow its current scope",
      anchorSlug: "projects/memrain",
    });
    expect(second.inserted).toBe(false);
    expect(second.take_key).toBe(first.take_key);
    const { rows } = await engine.query<{ status: string; source_ref: string; weight: number }>(
      `SELECT status, source_ref, weight FROM synth_takes WHERE take_key = $1`,
      [first.take_key],
    );
    expect(rows[0]?.status).toBe("queued");
    expect(rows[0]?.source_ref).toBe("projects/memrain");
    expect(Number(rows[0]?.weight)).toBeCloseTo(0.8, 6);
  });
});

const ANSWER = JSON.stringify({ answer: "All good [notes/a.md].", citations: [], gaps: [] });

describe("runThink withCalibration flag", () => {
  async function seedProfile(): Promise<void> {
    await engine.query(
      `INSERT INTO synth_calibration_profile (total_graded, accuracy, pattern_statements, bias_tags, model_id)
       VALUES (7, 0.71, '["You call macro well."]'::jsonb, '["over-confident-macro"]'::jsonb, 'm')`,
    );
  }

  it("omits the calibration block by default", async () => {
    await seedProfile();
    const s = sonnetOf([ANSWER]);
    await runThink(storage, {
      question: "how am I doing",
      sonnetFn: s.fn,
      pagesFn: async () => [hit("notes/a.md")],
      embedFn: null,
    });
    expect(s.users[0]).not.toContain("<calibration>");
  });

  it("injects the calibration block when withCalibration=true", async () => {
    await seedProfile();
    const s = sonnetOf([ANSWER]);
    await runThink(storage, {
      question: "how am I doing",
      sonnetFn: s.fn,
      pagesFn: async () => [hit("notes/a.md")],
      embedFn: null,
      withCalibration: true,
    });
    expect(s.users[0]).toContain("<calibration>");
    expect(s.users[0]).toContain("over-confident-macro");
  });
});

describe("anchor-subgraph gather stream", () => {
  it("gatherGraphPages walks the link graph from an anchor and returns page hits", async () => {
    await putPage(storage, { slug: "people/alice", title: "Alice", markdown_body: "Alice founded Acme and leads it." });
    await putPage(storage, { slug: "companies/acme", title: "Acme", markdown_body: "Acme is a robotics startup in Berlin." });
    await addLink(storage, {
      source_slug: "people/alice",
      target_slug: "companies/acme",
      type: "founded",
      allowAdHocType: true,
    });

    const hits = await gatherGraphPages(storage, ["people/alice"], 10);
    const paths = hits.map((h) => h.sourcePath);
    expect(paths).toContain("page://people/alice");
    expect(paths).toContain("page://companies/acme");
    // The anchor itself outranks its 1-hop neighbor.
    expect(hits[0]?.sourcePath).toBe("page://people/alice");
  });

  it("fusePageStreams dedups by sourcePath and keeps both streams' unique hits", () => {
    const fused = fusePageStreams(
      [hit("a.md"), hit("b.md")],
      [hit("b.md"), hit("c.md")],
      10,
    );
    const paths = fused.map((h) => h.sourcePath);
    expect(paths.length).toBe(3);
    // b.md appears in both streams → highest fused score.
    expect(paths[0]).toBe("b.md");
  });
});

describe("rounds", () => {
  const ROUND1 = JSON.stringify({
    answer: "Partial [notes/a.md].",
    citations: [{ ref: "notes/a.md", kind: "page" }],
    gaps: ["what about churn"],
  });
  const ROUND2 = JSON.stringify({
    answer: "Complete [notes/churn.md].",
    citations: [{ ref: "notes/churn.md", kind: "page" }],
    gaps: [],
  });

  it("feeds round-1 gaps into a second gather + synthesize", async () => {
    const queries: string[] = [];
    const s = sonnetOf([ROUND1, ROUND2]);
    const r = await runThink(storage, {
      question: "how is the business",
      rounds: 2,
      sonnetFn: s.fn,
      embedFn: null,
      pagesFn: async (q) => {
        queries.push(q);
        return q.includes("churn") ? [hit("notes/churn.md")] : [hit("notes/a.md")];
      },
    });
    expect(s.calls()).toBe(2);
    expect(queries.length).toBe(2);
    expect(queries[1]).toContain("what about churn");
    expect(r.synthesis?.answer).toContain("Complete");
    // Evidence widened across rounds → the round-2 citation validates.
    expect(r.synthesis?.citations.map((c) => c.ref)).toContain("notes/churn.md");
  });

  it("stops after round 1 when there are no gaps", async () => {
    const s = sonnetOf([ROUND2]);
    const r = await runThink(storage, {
      question: "q",
      rounds: 3,
      sonnetFn: s.fn,
      embedFn: null,
      pagesFn: async () => [hit("notes/churn.md")],
    });
    expect(s.calls()).toBe(1);
    expect(r.synthesis?.answer).toContain("Complete");
  });
});
