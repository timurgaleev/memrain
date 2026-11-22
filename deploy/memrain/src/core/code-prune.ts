/**
 * Code prune — retire the documents of source files deleted from a code root.
 *
 * The code sweep re-indexes new and changed files but never sees a deletion:
 * a removed file's document, chunks, vectors, mentions and call edges stay
 * live, and its symbols keep answering `search` and every `code_*` tool. This
 * pass soft-deletes those documents (`documents.deleted_at`, purged after the
 * shared 72 h TTL) and writes one `code_prunes` row each (migration 190): the
 * pass, the time, the root and the reason. Nothing is hard-deleted here, and
 * the chunks, vectors and edges stay in place, so `restoreCodePrunes` brings a
 * document back exactly as it was.
 *
 * A document is a candidate only when all of these hold:
 *   - it is live (not deleted, not archived) and `frontmatter.kind = 'code'`;
 *   - its source_path sits under the root that was just walked;
 *   - the source owning that path is a `code` source (or none is registered),
 *     and the document is that source's or unowned, so a row another source
 *     wrote under the same prefix is never touched;
 *   - stat says ENOENT or ENOTDIR. Any other error (EACCES, EIO) means the
 *     file's state is unknown and the document is kept.
 *
 * A root is pruned only after a complete walk: it exists, the walk read every
 * directory and file it met, it found at least one file, and no file budget
 * cut it short. A missing document whose content arrived at a new path in the
 * same walk (`git mv`, a renamed folder) is a move: it is retired without
 * counting toward the valve. Past that, the valve (`codePruneTrip`) withholds
 * the deletions of a pass that would retire more than one document and more
 * than half of a root's live code documents, more than CODE_PRUNE_MAX_DELETES
 * of them, or more than CODE_PRUNE_MAX_RATIO of them once past
 * CODE_PRUNE_RATIO_FLOOR: a half-mounted
 * checkout looks exactly like a mass deletion. Only `memrain code prune
 * --apply --allow-mass-delete` goes past it.
 */
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { Engine } from "./engine/interface.ts";
import { bumpDocumentClock } from "./generation.ts";
import { owningSource } from "./sources.ts";

/**
 * A pass retiring more than one document and more than this share of a root's
 * live code documents is withheld, whatever the root's size: a code root is a
 * mount, and a small one half gone is more likely a broken mount than a
 * deletion.
 */
export const CODE_PRUNE_MASS_RATIO = 0.5;
/** A pass retiring more documents than this is withheld. */
export const CODE_PRUNE_MAX_DELETES = 500;
/** A pass retiring more than CODE_PRUNE_RATIO_FLOOR documents and more than this share of the root's live code documents is withheld. */
export const CODE_PRUNE_MAX_RATIO = 0.01;
/** The share check only applies past this many deletions, so a small root's ordinary deletion of a folder is not withheld. */
export const CODE_PRUNE_RATIO_FLOOR = 50;
/**
 * How much longer than the purge TTL a pruned document whose file is back may
 * wait for a code sweep to revive it. Past that the purge goes ahead.
 */
export const CODE_PRUNE_PURGE_HOLD_HOURS = 72;

/** `MEMRAIN_CODE_PRUNE=0` stops the code sweep pruning on its own. On by default. */
export function codePruneAutoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !["0", "false", "off", "no"].includes((env.MEMRAIN_CODE_PRUNE ?? "").trim().toLowerCase());
}

/** What a walk of one root proved, which decides whether its missing files may be acted on. */
export interface CodeWalkEvidence {
  /** The root as configured. */
  root: string;
  /** The root did not exist on disk. */
  missing: boolean;
  /** Indexable files the walk found. */
  files: number;
  /** Directories or files the walk could not read. */
  walkErrors: number;
  /** A file budget stopped the walk before it finished. */
  partial: boolean;
  /** Documents this walk created at paths that had none: new files, or the new end of a move. */
  arrived?: string[];
}

export type CodePruneRefusal = "root_missing" | "empty_walk" | "walk_errors" | "partial_walk" | "mass_delete";

export interface CodePruneCandidate {
  id: string;
  source_id: string | null;
  source_path: string;
}

