/**
 * What synthesis derived from a source, and what happens to it when the source
 * goes for good (a page or document purge, a connector deletion, or the
 * repair of what older purges left behind).
 *
 * Synthesis keeps everything by reference with no foreign key: atoms name
 * their document or page in `source_ref`, takes name theirs, a concept links
 * its atoms, a contradiction row snapshots a fact, take or page. Nothing else
 * removes them, so a purged note's text would live on in them and come back
 * in search through the atom and concept pages.
 *
 * - Atoms of the source are deleted, and so are the atom pages the atoms phase
 *   published from it (legacy pages, which carry no `atom_origin`, are matched
 *   by the `Source:` line the phase wrote under their body). An atom page
 *   someone edited is kept.
 * - A concept linked to a deleted atom is rebuilt from the members it keeps
 *   (those whose source is still live): its purged links go, its narrative
 *   becomes the deterministic one over the survivors and its member hash is
 *   cleared, so the next concepts run narrates it again. A concept left with
 *   no live member is retired: its row goes and its page is hidden, and the
 *   concepts phase brings it back once live atoms carry the tag again. A
 *   concept page someone edited keeps its text either way.
 * - Takes of the source are deleted (their grades by cascade), and so are the
 *   contradiction rows that snapshot one of them, a retired fact or the page.
 *
 * The plan lists every row with its lineage, action and reason, and hashes
 * them; apply runs exactly a plan computed in the same transaction (the purge
 * paths) or refuses when the reviewed hash no longer matches (the repair).
 */
import { createHash, randomUUID } from "node:crypto";
import type { Engine } from "./engine/interface.ts";
import { hashBody, lockPageSlugs, softDeleteLockedPage } from "./pages.ts";
import { pageSourcePath, pageTruthSourcePath } from "./page-index.ts";
import { bumpClock, bumpDocumentClock, bumpPageGeneration } from "./generation.ts";
import { OperationError } from "./operation-error.ts";

// The atom and concept shapes the synthesis phases of a 2.x brain wrote;
// cleanup rebuilds a concept with the same deterministic text they used.

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

const TIER_T1_MIN = 10;
const TIER_T2_MIN = 5;
export const TIER_T3_MIN = 2;

/** The writer of every concept page version this phase publishes. */
export const CONCEPT_WRITER = "synthesize-concepts";

/** The body of a concept page: the narrative and up to ten member titles. */
export function conceptPageBody(narrative: string, titles: readonly string[]): string {
  const mentions = titles.slice(0, 10).map((t) => `- ${t}`).join("\n");
  return `${narrative}\n\n## Atoms (${titles.length})\n${mentions}\n`;
}

/**
 * Whether the atom `a` (with its document LEFT JOINed as `d`) still has a live
 * source: a document that exists and is not deleted, or a live page.
 */
export function atomSourceLiveSql(a: string, d: string): string {
  // scope: operator-only synthesis rows have no source axis; this only asks whether the source is still live
  return `CASE ${a}.source_kind
            WHEN 'document' THEN ${d}.id IS NOT NULL AND ${d}.deleted_at IS NULL
            WHEN 'page' THEN EXISTS (SELECT 1 FROM pages sp WHERE sp.slug = ${a}.source_ref AND sp.deleted_at IS NULL)
            ELSE true END`;
}

export type ConceptTier = "T1" | "T2" | "T3";

export function tierFor(count: number): ConceptTier {
  if (count >= TIER_T1_MIN) return "T1";
  if (count >= TIER_T2_MIN) return "T2";
  return "T3";
}

/** A concept's display name: the last slug segment, hyphens as spaces. */
export function conceptName(slug: string): string {
  return (slug.split("/").pop() ?? slug).replace(/-/g, " ");
}

/**
 * Deterministic narrative for T3 groups (and LLM-failure fallback). It names
 * the concept: one atom carries several concept tags, so two concepts often
 * share their atoms, and without the name their pages would be byte-identical
 * and their search text would never say which concept it is.
 */
