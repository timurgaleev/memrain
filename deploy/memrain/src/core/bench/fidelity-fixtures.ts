/**
 * Write-back fidelity fixtures — the labelled corpus behind "does the
 * conversation→memory pipeline preserve the facts it claims to?".
 *
 * A fixture is a miniature brain, a transcript, and the RAW MODEL TEXT the
 * extractor would have received for each turn. That last part is the whole
 * design: the stub replaces the MODEL, never the PIPELINE. Everything
 * downstream of the model — `parseFactsResponse`, the anonymous-speaker gate
 * (`facts-extract.ts:233`), the 500-char claim cap (`:221`), the 10-facts-per-
 * turn cap (`:210`), `makeSlugResolver` (`:516`) and `addFact` — runs for real.
 * A fixture that handed the harness `ExtractedFact[]` would be grading itself.
 *
 * Two label sets, and they answer different questions:
 *
 *   gold    claims the pipeline MUST end up holding, with the fields whose
 *           preservation is graded (`expect`).
 *   reject  claims the pipeline MUST discard. Without them "persist every
 *           claim the model emitted" scores a perfect recall.
 *
 * The loader is strict for the same reason `fixtures.ts` is: a corpus is
 * hand-maintained JSON and the failure that matters is silent. `"glod"` parses
 * fine and turns a graded claim into an ungraded one. Unknown keys are
 * rejected, every required label must be present, and four invariants below
 * exist because each of them, once violated, produces a fixture that scores
 * well while measuring nothing.
 *
 * What this file does NOT tell you: whether the labels are RIGHT. It enforces
 * that a fixture is well-formed and internally consistent with the model text
 * it ships; whether a claim is worth preserving is a human's judgement, and a
 * wrong-but-well-formed label is invisible here.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_PAGE_TYPES } from "../pages.ts";
import { validateSlug } from "../links.ts";
import { parseConversation } from "../conversation-parser.ts";
import { FACT_KINDS, type FactKind } from "../facts-extract.ts";
import { FixtureError, type FixturePage } from "./fixtures.ts";

/** Directory holding the shipped fidelity corpus (`*.json`, one per file). */
export const FIDELITY_CORPUS_DIR = join(import.meta.dir, "corpus-fidelity");

export type FactNotability = "high" | "medium" | "low";

/**
 * Fields graded for DISTORTION — "it landed, but not as claimed".
 *
 * Omit a field to leave it ungraded. `valid_from: null` is an assertion that
 * the row carries NO validity anchor, not an omission; the two must never look
 * the same, so `null` is meaningful and absence is not.
 */
export interface GoldExpect {
  /** `YYYY-MM-DD`, or null for "must land with no anchor at all". */
  valid_from?: string | null;
  confidence?: number;
  source_slug?: string;
  written_by?: string;
  /** `addFact`'s mig085 default is 'private'; the CLI path passes none. */
  visibility?: string;
  /** Who asserted it (mig130), or null for "must land with no speaker". */
  attributed_to?: string | null;
}

/** A claim the pipeline must end up holding. */
export interface GoldFact {
  /** Fixture-local handle. Appears in reports so a failure names itself. */
  id: string;
  /** The entity whose ledger the claim belongs on. */
  entity_slug: string;
  fact: string;
  /** Graded: `kind` drives decay half-life, so landing as the wrong kind is
   *  a real loss even when the text survives intact. */
  kind: FactKind;
  notability: FactNotability;
  expect?: GoldExpect;
}

