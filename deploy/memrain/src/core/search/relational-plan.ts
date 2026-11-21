/**
 * Multi-relation query planner: turns a question that chains 2-3 typed
 * relations ("who founded the companies that alice invested in?") into a chain
 * plan over `links`. Pure: no DB, no LLM, deterministic.
 *
 * How a question is read:
 *   1. A linear tokenizer splits it into word tokens with spans.
 *   2. Relation phrases are spotted longest-first from a fixed lexicon, each
 *      with its surface form: active verb ("invested in"), passive ("founded
 *      by"), agent noun ("investors of", "acme's founders"), outgoing noun
 *      ("alice's portfolio") or co-relation ("co-investors").
 *   3. Fewer than two relations is `not_applicable`: single-relation questions
 *      stay on parseRelationalQuery (relational-recall.ts), unchanged.
 *   4. Every token that is not a relation, question word, auxiliary,
 *      determiner, relative pronoun, polite lead-in, head noun or marker must
 *      form exactly one contiguous span: the anchor entity. A pronoun right
 *      after a verb ("who founded THEM") points back at the previous step.
 *   5. English nests the named entity innermost, so hops run from the relation
 *      nearest the anchor outward (nouns bind tighter than verbs at equal
 *      distance). A hop walks toward the relation's object or subject depending
 *      on its form and on which side of it the anchor sits.
 *   6. Consecutive hops must agree on the page type between them, and a
 *      "who" / "which companies" head must fit the last hop.
 *
 * Refused as `unsupported` (never answered with a one-hop guess): coordination
 * ("and" followed by a back-reference is a sequence, not coordination),
 * negation, dates and time windows, comparatives, counting, quoted names, more
 * than one candidate anchor, more than three hops, type-incoherent chains. A
 * tense marker right before a relation that can end ("formerly advised", "used
 * to work at") sets that hop's link-validity status instead.
 *
 * Tested in tests/relational_chain.test.ts.
 */
import type { LinkTemporalOptions } from "../link-validity.ts";

export const MAX_CHAIN_HOPS = 3;

/** Default on; `MEMRAIN_RELATIONAL_CHAIN=0` keeps multi-relation questions on the single-hop parser. */
export function relationalChainEnabled(raw: string | undefined = process.env["MEMRAIN_RELATIONAL_CHAIN"]): boolean {
  return raw !== "0";
}

/**
 * Page-type signature of each chain relation: subject types -> object types.
 * Every key is one of links.ts KNOWN_LINK_TYPES (asserted in the tests; not at
 * load time, since links.ts sits on this module's import cycle).
 */
export const LINK_SIGNATURES: Readonly<Record<string, { subject: readonly string[]; object: readonly string[] }>> = {
  founded: { subject: ["person"], object: ["company"] },
  invested_in: { subject: ["person", "company"], object: ["company", "deal"] },
  advises: { subject: ["person"], object: ["company"] },
  works_at: { subject: ["person"], object: ["company"] },
  attended: { subject: ["person"], object: ["meeting"] },
};

/** The signature of a chain relation; own keys only, so "__proto__" is not one. */
export function signatureOf(linkType: string): { subject: readonly string[]; object: readonly string[] } | undefined {
  return Object.hasOwn(LINK_SIGNATURES, linkType) ? LINK_SIGNATURES[linkType] : undefined;
}

/** Link types a chain hop may walk. */
export const CHAIN_LINK_TYPES: readonly string[] = Object.keys(LINK_SIGNATURES);

/** Relations that hold a state which can end; only these take a tense marker. */
const STATE_RELATIONS: ReadonlySet<string> = new Set(["works_at", "advises"]);

export type HopStatus = NonNullable<LinkTemporalOptions["status"]>;

export interface ChainHop {
  /** The relation this hop walks; always in CHAIN_LINK_TYPES. */
  linkType: string;
  /** Walk from the current node to the relation's object or subject. */
  toward: "object" | "subject";
  /** Page type the landing node must have, when the question names one. */
  nodeType?: string;
  /** Link-validity status for this hop ("formerly advised" -> expired). */
  status?: HopStatus;
}

export interface RelationalPlan {
  /** Raw anchor phrase, resolved to a page later (scope-aware). */
  anchor: string;
  /** Anchor-outward hops. */
  hops: ChainHop[];
  /** True for "other/else/also" questions and the co-relation shape. */
  excludeAnchor: boolean;
  /** Matched relation phrases in hop order, for telemetry. */
  phrases: string[];
}

export type PlanResult =
  | { kind: "plan"; plan: RelationalPlan }
  | { kind: "not_applicable" }
  | { kind: "unsupported"; reason: string };

