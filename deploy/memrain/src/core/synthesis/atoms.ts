/**
 * Bounded single-source extraction into synth_atoms and optional atom pages.
 * A complete, validated source run publishes its rows and completion manifest
 * atomically. Partial page versions remain auditable; old atoms are retained.
 * Legacy same-hash rows keep their no-replay behavior until a real source edit.
 * Only proven automatic pages from the previous completed manifest may retire.
 */
import { createHash } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import { notSynthesizedDocSql } from "../page-index.ts";
import type { Storage } from "../storage.ts";
import { putPage } from "../pages.ts";
import { resolveLlmFn, type LlmFn } from "../llm/haiku.ts";
import { sanitizeForPrompt } from "../llm/sanitize.ts";
import { parseModelJson } from "../llm/json-output.ts";
import { isQuoteInText } from "./quote-verify.ts";
import { resolveModel } from "../llm/resolve-model.ts";
import { clearSynthFailure, filterBackedOff, recordSynthFailure } from "./synth-failures.ts";
import { quarantineFilterFragment } from "../quarantine.ts";
import { isTruncated } from "../llm/truncation.ts";
import { TERMINAL_STOP_REASONS } from "../llm/converse.ts";
import { phaseFenceCheck, PhaseStoppedError } from "../cycle/phase-context.ts";
import { lockAtomSource } from "./atoms-source.ts";
import { readAtomCompletion, readCurrentAtomPage, retireCompletedAtomPages, validateCompletedPages,
  type AtomPageSnapshot } from "./atoms-lifecycle.ts";

/** Allowed atom_type values. A returned type outside this set falls back. */
export const ATOM_TYPES = [
  "insight",
  "anecdote",
  "quote",
  "framework",
  "statistic",
  "strategy",
  "critique",
] as const;
export type AtomType = (typeof ATOM_TYPES)[number];

const DEFAULT_MAX_DOCS = 25;
const MIN_DOC_CHARS = 400;
const MAX_DOC_CHARS_TO_LLM = 50_000;

export interface ExtractAtomsOptions {
  /** Max documents to process this run (cost guard). Default 25. */
  maxDocs?: number;
  /** Injected LLM seam. Tests pass a fake; production resolves callHaiku. */
  llmFn?: LlmFn;
  /** Override the utility model id (config / tests). */
  modelId?: string;
  /**
   * Storage handle for the atom page mirror (`atoms/<date>/<slug>` via
   * putPage). Absent → rows only, no pages (pre-076 behaviour). Page writes
   * can also be disabled globally with MEMRAIN_SYNTH_PAGES=0.
   */
  storage?: Storage;
}

export interface ExtractAtomsResult {
  documentsScanned: number;
  documentsProcessed: number;
  atomsWritten: number;
  /** Atom pages written via putPage (0 when no storage / gated off). */
  pagesWritten: number;
  /** source_quote values dropped because the note does not contain them. */
  quotesDropped: number;
  pagesHeld: number;
  pagesRetired: number;
  heldPages: { slug: string; reason: string }[];
  errors: string[];
}

interface ParsedAtom {
  title: string;
  atom_type: AtomType;
  body: string;
  concepts: string[];
  /** Verbatim source line the atom was distilled from (<=200 chars). */
  source_quote?: string;
  /** One-sentence takeaway. */
  lesson?: string;
}

interface SourceDoc {
  id: string;
  text: string;
  contentHash16: string;
  sourceId: string | null;
  /** The note's own date (effective_date, else ingest date) — YYYY-MM-DD. */
  sourceDate: string;
  frontmatter: Record<string, unknown>;
}

const SYSTEM_PROMPT = `You extract atomic knowledge nuggets from a note.

An atom is a single-source, self-contained idea. Each atom must:
- Stand alone (no "as discussed above").
- Have a clear point (not merely descriptive).
- Be specific (not a generic platitude).

Output a JSON array of 1-3 atoms (never more than 3). Each atom is an object:
  {"title": (<=80 chars), "atom_type": (one of: ${ATOM_TYPES.join(", ")}),
   "body": (2-4 sentences), "concepts": (array of 1-3 short lowercase topic tags),
   "source_quote": (verbatim quote from the note, <=200 chars),
   "lesson": (one sentence naming the takeaway)}

The message gives the note's observation date. Relative time words in the note ("yesterday", "last week", "next month") are relative to that date: write the absolute date in the body when the note supports one, and never treat the observation date as today.
"source_quote" must be copied word for word from the note; omit it rather than paraphrase.

Output ONLY the JSON array. No prose, no markdown fences.`;