/**
 * Why the pipeline must drop a claim. Each name maps to a gate that the
 * SHIPPED default path actually enforces — verified, not assumed:
 *
 *   anonymous_speaker    the model echoed a diarizer placeholder ("Speaker A",
 *                        "Participant 2") back as the entity; the parser nulls
 *                        it (`facts-extract.ts:233`) and the write path then
 *                        drops the whole fact (`:508`).
 *   null_entity          the model emitted `"entity": null` outright — same
 *                        drop, different cause, and worth telling apart.
 *   unresolvable_entity  the entity name carries no slug-alphabet character at
 *                        all (a lone em dash, punctuation), so the canonical
 *                        cascade falls to the slugify floor and `slugifyEntity`
 *                        returns null (`:521`).
 *   junk_filter          the claim is assistant narration or a provider error
 *                        string; `parseFactsResponse`'s junk gate drops it
 *                        (`isJunkFact`, on unless MEMRAIN_FACTS_JUNK_FILTER=0).
 *   pasted_content       the claim came from a turn that is nothing but a
 *                        `<pasted_content>` block; the command never asks the
 *                        model about it (`isPasteOnly`).
 *
 * TWO REASONS THE SPEC LISTED ARE DELIBERATELY ABSENT, because naming a gate
 * that does not fire would let a corpus author encode a drop that never
 * happens and read the resulting failure as a pipeline defect:
 *
 *   below_notability     `writeExtractedFacts`' notability filter defaults to
 *                        `'all'` (`facts-extract.ts:496`) and no caller on this
 *                        path overrides it. A low-notability claim is WRITTEN.
 *   over_length          the 500-char cap TRUNCATES the claim (`:221`); it does
 *                        not discard it. A truncated row fails the text match
 *                        and shows up as a recall loss, which is the honest
 *                        place for it.
 *
 * A claim that lands on an invented entity (the model names someone the brain
 * has never heard of) is likewise NOT a reject: the shipped resolver degrades
 * to the slugify floor and writes it. That is a PRECISION failure, and
 * `fidelityPrecision` is the term that reports it.
 */
export type RejectReason =
  | "anonymous_speaker"
  | "null_entity"
  | "unresolvable_entity"
  | "junk_filter"
  | "pasted_content";

export const REJECT_REASONS: readonly RejectReason[] = [
  "anonymous_speaker",
  "null_entity",
  "unresolvable_entity",
  "junk_filter",
  "pasted_content",
];

/** A claim the pipeline must NOT end up holding. */
export interface RejectFact {
  id: string;
  reason: RejectReason;
  /** If this text appears in the ledger, drop compliance fails. */
  fact: string;
}

export interface FidelityFixture {
  /** Corpus-unique identifier; must equal the file's basename. */
  name: string;
  description: string;
  /** Free-text rationale. Ignored by the harness. */
  note?: string;
  /** Seeded pages, so the slug resolver has something real to resolve into. */
  pages?: FixturePage[];
  /** The raw conversation handed to `parseConversation`. */
  transcript: string;
  /** Fallback `YYYY-MM-DD` for time-only transcript formats. */
  dateContext?: string;
  /** Provenance slug stamped on every fact this fixture's run writes. */
  sourceSlug: string;
  /**
   * The brain owner's entity for this run, as MEMRAIN_OWNER_ENTITY would set
   * it. Passed through the command's option, never the process environment.
   */
  ownerEntity?: string;
  /**
   * RAW MODEL OUTPUT keyed by turn index — a string, never a parsed fact list.
   * An index with no entry gets `{"facts":[]}`. See the module header.
   */
  stubResponses: Record<string, string>;
  /**
   * Model id the stub reports. Must substring-match opus|sonnet|haiku, or
   * `BudgetTracker.record` throws `no_pricing`, the run stops after turn 1, and
   * the fixture reports a low score with no model error anywhere in sight
   * (`budget.ts:50,138`; `extract-conversation-facts.ts:138-145`).
   */
  stubModelId: string;
  gold: GoldFact[];
  /** May be empty per fixture; the CORPUS must carry at least one. */
  reject: RejectFact[];
}

const FIXTURE_KEYS = new Set([
  "name",
  "description",
  "note",
  "pages",
  "transcript",
  "dateContext",
  "sourceSlug",
  "ownerEntity",
  "stubResponses",
  "stubModelId",
  "gold",
  "reject",
]);
const PAGE_KEYS = new Set(["slug", "type", "title", "body", "aliases", "source"]);
const GOLD_KEYS = new Set(["id", "entity_slug", "fact", "kind", "notability", "expect"]);
const EXPECT_KEYS = new Set([
  "valid_from",
  "confidence",
  "source_slug",
  "written_by",
  "visibility",
  "attributed_to",
]);
const ATTRIBUTIONS = ["user", "assistant", "other"];
const REJECT_KEYS = new Set(["id", "reason", "fact"]);
const NOTABILITIES: readonly FactNotability[] = ["high", "medium", "low"];

/** Model families the spend ledger can price. Anything else silently stops a run. */
const PRICED_MODEL_FAMILIES = /opus|sonnet|haiku/i;

function fail(where: string, detail: string): never {
  throw new FixtureError(where, detail);
}

function asObject(where: string, v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    fail(where, `expected an object, got ${Array.isArray(v) ? "an array" : typeof v}`);
  }
  return v as Record<string, unknown>;
}

