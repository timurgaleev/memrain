/**
 * The write gate as the indexer runs it, once per document write.
 *
 * The writer's trust tier (core/trust-tier.ts) decides whether the gate runs:
 * the lower of the tier the source's kind gives and the tier of the caller.
 *   - `external`: a source of an outside kind (mailbox, calendar, chat,
 *     meeting, webhook, GitHub), on every index, so a sweep re-derives the
 *     verdict, or a write recorded at the external tier;
 *   - `agent` (and `member`): a remote caller's write into any other source;
 *   - `owner`: a trusted local re-index of the same title and body carries the
 *     stored verdict forward, and a trusted rewrite drops it.
 *
 * The hold for a quarantined document is written inside the document's own
 * transaction (DocumentWrite.afterWrite), so the two land or fail together.
 */
import type { Engine } from "./engine/interface.ts";
import { GATE_OWNED_KEYS } from "./quarantine.ts";
import { logIngest } from "./ingest-log.ts";
import { lowerTier, sourceKindTier, type TrustTier } from "./trust-tier.ts";
import {
  WRITE_GATE_APPROVAL_KEY,
  WriteGateBlockError,
  assessWriteGate,
  carriedWriteGate,
  resolveWriteGateMode,
  stampWriteGate,
  writeGateBinding,
  writeGateExcerpt,
  writeGateFields,
  writeGateOrigin,
  type WriteGateVerdict,
} from "./write-gate.ts";
import { WRITE_GATE_AUDIT_SOURCE_TYPE, recordWriteGateHold, supersedeWriteGateHolds } from "./write-gate-holds.ts";

export interface WriteGatePlanInput {
  documentId: string;
  sourcePath: string;
  sourceId: string | null;
  remote: boolean;
  /** The caller's tier when the dispatcher resolved one; else `agent` for a remote write, `owner` otherwise. */
  trustTier?: TrustTier;
  title: string;
  body: string;
  /** The incoming header, already stripped of gate-owned keys for a remote writer. */
  frontmatter: Record<string, unknown>;
}

export interface WriteGatePlan {
  verdict: WriteGateVerdict | null;
  stamp: (frontmatter: Record<string, unknown>) => Record<string, unknown>;
  afterWrite?: (tx: Engine, sourceId: string | null) => Promise<void>;
}

/** Decide the verdict for one write; throws WriteGateBlockError in `reject` mode. */
export async function planWriteGate(engine: Engine, input: WriteGatePlanInput): Promise<WriteGatePlan> {
  // scope: upstream the indexer names the document it is about to write; a stored row of another source is not read
  const r = await engine.query<{ kind: string | null; source_id: string; frontmatter: Record<string, unknown> | null }>(
    `WITH stored AS (
       SELECT COALESCE(source_id, 'default') AS source_id, frontmatter FROM documents
        WHERE id = $2 AND ($1::text IS NULL OR COALESCE(source_id, 'default') = $1::text)
     )
     SELECT s.kind, eff.source_id, (SELECT frontmatter FROM stored) AS frontmatter
       FROM (SELECT COALESCE($1::text, (SELECT source_id FROM stored), 'default') AS source_id) eff
       LEFT JOIN sources s ON s.id = eff.source_id`,
    [input.sourceId, input.documentId],
  );
  const row = r.rows[0];
  const sourceId = row?.source_id ?? input.sourceId ?? "default";
  const stored = row?.frontmatter ?? null;
  const callerTier = input.trustTier ?? (input.remote ? "agent" : "owner");
  const origin = writeGateOrigin(lowerTier(sourceKindTier(row?.kind), callerTier));
  const fields = writeGateFields(input.title, input.body, input.frontmatter, GATE_OWNED_KEYS);
  const binding = writeGateBinding(fields);
  const storedApproval = stored?.[WRITE_GATE_APPROVAL_KEY];

  let verdict: WriteGateVerdict | null;
  if (origin) {
    verdict = assessWriteGate({ origin, mode: resolveWriteGateMode(origin, sourceId), fields, binding, approval: storedApproval });
    if (verdict.action === "reject") {
      await auditRefusal(engine, verdict, input.sourcePath, sourceId);
      throw new WriteGateBlockError(verdict);
    }
  } else {
    const carried = carriedWriteGate(stored, binding);
    verdict = carried && resolveWriteGateMode(carried.origin, sourceId) !== "off" ? carried : null;
  }

  const stamp = (fm: Record<string, unknown>) => stampWriteGate(fm, verdict, storedApproval);
  if (verdict?.action === "quarantine" && !verdict.approved && origin) {
    const held = verdict;
    const excerpt = writeGateExcerpt(fields);
    return {
      verdict,
      stamp,
      afterWrite: async (tx, effSource) => {
        await recordWriteGateHold(tx, { documentId: input.documentId, sourceId: effSource ?? "default", targetRef: input.sourcePath, verdict: held, excerpt });
      },
    };
  }
  return {
    verdict,
    stamp,
    ...(origin ? { afterWrite: (tx: Engine) => supersedeWriteGateHolds(tx, input.documentId, binding) } : {}),
  };
}

async function auditRefusal(engine: Engine, verdict: WriteGateVerdict, ref: string, sourceId: string): Promise<void> {
  try {
    await logIngest(engine, {
      source_type: WRITE_GATE_AUDIT_SOURCE_TYPE,
      source_ref: ref,
      summary: `refused (${verdict.origin}): ${verdict.families.join(", ")} [${verdict.detector_version}]`,
      source_id: sourceId,
    });
  } catch (e) {
    console.warn(`[write-gate] failed to audit the refusal of ${ref}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
