/**
 * Sources — first-class metadata layer above the documents table.
 *
 * A source declares:
 *   - kind: what *type* of thing it is (vault / memory / webhook / …).
 *   - path_prefix: the longest filesystem path prefix shared by docs
 *     belonging to it. Used to backfill and to pick the source for a
 *     freshly indexed document.
 *   - sync_policy: how the underlying content moves between disks
 *     (`synced` round-trips through an external file sync, `local-only`
 *     never does, `mirror` is one-way push to a remote).
 *   - indexed_policy: how much of the content to keep in our index
 *     (`verbatim` chunk text in DB, `hashed-only` privacy mode,
 *     `tombstoned` retains metadata only).
 *
 * wires this in. Phases 5+ honour it (search source-boost,
 * cycle skips tombstoned sources, etc.).
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Engine } from "./engine/interface.ts";
import { bumpDocumentClock } from "./generation.ts";
import { isNoSourceSentinel } from "./auth-info.ts";
import { canonicalPath, isUnderRoot, isWithinAllowedRoot, loadAllowedRootSpellings } from "./path_guard.ts";

export type SourceKind =
  | "vault"
  | "memory"
  | "webhook"
  | "mailbox"
  | "calendar"
  | "transcript"
  | "code"
  | "github"
  | "chat"
  | "meeting"
  | "other";

export const SOURCE_KINDS: readonly SourceKind[] = [
  "vault",
  "memory",
  "webhook",
  "mailbox",
  "calendar",
  "transcript",
  "code",
  "github",
  "chat",
  "meeting",
  "other",
];

export type SyncPolicy = "synced" | "local-only" | "mirror";
export type IndexedPolicy = "verbatim" | "hashed-only" | "tombstoned";

export interface SourceRow {
  id: string;
  kind: SourceKind;
  path_prefix: string;
  sync_policy: SyncPolicy;
  indexed_policy: IndexedPolicy;
  rate_limit_per_minute: number;
  respect_quiet_hours: boolean;
  boost_weight: number;
  description: string | null;
}

export interface RegisterSourceOptions {
  id: string;
  kind: SourceKind;
  pathPrefix: string;
  syncPolicy?: SyncPolicy;
  indexedPolicy?: IndexedPolicy;
  rateLimitPerMinute?: number;
  respectQuietHours?: boolean;
  boostWeight?: number;
  description?: string | null;
}

const SELECT_COLS =
  "id, kind, path_prefix, sync_policy, indexed_policy, " +
  "rate_limit_per_minute, respect_quiet_hours, boost_weight, description";

interface RawSourceRow extends Omit<SourceRow, "boost_weight"> {
  boost_weight: number | string;
}

function rowToSource(r: RawSourceRow): SourceRow {
  return {
    ...r,
    boost_weight: Number(r.boost_weight),
  };
}

/**
 * An empty prefix prefixes every path, so that source would claim every
 * document the next sweep classifies.
 */
function assertPathPrefix(pathPrefix: string): void {
  if (pathPrefix.trim() === "") {
    throw new Error("source: pathPrefix must not be empty");
  }
}

export async function registerSource(
  engine: Engine,
  opts: RegisterSourceOptions,
): Promise<SourceRow> {
  // The no-grant sentinel must never name a real source, or a caller denied
  // every source would read that one.
  if (isNoSourceSentinel(opts.id)) {
    throw new Error(`registerSource: "${opts.id}" is reserved`);
  }
  assertPathPrefix(opts.pathPrefix);
  const r = await engine.query<RawSourceRow>(
    `INSERT INTO sources (
       id, kind, path_prefix, sync_policy, indexed_policy,
       rate_limit_per_minute, respect_quiet_hours, boost_weight, description
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       kind = EXCLUDED.kind,
       path_prefix = EXCLUDED.path_prefix,
       sync_policy = EXCLUDED.sync_policy,
       indexed_policy = EXCLUDED.indexed_policy,
       rate_limit_per_minute = EXCLUDED.rate_limit_per_minute,
       respect_quiet_hours = EXCLUDED.respect_quiet_hours,
       boost_weight = EXCLUDED.boost_weight,
       description = EXCLUDED.description
     RETURNING ${SELECT_COLS}`,
    [
      opts.id,
      opts.kind,
      opts.pathPrefix,
      opts.syncPolicy ?? "synced",
      opts.indexedPolicy ?? "verbatim",
      opts.rateLimitPerMinute ?? 60,
      opts.respectQuietHours ?? false,
      opts.boostWeight ?? 1.0,
      opts.description ?? null,
    ],
  );
  if (!r.rows[0]) throw new Error(`registerSource: insert returned no row for ${opts.id}`);
  return rowToSource(r.rows[0]);
}

