/**
 * Write-back fidelity bench — drives the shipped conversation→facts pipeline
 * with a stubbed model and pins what survives the trip into the ledger.
 *
 * MEASURES: whether the pipeline preserves the claims it is handed. Four
 * numbers over four fixtures — how many labelled claims reached the ledger
 * (`fidelityRecall`), how many ledger rows any label accounts for
 * (`fidelityPrecision`), how many claims the pipeline was required to discard
 * actually stayed out (`dropCompliance`), and of the claims that landed, how
 * many landed altered (`distortionRate`).
 *
 * The stub replaces the MODEL and nothing else: `stubResponses` holds raw model
 * text, so the parser, the anonymous-speaker gate, the slug resolver and
 * `addFact` all run for real. The test at "the parser is in the loop" proves
 * that rather than asserting it — corrupting one response's JSON moves the
 * score, which it could not do if the harness read the fixture's own facts.
 *
 * The pinned numbers are a RATCHET, not a target. Three of them are pinned
 * below their ceiling on purpose, each for a documented reason, and each pin
 * says which fixture owns it. Fixing one SHOULD break this test; the fix is to
 * move the pin, not the label.
 *
 * Hermetic and free: PGLite on a temp dir, no network, no model call. The
 * "costs nothing" claim is asserted against the spend ledger, not stated.
 *
 * What a green run does NOT tell you: that the EXTRACTOR is good. The model is
 * a fixture here. These numbers grade what the pipeline does with a known model
 * answer; whether a real Sonnet call would produce that answer is a different
 * measurement this family deliberately does not make.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { FixtureError } from "../src/core/bench/fixtures.ts";
import {
  loadFidelityCorpus,
  parseFidelityFixture,
  type FidelityFixture,
} from "../src/core/bench/fidelity-fixtures.ts";
import {
  fidelityFamilyReport,
  makeGoldStub,
  normalizeFactText,
  runFidelityFixture,
  runFidelityCorpus,
  scoreFidelity,
  type FidelityCorpusRun,
} from "../src/core/bench/fidelity-harness.ts";
import { formatScoreboard } from "../src/core/bench/scoreboard.ts";
import { assertBrainEmpty } from "../src/core/bench/reset.ts";
import type { FactRow } from "../src/core/facts.ts";

let tmp: string;
let storage: Storage;
let fixtures: FidelityFixture[];
let run: FidelityCorpusRun;
let spendBefore: number;
let spendAfter: number;

/** Total booked spend across every client, in cents. Zero, or a call was paid for. */
async function ledgerCents(s: Storage): Promise<number> {
  const r = await s
    .engine()
    .query<{ c: string }>(
      `SELECT (COALESCE((SELECT SUM(spend_cents) FROM mcp_spend_log), 0)
             + COALESCE((SELECT SUM(estimated_cents) FROM mcp_spend_reservations), 0))::text AS c`,
    );
  return Number(r.rows[0]!.c);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-fidelity-bench-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  fixtures = loadFidelityCorpus();
  spendBefore = await ledgerCents(storage);
  // One Storage, one replay of the whole corpus; every test below reads it.
  run = await runFidelityCorpus(storage, fixtures);
  spendAfter = await ledgerCents(storage);
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const runFor = (name: string) => {
  const r = run.runs.find((x) => x.fixture === name);
  if (!r) throw new Error(`no such fidelity fixture: ${name}`);
  return r;
};

// -- The loader is strict, or the labels mean nothing ----------------------

describe("fidelity fixtures loader", () => {
  const minimal = {
    name: "x",
    description: "d",
    sourceSlug: "conversations/x",
    dateContext: "2026-08-14",
    stubModelId: "eu.anthropic.claude-sonnet-4-6-v1:0",
    transcript: "[2026-08-14 09:00] Ada Lin: I moved the renewal.\n",
    stubResponses: {
      "0": '{"facts":[{"fact":"Ada Lin moved the renewal.","kind":"commitment","entity":"Ada Lin","confidence":0.9,"notability":"high"}]}',
    },
    gold: [
      {
        id: "g0",
        entity_slug: "people/ada-lin",
        fact: "Ada Lin moved the renewal.",
        kind: "commitment",
        notability: "high",
      },
    ],
    reject: [],
  };

  it("accepts a minimal well-formed fixture", () => {
    expect(parseFidelityFixture("t", structuredClone(minimal)).gold[0]!.id).toBe("g0");
  });

  it("rejects an unknown key on a gold label — the silent-typo case", () => {
    const bad = structuredClone(minimal) as Record<string, unknown>;
    (bad["gold"] as Record<string, unknown>[])[0]!["expects"] = { valid_from: "2026-08-14" };
    expect(() => parseFidelityFixture("t", bad)).toThrow(FixtureError);
    expect(() => parseFidelityFixture("t", bad)).toThrow(/unknown key "expects"/);
  });

  it("rejects `rawSlugs`, because no seam turns canonicalization off", () => {
    // The spec sketched the flag; `writeExtractedFacts` builds its resolver
    // unconditionally (facts-extract.ts:499), so honouring it would mean a seam
    // on a production write path. A flag that silently does nothing is worse
    // than no flag.
    const bad = { ...structuredClone(minimal), rawSlugs: true };
    expect(() => parseFidelityFixture("t", bad)).toThrow(/unknown key "rawSlugs"/);
  });

  it("rejects a stub response that is not raw model text", () => {
    const bad = structuredClone(minimal) as Record<string, unknown>;
    bad["stubResponses"] = { "0": [{ fact: "Ada Lin moved the renewal." }] };
    expect(() => parseFidelityFixture("t", bad)).toThrow(/grades itself, not the pipeline/);
  });

  it("rejects a model id the budget cannot price", () => {
    // An unpriced id makes BudgetTracker.record throw no_pricing, and the run
    // reports zero facts with no model error anywhere in sight.
    const bad = { ...structuredClone(minimal), stubModelId: "eu.amazon.nova-pro-v1:0" };
    expect(() => parseFidelityFixture("t", bad)).toThrow(/matches no priced model family/);
  });

  it("rejects a transcript no parser recognizes", () => {
    // Non-empty, and still zero turns: no pattern matches a bare line of prose,
    // so the fixture would make no model call and score 0 recall for it.
    const bad = { ...structuredClone(minimal), transcript: "a paragraph nobody spoke\n" };
    expect(() => parseFidelityFixture("t", bad)).toThrow(/found no turns/);
  });

  it("rejects a stub response for a turn the transcript does not have", () => {
    const bad = structuredClone(minimal) as Record<string, unknown>;
    (bad["stubResponses"] as Record<string, string>)["4"] = '{"facts":[]}';
    expect(() => parseFidelityFixture("t", bad)).toThrow(/turn 4 is never asked/);
  });

  it("rejects a label the stub never emits", () => {
    // A gold claim absent from every response scores a recall miss for a reason
    // that has nothing to do with the pipeline; a reject claim absent from every
    // response passes drop compliance for free.
    const bad = structuredClone(minimal) as Record<string, unknown>;
    (bad["gold"] as Record<string, unknown>[])[0]!["fact"] = "Ada Lin cancelled the renewal.";
    expect(() => parseFidelityFixture("t", bad)).toThrow(/names a claim no stubResponse emits/);
  });

  it("rejects a reject reason that names no gate the pipeline enforces", () => {
    const bad = structuredClone(minimal) as Record<string, unknown>;
    bad["reject"] = [
      { id: "r0", reason: "below_notability", fact: "Ada Lin moved the renewal." },
    ];
    expect(() => parseFidelityFixture("t", bad)).toThrow(/names no gate the shipped pipeline/);
  });

  it("rejects a claim that is both required and forbidden", () => {
    const bad = structuredClone(minimal) as Record<string, unknown>;
    bad["reject"] = [
      { id: "r0", reason: "null_entity", fact: "Ada Lin moved the renewal." },
    ];
    expect(() => parseFidelityFixture("t", bad)).toThrow(/repeats a gold claim verbatim/);
  });

  it("rejects a fixture with no gold and one with no reject key at all", () => {
    const noGold = { ...structuredClone(minimal), gold: [] };
    expect(() => parseFidelityFixture("t", noGold)).toThrow(/non-empty array/);
    const noReject = structuredClone(minimal) as Record<string, unknown>;
    delete noReject["reject"];
    expect(() => parseFidelityFixture("t", noReject)).toThrow(/required, even when empty/);
  });

  it("distinguishes an ungraded field from one asserted to be NULL", () => {
    const graded = structuredClone(minimal) as Record<string, unknown>;
    (graded["gold"] as Record<string, unknown>[])[0]!["expect"] = { valid_from: null };
    const parsed = parseFidelityFixture("t", graded);
    expect(parsed.gold[0]!.expect).toEqual({ valid_from: null });
    // Absent means "not graded"; null means "must land with no anchor".
    expect(parseFidelityFixture("t", structuredClone(minimal)).gold[0]!.expect).toBeUndefined();
  });
});

// -- The corpus itself -----------------------------------------------------

describe("fidelity corpus", () => {
  it("ships the cases the family exists to cover", () => {
    expect(fixtures.map((f) => f.name)).toEqual([
      "anonymous-placeholders",
      "claude-code-owner-session",
      "distortion-traps",
      "drop-required",
      "plain-transcript",
    ]);
  });

  it("carries at least one claim the pipeline is required to discard", () => {
    // The corpus-level invariant, restated as a test: without it,
    // "persist every claim the model emitted" scores a perfect recall.
    expect(fixtures.reduce((n, f) => n + f.reject.length, 0)).toBe(5);
  });

  it("pins today's corpus scores", () => {
    expect(run.scores).toEqual({
      goldTotal: 15,
      ledgerRows: 12,
      rejectTotal: 5,
      matchedGold: 12,
      justifiedRows: 11,
      // 11 of 12 rows are accounted for by a label. The twelfth is the
      // `someone-unheard-of` row drop-required plants on purpose.
      fidelityPrecision: 0.9167,
      // 12 of 15 labelled claims land. The three that do not are
      // anonymous-placeholders', dropped by design.
      fidelityRecall: 0.8,
      dropCompliance: 1,
      // 1 of the 12 landed claims landed altered — see the distortion pin below.
      distortionRate: 0.0833,
    });
  });

  it("pins per-fixture scores so a regression names its own fixture", () => {
    const actual = Object.fromEntries(
      run.runs.map((r) => [
        r.fixture,
        [
          r.scores.fidelityPrecision,
          r.scores.fidelityRecall,
          r.scores.dropCompliance,
          r.scores.distortionRate,
        ],
      ]),
    );
    expect(actual).toEqual({
      // `null`, not 0 or 1: nothing landed, so precision has no denominator,
      // and this fixture declares nothing to drop. A passing grade for an exam
      // nobody sat is exactly what these nulls refuse to report.
      "anonymous-placeholders": [null, 0, null, null],
      "claude-code-owner-session": [1, 1, 1, 0],
      "distortion-traps": [1, 1, null, 0.3333],
      "drop-required": [0.75, 1, 1, 0],
      "plain-transcript": [1, 1, null, 0],
    });
  });

  it("prints one grep-able line", () => {
    expect(
      formatScoreboard({
        corpus: "shipped",
        mode: "stub",
        spendUsd: run.spentUsd,
        families: [fidelityFamilyReport(run)],
      }),
    ).toBe(
      "bench (corpus: shipped, mode: stub, spend: $0.0000)\n" +
        "fidelity    gold=15 written=12 P=91.7% R=80.0% drop=100.0% distortion=8.3%",
    );
  });
});

// -- The pins that are below their ceiling, and why ------------------------

describe("known losses", () => {
  it("pins fidelityRecall at 0 for a transcript with no named speaker", () => {
    const r = runFor("anonymous-placeholders");
    expect(r.scores.fidelityRecall).toBe(0);
    expect(r.rows).toEqual([]);
    // The guard against a degenerate zero: the claims must have REACHED the
    // write path and been dropped there. `factsSkipped` is the proof — a stub
    // that returned nothing, or a parser that read nothing, would leave it at 0
    // and this fixture would score the same 0 recall while measuring nothing.
    expect(r.report.factsSkipped).toBe(3);
    expect(r.report.factsWritten).toBe(0);
  });

  it("pins distortionRate at the restatement's rewrite of what was claimed", () => {
    // KNOWN DIFFERENCE, NOT A DEFECT — pinned the way the push corpus pins its
    // two blind spots. The restatement collapse (facts.ts:456) finds the claim
    // already on file and refreshClaim (facts.ts:640) COALESCEs the repeat's
    // valid_from and confidence over the original's. A claim first made on the
    // 16th and repeated on the 18th ends up dated to the 18th at the repeat's
    // lower confidence: present, matchable, and no longer accurate about when
    // it was made. Both halves are correct on their own; the pin records what
    // they do together. If this is ever changed, move the pin.
    const r = runFor("distortion-traps");
    expect(r.scores.distortionRate).toBe(0.3333);
    const g0 = r.gold.find((o) => o.gold.id === "g0")!;
    expect(g0.row).not.toBeNull();
    expect(g0.distortions).toEqual([
      { field: "valid_from", expected: "2026-08-16", actual: "2026-08-18" },
      { field: "confidence", expected: 0.9, actual: 0.55 },
    ]);
    // The other two land exactly as claimed, so the rate is a real fraction
    // rather than a fixture that distorts everything.
    expect(r.gold.filter((o) => o.distortions.length === 0).map((o) => o.gold.id)).toEqual([
      "g1",
      "g2",
    ]);
  });

  it("pins the precision cost of an entity the brain has never heard of", () => {
    const r = runFor("drop-required");
    expect(r.scores.fidelityPrecision).toBe(0.75);
    // Not a reject: the resolver degrades to the slugify floor and WRITES it
    // (facts-extract.ts:517). Grading it as a drop would encode a gate that
    // does not exist; grading it as precision says what actually happened.
    const junk = r.rows.filter((row) => row.entity_slug === "someone-unheard-of");
    expect(junk.map((row) => row.fact)).toEqual(["The renewal now lands in a later quarter."]);
  });
});

// -- The stub replaces the model, not the pipeline -------------------------

describe("the parser is in the loop", () => {
  it("moves fidelityRecall when a stub response is corrupted", async () => {
    // If the harness compared the fixture's own gold to the fixture's own stub,
    // nothing here could change the score. Corrupting the JSON body means
    // `parseFactsResponse` returns `malformed` and that turn contributes
    // nothing — which only shows up if the real parser ran.
    const before = runFor("plain-transcript");
    expect(before.scores.fidelityRecall).toBe(1);

    // Built by hand, not through the loader: the loader would (correctly)
    // refuse a fixture whose labels name claims its responses no longer emit.
    const broken: FidelityFixture = structuredClone(fixtures.find((f) => f.name === "plain-transcript")!);
    broken.stubResponses["0"] = '{"facts": [ {"fact": "Dana Reed moved the';

    const after = await runFidelityFixture(storage, broken);
    expect(after.scores.fidelityRecall).toBe(0.75);
    // Only the Northwind claim is lost. g0 and g3 survive because turn 2
    // restates them — which is itself the restatement path doing its job, and
    // a reminder that a corpus with redundant claims hides parser damage.
    expect(after.gold.filter((o) => o.row === null).map((o) => o.gold.id)).toEqual(["g1"]);
  });

  it("recovers the same turn's response and records a prompt it cannot place", async () => {
    const fixture = fixtures.find((f) => f.name === "plain-transcript")!;
    const stub = makeGoldStub(fixture);
    const first = await stub.fn({
      system: "s",
      user:
        "Observation date: 2026-08-14 (when this text was written or said; resolve relative dates against it).\n" +
        "<turn>\nDana Reed: I'm moving the Northwind renewal to October.\n</turn>",
      maxTokens: 800,
    });
    expect(first.text).toBe(fixture.stubResponses["0"]!);
    expect(first.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(stub.callsByTurn).toEqual([1, 0, 0]);

    // A prompt the stub cannot place is the signal that the extractor's prompt
    // shape moved. It is recorded rather than thrown, because the command's own
    // per-turn `catch { continue }` would swallow a throw and report the seam
    // break as a low score; `runFidelityFixture` raises it after the run.
    await stub.fn({ system: "s", user: "<turn>\nnobody said this\n</turn>", maxTokens: 800 });
    expect(stub.unmatched).toEqual(["<turn>\nnobody said this\n</turn>"]);
  });

  it("asks each turn exactly once and writes nowhere but its own source", () => {
    for (const r of run.runs) {
      // The session's last turn is nothing but a paste: never paid for.
      expect(r.stubCalls).toEqual(r.fixture === "claude-code-owner-session" ? [1, 1, 0] : [1, 1, 1]);
      // Every fact this family writes carries the fixture's source slug, so a
      // non-zero count here means a row landed somewhere the grader never
      // looked — the score would be computed over a subset of what was written.
      expect(r.rowsOutsideSource).toBe(0);
    }
  });
});

// -- The counters are not the ledger ---------------------------------------

describe("grading reads the ledger, never the run's counters", () => {
  it("keeps perfect recall while factsWritten under-reports it", () => {
    const r = runFor("plain-transcript");
    // The transcript asserts four claims; two of them are the same claim, so
    // the restatement collapse refreshes one row and increments NEITHER
    // factsWritten NOR factsSkipped (facts.ts:456). A bench that graded the
    // counter would read a 25% loss over a ledger that has lost nothing.
    expect(r.report.factsWritten).toBe(3);
    expect(r.report.factsSkipped).toBe(0);
    expect(r.scores.goldTotal).toBe(4);
    expect(r.scores.fidelityRecall).toBe(1);
    expect(r.report.factsWritten).toBeLessThan(r.scores.goldTotal);
  });
});

// -- Cost is measured, not claimed -----------------------------------------

describe("the default run is free", () => {
  it("moves the spend ledger by exactly zero", () => {
    // `sonnetFn` is injected, so `callSonnet` — and with it `trackedInvoke` and
    // the durable spend ledger — is never reached. That is the claim; this is
    // the measurement, taken across every client and every held reservation.
    expect(spendBefore).toBe(0);
    expect(spendAfter).toBe(spendBefore);
  });

  it("reports zero spend from each fixture's own BudgetTracker", () => {
    expect(run.spentUsd).toBe(0);
    for (const r of run.runs) expect(r.report.spentUsd).toBe(0);
    // A budget-exhausted run stops after turn 1 and silently reports few facts;
    // if any fixture ever hit it, the scores above would be measuring the guard.
    for (const r of run.runs) expect(r.report.budgetExhausted).toBe(false);
  });

  it("refuses to run when insert-time dedup is armed", async () => {
    // Dedup embeds every fact with a real Bedrock call unless `dedup.embed` is
    // injected (facts.ts:236), and nothing on this path injects one. Refusing
    // beats unsetting the variable: process.env is global and a bench that
    // rewrites it changes behaviour for every later test in the shard.
    const prior = process.env["MEMRAIN_FACTS_DEDUP"];
    process.env["MEMRAIN_FACTS_DEDUP"] = "1";
    try {
      await expect(runFidelityFixture(storage, fixtures[0]!)).rejects.toThrow(
        /refuses to run with MEMRAIN_FACTS_DEDUP/,
      );
    } finally {
      if (prior === undefined) delete process.env["MEMRAIN_FACTS_DEDUP"];
      else process.env["MEMRAIN_FACTS_DEDUP"] = prior;
    }
  });
});

// -- Isolation between fixtures --------------------------------------------

describe("harness", () => {
  it("empties the brain before a fixture, counted rather than compared", async () => {
    // An A/B agreement assertion stays green with the truncate stubbed out —
    // mutation testing proved that against the push corpus. `assertBrainEmpty`
    // counts every table in RESET_TABLES instead.
    const r = await runFidelityFixture(storage, fixtures.find((f) => f.name === "drop-required")!);
    expect(r.scores.ledgerRows).toBe(4);
    await expect(assertBrainEmpty(storage)).rejects.toThrow(/left rows behind/);
    // ...and the next fixture starts from nothing, which is why the ledger
    // read-back below sees only its own rows.
    const next = await runFidelityFixture(storage, fixtures.find((f) => f.name === "plain-transcript")!);
    expect(next.rowsOutsideSource).toBe(0);
    expect(next.scores.ledgerRows).toBe(3);
  });
});

// -- The scorer itself, on synthetic rows ----------------------------------
//
// The corpus pins dropCompliance=1 and two fixtures at precision=1 — exactly
// what a BROKEN scorer emits too. A pin at the value a no-op produces verifies
// nothing, so the arithmetic is exercised here on rows built to make each
// number move.

describe("scoreFidelity arithmetic", () => {
  const row = (over: Partial<FactRow>): FactRow => ({
    id: 1,
    entity_slug: "people/a",
    fact: "a claim",
    confidence: 0.9,
    source_slug: "conversations/x",
    source_chunk_id: null,
    written_by: "facts-extract",
    written_at: "2026-08-14 00:00:00+00",
    kind: "commitment",
    notability: "high",
    valid_from: "2026-08-14",
    valid_until: null,
    visibility: "private",
    superseded_by: null,
    consolidated_into: null,
    context: null,
    source_session: null,
    attributed_to: null,
    forgotten_at: null,
    ...over,
  });

  const fixture = (over: Partial<FidelityFixture>): FidelityFixture => ({
    name: "synthetic",
    description: "d",
    transcript: "x",
    sourceSlug: "conversations/x",
    stubResponses: {},
    stubModelId: "sonnet",
    gold: [],
    reject: [],
    ...over,
  });

  const gold = (over: Partial<FidelityFixture["gold"][number]> = {}) => ({
    id: "g0",
    entity_slug: "people/a",
    fact: "a claim",
    kind: "commitment" as const,
    notability: "high" as const,
    ...over,
  });

  it("refuses to credit a claim that landed on the wrong entity", () => {
    const s = scoreFidelity(fixture({ gold: [gold()] }), [row({ entity_slug: "people/b" })]);
    // Same text, different subject. A text-only match would call this a hit and
    // make the resolver untestable.
    expect(s.scores.fidelityRecall).toBe(0);
    expect(s.scores.fidelityPrecision).toBe(0);
  });

  it("counts precision against rows, not against labels", () => {
    const s = scoreFidelity(fixture({ gold: [gold()] }), [
      row({ id: 1 }),
      row({ id: 2, fact: "a claim nobody labelled" }),
    ]);
    expect(s.scores.fidelityRecall).toBe(1);
    expect(s.scores.fidelityPrecision).toBe(0.5);
  });

  it("lets one row satisfy a claim asserted twice", () => {
    const s = scoreFidelity(
      fixture({ gold: [gold({ id: "g0" }), gold({ id: "g1" })] }),
      [row({ id: 1 })],
    );
    expect(s.scores.fidelityRecall).toBe(1);
    expect(s.scores.fidelityPrecision).toBe(1);
  });

  it("fails drop compliance when a forbidden claim is in the ledger", () => {
    const s = scoreFidelity(
      fixture({
        gold: [gold()],
        reject: [
          { id: "r0", reason: "null_entity", fact: "forbidden" },
          { id: "r1", reason: "anonymous_speaker", fact: "also forbidden" },
        ],
      }),
      [row({ id: 1 }), row({ id: 2, fact: "Forbidden.", entity_slug: "whoever" })],
    );
    // The term that keeps recall honest has to be able to be non-1. Note the
    // reject match ignores the entity: a forbidden claim landing ANYWHERE is a
    // compliance failure, not a misfiling.
    expect(s.scores.dropCompliance).toBe(0.5);
    expect(s.reject.map((o) => o.complied)).toEqual([false, true]);
  });

  it("grades a declared field and ignores an undeclared one", () => {
    const declared = scoreFidelity(
      fixture({ gold: [gold({ expect: { valid_from: "2026-08-14", confidence: 0.9 } })] }),
      [row({ valid_from: "2026-08-18" })],
    );
    expect(declared.scores.distortionRate).toBe(1);
    expect(declared.gold[0]!.distortions).toEqual([
      { field: "valid_from", expected: "2026-08-14", actual: "2026-08-18" },
    ]);
    const undeclared = scoreFidelity(fixture({ gold: [gold()] }), [row({ valid_from: null })]);
    expect(undeclared.scores.distortionRate).toBe(0);
  });

  it("treats an expected NULL anchor as an assertion", () => {
    const s = scoreFidelity(
      fixture({ gold: [gold({ expect: { valid_from: null } })] }),
      [row({ valid_from: "2026-08-14" })],
    );
    expect(s.gold[0]!.distortions).toEqual([
      { field: "valid_from", expected: null, actual: "2026-08-14" },
    ]);
  });

  it("grades kind and notability without being asked", () => {
    // Both are declared on every gold fact and stored on every row, and `kind`
    // drives the decay half-life — a commitment that lands as a belief outlives
    // or predeceases what the caller wrote.
    const s = scoreFidelity(fixture({ gold: [gold()] }), [
      row({ kind: "belief", notability: "low" }),
    ]);
    expect(s.gold[0]!.distortions.map((d) => d.field)).toEqual(["kind", "notability"]);
    expect(s.scores.fidelityRecall).toBe(1);
  });

  it("reports an unmeasured rate as null, never as a passing value", () => {
    const nothing = scoreFidelity(fixture({ gold: [gold()] }), []);
    expect(nothing.scores.fidelityPrecision).toBeNull();
    expect(nothing.scores.distortionRate).toBeNull();
    expect(nothing.scores.dropCompliance).toBeNull();
    // Recall still has a denominator — the claim was labelled and did not land.
    expect(nothing.scores.fidelityRecall).toBe(0);
  });

  it("normalizes text without smoothing away a different claim", () => {
    expect(normalizeFactText("  Dana  moved   the renewal.  ")).toBe("dana moved the renewal");
    expect(normalizeFactText("Dana moved the renewal!!")).toBe("dana moved the renewal");
    // Punctuation inside the claim is content, not decoration.
    expect(normalizeFactText("Dana moved the renewal, then left")).not.toBe(
      normalizeFactText("Dana moved the renewal then left."),
    );
  });
});
