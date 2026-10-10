/**
 * Page → search bridge.
 *
 * The DB-canonical `pages` store (migration 015) holds the authored body,
 * but search reads `documents`/`chunks`/`embeddings`. Without a bridge a
 * page written via `page_put` is invisible to search. This module mirrors a
 * page's body into the search store by routing it through the same
 * `indexDocument` pipeline the file sweep uses — chunk + embed + write,
 * idempotent per source_path.
 *
 * The mirror document is keyed by a reserved `page://<slug>` source_path so
 * it never collides with file-derived documents (which use real filesystem
 * paths) and so a page delete can find and drop its mirror.
 *
 * TENANT AXIS (composite-PK precursor): a page's identity is `(source_id,
 * slug)`, so two tenants may own the same slug. The mirror id therefore
 * carries the source for any non-'default' tenant — `page://<sourceId>/<slug>`
 * — so their bodies map to DISTINCT search documents instead of colliding on a
 * shared `page://<slug>`. The 'default' tenant keeps the bare `page://<slug>`
 * form so existing mirror documents are NOT orphaned by the new scheme (no
 * live re-mirror needed). See {@link pageSourcePath}.
 */
import { createHash } from "node:crypto";
import {
  indexDocument,
  removeDocument,
  type IndexFileOptions,
  type IndexResult,
} from "./indexer.ts";
import { MARKDOWN_CHUNKER_VERSION } from "./chunkers/recursive.ts";
import type { Storage } from "./storage.ts";
import { logIngest } from "./ingest-log.ts";
import type { QuarantineVerdict } from "./quarantine.ts";

/**
 * Reserved source_path namespace for page-derived search documents, keyed by
 * the page's `(source_id, slug)` identity.
 *
 * Back-compat guarantee: `source_id` omitted OR `'default'` yields the legacy
 * `page://<slug>` id, so the existing single-tenant corpus keeps every mirror
 * document exactly where it is (no re-mirror, no orphan). A non-'default'
 * tenant gets a collision-free `page://<sourceId>/<slug>` — required so two
 * tenants' same-slug pages don't overwrite one shared mirror document.
 */
export function pageSourcePath(slug: string, sourceId?: string | null): string {
  if (sourceId && sourceId !== "default") {
    return `page://${sourceId}/${slug}`;
  }
  return `page://${slug}`;
}

/** True for a page-derived mirror source_path — the body mirror
 *  ({@link pageSourcePath}) or the compiled-truth mirror
 *  ({@link pageTruthSourcePath}). Both carry author-written page content, so
 *  every caller that suppresses page mirrors (public-ingress redaction) must
 *  suppress both. */
export function isPageSourcePath(sourcePath: string): boolean {
  return sourcePath.startsWith("page://") || sourcePath.startsWith("page-truth://");
}

/**
 * Reserved source_path namespace for a page's COMPILED-TRUTH mirror — the
 * canonical per-page understanding (`pages.compiled_truth`) indexed as its own
 * search document so canonical answers are retrievable (compiled truth is
 * chunked alongside the body and boosted ×2 at fusion — see hybrid.ts
 * COMPILED_TRUTH_BOOST). Tenant-keyed exactly like {@link pageSourcePath}.
 */
export function pageTruthSourcePath(slug: string, sourceId?: string | null): string {
  if (sourceId && sourceId !== "default") {
    return `page-truth://${sourceId}/${slug}`;
  }
  return `page-truth://${slug}`;
}

/** SQL twin of {@link pageTruthSourcePath} (`p` = the `pages` alias). */
export const PAGE_TRUTH_PATH_SQL =
  `CASE WHEN p.source_id = 'default' THEN 'page-truth://' || p.slug ` +
  `ELSE 'page-truth://' || p.source_id || '/' || p.slug END`;

/**
 * Serialize a page's compiled_truth JSONB into the text indexed for its truth
 * mirror: an H1 (title + marker, searchable) followed by one readable
 * `key: value` line per entry, keys sorted so the serialization — and its
 * hash — is deterministic. Empty / non-object truth serializes to "" (the
 * caller removes the mirror instead of indexing a husk).
 */