export function deterministicNarrative(group: { slug: string; tier: ConceptTier; titles: readonly string[] }): string {
  const n = group.titles.length;
  const top = group.titles.slice(0, 5).map((t) => `- ${t}`).join("\n");
  return `${group.tier} concept "${conceptName(group.slug)}". ${n} atom${n === 1 ? "" : "s"} reference this.\nTop mentions:\n${top}`;
}

/** A contradiction row snapshotting one of the facts `$1`, takes `$2` or pages `$3`. */
const CONTRADICTION_REFS = `(a_kind = 'fact' AND a_ref = ANY($1::text[])) OR (b_kind = 'fact' AND b_ref = ANY($1::text[]))
   OR (a_kind = 'take' AND a_ref = ANY($2::text[])) OR (b_kind = 'take' AND b_ref = ANY($2::text[]))
   OR (a_kind = 'page' AND a_ref = ANY($3::text[])) OR (b_kind = 'page' AND b_ref = ANY($3::text[]))`;

/** The parts of a connector delete's counts that synthesis cleanup adds to. */
export interface SynthesisCounts {
  atoms: number;
  takes: number;
  contradictions: number;
  concepts: number;
}

/**
 * Delete what synthesis distilled from the documents `docIds` and the pages
 * `slugs`, inside `tx`, adding to `counts`: atoms, takes, concepts narrated
 * over a doomed atom, and the contradiction rows that snapshot one of
 * `factIds`, a doomed take or one of the pages. Returns the concepts deleted.
 * A caller that rebuilds concepts unlinks the doomed atoms first, so none is
 * deleted here.
 */
export async function deleteSynthesisDerived(
  tx: Engine,
  docIds: readonly string[],
  slugs: readonly string[],
  factIds: readonly string[],
  counts: SynthesisCounts,
): Promise<string[]> {
  const doomedAtoms = `SELECT id FROM synth_atoms
     WHERE (source_kind = 'document' AND source_ref = ANY($1::text[])) OR (source_kind = 'page' AND source_ref = ANY($2::text[]))`;
  const concepts = (await tx.query<{ concept_slug: string }>(
    `DELETE FROM synth_concepts WHERE concept_slug IN (
       SELECT ca.concept_slug FROM synth_concept_atoms ca WHERE ca.atom_id IN (${doomedAtoms}))
     RETURNING concept_slug`,
    [[...docIds], [...slugs]])).rows.map(r => r.concept_slug);
  counts.concepts += concepts.length;
  counts.atoms += (await tx.query<{ n: number }>(
    `WITH d AS (DELETE FROM synth_atoms WHERE id IN (${doomedAtoms}) RETURNING 1) SELECT count(*)::int AS n FROM d`,
    [[...docIds], [...slugs]])).rows[0]?.n ?? 0;
  const takeKeys = (await tx.query<{ take_key: string }>(
    `DELETE FROM synth_takes WHERE source_ref = ANY($1::text[]) RETURNING take_key`,
    [[...docIds, ...slugs]])).rows.map(r => r.take_key);
  counts.takes += takeKeys.length;
  const pairs = (await tx.query<{ pair_key: string }>(
    `DELETE FROM synth_contradictions WHERE ${CONTRADICTION_REFS} RETURNING pair_key`,
    [[...factIds], takeKeys, [...slugs]])).rows.map(r => r.pair_key);
  counts.contradictions += pairs.length;
  if (pairs.length > 0) await tx.query(`DELETE FROM synth_contradiction_verdicts WHERE pair_key = ANY($1::text[])`, [pairs]);
  return concepts;
}

/** The source a legacy atom page names on the `Source:` line under its body. */
const ATOM_PAGE_SOURCE = `COALESCE(p.compiled_truth #>> '{atom_origin,source_ref}',
  CASE WHEN NOT p.compiled_truth ? 'atom_origin' THEN substring(p.markdown_body from 'Source: (\\S+) [(]') END)`;

