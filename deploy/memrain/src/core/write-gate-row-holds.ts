/**
 * Facts, takes and timeline entries the row write gate held (migration 183).
 *
 * In quarantine mode a gated row is not inserted: it lands here as the row its
 * writer would have inserted, so it is invisible to every reader of
 * entity_facts, synth_takes and timeline_events without any filter. The owner
 * decides through the local CLI or the admin Approvals page:
 *
 *   release  the row is inserted as written (same principal and source, so
 *            readers frame it exactly as they would have) and carries a flag
 *            receipt; the same content arriving again is stored from then on
 *   drop     the row stays out, and the same content stays dropped
 *
 * A hold keeps the row's text, like the row would have; its receipt names
 * families and a hash only.
 */
import { createHash } from "node:crypto";
import type { Engine } from "./engine/interface.ts";
import { logIngest } from "./ingest-log.ts";
import { wellFormForText } from "./well-form.ts";
import { gateBaseView, type GateField } from "./write-gate.ts";
import { flagGatedRow, type GatedRowTable } from "./write-gate-rows.ts";
import type { TrustTier } from "./trust-tier.ts";
import type { Storage } from "./storage.ts";

export type RowHoldKind = "fact" | "take" | "timeline";
export type RowHoldStatus = "held" | "released" | "dropped";

export const ROW_HOLD_AUDIT_SOURCE_TYPE = "write_gate";

const TABLE_OF: Readonly<Record<RowHoldKind, GatedRowTable>> = {
  fact: "entity_facts",
  take: "synth_takes",
  timeline: "timeline_events",
};

export function holdKindOf(table: GatedRowTable): RowHoldKind {
  return table === "entity_facts" ? "fact" : table === "synth_takes" ? "take" : "timeline";
}

/**
 * The columns a release may write, per table: the ones the gated writers set.
 * Anything else in a payload is ignored, so a payload can never name a column
 * such as `trust_tier` or `id`.
 */
const RELEASE_COLUMNS: Readonly<Record<GatedRowTable, readonly string[]>> = {
  entity_facts: [
    "entity_slug", "fact", "confidence", "source_slug", "source_chunk_id", "written_by", "kind", "notability",
    "valid_from", "valid_until", "claim_metric", "claim_value", "claim_unit", "claim_period", "event_type",
    "visibility", "context", "source_session", "attributed_to", "written_by_principal", "source_id",
    "slot_dimension", "slot_value", "slot_value_hash", "source_markdown_slug", "row_num",
    "dimension", "value", "value_hash", "dim_status",
  ],
  synth_takes: [
    "take_key", "source_ref", "source_hash", "prompt_version", "claim_text", "kind", "weight", "domain", "status",
    "model_id", "holder", "active", "row_num", "since_date", "until_date", "resolved_at", "resolved_quality",
    "resolved_outcome", "resolved_value", "resolved_unit", "resolved_source", "resolved_by", "written_by_principal",
  ],
  timeline_events: [
    "slug", "occurred_at", "event", "detail", "source_label", "source_chunk_id", "written_by_principal", "source_id", "event_slug",
  ],
};

/**
 * Dedupe key for a held row: its kind plus every gated field as the detector
 * reads it (hidden tag characters decoded, invisible characters removed,
 * NFKC), so the same content with a zero-width space in it is the same hold.
 */
export function holdFingerprint(kind: RowHoldKind, texts: readonly string[]): string {
  return fingerprintOf(kind, texts.map(t => gateBaseView(t).replace(/\s+/g, " ").trim()));
}

/** The key holds written before write-gate/v3 carry, so an earlier decision still counts. */
function legacyHoldFingerprint(kind: RowHoldKind, texts: readonly string[]): string {
  return fingerprintOf(kind, texts.map(t => wellFormForText(t).toLowerCase().replace(/\s+/g, " ").trim()));
}

function fingerprintOf(kind: RowHoldKind, norm: readonly string[]): string {
  return createHash("sha256").update(`${kind}\u0000${norm.join("\u0001")}`, "utf8").digest("hex");
}

export interface NewRowHold {
  kind: RowHoldKind;
  sourceId: string;
  slug: string;
  fields: readonly GateField[];
  payload: Record<string, unknown>;
  origin: "external" | "agent";
  tier: Exclude<TrustTier, "owner">;
  families: readonly string[];
  detectorVersion: string;
  detectorError: boolean;
}