function rejectUnknownKeys(
  where: string,
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      fail(where, `unknown key ${JSON.stringify(k)} (allowed: ${[...allowed].sort().join(", ")})`);
    }
  }
}

function requireString(where: string, obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    fail(`${where}.${key}`, `expected a non-empty string, got ${JSON.stringify(v)}`);
  }
  return v;
}

function optionalStringArray(
  where: string,
  obj: Record<string, unknown>,
  key: string,
): string[] | undefined {
  if (!(key in obj)) return undefined;
  const v = obj[key];
  if (!Array.isArray(v)) fail(`${where}.${key}`, `expected an array, got ${JSON.stringify(v)}`);
  return v.map((item, i) => {
    if (typeof item !== "string" || item.trim() === "") {
      fail(`${where}.${key}[${i}]`, `expected a non-empty string, got ${JSON.stringify(item)}`);
    }
    return item;
  });
}

function requireSlug(where: string, obj: Record<string, unknown>, key: string): string {
  const v = requireString(where, obj, key);
  try {
    validateSlug(v);
  } catch (e) {
    fail(`${where}.${key}`, (e as Error).message);
  }
  return v;
}

function parsePage(where: string, raw: unknown): FixturePage {
  const obj = asObject(where, raw);
  rejectUnknownKeys(where, obj, PAGE_KEYS);
  const type = requireString(where, obj, "type");
  if (!(KNOWN_PAGE_TYPES as readonly string[]).includes(type)) {
    fail(
      `${where}.type`,
      `${JSON.stringify(type)} is not a known page type (${KNOWN_PAGE_TYPES.join(", ")})`,
    );
  }
  const page: FixturePage = {
    slug: requireSlug(where, obj, "slug"),
    type,
    title: requireString(where, obj, "title"),
    body: requireString(where, obj, "body"),
  };
  const aliases = optionalStringArray(where, obj, "aliases");
  if (aliases) page.aliases = aliases;
  if ("source" in obj) page.source = requireString(where, obj, "source");
  return page;
}

function parseExpect(where: string, raw: unknown): GoldExpect {
  const obj = asObject(where, raw);
  rejectUnknownKeys(where, obj, EXPECT_KEYS);
  const out: GoldExpect = {};
  if ("valid_from" in obj) {
    const v = obj["valid_from"];
    // null is an ASSERTION ("no anchor at all"), so it is accepted here and
    // absence is not — see GoldExpect.
    if (v !== null && (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v))) {
      fail(`${where}.valid_from`, `expected "YYYY-MM-DD" or null, got ${JSON.stringify(v)}`);
    }
    out.valid_from = v as string | null;
  }
  if ("confidence" in obj) {
    const v = obj["confidence"];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      fail(`${where}.confidence`, `expected a number in [0, 1], got ${JSON.stringify(v)}`);
    }
    out.confidence = v;
  }
  if ("source_slug" in obj) out.source_slug = requireSlug(where, obj, "source_slug");
  if ("written_by" in obj) out.written_by = requireString(where, obj, "written_by");
  if ("visibility" in obj) out.visibility = requireString(where, obj, "visibility");
  if ("attributed_to" in obj) {
    const v = obj["attributed_to"];
    if (v !== null && (typeof v !== "string" || !ATTRIBUTIONS.includes(v))) {
      fail(`${where}.attributed_to`, `expected one of ${ATTRIBUTIONS.join(", ")} or null, got ${JSON.stringify(v)}`);
    }
    out.attributed_to = v as string | null;
  }
  return out;
}

function parseGold(where: string, raw: unknown): GoldFact {
  const obj = asObject(where, raw);
  rejectUnknownKeys(where, obj, GOLD_KEYS);
  const kind = requireString(where, obj, "kind");
  if (!(FACT_KINDS as readonly string[]).includes(kind)) {
    fail(`${where}.kind`, `${JSON.stringify(kind)} is not a fact kind (${FACT_KINDS.join(", ")})`);
  }
  const notability = requireString(where, obj, "notability");
  if (!(NOTABILITIES as readonly string[]).includes(notability)) {
    fail(
      `${where}.notability`,
      `${JSON.stringify(notability)} is not one of ${NOTABILITIES.join(", ")}`,
    );
  }
  const gold: GoldFact = {
    id: requireString(where, obj, "id"),
    entity_slug: requireSlug(where, obj, "entity_slug"),
    fact: requireString(where, obj, "fact"),
    kind: kind as FactKind,
    notability: notability as FactNotability,
  };
  if ("expect" in obj) gold.expect = parseExpect(`${where}.expect`, obj["expect"]);
  return gold;
}

