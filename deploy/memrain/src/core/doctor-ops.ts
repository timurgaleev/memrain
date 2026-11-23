/**
 * Ops-facing brain-health probes for `memrain doctor`: stale maintenance
 * locks, applied-vs-available schema version, embedding-width consistency,
 * invalid indexes, content-hash duplicate pages, dangling slug redirects and
 * quarantined pages. Each returns {ok, status, detail}; the caller turns a
 * probe error into a `warn` verdict. All read-only, config-free, no LLM.
 */
import type { CheckStatus } from "./doctor-categories.ts";
import type { Engine } from "./engine/interface.ts";
import { diffMigrationIds, discoverMigrations } from "./migrate.ts";
import { EMBED_DIMENSIONS } from "./embedding.ts";
import { embeddingVectorType } from "./embedding-column.ts";
import { runtimeOverlayState } from "./runtime-config.ts";

export interface OpsCheckResult {
  /** Exit-code driver — false only on `status:"fail"`. */
  ok: boolean;
  /** Three-state verdict; a `warn` is a real signal that must not gate. */
  status: CheckStatus;
  detail: string;
}

export async function checkRuntimeConfigOverlay(engine: Engine): Promise<OpsCheckResult> {
  const state = runtimeOverlayState(engine);
  return { ok: true, status: state === "unavailable" ? "warn" : "ok", detail: `runtime config overlay: ${state}${state === "unavailable" ? "; DB overrides could not be loaded; inspect connection and SQLSTATE log, then restart" : ""}` };
}

/**
 * Maintenance locks whose TTL has elapsed but whose row is still present — an
 * orphaned holder (a crashed run). Reclaimed on the next acquire via the TTL
 * fallback, so this is informational (ok:true) unless one persists run to run.
 */
export async function checkStaleLocks(engine: Engine): Promise<OpsCheckResult> {
  const r = await engine.query<{ n: number; oldest: string | null }>(
    `SELECT count(*)::int AS n,
            to_char(MIN(ttl_expires_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS oldest
       FROM cycle_locks WHERE ttl_expires_at < NOW()`,
  );
  const n = r.rows[0]?.n ?? 0;
  return {
    ok: true,
    status: "ok",
    detail:
      n === 0
        ? "no stale maintenance locks"
        : `${n} maintenance lock(s) past TTL (oldest expired ${r.rows[0]?.oldest}) — reclaimed on next acquire`,
  };
}

/**
 * Applied vs available schema version, compared as full id sets (see
 * `diffMigrationIds`). Unapplied migrations past the applied head flip
 * ok:false — a real, actionable drift (run `memrain apply-migrations`).
 * Applied ids this build does not know (the image was rolled back under a newer
 * schema) and holes below the head both warn.
 */
export async function checkSchemaVersion(
  engine: Engine,
): Promise<OpsCheckResult> {
  const r = await engine.query<{ id: number }>(
    `SELECT id::int AS id FROM migrations ORDER BY id`,
  );
  const appliedIds = r.rows.map((row) => Number(row.id));
  const head = appliedIds.length > 0 ? Math.max(...appliedIds) : 0;
  let availableIds: number[] | null = null;
  try {
    availableIds = discoverMigrations().map((m) => m.id);
  } catch {
    // Can't read the migrations dir (packaged oddly) — report applied only.
  }
  const base = `schema at migration ${head} (${appliedIds.length} applied)`;
  if (availableIds === null) {
    return { ok: true, status: "ok", detail: `${base}, migration files unreadable` };
  }
  const { ahead, gaps, pending } = diffMigrationIds(appliedIds, availableIds);
  const notes: string[] = [];
  if (pending.length > 0) {
    notes.push(`${pending.length} unapplied through ${pending[pending.length - 1]}; run \`memrain apply-migrations\``);
  }
  if (ahead.length > 0) {
    notes.push(`schema ahead of this build: applied migration(s) ${ahead.join(", ")} unknown to the image (rolled back?)`);
  }
  if (gaps.length > 0) {
    notes.push(`gap: migration(s) ${gaps.join(", ")} not applied below the head`);
  }
  const status = pending.length > 0 ? "fail" : notes.length > 0 ? "warn" : "ok";
  return {
    ok: status !== "fail",
    status,
    detail: notes.length > 0 ? `${base} — ${notes.join("; ")}` : `${base}, up to date`,
  };
}