export const ATOM_PAGE_WRITER = "extract-atoms";
const ATOM_RETIRE_WRITER = "extract-atoms:retired";

/** The documents a page's search mirror was indexed as, by the indexer's id scheme. */
export function pageMirrorDocIds(slug: string, sourceId: string): string[] {
  return [pageSourcePath(slug, sourceId), pageTruthSourcePath(slug, sourceId)]
    .map((path) => `doc_${createHash("sha256").update(path).digest("hex").slice(0, 16)}`);
}

export type CleanupAction = "retire" | "regenerate" | "keep";

export interface PlannedPage { slug: string; source_id: string; content_hash: string; action: CleanupAction; reason: string }
export interface PlannedAtom { id: number; atom_key: string; source_kind: string; source_ref: string; title: string; digest: string; action: "retire"; reason: string }
export interface PlannedAtomPage extends PlannedPage { source_ref: string }
export interface PlannedConcept {
  concept_slug: string;
  /** md5 of the stored narrative, so a concept re-narrated after the preview changes the plan. */
  narrative_digest: string;
  action: "regenerate" | "retire";
  reason: string;
  removed_atom_ids: number[];
  surviving_atom_ids: number[];
  page: PlannedPage | null;
}
export interface PlannedTake { id: number; take_key: string; source_ref: string; status: string; digest: string; action: "retire"; reason: string }
export interface PlannedContradiction { pair_key: string; digest: string; action: "retire"; reason: string }
export interface PlannedFact { id: number; entity_slug: string; page_slug: string; source_id: string; digest: string; action: "retire" | "keep"; reason: string }

export interface DerivedCleanupPlan {
  mode: "scope" | "orphans";
  /** The gone sources everything below derives from: document ids and page slugs. */
  source_refs: string[];
  /** Fact ids retired with the sources, whose contradiction rows go too. */
  fact_refs: string[];
  atoms: PlannedAtom[];
  atom_pages: PlannedAtomPage[];
  concepts: PlannedConcept[];
  takes: PlannedTake[];
  contradictions: PlannedContradiction[];
  facts: PlannedFact[];
  summary: Record<"atoms" | "atom_pages" | "concepts" | "concept_pages" | "takes" | "contradictions" | "facts", Partial<Record<CleanupAction, number>>>;
  /** Rows the apply retires (deletes, hides or retires), over every kind. */
  retire_total: number;
  plan_hash: string;
}

export type DerivedCleanupScope =
  | { docIds: readonly string[]; pageSlugs: readonly string[]; factIds?: readonly string[] }
  | { orphans: true };

/**
 * Documents nothing holds any more: an atom's or a take's document row is
 * gone, or a live atom page names a document that is gone. A deleted (not yet
 * purged) document is not gone. Page slugs are left to the page purge, which
 * knows the page went: a rename moves a page without its takes, and a think
 * take may be anchored on a slug no page ever had.
 */
async function goneSourceRefs(engine: Engine): Promise<string[]> {
  const r = await engine.query<{ ref: string }>(
    // scope: operator-only synthesis output has no source axis; the sources these rows derive from are gone
    `SELECT a.source_ref AS ref FROM synth_atoms a
      WHERE a.source_kind = 'document' AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = a.source_ref)
     UNION
     SELECT t.source_ref FROM synth_takes t
      WHERE t.source_ref ~ '^doc_[0-9a-f]{16}$' AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = t.source_ref)
        AND NOT EXISTS (SELECT 1 FROM pages sp WHERE sp.slug = t.source_ref)
     UNION
     SELECT ${ATOM_PAGE_SOURCE} FROM pages p
      WHERE p.deleted_at IS NULL AND p.type = 'atom' AND p.slug LIKE 'atoms/%' AND ${ATOM_PAGE_SOURCE} ~ '^doc_[0-9a-f]{16}$'
        AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = ${ATOM_PAGE_SOURCE})
     ORDER BY 1`,
  );
  return r.rows.map((row) => row.ref);
}

