/**
 * Deletion, retention and disconnect for connector pages.
 *
 * A connector copy is the provider's data, so its deletions are hard: when an
 * item is deleted at the provider, ages out of its retention window, or the
 * owner deletes everything a connector brought in, the page goes with
 * everything derived from it — page history, search documents, chunks and
 * their embeddings, facts written from the page or its chunks, chronicle
 * events drawn from its chunks, links it is the provenance of, and the
 * slug-keyed leftovers a purge also clears. Facts are deleted, not retired:
 * a retired fact still holds the text.
 *
 * Each page goes in its own transaction, which also writes a receipt to the
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
 * until the owner confirms; the guard beats the hard delete.
 */
import { createHash } from "node:crypto";
import type { Storage } from "../storage.ts";
import type { Engine } from "../engine/interface.ts";
import { lockPageSlugs } from "../pages.ts";
import { leftovers } from "../pages-purge.ts";
import { pageSourcePath, pageTruthSourcePath } from "../page-index.ts";
import { bumpClock, bumpDocumentClock } from "../generation.ts";
import { logIngest } from "../ingest-log.ts";
import { OperationError } from "../operation-error.ts";
import { deadlockSafeTransaction } from "../retry.ts";
import { shortHash, SOURCE_KIND_FOR, type ConnectorDataKind } from "./model.ts";

export const CONNECTOR_DELETE_SOURCE_TYPE = "connector-delete";

export type DeleteReason = "provider_deleted" | "retention" | "disconnect";

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
}

export interface HardDeleteResult {
  deleted: boolean;
  /** Why nothing was deleted. */
  refused?: "not_connector_page";
  counts: DeleteCounts;
}

const CONNECTOR_SOURCE_KINDS = new Set(Object.values(SOURCE_KIND_FOR));

const EMPTY_COUNTS: DeleteCounts = {
  versions: 0, documents: 0, chunks: 0, embeddings: 0, facts: 0, timeline_events: 0, links: 0, leftovers: 0,
};

/** The page predicate every delete shares: this source, a connector page, this account. */
const OWNED_PAGE = `p.source_id = $1 AND p.compiled_truth->>'origin' = 'connector' AND p.compiled_truth->>'account' = $2`;

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

/** Delete one page and everything derived from it, inside `tx`. */
async function deleteOwnedPage(tx: Engine, scope: ConnectorScope, slug: string): Promise<DeleteCounts | null> {
  await lockPageSlugs(tx, slug);
  const page = await tx.query<{ slug: string }>(
    `SELECT p.slug FROM pages p WHERE p.slug = $3 AND ${OWNED_PAGE} FOR UPDATE`,
    [scope.sourceId, scope.accountRef, slug],
  );
  if (page.rows.length === 0) return null;
  const paths = [pageSourcePath(slug, scope.sourceId), pageTruthSourcePath(slug, scope.sourceId)];
  const docIds = (await tx.query<{ id: string }>(
    `SELECT id FROM documents WHERE source_path = ANY($1::text[]) AND COALESCE(source_id, 'default') = $2`,
    [paths, scope.sourceId],
  )).rows.map(r => r.id);
  const chunkIds = (await tx.query<{ id: string }>(
    `SELECT id FROM chunks WHERE document_id = ANY($1::text[])`, [docIds],
  )).rows.map(r => r.id);

  const counts: DeleteCounts = { ...EMPTY_COUNTS };
  counts.versions = await count(tx, `SELECT count(*)::int AS n FROM page_versions WHERE slug = $1`, [slug]);
  counts.embeddings = await count(tx, `SELECT count(*)::int AS n FROM embeddings WHERE chunk_id = ANY($1::text[])`, [chunkIds]);
  counts.chunks = chunkIds.length;
  counts.facts = await count(tx,
    `WITH d AS (
       DELETE FROM entity_facts f
        WHERE ((f.source_markdown_slug = $1 OR (f.source_markdown_slug IS NULL AND f.source_slug = $1))
               AND COALESCE(f.source_id, 'default') = $2)
           OR f.source_chunk_id = ANY($3::text[])
       RETURNING 1)
     SELECT count(*)::int AS n FROM d`,
    [slug, scope.sourceId, chunkIds]);
  counts.timeline_events = await count(tx,
    `WITH d AS (DELETE FROM timeline_events WHERE slug = $1 OR source_chunk_id = ANY($2::text[]) RETURNING 1)
     SELECT count(*)::int AS n FROM d`,
    [slug, chunkIds]);
  counts.links = await count(tx,
    `WITH d AS (DELETE FROM links WHERE source_slug = $1 OR origin_slug = $1 RETURNING 1)
     SELECT count(*)::int AS n FROM d`,
    [slug]);
  counts.documents = await count(tx,
    `WITH d AS (DELETE FROM documents WHERE id = ANY($1::text[]) RETURNING 1) SELECT count(*)::int AS n FROM d`,
    [docIds]);
  const rest = await leftovers(tx, [slug], true);
  counts.leftovers = rest.raw_data_rows + rest.tags_rows + rest.slug_aliases_rows + rest.volunteer_event_rows;
  await tx.query(`DELETE FROM pages WHERE slug = $1`, [slug]);
  if (counts.documents > 0) await bumpDocumentClock(tx);
  await bumpClock(tx);
  return counts;
}