/**
 * Invalid indexes: any index left `indisvalid = false` — the fingerprint of a
 * failed or interrupted build (a killed `CREATE INDEX CONCURRENTLY`, or an OOM
 * mid-build, which memrain has a live history of). Postgres keeps such an index
 * present but NEVER uses it for query planning, so the HNSW vector arm (or any
 * indexed lookup) silently falls back to a sequential scan with no error — a
 * quiet retrieval-quality regression. Flips ok:false so it surfaces in `doctor`
 * instead of hiding as slow searches. Recover by rebuilding the index:
 * `memrain hnsw rebuild` for the embeddings HNSW (non-concurrent — a concurrent
 * HNSW build holds two graphs and exhausted a 1 GB instance). Read-only.
 */
export async function checkInvalidIndexes(
  engine: Engine,
): Promise<OpsCheckResult> {
  const r = await engine.query<{ indexname: string; tablename: string }>(
    `SELECT c.relname AS indexname, t.relname AS tablename
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE i.indisvalid = false
        AND n.nspname = 'public'
      ORDER BY c.relname`,
  );
  const bad = r.rows;
  if (bad.length === 0) {
    return { ok: true, status: "ok", detail: "all indexes valid" };
  }
  const names = bad.map((b) => `${b.indexname} (on ${b.tablename})`).join(", ");
  return {
    ok: false,
    status: "fail",
    detail: `${bad.length} invalid index(es) — Postgres ignores these, so lookups silently seq-scan: ${names}. Recover the embeddings HNSW with \`memrain hnsw rebuild\` (non-concurrent: vector search pauses for the build, keyword search keeps serving; never REINDEX CONCURRENTLY an HNSW index on a small instance), any other index with \`REINDEX INDEX <name>\``,
  };
}

/**
 * Duplicate live pages: the same (source_id, content_hash) present under more
 * than one slug — the fingerprint of a path remap or a double import landing
 * one body twice. Retrieval still works (both copies rank, dedup collapses
 * near-twins), so a duplicate group warns rather than fails (ok:true); the
 * sample names the slug groups so the operator knows what to reconcile.
 *
 * Connector pages are left out. Each mirrors one provider item under the
 * account that synced it (the slug is made from the item's id and the
 * account), so the sync never stores one item twice; two connector pages with
 * one body are two items that read alike, or two connected accounts' copies of
 * one meeting or mail. Neither is a double import, and the next sync would
 * rewrite whatever the operator merged. A page retention handed to the brain
 * (origin `connector_detached`) is the brain's own again and is counted.
 */
export async function checkDuplicatePages(
  engine: Engine,
): Promise<OpsCheckResult> {
  // Window count over the grouped subquery = total groups; LIMIT keeps the
  // sample small without losing that total.
  const r = await engine.query<{ slugs: string; total: number }>(
    `SELECT g.slugs, count(*) OVER ()::int AS total
       FROM (SELECT string_agg(slug, ', ' ORDER BY slug) AS slugs
               FROM pages
              WHERE deleted_at IS NULL
                AND (compiled_truth->>'origin') IS DISTINCT FROM 'connector'
              GROUP BY source_id, content_hash
             HAVING count(*) > 1
              ORDER BY count(*) DESC, MIN(slug)) g
      LIMIT 3`,
  );
  const total = r.rows[0]?.total ?? 0;
  if (total === 0) {
    return { ok: true, status: "ok", detail: "no duplicate pages" };
  }
  const sample = r.rows.map((x) => `[${x.slugs}]`).join("; ");
  // The warn tier is the typed field now; the old `WARN:` prefix said the same
  // thing in a form only a string match could read.
  return {
    ok: true,
    status: "warn",
    detail: `${total} duplicate page group(s) — same source + content under multiple slugs, e.g. ${sample}`,
  };
}

/**
 * Slug redirects whose target is not a live page. slug_aliases has no foreign
 * key to pages, and the resolver now forwards only to live pages, so such a
 * row is dead weight that hides why an old name stopped resolving (rows left
 * from before the purge cleaned redirects, or a target that was only
 * soft-deleted). Read-only; warn, never fail.
 */
