/**
 * propose_takes zero-yield idle cost + take lifecycle — hermetic, MOCKED llmFn
 * and SonnetFn (no Bedrock).
 *
 * A document that cleanly extracts NO gradeable claims used to write no
 * synth_takes row at all, so its idempotency tuple was never recorded and every
 * run re-sent the same unchanged prose to the model. These cover the tombstone
 * row that closes that hole, and the discipline around it: only a cleanly
 * parsed empty array is memoized, and the tombstone stays behind every
 * lifecycle fence instead of reading as a claim.
 *
 * The same edit that produces a tombstone also strands the takes the previous
 * scan distilled from the OLD content, so the retirement pass and `think`'s
 * lifecycle fence are covered here too: a claim the corpus no longer supports
 * must never reach synthesis.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  proposeTakesPhase,
  isWellFormedEmptyExtraction,
  EMPTY_EXTRACTION_TOMBSTONE_TEXT,
} from "../src/core/synthesis/takes.ts";
import { listTakes, searchTakes, getTakesScorecard } from "../src/core/synthesis/reads.ts";
import { calibrationProfilePhase } from "../src/core/synthesis/calibration.ts";
import { probeContradictionsPhase } from "../src/core/synthesis/contradictions.ts";
import { runThink } from "../src/core/synthesis/think.ts";
import type { LlmFn } from "../src/core/llm/haiku.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import type { SearchHit } from "../src/core/search/hybrid.ts";

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-takes-phase-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function seedDoc(id: string, body: string): Promise<void> {
  await engine.query(`INSERT INTO documents (id, source_path, title) VALUES ($1, $2, $3)`, [
    id,
    `/vault/${id}.md`,
    id,
  ]);
  await engine.query(
    `INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ($1, $2, 0, $3)`,
    [`${id}c0`, id, body],
  );
}

/** A failed call parks the document (synth_failures); let that wait run out. */
async function expireBackoff(): Promise<void> {
  await engine.query(`UPDATE synth_failures SET next_eligible_at = now() - interval '1 second'`);
}

/** Counting LLM stub — the call count IS the token spend under test. */
function countingLlm(text: string): { fn: LlmFn; calls: () => number } {
  let calls = 0;
  return {
    fn: async () => {
      calls += 1;
      return { text, modelId: "fake-nova" };
    },
    calls: () => calls,
  };
}

interface TombstoneRow {
  source_ref: string;
  source_hash: string;
  prompt_version: string;
  model_id: string;
  status: string;
  active: boolean;
  holder: string;
  weight: number;
}

/** The tombstone rows — synth_takes rows carrying the sentinel claim. */
async function tombstoneRows(): Promise<TombstoneRow[]> {
  const { rows } = await engine.query<TombstoneRow>(
    `SELECT source_ref, source_hash, prompt_version, model_id, status, active, holder, weight
       FROM synth_takes
      WHERE claim_text = $1
      ORDER BY id ASC`,
    [EMPTY_EXTRACTION_TOMBSTONE_TEXT],
  );
  return rows;
}

/** LLM stub that answers a scripted sequence, repeating the last response. */
function scriptedLlm(...responses: string[]): { fn: LlmFn; calls: () => number } {
  let calls = 0;
  return {
    fn: async () => {
      const text = responses[Math.min(calls, responses.length - 1)]!;
      calls += 1;
      return { text, modelId: "fake-nova" };
    },
    calls: () => calls,
  };
}

/**
 * Engine wrapper whose retirement UPDATE always fails — the stand-in for the
 * crash/query-failure that can land between the tombstone and the retirement.
 * Wraps the transaction handle too, so the injected failure happens INSIDE the
 * transaction the phase opens.
 */
function failRetirement(base: Engine): Engine {
  const wrap = (e: Engine): Engine => ({
    kind: e.kind,
    ready: () => e.ready(),
    query: <T>(sql: string, params?: unknown[]) =>
      /SET active = false/.test(sql)
        ? Promise.reject(new Error("retire boom"))
        : e.query<T>(sql, params),
    exec: (sql: string) => e.exec(sql),
    close: () => e.close(),
    transaction: <T>(fn: (tx: Engine) => Promise<T>) => e.transaction((tx) => fn(wrap(tx))),
  });
  return wrap(base);
}

