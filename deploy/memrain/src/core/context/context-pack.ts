/**
 * Context pack — a budgeted "what matters now" bundle for the start of a turn.
 *
 *   explicit slugs ─┐
 *                   ├─> standing entities (dedupe, cap 8) ─> entity cards
 *   window text ────┘   (volunteer resolver, default gate)   (facts + recent)
 *
 *   top decayed facts across the grant, minus facts already on a card
 *
 *   each card also lists up to 8 newer pages that link to the entity
 *   (newer-mentions.ts); they are the first thing a tight budget trims
 *
 *   token budget: cards first, then facts; the pack says what it dropped
 *
 * Stateless, read-only, zero-LLM. Every read underneath is already
 * tenant-scoped (entityRecall, listFacts, resolveEntitiesToPointers take the
 * caller's sourceIds and the visibility floor), so this module only composes
 * and trims. A slug that is malformed, missing, out of grant, a soft-stub or
 * fenced produces no card and no other trace — all five look the same, so the
 * pack cannot be used to probe whether a slug exists.
 */

import type { Storage } from "../storage.ts";
import { entityRecall, listFacts, type FactRow } from "../facts.ts";
import { validateSlug } from "../pages.ts";
import { estTokens } from "../search/token-budget.ts";
import { extractCandidatesFromWindow } from "./entity-salience.ts";
import { resolveEntitiesToPointers } from "./reflex.ts";
import { parseWindow, VOLUNTEER_DEFAULT_MIN_CONFIDENCE } from "./volunteer.ts";
import { newerMentionsEnabled, readNewerMentions } from "./newer-mentions.ts";

export const CONTEXT_PACK_DEFAULT_ENTITIES = 5;
export const CONTEXT_PACK_MAX_ENTITIES = 8;
export const CONTEXT_PACK_DEFAULT_FACTS = 10;
export const CONTEXT_PACK_MAX_FACTS = 25;
export const CONTEXT_PACK_DEFAULT_BUDGET = 1500;
export const CONTEXT_PACK_MIN_BUDGET = 200;
export const CONTEXT_PACK_MAX_BUDGET = 8000;
export const CONTEXT_PACK_CARD_FACTS = 5;
export const CONTEXT_PACK_CARD_EVENTS = 3;
/** listFacts' own row cap; the fenced over-fetch never asks for more. */
const FACT_FETCH_CAP = 1000;

export interface PackCardFact {
  id: number;
  fact?: string;
  confidence: number;
}

export interface PackCardEvent {
  date: string;
  event?: string;
}

/** A page dated after the entity's own that links to it. Redacted: date only. */
export interface PackCardNewer {
  date: string;
  slug?: string;
  title?: string | null;
}

export interface PackCard {
  slug: string;
  title: string | null;
  type: string | null;
  facts: PackCardFact[];
  recent: PackCardEvent[];
  /** Present only when something newer links to the entity. */
  newer?: PackCardNewer[];
}

export interface PackFact {
  id: number;
  entity_slug: string;
  fact?: string;
  confidence: number;
}

export interface ContextPackBudget {
  token_budget: number;
  used_tokens: number;
  cards_dropped: number;
  facts_dropped: number;
  card_facts_dropped: number;
  card_events_dropped: number;
  card_newer_dropped: number;
}

export interface ContextPack {
  cards: PackCard[];
  facts: PackFact[];
  budget: ContextPackBudget;
}