/** A live page at `slug` and whether every version of it was written by `writer` (and it is of `type`). */
async function automaticPage(engine: Engine, slug: string, type: string, writer: string): Promise<{ page: Omit<PlannedPage, "action" | "reason">; automatic: boolean } | null> {
  const r = await engine.query<{ slug: string; source_id: string; content_hash: string; automatic: boolean }>(
    // scope: operator-only a concept page is the brain-wide synthesis output for its slug
    `SELECT p.slug, p.source_id, p.content_hash,
            (p.type = $2 AND NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.slug = p.slug AND v.written_by IS DISTINCT FROM $3)) AS automatic
       FROM pages p WHERE p.slug = $1 AND p.deleted_at IS NULL`,
    [slug, type, writer],
  );
  const row = r.rows[0];
  return row ? { page: { slug: row.slug, source_id: row.source_id, content_hash: row.content_hash }, automatic: row.automatic } : null;
}

function bump(summary: DerivedCleanupPlan["summary"], kind: keyof DerivedCleanupPlan["summary"], action: CleanupAction): void {
  summary[kind][action] = (summary[kind][action] ?? 0) + 1;
}

/** Read-only: what a cleanup of `scope` would do, row by row, with the plan's hash. */
export async function planDerivedCleanup(engine: Engine, scope: DerivedCleanupScope): Promise<DerivedCleanupPlan> {
  const orphans = "orphans" in scope;
  // Document ids and page slugs never collide, so one list serves as both.
  const refs = orphans ? await goneSourceRefs(engine) : [...new Set([...scope.docIds, ...scope.pageSlugs])].sort();
  const why = orphans ? "its source no longer exists" : "its source was purged";

  const atoms: PlannedAtom[] = (await engine.query<Omit<PlannedAtom, "action" | "reason">>(
    `SELECT id, atom_key, source_kind, source_ref, title, md5(title || E'\n' || body || E'\n' || concepts::text) AS digest FROM synth_atoms
      WHERE (source_kind = 'document' AND source_ref = ANY($1::text[])) OR (source_kind = 'page' AND source_ref = ANY($2::text[]))
      ORDER BY id`, [refs, refs])).rows.map((a) => ({ ...a, id: Number(a.id), action: "retire" as const, reason: why }));
  const doomed = atoms.map((a) => a.id);

  const atomPages: PlannedAtomPage[] = [];
  if (refs.length > 0) {
    const rows = (await engine.query<{ slug: string; source_id: string; content_hash: string; source_ref: string; automatic: boolean }>(
      // scope: operator-only atom pages published from sources that are gone, in whatever source they were published
      `SELECT p.slug, p.source_id, p.content_hash, ${ATOM_PAGE_SOURCE} AS source_ref,
              NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.slug = p.slug AND v.written_by IS DISTINCT FROM $2) AS automatic
         FROM pages p
        WHERE p.deleted_at IS NULL AND p.type = 'atom' AND p.slug LIKE 'atoms/%' AND ${ATOM_PAGE_SOURCE} = ANY($1::text[])
        ORDER BY p.slug`, [refs, ATOM_PAGE_WRITER])).rows;
    for (const row of rows) {
      atomPages.push({ slug: row.slug, source_id: row.source_id, content_hash: row.content_hash, source_ref: row.source_ref,
        action: row.automatic ? "retire" : "keep",
        reason: row.automatic ? `published from ${row.source_ref}, ${why}` : "someone edited this atom page" });
    }
  }

  const concepts: PlannedConcept[] = [];
  if (doomed.length > 0) {
    const linked = (await engine.query<{ concept_slug: string; atom_ids: Array<number | string>; narrative_digest: string | null }>(
      `SELECT ca.concept_slug, array_agg(ca.atom_id ORDER BY ca.atom_id) AS atom_ids,
              (SELECT md5(c.narrative) FROM synth_concepts c WHERE c.concept_slug = ca.concept_slug) AS narrative_digest
         FROM synth_concept_atoms ca
        WHERE ca.concept_slug IN (SELECT concept_slug FROM synth_concept_atoms WHERE atom_id = ANY($1::bigint[]))
        GROUP BY ca.concept_slug ORDER BY ca.concept_slug`, [doomed])).rows;
    const doomedSet = new Set(doomed);
    for (const row of linked) {
      const all = row.atom_ids.map(Number);
      const surviving = (await engine.query<{ id: number }>(
        // scope: operator-only concept members are brain-wide synthesis rows
        `SELECT a.id FROM synth_atoms a LEFT JOIN documents d ON a.source_kind = 'document' AND d.id = a.source_ref
          WHERE a.id = ANY($1::bigint[]) AND NOT (a.id = ANY($2::bigint[])) AND ${atomSourceLiveSql("a", "d")}
          ORDER BY a.id`, [all, all.filter((id) => doomedSet.has(id))])).rows.map((a) => Number(a.id));
      // The links that go: the purged members and any whose source is hidden;
      // the concepts phase links a hidden member again if its source comes back.
      const survivingSet = new Set(surviving);
      const removed = all.filter((id) => !survivingSet.has(id));
      const action = surviving.length > 0 ? "regenerate" as const : "retire" as const;
      // Only a concept slug already in page form owns `concepts/<slug>`; an
      // older spelling ("api design") shares that page with its canonical row.
      let page: PlannedPage | null = null;
      if (slugifyTitle(row.concept_slug) === row.concept_slug) {
        const found = await automaticPage(engine, `concepts/${row.concept_slug}`, "concept", CONCEPT_WRITER);
        if (found) {
          page = { ...found.page, action: found.automatic ? action : "keep",
            reason: found.automatic ? (action === "retire" ? "every atom it was built from is gone" : "rebuilt from the atoms left")
              : "someone edited this concept page" };
        }
      }
      concepts.push({ concept_slug: row.concept_slug, narrative_digest: row.narrative_digest ?? "", action, removed_atom_ids: removed, surviving_atom_ids: surviving, page,
        reason: action === "retire" ? `all ${all.length} member atom(s) are gone or hidden`
          : `${removed.length} of ${all.length} member atom(s) are gone or hidden` });
    }
  }

  const takes: PlannedTake[] = (await engine.query<Omit<PlannedTake, "action" | "reason">>(
    `SELECT id, take_key, source_ref, status, md5(claim_text || E'\n' || status || E'\n' || active::text) AS digest
       FROM synth_takes WHERE source_ref = ANY($1::text[]) ORDER BY id`,
    [refs])).rows.map((t) => ({ ...t, id: Number(t.id), action: "retire" as const, reason: why }));

  const facts: PlannedFact[] = orphans ? await planLeftoverFacts(engine) : [];
  const factIds = orphans ? facts.filter((f) => f.action === "retire").map((f) => String(f.id)) : [...(scope.factIds ?? [])];
  const contradictions: PlannedContradiction[] = (await engine.query<{ pair_key: string; digest: string }>(
    // scope: operator-only contradiction rows snapshot facts and takes that go with a purged source
    `SELECT pair_key, md5(concat_ws(E'\n', a_text, b_text)) AS digest FROM synth_contradictions WHERE ${CONTRADICTION_REFS} ORDER BY pair_key`,
    [factIds, takes.map((t) => t.take_key), refs])).rows
    .map((c) => ({ pair_key: c.pair_key, digest: c.digest, action: "retire" as const, reason: "it snapshots a retired fact, take or page" }));

  const summary: DerivedCleanupPlan["summary"] = { atoms: {}, atom_pages: {}, concepts: {}, concept_pages: {}, takes: {}, contradictions: {}, facts: {} };
  for (const a of atoms) bump(summary, "atoms", a.action);
  for (const p of atomPages) bump(summary, "atom_pages", p.action);
  for (const c of concepts) {
    bump(summary, "concepts", c.action);
    if (c.page) bump(summary, "concept_pages", c.page.action);
  }
  for (const t of takes) bump(summary, "takes", t.action);
  for (const c of contradictions) bump(summary, "contradictions", c.action);
  for (const f of facts) bump(summary, "facts", f.action);
  const retireTotal = Object.values(summary).reduce((sum, kind) => sum + (kind.retire ?? 0), 0);
  const body = { mode: orphans ? "orphans" as const : "scope" as const, source_refs: refs, fact_refs: factIds, atoms, atom_pages: atomPages, concepts, takes, contradictions, facts };
  return { ...body, summary, retire_total: retireTotal, plan_hash: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

/**
 * Live facts older purges left behind: written on a page (its fence) that no
 * longer exists, or written before a purge a receipt records about the purged
 * page, naming as its source a page that is gone too (ontology observations
 * and facts that name no source stay). A fact naming a gone page
 * only as its source, with no purge record, may come from a rename or an
 * import and is listed but kept.
 */
async function planLeftoverFacts(engine: Engine): Promise<PlannedFact[]> {
  const r = await engine.query<{ id: number; entity_slug: string; page_slug: string; source_id: string; kind: string; digest: string }>(
    // scope: operator-only the operator's repair reads every source's leftovers
    `SELECT f.id, f.entity_slug, f.source_markdown_slug AS page_slug, COALESCE(f.source_id, 'default') AS source_id, 'fence' AS kind, md5(f.fact) AS digest
       FROM entity_facts f
      WHERE f.forgotten_at IS NULL AND f.source_markdown_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.slug = f.source_markdown_slug)
     UNION ALL
     SELECT f.id, f.entity_slug, f.entity_slug, COALESCE(f.source_id, 'default'), 'about', md5(f.fact)
       FROM entity_facts f
      WHERE f.forgotten_at IS NULL AND f.dimension IS NULL AND f.source_markdown_slug IS NULL AND f.source_slug IS NOT NULL
        AND EXISTS (SELECT 1 FROM fact_purge_receipts rc WHERE rc.page_slug = f.entity_slug AND rc.source_id = COALESCE(f.source_id, 'default')
                                                          AND rc.created_at >= f.written_at)
        AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.slug = f.entity_slug)
        AND NOT EXISTS (SELECT 1 FROM pages hp WHERE hp.slug = f.source_slug)
     UNION ALL
     SELECT f.id, f.entity_slug, f.source_slug, COALESCE(f.source_id, 'default'), 'ambiguous', md5(f.fact)
       FROM entity_facts f
      WHERE f.forgotten_at IS NULL AND f.source_markdown_slug IS NULL AND f.source_slug IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.slug = f.source_slug)
        AND NOT EXISTS (SELECT 1 FROM fact_purge_receipts rc WHERE rc.page_slug = f.entity_slug AND rc.source_id = COALESCE(f.source_id, 'default'))
     ORDER BY 1`,
  );
  const reasons: Record<string, string> = {
    fence: "written on a page that no longer exists",
    about: "about a purged page that no other page holds",
    ambiguous: "names a page that no longer exists as its source, with no purge record; kept",
  };
  return r.rows.map((f) => ({ id: Number(f.id), entity_slug: f.entity_slug, page_slug: f.page_slug, source_id: f.source_id, digest: f.digest,
    action: f.kind === "ambiguous" ? "keep" as const : "retire" as const, reason: reasons[f.kind]! }));
}

async function dropPageMirrors(tx: Engine, slug: string, sourceId: string): Promise<number> {
  const r = await tx.query(
    `DELETE FROM documents WHERE source_path = ANY($1::text[]) AND COALESCE(source_id, 'default') = $2 RETURNING id`,
    [[pageSourcePath(slug, sourceId), pageTruthSourcePath(slug, sourceId)], sourceId],
  );
  return r.rows.length;
}

/** Replace a locked page's body as a new version by `writer`; its search mirror goes until the mirror phase rebuilds it. */
async function rewriteLockedPage(tx: Engine, page: PlannedPage, body: string, writer: string, principal: string | null, reason: string): Promise<number> {
  const cur = (await tx.query<{ compiled_truth: unknown; version_n: number }>(
    // scope: upstream the page was locked and checked against the plan
    `SELECT p.compiled_truth, COALESCE((SELECT max(v.version_n) FROM page_versions v WHERE v.slug = p.slug), 0)::int AS version_n
       FROM pages p WHERE p.slug = $1`, [page.slug])).rows[0]!;
  const hashNew = hashBody(body);
  const truth = JSON.stringify(cur.compiled_truth ?? {});
  await tx.query(`UPDATE pages SET markdown_body = $2, content_hash = $3, updated_at = NOW() WHERE slug = $1`, [page.slug, body, hashNew]);
  await tx.query(
    `INSERT INTO page_versions
       (slug, version_n, hash_prev, hash_new, body_snapshot, compiled_truth_snapshot, written_by, source_id, written_by_principal, change_reason)
     VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8, $9, $10)`,
    [page.slug, Number(cur.version_n) + 1, page.content_hash, hashNew, body, truth, writer, page.source_id, principal, reason],
  );
  await bumpPageGeneration(tx, page.slug);
  return dropPageMirrors(tx, page.slug, page.source_id);
}

async function hideLockedPage(tx: Engine, page: PlannedPage, writer: string, reason: string): Promise<number> {
  await softDeleteLockedPage(tx, page, { writtenBy: writer, writtenByPrincipal: null, changeReason: reason });
  return dropPageMirrors(tx, page.slug, page.source_id);
}

export interface DerivedCleanupResult extends SynthesisCounts {
  atom_pages: number;
  concepts_regenerated: number;
  concept_pages: number;
  facts: number;
}

/**
 * Run `plan` inside `tx`. The plan must be current: the pages it touches must
 * still hold the content it read, and the rows it deletes must be exactly the
 * ones it lists, or the whole transaction is refused. `purgeId` names the
 * receipt rows of any fact it retires.
 */
export async function applyDerivedCleanup(tx: Engine, plan: DerivedCleanupPlan, purgeId: string = randomUUID()): Promise<DerivedCleanupResult> {
  const out: DerivedCleanupResult = { atoms: 0, takes: 0, contradictions: 0, concepts: 0, atom_pages: 0, concepts_regenerated: 0, concept_pages: 0, facts: 0 };
  const pages = [...plan.atom_pages, ...plan.concepts.flatMap((c) => c.page ? [c.page] : [])].filter((p) => p.action !== "keep");
  if (pages.length > 0) {
    await lockPageSlugs(tx, ...pages.map((p) => p.slug));
    const now = await tx.query<{ slug: string; content_hash: string }>(
      // scope: upstream the pages the plan names, just locked
      `SELECT slug, content_hash FROM pages WHERE slug = ANY($1::text[]) AND deleted_at IS NULL`, [pages.map((p) => p.slug)]);
    const current = new Map(now.rows.map((r) => [r.slug, r.content_hash]));
    const moved = pages.filter((p) => current.get(p.slug) !== p.content_hash).map((p) => p.slug);
    if (moved.length > 0) {
      throw new OperationError("conflict", `page(s) changed since the cleanup was planned: ${moved.join(", ")}`, "Plan the cleanup again.");
    }
  }
  let mirrors = 0;
  for (const c of plan.concepts) {
    if (c.removed_atom_ids.length > 0) {
      await tx.query(`DELETE FROM synth_concept_atoms WHERE concept_slug = $1 AND atom_id = ANY($2::bigint[])`, [c.concept_slug, c.removed_atom_ids]);
    }
    if (c.action === "retire") {
      await tx.query(`DELETE FROM synth_concepts WHERE concept_slug = $1`, [c.concept_slug]);
      out.concepts++;
      if (c.page?.action === "retire") {
        mirrors += await hideLockedPage(tx, c.page, CONCEPT_WRITER, "every atom this concept was built from was purged");
        out.concept_pages++;
      }
      continue;
    }
    const titles = (await tx.query<{ title: string }>(
      // scope: upstream the surviving members the plan names
      `SELECT title FROM synth_atoms WHERE id = ANY($1::bigint[]) ORDER BY id`, [c.surviving_atom_ids])).rows.map((r) => r.title);
    const tier = tierFor(titles.length);
    const narrative = deterministicNarrative({ slug: c.concept_slug, tier, titles });
    await tx.query(
      `UPDATE synth_concepts SET narrative = $2, tier = $3, atom_count = $4, model_id = 'deterministic', generated_at = NOW(), member_hash = NULL
        WHERE concept_slug = $1`, [c.concept_slug, narrative, tier, titles.length]);
    out.concepts_regenerated++;
    if (c.page?.action === "regenerate") {
      mirrors += await rewriteLockedPage(tx, c.page, conceptPageBody(narrative, titles), CONCEPT_WRITER, "operator",
        "rebuilt from the atoms left after a purge");
      out.concept_pages++;
    }
  }
  for (const p of plan.atom_pages) {
    if (p.action !== "retire") continue;
    mirrors += await hideLockedPage(tx, p, ATOM_RETIRE_WRITER, "the source this atom was distilled from was purged");
    out.atom_pages++;
  }
  const retiredFacts = plan.facts.filter((f) => f.action === "retire");
  if (retiredFacts.length > 0) out.facts = await retireLeftoverFacts(tx, retiredFacts, purgeId);
  const counts: SynthesisCounts = { atoms: 0, takes: 0, contradictions: 0, concepts: 0 };
  await deleteSynthesisDerived(tx, plan.source_refs, plan.source_refs, plan.fact_refs, counts);
  if (counts.atoms !== plan.atoms.length || counts.takes !== plan.takes.length || counts.concepts !== 0 || counts.contradictions !== plan.contradictions.length) {
    throw new OperationError("conflict",
      `synthesis rows changed since the cleanup was planned (atoms ${counts.atoms}/${plan.atoms.length}, takes ${counts.takes}/${plan.takes.length}, contradictions ${counts.contradictions}/${plan.contradictions.length})`,
      "Plan the cleanup again.");
  }
  out.atoms = counts.atoms;
  out.takes = counts.takes;
  out.contradictions = counts.contradictions;
  if (mirrors > 0) await bumpDocumentClock(tx);
  if (out.atoms + out.takes + out.contradictions + out.concepts + out.concepts_regenerated + out.atom_pages + out.facts > 0) await bumpClock(tx);
  return out;
}

async function retireLeftoverFacts(tx: Engine, facts: readonly PlannedFact[], purgeId: string): Promise<number> {
  const r = await tx.query<{ n: number }>(
    `WITH planned AS (
       SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[]) AS g(id, page_slug, source_id)
     ), retired AS (
       UPDATE entity_facts f SET forgotten_at = NOW(), forgotten_cause = 'purge', forgotten_reason = 'purge leftover: ' || g.page_slug
         FROM planned g WHERE f.id = g.id AND f.forgotten_at IS NULL
       RETURNING f.id, g.page_slug, g.source_id
     ), receipts AS (
       INSERT INTO fact_purge_receipts (purge_id, page_slug, source_id, fact_ids)
       SELECT $4::uuid, page_slug, source_id, array_agg(id ORDER BY id) FROM retired GROUP BY page_slug, source_id
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM retired`,
    [facts.map((f) => f.id), facts.map((f) => f.page_slug), facts.map((f) => f.source_id), purgeId],
  );
  const n = r.rows[0]?.n ?? 0;
  if (n !== facts.length) {
    throw new OperationError("conflict", `facts changed since the cleanup was planned (${n}/${facts.length} still live)`, "Plan the cleanup again.");
  }
  return n;
}