/** Page mirror gate — default ON; MEMRAIN_SYNTH_PAGES=0 turns synth page writes off. */
export function synthPagesEnabled(
  raw: string | undefined = process.env.MEMRAIN_SYNTH_PAGES,
): boolean {
  return (raw ?? "").trim() !== "0";
}

/** Kebab page-slug segment from a free-text title. */
export function slugifyTitle(title: string): string {
  // Measured linear through slugifyTitle: 0.6 ms at 800 K chars, ratio 1.99 on
  // a doubling (`-`*n, `!`*n and `-a`*n/2 all agree). The `-+` run the rule
  // warns about cannot reach either trim: the `[^a-z0-9]+` collapse on the line
  // above rewrites EVERY run of non-alphanumerics to a single `-`, so by the
  // time these two run the string has no two adjacent dashes to back over.
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    // eslint-disable-next-line regexp/no-super-linear-move
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    // ...and this one also sees at most 60 chars, whatever the title was.
    // eslint-disable-next-line regexp/no-super-linear-move
    .replace(/^-+|-+$/g, "");
  return s.length > 0 ? s : "atom";
}

/** Stable 16-char content hash of a document's text (source-change signal). */
export function contentHash16(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Deterministic idempotency key for an atom. */
export function atomKey(sourceRef: string, sourceHash16: string, body: string): string {
  return createHash("sha256")
    .update(`${sourceRef} ${sourceHash16} ${body}`)
    .digest("hex");
}

/**
 * Deterministic page slug for an atom's mirror:
 * `atoms/<source-date>/<title-slug>-<identity-hash>`.
 *
 * Every input is stable identity — the source document and the atom title.
 * Neither the run date nor the document's content hash appears, so editing a
 * source note re-writes the SAME atom page (putPage upserts) instead of
 * stranding the old one and minting a near-duplicate beside it. The date
 * segment is the NOTE's date, not today's, for the same reason.
 *
 * The hash suffix keeps two atoms whose titles slugify to the same string on
 * distinct slugs, so a deterministic slug never silently clobbers a *different*
 * atom. It covers the title only — an LLM rewording the body on re-extraction
 * still lands on the same page.
 *
 * `occurrence` is the atom's ordinal among the same-titled atoms of the SAME
 * extraction (0 for the first). One document can yield two distinct atoms that
 * share a title; without the ordinal both hash alike and the second putPage
 * overwrites the first. Counting per title rather than per atom keeps the
 * discriminator stable — the sole atom titled T is always occurrence 0,
 * whatever else the model returned alongside it and in what order.
 */
export function atomPageSlug(
  sourceRef: string,
  sourceDate: string,
  title: string,
  occurrence = 0,
): string {
  const identity = createHash("sha256")
    .update(`${sourceRef}\n${title}\n${occurrence}`)
    .digest("hex")
    .slice(0, 8);
  return `atoms/${sourceDate}/${slugifyTitle(title)}-${identity}`;
}

/**
 * Parse the LLM JSON response into atoms. Tolerant of fence wrapping and
 * leading/trailing prose; rejects (returns []) on hard parse failure or
 * invalid shape. Never throws.
 */
export function parseAtomsResponse(raw: string): ParsedAtom[] {
  const parsed = parseModelJson(raw, "[");
  if (!Array.isArray(parsed)) return [];

  const out: ParsedAtom[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.slice(0, 200).trim() : "";
    const body = typeof o.body === "string" ? o.body.trim() : "";
    if (!title || !body) continue;
    const rawType = typeof o.atom_type === "string" ? o.atom_type : "";
    const atom_type: AtomType = (ATOM_TYPES as readonly string[]).includes(rawType)
      ? (rawType as AtomType)
      : "insight";
    const concepts = Array.isArray(o.concepts)
      ? o.concepts
          .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
          .map((c) => c.trim().toLowerCase())
          .slice(0, 5)
      : [];
    const source_quote =
      typeof o.source_quote === "string" && o.source_quote.trim().length > 0
        ? o.source_quote.trim().slice(0, 200)
        : undefined;
    const lesson =
      typeof o.lesson === "string" && o.lesson.trim().length > 0
        ? o.lesson.trim().slice(0, 300)
        : undefined;
    out.push({
      title,
      atom_type,
      body,
      concepts,
      ...(source_quote !== undefined ? { source_quote } : {}),
      ...(lesson !== undefined ? { lesson } : {}),
    });
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * True only when `raw` is a cleanly parsed EMPTY JSON array — the well-behaved
 * "nothing worth distilling here" answer. `parseAtomsResponse` returns [] for
 * that AND for malformed / truncated / prose output, so the zero-yield
 * tombstone needs the stricter test: memoizing a transient parse failure would
 * permanently suppress a document that does carry atoms. It is
 * deliberately stricter than `parseAtomsResponse` (which reads through the
 * shared decoder): only a closed fence is unwrapped and nothing is salvaged, so
 * a reply the decoder would still read — an unclosed fence, a thinking block —
 * stays retryable rather than being memoized as empty.
 *
 * The whole (de-fenced, trimmed) response has to BE the empty array. Seeking
 * to the first `[` the way the tolerant parser does would read
 * "Unable to parse the source; returning fallback []" as a clean extraction —
 * a model announcing its own failure, then stamped into the document's
 * frontmatter and never scanned again. Prose around the array is a parse
 * failure, and a parse failure must stay retryable.
 */
function parseCompleteAtoms(raw: string): ParsedAtom[] | null {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    const fence = cleaned.match(/^```(?:json)?([\s\S]*)```$/);
    if (!fence) return null;
    cleaned = fence[1]!.trim();
  }
  let value: unknown;
  try { value = JSON.parse(cleaned); } catch { return null; }
  if (!Array.isArray(value) || value.length > 3) return null;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const atom = item as Record<string, unknown>;
    if (typeof atom.title !== "string" || !atom.title.trim() || atom.title.length > 200 ||
        typeof atom.body !== "string" || !atom.body.trim()) return null;
    if (atom.atom_type !== undefined && !(ATOM_TYPES as readonly unknown[]).includes(atom.atom_type)) return null;
    if (atom.concepts !== undefined && (!Array.isArray(atom.concepts) || atom.concepts.length > 5 ||
        atom.concepts.some((concept: unknown) => typeof concept !== "string" || !concept.trim()))) return null;
    if (atom.source_quote !== undefined && (typeof atom.source_quote !== "string" || atom.source_quote.length > 200)) return null;
    if (atom.lesson !== undefined && (typeof atom.lesson !== "string" || atom.lesson.length > 300)) return null;
  }
  return parseAtomsResponse(JSON.stringify(value));
}

export function isWellFormedEmptyExtraction(raw: string): boolean {
  return parseCompleteAtoms(raw)?.length === 0;
}

/**
 * Discover documents that still need atom extraction: live documents with
 * enough body text without completion for their current hash. Legacy sources
 * without a completion manifest retain their atom-row/zero-yield skip.
 *
 * memrain stores body text in `chunks`, not on `documents`, so the per-document
 * text is the concatenation of its chunks (ordered). Soft-deleted documents
 * (migration 040 added `deleted_at`) are excluded, and so are quarantined
 * ones: text the gate hid from search must not come back as an atom.
 */
async function discoverDocuments(
  engine: Engine,
  maxDocs: number,
  model: string,
): Promise<SourceDoc[]> {
  const { rows } = await engine.query<{
    id: string;
    text: string;
    source_id: string | null;
    source_date: string;
    frontmatter: Record<string, unknown> | null;
  }>(
    `SELECT d.id, d.source_id, d.frontmatter,
            COALESCE(d.effective_date, d.ingested_at)::date::text AS source_date,
            string_agg(c.content, E'\n\n' ORDER BY c.chunk_index) AS text
       FROM documents d
       JOIN chunks c ON c.document_id = d.id
      WHERE d.deleted_at IS NULL
        AND ${quarantineFilterFragment("d")}
        AND ${notSynthesizedDocSql("d")}
      GROUP BY d.id, d.source_id, d.effective_date, d.ingested_at
      ORDER BY MAX(d.updated_at) DESC`,
  );

  const candidates: SourceDoc[] = [];
  for (const r of rows) {
    const text = r.text ?? "";
    if (text.length < MIN_DOC_CHARS) continue;
    candidates.push({
      id: r.id,
      text,
      contentHash16: contentHash16(text),
      sourceId: r.source_id,
      sourceDate: r.source_date,
      frontmatter: r.frontmatter ?? {},
    });
  }
  if (candidates.length === 0) return [];

  // Batch idempotency: which (source_ref, source_hash) PAIRS have already been
  // extracted — either they produced atoms, or they were scanned and produced
  // none (the `atoms_scan_hash` stamp; without it a zero-yield document is
  // rediscovered and re-paid for every run, and since the candidate list is
  // recency-ordered a stable set of them can hold every slot forever).
  // Pair via unnest so the match is on the tuple, not the cross-product of the
  // two ANY() arrays (a doc whose hash coincides with another doc's hash must
  // NOT be falsely marked done). The stamp is compared against the hash we just
  // computed, so an edited note falls out of the match and is re-scanned.
  const refs = candidates.map((c) => c.id);
  const hashes = candidates.map((c) => c.contentHash16);
  const { rows: existing } = await engine.query<{ source_ref: string; source_hash: string }>(
    `SELECT w.source_ref, w.source_hash
       FROM unnest($1::text[], $2::text[]) AS w(source_ref, source_hash)
      WHERE EXISTS (
              SELECT 1 FROM synth_atoms a
               WHERE a.source_ref = w.source_ref
                 AND a.source_hash = w.source_hash
                 AND a.source_kind = 'document')
         OR EXISTS (
              SELECT 1 FROM documents d
               WHERE d.id = w.source_ref
                 AND COALESCE(d.frontmatter->>'atoms_scan_hash', '') = w.source_hash)`,
    [refs, hashes],
  );
  const done = new Set(existing.map((e) => `${e.source_ref} ${e.source_hash}`));

  const fresh = candidates.filter((c) => {
    const completion = readAtomCompletion(c.frontmatter);
    return completion ? completion.hash !== c.contentHash16 : !done.has(`${c.id} ${c.contentHash16}`);
  });
  // Before the slice, so a document parked after a failed call gives up its slot.
  return (await filterBackedOff(engine, "extract_atoms", fresh, model)).slice(0, maxDocs);
}

interface StagedAtom extends ParsedAtom {
  key: string;
  slug: string;
}

function stageAtoms(atoms: ParsedAtom[], doc: SourceDoc): StagedAtom[] {
  const occurrences = new Map<string, number>();
  return atoms.map((atom) => {
    const occurrence = occurrences.get(atom.title) ?? 0;
    occurrences.set(atom.title, occurrence + 1);
    return { ...atom, key: atomKey(doc.id, doc.contentHash16, atom.body),
      slug: atomPageSlug(doc.id, doc.sourceDate, atom.title, occurrence) };
  });
}

async function previousAtomCount(engine: Engine, doc: SourceDoc): Promise<number> {
  const previous = readAtomCompletion(doc.frontmatter);
  const { rows } = await engine.query<{ count: number }>(
    `SELECT COALESCE(max(n), 0)::int AS count FROM (
       SELECT count(*) AS n FROM synth_atoms WHERE source_ref = $1 AND source_kind = 'document'
         AND ($2::text IS NULL OR source_hash = $2) GROUP BY source_hash
     ) counts`, [doc.id, previous?.hash ?? null],
  );
  return Number(rows[0]!.count);
}

async function writeAtomPage(storage: Storage, doc: SourceDoc, atom: StagedAtom): Promise<AtomPageSnapshot | { held: string }> {
  const current = await readCurrentAtomPage(storage.engine(), atom.slug);
  if (current && (current.deleted || current.source_id !== doc.sourceId || !current.automatic ||
      current.origin?.source_ref !== doc.id || current.origin.source_id !== doc.sourceId ||
      !current.origin.source_hash || !current.origin.atom_key)) return { held: current.legacy ? "held_legacy" : "authored_edit" };
  const origin = { source_ref: doc.id, source_hash: doc.contentHash16, source_id: doc.sourceId, atom_key: atom.key };
  const body = [atom.body, atom.source_quote ? `\n> ${atom.source_quote}` : "",
    atom.lesson ? `\n**Lesson:** ${atom.lesson}` : "", `\n---\nSource: ${doc.id} (${doc.contentHash16})`].filter(Boolean).join("\n");
  await phaseFenceCheck();
  const result = await putPage(storage, {
    slug: atom.slug, type: "atom", allowAdHocType: true, title: atom.title, markdown_body: body,
    compiled_truth: { atom_origin: origin }, source_id: doc.sourceId!, written_by: "extract-atoms",
    written_by_principal: "operator",
    onlyOverwriteWriter: "extract-atoms", expectedVersion: current?.version ?? 0,
    expectedOriginDocument: { id: doc.id, sourceId: doc.sourceId, contentHash: doc.contentHash16 },
    ...(current ? { expectedAtomPage: { sourceRef: doc.id, sourceHash: current.origin!.source_hash!,
      atomKey: current.origin!.atom_key!, contentHash: current.hash } } : {}),
  });
  if (result.held === "source_busy") throw new Error("atom page publication held: source_busy");
  if (result.held) return { held: result.held };
  return { slug: atom.slug, version: result.version_n, hash: result.content_hash, atom_key: atom.key, source_hash: doc.contentHash16 };
}

async function publishAtoms(engine: Engine, doc: SourceDoc, atoms: StagedAtom[], modelId: string,
  pages: AtomPageSnapshot[]): Promise<void> {
  await phaseFenceCheck();
  await engine.transaction(async (tx) => {
    const source = { id: doc.id, sourceId: doc.sourceId, contentHash: doc.contentHash16 };
    const current = await lockAtomSource(tx, source);
    if (readAtomCompletion(current)?.hash !== readAtomCompletion(doc.frontmatter)?.hash) {
      throw new Error("atom completion changed during extraction");
    }
    await validateCompletedPages(tx, source, pages);
    for (const atom of atoms) {
      await tx.query(
        `INSERT INTO synth_atoms
           (atom_key, source_ref, source_kind, source_hash, title, body, atom_type, concepts, source_quote, lesson, model_id)
         VALUES ($1, $2, 'document', $3, $4, $5, $6, $7::text::jsonb, $8, $9, $10)
         ON CONFLICT (atom_key) DO NOTHING`,
        [atom.key, doc.id, doc.contentHash16, atom.title, atom.body, atom.atom_type,
          JSON.stringify(atom.concepts), atom.source_quote ?? null, atom.lesson ?? null, modelId],
      );
    }
    await tx.query(
      `UPDATE documents SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || $2::text::jsonb WHERE id = $1`,
      [doc.id, JSON.stringify({ atoms_completed_hash: doc.contentHash16, atoms_completed_pages: pages,
        ...(atoms.length === 0 ? { atoms_scan_hash: doc.contentHash16 } : {}) })],
    );
  });
}

export async function extractAtomsPhase(
  engine: Engine,
  opts: ExtractAtomsOptions = {},
): Promise<ExtractAtomsResult> {
  const maxDocs = opts.maxDocs ?? DEFAULT_MAX_DOCS;
  const llm = resolveLlmFn(opts.llmFn, opts.modelId ? { modelId: opts.modelId } : {});
  const writePages = opts.storage !== undefined && synthPagesEnabled();
  const result: ExtractAtomsResult = {
    documentsScanned: 0, documentsProcessed: 0, atomsWritten: 0, pagesWritten: 0,
    quotesDropped: 0, pagesHeld: 0, pagesRetired: 0, heldPages: [], errors: [],
  };
  const backoffModel = resolveModel("utility", opts.modelId);
  const docs = await discoverDocuments(engine, maxDocs, backoffModel);
  result.documentsScanned = docs.length;
  let retirementTargets = 0;

  for (const doc of docs) {
    await phaseFenceCheck();
    let failureKind: "llm_error" | "unparseable" | "truncated" = "llm_error";
    try {
      if (writePages && doc.sourceId === null) throw new Error("atom page publication held: unknown_source");
      const prompt = sanitizeForPrompt(doc.text, MAX_DOC_CHARS_TO_LLM);
      if (doc.text.length > MAX_DOC_CHARS_TO_LLM || prompt.matched.includes("length-cap")) {
        failureKind = "truncated";
        throw new Error("atom extraction held: truncated_input");
      }
      const resp = await llm({ system: SYSTEM_PROMPT,
        user: `Source: ${doc.id}\nObservation date: ${doc.sourceDate}\n\n---\n\n${prompt.text}`, maxTokens: 1200 });
      result.documentsProcessed++;
      failureKind = isTruncated(resp) ? "truncated" : "unparseable";
      const parsed = !isTruncated(resp) && !TERMINAL_STOP_REASONS.has(resp.stopReason ?? "") ? parseCompleteAtoms(resp.text) : null;
      if (parsed === null) throw new Error("extractor output not parseable as complete atoms; retried after backoff");
      const previousCount = await previousAtomCount(engine, doc);
      if (previousCount > 0 && (parsed.length === 0 || parsed.length * 2 < previousCount)) {
        throw new Error("atom extraction held: held_shrink");
      }
      const atoms = stageAtoms(parsed.map((atom): ParsedAtom => {
        if (atom.source_quote === undefined || isQuoteInText(atom.source_quote, doc.text)) return atom;
        result.quotesDropped++;
        const { source_quote: _dropped, ...rest } = atom;
        return rest;
      }), doc);
      if (new Set(atoms.map((atom) => atom.key)).size !== atoms.length) {
        throw new Error("atom extraction held: duplicate_identity");
      }
      await engine.transaction(async (tx) => {
        await lockAtomSource(tx, { id: doc.id, sourceId: doc.sourceId, contentHash: doc.contentHash16 });
      });
      const pages: AtomPageSnapshot[] = [];
      if (writePages && opts.storage) {
        for (const atom of atoms) {
          const page = await writeAtomPage(opts.storage, doc, atom);
          if ("held" in page) {
            result.pagesHeld++;
            if (result.heldPages.length < 100) result.heldPages.push({ slug: atom.slug, reason: page.held });
          } else { pages.push(page); result.pagesWritten++; }
        }
      }
      await publishAtoms(engine, doc, atoms, resp.modelId, pages);
      result.atomsWritten += atoms.length;
      await phaseFenceCheck();
      await clearSynthFailure(engine, doc.id, "extract_atoms");
      if (writePages && opts.storage) {
        const keep = new Set(atoms.map((atom) => atom.slug));
        const obsolete = (readAtomCompletion(doc.frontmatter)?.pages ?? []).filter((page) => !keep.has(page.slug));
        const selected = obsolete.slice(0, 100 - retirementTargets);
        retirementTargets += selected.length;
        const capped = obsolete.slice(selected.length);
        result.pagesHeld += capped.length;
        result.heldPages.push(...capped.map((page) => ({ slug: page.slug, reason: "retirement_limit" }))
          .slice(0, 100 - result.heldPages.length));
        const retirement = await retireCompletedAtomPages(opts.storage,
          { id: doc.id, sourceId: doc.sourceId, contentHash: doc.contentHash16 },
          selected, keep);
        result.pagesRetired += retirement.retired;
        result.pagesHeld += retirement.held;
        result.heldPages.push(...retirement.targets.filter((page) => page.status === "held")
          .map((page) => ({ slug: page.slug, reason: page.reason! })).slice(0, 100 - result.heldPages.length));
      }
    } catch (error) {
      if (error instanceof PhaseStoppedError) throw error;
      result.errors.push(`${doc.id}: ${error instanceof Error ? error.message : String(error)}`);
      await phaseFenceCheck();
      await recordSynthFailure(engine, { docId: doc.id, phase: "extract_atoms", contentHash: doc.contentHash16,
        model: backoffModel, kind: failureKind });
    }
  }
  return result;
}
