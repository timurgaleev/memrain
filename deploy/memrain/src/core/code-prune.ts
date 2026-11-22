/**
 * Code prune — retire the documents of source files deleted from a code root.
 *
 * The code sweep re-indexes new and changed files but never sees a deletion:
 * a removed file's document, chunks, vectors, mentions and call edges stay
 * live, and its symbols keep answering `search` and every `code_*` tool. This
 * pass soft-deletes those documents (`documents.deleted_at`, purged after the
 * shared 72 h TTL) and writes one `code_prunes` row each (migration 192): the
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
 * cut it short. Past that, the valve withholds a pass that would retire more
 * than CODE_PRUNE_MAX_DELETES documents, or more than one that is also more
 * than CODE_PRUNE_MAX_RATIO of the root's live code documents: a half-mounted
 * checkout looks exactly like a mass deletion. Only `memrain code prune
 * --apply --allow-mass-delete` goes past it.
 */
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import type { Engine } from "./engine/interface.ts";
import { bumpDocumentClock } from "./generation.ts";
import { owningSource } from "./sources.ts";

/** A pass retiring more documents than this is withheld. */
export const CODE_PRUNE_MAX_DELETES = 200;
/** A pass retiring more than one document and more than this share of the root's live code documents is withheld. */
export const CODE_PRUNE_MAX_RATIO = 0.2;

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

/** The valve: true when retiring `missing` of `live` documents looks like a broken mount, not a deletion. */
export function codePruneTrip(missing: number, live: number): boolean {
  return missing > CODE_PRUNE_MAX_DELETES || (missing > 1 && missing > live * CODE_PRUNE_MAX_RATIO);
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
         SELECT DISTINCT ON (document_id) document_id, restored_by
           FROM code_prunes
          WHERE document_id = ANY($1::text[])
          ORDER BY document_id, id DESC) latest
        WHERE restored_by = 'cli'`,
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
    if (codePruneTrip(targets.length, plan.live) && !opts.allowMassDelete) {
      result.roots.push({ ...report, status: "withheld", reason: "mass_delete" });
      continue;
    }
    if (!opts.apply) {
      result.roots.push({ ...report, status: "dry_run" });
      continue;
    }
    // The walk proved the root earlier; a mount that went away since would make
    // every file read as deleted.
    if (fileState(evidence.root) !== "present" || !statSync(evidence.root).isDirectory()) {
      result.roots.push({ ...report, status: "withheld", reason: "root_missing" });
      continue;
    }
    result.sweep_id ??= newSweepId();
    const retired = await retire(engine, evidence.root, targets, result.sweep_id, opts.trigger);
    result.pruned += retired.length;
    result.roots.push({ ...report, status: retired.length > 0 ? "pruned" : "clean", pruned: retired.length });
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
