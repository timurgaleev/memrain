/**
 * extract_atoms synthesis phase — per-source distillation of corpus documents
 * into atomic claims ("atoms"), written ONLY to `synth_atoms`.
 *
 * Architecture guard: this phase READS from `documents` + `chunks` (the
 * authored vault) and WRITES to `synth_atoms`, plus an
 * `atoms/<source-date>/<slug>` page mirror per atom (via putPage) so atoms are
 * retrievable through normal search. The page write needs a Storage handle and
 * can be disabled with MEMRAIN_SYNTH_PAGES=0. Source notes remain sacrosanct:
 * the only thing this phase writes back to `documents` is the zero-yield
 * `atoms_scan_hash` frontmatter stamp; chunk text is never touched.
 *
 * Safety properties:
 *   - opt-in: only runs when the cycle requests the "extract-atoms" phase.
 *   - budget-capped: at most `maxDocs` documents per run (cost guard).
 *   - idempotent: each atom keys on hash(source_ref + source_hash + body); an
 *     unchanged document re-runs to a no-op via ON CONFLICT DO NOTHING, and the
 *     per-doc discovery skips documents that already have an atom — or a
 *     zero-yield `atoms_scan_hash` stamp — for the current content hash.
 *   - fail-open: an LLM error on one document logs + skips that document; the
 *     phase continues and never corrupts the brain.
 *
 * The LLM is injected via `opts.llmFn` (see core/llm/haiku.ts). Tests pass a
 * fake; production resolves `callHaiku`. NO live Bedrock in tests.
 *
 * Written for memrain's flat single-source vault (no source_id) and
 * own-namespace tables.
 */
