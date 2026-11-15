/**
 * Deletion, retention and disconnect for connector pages.
 *
 * A connector copy is the provider's data, so its deletions are hard: when an
 * item is deleted at the provider, ages out of its retention window, or the
 * owner deletes everything a connector brought in, the page goes with
 * everything derived from it — page history, search documents, chunks and
 * their embeddings, facts written from the page or its chunks, chronicle
 * events drawn from its chunks, links it is the provenance of, the
 * slug-keyed leftovers a purge also clears, and what synthesis distilled from
 * it: atoms, the atom pages the atoms phase published, takes, concepts
 * narrated over a deleted atom and their pages, and the contradiction rows
 * that snapshot a deleted claim. A synthesized page someone edited is kept
 * and counted in the receipt, so human-written text is never destroyed. Facts are deleted, not retired:
 * a retired fact still holds the text.
 *
 * Retention never deletes what a person wrote: a page whose latest connector
 * write was followed by a version an authenticated caller wrote (not one of
 * the brain's own writers; see humanEdited) is detached instead, with its parts.
 * Its compiled truth keeps everything but the connector's claim
 * (`origin: connector_detached`, no `last_activity_at`), so no sweep, upstream
 * deletion or disconnect reaches it again, and the page keeps its text, its
 * history and its untrusted provenance. The detach is a new page version and
 * a text-free `connector-detach` receipt.
 *
 * A page split into parts (`compiled_truth.part_of` names it) goes together
 * with its parts. When a long item shrinks, the parts its new split no longer
 * has go the same way, all in one transaction (deleteStaleParts). Each page goes in its own transaction, which also writes a receipt to the
 * ingest log (`connector-delete`) that holds counts and hashes only — no
 * slug, title, address or text — so the deletion is provable without keeping
 * what was deleted.
 *
 * Every delete is fenced to one account: the source must be a connector
 * source, and the page must be that source's page with compiled truth
 * `origin: connector` and this account's ref. A handwritten page, another
 * account's page or any page elsewhere is refused and left untouched.
 *
 * A sync run that wants to delete more than the guard allows (default 200
 * items, or 5% of the account's pages once a run deletes at least 10) is held
 * until the owner confirms; the guard beats the hard delete. That holds for
 * upstream deletions and for pages aging out of their retention window alike.
 */
import { createHash } from "node:crypto";
import type { Storage } from "../storage.ts";
import type { Engine } from "../engine/interface.ts";
import { lockPageSlugs } from "../pages.ts";
import { leftovers } from "../pages-purge.ts";
import { pageSourcePath, pageTruthSourcePath } from "../page-index.ts";
import { bumpClock, bumpDocumentClock, bumpPageGeneration } from "../generation.ts";
import { logIngest } from "../ingest-log.ts";
import { OperationError } from "../operation-error.ts";
import { deadlockSafeTransaction } from "../retry.ts";
import { slugifyTitle } from "../synthesis/atoms.ts";
import { GENERATORS } from "../search/generated-provenance.ts";
import { shortHash, SOURCE_KIND_FOR, type ConnectorDataKind } from "./model.ts";
import {
  DELETION_STATES,
  heldDeleteCount,
  holdOrphanRetentionDeletes,
  holdRetentionDeletes,
  openNotice,
  releaseRetentionHolds,
  resolveNotice,
  RETENTION_CONFIRMED,
  RETENTION_HELD,
  RETENTION_KEPT,
} from "./sync-store.ts";

export const CONNECTOR_DELETE_SOURCE_TYPE = "connector-delete";
export const CONNECTOR_DETACH_SOURCE_TYPE = "connector-detach";
/** compiled_truth.origin of a connector page a person edited and retention handed over to the brain. */
export const DETACHED_ORIGIN = "connector_detached";
const DETACH_WRITER = "retention-detach";

export type DeleteReason = "provider_deleted" | "retention" | "disconnect" | "part_superseded";

export interface ConnectorScope {
  sourceId: string;
  /** accountRef() of the connected account. */
  accountRef: string;
}

export interface DeleteCounts {
  versions: number;
  documents: number;
  chunks: number;
  embeddings: number;
  facts: number;
  timeline_events: number;
  links: number;
  leftovers: number;
  /** Synthesis atoms distilled from the page's documents, and the atom pages published from them. */
  atoms: number;
  atom_pages: number;
  /** Atom pages claiming the origin that were edited by hand or are not atoms; left in place. */
  atom_pages_kept: number;
  takes: number;
  contradictions: number;
  /** Concepts narrated over a deleted atom (rebuilt by the next concepts run), and their pages. */
  concepts: number;
  concept_pages: number;
  concept_pages_kept: number;
}

export interface HardDeleteResult {
  deleted: boolean;
  /** Why nothing was deleted. */
  refused?: "not_connector_page" | "changed" | "human_edited";
  /** Retention found a person's edit: the page and its parts were detached from the connector instead. */
  detached?: boolean;
  counts: DeleteCounts;
}