type Form = "verb" | "passive" | "agent" | "out" | "co";

interface LexEntry {
  words: string[];
  rel: string;
  form: Form;
  /** Base-form verbs ("found", "back") count only next to an auxiliary ("did X back"). */
  needsAux?: boolean;
}

function entries(rel: string, form: Form, phrases: string[], needsAux = false): LexEntry[] {
  return phrases.map(p => ({ words: p.split(" "), rel, form, ...(needsAux ? { needsAux } : {}) }));
}

const LEXICON: LexEntry[] = [
  ...entries("founded", "verb", ["founded", "co-founded", "cofounded", "started", "founds", "starts", "established"]),
  ...entries("founded", "verb", ["found", "co-found", "start"], true),
  ...entries("founded", "passive", ["founded by", "co-founded by", "cofounded by", "started by", "established by"]),
  ...entries("founded", "out", ["'s startups", "'s startup", "'s ventures", "'s founded companies", "'s founded startups"]),
  ...entries("founded", "agent", ["founder", "founders", "co-founder", "co-founders", "cofounder", "cofounders", "founding team"]),
  ...entries("invested_in", "verb", ["invested in", "invests in", "has invested in", "backed", "backs", "funded", "funds",
    "financed", "finances", "put money into", "put money in", "invest in", "holds a stake in", "holds stakes in",
    "has a stake in", "is an investor in", "are investors in", "was an investor in"]),
  ...entries("invested_in", "verb", ["back", "fund", "finance"], true),
  ...entries("invested_in", "passive", ["backed by", "funded by", "financed by"]),
  ...entries("invested_in", "agent", ["investor", "investors", "backer", "backers", "funder", "funders", "shareholders"]),
  ...entries("invested_in", "out", ["portfolio", "portfolio companies", "portfolio company", "investments"]),
  ...entries("invested_in", "co", ["co-investor", "co-investors", "coinvestors"]),
  ...entries("advises", "verb", ["advises", "advised", "advising", "advise", "is an advisor to", "is an adviser to",
    "serves as an advisor to", "serves as advisor to"]),
  ...entries("advises", "passive", ["advised by"]),
  ...entries("advises", "agent", ["advisor", "advisors", "adviser", "advisers", "advisory board"]),
  ...entries("works_at", "verb", ["works at", "worked at", "works for", "worked for", "working at", "working for",
    "employed at", "employed by", "work at", "work for"]),
  ...entries("works_at", "agent", ["employee", "employees", "staff", "team members"]),
  ...entries("works_at", "out", ["employer", "employers"]),
  ...entries("attended", "verb", ["attended", "attend"]),
  ...entries("attended", "passive", ["attended by"]),
  ...entries("attended", "agent", ["attendees"]),
].sort((a, b) => b.words.length - a.words.length);

const WH = new Set(["who", "whom", "which", "what"]);
const AUX = new Set(["did", "does", "do", "has", "have", "had", "is", "are", "was", "were"]);
const DO_AUX = new Set(["did", "does", "do", "has", "have", "had"]);
const DETERMINERS = new Set(["the", "a", "an", "all", "any", "their", "its", "his", "her", "each", "every", "some",
  "those", "these", "same", "them", "they", "it"]);
const RELATIVE = new Set(["that", "which", "who", "whom"]);
const HEAD_LEAD = new Set(["among", "of", "our", "my"]);
const PREPS = new Set(["of", "in", "at", "behind", "for", "to", "into", "with"]);
const POLITE = new Set(["list", "show", "name", "find", "give", "me", "tell", "please", "us", "could", "can", "would",
  "you", "i", "know", "want", "like", "wondering", "curious", "see"]);
// The word tables are Maps, not object literals: a query word such as
// "constructor" or "__proto__" must never match an inherited property.
/** Tense markers right before a state relation pick which links that hop walks. */
const TENSE: ReadonlyMap<string, HopStatus> = new Map(Object.entries({
  former: "expired", formerly: "expired", previously: "expired", past: "expired", current: "active", currently: "active",
} as const));
/** Pronouns pointing back at the previous step's pages ("..., who founded THEM"). */
const BACKREF = new Set(["them", "those", "these", "they"]);
/** Head nouns that name no page type ("which other PARTIES invested ..."). */
const GENERIC_HEADS = new Set(["parties", "entities", "ones", "additional"]);
const OTHER_MARKERS = new Set(["other", "others", "else", "also"]);
const HEAD_TYPES: ReadonlyMap<string, string> = new Map(Object.entries({
  people: "person", person: "person", persons: "person", individuals: "person", folks: "person", angels: "person",
  companies: "company", company: "company", startups: "company", startup: "company", firms: "company", firm: "company",
  businesses: "company", organizations: "company", funds: "company", fund: "company", vcs: "company",
  meetings: "meeting", meeting: "meeting", events: "meeting",
}));
const REFUSE: ReadonlyMap<string, string> = new Map(Object.entries({
  "and": "coordination", "or": "coordination", "nor": "coordination", "but": "coordination",
  "not": "negation", "never": "negation", "no": "negation", "without": "negation", "except": "negation", "n't": "negation",
  "before": "time", "after": "time", "since": "time", "during": "time", "until": "time", "ago": "time",
  "recently": "time", "year": "time", "years": "time",
  "most": "comparative", "more": "comparative", "least": "comparative", "fewest": "comparative", "top": "comparative",
  "many": "count", "count": "count", "number": "count",
}));