import { createHash } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import type { Storage } from "../storage.ts";
import { putPage } from "../pages.ts";
import { resolveLlmFn, type LlmFn } from "../llm/haiku.ts";
import { sanitizeForPrompt } from "../llm/sanitize.ts";
import { parseModelJson } from "../llm/json-output.ts";
import { isQuoteInText } from "./quote-verify.ts";
import { resolveModel } from "../llm/resolve-model.ts";
import { clearSynthFailure, filterBackedOff, recordSynthFailure } from "./synth-failures.ts";

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
export function isWellFormedEmptyExtraction(raw: string): boolean {
  let cleaned = raw.trim();
  if (cleaned.length === 0) return false;
  // No `\s*` after the language tag: the capture is trimmed on the next line,
  // and with it the two quantifiers trade characters on an unclosed fence —
  // measured 1.2 ms at 2 K to 60.8 ms at 16 K, ratio ~4.0 per doubling.
  const fence = cleaned.match(/```(?:json)?([\s\S]*?)```/);
  if (fence && fence[1] !== undefined) cleaned = fence[1].trim();
  try {
    const parsed: unknown = JSON.parse(cleaned);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
}

/**
 * Discover documents that still need atom extraction: live documents with
 * enough body text whose current content hash has NO atom row and NO zero-yield
 * scan stamp yet. One SQL round-trip; the EXISTS pair is the idempotency
 * filter.
 *
 * memrain stores body text in `chunks`, not on `documents`, so the per-document
 * text is the concatenation of its chunks (ordered). Soft-deleted documents
 * (migration 040 added `deleted_at`) are excluded.
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
  }>(
    `SELECT d.id, d.source_id,
            COALESCE(d.effective_date, d.ingested_at)::date::text AS source_date,
            string_agg(c.content, E'\n\n' ORDER BY c.chunk_index) AS text
       FROM documents d
       JOIN chunks c ON c.document_id = d.id
      WHERE d.deleted_at IS NULL
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

  const fresh = candidates.filter((c) => !done.has(`${c.id} ${c.contentHash16}`));
  // Before the slice, so a document parked after a failed call gives up its slot.
  return (await filterBackedOff(engine, "extract_atoms", fresh, model)).slice(0, maxDocs);
}

/**
 * Stamp "this exact content was scanned and produced nothing" into the source
 * document's frontmatter so it stops re-entering the discovery window. Only
 * called for a CLEAN empty extraction — an LLM error takes the catch path and
 * malformed output fails `isWellFormedEmptyExtraction`; both stay retryable.
 *
 * The stamp holds the hash of the text we scanned and discovery skips the
 * document only while that still matches, so editing the note re-eligibilizes
 * it; that mirrors how a content change invalidates the atom rows. Merging into
 * the existing jsonb keeps the authored frontmatter intact; unlike the pages
 * analogue the column is nullable here, hence the COALESCE.
 */
async function stampZeroYieldScan(engine: Engine, doc: SourceDoc): Promise<void> {
  await engine.query(
    `UPDATE documents
        SET frontmatter = COALESCE(frontmatter, '{}'::jsonb)
                          || jsonb_build_object('atoms_scan_hash', $1::text)
      WHERE id = $2 AND deleted_at IS NULL`,
    [doc.contentHash16, doc.id],
  );
}

export async function extractAtomsPhase(
  engine: Engine,
  opts: ExtractAtomsOptions = {},
): Promise<ExtractAtomsResult> {
  const maxDocs = opts.maxDocs ?? DEFAULT_MAX_DOCS;
  const llm = resolveLlmFn(opts.llmFn, opts.modelId ? { modelId: opts.modelId } : {});
  const writePages = opts.storage !== undefined && synthPagesEnabled();
  const result: ExtractAtomsResult = {
    documentsScanned: 0,
    documentsProcessed: 0,
    atomsWritten: 0,
    pagesWritten: 0,
    quotesDropped: 0,
    errors: [],
  };

  // The model the backoff is keyed on — the one `llm` will call.
  const backoffModel = resolveModel("utility", opts.modelId);
  const docs = await discoverDocuments(engine, maxDocs, backoffModel);
  result.documentsScanned = docs.length;

  for (const doc of docs) {
    let text: string;
    let modelId: string;
    try {
      const resp = await llm({
        system: SYSTEM_PROMPT,
        // Note body is untrusted — strip injection phrases + cap before the LLM.
        user: `Source: ${doc.id}\nObservation date: ${doc.sourceDate}\n\n---\n\n${sanitizeForPrompt(doc.text, MAX_DOC_CHARS_TO_LLM).text}`,
        maxTokens: 1200,
      });
      text = resp.text;
      modelId = resp.modelId;
    } catch (e) {
      // Fail-open: log + skip this document, never abort the phase.
      result.errors.push(`${doc.id}: ${e instanceof Error ? e.message : String(e)}`);
      await recordSynthFailure(engine, {
        docId: doc.id, phase: "extract_atoms", contentHash: doc.contentHash16, model: backoffModel, kind: "llm_error",
      });
      continue;
    }

    // A source_quote the note does not contain is made up; drop it rather
    // than store it as a verbatim line.
    const atoms = parseAtomsResponse(text).map((atom): ParsedAtom => {
      if (atom.source_quote === undefined || isQuoteInText(atom.source_quote, doc.text)) return atom;
      result.quotesDropped += 1;
      const { source_quote: _dropped, ...rest } = atom;
      return rest;
    });
    result.documentsProcessed += 1;
    if (atoms.length > 0 || isWellFormedEmptyExtraction(text)) {
      await clearSynthFailure(engine, doc.id, "extract_atoms");
    }
    if (atoms.length === 0) {
      // Only a cleanly parsed `[]` is a genuine zero-yield note.
      // parseAtomsResponse also returns [] for malformed or truncated output,
      // and tombstoning that would permanently suppress a document that does
      // carry atoms, so that case is logged and retried after a backoff.
      if (!isWellFormedEmptyExtraction(text)) {
        result.errors.push(
          `${doc.id}: extractor output not parseable as atoms; not memoized, retried after backoff`,
        );
        await recordSynthFailure(engine, {
          docId: doc.id, phase: "extract_atoms", contentHash: doc.contentHash16, model: backoffModel, kind: "unparseable",
        });
        continue;
      }
      try {
        await stampZeroYieldScan(engine, doc);
      } catch (e) {
        // Fail-soft: the worst case is the pre-fix behaviour — the document
        // stays rediscoverable and costs one more call next run.
        result.errors.push(
          `${doc.id} zero-yield stamp: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      continue;
    }

    // Ordinal per title within this extraction — see atomPageSlug. Assigned
    // before the row write so a transient insert failure can't shift the next
    // same-titled atom onto its neighbour's page.
    const titleOccurrences = new Map<string, number>();

    for (const atom of atoms) {
      const occurrence = titleOccurrences.get(atom.title) ?? 0;
      titleOccurrences.set(atom.title, occurrence + 1);
      const key = atomKey(doc.id, doc.contentHash16, atom.body);
      try {
        await engine.query(
          `INSERT INTO synth_atoms
             (atom_key, source_ref, source_kind, source_hash, title, body, atom_type, concepts, source_quote, lesson, model_id)
           VALUES ($1, $2, 'document', $3, $4, $5, $6, $7::text::jsonb, $8, $9, $10)
           ON CONFLICT (atom_key) DO NOTHING`,
          [
            key, doc.id, doc.contentHash16, atom.title, atom.body, atom.atom_type,
            JSON.stringify(atom.concepts), atom.source_quote ?? null, atom.lesson ?? null, modelId,
          ],
        );
        result.atomsWritten += 1;
      } catch (e) {
        result.errors.push(`${doc.id} atom write: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }

      // Page mirror — storing every atom as a page is what
      // makes atoms retrievable via normal search (the cycle's mirror phase
      // indexes pages into documents/chunks). Idempotent via putPage; a page
      // failure never loses the synth_atoms row.
      if (writePages && opts.storage) {
        // Stable identity only — see atomPageSlug. The old slug folded in the
        // run date and the atom_key (which carries the document's content
        // hash), so editing a source note stranded its atom pages and minted
        // near-duplicates beside them.
        const slug = atomPageSlug(doc.id, doc.sourceDate, atom.title, occurrence);
        const bodyParts = [
          atom.body,
          atom.source_quote ? `\n> ${atom.source_quote}` : "",
          atom.lesson ? `\n**Lesson:** ${atom.lesson}` : "",
          `\n---\nSource: ${doc.id} (${doc.contentHash16})`,
        ].filter(Boolean);
        try {
          await putPage(opts.storage, {
            slug,
            type: "atom",
            allowAdHocType: true,
            title: atom.title,
            markdown_body: bodyParts.join("\n"),
            source_id: doc.sourceId ?? "default",
            written_by: "extract-atoms",
          });
          result.pagesWritten += 1;
        } catch (e) {
          result.errors.push(`${doc.id} atom page: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  return result;
}