function parseReject(where: string, raw: unknown): RejectFact {
  const obj = asObject(where, raw);
  rejectUnknownKeys(where, obj, REJECT_KEYS);
  const reason = requireString(where, obj, "reason");
  if (!(REJECT_REASONS as readonly string[]).includes(reason)) {
    fail(
      `${where}.reason`,
      `${JSON.stringify(reason)} names no gate the shipped pipeline enforces ` +
        `(${REJECT_REASONS.join(", ")}) — see RejectReason for the two the spec ` +
        `listed and this loader refuses`,
    );
  }
  return {
    id: requireString(where, obj, "id"),
    reason: reason as RejectReason,
    fact: requireString(where, obj, "fact"),
  };
}

/** The escaped form a claim takes inside a raw JSON model response. */
function jsonNeedle(text: string): string {
  const encoded = JSON.stringify(text);
  return encoded.slice(1, encoded.length - 1);
}

/** Validate a parsed JSON value as a fidelity fixture. `where` labels errors. */
export function parseFidelityFixture(where: string, raw: unknown): FidelityFixture {
  const obj = asObject(where, raw);
  rejectUnknownKeys(where, obj, FIXTURE_KEYS);

  const fixture: FidelityFixture = {
    name: requireString(where, obj, "name"),
    description: requireString(where, obj, "description"),
    transcript: requireString(where, obj, "transcript"),
    sourceSlug: requireSlug(where, obj, "sourceSlug"),
    stubModelId: requireString(where, obj, "stubModelId"),
    stubResponses: {},
    gold: [],
    reject: [],
  };
  if ("note" in obj) fixture.note = requireString(where, obj, "note");
  if ("ownerEntity" in obj) fixture.ownerEntity = requireSlug(where, obj, "ownerEntity");

  if ("dateContext" in obj) {
    const v = requireString(where, obj, "dateContext");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      fail(`${where}.dateContext`, `expected "YYYY-MM-DD", got ${JSON.stringify(v)}`);
    }
    fixture.dateContext = v;
  }

  if ("pages" in obj) {
    const rawPages = obj["pages"];
    if (!Array.isArray(rawPages)) fail(`${where}.pages`, "expected an array of seed pages");
    const pages = rawPages.map((p, i) => parsePage(`${where}.pages[${i}]`, p));
    const slugs = new Set<string>();
    for (const p of pages) {
      if (slugs.has(p.slug)) fail(`${where}.pages`, `duplicate slug ${JSON.stringify(p.slug)}`);
      slugs.add(p.slug);
    }
    fixture.pages = pages;
  }

  // The transcript is parsed HERE, by the same parser the run uses, because a
  // transcript no pattern recognizes yields zero turns, zero model calls and a
  // recall of 0 under every configuration — a fixture that cannot fail.
  const messages = parseConversation(fixture.transcript, {
    ...(fixture.dateContext ? { dateContext: fixture.dateContext } : {}),
  });
  if (messages.length === 0) {
    fail(
      `${where}.transcript`,
      "parseConversation found no turns in it — the fixture would score 0 recall " +
        "without ever reaching the pipeline",
    );
  }

  if (!(PRICED_MODEL_FAMILIES.test(fixture.stubModelId))) {
    fail(
      `${where}.stubModelId`,
      `${JSON.stringify(fixture.stubModelId)} matches no priced model family ` +
        `(opus|sonnet|haiku) — BudgetTracker.record would throw no_pricing and the ` +
        `run would stop after the first turn with no model error reported`,
    );
  }

  const rawResponses = asObject(`${where}.stubResponses`, obj["stubResponses"]);
  const responses: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawResponses)) {
    if (!/^\d+$/.test(key)) {
      fail(`${where}.stubResponses`, `key ${JSON.stringify(key)} is not a turn index`);
    }
    const idx = Number(key);
    if (idx >= messages.length) {
      fail(
        `${where}.stubResponses.${key}`,
        `the transcript has ${messages.length} turn(s), so turn ${idx} is never asked`,
      );
    }
    if (typeof value !== "string") {
      // The one structural guarantee that keeps the stub from BEING the
      // pipeline: it hands back model text, and the real parser reads it.
      fail(
        `${where}.stubResponses.${key}`,
        `expected RAW MODEL TEXT (a string), got ${Array.isArray(value) ? "an array" : typeof value} — ` +
          "a fixture that supplies parsed facts grades itself, not the pipeline",
      );
    }
    responses[key] = value;
  }
  if (Object.keys(responses).length === 0) {
    fail(`${where}.stubResponses`, "no turn has a declared response — nothing would be extracted");
  }
  fixture.stubResponses = responses;

  const rawGold = obj["gold"];
  if (!Array.isArray(rawGold) || rawGold.length === 0) {
    fail(`${where}.gold`, "expected a non-empty array — a fixture with no gold grades nothing");
  }
  fixture.gold = rawGold.map((g, i) => parseGold(`${where}.gold[${i}]`, g));

  const rawReject = obj["reject"];
  if (!Array.isArray(rawReject)) {
    fail(`${where}.reject`, "required, even when empty ([] means 'this fixture drops nothing')");
  }
  fixture.reject = rawReject.map((r, i) => parseReject(`${where}.reject[${i}]`, r));

  const ids = new Set<string>();
  for (const item of [...fixture.gold, ...fixture.reject]) {
    if (ids.has(item.id)) fail(`${where}`, `duplicate label id ${JSON.stringify(item.id)}`);
    ids.add(item.id);
  }

  // A claim cannot be both required and forbidden.
  const goldTexts = new Set(fixture.gold.map((g) => g.fact));
  for (const r of fixture.reject) {
    if (goldTexts.has(r.fact)) {
      fail(`${where}.reject`, `${JSON.stringify(r.id)} repeats a gold claim verbatim`);
    }
  }

  // Every label must be a claim the STUB ACTUALLY EMITS. A gold text that
  // appears in no response is unreachable: it scores a recall miss for a
  // reason that has nothing to do with the pipeline, and a reject text that
  // appears in no response passes drop compliance for free.
  const allResponses = Object.values(responses).join("\n");
  for (const item of [...fixture.gold, ...fixture.reject]) {
    if (!allResponses.includes(jsonNeedle(item.fact))) {
      fail(
        `${where}`,
        `label ${JSON.stringify(item.id)} names a claim no stubResponse emits — ` +
          "it would be graded against model output that never existed",
      );
    }
  }

  return fixture;
}