export interface CodePruneRootReport {
  root: string;
  /** `pruned`: documents were retired; `clean`: nothing was missing; `withheld`: refused, nothing written. */
  status: "pruned" | "clean" | "withheld" | "dry_run";
  reason?: CodePruneRefusal;
  /** Live code documents under the root this pass may act on. */
  live?: number;
  /** Of those, documents whose file is gone. */
  missing?: number;
  /** Documents whose file could not be checked (kept). */
  unknown?: number;
  /** Of the missing, documents whose content arrived at a new path in this walk: retired as moves, outside the valve. */
  moved?: number;
  /** Missing documents an operator restored before; only the CLI prunes them again. */
  held?: number;
  pruned?: number;
  /** Up to ten missing paths, for the log and the dry run. */
  sample?: string[];
}

export interface CodePruneResult {
  /** Set when this pass retired at least one document; `memrain code restore --sweep <id>` undoes it. */
  sweep_id?: string;
  pruned: number;
  roots: CodePruneRootReport[];
}

export interface CodePruneOptions {
  trigger: "sweep" | "cli";
  /** False: report what would happen, write nothing. */
  apply: boolean;
  /** Go past the valve. CLI only. */
  allowMassDelete?: boolean;
  /** Prune documents an operator restored before too. The automatic pass leaves them alone. */
  includeHeld?: boolean;
}

const SAMPLE = 10;

type FileState = "present" | "missing" | "unknown";

function fileState(path: string): FileState {
  try {
    statSync(path);
    return "present";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown";
  }
}

function withSlash(root: string): string {
  return root.endsWith("/") ? root : `${root}/`;
}

/** The valve: true when retiring `deletes` of `live` documents looks like a broken mount, not a deletion. */
export function codePruneTrip(deletes: number, live: number): boolean {
  if (deletes <= 0) return false;
  if (deletes > 1 && deletes > live * CODE_PRUNE_MASS_RATIO) return true;
  if (deletes > CODE_PRUNE_MAX_DELETES) return true;
  return deletes > CODE_PRUNE_RATIO_FLOOR && deletes > live * CODE_PRUNE_MAX_RATIO;
}

/**
 * A digest of each document's stored chunk texts in order. A moved file is
 * re-indexed into the same chunks under its new path, so equal digests pair a
 * document left behind with the one its content arrived as.
 */
async function contentDigests(engine: Engine, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  // scope: operator-only digests of documents the operator's code walk just planned or wrote
  const r = await engine.query<{ document_id: string; digest: string }>(
    `SELECT c.document_id, md5(string_agg(c.content, chr(31) ORDER BY c.chunk_index)) AS digest
       FROM chunks c
      WHERE c.document_id = ANY($1::text[])
      GROUP BY c.document_id`,
    [[...ids]],
  );
  return new Map(r.rows.map((row) => [row.document_id, row.digest]));
}

/** Of `targets`, those whose content arrived elsewhere; each arrival pairs with one target. */
async function pairMoves(
  engine: Engine,
  targets: readonly CodePruneCandidate[],
  arrivals: Map<string, number>,
): Promise<CodePruneCandidate[]> {
  if (arrivals.size === 0) return [];
  const digests = await contentDigests(engine, targets.map((t) => t.id));
  const moved: CodePruneCandidate[] = [];
  for (const t of targets) {
    const digest = digests.get(t.id);
    const left = digest === undefined ? 0 : (arrivals.get(digest) ?? 0);
    if (left === 0) continue;
    arrivals.set(digest!, left - 1);
    moved.push(t);
  }
  return moved;
}

function refusal(evidence: CodeWalkEvidence): CodePruneRefusal | null {
  if (evidence.missing) return "root_missing";
  if (evidence.partial) return "partial_walk";
  if (evidence.walkErrors > 0) return "walk_errors";
  if (evidence.files === 0) return "empty_walk";
  return null;
}

interface RootPlan {
  live: number;
  missing: CodePruneCandidate[];
  unknown: number;
  held: CodePruneCandidate[];
}

