/**
 * Reflections: a prose answer gets one follow-up for the JSON array, a `[]`
 * parks the transcripts for good, and prose twice parks them with backoff — so
 * unchanged transcripts are not paid for on every run.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { reflectionsPhase, REFLECTIONS_REASK } from "../src/core/synthesis/reflections.ts";
import { BudgetTracker } from "../src/core/budget.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-reflections-skip-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const MODEL = "eu.anthropic.claude-sonnet-4-6";

/** Answers in order; the last one repeats. Records every prompt it was sent. */
function scripted(answers: string[], outputTokens = 40): SonnetFn & { prompts: string[] } {
  const prompts: string[] = [];
  const fn = (async (input) => {
    prompts.push(input.user);
    const text = answers[Math.min(prompts.length - 1, answers.length - 1)]!;
    return { text, modelId: MODEL, usage: { inputTokens: 200, outputTokens } };
  }) as SonnetFn & { prompts: string[] };
  fn.prompts = prompts;
  return fn;
}

async function seed(slug: string, body: string): Promise<void> {
  await putPage(storage, { slug, type: "note", title: slug, markdown_body: body, source_id: "default" });
}

const BODY = "Spent the afternoon going over the quarterly plan again, weighing whether to cut scope or ask for more time, ".repeat(3);

async function parkedKinds(): Promise<string[]> {
  const r = await storage.engine().query<{ kind: string }>(
    "SELECT kind FROM synth_failures WHERE phase = 'reflections' ORDER BY doc_id",
  );
  return r.rows.map((row) => row.kind);
}

