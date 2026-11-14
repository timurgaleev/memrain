/**
 * The owner's review queue for documents the write gate held (migration 159).
 *
 * A hold is created inside the document's own write transaction, so a
 * document is never hidden without a row pointing at it. Deciding is
 * operator-only (the local CLI); every hold and decision leaves an
 * `ingest_log` row naming families and actor, never the held text.
 *
 * Approving releases the document from search quarantine and stamps an
 * approval bound to its current title and body, so re-indexing the same
 * content keeps it released while any edit is assessed afresh. The released
 * document keeps its `instruction_like` content flag and its strong read
 * frame: approval says "this may be memory", not "this is trusted".
 */
import type { Engine } from "./engine/interface.ts";
import { bumpDocumentClock } from "./generation.ts";
import { logIngest } from "./ingest-log.ts";
import { clearCache } from "./search/query-cache.ts";
import {
  INSTRUCTION_LIKE_REASON,
  WRITE_GATE_APPROVAL_KEY,
  WRITE_GATE_KEY,
  type WriteGateVerdict,
} from "./write-gate.ts";

export const WRITE_GATE_AUDIT_SOURCE_TYPE = "write_gate";

export interface WriteGateHoldRow {
  id: number;
  source_id: string;
  document_id: string;
  target_ref: string;
  origin: "external" | "agent";
  families: string[];
  detector_version: string;
  binding: string;
  excerpt: string;
  created_at: string;
  decision: "approved" | "rejected" | "superseded" | null;
  decided_at: string | null;
  decided_by: string | null;
  /** The document still carries the content this hold was raised on. */
  current: boolean;
}

export interface NewWriteGateHold {
  documentId: string;
  sourceId: string;
  targetRef: string;
  verdict: WriteGateVerdict;
  excerpt: string;
}

/**
 * Close the document's open holds raised on other content: the text they
 * describe is no longer what the document holds.
 */
export async function supersedeWriteGateHolds(tx: Engine, documentId: string, binding: string): Promise<void> {
  await tx.query(
    `UPDATE write_gate_holds SET decision = 'superseded', decided_at = NOW(), decided_by = 'write-gate'
      WHERE document_id = $1 AND binding <> $2 AND decision IS NULL`,
    [documentId, binding],
  );
}

/**
 * Queue a hold for the document's current content. A repeat of content that is
 * already queued, approved or rejected is a no-op; content whose hold was
 * superseded by an edit and has now returned is queued again.
 */
export async function recordWriteGateHold(tx: Engine, hold: NewWriteGateHold): Promise<number | null> {
  await supersedeWriteGateHolds(tx, hold.documentId, hold.verdict.binding);
  const r = await tx.query<{ id: number }>(
    `INSERT INTO write_gate_holds (source_id, document_id, target_ref, origin, reason_families, detector_version, binding, excerpt)
     VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8)
     ON CONFLICT (document_id, binding) DO UPDATE
       SET decision = NULL, decided_at = NULL, decided_by = NULL, created_at = NOW(),
           reason_families = EXCLUDED.reason_families, detector_version = EXCLUDED.detector_version, excerpt = EXCLUDED.excerpt
       WHERE write_gate_holds.decision = 'superseded'
     RETURNING id`,
    [hold.sourceId, hold.documentId, hold.targetRef, hold.verdict.origin, hold.verdict.families,
      hold.verdict.detector_version, hold.verdict.binding, hold.excerpt],
  );
  const id = r.rows[0]?.id ?? null;
  if (id !== null) {
    const why = hold.verdict.error ? "detector_error" : hold.verdict.families.join(", ");
    await logIngest(tx, {
      source_type: WRITE_GATE_AUDIT_SOURCE_TYPE,
      source_ref: hold.targetRef,
      summary: `held #${id} (${hold.verdict.origin}): ${why} [${hold.verdict.detector_version}]`,
      source_id: hold.sourceId,
    });
  }
  return id === null ? null : Number(id);
}

export interface ListWriteGateHoldsOptions {
  /** `open` (default): awaiting a decision. `all`: every hold, newest first. */
  status?: "open" | "all";
  limit?: number;
}