export async function checkDanglingSlugRedirects(
  engine: Engine,
): Promise<OpsCheckResult> {
  const r = await engine.query<{ alias_slug: string; canonical_slug: string; total: number }>(
    `SELECT a.alias_slug, a.canonical_slug, count(*) OVER ()::int AS total
       FROM slug_aliases a
       LEFT JOIN pages p ON p.slug = a.canonical_slug AND p.deleted_at IS NULL
      WHERE p.slug IS NULL
      ORDER BY a.alias_slug
      LIMIT 3`,
  );
  const total = r.rows[0]?.total ?? 0;
  if (total === 0) {
    return { ok: true, status: "ok", detail: "every slug redirect points at a live page" };
  }
  const sample = r.rows.map((x) => `${x.alias_slug} -> ${x.canonical_slug}`).join(", ");
  return {
    ok: true,
    status: "warn",
    detail: `${total} slug redirect(s) point at no live page, e.g. ${sample} — delete them or restore the target`,
  };
}

/**
 * Quarantined pages: how many the content-sanity gate is hiding and which
 * patterns hid them. A false positive vanishes from search silently, so the
 * count alone is not enough — the top patterns say which one to switch off
 * (`MEMRAIN_CONTENT_SANITY_DISABLE`) before `memrain quarantine clear`. Warn, never
 * fail: a held page is the gate working, not a broken brain.
 */
export async function checkQuarantinedPages(
  engine: Engine,
): Promise<OpsCheckResult> {
  const total = await engine.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM documents WHERE frontmatter ? 'quarantine'`,
  );
  const n = total.rows[0]?.n ?? 0;
  if (n === 0) {
    return { ok: true, status: "ok", detail: "no quarantined pages" };
  }
  // The marker's detail is the comma-joined list of pattern names that fired.
  const top = await engine.query<{ pattern: string; n: number }>(
    `SELECT trim(p) AS pattern, count(*)::int AS n
       FROM documents d,
            unnest(string_to_array(COALESCE(d.frontmatter->'quarantine'->>'detail', ''), ',')) AS p
      WHERE d.frontmatter ? 'quarantine' AND trim(p) <> ''
      GROUP BY trim(p)
      ORDER BY n DESC, pattern
      LIMIT 3`,
  );
  const patterns = top.rows.map((r) => `${r.pattern}=${r.n}`).join(", ");
  return {
    ok: true,
    status: "warn",
    detail:
      `${n} quarantined page(s) hidden from search` +
      (patterns ? `; top patterns: ${patterns}` : "") +
      " — review with `memrain quarantine list`",
  };
}

/**
 * Embedding-width consistency: the stored vector width vs the configured
 * EMBED_DIMENSIONS (MEMRAIN_EMBED_DIM). The column (`halfvec(N)`, or `vector(N)`
 * where pgvector lacks halfvec) is fixed-width, so a mismatch means the config
 * was changed without migrating the column — new embeds would break. Flips
 * ok:false so the drift is visible before it bites. `vector_dims` reads both types.
 */
export async function checkEmbeddingWidth(
  engine: Engine,
): Promise<OpsCheckResult> {
  // DISTINCT across all rows (not a single unordered sample) so the result is
  // deterministic: mid dimension-migration, old- and new-width rows coexist and
  // an unordered LIMIT 1 would flicker the health signal. Surfacing >1 distinct
  // width IS the drift signal.
  const r = await engine.query<{ dims: number }>(
    `SELECT DISTINCT vector_dims(vector) AS dims
       FROM embeddings WHERE vector IS NOT NULL ORDER BY dims`,
  );
  const widths = r.rows.map((x) => x.dims);
  if (widths.length === 0) {
    return { ok: true, status: "ok", detail: "no embeddings yet" };
  }
  if (widths.length > 1) {
    return {
      ok: false,
      status: "fail",
      detail: `mixed embedding widths present (${widths.join(", ")}; expected ${EMBED_DIMENSIONS}) — a dimension migration is incomplete; finish the re-embed`,
    };
  }
  const stored = widths[0]!;
  const ok = stored === EMBED_DIMENSIONS;
  const type = await embeddingVectorType(engine);
  return {
    ok,
    status: ok ? "ok" : "fail",
    detail: ok
      ? `embeddings are ${stored}-dim ${type} (matches configured ${EMBED_DIMENSIONS})`
      : `stored embeddings are ${stored}-dim but config expects ${EMBED_DIMENSIONS} — reindex or align MEMRAIN_EMBED_DIM`,
  };
}