/** The claim rows — everything in synth_takes that is NOT a tombstone. */
async function takeRows(): Promise<{ claim_text: string; active: boolean; status: string }[]> {
  const { rows } = await engine.query<{ claim_text: string; active: boolean; status: string }>(
    `SELECT claim_text, active, status FROM synth_takes
      WHERE claim_text <> $1
      ORDER BY id ASC`,
    [EMPTY_EXTRACTION_TOMBSTONE_TEXT],
  );
  return rows;
}

describe("isWellFormedEmptyExtraction", () => {
  it("accepts a clean empty array, fenced or bare", () => {
    expect(isWellFormedEmptyExtraction("[]")).toBe(true);
    expect(isWellFormedEmptyExtraction("  [ ]\n")).toBe(true);
    expect(isWellFormedEmptyExtraction("```json\n[]\n```")).toBe(true);
  });

  it("rejects malformed, truncated, prose and non-empty output", () => {
    expect(isWellFormedEmptyExtraction("")).toBe(false);
    expect(isWellFormedEmptyExtraction("I found no gradeable claims.")).toBe(false);
    expect(isWellFormedEmptyExtraction("[{")).toBe(false);
    expect(isWellFormedEmptyExtraction(`[{"claim_text":"x"}`)).toBe(false);
    expect(isWellFormedEmptyExtraction("[] and here is why:")).toBe(false);
    // Prose BEFORE the array is the dangerous shape: a model announcing its
    // own failure and appending a fallback. Seeking to the first `[` reads
    // that as a clean extraction and memoizes the failure.
    expect(isWellFormedEmptyExtraction("Unable to parse source; returning fallback []")).toBe(
      false,
    );
    expect(isWellFormedEmptyExtraction("The note is a shopping list [] nothing to grade")).toBe(
      false,
    );
    expect(isWellFormedEmptyExtraction(`[{"claim_text":"x","kind":"bet","weight":0.5}]`)).toBe(
      false,
    );
  });
});

