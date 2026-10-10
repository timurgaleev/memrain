/**
 * Write-back fidelity harness — drives the SHIPPED extraction pipeline with the
 * model, and only the model, replaced.
 *
 * WHERE THE STUB GOES, AND WHY IT GOES THERE. `runExtractConversationFacts`
 * (`src/commands/extract-conversation-facts.ts:75`) already takes a `sonnetFn`
 * seam, so the harness injects at exactly one point — the Bedrock call — and
 * everything else is production code: `parseConversation` splits the turns,
 * `sanitizeForPrompt` fences them, `parseFactsResponse` reads the model text,
 * the anonymous-speaker gate nulls placeholder entities, `makeSlugResolver`
 * canonicalizes what is left, and `addFact` writes the ledger. A harness that
 * reimplemented any of that would grade its own copy and prove nothing, which
 * is why the stub returns RAW TEXT rather than parsed facts.
 *
 * The stub maps a prompt back to its turn by RECONSTRUCTING the prompt the
 * extractor builds (`facts-extract.ts:364-370`) for each parsed message and
 * using it as a lookup key. That is a mirror, not a reimplementation: if the
 * prompt shape ever changes, no key matches, and `runFidelityFixture` throws
 * instead of quietly reporting a low score. A seam that breaks silently is
 * worse than one that breaks loudly, and a swallowed model error is exactly
 * what the caller's per-turn `catch { continue }` (`:131-134`) would do with it.
 *
 * WHAT IS GRADED: ledger rows, never the run's counters. `factsWritten` counts
 * inserts, and a restatement collapse (`facts.ts:456`) increments neither
 * `written` nor `skipped` — a corpus that repeats a claim under-reports
 * `factsWritten` while the ledger is perfectly correct. So the score comes from
 * `listFacts`, read back through the shipped path with decay OFF: a grader
 * whose result moves with the wall clock is not a ratchet.
 *
 * WHAT A GREEN RUN DOES NOT TELL YOU: that the extractor is good. The model is
 * a fixture. These numbers grade what the pipeline does with a KNOWN model
 * answer — the parser, the gates, the resolver and the ledger. Whether a real
 * Sonnet call would have produced that answer is a different measurement, and
 * this family deliberately does not make it.
 */

import type { Storage } from "../storage.ts";
import {
  listFacts,
  factsDedupEnabled,
  factsDedupLlmEnabled,
  type FactRow,
} from "../facts.ts";
import { parseConversation } from "../conversation-parser.ts";
import { sanitizeForPrompt } from "../llm/sanitize.ts";
import { observationDateLine } from "../llm/date-grounding.ts";
import { stripPastedContent } from "../transcripts/pasted-content.ts";
import type { SonnetFn } from "../llm/sonnet.ts";
import {
  runExtractConversationFacts,
  type ExtractConvFactsReport,
} from "../../commands/extract-conversation-facts.ts";
import type { PushFixture } from "./fixtures.ts";
import { seedFixture } from "./harness.ts";
import { resetBrain, resetProcessGlobals, assertBrainEmpty } from "./reset.ts";
import type { FidelityFamilyReport } from "./scoreboard.ts";
import type { FidelityFixture, GoldExpect, GoldFact, RejectFact } from "./fidelity-fixtures.ts";

/** Char cap the extractor sanitizes a turn to before fencing it. */
const TURN_SANITIZE_CHARS = 12_000;

/** Row cap for the ledger read-back. Far above any fixture's write count. */
const LEDGER_READ_LIMIT = 1000;

/** Tolerance for the `confidence` comparison — the column is `real`. */
const CONFIDENCE_EPSILON = 1e-6;

/** The injectable model, plus what it saw. */
export interface GoldStub {
  /** Hand this to `runExtractConversationFacts` as `sonnetFn`. */
  fn: SonnetFn;
  /** How many times each turn index was asked. Exactly one each, or the
   *  budget guard stopped the run short / a truncation retry fired. */
  callsByTurn: number[];
  /** Prompts that matched no turn. Non-empty means the seam moved. */
  unmatched: string[];
}