const CONNECTOR_SOURCE_KINDS = new Set(Object.values(SOURCE_KIND_FOR));

const EMPTY_COUNTS: DeleteCounts = {
  versions: 0, documents: 0, chunks: 0, embeddings: 0, facts: 0, timeline_events: 0, links: 0, leftovers: 0,
  atoms: 0, atom_pages: 0, atom_pages_kept: 0, takes: 0, contradictions: 0,
  concepts: 0, concept_pages: 0, concept_pages_kept: 0,
};

/** The page predicate every delete shares: this source, a connector page, this account. */
const ownedPageScope = `p.source_id = $1 AND p.compiled_truth->>'origin' = 'connector' AND p.compiled_truth->>'account' = $2`;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

async function assertConnectorSource(engine: Engine, sourceId: string): Promise<void> {
  const r = await engine.query<{ kind: string }>(`SELECT kind FROM sources WHERE id = $1`, [sourceId]);
  const kind = r.rows[0]?.kind;
  if (kind === undefined || !CONNECTOR_SOURCE_KINDS.has(kind)) {
    throw new OperationError(
      "invalid_params",
      `source '${sourceId}' is not a connector source`,
      "Connector deletion runs only on a source of kind mailbox, calendar, chat or meeting.",
    );
  }
}

async function count(tx: Engine, sql: string, params: unknown[]): Promise<number> {
  return (await tx.query<{ n: number }>(sql, params)).rows[0]?.n ?? 0;
}

/**
 * Delete one page and everything derived from it, inside `tx`, adding to
 * `counts`. Returns the ids of the page's search documents.
 */
async function deletePageDerived(tx: Engine, slug: string, sourceId: string, counts: DeleteCounts): Promise<{ docIds: string[]; concepts: string[] }> {
  const paths = [pageSourcePath(slug, sourceId), pageTruthSourcePath(slug, sourceId)];
  const docIds = (await tx.query<{ id: string }>(
    `SELECT id FROM documents WHERE source_path = ANY($1::text[]) AND COALESCE(source_id, 'default') = $2`,
    [paths, sourceId],
  )).rows.map(r => r.id);
  const chunkIds = (await tx.query<{ id: string }>(
    // scope: upstream document ids come from the source-scoped read above
    `SELECT id FROM chunks WHERE document_id = ANY($1::text[])`, [docIds],
  )).rows.map(r => r.id);

  // scope: upstream the slug is a page the caller locked as this source's own; every version of it goes
  counts.versions += await count(tx, `SELECT count(*)::int AS n FROM page_versions WHERE slug = $1`, [slug]);
  counts.embeddings += await count(tx, `SELECT count(*)::int AS n FROM embeddings WHERE chunk_id = ANY($1::text[])`, [chunkIds]);
  counts.chunks += chunkIds.length;
  const factIds = (await tx.query<{ id: string }>(
    `DELETE FROM entity_facts f
      WHERE ((f.source_markdown_slug = $1 OR (f.source_markdown_slug IS NULL AND f.source_slug = $1))
             AND COALESCE(f.source_id, 'default') = $2)
         OR f.source_chunk_id = ANY($3::text[])
     RETURNING f.id::text AS id`,
    [slug, sourceId, chunkIds])).rows.map(r => r.id);
  counts.facts += factIds.length;
  counts.timeline_events += await count(tx,
    // scope: upstream owned slug and its chunk ids; everything drawn from them goes
    `WITH d AS (DELETE FROM timeline_events WHERE slug = $1 OR source_chunk_id = ANY($2::text[]) RETURNING 1)
     SELECT count(*)::int AS n FROM d`,
    [slug, chunkIds]);
  counts.links += await count(tx,
    // scope: upstream links the owned slug is the source or provenance of
    `WITH d AS (DELETE FROM links WHERE source_slug = $1 OR origin_slug = $1 RETURNING 1)
     SELECT count(*)::int AS n FROM d`,
    [slug]);
  // Synthesis keeps what it distils from a document or page by reference, with
  // no foreign key, and snapshots claim text into contradiction rows. A concept
  // narrated over one of the doomed atoms goes too; the next concepts run
  // rebuilds it from the atoms that remain.
  const concepts = (await tx.query<{ concept_slug: string }>(
    `DELETE FROM synth_concepts WHERE concept_slug IN (
       SELECT ca.concept_slug FROM synth_concept_atoms ca JOIN synth_atoms a ON a.id = ca.atom_id
        WHERE a.source_kind = 'document' AND a.source_ref = ANY($1::text[]))
     RETURNING concept_slug`,
    [docIds])).rows.map(r => r.concept_slug);
  counts.concepts += concepts.length;
  counts.atoms += await count(tx,
    `WITH d AS (DELETE FROM synth_atoms WHERE source_kind = 'document' AND source_ref = ANY($1::text[]) RETURNING 1)
     SELECT count(*)::int AS n FROM d`,
    [docIds]);
  const takeKeys = (await tx.query<{ take_key: string }>(
    `DELETE FROM synth_takes WHERE source_ref = ANY($1::text[]) RETURNING take_key`,
    [[...docIds, slug]])).rows.map(r => r.take_key);
  counts.takes += takeKeys.length;
  const pairs = (await tx.query<{ pair_key: string }>(
    `DELETE FROM synth_contradictions
      WHERE (a_kind = 'fact' AND a_ref = ANY($1::text[])) OR (b_kind = 'fact' AND b_ref = ANY($1::text[]))
         OR (a_kind = 'take' AND a_ref = ANY($2::text[])) OR (b_kind = 'take' AND b_ref = ANY($2::text[]))
         OR (a_kind = 'page' AND a_ref = $3) OR (b_kind = 'page' AND b_ref = $3)
     RETURNING pair_key`,
    [factIds, takeKeys, slug])).rows.map(r => r.pair_key);
  counts.contradictions += pairs.length;
  if (pairs.length > 0) await tx.query(`DELETE FROM synth_contradiction_verdicts WHERE pair_key = ANY($1::text[])`, [pairs]);
  counts.documents += await count(tx,
    // scope: upstream document ids come from the source-scoped read above
    `WITH d AS (DELETE FROM documents WHERE id = ANY($1::text[]) RETURNING 1) SELECT count(*)::int AS n FROM d`,
    [docIds]);
  const rest = await leftovers(tx, [slug], true);
  counts.leftovers += rest.raw_data_rows + rest.tags_rows + rest.slug_aliases_rows + rest.volunteer_event_rows;
  await tx.query(`DELETE FROM pages WHERE slug = $1`, [slug]);
  return { docIds, concepts };
}