export function serializeCompiledTruth(
  title: string | null,
  slug: string,
  truth: unknown,
): string {
  if (!truth || typeof truth !== "object" || Array.isArray(truth)) return "";
  const entries = Object.entries(truth as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return "";
  const lines = entries.map(([k, v]) => {
    if (typeof v === "string") return `${k}: ${v}`;
    if (Array.isArray(v)) return `${k}: ${v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ")}`;
    return `${k}: ${JSON.stringify(v)}`;
  });
  return `# ${title ?? slug} — compiled truth\n\n${lines.join("\n")}`;
}

/** SHA-256 of the serialized truth text — the staleness stamp for reconcile. */
export function compiledTruthHash(serialized: string): string {
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

/**
 * SQL expression that reconstructs a page's mirror source_path from its
 * `(source_id, slug)` columns, MUST mirror {@link pageSourcePath} exactly. Used
 * by the reconcile passes to join `pages` ↔ `documents` on the tenant-aware id
 * (a slug may repeat across sources, so a bare `'page://' || slug` join would
 * mismatch a non-'default' tenant's mirror). `p` is the `pages` alias.
 */
export const PAGE_MIRROR_PATH_SQL =
  `CASE WHEN p.source_id = 'default' THEN 'page://' || p.slug ` +
  `ELSE 'page://' || p.source_id || '/' || p.slug END`;

/**
 * Compose the text indexed for a page: the title as an H1 (so the page title
 * is searchable and feeds the title-phrase boost) followed by the body. The
 * H1 is only prepended when the body doesn't already open with one.
 */
function pageText(title: string | null, body: string): string {
  const b = body ?? "";
  if (title && !/^\s*#\s/.test(b)) {
    return `# ${title}\n\n${b}`;
  }
  return b;
}

export interface PageIndexInput {
  slug: string;
  title: string | null;
  markdown_body: string;
  /**
   * Page content hash — stamped onto the mirror document's frontmatter as
   * `page_content_hash` so {@link reconcilePageMirrors} can detect a stale
   * mirror (page changed but a write-time embed failed).
   */
  content_hash?: string;
  /**
   * Owning source (tenant) of the page. Propagated to the mirror document so
   * the page's content is search-isolated to its tenant. Defaults to 'default'.
   */
  source_id?: string;
  /**
   * The page's compiled_truth header. When provided (even `{}`) the
   * compiled-truth mirror (`page-truth://…`) is synced too: non-empty truth is
   * indexed as its own search document, empty truth removes the mirror. When
   * OMITTED the truth mirror is left untouched — the reconcile backstop
   * (`reconcilePageMirrors`) syncs it on the next cycle, so callers that only
   * know the body don't churn the truth doc.
   */
  compiled_truth?: Record<string, unknown> | null;
}

/**
 * Mirror a page into the search store. A page with an empty/whitespace title
 * AND body has nothing to index — its mirror is removed instead of writing an
 * empty husk. (A title-only page IS indexed: the title is searchable.)
 * Returns the index result, or `null` when the page was removed.
 */
export async function indexPageIntoSearch(
  storage: Storage,
  page: PageIndexInput,
  opts: IndexFileOptions = {},
): Promise<IndexResult | null> {
  // Compiled-truth mirror — synced only when the caller passed the field
  // (undefined = leave to the reconcile backstop). Best-effort relative to the
  // body mirror: a truth-mirror failure must not lose the body write, so it is
  // indexed first and its errors propagate the same way (caller/backstop retry).
  if (page.compiled_truth !== undefined) {
    await indexPageTruthIntoSearch(storage, page, opts);
  }
  const text = pageText(page.title, page.markdown_body);
  if (text.trim().length === 0) {
    // Body mirror only — a body-less page can still carry compiled truth
    // (handled above / by the backstop); full removal is page-delete's job
    // via removePageFromSearch.
    await removeDocument(storage, pageSourcePath(page.slug, page.source_id));
    return null;
  }
  // A page mirror is a page BODY (its title is already folded into `text` by
  // pageText), not a raw markdown file — skip path-based frontmatter inference
  // so a slug like `daily/2026-03-20` doesn't gain a synthesized type/date header.
  const indexOpts: IndexFileOptions = { ...opts, inferFrontmatter: false };
  return indexDocument(
    storage,
    {
      sourcePath: pageSourcePath(page.slug, page.source_id),
      text,
      sourceId: page.source_id ?? null,
      // The mirror belongs to this page: adopt an unowned row rather than
      // leaving it permanently unreconcilable (see DocumentWrite.claimUnowned).
      claimUnowned: true,
      // Stamp the body hash AND the title: `pages.content_hash` is body-only,
      // so a title-only edit leaves it unchanged. Stamping the title too lets
      // the backstop detect a stale mirror after a title-only edit whose
      // write-time embed failed.
      ...(page.content_hash
        ? {
            extraFrontmatter: {
              page_content_hash: page.content_hash,
              page_title: page.title ?? "",
            },
          }
        : {}),
    },
    indexOpts,
  );
}

/**
 * Sync a page's compiled-truth mirror: index the serialized truth as its own
 * `page-truth://` document (stamped with the serialization hash for the
 * reconcile backstop), or drop the mirror when the truth is empty. Returns
 * the index result, or null when the mirror was removed / left absent.
 */
export async function indexPageTruthIntoSearch(
  storage: Storage,
  page: Pick<PageIndexInput, "slug" | "title" | "source_id" | "compiled_truth">,
  opts: IndexFileOptions = {},
): Promise<IndexResult | null> {
  const serialized = serializeCompiledTruth(
    page.title ?? null,
    page.slug,
    page.compiled_truth ?? null,
  );
  const path = pageTruthSourcePath(page.slug, page.source_id);
  if (serialized.length === 0) {
    await removeDocument(storage, path);
    return null;
  }
  const indexOpts: IndexFileOptions = { ...opts, inferFrontmatter: false };
  return indexDocument(
    storage,
    {
      sourcePath: path,
      text: serialized,
      sourceId: page.source_id ?? null,
      // The mirror belongs to this page: adopt an unowned row rather than
      // leaving it permanently unreconcilable (see DocumentWrite.claimUnowned).
      claimUnowned: true,
      extraFrontmatter: {
        page_truth_hash: compiledTruthHash(serialized),
      },
    },
    indexOpts,
  );
}

export interface ReconcilePageMirrorsResult {
  /** Pages examined whose mirror was missing or stale. */
  scanned: number;
  /** Pages (re)mirrored into the search store. */
  mirrored: number;
  /** Orphan mirrors (page deleted/gone) dropped from the search store. */
  removed: number;
  /** Per-slug failures (e.g. transient embed errors) — retried next run. */
  errors: string[];
}

/**
 * Cycle backstop for the page → search bridge. Two self-healing passes:
 *
 *  1. Re-mirror pages whose `page://<slug>` document is MISSING (a write-time
 *     embed failed) or STALE (`page_content_hash` ≠ the page's content_hash).
 *  2. Drop orphan mirrors whose page was soft-deleted or no longer exists.
 *
 * Bounded per run so a large backlog drains over several cycles rather than
 * hammering Bedrock in one burst. Per-page failures are collected, not thrown,
 * so one bad page can't abort the pass.
 */
export async function reconcilePageMirrors(
  storage: Storage,
  opts: { maxPerRun?: number; embedFn?: IndexFileOptions["embedFn"] } = {},
): Promise<ReconcilePageMirrorsResult> {
  const limit = opts.maxPerRun ?? 200;
  const indexOpts: IndexFileOptions = {};
  if (opts.embedFn) indexOpts.embedFn = opts.embedFn;
  const engine = storage.engine();
  const result: ReconcilePageMirrorsResult = {
    scanned: 0,
    mirrored: 0,
    removed: 0,
    errors: [],
  };

  // Pass 1 — missing or stale mirrors. Staleness = missing doc, tenant drift,
  // content/title drift, OR a chunker-version below the current markdown chunker
  // ($2). The chunker-version arm is the ONLY way a page mirror re-chunks on a
  // chunking-behavior change: the vault rechunk-sweep reads `source_path` off
  // disk and skips `page://` docs (no file), so DB-canonical pages would
  // otherwise never pick up a new chunker (e.g. the v2 takes-fence strip).
  const stale = await engine.query<{
    slug: string;
    title: string | null;
    markdown_body: string;
    content_hash: string;
    source_id: string;
  }>(
    `SELECT p.slug, p.title, p.markdown_body, p.content_hash, p.source_id
       FROM pages p
       LEFT JOIN documents d ON d.source_path = ${PAGE_MIRROR_PATH_SQL}
      WHERE p.deleted_at IS NULL
        AND (d.id IS NULL
             OR d.source_id <> p.source_id
             OR COALESCE(d.frontmatter->>'page_content_hash', '') <> p.content_hash
             OR COALESCE(d.frontmatter->>'page_title', '') <> COALESCE(p.title, '')
             OR COALESCE(d.chunker_version, 0) < $2)
      ORDER BY p.updated_at DESC
      LIMIT $1`,
    [limit, MARKDOWN_CHUNKER_VERSION],
  );
  for (const p of stale.rows) {
    result.scanned++;
    try {
      const r = await indexPageIntoSearch(
        storage,
        {
          slug: p.slug,
          title: p.title,
          markdown_body: p.markdown_body,
          content_hash: p.content_hash,
          source_id: p.source_id,
        },
        indexOpts,
      );
      if (r === null) result.removed++;
      else result.mirrored++;
    } catch (e) {
      result.errors.push(
        `${p.slug}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Pass 1t — missing or stale COMPILED-TRUTH mirrors. The staleness stamp
  // (`page_truth_hash`) is a JS-side hash of the serialized truth, so the
  // candidate set (every truth-bearing page + its mirror's stamp) is fetched
  // and compared here rather than in SQL. Page counts are ~10^3 and the rows
  // are header-sized — a full scan per cycle is cheap; the re-index work
  // itself stays bounded by `limit`.
  const truthRows = await engine.query<{
    slug: string;
    title: string | null;
    compiled_truth: unknown;
    source_id: string;
    doc_source_id: string | null;
    stamp: string | null;
    doc_chunker_version: number | null;
  }>(
    `SELECT p.slug, p.title, p.compiled_truth, p.source_id,
            d.source_id AS doc_source_id,
            d.frontmatter->>'page_truth_hash' AS stamp,
            d.chunker_version AS doc_chunker_version
       FROM pages p
       LEFT JOIN documents d ON d.source_path = ${PAGE_TRUTH_PATH_SQL}
      WHERE p.deleted_at IS NULL
        AND p.compiled_truth IS NOT NULL
        AND p.compiled_truth <> '{}'::jsonb
      ORDER BY p.updated_at DESC`,
  );
  let truthBudget = limit;
  for (const p of truthRows.rows) {
    if (truthBudget <= 0) break;
    let truth: unknown = p.compiled_truth;
    if (typeof truth === "string") {
      try {
        truth = JSON.parse(truth);
      } catch {
        truth = null;
      }
    }
    const serialized = serializeCompiledTruth(
      p.title,
      p.slug,
      truth,
    );
    // Freshness mirrors Pass 1: hash + tenant + chunker version. The version
    // arm is the ONLY way a truth mirror re-chunks on a chunking-behavior
    // change — without it a MARKDOWN_CHUNKER_VERSION bump drained body
    // mirrors but left truth mirrors stamped at the old version forever.
    const fresh =
      serialized.length > 0 &&
      p.stamp === compiledTruthHash(serialized) &&
      p.doc_source_id === p.source_id &&
      (p.doc_chunker_version ?? 0) >= MARKDOWN_CHUNKER_VERSION;
    if (fresh) continue;
    truthBudget--;
    result.scanned++;
    try {
      const r = await indexPageTruthIntoSearch(
        storage,
        {
          slug: p.slug,
          title: p.title,
          source_id: p.source_id,
          compiled_truth: (truth ?? null) as Record<string, unknown> | null,
        },
        indexOpts,
      );
      if (r === null) result.removed++;
      else result.mirrored++;
    } catch (e) {
      result.errors.push(
        `${p.slug} (truth): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Pass 2 — orphan mirrors (page soft-deleted or gone). Two sweeps, one per
  // mirror namespace: body mirrors joined on their path, truth mirrors joined
  // on theirs AND requiring the page still carries non-empty truth.
  const orphans = await engine.query<{ source_path: string }>(
    `SELECT d.source_path
       FROM documents d
       LEFT JOIN pages p
         ON ${PAGE_MIRROR_PATH_SQL} = d.source_path AND p.deleted_at IS NULL
      WHERE d.source_path LIKE 'page://%' AND p.slug IS NULL
      LIMIT $1`,
    [limit],
  );
  const truthOrphans = await engine.query<{ source_path: string }>(
    `SELECT d.source_path
       FROM documents d
       LEFT JOIN pages p
         ON ${PAGE_TRUTH_PATH_SQL} = d.source_path
        AND p.deleted_at IS NULL
        AND p.compiled_truth IS NOT NULL
        AND p.compiled_truth <> '{}'::jsonb
      WHERE d.source_path LIKE 'page-truth://%' AND p.slug IS NULL
      LIMIT $1`,
    [limit],
  );
  for (const o of [...orphans.rows, ...truthOrphans.rows]) {
    try {
      const r = await removeDocument(storage, o.source_path);
      if (r.removed) result.removed++;
    } catch (e) {
      result.errors.push(
        `${o.source_path}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return result;
}

/**
 * Drop a page's mirror documents — body AND compiled-truth — (idempotent).
 * `sourceId` selects the tenant's mirror ids — omitted/'default' targets the
 * legacy `page://<slug>` document, so existing single-tenant callers are
 * unchanged. `removed` reports the body mirror (the pre-truth contract).
 */
export async function removePageFromSearch(
  storage: Storage,
  slug: string,
  sourceId?: string | null,
): Promise<{ removed: boolean }> {
  const body = await removeDocument(storage, pageSourcePath(slug, sourceId));
  await removeDocument(storage, pageTruthSourcePath(slug, sourceId));
  return body;
}

export interface MirrorPageOptions {
  /** The write came from an untrusted caller: gate-owned frontmatter markers
   *  are stripped rather than honoured (see IndexFileOptions.remote). */
  remote: boolean;
  timingLabel?: string;
  /** Record a `page-mirror-failed` ingest row on failure (default true). A
   *  retried job passes false until its last attempt, so a failing page
   *  leaves one row, not one per retry. */
  logFailure?: boolean;
  /** Test seams — production omits both. */
  embedFn?: IndexFileOptions["embedFn"];
  contextualLlmFn?: IndexFileOptions["contextualLlmFn"];
}

/**
 * Mirror a page into the search store, best-effort. The page write it follows
 * has already committed and is the source of truth, so a failed mirror returns
 * `false` instead of throwing — and records a `page-mirror-failed` ingest row,
 * because otherwise nothing outlives the request and a page that silently
 * stayed unsearchable leaves no trace anyone can find. Used by the write path
 * directly and by the `page_mirror` job.
 */
export async function mirrorPage(
  storage: Storage,
  page: MirrorPageInput,
  opts: MirrorPageOptions,
): Promise<boolean> {
  return (await mirrorPageVerdict(storage, page, opts)).ok;
}

export interface MirrorPageInput {
  slug: string;
  title: string | null;
  markdown_body: string;
  content_hash?: string;
  source_id?: string | null;
}

export interface MirrorPageVerdict {
  /** The mirror was written (or removed for an empty page). */
  ok: boolean;
  /** Set when the content-sanity gate hid the mirrored page from search. */
  quarantined?: QuarantineVerdict;
  /** Chunks mirrored without a vector because embedding was deferred. */
  embeddingDeferred?: number;
}

/**
 * {@link mirrorPage}, also reporting whether the content-sanity gate hid the
 * page, so a write path can tell its caller the page went into quarantine.
 */
export async function mirrorPageVerdict(
  storage: Storage,
  page: MirrorPageInput,
  opts: MirrorPageOptions,
): Promise<MirrorPageVerdict> {
  try {
    const indexed = await indexPageIntoSearch(
      storage,
      {
        slug: page.slug,
        title: page.title,
        markdown_body: page.markdown_body,
        ...(page.content_hash ? { content_hash: page.content_hash } : {}),
        ...(page.source_id ? { source_id: page.source_id } : {}),
      },
      {
        remote: opts.remote,
        ...(opts.timingLabel ? { timingLabel: opts.timingLabel } : {}),
        ...(opts.embedFn ? { embedFn: opts.embedFn } : {}),
        ...(opts.contextualLlmFn ? { contextualLlmFn: opts.contextualLlmFn } : {}),
      },
    );
    const deferred = indexed?.embeddingDeferred ?? 0;
    if (deferred > 0) await logMirrorDeferred(storage, page, deferred);
    return {
      ok: true,
      ...(indexed?.quarantined ? { quarantined: indexed.quarantined } : {}),
      ...(deferred > 0 ? { embeddingDeferred: deferred } : {}),
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[page-index] failed to mirror page ${page.slug} into search:`, reason);
    if (opts.logFailure === false) return { ok: false };
    try {
      await logIngest(storage.engine(), {
        source_type: "page-mirror-failed",
        source_ref: page.slug,
        pages_updated: [page.slug],
        summary: reason.slice(0, 500),
        ...(page.source_id ? { source_id: page.source_id } : {}),
      });
    } catch {
      // A logging failure must never turn a committed page write into a failed one.
    }
    return { ok: false };
  }
}

/**
 * A page mirrored without some of its vectors leaves a `page-mirror-deferred`
 * ingest row: the page is keyword-searchable, and the row says why semantic
 * search misses it until the embed-gaps phase catches up.
 */
async function logMirrorDeferred(storage: Storage, page: MirrorPageInput, chunks: number): Promise<void> {
  try {
    await logIngest(storage.engine(), {
      source_type: "page-mirror-deferred",
      source_ref: page.slug,
      pages_updated: [page.slug],
      summary: `${chunks} chunk(s) stored without embeddings; filled later by embed-gaps`,
      ...(page.source_id ? { source_id: page.source_id } : {}),
    });
  } catch {
    // A logging failure must never turn a committed page write into a failed one.
  }
}
