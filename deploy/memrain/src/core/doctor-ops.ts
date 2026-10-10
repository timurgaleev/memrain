/**
 * Ops-facing brain-health probes for `memrain doctor`: stale cycle locks, job
 * queue depth/wedge, applied-vs-available schema version, embedding-width
 * consistency, and content-hash duplicate pages. Each returns
 * {ok, status, detail}; the caller turns a probe error into a `warn` verdict.
 * All read-only, config-free, no LLM — the substrate already exists
 * (cycle_locks mig 050, jobs mig 006, migrations table, vector(N),
 * pages.content_hash).
 */
import type { CheckStatus } from "./doctor-categories.ts";
import type { Engine } from "./engine/interface.ts";
import { diffMigrationIds, discoverMigrations } from "./migrate.ts";
import { EMBED_DIMENSIONS } from "./embedding.ts";
import { grammarSelfCheck } from "./chunkers/parsers.ts";
import { isJunkEntityName, isJunkEntitySlug } from "./entity-junk.ts";
import { Queue } from "./jobs/queue.ts";
import { bucketJobErrors } from "./jobs/error-classify.ts";

export interface OpsCheckResult {
  /** Exit-code driver — false only on `status:"fail"`. */
  ok: boolean;
  /** Three-state verdict; a `warn` is a real signal that must not gate. */
  status: CheckStatus;
  detail: string;
}

/**
 * Cycle locks whose TTL has elapsed but whose row is still present — an
 * orphaned holder (a crashed cycle). Reclaimed on the next acquire via the TTL
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
        ? "no stale cycle locks"
        : `${n} cycle lock(s) past TTL (oldest expired ${r.rows[0]?.oldest}) — reclaimed on next acquire`,
  };
}

/**
 * Every vendored tree-sitter grammar must LOAD and PARSE. A grammar that does
 * neither indexes zero symbols for its file type and nothing fails loudly —
 * that is exactly how the shell corpus went missing.
 *
 * This used to compare the blobs against `wasm/manifest.json`, which is a
 * manifest generated FROM those blobs: it could only ever confirm the blobs are
 * the blobs. Through the whole live incident the bytes matched and every .sh
 * file still threw inside the external scanner, so the failure that mattered
 * was invisible to the check meant to catch it. Now each language gets a short
 * probe parsed through the real runtime (see GRAMMAR_PROBES) and the detail
 * names which language broke and at which stage. Engine-free; takes the handle
 * to match the probe shape.
 */
export async function checkGrammars(_engine: Engine): Promise<OpsCheckResult> {
  // Resolved across two branches: the real self-check (loads each grammar and
  // parses a probe) from the code-index work, carrying the typed verdict from
  // the warn-tier work. The manifest comparison it replaced could only ever
  // confirm the blobs were the blobs.
  const results = await grammarSelfCheck();
  const broken = results.filter((r) => !r.ok);
  if (broken.length === 0) {
    return {
      ok: true,
      status: "ok",
      detail: `${results.length} grammar(s) load and parse a probe: ${results
        .map((r) => r.language)
        .join(", ")}`,
    };
  }
  return {
    ok: false,
    status: "fail",
    detail:
      `unusable grammar(s): ${broken
        .map((b) => `${b.language} failed at ${b.stage} — ${b.error}`)
        .join("; ")} — files of the affected language(s) index as plain text, ` +
      `with no symbols and no call graph`,
  };
}