/**
 * Pages a synthesis phase wrote and nobody edited: every version by `writer`.
 * Locks every page matching `where` first and only then reads their versions,
 * so an edit committed while this waited for a lock is seen and keeps its
 * page. Returns the deletable ones with their sources and how many were kept.
 */
async function automaticPages(tx: Engine, where: string, params: unknown[], type: string, prefix: string, writer: string): Promise<{ pages: Array<{ slug: string; source_id: string }>; kept: number }> {
  // scope: upstream callers pass the page predicate: the account's source for atom pages, and for
  // concept pages the brain-wide synthesis output narrated over an atom this delete removed
  const candidates = (await tx.query<{ slug: string }>(`SELECT p.slug FROM pages p WHERE ${where}`, params)).rows.map(r => r.slug);
  if (candidates.length === 0) return { pages: [], kept: 0 };
  await lockPageSlugs(tx, ...candidates);
  const locked = params.length + 1;
  // scope: upstream the same caller predicate, narrowed to the pages just locked
  const rows = (await tx.query<{ slug: string; source_id: string; automatic: boolean }>(
    `SELECT p.slug, p.source_id,
            (p.type = '${type}' AND p.slug LIKE '${prefix}%'
             AND NOT EXISTS (SELECT 1 FROM page_versions v WHERE v.slug = p.slug
                              AND v.written_by IS DISTINCT FROM '${writer}')) AS automatic
       FROM pages p WHERE ${where} AND p.slug = ANY($${locked}::text[]) ORDER BY p.slug`,
    [...params, candidates],
  )).rows;
  const pages = rows.filter(r => r.automatic).map(r => ({ slug: r.slug, source_id: r.source_id }));
  return { pages, kept: rows.length - pages.length };
}

/**
 * Whether a person edited any of `slugs` since the connector last wrote it: a
 * version newer than the page's latest connector write that arrived on a
 * credential. `written_by` is a label any caller picks, so the credential
 * decides: an authenticated caller is a person whatever writer name it used,
 * while the brain's own writers (secrets-audit redactions, enrichment, the
 * importers and the cycle) carry no principal, and its generators stamp
 * `operator` under their own writer names. Neither is a person's edit, so a
 * redaction or an enrichment pass never keeps an aged page alive.
 */
async function humanEdited(tx: Engine, slugs: readonly string[]): Promise<boolean> {
  const connectorWrite = (v: string) => `(${v}.written_by LIKE 'connector-%' AND ${v}.written_by_principal IS NULL)`;
  const r = await tx.query(
    // scope: upstream slugs are the owned page and its parts, locked by the caller
    `SELECT 1 FROM page_versions v
      WHERE v.slug = ANY($1::text[]) AND v.written_by_principal IS NOT NULL
        AND NOT (v.written_by_principal = 'operator' AND v.written_by = ANY($2::text[]))
        AND v.version_n > COALESCE((SELECT max(c.version_n) FROM page_versions c
                                     WHERE c.slug = v.slug AND ${connectorWrite("c")}), 0)
      LIMIT 1`,
    [[...slugs], GENERATORS],
  );
  return r.rows.length > 0;
}