describe("proposeTakesPhase — zero-yield tombstone", () => {
  it("extracts a zero-claim document once and skips it on the second run", async () => {
    await seedDoc("d1", "Q".repeat(500));
    const llm = countingLlm("[]");

    const r1 = await proposeTakesPhase(engine, { llmFn: llm.fn });
    expect(r1.documentsScanned).toBe(1);
    expect(r1.takesQueued).toBe(0);
    expect(r1.tombstonesWritten).toBe(1);
    expect(llm.calls()).toBe(1);

    const r2 = await proposeTakesPhase(engine, { llmFn: llm.fn });
    expect(r2.documentsScanned).toBe(0);
    expect(r2.tombstonesWritten).toBe(0);
    expect(llm.calls()).toBe(1); // no second spend on unchanged prose
  });

  it("writes the tombstone behind every lifecycle fence", async () => {
    await seedDoc("d1", "R".repeat(500));
    await proposeTakesPhase(engine, { llmFn: countingLlm("[]").fn });
    expect(await takeRows()).toEqual([]); // no claim rows — nothing was proposed
    const rows = await tombstoneRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.source_ref).toBe("d1");
    expect(rows[0]?.prompt_version).toBe("v1-nova");
    expect(rows[0]?.model_id).toBe("fake-nova");
    // A memo, not a belief: out of the review queue and the grade pool
    // ('rejected'), out of think/drift/salience (inactive), and carrying no
    // stated confidence.
    expect(rows[0]?.status).toBe("rejected");
    expect(rows[0]?.active).toBe(false);
    expect(rows[0]?.holder).toBe("brain");
    expect(rows[0]?.weight).toBe(0);
  });

  it("stays invisible to a caller floored to the 'world' holder", async () => {
    await seedDoc("d1", "R".repeat(500));
    await proposeTakesPhase(engine, { llmFn: countingLlm("[]").fn });
    // Every remote token is floored to holder ['world'] — the tombstone's
    // 'brain' holder keeps it out of both take read surfaces.
    expect(await listTakes(engine, { holderAllowList: ["world"] })).toEqual([]);
    expect(
      await searchTakes(engine, { q: "gradeable claims", holderAllowList: ["world"] }),
    ).toEqual([]);
  });

  it("does not tombstone an unparseable response — the document is retried", async () => {
    await seedDoc("d1", "S".repeat(500));
    const llm = countingLlm("Sorry, I could not find any claims.");

    const r1 = await proposeTakesPhase(engine, { llmFn: llm.fn });
    expect(r1.tombstonesWritten).toBe(0);
    expect(r1.errors.length).toBe(1);
    expect(await tombstoneRows()).toEqual([]);

    await expireBackoff();
    const r2 = await proposeTakesPhase(engine, { llmFn: llm.fn });
    expect(r2.documentsScanned).toBe(1);
    expect(llm.calls()).toBe(2);
  });

  it("does not tombstone a prose-wrapped empty array, and keeps the old claims", async () => {
    await seedDoc("d1", "S".repeat(500));
    const claim = `[{"claim_text":"the index will hold","kind":"prediction","weight":0.7}]`;
    // The model gave up and appended a fallback. It parses to [] exactly like a
    // genuine empty extraction, and the prose sits BEFORE the bracket — the one
    // shape that used to slip past the guard, memoizing the failure forever and
    // retiring claims the note still supports on the way out.
    const excuse = "Unable to parse the source note; returning fallback []";
    const llm = scriptedLlm(claim, excuse);
    expect((await proposeTakesPhase(engine, { llmFn: llm.fn })).takesQueued).toBe(1);

    await engine.query(`UPDATE chunks SET content = $1 WHERE id = 'd1c0'`, ["T".repeat(600)]);
    const r = await proposeTakesPhase(engine, { llmFn: llm.fn });
    expect(r.tombstonesWritten).toBe(0);
    expect(r.takesRetired).toBe(0);
    expect(r.errors.length).toBe(1);
    expect(await tombstoneRows()).toEqual([]);
    expect((await takeRows())[0]?.active).toBe(true);

    // Still rediscoverable: nothing was memoized, so once the failure backoff
    // runs out the next run re-scans it.
    await expireBackoff();
    const r2 = await proposeTakesPhase(engine, { llmFn: countingLlm("[]").fn });
    expect(r2.documentsScanned).toBe(1);
    expect(r2.tombstonesWritten).toBe(1);
  });

  it("does not tombstone on an LLM error", async () => {
    await seedDoc("d1", "T".repeat(500));
    const boom: LlmFn = async () => {
      throw new Error("down");
    };
    const r = await proposeTakesPhase(engine, { llmFn: boom });
    expect(r.tombstonesWritten).toBe(0);
    expect(r.errors.length).toBe(1);
    expect(await tombstoneRows()).toEqual([]);
  });

  it("re-extracts after the document content changes", async () => {
    await seedDoc("d1", "U".repeat(500));
    const llm = countingLlm("[]");
    await proposeTakesPhase(engine, { llmFn: llm.fn });
    const first = await tombstoneRows();

    await engine.query(`UPDATE chunks SET content = $1 WHERE id = 'd1c0'`, ["V".repeat(600)]);
    const r = await proposeTakesPhase(engine, { llmFn: llm.fn });
    expect(r.documentsScanned).toBe(1);
    expect(llm.calls()).toBe(2);

    // One tombstone per scanned content hash — the old one stays as the record
    // that THAT text was already paid for, exactly like a take row does.
    const second = await tombstoneRows();
    expect(second.length).toBe(2);
    expect(second[1]?.source_hash).not.toBe(first[0]?.source_hash);
  });

  it("re-extracts after a prompt-version bump", async () => {
    await seedDoc("d1", "W".repeat(500));
    const llm = countingLlm("[]");
    await proposeTakesPhase(engine, { llmFn: llm.fn, promptVersion: "v1" });
    const r = await proposeTakesPhase(engine, { llmFn: llm.fn, promptVersion: "v2" });
    expect(r.documentsScanned).toBe(1);
    expect(llm.calls()).toBe(2);
    expect((await tombstoneRows()).length).toBe(2);
  });

  it("a document that yields claims is memoized by its take rows, not a tombstone", async () => {
    await seedDoc("d1", "X".repeat(500));
    const llm = countingLlm(`[{"claim_text":"X will happen","kind":"prediction","weight":0.7}]`);
    const r = await proposeTakesPhase(engine, { llmFn: llm.fn });
    expect(r.takesQueued).toBe(1);
    expect(r.tombstonesWritten).toBe(0);
    expect(await tombstoneRows()).toEqual([]);
  });

  it("never feeds the sentinel back to the extractor as an already-captured claim", async () => {
    await seedDoc("d1", "Y".repeat(500));
    let user = "";
    const spy: LlmFn = async (input) => {
      user = input.user;
      return { text: "[]", modelId: "fake-nova" };
    };
    await proposeTakesPhase(engine, { llmFn: spy });
    await engine.query(`UPDATE chunks SET content = $1 WHERE id = 'd1c0'`, ["Z".repeat(600)]);
    await proposeTakesPhase(engine, { llmFn: spy });
    expect(user).not.toContain(EMPTY_EXTRACTION_TOMBSTONE_TEXT);
    expect(user).not.toContain("ALREADY CAPTURED");
  });
});