/** The live code documents under `root` this pass may act on, and which of their files are gone. */
async function planRoot(engine: Engine, root: string): Promise<RootPlan> {
  const prefix = withSlash(root);
  // scope: operator-only the code sweep and the local CLI prune the operator's configured code roots
  const rows = await engine.query<CodePruneCandidate>(
    `SELECT d.id, d.source_id, d.source_path
       FROM documents d
      WHERE d.deleted_at IS NULL AND NOT d.archived
        AND d.frontmatter->>'kind' = 'code'
        AND left(d.source_path, length($1)) = $1
      ORDER BY d.source_path`,
    [prefix],
  );
  const sources = await engine.query<{ id: string; kind: string; path_prefix: string }>(
    "SELECT id, kind, path_prefix FROM sources",
  );
  const kinds = new Map(sources.rows.map((s) => [s.id, s.kind]));
  const prefixes = sources.rows.map((s) => ({ id: s.id, prefix: s.path_prefix }));
  const eligible = rows.rows.filter((r) => {
    const owner = owningSource(r.source_path, prefixes);
    if (owner !== null && kinds.get(owner) !== "code") return false;
    return r.source_id === null || r.source_id === owner;
  });
  const missing: CodePruneCandidate[] = [];
  let unknown = 0;
  for (const r of eligible) {
    const state = fileState(r.source_path);
    if (state === "missing") missing.push(r);
    else if (state === "unknown") unknown++;
  }
  let held: CodePruneCandidate[] = [];
  if (missing.length > 0) {
    // scope: operator-only provenance of documents this root's plan already selected
    const restored = await engine.query<{ document_id: string }>(
      `SELECT document_id FROM (
         SELECT DISTINCT ON (document_id) document_id, restored_by, hold_released_at
           FROM code_prunes
          WHERE document_id = ANY($1::text[])
          ORDER BY document_id, id DESC) latest
        WHERE restored_by = 'cli' AND hold_released_at IS NULL`,
      [missing.map((m) => m.id)],
    );
    const heldIds = new Set(restored.rows.map((r) => r.document_id));
    held = missing.filter((m) => heldIds.has(m.id));
  }
  return { live: eligible.length, missing, unknown, held };
}

function newSweepId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `cp-${stamp}-${randomBytes(3).toString("hex")}`;
}

/**
 * Soft-delete `candidates` and record each one under `sweepId`. A file that came
 * back since the plan is kept, and so is a row an indexer or a source
 * reassignment changed since: the update re-states the plan's path, owner and
 * kind. Returns the source_paths retired.
 */
async function retire(
  engine: Engine,
  root: string,
  candidates: readonly CodePruneCandidate[],
  sweepId: string,
  trigger: "sweep" | "cli",
): Promise<string[]> {
  const gone = candidates.filter((c) => fileState(c.source_path) === "missing");
  if (gone.length === 0) return [];
  let paths: string[] = [];
  await engine.transaction(async (tx) => {
    const r = await tx.query<{ id: string; source_path: string }>(
      `UPDATE documents d
          SET deleted_at = NOW(), updated_at = NOW(), generation = d.generation + 1
         FROM unnest($1::text[], $2::text[], $3::text[]) AS c(id, path, src)
        WHERE d.id = c.id AND d.source_path = c.path AND d.source_id IS NOT DISTINCT FROM c.src
          AND d.frontmatter->>'kind' = 'code' AND d.deleted_at IS NULL AND NOT d.archived
        RETURNING d.id, d.source_path`,
      [gone.map((c) => c.id), gone.map((c) => c.source_path), gone.map((c) => c.source_id)],
    );
    if (r.rows.length === 0) return;
    // scope: operator-only records the documents retired just above
    await tx.query(
      `INSERT INTO code_prunes (sweep_id, trigger, document_id, source_id, source_path, root, pruned_at)
       SELECT $2, $3, d.id, d.source_id, d.source_path, $4, d.deleted_at
         FROM documents d
        WHERE d.id = ANY($1::text[])`,
      [r.rows.map((row) => row.id), sweepId, trigger, root],
    );
    await bumpDocumentClock(tx);
    paths = r.rows.map((row) => row.source_path).sort();
  });
  return paths;
}

/**
 * Plan, and with `apply` carry out, the prune of every root in `roots`. `roots`
 * carries what each root's walk proved; a root whose walk cannot be trusted is
 * reported and left alone. `root` must be spelled the way the indexer stores
 * source paths (normalizeSourcePath).
 */