/**
 * Hand `slugs` over to the brain: drop the connector's claim and expiry from
 * their compiled truth, as a new version of each, keeping text and history.
 */
async function detachPages(tx: Engine, slugs: readonly string[]): Promise<void> {
  for (const slug of slugs) {
    const page = (await tx.query<{ markdown_body: string; content_hash: string; compiled_truth: Record<string, unknown>; source_id: string; version_n: number }>(
      // scope: upstream the slug is an owned page or part the caller locked
      `SELECT p.markdown_body, p.content_hash, p.compiled_truth, p.source_id,
              COALESCE((SELECT max(v.version_n) FROM page_versions v WHERE v.slug = p.slug), 0)::int AS version_n
         FROM pages p WHERE p.slug = $1`,
      [slug],
    )).rows[0];
    if (page === undefined) continue;
    const { last_activity_at: _expiry, ...kept } = page.compiled_truth;
    const truth = JSON.stringify({ ...kept, origin: DETACHED_ORIGIN });
    await tx.query(`UPDATE pages SET compiled_truth = $2::text::jsonb, updated_at = NOW() WHERE slug = $1`, [slug, truth]);
    await tx.query(
      `INSERT INTO page_versions
         (slug, version_n, hash_prev, hash_new, body_snapshot, compiled_truth_snapshot, written_by, source_id, written_by_principal, change_reason)
       VALUES ($1, $2, $3, $3, $4, $5::text::jsonb, $6, $7, NULL, $8)`,
      [slug, Number(page.version_n) + 1, page.content_hash, page.markdown_body, truth, DETACH_WRITER, page.source_id,
        "retention kept a page edited by hand and detached it from its connector"],
    );
    await bumpPageGeneration(tx, slug);
  }
}

/**
 * Delete one owned connector page and the atom pages the atoms phase
 * published from its documents, inside `tx`. Only an atom page every version
 * of which the atoms phase wrote goes; one someone edited, or any other page
 * claiming the same origin, is kept and counted.
 */
async function deleteOwnedPage(
  tx: Engine,
  scope: ConnectorScope,
  slug: string,
  expected: { contentHash?: string; partHashes?: ReadonlyMap<string, string> } = {},
  keepEdited = false,
): Promise<DeleteCounts | "changed" | "detached" | null> {
  const partsSql = `SELECT p.slug, p.content_hash FROM pages p WHERE ${ownedPageScope} AND p.compiled_truth->>'part_of' = $3 ORDER BY p.slug`;
  const readParts = async () => (await tx.query<{ slug: string; content_hash: string }>(partsSql, [scope.sourceId, scope.accountRef, slug])).rows;
  const seen = new Set((await readParts()).map(r => r.slug));
  await lockPageSlugs(tx, slug, ...seen);
  const page = await tx.query<{ content_hash: string }>(
    `SELECT p.content_hash FROM pages p WHERE p.slug = $3 AND ${ownedPageScope} FOR UPDATE`,
    [scope.sourceId, scope.accountRef, slug],
  );
  if (page.rows.length === 0) return null;
  if (expected.contentHash !== undefined && page.rows[0]!.content_hash !== expected.contentHash) return "changed";
  // Read under the locks: these are the parts that go, and each must still
  // be what the caller saw when it pinned them. A part written while this
  // waited is locked too before anything reads its versions.
  let partRows = await readParts();
  const late = partRows.map(r => r.slug).filter(s => !seen.has(s));
  if (late.length > 0) {
    await lockPageSlugs(tx, ...late);
    partRows = await readParts();
  }
  if (expected.partHashes !== undefined && (partRows.length !== expected.partHashes.size
    || partRows.some(r => expected.partHashes!.get(r.slug) !== r.content_hash))) return "changed";
  const parts = partRows.map(r => r.slug);
  if (keepEdited && await humanEdited(tx, [slug, ...parts])) {
    await detachPages(tx, [slug, ...parts]);
    return "detached";
  }
  const counts: DeleteCounts = { ...EMPTY_COUNTS };
  const { docIds, concepts } = await deletePageDerived(tx, slug, scope.sourceId, counts);
  for (const part of parts) {
    const derived = await deletePageDerived(tx, part, scope.sourceId, counts);
    docIds.push(...derived.docIds);
    concepts.push(...derived.concepts);
  }
  if (docIds.length > 0) {
    const atoms = await automaticPages(tx,
      `p.source_id = $1 AND p.compiled_truth->'atom_origin'->>'source_ref' = ANY($2::text[])`,
      [scope.sourceId, docIds], "atom", "atoms/", "extract-atoms");
    counts.atom_pages_kept += atoms.kept;
    for (const atom of atoms.pages) {
      await deletePageDerived(tx, atom.slug, atom.source_id, counts);
      counts.atom_pages++;
    }
  }
  if (concepts.length > 0) {
    const pageSlugs = concepts.map(c => `concepts/${slugifyTitle(c)}`);
    const conceptPages = await automaticPages(tx, `p.slug = ANY($1::text[])`, [pageSlugs], "concept", "concepts/", "synthesize-concepts");
    counts.concept_pages_kept += conceptPages.kept;
    for (const concept of conceptPages.pages) {
      await deletePageDerived(tx, concept.slug, concept.source_id, counts);
      counts.concept_pages++;
    }
  }
  if (counts.documents > 0) await bumpDocumentClock(tx);
  await bumpClock(tx);
  return counts;
}