/**
 * Hard-delete one connector page of this account, with a text-free receipt.
 * A page that is not this account's connector page is refused untouched.
 */
export async function hardDeleteConnectorPage(
  storage: Storage,
  scope: ConnectorScope,
  item: { slug: string; reason: DeleteReason; externalId?: string },
): Promise<HardDeleteResult> {
  const engine = storage.engine();
  await assertConnectorSource(engine, scope.sourceId);
  return deadlockSafeTransaction(engine, async (tx) => {
    const counts = await deleteOwnedPage(tx, scope, item.slug);
    if (counts === null) return { deleted: false, refused: "not_connector_page", counts: { ...EMPTY_COUNTS } };
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
 * Hold when a run deletes more than MEMRAIN_CONNECTOR_MASS_DELETE_MAX items
 * (200), or at least MEMRAIN_CONNECTOR_MASS_DELETE_MIN (10) items that are more
 * than MEMRAIN_CONNECTOR_MASS_DELETE_PCT (5) percent of the account's pages.
 * The floor keeps a small account's single deletion from holding every run.
 */
export function massDeleteVerdict(requested: number, total: number, env: NodeJS.ProcessEnv = process.env): MassDeleteVerdict {
  const max = envNumber(env, "MEMRAIN_CONNECTOR_MASS_DELETE_MAX", DEFAULT_MASS_MAX);
  const pct = envNumber(env, "MEMRAIN_CONNECTOR_MASS_DELETE_PCT", DEFAULT_MASS_PCT);
  const min = envNumber(env, "MEMRAIN_CONNECTOR_MASS_DELETE_MIN", DEFAULT_MASS_MIN);
  if (requested > max) return { held: true, reason: `run deletes ${requested} items, more than ${max}` };
  if (requested >= min && requested > (total * pct) / 100) {
    return { held: true, reason: `run deletes ${requested} of ${total} items, more than ${pct}%` };
  }
  return { held: false, reason: null };
}

async function accountPageCount(engine: Engine, scope: ConnectorScope): Promise<number> {
  return count(engine, `SELECT count(*)::int AS n FROM pages p WHERE ${OWNED_PAGE}`, [scope.sourceId, scope.accountRef]);
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

export const DEFAULT_RETENTION_DAYS: Readonly<Record<ConnectorDataKind, number>> = {
  mail: 180,
  chat: 180,
  calendar: 365,
  meeting: 365,
};

/**
 * Days a page of this kind is kept after its last activity: the account's own
 * setting, else MEMRAIN_CONNECTOR_RETENTION_DAYS_<KIND>, else the default.
 * `0` or `off` keeps pages indefinitely (null). A malformed value throws.
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
  return n;
}

export interface RetentionSweepResult {
  kind: ConnectorDataKind;
  days: number | null;
  deleted: string[];
  /** More pages were past the window than this run's limit. */
  more: boolean;
}

/**
 * Hard-delete this account's pages of one kind whose last activity is older
 * than the window, at most `limit` per run. `last_activity_at` is written by
 * the renderers as an ISO-8601 UTC string, so it compares as text.
 */
export async function sweepRetention(
  storage: Storage,
  scope: ConnectorScope,
  opts: { kind: ConnectorDataKind; accountDays?: number | null; env?: NodeJS.ProcessEnv; now?: () => number; limit?: number },
): Promise<RetentionSweepResult> {
  const engine = storage.engine();
  await assertConnectorSource(engine, scope.sourceId);
  const days = retentionDays(opts.kind, opts.accountDays, opts.env ?? process.env);
  if (days === null) return { kind: opts.kind, days, deleted: [], more: false };
  const limit = opts.limit ?? 500;
  const cutoff = new Date((opts.now ?? Date.now)() - days * 86_400_000).toISOString();
  const due = (await engine.query<{ slug: string }>(
    `SELECT p.slug FROM pages p
      WHERE ${OWNED_PAGE} AND p.compiled_truth->>'kind' = $3
        AND p.compiled_truth->>'last_activity_at' < $4
      ORDER BY p.compiled_truth->>'last_activity_at', p.slug
      LIMIT $5`,
    [scope.sourceId, scope.accountRef, opts.kind, cutoff, limit + 1],
  )).rows.map(r => r.slug);
  const deleted: string[] = [];
  for (const slug of due.slice(0, limit)) {
    const r = await hardDeleteConnectorPage(storage, scope, { slug, reason: "retention" });
    if (r.deleted) deleted.push(slug);
  }
  return { kind: opts.kind, days, deleted, more: due.length > limit };
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

async function planSlugs(engine: Engine, scope: ConnectorScope): Promise<Array<{ slug: string; content_hash: string }>> {
  return (await engine.query<{ slug: string; content_hash: string }>(
    `SELECT p.slug, p.content_hash FROM pages p WHERE ${OWNED_PAGE} ORDER BY p.slug`,
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
): Promise<{ deleted: string[] }> {
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
  const deleted: string[] = [];
  for (const { slug } of rows) {
    const r = await hardDeleteConnectorPage(storage, scope, { slug, reason: "disconnect" });
    if (r.deleted) deleted.push(slug);
  }
  return { deleted };
}