export type RowHoldLookup = { status: RowHoldStatus; id: number; detectorVersion: string } | null;

/**
 * The state of this content if it was held before: the latest decision the
 * owner made on it under any detector version, else the hold still pending
 * under this one. A detector change never re-opens a release or a drop, and
 * a release of an older hold is not undone by a newer pending one.
 */
export async function findRowHold(
  engine: Engine,
  key: { kind: RowHoldKind; sourceId: string; slug: string; fields: readonly GateField[]; detectorVersion: string },
): Promise<RowHoldLookup> {
  const texts = key.fields.map(f => f.text);
  // scope: upstream the writer's own source and slug, by the hold's dedupe key
  const r = await engine.query<{ id: number; status: RowHoldStatus; detector_version: string }>(
    `SELECT id::int AS id, status, detector_version FROM write_gate_row_holds
      WHERE source_id = $1 AND kind = $2 AND slug = $3 AND fingerprint = ANY($4::text[])
        AND (detector_version = $5 OR status <> 'held')
      ORDER BY (status <> 'held') DESC, id DESC
      LIMIT 1`,
    [key.sourceId, key.kind, key.slug, [holdFingerprint(key.kind, texts), legacyHoldFingerprint(key.kind, texts)], key.detectorVersion],
  );
  const row = r.rows[0];
  return row ? { id: Number(row.id), status: row.status, detectorVersion: row.detector_version } : null;
}

/**
 * Hold a row instead of inserting it, with its `quarantine` receipt. The same
 * content again bumps the existing hold and leaves its status as it is; while
 * it is still held, the newest payload replaces the older one. Null when the
 * source does not exist (nothing written; the caller stores the row as before).
 * Every statement is an upsert that cannot violate a constraint, so a writer
 * calling this inside its own transaction is never aborted by it.
 */
export async function recordRowHold(tx: Engine, hold: NewRowHold): Promise<{ id: number; status: RowHoldStatus } | null> {
  const fingerprint = holdFingerprint(hold.kind, hold.fields.map(f => f.text));
  const r = await tx.query<{ id: number; status: RowHoldStatus; seen_count: number }>(
    `INSERT INTO write_gate_row_holds
       (kind, source_id, slug, fingerprint, detector_version, origin, tier, reason_families, detector_error, payload)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10::jsonb
      WHERE EXISTS (SELECT 1 FROM sources WHERE id = $2)
     ON CONFLICT (source_id, kind, slug, fingerprint, detector_version) DO UPDATE
       SET seen_count = write_gate_row_holds.seen_count + 1, last_seen_at = NOW(),
           payload = CASE WHEN write_gate_row_holds.status = 'held' THEN EXCLUDED.payload ELSE write_gate_row_holds.payload END
     RETURNING id::int AS id, status, seen_count`,
    [hold.kind, hold.sourceId, hold.slug, fingerprint, hold.detectorVersion, hold.origin, hold.tier,
      [...hold.families], hold.detectorError, JSON.stringify(hold.payload)],
  );
  const row = r.rows[0];
  if (!row) return null;
  const id = Number(row.id);
  await tx.query(
    `INSERT INTO write_gate_receipts
       (target_table, target_id, source_id, origin, verdict, reason_families, detector_version, detector_error, binding)
     VALUES ('write_gate_row_holds', $1, $2, $3, 'quarantine', $4::text[], $5, $6, $7)
     ON CONFLICT (target_table, target_id, binding, detector_version)
     DO UPDATE SET seen_count = write_gate_receipts.seen_count + 1, last_seen_at = NOW()`,
    [String(id), hold.sourceId, hold.origin, [...hold.families], hold.detectorVersion, hold.detectorError, fingerprint],
  );
  if (Number(row.seen_count) === 1) {
    await logIngest(tx, {
      source_type: ROW_HOLD_AUDIT_SOURCE_TYPE,
      source_ref: `${hold.kind}:${hold.slug}`,
      summary: `held row h${id} (${hold.origin}): ${hold.detectorError ? "detector_error" : hold.families.join(", ")} [${hold.detectorVersion}]`,
      source_id: hold.sourceId,
    });
  }
  return { id, status: row.status };
}