/**
 * Hard-delete one connector page of this account, with a text-free receipt.
 * A page that is not this account's connector page is refused untouched. For
 * retention, a page a person edited is detached instead (see the header).
 */
export async function hardDeleteConnectorPage(
  storage: Storage,
  scope: ConnectorScope,
  item: {
    slug: string;
    reason: DeleteReason;
    externalId?: string;
    expectedContentHash?: string;
    /** The page's parts by slug, as the caller saw them; any difference refuses the delete. */
    expectedPartHashes?: ReadonlyMap<string, string>;
  },
): Promise<HardDeleteResult> {
  const engine = storage.engine();
  await assertConnectorSource(engine, scope.sourceId);
  return deadlockSafeTransaction(engine, async (tx) => {
    const counts = await deleteOwnedPage(tx, scope, item.slug, {
      ...(item.expectedContentHash === undefined ? {} : { contentHash: item.expectedContentHash }),
      ...(item.expectedPartHashes === undefined ? {} : { partHashes: item.expectedPartHashes }),
    }, item.reason === "retention");
    if (counts === null) return { deleted: false, refused: "not_connector_page", counts: { ...EMPTY_COUNTS } };
    if (counts === "changed") return { deleted: false, refused: "changed", counts: { ...EMPTY_COUNTS } };
    if (counts === "detached") {
      await logIngest(tx, {
        source_type: CONNECTOR_DETACH_SOURCE_TYPE,
        source_id: scope.sourceId,
        source_ref: `${item.reason}:${scope.accountRef}:${hash(`slug:${item.slug}`)}`,
        pages_updated: [],
        summary: JSON.stringify({ reason: item.reason, account: scope.accountRef, page: hash(`slug:${item.slug}`) }),
      });
      return { deleted: false, refused: "human_edited", detached: true, counts: { ...EMPTY_COUNTS } };
    }
    await logIngest(tx, {
      source_type: CONNECTOR_DELETE_SOURCE_TYPE,
      source_id: scope.sourceId,
      source_ref: `${item.reason}:${scope.accountRef}:${hash(`slug:${item.slug}`)}`,
      pages_updated: [],
      summary: JSON.stringify({
        reason: item.reason,
        account: scope.accountRef,
        page: hash(`slug:${item.slug}`),
        ...(item.externalId === undefined ? {} : { item: shortHash(`item:${item.externalId}`) }),
        counts,
      }),
    });
    return { deleted: true, counts };
  });
}

/**
 * Delete the parts of `parentSlug` that its latest split no longer has, with
 * everything derived from them, in one transaction and with one text-free
 * receipt. Called after the item's new parts and contents page are written,
 * so nothing still links to what goes. Fenced like every connector delete:
 * only this account's connector pages in a connector source; on any other
 * source it does nothing.
 */
export async function deleteStaleParts(
  storage: Storage,
  scope: ConnectorScope,
  parentSlug: string,
  keep: readonly string[],
): Promise<{ parts: number; counts: DeleteCounts }> {
  const engine = storage.engine();
  const none = { parts: 0, counts: { ...EMPTY_COUNTS } };
  const kind = (await engine.query<{ kind: string }>(`SELECT kind FROM sources WHERE id = $1`, [scope.sourceId])).rows[0]?.kind;
  if (kind === undefined || !CONNECTOR_SOURCE_KINDS.has(kind)) return none;
  const staleSql = `SELECT p.slug FROM pages p WHERE ${ownedPageScope} AND p.compiled_truth->>'part_of' = $3
                     AND NOT (p.slug = ANY($4::text[])) ORDER BY p.slug`;
  const params = [scope.sourceId, scope.accountRef, parentSlug, [...keep]];
  // Most writes have nothing stale: check before opening a transaction.
  if ((await engine.query(staleSql, params)).rows.length === 0) return none;
  return deadlockSafeTransaction(engine, async (tx) => {
    const counts: DeleteCounts = { ...EMPTY_COUNTS };
    let parts = 0;
    for (const { slug } of (await tx.query<{ slug: string }>(staleSql, params)).rows) {
      const deleted = await deleteOwnedPage(tx, scope, slug);
      if (deleted === null || deleted === "changed" || deleted === "detached") continue;
      for (const k of Object.keys(counts) as Array<keyof DeleteCounts>) counts[k] += deleted[k];
      parts++;
    }
    if (parts === 0) return none;
    await logIngest(tx, {
      source_type: CONNECTOR_DELETE_SOURCE_TYPE,
      source_id: scope.sourceId,
      source_ref: `part_superseded:${scope.accountRef}:${hash(`slug:${parentSlug}`)}`,
      pages_updated: [],
      summary: JSON.stringify({ reason: "part_superseded", account: scope.accountRef, page: hash(`slug:${parentSlug}`), parts, counts }),
    });
    return { parts, counts };
  });
}