describe("reflections skip", () => {
  // Value: protects=a "nothing here" answer is paid once; fails_when=unchanged transcripts are re-sent every run.
  it("parks the transcripts after a [] answer, so the next run sends nothing", async () => {
    await seed("notes/a", BODY);
    await seed("notes/b", `${BODY} b`);
    const fn = scripted(["[]"]);
    const first = await reflectionsPhase(storage, { sonnetFn: fn, modelId: MODEL });
    expect(first.ran).toBe(true);
    expect(fn.prompts).toHaveLength(1);
    expect(await parkedKinds()).toEqual(["skipped", "skipped"]);
    const second = await reflectionsPhase(storage, { sonnetFn: fn, modelId: MODEL });
    expect(second.reason).toBe("no un-reflected transcripts in scope");
    expect(fn.prompts).toHaveLength(1);
  });

  // Value: protects=a prose answer is asked once for the JSON skip; fails_when=prose is re-paid every run or asked twice.
  it("asks once for the JSON array after a prose answer and records the skip", async () => {
    await seed("notes/a", BODY);
    const fn = scripted(["Nothing in these notes seems worth a reflection.", "[]"]);
    await reflectionsPhase(storage, { sonnetFn: fn, modelId: MODEL });
    expect(fn.prompts).toHaveLength(2);
    expect(fn.prompts[1]).toContain(REFLECTIONS_REASK);
    expect(await parkedKinds()).toEqual(["skipped"]);
    await reflectionsPhase(storage, { sonnetFn: fn, modelId: MODEL });
    expect(fn.prompts).toHaveLength(2);
  });

  it("parks with backoff when the model answers in prose twice", async () => {
    await seed("notes/a", BODY);
    const fn = scripted(["I do not think there is anything here."]);
    const res = await reflectionsPhase(storage, { sonnetFn: fn, modelId: MODEL });
    expect(fn.prompts).toHaveLength(2);
    expect(res.errors.join(" ")).toContain("parked");
    const row = (await storage.engine().query<{ kind: string; forever: boolean }>(
      "SELECT kind, next_eligible_at = 'infinity'::timestamptz AS forever FROM synth_failures WHERE phase = 'reflections'",
    )).rows[0]!;
    expect(row).toEqual({ kind: "unparseable", forever: false });
    await reflectionsPhase(storage, { sonnetFn: fn, modelId: MODEL });
    expect(fn.prompts).toHaveLength(2);
  });

  it("backs off when no entry of the array is usable", async () => {
    await seed("notes/a", BODY);
    const fn = scripted([JSON.stringify([{ topic_slug: "x", title: "T", body: "B", evidence: ["notes/invented"] }])]);
    await reflectionsPhase(storage, { sonnetFn: fn, modelId: MODEL });
    expect(fn.prompts).toHaveLength(1);
    expect(await parkedKinds()).toEqual(["unparseable"]);
    await reflectionsPhase(storage, { sonnetFn: fn, modelId: MODEL });
    expect(fn.prompts).toHaveLength(1);
  });

  // Value: protects=a transcript no written reflection cites is not re-sent; fails_when=only an all-empty answer parks transcripts.
  it("parks the transcripts a written reflection does not cite", async () => {
    await seed("notes/a", BODY);
    await seed("notes/b", `${BODY} b`);
    const fn = scripted([JSON.stringify([{ topic_slug: "scope", title: "Scope or time", body: "Weighing scope [[notes/a]].", evidence: ["notes/a"] }])]);
    const first = await reflectionsPhase(storage, { sonnetFn: fn, modelId: MODEL });
    expect(first.reflectionsWritten).toBe(1);
    const parked = await storage.engine().query<{ doc_id: string; kind: string }>(
      "SELECT doc_id, kind FROM synth_failures WHERE phase = 'reflections'",
    );
    expect(parked.rows).toHaveLength(1);
    expect(parked.rows[0]!.doc_id).toContain("notes/b");
    expect(parked.rows[0]!.kind).toBe("skipped");
    expect(fn.prompts[0]).toContain("[[notes/b]]");
    await reflectionsPhase(storage, { sonnetFn: fn, modelId: MODEL });
    expect(fn.prompts.slice(1).some((p) => p.includes("[[notes/b]]"))).toBe(false);
  });

  it("sends no follow-up for broken JSON or a declined answer", async () => {
    await seed("notes/a", BODY);
    const broken = scripted(['[{"topic_slug": "x", "title": ']);
    await reflectionsPhase(storage, { sonnetFn: broken, modelId: MODEL });
    expect(broken.prompts).toHaveLength(1);
    await seed("notes/a", `${BODY} edited`);
    const prompts: string[] = [];
    const declined: SonnetFn = async (input) => {
      prompts.push(input.user);
      return { text: "I cannot help with that.", modelId: MODEL, usage: { inputTokens: 200, outputTokens: 10 }, stopReason: "content_filtered" };
    };
    await reflectionsPhase(storage, { sonnetFn: declined, modelId: MODEL });
    expect(prompts).toHaveLength(1);
  });

  it("re-opens a parked transcript once it is edited", async () => {
    await seed("notes/a", BODY);
    const fn = scripted(["[]"]);
    await reflectionsPhase(storage, { sonnetFn: fn, modelId: MODEL });
    await seed("notes/a", `${BODY} and then decided to ask for a week more.`);
    await reflectionsPhase(storage, { sonnetFn: fn, modelId: MODEL });
    expect(fn.prompts).toHaveLength(2);
  });

  it("sends no follow-up when the budget cannot cover it", async () => {
    await seed("notes/a", BODY);
    const fn = scripted(["Just prose."], 1000);
    // Room for the first call's estimate, not for a second one after it.
    const budget = new BudgetTracker(0.03, "reflections");
    const res = await reflectionsPhase(storage, { sonnetFn: fn, modelId: MODEL, budget });
    expect(fn.prompts).toHaveLength(1);
    expect(res.budgetExhausted).toBe(true);
    expect(await parkedKinds()).toEqual([]);
  });

  it("does not park transcripts behind a cut-off answer", async () => {
    await seed("notes/a", BODY);
    let calls = 0;
    const fn: SonnetFn = async () => {
      calls += 1;
      return { text: "[{\"topic_slug\": \"x\", \"title\": \"cut", modelId: MODEL, usage: { inputTokens: 200, outputTokens: 1500 }, stopReason: "max_tokens" };
    };
    await reflectionsPhase(storage, { sonnetFn: fn, modelId: MODEL, budget: new BudgetTracker(1, "reflections") });
    expect(await parkedKinds()).toEqual([]);
    expect(calls).toBeLessThanOrEqual(2);
  });
});