export interface RowHold {
  id: number;
  ref: string;
  kind: RowHoldKind;
  source_id: string;
  slug: string;
  origin: "external" | "agent";
  tier: string;
  families: string[];
  detector_version: string;
  detector_error: boolean;
  payload: Record<string, unknown>;
  status: RowHoldStatus;
  seen_count: number;
  created_at: string;
  last_seen_at: string;
  decided_at: string | null;
  decided_by: string | null;
  released_target_id: string | null;
}

// scope: operator-only every hold read below serves the operator's review queue
const HOLD_SELECT = `SELECT id::int AS id, kind, source_id, slug, origin, tier, reason_families AS families, detector_version,
  detector_error, payload, status, seen_count, created_at::text AS created_at, last_seen_at::text AS last_seen_at,
  decided_at::text AS decided_at, decided_by, released_target_id FROM write_gate_row_holds`;

function toHold(row: Omit<RowHold, "ref">): RowHold {
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) as Record<string, unknown> : row.payload;
  return { ...row, id: Number(row.id), ref: `h${row.id}`, seen_count: Number(row.seen_count), families: [...row.families], payload };
}

export interface ListRowHoldsOptions {
  /** Default `held`. */
  status?: RowHoldStatus | "all";
  kind?: RowHoldKind;
  limit?: number;
}

/** Operator-only listing across every source, newest first. */
export async function listRowHolds(engine: Engine, opts: ListRowHoldsOptions = {}): Promise<RowHold[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const status = opts.status ?? "held";
  if (status !== "all") { params.push(status); where.push(`status = $${params.length}`); }
  if (opts.kind) { params.push(opts.kind); where.push(`kind = $${params.length}`); }
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  // scope: operator-only the row hold queue is reviewed by the operator
  const r = await engine.query<Omit<RowHold, "ref">>(
    `${HOLD_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${limit}`, params);
  return r.rows.map(toHold);
}

export type RowHoldDecisionStatus = "released" | "dropped" | "already_decided" | "not_found";

async function lockHeld(tx: Engine, id: number): Promise<RowHold | "already_decided" | "not_found"> {
  // scope: operator-only a decision names one hold by id from the operator's queue
  const r = await tx.query<Omit<RowHold, "ref">>(`${HOLD_SELECT} WHERE id = $1 FOR UPDATE`, [id]);
  const row = r.rows[0];
  if (!row) return "not_found";
  return row.status === "held" ? toHold(row) : "already_decided";
}

/** The payload's allowed columns, in a stable order. */
function releaseColumns(table: GatedRowTable, payload: Record<string, unknown>): string[] {
  return RELEASE_COLUMNS[table].filter(c => Object.hasOwn(payload, c));
}