describe("proposeTakesPhase — retiring takes the document no longer supports", () => {
  const oneClaim = `[{"claim_text":"the migration will finish on time","kind":"prediction","weight":0.7}]`;

  it("marks the old takes inactive when the edited document yields nothing", async () => {
    await seedDoc("d1", "Y".repeat(500));
    const llm = scriptedLlm(oneClaim, "[]");
    expect((await proposeTakesPhase(engine, { llmFn: llm.fn })).takesQueued).toBe(1);

    await engine.query(`UPDATE chunks SET content = $1 WHERE id = 'd1c0'`, ["Z".repeat(600)]);
    const r = await proposeTakesPhase(engine, { llmFn: llm.fn });
    expect(r.tombstonesWritten).toBe(1);
    expect(r.takesRetired).toBe(1);

    // Retired, not deleted — the grade + resolution history stays addressable.
    const rows = await takeRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.active).toBe(false);
  });

  it("leaves takes distilled from the CURRENT content alone", async () => {
    await seedDoc("d1", "A".repeat(500));
    const llm = scriptedLlm(oneClaim, "[]");
    await proposeTakesPhase(engine, { llmFn: llm.fn, promptVersion: "v1" });
    // Same prose, a bumped prompt that finds no claims: the v1 take is still
    // backed by the text on disk, so it must survive the tombstone.
    const r = await proposeTakesPhase(engine, { llmFn: llm.fn, promptVersion: "v2" });
    expect(r.tombstonesWritten).toBe(1);
    expect(r.takesRetired).toBe(0);
    expect((await takeRows())[0]?.active).toBe(true);
  });

  it("writes no tombstone when the retirement fails — never memoized-but-stale", async () => {
    await seedDoc("d1", "C".repeat(500));
    const llm = scriptedLlm(oneClaim, "[]");
    expect((await proposeTakesPhase(engine, { llmFn: llm.fn })).takesQueued).toBe(1);
    await engine.query(`UPDATE chunks SET content = $1 WHERE id = 'd1c0'`, ["D".repeat(600)]);

    // Tombstone + retirement are one commit. If the retirement half fails, a
    // committed tombstone would memoize the document forever while its stranded
    // take stayed active — never rediscovered, so never retired.
    const r = await proposeTakesPhase(failRetirement(engine), { llmFn: llm.fn });
    expect(r.tombstonesWritten).toBe(0);
    expect(r.takesRetired).toBe(0);
    expect(r.errors.length).toBe(1);
    expect(await tombstoneRows()).toEqual([]);
    expect((await takeRows())[0]?.active).toBe(true);

    // Still rediscoverable, and the retry lands both halves.
    const r2 = await proposeTakesPhase(engine, { llmFn: llm.fn });
    expect(r2.documentsScanned).toBe(1);
    expect(r2.tombstonesWritten).toBe(1);
    expect(r2.takesRetired).toBe(1);
    expect((await takeRows())[0]?.active).toBe(false);
  });

  it("does not retire an operator fence row", async () => {
    await seedDoc("d1", "B".repeat(500));
    await engine.query(
      `INSERT INTO synth_takes
         (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight,
          status, model_id, row_num)
       VALUES ('fence1', 'd1', 'oldhash', 'operator-fence-v1', 'my own call', 'take', 0.6,
               'accepted', 'operator', 1)`,
    );
    const r = await proposeTakesPhase(engine, { llmFn: countingLlm("[]").fn });
    expect(r.tombstonesWritten).toBe(1);
    expect(r.takesRetired).toBe(0);
    expect((await takeRows())[0]?.active).toBe(true);
  });
});