interface Tok { text: string; lower: string; start: number; end: number }

/** Linear tokenizer: words (letters, digits, inner `.&-`), possessive markers and quotes; other punctuation dropped. */
function tokenize(q: string): Tok[] {
  const toks: Tok[] = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}.&-]*|['\u2019]s\b|['\u2019"\u201C\u201D]/gu;
  for (const m of q.matchAll(re)) {
    let text = m[0];
    let start = m.index;
    if (text === "\"" || text === "\u201C" || text === "\u201D") {
      toks.push({ text, lower: "\"", start, end: start + 1 });
      continue;
    }
    while (text.endsWith(".")) text = text.slice(0, -1);
    const lower = text.toLowerCase().replace("\u2019", "'");
    if (lower.endsWith("n't") && lower.length > 3) {
      toks.push({ text: text.slice(0, -3), lower: lower.slice(0, -3), start, end: start + text.length - 3 });
      start += text.length - 3;
      toks.push({ text: "n't", lower: "n't", start, end: start + 3 });
      continue;
    }
    toks.push({ text, lower: lower === "'s" || lower === "'" ? "'s" : lower, start, end: start + text.length });
  }
  return toks;
}

interface Rel { entry: LexEntry; from: number; to: number }

/** Plan a multi-relation question, or say why not. */
export function parseRelationalPlan(query: string): PlanResult {
  if (typeof query !== "string" || query.length === 0 || query.length > 512) return { kind: "not_applicable" };
  const toks = tokenize(query);
  let lead = 0;
  while (lead < toks.length && POLITE.has(toks[lead]!.lower)) lead++;
  const hasAux = toks.some(t => AUX.has(t.lower));

  const rels: Rel[] = [];
  const used: boolean[] = Array.from<boolean>({ length: toks.length }).fill(false);
  for (let i = 0; i < toks.length; i++) {
    if (used[i]) continue;
    for (const e of LEXICON) {
      if (i + e.words.length > toks.length) continue;
      if (!e.words.every((word, j) => toks[i + j]!.lower === word)) continue;
      if (e.needsAux && !hasAux) continue;
      rels.push({ entry: e, from: i, to: i + e.words.length - 1 });
      for (let j = i; j < i + e.words.length; j++) used[j] = true;
      break;
    }
  }
  // An agent noun right after the question word is the question's head, not a
  // relation ("WHICH INVESTORS backed ..."). "WHO are the founders of ..."
  // asks for the relation, so a bare who/whom heads only with "among"/"of".
  const headLead = toks.slice(lead, rels[0]?.from ?? lead);
  const leadTok = toks[lead]?.lower ?? "";
  if (rels.length > 0 && rels[0]!.entry.form === "agent" && rels[0]!.from > lead && WH.has(leadTok)
    && (!["who", "whom"].includes(leadTok) || headLead.some(t => t.lower === "among" || t.lower === "of"))
    && headLead.every(t => WH.has(t.lower) || DETERMINERS.has(t.lower) || OTHER_MARKERS.has(t.lower) || HEAD_LEAD.has(t.lower))) {
    rels.shift();
  }
  // "the CO-INVESTORS in the companies X INVESTED IN": the co-relation already
  // walks out and back over that relation, so its verb is not another hop.
  const co = rels.find(r => r.entry.form === "co");
  if (co) {
    for (let k = rels.length - 1; k >= 0; k--) {
      if (rels[k] !== co && rels[k]!.entry.rel === co.entry.rel) rels.splice(k, 1);
    }
  }
  const relCount = rels.reduce((n, r) => n + (r.entry.form === "co" ? 2 : 1), 0);
  if (relCount < 2) return { kind: "not_applicable" };
  if (toks.some(t => t.lower === "\"")) return { kind: "unsupported", reason: "quoted names are not planned" };

  for (const [i, t] of toks.entries()) {
    if (t.lower === "and" && toks.slice(i + 1).some(n => BACKREF.has(n.lower))) continue;
    const why = REFUSE.get(t.lower) ?? (/^(?:1[89]|20)\d\d$/.test(t.lower) ? "time" : undefined);
    if (why) return { kind: "unsupported", reason: `${why} constraints are not planned ("${t.text}")` };
  }
  const tenseOf = new Map<Rel, HopStatus>();
  const tenseTok = new Set<number>();
  for (let i = 0; i < toks.length; i++) {
    const usedTo = toks[i]!.lower === "used" && toks[i + 1]?.lower === "to";
    const status = usedTo ? "all" : TENSE.get(toks[i]!.lower);
    if (!status) continue;
    const marker = query.slice(toks[i]!.start, toks[usedTo ? i + 1 : i]!.end);
    let j = i + (usedTo ? 2 : 1);
    while (j < toks.length && DETERMINERS.has(toks[j]!.lower)) j++;
    const rel = rels.find(r => r.from === j);
    if (!rel) return { kind: "unsupported", reason: `time constraints are not planned ("${marker}")` };
    if (!STATE_RELATIONS.has(rel.entry.rel)) {
      return { kind: "unsupported", reason: `${rel.entry.rel} does not end, so "${marker}" is not planned` };
    }
    tenseOf.set(rel, status);
    tenseTok.add(i);
    if (usedTo) tenseTok.add(i + 1);
  }
  for (const r of rels) {
    if (!tenseOf.has(r) && toks[r.from]!.lower === "worked" && r.entry.rel === "works_at") tenseOf.set(r, "all");
  }
  if (relCount > MAX_CHAIN_HOPS) return { kind: "unsupported", reason: `more than ${MAX_CHAIN_HOPS} relations` };

  // Classify every non-relation token; leftovers form the anchor.
  let headType: string | null = null;
  let excludeAnchor = false;
  const leftover: number[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (used[i] || tenseTok.has(i)) continue;
    const l = toks[i]!.lower;
    if (OTHER_MARKERS.has(l)) {
      excludeAnchor = true;
      continue;
    }
    if (l === "'s" || l === "and" || GENERIC_HEADS.has(l)) continue;
    if (WH.has(l) || AUX.has(l) || DETERMINERS.has(l) || RELATIVE.has(l) || PREPS.has(l) || POLITE.has(l) || l === "by" || l === "whose") {
      if ((l === "who" || l === "whom") && headType === null && i === lead) headType = "person";
      continue;
    }
    const head = HEAD_TYPES.get(l);
    if (head) {
      const leading = toks.slice(0, i).every(t => WH.has(t.lower) || POLITE.has(t.lower) || DETERMINERS.has(t.lower));
      if (headType === null && leading) headType = head;
      continue;
    }
    leftover.push(i);
  }
  if (leftover.length === 0) return { kind: "unsupported", reason: "no entity named" };
  if (!leftover.every((idx, k) => k === 0 || idx === leftover[k - 1]! + 1)) {
    return { kind: "unsupported", reason: "more than one candidate entity" };
  }
  const aStart = leftover[0]!;
  const aEnd = leftover[leftover.length - 1]!;
  const anchor = query.slice(toks[aStart]!.start, toks[aEnd]!.end).trim();
  if (anchor.length === 0 || anchor.length > 80) return { kind: "unsupported", reason: "entity name out of bounds" };
  if (rels.some(r => r.from <= aEnd && r.to >= aStart)) return { kind: "unsupported", reason: "entity name overlaps a relation" };

  // Order hops anchor-outward. The main-clause verb ("WHO founded ...", "which
  // companies DID ... back") is always outermost; the rest order by how many
  // content tokens separate them from the anchor, nouns binding tighter than
  // verbs at equal distance.
  const scaffold = (l: string) => TENSE.has(l) || WH.has(l) || AUX.has(l) || DETERMINERS.has(l) || POLITE.has(l)
    || OTHER_MARKERS.has(l) || GENERIC_HEADS.has(l) || HEAD_TYPES.has(l);
  const isVerb = (r: Rel) => r.entry.form === "verb" || r.entry.form === "passive";
  const startsWithWh = lead < toks.length && WH.has(leadTok);
  // "which companies DID alice back": the auxiliary is followed by its subject,
  // not by a relation ("which parties HAVE invested in" is perfect tense).
  const auxInverted = startsWithWh && toks.slice(lead + 1, lead + 4).some((t, k) => DO_AUX.has(t.lower) && !used[lead + 2 + k]);
  const lastRel = rels.reduce((a, b) => (b.from > a.from ? b : a));
  const isMain = (r: Rel) => isVerb(r) && (
    (startsWithWh && toks.slice(0, r.from).every(t => scaffold(t.lower)))
    || (auxInverted && r === lastRel && r.to === toks.length - 1)
  );
  const skip = (l: string) => TENSE.has(l) || l === "used" || DETERMINERS.has(l) || PREPS.has(l) || RELATIVE.has(l)
    || AUX.has(l) || OTHER_MARKERS.has(l) || l === "'s" || l === "by" || l === "whose";
  const dist = (r: Rel) => {
    const [a, b] = r.to < aStart ? [r.to + 1, aStart] : [aEnd + 1, r.from];
    const span = toks.slice(a, b);
    return span.filter((t, k) => !used[a + k] && !skip(t.lower)).length + span.filter((_, k) => used[a + k]).length;
  };
  const nounish = (r: Rel) => (isVerb(r) ? 1 : 0);
  // "alice's portfolio": the noun the anchor possesses binds first, whether the
  // lexicon entry carries the "'s" or the noun follows a bare "'s" token.
  const possessive = (r: Rel) =>
    (r.entry.words[0] === "'s" && r.from === aEnd + 1) || (r.from === aEnd + 2 && toks[aEnd + 1]?.lower === "'s") ? 0 : 1;
  const ordered = [...rels].sort((a, b) =>
    Number(isMain(a)) - Number(isMain(b)) || possessive(a) - possessive(b) || dist(a) - dist(b) || nounish(a) - nounish(b) || a.from - b.from);

  const hops: ChainHop[] = [];
  const phrases: string[] = [];
  for (const r of ordered) {
    const anchorOnLeft = aEnd < r.from && !BACKREF.has(toks[r.to + 1]?.lower ?? "");
    const phrase = query.slice(toks[r.from]!.start, toks[r.to]!.end);
    if (r.entry.form === "co") {
      hops.push({ linkType: r.entry.rel, toward: "object" }, { linkType: r.entry.rel, toward: "subject" });
      excludeAnchor = true;
      phrases.push(phrase, phrase);
      continue;
    }
    const toward: ChainHop["toward"] =
      r.entry.form === "verb" ? (anchorOnLeft ? "object" : "subject")
        : r.entry.form === "passive" ? (anchorOnLeft ? "subject" : "object")
          : r.entry.form === "agent" ? "subject" : "object";
    const status = tenseOf.get(r);
    hops.push({ linkType: r.entry.rel, toward, ...(status ? { status } : {}) });
    phrases.push(phrase);
  }
  if (hops.length > MAX_CHAIN_HOPS) return { kind: "unsupported", reason: `more than ${MAX_CHAIN_HOPS} relations` };

  // Co-relation shape: the last hop walks back over the relation just walked.
  const last = hops[hops.length - 1]!;
  const prev = hops[hops.length - 2];
  if (prev && last.linkType === prev.linkType && last.toward !== prev.toward) excludeAnchor = true;

  // Type coherence along the chain, then the head noun on the last hop.
  let types: Set<string> | null = null;
  for (const h of hops) {
    const sig = signatureOf(h.linkType)!;
    const entry = new Set(h.toward === "object" ? sig.subject : sig.object);
    if (types && ![...types].some(t => entry.has(t))) {
      return { kind: "unsupported", reason: "the relations do not chain (page types disagree)" };
    }
    types = new Set(h.toward === "object" ? sig.object : sig.subject);
  }
  if (headType && types) {
    if (!types.has(headType)) {
      return { kind: "unsupported", reason: `the question asks for ${headType} pages but the last relation returns ${[...types].join("/")}` };
    }
    if (types.size > 1) hops[hops.length - 1] = { ...last, nodeType: headType };
  }
  return { kind: "plan", plan: { anchor, hops, excludeAnchor, phrases } };
}

/**
 * Validate a model-supplied chain: 1-3 hops of `{link_type, toward}` over the
 * chain link types. Null on any shortfall -- a bad hop list is a miss, never a
 * partial plan.
 */
export function validateChainHops(raw: unknown): ChainHop[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CHAIN_HOPS) return null;
  const hops: ChainHop[] = [];
  for (const h of raw) {
    if (typeof h !== "object" || h === null) return null;
    const o = h as Record<string, unknown>;
    const lt = typeof o.link_type === "string" ? o.link_type.trim().toLowerCase() : "";
    if (!signatureOf(lt)) return null;
    if (o.toward !== "object" && o.toward !== "subject") return null;
    hops.push({ linkType: lt, toward: o.toward });
  }
  return hops;
}
