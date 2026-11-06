/**
 * Destructive-guard — soft-delete / archive / restore / purge for documents,
 * with an impact preview and a confirmation gate, over memrain's `documents`
 * store.
 *
 * Soft-delete and archive flip columns (migration 040); nothing is hard-deleted
 * until it has aged past the TTL, at which point the `purge` cycle phase reaps
 * it (cascading to chunks/embeddings via FK). A restore is a column flip back.
 */
import type { Engine } from "./engine/interface.ts";
import { bumpDocumentClock } from "./generation.ts";

/** Hours a soft-deleted / archived document survives before hard purge. */
export const SOFT_DELETE_TTL_HOURS = 72;

/** Hours a soft-deleted page survives before hard purge (30 days). */
export const PAGE_SOFT_DELETE_TTL_HOURS = 720;

export interface DestructiveImpact {
  /** documents that would be affected (live, not already deleted/archived). */
  documents: number;
  chunks: number;
  embeddings: number;
}

/**
 * Preview what a soft-delete/archive of a source (or a single document) would
 * touch. Counts only currently-visible rows so a repeated call doesn't
 * double-count already-retired ones.
 */
export async function assessDestructiveImpact(
  engine: Engine,
  target: { sourceId?: string; documentId?: string },
): Promise<DestructiveImpact> {
  const { where, params } = targetClause(target, "d");
  const r = await engine.query<{
    documents: number;
    chunks: number;
    embeddings: number;
  }>(
    `SELECT
       COUNT(DISTINCT d.id)::int AS documents,
       COUNT(DISTINCT c.id)::int AS chunks,
       COUNT(DISTINCT e.chunk_id)::int AS embeddings
     FROM documents d
     LEFT JOIN chunks c ON c.document_id = d.id
     LEFT JOIN embeddings e ON e.chunk_id = c.id
     WHERE ${where} AND d.deleted_at IS NULL AND NOT d.archived`,
    params,
  );
  const row = r.rows[0];
  return {
    documents: row?.documents ?? 0,
    chunks: row?.chunks ?? 0,
    embeddings: row?.embeddings ?? 0,
  };
}

export interface ConfirmOptions {
  confirmDestructive?: boolean;
  dryRun?: boolean;
}

/**
 * Gate a destructive op. Passes (returns null) when there is nothing to lose
 * (zero impact), it's a dry run, or `confirmDestructive` is explicitly set.
 * Otherwise returns a human-readable refusal string.
 */
export function checkDestructiveConfirmation(
  impact: DestructiveImpact,
  opts: ConfirmOptions = {},
): string | null {
  if (opts.dryRun) return null;
  if (impact.documents === 0) return null;
  if (opts.confirmDestructive) return null;
  return (
    `refusing: would retire ${impact.documents} document(s), ` +
    `${impact.chunks} chunk(s), ${impact.embeddings} embedding(s). ` +
    `Pass confirmDestructive to proceed.`
  );
}

/** Soft-delete documents (set deleted_at = NOW()). Returns rows affected. */
export async function softDeleteDocuments(
  engine: Engine,
  target: { sourceId?: string; documentId?: string },
): Promise<{ deleted: number }> {
  const { where, params } = targetClause(target, "documents");
  let deleted = 0;
  await engine.transaction(async (tx) => {
    const r = await tx.query<{ id: string }>(
      `UPDATE documents
          SET deleted_at = NOW(), updated_at = NOW(),
              generation = generation + 1
        WHERE ${where} AND deleted_at IS NULL RETURNING id`,
      params,
    );
    deleted = r.rows.length;
    if (deleted > 0) await bumpDocumentClock(tx);
  });
  return { deleted };
}

