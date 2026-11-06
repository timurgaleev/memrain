/**
 * Deletion-reconcile — the missing half of the mtime-incremental sweep.
 *
 * The sweep re-indexes new/changed files but is blind to DELETIONS: a file
 * removed from the vault leaves its `documents` row + chunks + embeddings
 * stranded in the DB, where they keep surfacing as (now false) evidence. Only
 * a full `--all` re-index used to clear them. This pass targets exactly that
 * gap: after a sweep has walked the on-disk files under a root, soft-delete the
 * DB documents beneath that same root whose `source_path` is no longer present
 * on disk.
 *
 * SAFETY — this only ever soft-deletes a document when BOTH hold:
 *   1. its `source_path` lives under `rootPrefix` (the exact root swept in this
 *      run), so a partial sweep can never retire a document owned by another
 *      source or another vault; and
 *   2. `existsSync(source_path)` is false — the file is genuinely gone, not
 *      merely unwalked (this mirrors orphans-purge's missing-on-disk probe).
 *
 * Two refusals guard against a root that only LOOKS empty (an unmounted volume,
 * a typo'd path): a root that is not an existing directory throws
 * `root_missing`, and more than 50 documents missing at once, or more than one
 * that is also more than 25% of the live documents under the root, throws
 * `mass_delete_refused` unless `allowMassDelete` is set.
 *
 * Deletion is the SAME soft-delete primitive the destructive-guard path uses
 * (`softDeleteDocuments` → `deleted_at = NOW()`), so chunks/embeddings/links are
 * retired and hard-purged identically after the shared 72h TTL. No new deletion
 * path is introduced here.
 */
import { existsSync, statSync } from "node:fs";
import { sep } from "node:path";
import type { Engine } from "./engine/interface.ts";
import { softDeleteDocuments } from "./destructive-guard.ts";
import { OperationError } from "./operation-error.ts";

export interface ReconcileDeletesResult {
  /** Number of documents soft-deleted because their file vanished from disk. */
  reconciled: number;
  /** The `source_path`s that were retired (for the operator's audit). */
  reconciledPaths: string[];
}

/** True when `p` is `root` itself or sits beneath it (separator-guarded so
 *  `/vault2/x.md` is NOT considered under root `/vault`). */
function underRoot(p: string, root: string): boolean {
  if (p === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return p.startsWith(prefix);
}

/**
 * Soft-delete every live document under `rootPrefix` whose file is missing on
 * disk. Idempotent: a document already soft-deleted is skipped (the underlying
 * primitive filters on `deleted_at IS NULL`), and a run with nothing missing is
 * a no-op returning zero.
 *
 * `rootPrefix` MUST be the absolute filesystem root that was just swept — the
 * scope is derived entirely from it, so passing a subset root reconciles ONLY
 * that subset and can never over-delete siblings.
 */
export async function reconcileDeletedDocuments(
  engine: Engine,
  rootPrefix: string,
  opts: { allowMassDelete?: boolean } = {},
): Promise<ReconcileDeletesResult> {
  if (!rootPrefix) {
    throw new Error("reconcileDeletedDocuments: rootPrefix is required");
  }
  if (!existsSync(rootPrefix) || !statSync(rootPrefix).isDirectory()) {
    throw new OperationError(
      "root_missing",
      `${rootPrefix} is not an existing directory; refusing to reconcile deletions against it`,
    );
  }

  // Pull live docs once; scope + existence are filtered in-process (robust
  // against LIKE metacharacters in a source_path, and cheap at vault scale).
  const rows = await engine.query<{ id: string; source_path: string }>(
    `SELECT id, source_path FROM documents WHERE deleted_at IS NULL`,
  );

  const live = rows.rows.filter((r) => underRoot(r.source_path, rootPrefix));
  const missing = live.filter((r) => !existsSync(r.source_path));

  const n = missing.length;
  const mass = n > 50 || (n > 1 && n > live.length * 0.25);
  if (mass && !opts.allowMassDelete) {
    const sample = missing.slice(0, 5).map((r) => r.source_path).join(", ");
    throw new OperationError(
      "mass_delete_refused",
      `${missing.length} of ${live.length} documents under ${rootPrefix} are missing; pass --allow-mass-delete to retire them; e.g. ${sample}`,
    );
  }

  const reconciledPaths: string[] = [];
  for (const doc of missing) {
    const { deleted } = await softDeleteDocuments(engine, {
      documentId: doc.id,
    });
    if (deleted > 0) reconciledPaths.push(doc.source_path);
  }

  return { reconciled: reconciledPaths.length, reconciledPaths };
}