export async function pruneCodeRoots(
  engine: Engine,
  roots: readonly CodeWalkEvidence[],
  opts: CodePruneOptions,
): Promise<CodePruneResult> {
  const result: CodePruneResult = { pruned: 0, roots: [] };
  // One pool for the whole walk: a file may move from one root to another.
  const arrivals = new Map<string, number>();
  for (const digest of (await contentDigests(engine, roots.flatMap((r) => r.arrived ?? []))).values()) {
    arrivals.set(digest, (arrivals.get(digest) ?? 0) + 1);
  }
  for (const evidence of roots) {
    const refused = refusal(evidence);
    if (refused) {
      result.roots.push({ root: evidence.root, status: "withheld", reason: refused });
      continue;
    }
    const plan = await planRoot(engine, evidence.root);
    const heldIds = new Set(plan.held.map((h) => h.id));
    const targets = opts.includeHeld ? plan.missing : plan.missing.filter((m) => !heldIds.has(m.id));
    const report: CodePruneRootReport = {
      root: evidence.root,
      status: "clean",
      live: plan.live,
      missing: plan.missing.length,
      unknown: plan.unknown,
      held: plan.held.length,
      sample: plan.missing.slice(0, SAMPLE).map((m) => m.source_path),
    };
    if (targets.length === 0) {
      result.roots.push(report);
      continue;
    }
    const moved = await pairMoves(engine, targets, arrivals);
    if (moved.length > 0) report.moved = moved.length;
    // A move is retired even when the valve withholds the pass's deletions.
    const tripped = codePruneTrip(targets.length - moved.length, plan.live) && !opts.allowMassDelete;
    const retiring = tripped ? moved : targets;
    const withheld = { status: "withheld", reason: "mass_delete" } as const;
    if (!opts.apply || retiring.length === 0) {
      result.roots.push({ ...report, ...(tripped ? withheld : { status: "dry_run" as const }) });
      continue;
    }
    // The walk proved the root earlier; a mount that went away since would make
    // every file read as deleted.
    if (fileState(evidence.root) !== "present" || !statSync(evidence.root).isDirectory()) {
      result.roots.push({ ...report, status: "withheld", reason: "root_missing" });
      continue;
    }
    result.sweep_id ??= newSweepId();
    const retired = await retire(engine, evidence.root, retiring, result.sweep_id, opts.trigger);
    result.pruned += retired.length;
    result.roots.push({
      ...report,
      ...(tripped ? withheld : { status: retired.length > 0 ? "pruned" as const : "clean" as const }),
      pruned: retired.length,
    });
  }
  if (result.pruned === 0) delete result.sweep_id;
  return result;
}

export interface CodeRestoreResult {
  /** Documents made live again. */
  restored: string[];
  /** Recorded, but the purge already removed the document. */
  purged: string[];
  /** The document was restored or deleted again by something else since; left as it is. */
  superseded: string[];
}

/**
 * Undo a prune: by the pass's sweep id, or for one document. Only a document
 * whose `deleted_at` still equals the recorded `pruned_at` is made live, so a
 * document deleted afterwards by another path stays deleted.
 */
export async function restoreCodePrunes(
  engine: Engine,
  target: { sweepId: string } | { documentId: string },
  by: "cli" | "file_returned",
): Promise<CodeRestoreResult> {
  const col = "sweepId" in target ? "sweep_id" : "document_id";
  const key = "sweepId" in target ? target.sweepId : target.documentId;
  const out: CodeRestoreResult = { restored: [], purged: [], superseded: [] };
  await engine.transaction(async (tx) => {
    // scope: operator-only restore runs from the local CLI and the operator's code sweep
    const open = await tx.query<{ id: string; document_id: string; live: boolean | null }>(
      `SELECT p.id::text AS id, p.document_id,
              CASE WHEN d.id IS NULL THEN NULL ELSE d.deleted_at = p.pruned_at END AS live
         FROM code_prunes p
         LEFT JOIN documents d ON d.id = p.document_id
        WHERE p.restored_at IS NULL AND p.${col} = $1
        ORDER BY p.id`,
      [key],
    );
    const matching = open.rows.filter((r) => r.live === true);
    for (const r of open.rows) {
      if (r.live === null) out.purged.push(r.document_id);
      else if (r.live === false) out.superseded.push(r.document_id);
    }
    if (matching.length === 0) return;
    // The fence sits in the write too: a document restored and deleted again by
    // another writer since the read above keeps its newer deletion.
    const revived = await tx.query<{ id: string; prune_id: string }>(
      `UPDATE documents d
          SET deleted_at = NULL, updated_at = NOW(), generation = d.generation + 1
         FROM code_prunes p
        WHERE p.id = ANY($1::bigint[]) AND d.id = p.document_id AND d.deleted_at = p.pruned_at
        RETURNING d.id, p.id::text AS prune_id`,
      [matching.map((r) => r.id)],
    );
    const revivedIds = new Set(revived.rows.map((r) => r.id));
    for (const r of matching) if (!revivedIds.has(r.document_id)) out.superseded.push(r.document_id);
    if (revived.rows.length === 0) return;
    await tx.query(
      `UPDATE code_prunes SET restored_at = NOW(), restored_by = $2
        WHERE id = ANY($1::bigint[])`,
      [revived.rows.map((r) => r.prune_id), by],
    );
    await bumpDocumentClock(tx);
    out.restored = [...revivedIds].sort();
  });
  return out;
}