/**
 * Build the model stub for a fixture.
 *
 * Keyed on the exact `user` string the extractor assembles, so a change to the
 * prompt shape shows up as an unmatched prompt rather than as a fidelity
 * regression. Repeated identical turns map to successive indices; a call past
 * the last one reuses it (the only caller that repeats a prompt is the
 * truncation retry, which this stub never triggers — it never reports
 * `max_tokens`).
 */
export function makeGoldStub(fixture: FidelityFixture): GoldStub {
  const messages = parseConversation(fixture.transcript, {
    ...(fixture.dateContext ? { dateContext: fixture.dateContext } : {}),
  });
  const byPrompt = new Map<string, number[]>();
  messages.forEach((m, i) => {
    const turn = `${m.speaker}: ${m.text}`.trim();
    const { text: clean } = sanitizeForPrompt(stripPastedContent(turn).text, TURN_SANITIZE_CHARS);
    // The command anchors each turn at its own day; an epoch-anchored parse
    // (a time-only format with no dateContext) carries no real date.
    const day = /^\d{4}-\d{2}-\d{2}/.test(m.timestamp) && !m.timestamp.startsWith("1970-")
      ? m.timestamp.slice(0, 10)
      : null;
    const key = `${observationDateLine(day)}\n<turn>\n${clean}\n</turn>`;
    const bucket = byPrompt.get(key);
    if (bucket) bucket.push(i);
    else byPrompt.set(key, [i]);
  });

  const callsByTurn = Array.from<number>({ length: messages.length }).fill(0);
  const unmatched: string[] = [];
  const seen = new Map<string, number>();

  const fn: SonnetFn = async (input) => {
    const bucket = byPrompt.get(input.user);
    if (!bucket) {
      unmatched.push(input.user);
      return {
        text: '{"facts":[]}',
        modelId: fixture.stubModelId,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
    const nth = seen.get(input.user) ?? 0;
    seen.set(input.user, nth + 1);
    const index = bucket[Math.min(nth, bucket.length - 1)]!;
    callsByTurn[index] = (callsByTurn[index] ?? 0) + 1;
    return {
      // Zero usage is what makes the family free: `costUsd` prices tokens, so
      // the BudgetTracker records $0 and never reaches the spend ledger.
      text: fixture.stubResponses[String(index)] ?? '{"facts":[]}',
      modelId: fixture.stubModelId,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  };

  return { fn, callsByTurn, unmatched };
}

/**
 * Text-only claim matching: lowercase, collapse whitespace, drop trailing
 * punctuation. Deliberately not embedding-based — the grader must not need a
 * model to decide whether a claim survived, or the bench acquires the very
 * dependency it exists to measure without.
 */
export function normalizeFactText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    // The `(?<!…)` guard is what keeps this linear, and it is the same shape
    // that measured 20 s on a 200 K run elsewhere in this repo: unguarded,
    // `[…]+$` restarts inside the punctuation run at every offset and walks to
    // the end each time. The guard admits only a run's first character, so the
    // total walk is the sum of the run lengths. Same language — a greedy
    // `[…]+$` only ever matched the maximal trailing run.
    .replace(/(?<![.,;:!?…])[.,;:!?…]+$/u, "")
    .trim();
}

/** One graded field on a gold fact that landed altered. */
export interface FieldDistortion {
  field: keyof GoldExpect | "kind" | "notability";
  expected: string | number | null;
  actual: string | number | null;
}

/** How one gold claim fared. */
export interface GoldOutcome {
  gold: GoldFact;
  /** The ledger row it matched, or null when nothing did. */
  row: FactRow | null;
  /** Empty when it landed exactly as claimed. */
  distortions: FieldDistortion[];
}

/** How one rejected claim fared. */
export interface RejectOutcome {
  reject: RejectFact;
  /** True when the pipeline kept it out of the ledger, as required. */
  complied: boolean;
}

export interface FidelityScores {
  goldTotal: number;
  ledgerRows: number;
  rejectTotal: number;
  /** Gold claims with a matching ledger row — the recall numerator. */
  matchedGold: number;
  /** Ledger rows some gold claim accounts for — the precision numerator. */
  justifiedRows: number;
  fidelityPrecision: number | null;
  fidelityRecall: number | null;
  dropCompliance: number | null;
  /** Of the gold claims that landed, the fraction that landed altered. */
  distortionRate: number | null;
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function fieldsOf(gold: GoldFact, row: FactRow): FieldDistortion[] {
  const out: FieldDistortion[] = [];
  const push = (
    field: FieldDistortion["field"],
    expected: string | number | null,
    actual: string | number | null,
  ) => {
    out.push({ field, expected, actual });
  };
  // `kind` and `notability` are declared on every gold fact and stored on every
  // row, so they are graded unconditionally: `kind` drives the decay half-life
  // (`facts-decay.ts`), and a commitment that lands as a belief outlives or
  // predeceases what the caller wrote.
  if (row.kind !== gold.kind) push("kind", gold.kind, row.kind);
  if (row.notability !== gold.notability) push("notability", gold.notability, row.notability);

  const e = gold.expect;
  if (!e) return out;
  if ("valid_from" in e) {
    const want = e.valid_from ?? null;
    const got = row.valid_from ?? null;
    if (want !== got) push("valid_from", want, got);
  }
  if (e.confidence !== undefined && Math.abs(row.confidence - e.confidence) > CONFIDENCE_EPSILON) {
    push("confidence", e.confidence, row.confidence);
  }
  if (e.source_slug !== undefined && row.source_slug !== e.source_slug) {
    push("source_slug", e.source_slug, row.source_slug);
  }
  if (e.written_by !== undefined && row.written_by !== e.written_by) {
    push("written_by", e.written_by, row.written_by);
  }
  if (e.visibility !== undefined && row.visibility !== e.visibility) {
    push("visibility", e.visibility, row.visibility);
  }
  if ("attributed_to" in e) {
    const want = e.attributed_to ?? null;
    const got = row.attributed_to ?? null;
    if (want !== got) push("attributed_to", want, got);
  }
  return out;
}

/**
 * Grade a fixture's ledger against its labels.
 *
 * A row matches a gold claim when the normalized text AND the entity slug
 * agree. Entity equality is not a nicety: a claim that landed on an invented
 * entity is a distinct failure from one that landed correctly, and crediting it
 * would make the resolver untestable. Several gold claims may match one row —
 * a transcript that asserts the same thing twice is preserved by the single row
 * the restatement collapse keeps.
 *
 * Every rate is `null` over an empty denominator, never 0: "100% drop
 * compliance" for a fixture with nothing to drop reads as a pass for an exam
 * nobody sat.
 */
export function scoreFidelity(
  fixture: FidelityFixture,
  rows: readonly FactRow[],
): { scores: FidelityScores; gold: GoldOutcome[]; reject: RejectOutcome[] } {
  const normRows = rows.map((r) => ({ row: r, norm: normalizeFactText(r.fact) }));

  const goldOutcomes: GoldOutcome[] = fixture.gold.map((g) => {
    const want = normalizeFactText(g.fact);
    const hit = normRows.find((r) => r.norm === want && r.row.entity_slug === g.entity_slug);
    return {
      gold: g,
      row: hit?.row ?? null,
      distortions: hit ? fieldsOf(g, hit.row) : [],
    };
  });

  const justified = normRows.filter(({ row, norm }) =>
    fixture.gold.some((g) => normalizeFactText(g.fact) === norm && g.entity_slug === row.entity_slug),
  ).length;

  const rejectOutcomes: RejectOutcome[] = fixture.reject.map((j) => {
    const want = normalizeFactText(j.fact);
    return { reject: j, complied: !normRows.some((r) => r.norm === want) };
  });

  const matched = goldOutcomes.filter((o) => o.row !== null);
  const distorted = matched.filter((o) => o.distortions.length > 0).length;

  return {
    scores: {
      goldTotal: fixture.gold.length,
      ledgerRows: rows.length,
      rejectTotal: fixture.reject.length,
      matchedGold: matched.length,
      justifiedRows: justified,
      fidelityPrecision: rows.length === 0 ? null : round(justified / rows.length),
      fidelityRecall: fixture.gold.length === 0 ? null : round(matched.length / fixture.gold.length),
      dropCompliance:
        fixture.reject.length === 0
          ? null
          : round(rejectOutcomes.filter((o) => o.complied).length / fixture.reject.length),
      distortionRate: matched.length === 0 ? null : round(distorted / matched.length),
    },
    gold: goldOutcomes,
    reject: rejectOutcomes,
  };
}

export interface FidelityFixtureRun {
  fixture: string;
  description: string;
  /** What the shipped command reported — kept for the counter-vs-ledger check. */
  report: ExtractConvFactsReport;
  /** The ledger rows this fixture's run wrote, by its own source slug. */
  rows: FactRow[];
  /** Rows anywhere else in `entity_facts` — should always be 0. */
  rowsOutsideSource: number;
  stubCalls: number[];
  scores: FidelityScores;
  gold: GoldOutcome[];
  reject: RejectOutcome[];
}

export interface FidelityCorpusRun {
  runs: FidelityFixtureRun[];
  /** Micro-averaged over every gold claim / ledger row in the corpus. */
  scores: FidelityScores;
  /** Summed from each run's own BudgetTracker. Zero, or the stub was bypassed. */
  spentUsd: number;
}

/**
 * Refuse to run when a paid side path is armed.
 *
 * `writeExtractedFacts` passes no `dedup`, so `MEMRAIN_FACTS_DEDUP` alone turns
 * on `resolveDedup`'s default embedder (`facts.ts:236`) — a real Titan call per
 * fact, billed. Unsetting it here would be worse than refusing: `process.env`
 * is process-global, and a bench that quietly rewrites it changes behaviour for
 * every later test in the shard.
 */
function refuseIfPaidPathsArmed(): void {
  const armed: string[] = [];
  if (factsDedupEnabled()) armed.push("MEMRAIN_FACTS_DEDUP");
  if (factsDedupLlmEnabled()) armed.push("MEMRAIN_FACTS_DEDUP_LLM");
  if (armed.length > 0) {
    throw new Error(
      `fidelity bench refuses to run with ${armed.join(", ")} set: insert-time dedup ` +
        "embeds every fact with a real Bedrock call, and this family is free by design",
    );
  }
}

/**
 * Replay one fixture: empty the brain, seed its pages, run the shipped
 * extraction command against the stub, read the ledger back and grade it.
 */
export async function runFidelityFixture(
  storage: Storage,
  fixture: FidelityFixture,
): Promise<FidelityFixtureRun> {
  refuseIfPaidPathsArmed();

  await resetBrain(storage);
  await resetProcessGlobals(storage.engine());
  await assertBrainEmpty(storage);

  if (fixture.pages?.length) {
    // `seedFixture` reads `pages` and `name` and nothing else; a turn-less push
    // fixture reuses the shipped seed path (registerSource + putPage) instead
    // of forking a second one that could drift from it.
    const seed: PushFixture = {
      name: fixture.name,
      description: fixture.description,
      pages: fixture.pages,
      turns: [],
    };
    await seedFixture(storage, seed);
  }

  const stub = makeGoldStub(fixture);
  const report = await runExtractConversationFacts(storage, {
    text: fixture.transcript,
    sourceSlug: fixture.sourceSlug,
    ...(fixture.dateContext ? { dateContext: fixture.dateContext } : {}),
    ...(fixture.ownerEntity ? { ownerEntity: fixture.ownerEntity } : {}),
    sonnetFn: stub.fn,
    modelId: fixture.stubModelId,
  });

  if (stub.unmatched.length > 0) {
    throw new Error(
      `fidelity fixture ${fixture.name}: the stub matched no turn for ` +
        `${stub.unmatched.length} prompt(s) — the extractor's prompt shape moved, so this ` +
        `run's scores mean nothing. First: ${JSON.stringify(stub.unmatched[0])}`,
    );
  }
  if (!report.ran) {
    throw new Error(`fidelity fixture ${fixture.name}: extraction did not run — ${report.reason}`);
  }

  // The ledger, read back through the shipped path. `decay: false` because a
  // decay-ranked view drops rows by wall-clock age, and a bench whose score
  // moves with the calendar is not a ratchet. Entity-less + source-scoped, so a
  // claim that landed on the WRONG entity is visible rather than invisible.
  const rows = await listFacts(storage, null, {
    source_slug: fixture.sourceSlug,
    decay: false,
    limit: LEDGER_READ_LIMIT,
    order: "recency",
  });
  const total = await storage
    .engine()
    .query<{ n: number }>(`SELECT count(*)::int AS n FROM entity_facts`);
  const rowsOutsideSource = Number(total.rows[0]?.n ?? 0) - rows.length;

  const graded = scoreFidelity(fixture, rows);
  return {
    fixture: fixture.name,
    description: fixture.description,
    report,
    rows,
    rowsOutsideSource,
    stubCalls: stub.callsByTurn,
    scores: graded.scores,
    gold: graded.gold,
    reject: graded.reject,
  };
}

/** Replay a whole corpus on one Storage, in the order given. */
export async function runFidelityCorpus(
  storage: Storage,
  fixtures: readonly FidelityFixture[],
): Promise<FidelityCorpusRun> {
  const runs: FidelityFixtureRun[] = [];
  for (const f of fixtures) runs.push(await runFidelityFixture(storage, f));

  // Micro-averaged, matching the push family: a fixture with four gold claims
  // weighs four times one with a single claim, because that is what a caller
  // trusting the ledger actually pays.
  let goldTotal = 0;
  let ledgerRows = 0;
  let rejectTotal = 0;
  let matched = 0;
  let justified = 0;
  let complied = 0;
  let distorted = 0;
  // Counters are summed and the rates recomputed from them. Averaging the
  // per-fixture rates instead would weigh a one-claim fixture the same as a
  // four-claim one, and the corpus is deliberately lopsided.
  for (const r of runs) {
    goldTotal += r.scores.goldTotal;
    ledgerRows += r.scores.ledgerRows;
    rejectTotal += r.scores.rejectTotal;
    matched += r.scores.matchedGold;
    justified += r.scores.justifiedRows;
    complied += r.reject.filter((o) => o.complied).length;
    distorted += r.gold.filter((o) => o.row !== null && o.distortions.length > 0).length;
  }

  return {
    runs,
    scores: {
      goldTotal,
      ledgerRows,
      rejectTotal,
      matchedGold: matched,
      justifiedRows: justified,
      fidelityPrecision: ledgerRows === 0 ? null : round(justified / ledgerRows),
      fidelityRecall: goldTotal === 0 ? null : round(matched / goldTotal),
      dropCompliance: rejectTotal === 0 ? null : round(complied / rejectTotal),
      distortionRate: matched === 0 ? null : round(distorted / matched),
    },
    spentUsd: runs.reduce((n, r) => n + r.report.spentUsd, 0),
  };
}

/** Reduce a corpus run to the shape the scoreboard prints. */
export function fidelityFamilyReport(run: FidelityCorpusRun): FidelityFamilyReport {
  return {
    family: "fidelity",
    goldTotal: run.scores.goldTotal,
    ledgerRows: run.scores.ledgerRows,
    rejectTotal: run.scores.rejectTotal,
    fidelityPrecision: run.scores.fidelityPrecision,
    fidelityRecall: run.scores.fidelityRecall,
    dropCompliance: run.scores.dropCompliance,
    distortionRate: run.scores.distortionRate,
  };
}