/** Insert the held row as its writer would have; the id of the stored row, or null when an equal row was already there. */
async function insertReleased(engine: Engine, hold: RowHold): Promise<string | null> {
  const table = TABLE_OF[hold.kind];
  // The row keeps the tier the gate saw when it held it; the insert trigger
  // only ever lowers it further (a payload never names trust_tier itself).
  const cols = [...releaseColumns(table, hold.payload), "trust_tier"];
  const params = cols.map(c => (c === "trust_tier" ? hold.tier : hold.payload[c] ?? null));
  const values = cols.map((_, i) => `$${i + 1}`).join(", ");
  let stored: string | null;
  if (table === "synth_takes") {
    // A proposed or think take's key is derived from its text: a conflict is the same take.
    const r = await engine.query<{ take_key: string }>(
      `INSERT INTO synth_takes (${cols.join(", ")}) VALUES (${values}) ON CONFLICT (take_key) DO NOTHING RETURNING take_key`, params);
    stored = r.rows[0]?.take_key ?? null;
  } else {
    // A chronicle projection already stored for the event's day may be newer
    // than the held one, so it is never overwritten: the next chronicle run
    // projects the released text if the event page still says it.
    const r = await engine.query<{ id: number }>(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${values}) ON CONFLICT DO NOTHING RETURNING id`, params);
    const id = r.rows[0]?.id;
    stored = id === undefined ? null : String(id);
  }
  if (stored !== null) {
    await flagGatedRow(engine, {
      table, targetId: stored, sourceId: hold.source_id, tier: hold.tier as TrustTier, fields: payloadFields(hold.kind, hold.payload),
    });
  }
  return stored;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Store a released row. A fence row is re-projected from its page as the page
 * reads now, so a page edited since the hold is never overwritten with the
 * held text; an ontology observation goes back through its merge, which
 * closes the value it replaces; anything else is inserted as written. Each
 * writer finds the content released, stores it and records its flag receipt.
 * The stored row's id, or null when nothing is stored now (the page no longer
 * holds the row, or an equal row was already there).
 */
type WriterPath = "fence_take" | "fence_fact" | "ontology";

/** Which writer re-stores a released row; null for a row inserted as written. */
function writerPath(hold: RowHold): WriterPath | null {
  const p = hold.payload;
  const rowNum = typeof p["row_num"] === "number";
  if (hold.kind === "take" && rowNum && str(p["source_ref"])) return "fence_take";
  if (hold.kind === "fact" && rowNum && str(p["source_markdown_slug"])) return "fence_fact";
  if (hold.kind === "fact" && str(p["dimension"]) && str(p["value"])) return "ontology";
  return null;
}

async function publishReleased(storage: Storage, hold: RowHold, path: WriterPath): Promise<string | null> {
  const engine = storage.engine();
  const p = hold.payload;
  const rowNum = typeof p["row_num"] === "number" ? p["row_num"] : null;
  if (path === "fence_take" && rowNum !== null) {
    const { getPage, lockPageSlugs } = await import("./pages.ts");
    const { syncTakesFromFence } = await import("./synthesis/takes-canon.ts");
    const page = await getPage(storage, p["source_ref"] as string);
    if (!page) return null;
    // Under the page's lock, and only while the page is still the one read: a
    // page edit that commits meanwhile ran its own sync, which found the
    // content released.
    const current = await engine.transaction(async (tx) => {
      await lockPageSlugs(tx, page.slug);
      // scope: upstream the page slug comes from the released hold's own payload
      const now = await tx.query<{ content_hash: string }>(`SELECT content_hash FROM pages WHERE slug = $1 AND deleted_at IS NULL`, [page.slug]);
      if (now.rows[0]?.content_hash !== page.content_hash) return false;
      await syncTakesFromFence(tx, page.slug, page.markdown_body, { changedRowNums: [rowNum], deactivateMissing: false });
      return true;
    });
    if (!current) return null;
    // scope: upstream the take key comes from the released hold's own payload
    const r = await engine.query<{ take_key: string }>(
      `SELECT take_key FROM synth_takes WHERE take_key = $1 AND claim_text = $2`, [p["take_key"], p["claim_text"]]);
    return r.rows[0]?.take_key ?? null;
  }
  if (path === "fence_fact" && rowNum !== null) {
    const { getPage } = await import("./pages.ts");
    const { reconcileFactsForPage } = await import("./facts-reconcile.ts");
    const slug = p["source_markdown_slug"] as string;
    const page = await getPage(storage, slug);
    if (!page) return null;
    await reconcileFactsForPage(storage, slug, page.content_hash, str(p["source_id"]) ?? undefined);
    // scope: upstream the page and row number come from the released hold's own payload
    const r = await engine.query<{ id: number }>(
      `SELECT id FROM entity_facts WHERE source_markdown_slug = $1 AND row_num = $2 AND fact = $3 AND forgotten_at IS NULL
        ORDER BY id DESC LIMIT 1`, [slug, rowNum, p["fact"]]);
    const id = r.rows[0]?.id;
    return id === undefined ? null : String(id);
  }
  const { mergeOntologyFact } = await import("./ontology-facts.ts");
  const merged = await mergeOntologyFact(storage, {
    entitySlug: p["entity_slug"] as string, dimension: p["dimension"] as string, value: p["value"] as string,
    sourceId: str(p["source_id"]) ?? "default", principal: str(p["written_by_principal"]),
    ...(typeof p["confidence"] === "number" ? { confidence: p["confidence"] } : {}),
    ...(str(p["source_slug"]) ? { source_slug: p["source_slug"] as string } : {}),
    ...(str(p["valid_from"]) ? { validFrom: p["valid_from"] as string } : {}),
    ...(str(p["valid_until"]) ? { validTo: p["valid_until"] as string } : {}),
    ...(p["visibility"] === "world" || p["visibility"] === "private" ? { visibility: p["visibility"] } : {}),
    ...(p["dim_status"] === "active" || p["dim_status"] === "quarantined" ? { status: p["dim_status"] } : {}),
  });
  return merged.factId === null ? null : String(merged.factId);
}

/** The gated text of a held row, read back from its payload for the release's flag receipt. */
function payloadFields(kind: RowHoldKind, p: Record<string, unknown>): GateField[] {
  const s = (k: string) => (typeof p[k] === "string" ? p[k] as string : "");
  if (kind === "fact") return [{ field: "fact", text: s("fact") }, { field: "context", text: s("context") }];
  if (kind === "take") return [{ field: "claim", text: s("claim_text") }, { field: "evidence", text: s("resolved_source") }];
  return [{ field: "event", text: s("event") }, { field: "detail", text: s("detail") }];
}

async function logRelease(engine: Engine, hold: RowHold, by: string, targetId: string | null): Promise<void> {
  await logIngest(engine, {
    source_type: ROW_HOLD_AUDIT_SOURCE_TYPE,
    source_ref: `${hold.kind}:${hold.slug}`,
    summary: `released row h${hold.id} by ${by}${targetId === null ? " (nothing stored now: its page changed, or an equal row was there)" : ""}`,
    source_id: hold.source_id,
  });
}

/**
 * Release a held row. A row inserted as written is stored and marked released
 * in one transaction. A row its writer re-stores (fence rows, ontology
 * observations) is marked released first, because that writer looks for the
 * released content, then stored; should storing fail, the hold goes back to
 * `held`. Authorization is the caller's (operator CLI, admin session).
 */
export async function releaseRowHold(
  storage: Storage, id: number, decidedBy: string,
): Promise<{ status: RowHoldDecisionStatus; target_id?: string | null }> {
  const by = decidedBy.trim().slice(0, 200) || "operator";
  const engine = storage.engine();
  const decided = await engine.transaction(async (tx): Promise<RowHold | "already_decided" | "not_found" | { direct: string | null }> => {
    const hold = await lockHeld(tx, id);
    if (typeof hold === "string") return hold;
    if (writerPath(hold) !== null) {
      await tx.query(`UPDATE write_gate_row_holds SET status = 'released', decided_at = NOW(), decided_by = $2 WHERE id = $1`, [id, by]);
      return hold;
    }
    const targetId = await insertReleased(tx, hold);
    await tx.query(
      `UPDATE write_gate_row_holds SET status = 'released', decided_at = NOW(), decided_by = $2, released_target_id = $3 WHERE id = $1`,
      [id, by, targetId]);
    await logRelease(tx, hold, by, targetId);
    return { direct: targetId };
  });
  if (typeof decided === "string") return { status: decided };
  if ("direct" in decided) return { status: "released", target_id: decided.direct };
  let targetId: string | null;
  try {
    targetId = await publishReleased(storage, decided, writerPath(decided)!);
  } catch (e) {
    await engine.query(
      `UPDATE write_gate_row_holds SET status = 'held', decided_at = NULL, decided_by = NULL WHERE id = $1 AND status = 'released'`, [id]);
    throw e;
  }
  await engine.query(`UPDATE write_gate_row_holds SET released_target_id = $2 WHERE id = $1`, [id, targetId]);
  await logRelease(engine, decided, by, targetId);
  return { status: "released", target_id: targetId };
}

/** Drop a held row: it stays out, kept as a decided record. */
export async function dropRowHold(engine: Engine, id: number, decidedBy: string): Promise<{ status: RowHoldDecisionStatus }> {
  const by = decidedBy.trim().slice(0, 200) || "operator";
  return engine.transaction(async (tx) => {
    const hold = await lockHeld(tx, id);
    if (typeof hold === "string") return { status: hold };
    await tx.query(`UPDATE write_gate_row_holds SET status = 'dropped', decided_at = NOW(), decided_by = $2 WHERE id = $1`, [id, by]);
    await logIngest(tx, {
      source_type: ROW_HOLD_AUDIT_SOURCE_TYPE,
      source_ref: `${hold.kind}:${hold.slug}`,
      summary: `dropped row h${id} by ${by}`,
      source_id: hold.source_id,
    });
    return { status: "dropped" as const };
  });
}