// ---------------------------------------------------------------------------
// Mass-delete guard and provider deletions.

const DEFAULT_MASS_MAX = 200;
const DEFAULT_MASS_PCT = 5;
const DEFAULT_MASS_MIN = 10;

function envNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
}

export interface MassDeleteVerdict {
  held: boolean;
  reason: string | null;
}

/**
 * The one mass-delete guard, shared by the sync engine and this module: hold
 * when a run deletes more than MEMRAIN_CONNECTOR_MASS_DELETE_ITEMS items (200),
 * or at least MEMRAIN_CONNECTOR_MASS_DELETE_MIN (10) items that are more than
 * MEMRAIN_CONNECTOR_MASS_DELETE_PCT (5) percent of the account's total. The
 * floor keeps a small account's single deletion from holding every run.
 */
export function massDeleteVerdict(requested: number, total: number, env: NodeJS.ProcessEnv = process.env): MassDeleteVerdict {
  const max = envNumber(env, "MEMRAIN_CONNECTOR_MASS_DELETE_ITEMS", DEFAULT_MASS_MAX);
  const pct = envNumber(env, "MEMRAIN_CONNECTOR_MASS_DELETE_PCT", DEFAULT_MASS_PCT);
  const min = envNumber(env, "MEMRAIN_CONNECTOR_MASS_DELETE_MIN", DEFAULT_MASS_MIN);
  if (requested > max) return { held: true, reason: `run deletes ${requested} items, more than ${max}` };
  if (requested >= min && requested > (total * pct) / 100) {
    return { held: true, reason: `run deletes ${requested} of ${total} items, more than ${pct}%` };
  }
  return { held: false, reason: null };
}

async function accountPageCount(engine: Engine, scope: ConnectorScope): Promise<number> {
  return count(engine, `SELECT count(*)::int AS n FROM pages p WHERE ${ownedPageScope}`, [scope.sourceId, scope.accountRef]);
}

export interface ProviderDeletionResult {
  held: boolean;
  reason: string | null;
  deleted: string[];
  refused: string[];
}

/**
 * Apply one sync run's provider-side deletions: each page in its own
 * transaction. Held whole, deleting nothing, when the guard trips and the
 * owner has not confirmed.
 */