/**
 * Documents the operator restored whose hold on the automatic pass is still on.
 * The sweep releases a hold once it sees the document's file again: from then
 * on a deletion of that file is an ordinary one.
 */
export async function heldCodePruneDocIds(engine: Engine): Promise<Set<string>> {
  // scope: operator-only read by the operator's code sweep
  const r = await engine.query<{ document_id: string }>(
    `SELECT DISTINCT document_id FROM code_prunes
      WHERE restored_by = 'cli' AND hold_released_at IS NULL`,
  );
  return new Set(r.rows.map((row) => row.document_id));
}

/** Release the operator's hold on `documentId`: its file is present again. */
export async function releaseCodePruneHold(engine: Engine, documentId: string): Promise<void> {
  await engine.query(
    `UPDATE code_prunes SET hold_released_at = NOW()
      WHERE document_id = $1 AND restored_by = 'cli' AND hold_released_at IS NULL`,
    [documentId],
  );
}

/** The code roots `MEMRAIN_CODE_PATHS` configures, spelled the way prunes record them. */
export function configuredCodeRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.MEMRAIN_CODE_PATHS ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0).map((s) => resolve(s));
}

/**
 * Pruned documents past `ttlHours` the purge must keep for now: their file is
 * back (or cannot be checked) and their root is still a configured code root,
 * so a code sweep will re-read and revive them. The hold lasts at most
 * CODE_PRUNE_PURGE_HOLD_HOURS past the TTL: a file the sweep never revives
 * (its reread is refused, it stays unreadable) does not keep its rows forever.
 * A file still missing lets the purge go ahead.
 */
export async function codePrunesKeptFromPurge(
  engine: Engine,
  ttlHours: number,
  codeRoots: readonly string[] = configuredCodeRoots(),
): Promise<string[]> {
  if (codeRoots.length === 0) return [];
  // scope: operator-only the purge cycle phase runs for the whole brain
  const r = await engine.query<{ document_id: string; source_path: string }>(
    `SELECT p.document_id, p.source_path
       FROM code_prunes p
       JOIN documents d ON d.id = p.document_id AND d.deleted_at = p.pruned_at
      WHERE p.restored_at IS NULL
        AND p.root = ANY($3::text[])
        AND d.deleted_at <= NOW() - ($1 || ' hours')::interval
        AND d.deleted_at > NOW() - ($2 || ' hours')::interval`,
    [String(ttlHours), String(ttlHours + CODE_PRUNE_PURGE_HOLD_HOURS), [...codeRoots]],
  );
  return r.rows.filter((row) => fileState(row.source_path) !== "missing").map((row) => row.document_id);
}

/** Documents retired by a prune whose deletion is still the prune's (restorable, not yet purged). */
export async function openCodePruneDocIds(engine: Engine): Promise<Set<string>> {
  // scope: operator-only read by the operator's code sweep
  const r = await engine.query<{ document_id: string }>(
    `SELECT p.document_id
       FROM code_prunes p
       JOIN documents d ON d.id = p.document_id AND d.deleted_at = p.pruned_at
      WHERE p.restored_at IS NULL`,
  );
  return new Set(r.rows.map((row) => row.document_id));
}

export interface CodePruneRun {
  sweep_id: string;
  trigger: string;
  roots: string;
  pruned_at: string;
  documents: number;
  restored: number;
}

/** The most recent prune passes, newest first. */
export async function listCodePruneRuns(engine: Engine, limit = 20): Promise<CodePruneRun[]> {
  // scope: operator-only the local CLI lists prune passes
  const r = await engine.query<CodePruneRun>(
    `SELECT sweep_id, min(trigger) AS trigger, string_agg(DISTINCT root, ',') AS roots,
            min(pruned_at)::text AS pruned_at, count(*)::int AS documents,
            count(restored_at)::int AS restored
       FROM code_prunes
      GROUP BY sweep_id
      ORDER BY min(pruned_at) DESC, sweep_id DESC
      LIMIT $1`,
    [limit],
  );
  return r.rows;
}