describe("take read surfaces — zero-yield tombstone fence", () => {
  const CLAIM = "aluminium prices will fall";
  const oneClaim = `[{"claim_text":"${CLAIM}","kind":"prediction","weight":0.7}]`;

  /** Counting Sonnet stub — the call count IS the paid judge spend under test. */
  function countingSonnet(): { fn: SonnetFn; calls: () => number } {
    let calls = 0;
    return {
      fn: async () => {
        calls += 1;
        return {
          text: `{"contradicts":false,"severity":"low","axis":"","confidence":0.2,"resolution_kind":"manual","resolution_command":""}`,
          modelId: "eu.anthropic.claude-sonnet-4-6",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
      calls: () => calls,
    };
  }

  /**
   * One document that yields a claim and one that yields nothing, both stamped
   * with the 'default' tenant. The stub answers per document, so the scan order
   * cannot decide which one gets the claim.
   */
  async function seedClaimAndTombstone(): Promise<void> {
    await seedDoc("d-claim", "A".repeat(500));
    await seedDoc("d-empty", "B".repeat(500));
    await engine.query(
      `INSERT INTO sources (id, kind, path_prefix) VALUES ('default', 'other', '__default__')
         ON CONFLICT (id) DO NOTHING`,
    );
    await engine.query(`UPDATE documents SET source_id = 'default'`);
    const perDoc: LlmFn = async (input) => ({
      text: input.user.includes("Source: d-claim") ? oneClaim : "[]",
      modelId: "fake-nova",
    });
    const r = await proposeTakesPhase(engine, { llmFn: perDoc });
    expect(r.takesQueued).toBe(1);
    expect(r.tombstonesWritten).toBe(1);
  }

  it("keeps the memo out of list_takes — unscoped, scoped, and under its own filters", async () => {
    await seedClaimAndTombstone();
    // The unscoped read is the operator's own: no holder allow-list, no tenant
    // filter, every lifecycle state — nothing but the claim-text fence stands
    // between the memo and a listing that reads it as a take.
    expect((await listTakes(engine)).map((t) => t.claim_text)).toEqual([CLAIM]);
    expect((await listTakes(engine, { sourceIds: ["default"] })).map((t) => t.claim_text)).toEqual([
      CLAIM,
    ]);
    // Asking for exactly the memo's own lifecycle state must still not find it.
    expect(await listTakes(engine, { status: "rejected" })).toEqual([]);
    expect(await listTakes(engine, { active: false })).toEqual([]);
  });

  it("keeps the memo out of takes_search while a real claim still matches", async () => {
    await seedClaimAndTombstone();
    expect(await searchTakes(engine, { q: "gradeable claims" })).toEqual([]);
    expect(await searchTakes(engine, { q: "gradeable claims", sourceIds: ["default"] })).toEqual([]);
    // The positive case proves the empty results above are a fence, not a
    // swallowed error (searchTakes fails open to []).
    expect((await searchTakes(engine, { q: "aluminium prices" })).map((t) => t.claim_text)).toEqual([
      CLAIM,
    ]);
  });

  it("leaves the scorecard counting real takes only", async () => {
    await seedClaimAndTombstone();
    expect((await getTakesScorecard(engine)).total_takes).toBe(1);
    expect((await getTakesScorecard(engine, { sourceIds: ["default"] })).total_takes).toBe(1);
  });

  it("does not drag grade_completion down with an ungradeable memo", async () => {
    await seedDoc("d1", "C".repeat(500));
    await proposeTakesPhase(engine, { llmFn: countingLlm("[]").fn });
    const { rows } = await engine.query<{ id: number }>(
      `INSERT INTO synth_takes
         (take_key, source_ref, source_hash, prompt_version, claim_text, model_id)
       VALUES ('t-graded', 'd1', 'h2', 'v1-nova', 'the rollout lands in Q3', 'm')
       RETURNING id`,
    );
    await engine.query(
      `INSERT INTO synth_take_grades
         (take_id, prompt_version, evidence_signature, verdict, confidence, model_id)
       VALUES ($1, 'v1-nova', 'sig', 'correct', 0.8, 'm')`,
      [Number(rows[0]?.id)],
    );

    // 1 graded of 1 gradeable take. Counting the memo would report 1/2 and keep
    // the tenant permanently short of "fully graded".
    const r = await calibrationProfilePhase(engine, {
      llmFn: async () => ({ text: "", modelId: "fake-nova" }),
    });
    expect(r.profiles.length).toBe(1);
    expect(r.profiles[0]?.gradeCompletion).toBe(1);
  });

  it("never spends a contradiction judge pairing the memo with a fact", async () => {
    await seedDoc("d1", "D".repeat(500));
    await proposeTakesPhase(engine, { llmFn: countingLlm("[]").fn });
    // The entity name appears in the sentinel, which is the whole condition the
    // take-vs-fact stream pairs on.
    await engine.query(
      `INSERT INTO entity_facts (entity_slug, fact, written_by)
       VALUES ('topics/gradeable', 'gradeable claims are rare here', 'test')`,
    );

    const sonnet = countingSonnet();
    const r = await probeContradictionsPhase(engine, { sonnetFn: sonnet.fn });
    expect(r.pairsScanned).toBe(0);
    expect(r.judged).toBe(0);
    expect(sonnet.calls()).toBe(0);
  });
});

describe("think take gather — lifecycle fence", () => {
  const okResponse = JSON.stringify({ answer: "ok", citations: [], gaps: [] });
  const fakePages = async (): Promise<SearchHit[]> => [];
  /** Fixed non-zero vector — the claim embeddings and the question embedding
   *  are identical, so every embedded take is a candidate for the vector arm. */
  const vec = (): number[] => new Array(1024).fill(0.01);

  async function seedTake(
    key: string,
    claim: string,
    cols: {
      sourceRef?: string;
      status?: string;
      active?: boolean;
      resolved?: boolean;
      embedded?: boolean;
    } = {},
  ): Promise<void> {
    await engine.query(
      `INSERT INTO synth_takes
         (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight,
          status, model_id, active, resolved_at, resolved_quality, resolved_outcome, embedding)
       VALUES ($1, $2, 'h', 'v', $3, 'prediction', 0.7, $4, 'fake-nova', $5,
               $6::timestamptz, $7, $8, $9::vector)`,
      [
        key,
        cols.sourceRef ?? "doc1",
        claim,
        cols.status ?? "queued",
        cols.active ?? true,
        cols.resolved ? new Date().toISOString() : null,
        cols.resolved ? "correct" : null,
        cols.resolved ? true : null,
        cols.embedded ? JSON.stringify(vec()) : null,
      ],
    );
  }

  /** Run think over a mocked model and hand back the prompt it saw. */
  async function think(
    embed: boolean,
    question = "migration",
  ): Promise<{ takes: number; user: string }> {
    let user = "";
    const spy: SonnetFn = async (input) => {
      user = input.user;
      return {
        text: okResponse,
        modelId: "eu.anthropic.claude-sonnet-4-6",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    };
    const r = await runThink(storage, {
      question,
      sonnetFn: spy,
      pagesFn: fakePages,
      embedFn: embed ? async () => vec() : null,
    });
    return { takes: r.takesGathered, user };
  }

  it("gathers only the live take — not the retired, rejected or resolved ones", async () => {
    await seedTake("live", "the migration will finish on time");
    await seedTake("retired", "the migration is doomed", { active: false });
    await seedTake("rejected", "the migration never started", { status: "rejected" });
    await seedTake("settled", "the migration slipped a quarter", { resolved: true });

    const { takes, user } = await think(false);
    expect(takes).toBe(1);
    expect(user).toContain("the migration will finish on time");
    expect(user).not.toContain("doomed");
    expect(user).not.toContain("never started");
    expect(user).not.toContain("slipped a quarter");
  });

  it("drops a take whose backing document was soft-deleted", async () => {
    await engine.query(
      `INSERT INTO documents (id, source_path, title, deleted_at)
       VALUES ('gone', '/vault/gone.md', 'gone', now())`,
    );
    await seedTake("live", "the migration will finish on time");
    await seedTake("orphan", "the migration was a mistake", { sourceRef: "gone" });

    const { takes, user } = await think(false);
    expect(takes).toBe(1);
    expect(user).not.toContain("a mistake");
  });

  it("never gathers a zero-yield tombstone", async () => {
    await seedDoc("d1", "C".repeat(500));
    await proposeTakesPhase(engine, { llmFn: countingLlm("[]").fn });
    // The question is worded to MATCH the sentinel's keyword scan, so only the
    // lifecycle fence can keep it out.
    const { takes, user } = await think(false, "gradeable claims");
    expect(takes).toBe(0);
    expect(user).not.toContain(EMPTY_EXTRACTION_TOMBSTONE_TEXT);
  });

  it("fences the vector stream the same way as the keyword stream", async () => {
    // The claim shares no words with the question, so only the vector arm can
    // surface it — proving the fence is not enforced by the keyword arm alone.
    await seedTake("retired", "quarterly hiring stays flat", {
      active: false,
      embedded: true,
    });

    const { takes, user } = await think(true);
    expect(takes).toBe(0);
    expect(user).not.toContain("hiring stays flat");
  });
});