export interface ContextPackOpts {
  slugs?: readonly unknown[];
  window?: string;
  maxEntities?: number;
  factsLimit?: number;
  tokenBudget?: number;
  /** Tenant read scope. Omitted -> operator (whole brain); `[]` -> nothing. */
  sourceIds?: string[];
  /** Visibility floor (a remote caller passes ['world']). */
  visibility?: string[];
  /** Confidence decay for the fact reads (off on public ingress). */
  decay?: boolean;
  /** Strip free-text fact/event bodies (public-ingress shape). */
  redact?: boolean;
  /** Untrusted caller: diary entities (slug prefix at least) are left out of the pack. */
  remote?: boolean;
  /** True when the caller must not see this entity (the diary fence). */
  fenced?: (slug: string) => Promise<boolean>;
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/** What one unit costs inside the serialized pack, its separator included. */
const unitCost = (unit: unknown): number => estTokens(`${JSON.stringify(unit)},`);
const PACK_OVERHEAD = estTokens(JSON.stringify({ cards: [], facts: [] }));

function isDiarySlug(slug: string): boolean {
  return slug.startsWith("life/diary/");
}

/**
 * One fence predicate for every section of the pack, memoised per slug. A
 * remote caller without an explicit `fenced` still gets the slug-prefix check.
 */
function fenceOf(opts: Pick<ContextPackOpts, "remote" | "fenced">): ((slug: string) => Promise<boolean>) | null {
  if (opts.fenced) {
    const fenced = opts.fenced;
    const seen = new Map<string, Promise<boolean>>();
    return (slug) => {
      let v = seen.get(slug);
      if (!v) {
        v = fenced(slug);
        seen.set(slug, v);
      }
      return v;
    };
  }
  if (opts.remote) return async (slug) => isDiarySlug(slug);
  return null;
}

function toDate(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
}

function validSlug(s: unknown): s is string {
  if (typeof s !== "string") return false;
  try {
    validateSlug(s);
    return true;
  } catch {
    return false;
  }
}

async function windowEntities(
  storage: Storage,
  window: string | undefined,
  room: number,
  sourceIds: string[] | undefined,
): Promise<string[]> {
  if (room <= 0 || typeof window !== "string" || !window.trim()) return [];
  const candidates = extractCandidatesFromWindow(parseWindow(window));
  if (!candidates.length) return [];
  const pointers = await resolveEntitiesToPointers(storage, candidates, {
    maxPointers: CONTEXT_PACK_MAX_ENTITIES * 2,
    ...(sourceIds !== undefined ? { sourceIds } : {}),
  });
  return pointers
    .filter((p) => p.confidence >= VOLUNTEER_DEFAULT_MIN_CONFIDENCE)
    .map((p) => p.slug);
}

/** Explicit slugs first, then window-resolved ones, deduped and capped. */
export async function selectPackEntities(
  storage: Storage,
  opts: Pick<ContextPackOpts, "slugs" | "window" | "maxEntities" | "sourceIds">,
  isFenced: ((slug: string) => Promise<boolean>) | null = null,
): Promise<string[]> {
  const max = clampInt(opts.maxEntities, CONTEXT_PACK_DEFAULT_ENTITIES, 1, CONTEXT_PACK_MAX_ENTITIES);
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (s: string) => {
    if (out.length < max && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  for (const s of opts.slugs ?? []) if (validSlug(s)) take(s);
  // A missing explicit slug takes a slot too, so fencing it later reveals
  // nothing. A window name that matches nothing never resolves, though, so a
  // fenced window match must not take a slot either.
  for (const s of await windowEntities(storage, opts.window, max - out.length, opts.sourceIds)) {
    if (out.length >= max) break;
    if (isFenced && (await isFenced(s))) continue;
    take(s);
  }
  return out;
}

/** An assistant's claim reads as one, so the caller never takes a suggestion
 *  for something the operator said (mig130 `attributed_to`). */
function packFactText(f: FactRow): string {
  return f.attributed_to === "assistant" ? `(assistant said) ${f.fact}` : f.fact;
}

/** The operator's own claims first; assistant claims after, order otherwise kept. */
function speakerOrdered(rows: readonly FactRow[]): FactRow[] {
  return [
    ...rows.filter((f) => f.attributed_to !== "assistant"),
    ...rows.filter((f) => f.attributed_to === "assistant"),
  ];
}

async function buildCard(
  storage: Storage,
  slug: string,
  opts: ContextPackOpts,
  isFenced: ((slug: string) => Promise<boolean>) | null,
): Promise<PackCard | null> {
  if (isFenced && (await isFenced(slug))) return null;
  const r = await entityRecall(storage, slug, {
    redact_body: true,
    fact_limit: CONTEXT_PACK_CARD_FACTS,
    timeline_limit: CONTEXT_PACK_CARD_EVENTS,
    ...(opts.decay !== undefined ? { decay: opts.decay } : {}),
    ...(opts.sourceIds !== undefined ? { sourceIds: opts.sourceIds } : {}),
    ...(opts.visibility?.length ? { visibility: opts.visibility } : {}),
  });
  // A soft-stub (facts without a page) and an out-of-grant page both read as
  // null here; neither gets a card.
  if (!r.page) return null;
  const newer = newerMentionsEnabled()
    ? await readNewerMentions(storage, slug, {
        ...(opts.sourceIds !== undefined ? { sourceIds: opts.sourceIds } : {}),
        isFenced,
        includeDocuments: !opts.remote,
      })
    : [];
  return {
    slug,
    title: r.page.title ?? null,
    type: r.page.type ?? null,
    facts: speakerOrdered(r.facts).map((f) =>
      opts.redact
        ? { id: f.id, confidence: f.confidence }
        : { id: f.id, fact: packFactText(f), confidence: f.confidence },
    ),
    recent: r.timeline.map((e) =>
      opts.redact ? { date: toDate(e.occurred_at) } : { date: toDate(e.occurred_at), event: e.event },
    ),
    ...(newer.length > 0
      ? { newer: newer.map((m) => (opts.redact ? { date: m.date } : { date: m.date, slug: m.slug, title: m.title })) }
      : {}),
  };
}

interface FittedCard {
  card: PackCard;
  cost: number;
  factsDropped: number;
  eventsDropped: number;
  newerDropped: number;
}

/**
 * Fit one card into `room` tokens. Newer mentions are trimmed first, oldest
 * first: they point elsewhere, while facts and events are the entity's own.
 * Then facts go first, then recent events; null when the header alone does
 * not fit.
 */
function fitCard(card: PackCard, room: number): FittedCard | null {
  const full = unitCost(card);
  if (full <= room) return { card, cost: full, factsDropped: 0, eventsDropped: 0, newerDropped: 0 };
  const newer = card.newer ?? [];
  for (let keep = newer.length - 1; keep >= 1; keep--) {
    const shorter: PackCard = { ...card, newer: newer.slice(0, keep) };
    const cost = unitCost(shorter);
    if (cost <= room) return { card: shorter, cost, factsDropped: 0, eventsDropped: 0, newerDropped: newer.length - keep };
  }
  const { newer: _newer, ...bare } = card;
  if (newer.length > 0) {
    const cost = unitCost(bare);
    if (cost <= room) return { card: bare, cost, factsDropped: 0, eventsDropped: 0, newerDropped: newer.length };
  }
  const fitted = fitFactsAndEvents(bare, room);
  return fitted && { ...fitted, newerDropped: newer.length };
}

function fitFactsAndEvents(card: PackCard, room: number): Omit<FittedCard, "newerDropped"> | null {
  const trimmed: PackCard = { ...card, facts: [], recent: [] };
  if (unitCost(trimmed) > room) return null;
  for (const f of card.facts) {
    const next = { ...trimmed, facts: [...trimmed.facts, f] };
    if (unitCost(next) > room) break;
    trimmed.facts = next.facts;
  }
  // Events only once every fact is in, so a later event never outlasts a fact.
  if (trimmed.facts.length === card.facts.length) {
    for (const e of card.recent) {
      const next = { ...trimmed, recent: [...trimmed.recent, e] };
      if (unitCost(next) > room) break;
      trimmed.recent = next.recent;
    }
  }
  return {
    card: trimmed,
    cost: unitCost(trimmed),
    factsDropped: card.facts.length - trimmed.facts.length,
    eventsDropped: card.recent.length - trimmed.recent.length,
  };
}

export async function buildContextPack(
  storage: Storage,
  opts: ContextPackOpts = {},
): Promise<ContextPack> {
  const tokenBudget = clampInt(
    opts.tokenBudget,
    CONTEXT_PACK_DEFAULT_BUDGET,
    CONTEXT_PACK_MIN_BUDGET,
    CONTEXT_PACK_MAX_BUDGET,
  );
  const factsLimit = clampInt(opts.factsLimit, CONTEXT_PACK_DEFAULT_FACTS, 1, CONTEXT_PACK_MAX_FACTS);

  const isFenced = fenceOf(opts);
  const slugs = await selectPackEntities(storage, opts, isFenced);
  const built: PackCard[] = [];
  for (const slug of slugs) {
    const card = await buildCard(storage, slug, opts, isFenced);
    if (card) built.push(card);
  }

  const onCards = new Set<number>();
  for (const c of built) for (const f of c.facts) onCards.add(f.id);
  const kept: FactRow[] = [];
  // Fetch enough rows that excluding every card fact still leaves factsLimit;
  // fenced entities can eat more, so widen the read until it fills or runs dry.
  for (let limit = factsLimit + onCards.size; ; limit = Math.min(FACT_FETCH_CAP, limit * 4)) {
    const rows: FactRow[] = await listFacts(storage, null, {
      limit,
      order: "confidence",
      ...(opts.decay !== undefined ? { decay: opts.decay } : {}),
      ...(opts.sourceIds !== undefined ? { sourceIds: opts.sourceIds } : {}),
      ...(opts.visibility?.length ? { visibility: opts.visibility } : {}),
    });
    kept.length = 0;
    for (const f of rows) {
      if (kept.length >= factsLimit) break;
      if (onCards.has(f.id)) continue;
      if (isFenced && (await isFenced(f.entity_slug))) continue;
      kept.push(f);
    }
    if (kept.length >= factsLimit || rows.length < limit || limit >= FACT_FETCH_CAP) break;
  }
  const brainFacts: PackFact[] = speakerOrdered(kept).map((f) =>
    opts.redact
      ? { id: f.id, entity_slug: f.entity_slug, confidence: f.confidence }
      : { id: f.id, entity_slug: f.entity_slug, fact: packFactText(f), confidence: f.confidence },
  );

  // Charged on what the caller is allowed to see, so the dropped counts say
  // nothing about rows behind the grant or the visibility floor.
  let used = PACK_OVERHEAD;
  const cards: PackCard[] = [];
  let cardFactsDropped = 0;
  let cardEventsDropped = 0;
  let cardNewerDropped = 0;
  for (const card of built) {
    const fit = fitCard(card, tokenBudget - used);
    if (!fit) break;
    cards.push(fit.card);
    used += fit.cost;
    cardFactsDropped += fit.factsDropped;
    cardEventsDropped += fit.eventsDropped;
    cardNewerDropped += fit.newerDropped;
  }
  const facts: PackFact[] = [];
  // A dropped card outranks every brain fact, so none may take its place.
  const factPool = cards.length === built.length ? brainFacts : [];
  for (const f of factPool) {
    const cost = unitCost(f);
    if (used + cost > tokenBudget) break;
    facts.push(f);
    used += cost;
  }

  return {
    cards,
    facts,
    budget: {
      token_budget: tokenBudget,
      used_tokens: used,
      cards_dropped: built.length - cards.length,
      facts_dropped: brainFacts.length - facts.length,
      card_facts_dropped: cardFactsDropped,
      card_events_dropped: cardEventsDropped,
      card_newer_dropped: cardNewerDropped,
    },
  };
}