/** Load and validate one fixture file. The basename is its identity. */
export function loadFidelityFixtureFile(path: string): FidelityFixture {
  const text = readFileSync(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new FixtureError(path, `invalid JSON — ${(e as Error).message}`);
  }
  const fixture = parseFidelityFixture(path, raw);
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/, "");
  if (fixture.name !== base) {
    throw new FixtureError(
      path,
      `name ${JSON.stringify(fixture.name)} != filename ${JSON.stringify(base)}`,
    );
  }
  return fixture;
}

/**
 * Load every `*.json` fixture in `dir`, sorted by filename so a run is
 * reproducible. Throws on the first malformed file — a corpus that half-loads
 * reports scores over a corpus nobody chose.
 *
 * Two CORPUS-level invariants, both aimed at a cheat no per-fixture check can
 * see: without a reject anywhere, "write every claim the model emitted" scores
 * a perfect recall; and two fixtures writing to the same `sourceSlug` would
 * grade each other's rows if the reset between them ever narrowed.
 */
export function loadFidelityCorpus(dir: string = FIDELITY_CORPUS_DIR): FidelityFixture[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new FixtureError(dir, "no *.json fixtures found");
  const out: FidelityFixture[] = [];
  const names = new Set<string>();
  const sources = new Set<string>();
  for (const f of files) {
    const path = join(dir, f);
    const fixture = loadFidelityFixtureFile(path);
    if (names.has(fixture.name)) {
      throw new FixtureError(path, `duplicate fixture name ${JSON.stringify(fixture.name)}`);
    }
    names.add(fixture.name);
    if (sources.has(fixture.sourceSlug)) {
      throw new FixtureError(
        path,
        `sourceSlug ${JSON.stringify(fixture.sourceSlug)} is already used by another fixture — ` +
          "the ledger is read back by source slug, so two fixtures sharing one would grade " +
          "each other's rows the moment the reset between them narrowed",
      );
    }
    sources.add(fixture.sourceSlug);
    out.push(fixture);
  }
  if (!out.some((f) => f.reject.length > 0)) {
    throw new FixtureError(
      dir,
      "no fixture carries a `reject` list — drop compliance is the term that stops " +
        "'persist everything the model said' from scoring a perfect recall",
    );
  }
  return out;
}