/** Operator-only listing across every source. */
export async function listWriteGateHolds(engine: Engine, opts: ListWriteGateHoldsOptions = {}): Promise<WriteGateHoldRow[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  // scope: operator-only the hold queue is reviewed by the operator through the local CLI
  const r = await engine.query<Omit<WriteGateHoldRow, "current" | "families"> & { families: string[]; current: boolean }>(
    `SELECT h.id::int AS id, h.source_id, h.document_id, h.target_ref, h.origin, h.reason_families AS families,
            h.detector_version, h.binding, h.excerpt, h.created_at::text AS created_at, h.decision,
            h.decided_at::text AS decided_at, h.decided_by,
            COALESCE(d.frontmatter -> '${WRITE_GATE_KEY}' ->> 'binding' = h.binding, false) AS current
       FROM write_gate_holds h
       LEFT JOIN documents d ON d.id = h.document_id
      ${opts.status === "all" ? "" : "WHERE h.decision IS NULL"}
      ORDER BY h.created_at DESC, h.id DESC
      LIMIT ${limit}`,
  );
  return r.rows.map(row => ({ ...row, families: [...row.families] }));
}

export type WriteGateDecision = "approve" | "reject";
export type WriteGateDecisionStatus = "approved" | "rejected" | "stale" | "already_decided" | "not_found";

/**
 * Approve or reject one hold. Approving a hold whose document has changed
 * since (its gate record no longer carries the hold's binding) closes the hold
 * as superseded and reports `stale` instead of releasing unseen content.
 */
export async function decideWriteGateHold(
  engine: Engine,
  opts: { holdId: number; decision: WriteGateDecision; decidedBy: string },
): Promise<{ status: WriteGateDecisionStatus }> {
  const decidedBy = opts.decidedBy.trim().slice(0, 200) || "operator";
  const status = await engine.transaction(async (tx): Promise<WriteGateDecisionStatus> => {
    // scope: operator-only a decision names one hold by id from the operator's queue
    const held = await tx.query<{ document_id: string; source_id: string; target_ref: string; binding: string; decision: string | null }>(
      `SELECT document_id, source_id, target_ref, binding, decision FROM write_gate_holds WHERE id = $1 FOR UPDATE`,
      [opts.holdId],
    );
    const hold = held.rows[0];
    if (!hold) return "not_found";
    if (hold.decision !== null) return "already_decided";

    let result: WriteGateDecisionStatus = opts.decision === "approve" ? "approved" : "rejected";
    if (opts.decision === "approve") {
      // scope: upstream the document id comes from the hold row locked above
      const doc = await tx.query<{ frontmatter: Record<string, unknown> | null }>(
        `SELECT frontmatter FROM documents WHERE id = $1 FOR UPDATE`,
        [hold.document_id],
      );
      const fm = doc.rows[0]?.frontmatter ?? null;
      const record = fm?.[WRITE_GATE_KEY] as { binding?: unknown } | undefined;
      if (!fm || record?.binding !== hold.binding) {
        result = "stale";
      } else {
        const quarantine = fm["quarantine"] as { reason?: unknown } | undefined;
        const next: Record<string, unknown> = {
          ...fm,
          [WRITE_GATE_APPROVAL_KEY]: { binding: hold.binding, hold_id: opts.holdId, approved_at: new Date().toISOString() },
        };
        if (quarantine?.reason === INSTRUCTION_LIKE_REASON) delete next["quarantine"];
        await tx.query(`UPDATE documents SET frontmatter = $2::jsonb, updated_at = NOW() WHERE id = $1`, [hold.document_id, next]);
        await bumpDocumentClock(tx);
      }
    }
    const decision = result === "stale" ? "superseded" : result;
    await tx.query(
      `UPDATE write_gate_holds SET decision = $2, decided_at = NOW(), decided_by = $3 WHERE id = $1`,
      [opts.holdId, decision, decidedBy],
    );
    await logIngest(tx, {
      source_type: WRITE_GATE_AUDIT_SOURCE_TYPE,
      source_ref: hold.target_ref,
      summary: `${result === "stale" ? "stale, not released" : result} #${opts.holdId} by ${decidedBy}`,
      source_id: hold.source_id,
    });
    return result;
  });
  if (status === "approved") await clearCache(engine);
  return { status };
}