function jobWedgeSeconds(): number {
  const n = Number.parseInt(process.env.MEMRAIN_DOCTOR_JOB_WEDGE_SEC ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 3600;
}

/**
 * Job queue depth + wedged-job count (a `running` job older than the wedge
 * threshold, default 1h via MEMRAIN_DOCTOR_JOB_WEDGE_SEC). A deep pending queue is
 * normal mid-backfill (informational); a wedged job is the signal to look. Only
 * a wedged job flips ok:false. The detail also counts jobs waiting out an LLM
 * outage and groups the last 24 h of failures by cause.
 */
export async function checkQueueHealth(engine: Engine): Promise<OpsCheckResult> {
  const wedgeSec = jobWedgeSeconds();
  const r = await engine.query<{
    pending: number;
    running: number;
    wedged: number;
    deferred: number;
  }>(
    `SELECT
        count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'running')::int AS running,
        count(*) FILTER (WHERE status = 'running'
                         AND started_at IS NOT NULL
                         AND started_at < NOW() - $1 * INTERVAL '1 second')::int AS wedged,
        count(*) FILTER (WHERE status = 'pending'
                         AND last_error LIKE 'deferred:%')::int AS deferred
       FROM jobs`,
    [wedgeSec],
  );
  const pending = r.rows[0]?.pending ?? 0;
  const running = r.rows[0]?.running ?? 0;
  const wedged = r.rows[0]?.wedged ?? 0;
  const deferred = r.rows[0]?.deferred ?? 0;
  // What the last day's failures were, so the detail names the fix.
  const failures = await new Queue(engine).recentFailures(new Date(Date.now() - 86_400_000));
  const buckets = bucketJobErrors(failures.map((f) => f.lastError));
  const failedNote =
    failures.length === 0
      ? ""
      : ` failed_24h=${failures.length} (${buckets.map((b) => `${b.bucket}:${b.count}`).join(", ")})`;
  return {
    ok: wedged === 0,
    status: wedged === 0 ? "ok" : "fail",
    detail:
      `pending=${pending} running=${running} deferred=${deferred}` +
      failedNote +
      (wedged > 0 ? ` — ${wedged} wedged (running > ${wedgeSec}s)` : ""),
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
 * instead of hiding as slow searches. Recover by rebuilding the index (a manual
 * `CREATE INDEX CONCURRENTLY` + drop of the invalid one). Read-only.
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
    detail: `${bad.length} invalid index(es) — Postgres ignores these, so lookups silently seq-scan: ${names}. Recover with \`REINDEX INDEX CONCURRENTLY <name>\` (online, no write lock)`,
  };
}

/**
 * Duplicate live pages: the same (source_id, content_hash) present under more
 * than one slug — the fingerprint of a path remap or a double import landing
 * one body twice. Retrieval still works (both copies rank, dedup collapses
 * near-twins), so a duplicate group warns rather than fails (ok:true); the
 * sample names the slug groups so the operator knows what to reconcile.
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

/** Entity page types a junk name can accrete edges on. */
const JUNK_HUB_TYPES = ["person", "company", "concept"] as const;
/** Bound on the entity pages loaded for the name test — a doctor probe must
 *  stay cheap on a large brain. */
const JUNK_HUB_SCAN_LIMIT = 50_000;

/**
 * Junk entity hubs: entity pages whose name is a placeholder ("team",
 * "unknown", "user", a bare number) ranked by edge count. The shared
 * junk-entity gate stops new ones at every creation point, but pages minted
 * before it keep their edges and keep pulling unrelated pages together in
 * traversal. Read-only; warn, never fail — merging or deleting a hub is the
 * operator's call.
 */
export async function checkJunkEntityHubs(
  engine: Engine,
): Promise<OpsCheckResult> {
  const typeList = JUNK_HUB_TYPES.map((t) => `'${t}'`).join(", ");
  const pages = await engine.query<{ slug: string; title: string | null }>(
    `SELECT slug, title FROM pages
      WHERE deleted_at IS NULL AND type IN (${typeList})
      ORDER BY slug
      LIMIT ${JUNK_HUB_SCAN_LIMIT}`,
  );
  const junk = pages.rows
    .filter((p) => isJunkEntitySlug(p.slug) || (p.title !== null && p.title.trim() !== "" && isJunkEntityName(p.title)))
    .map((p) => p.slug);
  if (junk.length === 0) {
    return { ok: true, status: "ok", detail: "no junk-named entity pages" };
  }
  const top = await engine.query<{ slug: string; n: number }>(
    `SELECT j.slug,
            (SELECT count(*) FROM links l
              WHERE l.source_slug = j.slug OR l.target_slug = j.slug)::int AS n
       FROM unnest($1::text[]) AS j(slug)
      ORDER BY n DESC, j.slug
      LIMIT 5`,
    [junk],
  );
  const sample = top.rows.map((r) => `${r.slug} (${r.n} links)`).join(", ");
  return {
    ok: true,
    status: "warn",
    detail:
      `${junk.length} junk-named entity page(s); most linked: ${sample}` +
      " — merge or delete them so they stop joining unrelated pages",
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
 * EMBED_DIMENSIONS (MEMRAIN_EMBED_DIM). The `vector(N)` column is fixed-width, so
 * a mismatch means the config was changed without migrating the column — new
 * embeds would break. Flips ok:false so the drift is visible before it bites.
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
  return {
    ok,
    status: ok ? "ok" : "fail",
    detail: ok
      ? `embeddings are ${stored}-dim (matches configured ${EMBED_DIMENSIONS})`
      : `stored embeddings are ${stored}-dim but config expects ${EMBED_DIMENSIONS} — reindex or align MEMRAIN_EMBED_DIM`,
  };
}