export interface ListSourcesOptions {
  kind?: SourceKind;
}

export async function listSources(
  engine: Engine,
  opts: ListSourcesOptions = {},
): Promise<SourceRow[]> {
  const params: unknown[] = [];
  let where = "";
  if (opts.kind) {
    params.push(opts.kind);
    where = `WHERE kind = $${params.length}`;
  }
  const r = await engine.query<RawSourceRow>(
    `SELECT ${SELECT_COLS} FROM sources ${where} ORDER BY path_prefix`,
    params,
  );
  return r.rows.map(rowToSource);
}

export async function getSource(
  engine: Engine,
  id: string,
): Promise<SourceRow | null> {
  const r = await engine.query<RawSourceRow>(
    `SELECT ${SELECT_COLS} FROM sources WHERE id = $1`,
    [id],
  );
  return r.rows[0] ? rowToSource(r.rows[0]) : null;
}

export interface UpdateSourceOptions {
  id: string;
  kind?: SourceKind;
  pathPrefix?: string;
  syncPolicy?: SyncPolicy;
  indexedPolicy?: IndexedPolicy;
  rateLimitPerMinute?: number;
  respectQuietHours?: boolean;
  boostWeight?: number;
  description?: string | null;
}

export async function updateSource(
  engine: Engine,
  opts: UpdateSourceOptions,
): Promise<SourceRow | null> {
  // Build a partial SET clause from defined fields only — keeps the
  // call site narrow ("only the boost weight changed") and avoids
  // round-tripping unset values that would erase prior state.
  const sets: string[] = [];
  const params: unknown[] = [opts.id];
  function add(col: string, value: unknown): void {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (opts.kind !== undefined) add("kind", opts.kind);
  if (opts.pathPrefix !== undefined) {
    assertPathPrefix(opts.pathPrefix);
    add("path_prefix", opts.pathPrefix);
  }
  if (opts.syncPolicy !== undefined) add("sync_policy", opts.syncPolicy);
  if (opts.indexedPolicy !== undefined) add("indexed_policy", opts.indexedPolicy);
  if (opts.rateLimitPerMinute !== undefined)
    add("rate_limit_per_minute", opts.rateLimitPerMinute);
  if (opts.respectQuietHours !== undefined)
    add("respect_quiet_hours", opts.respectQuietHours);
  if (opts.boostWeight !== undefined) add("boost_weight", opts.boostWeight);
  if (opts.description !== undefined) add("description", opts.description);
  if (sets.length === 0) return getSource(engine, opts.id);
  const r = await engine.query<RawSourceRow>(
    `UPDATE sources SET ${sets.join(", ")} WHERE id = $1 RETURNING ${SELECT_COLS}`,
    params,
  );
  return r.rows[0] ? rowToSource(r.rows[0]) : null;
}

/** The fallback tenant: legacy credentials with no grant resolve to it. */
const FALLBACK_SOURCE = "default";

/**
 * Everything that still points at a source, by kind. Content rows and client
 * rows would block a DELETE through their foreign keys; grants would not —
 * oauth codes, tokens, enrollments and PAT permissions name the source without
 * a foreign key, so deleting it would leave a live credential scoped to a
 * missing tenant. `default` is never deletable: credentials with no grant fall
 * back to it.
 */
export async function sourceReferences(engine: Engine, id: string): Promise<Record<string, number>> {
  const r = await engine.query<Record<string, number>>(
    `SELECT
       (SELECT COUNT(*) FROM documents WHERE source_id = $1)::int AS documents,
       (SELECT COUNT(*) FROM pages WHERE source_id = $1)::int AS pages,
       (SELECT COUNT(*) FROM page_versions WHERE source_id = $1)::int AS page_versions,
       (SELECT COUNT(*) FROM entity_facts WHERE source_id = $1)::int AS facts,
       (SELECT COUNT(*) FROM links WHERE source_id = $1)::int AS links,
       (SELECT COUNT(*) FROM tags WHERE source_id = $1)::int AS tags,
       (SELECT COUNT(*) FROM timeline_events WHERE source_id = $1)::int AS timeline_events,
       (SELECT COUNT(*) FROM synth_calibration_profile WHERE source_id = $1)::int AS calibration_profiles,
       -- Revoked clients count too: their row keeps a RESTRICT foreign key.
       (SELECT COUNT(*) FROM oauth_clients
         WHERE source_id = $1 OR $1 = ANY(federated_read))::int AS oauth_clients,
       (SELECT COUNT(*) FROM oauth_tokens
         WHERE revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > EXTRACT(EPOCH FROM NOW()))
           AND (source_id = $1 OR $1 = ANY(COALESCE(federated_read, '{}'))))::int AS oauth_tokens,
       (SELECT COUNT(*) FROM oauth_codes
         WHERE expires_at > EXTRACT(EPOCH FROM NOW())
           AND (source_id = $1 OR $1 = ANY(COALESCE(federated_read, '{}'))))::int AS oauth_codes,
       (SELECT COUNT(*) FROM oauth_enrollments
         WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()
           AND (source_id = $1 OR $1 = ANY(federated_read)))::int AS enrollments,
       -- Some rows hold permissions double-encoded as a JSON string; the token
       -- verifier accepts that shape, so the count must see through it too.
       (SELECT COUNT(*) FROM access_tokens
         WHERE revoked_at IS NULL
           AND (CASE WHEN jsonb_typeof(permissions) = 'string'
                     THEN (permissions #>> '{}')::jsonb
                     ELSE permissions END) -> 'source_id' @> to_jsonb($1::text))::int AS personal_tokens`,
    [id],
  );
  const row = r.rows[0] ?? {};
  const refs = Object.fromEntries(Object.entries(row).filter(([, n]) => Number(n) > 0).map(([k, n]) => [k, Number(n)]));
  return id === FALLBACK_SOURCE ? { fallback_source: 1, ...refs } : refs;
}

const FOREIGN_KEY_VIOLATION = "23503";

export async function deleteSource(
  engine: Engine,
  id: string,
): Promise<boolean> {
  // Refuse while anything still references the source; the caller reassigns,
  // revokes or unsets first (`sourceReferences` says what). The grant tables are
  // locked for the check-and-delete so a token minted mid-way cannot slip past.
  try {
    return await engine.transaction(async (tx) => {
      await tx.query(
        `LOCK TABLE oauth_clients, oauth_tokens, oauth_codes, oauth_enrollments, access_tokens IN SHARE ROW EXCLUSIVE MODE`,
      );
      if (Object.keys(await sourceReferences(tx, id)).length > 0) return false;
      const r = await tx.query<{ id: string }>(`DELETE FROM sources WHERE id = $1 RETURNING id`, [id]);
      return r.rows.length > 0;
    });
  } catch (err) {
    if ((err as { code?: string })?.code === FOREIGN_KEY_VIOLATION) return false;
    throw err;
  }
}

/**
 * A path belongs to a prefix when the prefix covers it up to a separator:
 * an exact prefix compare (`_` and `%` in a prefix are LIKE wildcards, and the
 * `__default__` sentinel carries four), and the prefix must end at a path
 * boundary, so `/vault/a` does not own `/vault/a-shared/x.md`.
 */
const PATH_PREFIX_MATCH = `left($1, length(path_prefix)) = path_prefix
        AND (
          right(path_prefix, 1) = '/'
          OR length($1) = length(path_prefix)
          OR substr($1, length(path_prefix) + 1, 1) = '/'
        )`;

/**
 * Pick the most specific source for a given source_path: longest matching
 * path_prefix wins. Returns null if no source matches.
 */
export async function resolveSourceForPath(
  engine: Engine,
  sourcePath: string,
): Promise<string | null> {
  const r = await engine.query<{ id: string }>(
    `SELECT id FROM sources
      WHERE ${PATH_PREFIX_MATCH}
      ORDER BY length(path_prefix) DESC
      LIMIT 1`,
    [sourcePath],
  );
  return r.rows[0]?.id ?? null;
}

interface SourcePrefix {
  id: string;
  prefix: string;
}

/** `PATH_PREFIX_MATCH` + `resolveSourceForPath` in JS, over a preloaded list. */
function owningSource(path: string, prefixes: readonly SourcePrefix[]): string | null {
  let best: SourcePrefix | null = null;
  for (const s of prefixes) {
    if (!path.startsWith(s.prefix)) continue;
    const bounded =
      s.prefix.endsWith("/") ||
      path.length === s.prefix.length ||
      path[s.prefix.length] === "/";
    if (bounded && (best === null || s.prefix.length > best.prefix.length)) best = s;
  }
  return best?.id ?? null;
}

/** What the daemon knows about the row a local re-read would overwrite. */
export interface StoredDocument {
  sourceId: string | null;
  lastIndexedMtime: number | null;
}

export type RereadVerdict =
  | { ok: true; canonical: string }
  | { ok: false; canonical: string; reason: string };

export type RereadGuard = (
  sourcePath: string,
  stored: StoredDocument | null,
) => RereadVerdict;

/**
 * Decides whether the daemon may read `sourcePath` off disk into the document
 * stored under it. The inline `index` form lets a remote caller label its
 * document with any path; a sweep or the cycle re-reading that label would copy
 * the daemon's file into a document the caller reads.
 *
 * The file is judged by where a read would land: its canonical path must sit
 * under `roots`, and the source owning that canonical path must be the owner
 * the row carries — or, for an unowned or absent row, the owner the path-prefix
 * backfill will give it from its label. A label that reaches another source's
 * file through `..` or a symlink fails that comparison. An unowned row a
 * registered source covers must also carry a file mtime, which only a local
 * read records: the inline form never does. An owned row whose file no source
 * covers passes on that mtime too: the operator reassigned a locally read row.
 */
export async function loadRereadGuard(
  engine: Engine,
  roots: readonly string[],
): Promise<RereadGuard> {
  const r = await engine.query<{ id: string; path_prefix: string }>(
    "SELECT id, path_prefix FROM sources",
  );
  const labelled: SourcePrefix[] = r.rows.map((s) => ({ id: s.id, prefix: s.path_prefix }));
  const canonical: SourcePrefix[] = labelled
    .filter((s) => isAbsolute(s.prefix))
    .map((s) => ({ id: s.id, prefix: canonicalPath(s.prefix) }));
  const canonicalRoots = roots.map(canonicalPath);
  return (sourcePath, stored) => {
    const path = canonicalPath(sourcePath);
    if (!isUnderRoot(path, canonicalRoots)) {
      return { ok: false, canonical: path, reason: "outside the configured roots" };
    }
    const owner = owningSource(path, canonical);
    const rowOwner = stored?.sourceId ?? owningSource(sourcePath, labelled);
    const reassigned =
      owner === null && stored !== null && stored.sourceId !== null && stored.lastIndexedMtime !== null;
    if (rowOwner !== owner && !reassigned) {
      return {
        ok: false,
        canonical: path,
        reason: `document belongs to source ${rowOwner ?? "(none)"}, the file to ${owner ?? "(none)"}`,
      };
    }
    if (stored && stored.sourceId === null && owner !== null && stored.lastIndexedMtime === null) {
      return { ok: false, canonical: path, reason: "unowned document was not written by a local read" };
    }
    return { ok: true, canonical: path };
  };
}

/**
 * The one way a daemon path turns a stored `source_path` into file content.
 * Reads the canonical file only when `guard` passes the row and the file is not
 * a denied name (.env, .git) inside a root; null otherwise. The caller still
 * passes `expectOwner` on the write, since the guard judged a snapshot.
 */
export function readGuardedFile(
  guard: RereadGuard,
  sourcePath: string,
  stored: StoredDocument | null,
): { text: string; mtimeMs: number } | null {
  const verdict = guard(sourcePath, stored);
  if (!verdict.ok || !isWithinAllowedRoot(verdict.canonical)) return null;
  const mtimeMs = Math.floor(statSync(verdict.canonical).mtimeMs);
  return { text: readFileSync(verdict.canonical, "utf8"), mtimeMs };
}

/**
 * The check `indexFile` and `indexCodeFile` make before reading a file into the
 * row stored under `sourcePath`, whoever calls them: the row is loaded fresh and
 * judged by `guard`, or by one over the configured vault and code roots. With no
 * root configured the caller named the file itself, so only ownership is judged.
 * Throws when the verdict fails; otherwise returns the owner the write must still
 * find (`expectOwner`), since a label can land between this read and the write.
 */
export async function guardLocalIndex(
  engine: Engine,
  sourcePath: string,
  guard?: RereadGuard,
): Promise<string | null> {
  const row = (
    await engine.query<{ source_id: string | null; last_indexed_mtime: number | null }>(
      // Rows whose id the path no longer hashes to can share it until the
      // write folds them; judge the one the write lands on.
      `SELECT source_id, last_indexed_mtime FROM documents WHERE source_path = $1
        ORDER BY id = 'doc_' || left(encode(sha256(convert_to($1::text, 'UTF8')), 'hex'), 16) DESC, id`,
      [sourcePath],
    )
  ).rows[0];
  const stored = row ? { sourceId: row.source_id, lastIndexedMtime: row.last_indexed_mtime } : null;
  let judge = guard;
  if (!judge) {
    const roots = loadAllowedRootSpellings();
    judge = await loadRereadGuard(engine, roots.length > 0 ? roots : [sourcePath]);
  }
  const verdict = judge(sourcePath, stored);
  if (!verdict.ok) throw new Error(`not indexing ${sourcePath}: ${verdict.reason}`);
  return stored?.sourceId ?? null;
}

/**
 * How many candidate rows a capped re-read phase may scan per row of work. The
 * SQL prefilter is looser than the guard, so a row it admits can still be
 * refused every tick; paging past refused rows up to this many keeps them from
 * holding the cap while bounding the scan.
 */
export const REREAD_SCAN_FACTOR = 10;

/**
 * The SQL side of `loadRereadGuard`, over `documents d`: a cheap prefilter that
 * keeps a capped batch spent on rows the guard can pass. `$<rootsParam>` is a
 * `text[]` of root spellings. The label must sit under a root, and the row's
 * owner must be the source its label's prefix names — or the row is unowned and
 * carries a local read's mtime, which the guard then judges by canonical path.
 * Labels are compared as stored, so `..` and symlinks get past it; every row it
 * admits still goes through the guard before any read.
 */
export function rereadCandidateWhere(rootsParam: number): string {
  const labelOwner = `(
           SELECT s.id FROM sources s
            WHERE left(d.source_path, length(s.path_prefix)) = s.path_prefix
              AND (
                right(s.path_prefix, 1) = '/'
                OR length(d.source_path) = length(s.path_prefix)
                OR substr(d.source_path, length(s.path_prefix) + 1, 1) = '/'
              )
            ORDER BY length(s.path_prefix) DESC
            LIMIT 1)`;
  return `EXISTS (SELECT 1 FROM unnest($${rootsParam}::text[]) AS r(root)
                   WHERE d.source_path = r.root
                      OR left(d.source_path, length(rtrim(r.root, '/')) + 1) = rtrim(r.root, '/') || '/')
       AND (
         d.source_id IS NOT DISTINCT FROM ${labelOwner}
         OR (d.source_id IS NULL AND d.last_indexed_mtime IS NOT NULL)
         OR (d.source_id IS NOT NULL AND d.last_indexed_mtime IS NOT NULL AND ${labelOwner} IS NULL)
       )`;
}


/**
 * Classify documents that carry no source yet, picking the most specific
 * `path_prefix` that owns their path, and hand the source down to their chunks
 * and code edges. Idempotent, and set-based because the sweeps run it after
 * every pass while documents no prefix matches stay NULL for good.
 *
 * `paths` is the provenance fence, and every caller passes one: only paths a
 * local indexer just wrote, or that a sweep confirmed already hold its own
 * newer index, are classified. Remote ingest (`index` with `sourcePath` +
 * `text`) labels a document in the CALLER's namespace — an unfenced backfill
 * would let that label pick a tenant's prefix and drop attacker-authored text
 * into that tenant's scoped reads. Pass a path only after the local write for
 * it succeeded; a path a walk merely saw says nothing about who wrote the row
 * sitting at it.
 */
export async function backfillDocumentSources(
  engine: Engine,
  paths: readonly string[],
): Promise<{ updated: number; unmatched: number }> {
  if (paths.length === 0) return { updated: 0, unmatched: 0 };
  return engine.transaction(async (tx) => {
    // `source_id` is a ranking-relevant field (source-boost weighting + the
    // scope filter on the keyword/vector arms), so changing it must invalidate
    // the two-layer query cache for the touched document: bump its `generation`
    // (Layer 2), and the global clock once (Layer 1).
    const moved = await tx.query<{ id: string }>(
      `UPDATE documents d
          SET source_id = m.source_id, generation = d.generation + 1
         FROM (
           SELECT DISTINCT ON (doc.id) doc.id AS doc_id, s.id AS source_id
             FROM documents doc
             JOIN sources s ON left(doc.source_path, length(s.path_prefix)) = s.path_prefix
              AND (
                right(s.path_prefix, 1) = '/'
                OR length(doc.source_path) = length(s.path_prefix)
                OR substr(doc.source_path, length(s.path_prefix) + 1, 1) = '/'
              )
            WHERE doc.source_id IS NULL
              AND doc.source_path = ANY($1::text[])
            ORDER BY doc.id, length(s.path_prefix) DESC
         ) m
        WHERE d.id = m.doc_id
      RETURNING d.id`,
      [paths as string[]],
    );
    // Chunks and code edges mirror their document's source; left NULL they
    // would stay invisible to the document's own scoped readers. Driven off the
    // rows' own state, not this pass's id list, so a document classified by an
    // earlier run that died before propagating is repaired here.
    const chunks = await tx.query<{ id: string }>(
      `UPDATE chunks c SET source_id = d.source_id
         FROM documents d
        WHERE c.document_id = d.id
          AND c.source_id IS NULL AND d.source_id IS NOT NULL
          AND d.source_path = ANY($1::text[])
      RETURNING c.id`,
      [paths as string[]],
    );
    const edges = await tx.query<{ id: number }>(
      `UPDATE code_edges_symbol e SET source_id = d.source_id
         FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE e.from_chunk_id = c.id
          AND e.source_id IS NULL AND d.source_id IS NOT NULL
          AND d.source_path = ANY($1::text[])
      RETURNING e.id`,
      [paths as string[]],
    );
    if (moved.rows.length > 0 || chunks.rows.length > 0 || edges.rows.length > 0) {
      await bumpDocumentClock(tx);
    }
    const left = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM documents
        WHERE source_id IS NULL AND source_path = ANY($1::text[])`,
      [paths as string[]],
    );
    return { updated: moved.rows.length, unmatched: left.rows[0]?.n ?? 0 };
  });
}