/** Restore soft-deleted documents (deleted_at = NULL). Returns rows affected. */
export async function restoreDocuments(
  engine: Engine,
  target: { sourceId?: string; documentId?: string },
): Promise<{ restored: number }> {
  const { where, params } = targetClause(target, "documents");
  let restored = 0;
  await engine.transaction(async (tx) => {
    const r = await tx.query<{ id: string }>(
      `UPDATE documents
          SET deleted_at = NULL, updated_at = NOW(),
              generation = generation + 1
        WHERE ${where} AND deleted_at IS NOT NULL RETURNING id`,
      params,
    );
    restored = r.rows.length;
    if (restored > 0) await bumpDocumentClock(tx);
  });
  return { restored };
}

/** Archive a source: archived=true + archive_expires_at = NOW()+TTL. */
export async function archiveSource(
  engine: Engine,
  sourceId: string,
  ttlHours = SOFT_DELETE_TTL_HOURS,
): Promise<{ archived: number }> {
  let archived = 0;
  await engine.transaction(async (tx) => {
    const r = await tx.query<{ id: string }>(
      `UPDATE documents
          SET archived = true, archived_at = NOW(),
              archive_expires_at = NOW() + ($2 || ' hours')::interval,
              updated_at = NOW(), generation = generation + 1
        WHERE source_id = $1 AND NOT archived RETURNING id`,
      [sourceId, String(ttlHours)],
    );
    archived = r.rows.length;
    if (archived > 0) await bumpDocumentClock(tx);
  });
  return { archived };
}

/** Restore an archived source (archived=false, timestamps nulled). */
export async function restoreSource(
  engine: Engine,
  sourceId: string,
): Promise<{ restored: number }> {
  let restored = 0;
  await engine.transaction(async (tx) => {
    const r = await tx.query<{ id: string }>(
      `UPDATE documents
          SET archived = false, archived_at = NULL, archive_expires_at = NULL,
              updated_at = NOW(), generation = generation + 1
        WHERE source_id = $1 AND archived RETURNING id`,
      [sourceId],
    );
    restored = r.rows.length;
    if (restored > 0) await bumpDocumentClock(tx);
  });
  return { restored };
}

export interface PurgeResult {
  purged_deleted: number;
  purged_archived: number;
}

/**
 * Hard-delete documents past their TTL: soft-deleted older than `ttlHours`, and
 * archived whose `archive_expires_at` has passed. Cascades to chunks/embeddings
 * via FK. Set-based; safe to run every cycle.
 */
export async function purgeExpiredDocuments(
  engine: Engine,
  ttlHours = SOFT_DELETE_TTL_HOURS,
): Promise<PurgeResult> {
  let purgedDeleted = 0;
  let purgedArchived = 0;
  await engine.transaction(async (tx) => {
    const d = await tx.query<{ id: string }>(
      `DELETE FROM documents
        WHERE deleted_at IS NOT NULL
          -- Inclusive on purpose, and matching the archived branch below.
          -- A ttl of 0 means "purge what is already soft-deleted"; strict
          -- less-than makes a row deleted in the same clock tick as the purge
          -- miss its own deadline, because NOW() is the transaction's start
          -- time and the two timestamps can land equal.
          AND deleted_at <= NOW() - ($1 || ' hours')::interval
        RETURNING id`,
      [String(ttlHours)],
    );
    purgedDeleted = d.rows.length;
    const a = await tx.query<{ id: string }>(
      `DELETE FROM documents
        WHERE archived AND archive_expires_at IS NOT NULL
          AND archive_expires_at <= NOW()
        RETURNING id`,
    );
    purgedArchived = a.rows.length;
    if (purgedDeleted + purgedArchived > 0) await bumpDocumentClock(tx);
  });
  return { purged_deleted: purgedDeleted, purged_archived: purgedArchived };
}

/** Build a WHERE fragment + params for a source-or-document target. */
function targetClause(
  target: { sourceId?: string; documentId?: string },
  alias: string,
): { where: string; params: unknown[] } {
  if (target.documentId) {
    return { where: `${alias}.id = $1`, params: [target.documentId] };
  }
  if (target.sourceId) {
    return { where: `${alias}.source_id = $1`, params: [target.sourceId] };
  }
  throw new Error("destructive-guard: target requires sourceId or documentId");
}