export async function applyProviderDeletions(
  storage: Storage,
  scope: ConnectorScope,
  slugs: readonly string[],
  opts: { confirmed?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<ProviderDeletionResult> {
  const engine = storage.engine();
  await assertConnectorSource(engine, scope.sourceId);
  const unique = [...new Set(slugs)];
  const verdict = massDeleteVerdict(unique.length, await accountPageCount(engine, scope), opts.env ?? process.env);
  if (verdict.held && opts.confirmed !== true) return { held: true, reason: verdict.reason, deleted: [], refused: [] };
  const deleted: string[] = [];
  const refused: string[] = [];
  for (const slug of unique) {
    const r = await hardDeleteConnectorPage(storage, scope, { slug, reason: "provider_deleted" });
    (r.deleted ? deleted : refused).push(slug);
  }
  return { held: false, reason: verdict.reason, deleted, refused };
}

// ---------------------------------------------------------------------------
// Retention windows.

export const MIN_ENV_RETENTION_DAYS = 30;

export const DEFAULT_RETENTION_DAYS: Readonly<Record<ConnectorDataKind, number>> = {
  mail: 180,
  chat: 180,
  calendar: 365,
  meeting: 365,
};

/**
 * Days a page of this kind is kept after its last activity: the account's own
 * setting, else MEMRAIN_CONNECTOR_RETENTION_DAYS_<KIND>, else the default.
 * `0` or `off` keeps pages indefinitely (null). A malformed value, or an
 * environment window under MIN_ENV_RETENTION_DAYS, throws.
 */
export function retentionDays(kind: ConnectorDataKind, accountDays?: number | null, env: NodeJS.ProcessEnv = process.env): number | null {
  if (accountDays !== undefined && accountDays !== null) {
    if (!Number.isInteger(accountDays) || accountDays < 0) throw new Error("retention days must be a non-negative integer");
    return accountDays === 0 ? null : accountDays;
  }
  const name = `MEMRAIN_CONNECTOR_RETENTION_DAYS_${kind.toUpperCase()}`;
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return DEFAULT_RETENTION_DAYS[kind];
  if (raw === "off" || raw === "0") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number of days, 0 or off`);
  // The sweep hard-deletes, so a window this short is far likelier a typo
  // (1 for 180) than a wish; refusing it fails the run loudly instead.
  if (n < MIN_ENV_RETENTION_DAYS) throw new Error(`${name} must be at least ${MIN_ENV_RETENTION_DAYS} days, 0 or off`);
  return n;
}

export interface RetentionSweepResult {
  deleted: string[];
  /** Pages a person edited: detached from the connector and kept, not deleted. */
  detached: string[];
  /** Pages past the window waiting for the owner, because a sweep was past the mass-delete guard. */
  held: number;
  /** More pages could have gone than this run's limit. */
  more: boolean;
}

export interface RetentionSweepOptions {
  /** The connector account the scope belongs to; its items carry the holds. */
  accountId: string;
  kinds: readonly ConnectorDataKind[];
  /** The account's own window by kind; missing kinds fall back to the environment. */
  accountDays?: Partial<Record<ConnectorDataKind, number | null>>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  limit?: number;
}

type DueState = "fresh" | "orphan" | "upstream" | "held" | "confirmed" | "kept";

/**
 * Hard-delete this account's pages whose last activity is older than their
 * kind's window, at most `limit` per run across every kind. `last_activity_at`
 * is written by the renderers as an ISO-8601 UTC string, so it compares as
 * text.
 *
 * The pages due for the first time go through the mass-delete guard as one
 * run, like upstream deletions. Past it, the guard wins: their items are held
 * (`retention_held`), the account's `mass_delete_held` notice opens, and none
 * of them is deleted until the owner confirms (`retention_confirmed`, deleted
 * by the next sweep whatever their number) or keeps them (`retention_kept`,
 * left alone until the item changes upstream). A page no item maps to (its
 * sync record was forgotten) is held the same way through a stand-in item
 * (holdOrphanRetentionDeletes), so it is never deleted past the guard and
 * never waits without a notice. A held or confirmed item whose page is no
 * longer due, because the window grew, is released.
 */
export async function sweepRetention(storage: Storage, scope: ConnectorScope, opts: RetentionSweepOptions): Promise<RetentionSweepResult> {
  const engine = storage.engine();
  await assertConnectorSource(engine, scope.sourceId);
  const env = opts.env ?? process.env;
  const limit = opts.limit ?? 500;
  const now = (opts.now ?? Date.now)();
  const due: Array<{ slug: string; state: DueState }> = [];
  for (const kind of opts.kinds) {
    const days = retentionDays(kind, opts.accountDays?.[kind], env);
    if (days === null) continue;
    const cutoff = new Date(now - days * 86_400_000).toISOString();
    const item = (where: string) => `EXISTS (SELECT 1 FROM connector_items i
      WHERE i.account_id = $5 AND i.page_slug = p.slug AND ${where})`;
    // An item held for an upstream deletion belongs to that deletion, not to retention.
    due.push(...(await engine.query<{ slug: string; state: DueState }>(
      `SELECT p.slug,
              CASE WHEN ${item(`i.held_reason = '${RETENTION_KEPT}'`)} THEN 'kept'
                   WHEN ${item(`i.held_reason = '${RETENTION_CONFIRMED}'`)} THEN 'confirmed'
                   WHEN ${item(`i.held_reason = '${RETENTION_HELD}'`)} THEN 'held'
                   WHEN NOT ${item("TRUE")} THEN 'orphan'
                   WHEN ${item("(i.held_reason IS NULL OR NOT (i.held_reason = ANY($6::text[])))")} THEN 'fresh'
                   ELSE 'upstream' END AS state
         FROM pages p
        WHERE ${ownedPageScope} AND p.compiled_truth->>'kind' = $3
          AND p.compiled_truth->>'part_of' IS NULL
          AND p.compiled_truth->>'last_activity_at' < $4
        ORDER BY p.compiled_truth->>'last_activity_at', p.slug`,
      [scope.sourceId, scope.accountRef, kind, cutoff, opts.accountId, [...DELETION_STATES]],
    )).rows);
  }
  await releaseRetentionHolds(engine, opts.accountId, due.filter(d => d.state === "held" || d.state === "confirmed").map(d => d.slug));
  const slugsIn = (state: DueState) => due.filter(d => d.state === state).map(d => d.slug);
  const fresh = slugsIn("fresh");
  // A page no item maps to (its sync state was forgotten) counts toward the
  // guard like the rest; past it, a stand-in item holds it for the owner.
  const orphans = slugsIn("orphan");
  const toDelete = slugsIn("confirmed");
  let held = slugsIn("held").length;
  const newlyDue = fresh.length + orphans.length;
  const verdict = newlyDue === 0
    ? { held: false, reason: null }
    : massDeleteVerdict(newlyDue, await count(engine,
      `SELECT count(*)::int AS n FROM pages p WHERE ${ownedPageScope} AND p.compiled_truth->>'part_of' IS NULL`,
      [scope.sourceId, scope.accountRef]), env);
  if (verdict.held) {
    await holdRetentionDeletes(engine, opts.accountId, fresh);
    await holdOrphanRetentionDeletes(engine, opts.accountId, orphans, new Date(now));
    held += fresh.length + orphans.length;
  } else {
    toDelete.push(...fresh, ...orphans);
  }
  if (held > 0) {
    await openNotice(engine, opts.accountId, "mass_delete_held",
      `${held} page(s) past the retention window are held for confirmation; they are not deleted until you choose`, new Date(now));
  } else if (await heldDeleteCount(engine, opts.accountId) === 0) {
    await resolveNotice(engine, opts.accountId, "mass_delete_held", new Date(now));
  }
  const deleted: string[] = [];
  const detached: string[] = [];
  for (const slug of toDelete.slice(0, limit)) {
    const r = await hardDeleteConnectorPage(storage, scope, { slug, reason: "retention" });
    if (r.deleted) deleted.push(slug);
    else if (r.detached === true) detached.push(slug);
  }
  return { deleted, detached, held, more: toDelete.length > limit };
}

// ---------------------------------------------------------------------------
// Disconnect: keep data by default; delete everything only after a preview.

export interface ConnectorDataPreview {
  pages: number;
  chunks: number;
  facts: number;
  timeline_events: number;
  /** Pass back to deleteAllConnectorData to delete exactly this set. */
  plan_hash: string;
}

async function planSlugs(engine: Engine, scope: ConnectorScope): Promise<Array<{ slug: string; content_hash: string; part_of: string | null }>> {
  return (await engine.query<{ slug: string; content_hash: string; part_of: string | null }>(
    `SELECT p.slug, p.content_hash, p.compiled_truth->>'part_of' AS part_of FROM pages p WHERE ${ownedPageScope} ORDER BY p.slug`,
    [scope.sourceId, scope.accountRef],
  )).rows;
}

function planHash(rows: ReadonlyArray<{ slug: string; content_hash: string }>): string {
  return hash(rows.map(r => `${r.slug}\t${r.content_hash}`).join("\n"));
}

/** What "delete everything from this connector" would remove; counts only. */
export async function previewConnectorData(storage: Storage, scope: ConnectorScope): Promise<ConnectorDataPreview> {
  const engine = storage.engine();
  await assertConnectorSource(engine, scope.sourceId);
  const rows = await planSlugs(engine, scope);
  const slugs = rows.map(r => r.slug);
  const paths = slugs.flatMap(s => [pageSourcePath(s, scope.sourceId), pageTruthSourcePath(s, scope.sourceId)]);
  const chunkIds = (await engine.query<{ id: string }>(
    `SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE d.source_path = ANY($1::text[]) AND COALESCE(d.source_id, 'default') = $2`,
    [paths, scope.sourceId],
  )).rows.map(r => r.id);
  return {
    pages: slugs.length,
    chunks: chunkIds.length,
    facts: await count(engine,
      `SELECT count(*)::int AS n FROM entity_facts f
        WHERE ((COALESCE(f.source_markdown_slug, f.source_slug) = ANY($1::text[])) AND COALESCE(f.source_id, 'default') = $2)
           OR f.source_chunk_id = ANY($3::text[])`,
      [slugs, scope.sourceId, chunkIds]),
    timeline_events: await count(engine,
      // scope: upstream slugs and chunk ids come from the source-scoped plan above
      `SELECT count(*)::int AS n FROM timeline_events WHERE slug = ANY($1::text[]) OR source_chunk_id = ANY($2::text[])`,
      [slugs, chunkIds]),
    plan_hash: planHash(rows),
  };
}

/**
 * Delete every page this account's connector wrote, exactly as previewed:
 * refused when the set or any page's content changed since the preview.
 */
export async function deleteAllConnectorData(
  storage: Storage,
  scope: ConnectorScope,
  opts: { expectedPlanHash: string },
): Promise<{ deleted: string[]; changed: string[] }> {
  const engine = storage.engine();
  await assertConnectorSource(engine, scope.sourceId);
  const rows = await planSlugs(engine, scope);
  if (planHash(rows) !== opts.expectedPlanHash) {
    throw new OperationError(
      "conflict",
      `the connector's data changed since the preview (now ${rows.length} page(s))`,
      "Preview again, review the counts, and pass the new plan_hash.",
    );
  }
  // Each page and its parts are pinned to the content the preview saw: one
  // edited after the check above is refused, not deleted, and reported back.
  // A part goes with its page, never on its own.
  const deleted: string[] = [];
  const changed: string[] = [];
  for (const { slug, content_hash: expectedContentHash } of rows.filter(r => r.part_of === null)) {
    const expectedPartHashes = new Map(rows.filter(r => r.part_of === slug).map(r => [r.slug, r.content_hash]));
    const r = await hardDeleteConnectorPage(storage, scope, { slug, reason: "disconnect", expectedContentHash, expectedPartHashes });
    if (r.deleted) deleted.push(slug);
    else if (r.refused === "changed") changed.push(slug);
  }
  return { deleted, changed };
}
