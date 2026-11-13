/**
 * Facts-fence reconciliation — make the entity_facts DB index match a page's
 * `## Facts` fence (the system of record). LLM-FREE: the fence is canonical
 * structured markdown; this deterministically parses it and re-projects it
 * into the DB. (The extract_facts cycle phase, minus optional fact-text
 * embedding — memrain can add that later via its existing Bedrock path; the
 * reconcile itself never needs a model.)
 *
 * Per page write, `reconcileFactsForPage`:
 *   1. RE-READS the page's CURRENT body + content_hash, and skips if the page
 *      moved on since the triggering write (a newer write's own reconcile will
 *      project the newer body) — this is the concurrency guard,
 *   2. parses the `## Facts` fence (core/facts-fence.ts),
 *   3. keeps unchanged fence rows, preserving identity and derived metadata,
 *   4. replaces changed rows and inserts new ACTIVE (non-struck) rows, keyed by
 *      `source_markdown_slug` + `row_num` (migration 035).
 *
 * It runs on EVERY page write (not just content changes) so an idempotent
 * re-put is a REPAIR path: if a prior reconcile failed, re-putting the page
 * rebuilds the index. The wipe is scoped to `source_markdown_slug = <page>`,
 * so a legacy or explicitly-asserted fact (NULL source_markdown_slug, e.g. via
 * `add_fact`) is INVISIBLE to it and survives — the column scoping is the
 * empty-fence guard.
 *
 * A page whose fence is genuinely ABSENT (no fence markers) KEEPS its fence
 * rows and reports `fenceAbsent` with the count retained: a body rewritten as
 * prose, or a merge that dropped the markers, must not silently delete facts.
 * A fact leaves the index through a struck (`~~…~~`) fence row or
 * `forget_fact`. Likewise a fence whose markers are PRESENT yet parse to zero
 * rows (a hand-edit syntax typo, or an emptied table) does NOT wipe — a
 * malformed fence must never silently destroy the prior projection. The same holds for a PARTIALLY malformed fence (some rows
 * parse, some are claimless/broken): wiping would delete the broken rows'
 * prior projections, so the reconcile is refused until the fence is fixed.
 *
 * Each fence fact is keyed `entity_slug = <the page hosting the fence>` — the
 * fence states facts ABOUT that page's subject. `entity_slug` has no FK, so a
 * fence on a non-entity page is harmless. A page's markdown body is NOT
 * chunk-indexed (pages are the DB-canonical store; the search chunk index
 * comes from `indexDocument`, which strips the fence first), so the fence is
 * never double-represented as searchable prose.
 */
import type { Storage } from "./storage.ts";
import type { Engine } from "./engine/interface.ts";
import { validateSlug, getPage, lockPageSlugs } from "./pages.ts";
import { parseFactsFence } from "./facts-fence.ts";
import { fenceBounds } from "./fence-shared.ts";
import { deadlockSafeTransaction } from "./retry.ts";
import { LEGACY_FENCE_WRITER } from "./brand.ts";
import { readQuarantineVerdict } from "./quarantine.ts";
import { pageObservationDate } from "./facts-extract.ts";

/** Marks a fence-derived fact row's author (parallels the gazetteer's link_kind). */
const FENCE_WRITER = "memrain:facts-fence";
/** Every author stamp a fence-derived row may carry. Rows projected before the
 *  rename keep theirs; nothing filters on the stamp, and the wipe goes by
 *  `source_markdown_slug`. */
export const FENCE_WRITERS = [FENCE_WRITER, LEGACY_FENCE_WRITER] as const;
/** PostgreSQL INTEGER upper bound — a hand-edited row_num above this would
 *  overflow the column and abort every reconcile, so it is clamped. */
const MAX_ROW_NUM = 2_147_483_647;
/** Hard cap on fence rows projected per page (defence vs a pathological fence
 *  producing an unbounded INSERT loop / long transaction). */
const MAX_FACTS_FENCE_ROWS = 1000;

/**
 * Fence reconciliation is on by default — it only ever touches rows a page's
 * OWN fence produced, so it is safe. `MEMRAIN_FACTS_FENCE=0` disables it (a kill
 * switch; the fence then stays inert as it was before this feature).
 */
export function factsFenceEnabled(
  env: string | undefined = process.env.MEMRAIN_FACTS_FENCE,
): boolean {
  return env !== "0";
}

/** Validate a hand-edited provenance slug; return null if it isn't a valid slug
 *  (the fence is hand-editable and must degrade gracefully, never throw). */
function safeSourceSlug(raw: string | undefined): string | null {
  if (raw === undefined || raw.length === 0) return null;
  try {
    validateSlug(raw);
    return raw;
  } catch {
    return null;
  }
}

/**
 * Reconcile `pageSlug`'s fence-owned facts to its CURRENT body's `## Facts`
 * fence. `expectedContentHash` is the content hash of the write that triggered
 * this call: if the page's persisted hash no longer matches, a newer write
 * landed and owns the reconcile — this call skips (no stale projection).
 * Returns counts removed/added; `{0,0}` when disabled, skipped, or a malformed
 * fence is left untouched (`skipped` names the refusal cause). Runs the
 * wipe+insert in one transaction.
 */
export async function reconcileFactsForPage(
  storage: Storage,
  pageSlug: string,
  expectedContentHash: string,
  sourceId?: string,
): Promise<{
  removed: number;
  added: number;
  unchanged?: number;
  skipped?: "malformed_rows" | "mixed_fence_brands" | "quarantined";
  fenceAbsent?: true;
  retained?: number;
  superseded_rows?: number[];
}> {
  if (!factsFenceEnabled()) return { removed: 0, added: 0 };
  validateSlug(pageSlug);
  // Tenant scope (mig047): stamp source_id on fence-derived facts only when
  // given, else let the column DEFAULT 'default' apply (never pass NULL).
  const scope =
    typeof sourceId === "string" && sourceId.length > 0 ? sourceId : null;

  // Re-read the CURRENT page. Skip if it's gone or moved on since the write
  // that triggered us (concurrency guard — the newer write reconciles itself).
  const page = await getPage(storage, pageSlug);
  if (!page || page.content_hash !== expectedContentHash) {
    return { removed: 0, added: 0 };
  }
  if (await readQuarantineVerdict(storage.engine(), pageSlug, page.source_id)) {
    return { removed: 0, added: 0, skipped: "quarantined" };
  }
  const body = page.markdown_body;

  // Mixed-brand guard: a `memrain:` and a `memex:` facts fence on one page —
  // neither is authoritative, so refuse rather than project (or wipe) either.
  const bounds = fenceBounds(body, "facts");
  if (bounds?.brand === "both") {
    console.warn(
      `[memrain] facts-reconcile skipped for '${pageSlug}' (both memrain: and memex: facts fences present)`,
    );
    return { removed: 0, added: 0, skipped: "mixed_fence_brands" };
  }
  // Absent fence: keep the prior projection untouched and say how much of it
  // there is, so the caller can surface facts that outlive their fence.
  if (bounds === null) {
    const params: unknown[] = [pageSlug];
    if (scope !== null) params.push(scope);
    const live = await storage.engine().query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM entity_facts
        WHERE source_markdown_slug = $1 AND forgotten_at IS NULL${scope !== null ? " AND source_id = $2" : ""}`,
      params,
    );
    return { removed: 0, added: 0, fenceAbsent: true, retained: live.rows[0]?.c ?? 0 };
  }
  // Malformed-fence guard: markers present but nothing parses → do NOT wipe.
  const parseWarnings: string[] = [];
  const parsed = parseFactsFence(body, parseWarnings);
  if (parsed.length === 0) {
    return { removed: 0, added: 0 };
  }
  // Partial-parse guard: some data rows were claimless/malformed and got
  // skipped by the parser. Wipe+reinsert here would delete THOSE rows' prior
  // projections, so refuse the reconcile and keep the existing index — the
  // next re-put of a fixed fence repairs it.
  if (parseWarnings.length > 0) {
    // Callers discard this result on the put path — log here so a frozen
    // projection is diagnosable instead of silent.
    console.warn(
      `[memrain] facts-reconcile skipped for '${pageSlug}' (malformed fence rows): ${parseWarnings.join("; ")}`,
    );
    return { removed: 0, added: 0, skipped: "malformed_rows" };
  }

  // Active rows only: a struck (`~~…~~`) claim is a retraction — it must NOT
  // re-enter the DB index. Dedup by row_num, the fence's stable identity (two
  // rows with the SAME claim but distinct row_num are intentionally distinct
  // facts; the per-page wipe-on-rewrite keeps the row set bounded). Clamp
  // row_num to the INTEGER range and cap the total.
  const observationDate = await pageObservationDate(storage, pageSlug, page.source_id);
  const seenRow = new Set<number>();
  const facts: {
    claim: string;
    confidence: number;
    source?: string;
    rowNum: number;
    kind?: string;
    notability?: string;
    validFrom?: string;
    validUntil?: string;
    claimMetric?: string;
    claimValue?: number;
    claimUnit?: string;
    claimPeriod?: string;
    eventType?: string;
  }[] = [];
  for (const f of parsed) {
    if (!f.active) continue;
    const rowNum = Math.min(Math.max(1, Math.trunc(f.rowNum)), MAX_ROW_NUM);
    if (seenRow.has(rowNum)) continue;
    seenRow.add(rowNum);
    // kind / notability / valid_from / valid_until are already
    // normalized-or-undefined by the fence parser (invalid → undefined), so
    // they reach the DATE / CHECK-constrained columns clean or as NULL.
    const row: (typeof facts)[number] = {
      claim: f.claim,
      confidence: f.confidence,
      rowNum,
    };
    if (f.source !== undefined) row.source = f.source;
    if (f.kind !== undefined) row.kind = f.kind;
    if (f.notability !== undefined) row.notability = f.notability;
    const validFrom = f.validFrom ?? observationDate;
    if (validFrom !== null) row.validFrom = validFrom;
    if (f.validUntil !== undefined) row.validUntil = f.validUntil;
    // Typed-claim fields (mig070) — already normalized-or-undefined by the fence
    // parser, so they reach the NUMERIC / TEXT columns clean or as NULL.
    if (f.claimMetric !== undefined) row.claimMetric = f.claimMetric;
    if (f.claimValue !== undefined) row.claimValue = f.claimValue;
    if (f.claimUnit !== undefined) row.claimUnit = f.claimUnit;
    if (f.claimPeriod !== undefined) row.claimPeriod = f.claimPeriod;
    if (f.eventType !== undefined) row.eventType = f.eventType;
    facts.push(row);
    if (facts.length >= MAX_FACTS_FENCE_ROWS) break;
  }

  const engine: Engine = storage.engine();
  // When scoped, the wipe + insert confine to this source so a per-tenant
  // re-put never clears another tenant's fence facts. Unscoped (NULL) keeps the
  // original whole-source behavior.
  const delScope = scope !== null ? ` AND source_id = $2` : "";
  const insCol = scope !== null ? ", source_id" : "";
  const insVal = scope !== null ? ", $17" : "";
  // Deadlock-safe: the wipe holds row locks and the re-insert then takes the
  // withdraw lock shared through its trigger, so a concurrent forget can make
  // this the deadlock victim (see retry.ts).
  return deadlockSafeTransaction(engine, async (tx) => {
    await lockPageSlugs(tx, pageSlug);
    const current = await tx.query<{ content_hash: string }>(
      `SELECT content_hash FROM pages WHERE slug = $1 AND deleted_at IS NULL${delScope}`,
      scope !== null ? [pageSlug, scope] : [pageSlug],
    );
    if (current.rows[0]?.content_hash !== expectedContentHash) return { removed: 0, added: 0 };
    // Preserve forget tombstones (mig043) across the rebuild: a fact the
    // operator explicitly forgot must not be resurrected by the next page
    // re-put. Two parts — (1) the wipe below spares tombstoned rows
    // (`forgotten_at IS NULL`), keeping them for audit, and (2) we skip
    // re-inserting any fence fact whose claim is already tombstoned for this
    // page. A fence fact's identity here is its claim text (every fence row on
    // a page shares entity_slug = the page). Fetched BEFORE the wipe.
    //
    // Supersession applies only to the exact source/page/row/claim identity;
    // a corrected claim or another row remains eligible. Forget keeps its
    // broader existing withdrawal semantics. A purge tombstone belongs to the
    // page that was purged, never to a later page on the same slug.
    const tombParams: unknown[] = [pageSlug];
    if (scope !== null) tombParams.push(scope);
    const tomb = await tx.query<{ fact: string; row_num: number | null; source_id: string; forgotten_cause: string | null }>(
      `SELECT DISTINCT fact, row_num, source_id, forgotten_cause FROM entity_facts
        WHERE source_markdown_slug = $1
          AND forgotten_at IS NOT NULL
          AND forgotten_cause IS DISTINCT FROM 'purge'
          ${delScope}`,
      tombParams,
    );
    // Key the tombstone skip-set on row_num — the fence's stable identity used
    // everywhere else — so a forgotten row is suppressed WITHOUT collaterally
    // dropping a same-text sibling on a different row. Legacy tombstones with a
    // NULL row_num (retired pre-mig062) fall back to claim-text matching.
    const forgottenRows = new Set<number>();
    const forgottenLegacyText = new Set<string>();
    const superseded = new Set<string>();
    for (const r of tomb.rows) {
      if (r.forgotten_cause === "supersede") {
        if (r.source_id === (scope ?? "default") && r.row_num !== null) superseded.add(JSON.stringify([r.row_num, r.fact]));
        continue;
      }
      if (typeof r.row_num === "number") forgottenRows.add(r.row_num);
      else forgottenLegacyText.add(r.fact);
    }

    // A claim withdrawn by a forget anywhere in this source — an add_fact row, a
    // transcript extraction, another fence row — is skipped too (migration 112).
    // The insert trigger would land it forgotten anyway, but the wipe spares
    // tombstones, so every re-put would pile up one more. Fence rows take the
    // column DEFAULTs: visibility 'private', source 'default' when unscoped.
    const withdrawnClaims = new Set<string>();
    if (facts.length > 0) {
      const w = await tx.query<{ claim: string }>(
        `SELECT c.claim FROM unnest($1::text[]) AS c(claim)
          WHERE EXISTS (
            SELECT 1 FROM fact_withdrawals w
             WHERE w.source_id = $2 AND w.visibility = 'private'
               AND w.entity_slug = $3
               AND w.claim_key = memrain_fact_claim_key(c.claim))`,
        [facts.map((f) => f.claim), scope ?? "default", pageSlug],
      );
      for (const r of w.rows) withdrawnClaims.add(r.claim);
    }

    const live = await tx.query<Record<string, unknown> & { id: number; row_num: number }>(
      `SELECT id, row_num, entity_slug, source_id, fact, confidence::float8 AS confidence,
              source_slug, kind, notability, valid_from::text AS valid_from, valid_until::text AS valid_until,
              claim_metric, claim_value::float8 AS claim_value, claim_unit, claim_period, event_type
         FROM entity_facts WHERE source_markdown_slug = $1 AND forgotten_at IS NULL${delScope}
         FOR UPDATE`, tombParams,
    );
    const liveByRow = new Map(live.rows
      .filter(r => r.source_id === (scope ?? "default") && r.entity_slug === pageSlug)
      .map(r => [r.row_num, r]));
    const keepIds: number[] = [];
    const keepRows = new Set<number>();
    const supersededRows = facts.filter(f => superseded.has(JSON.stringify([f.rowNum, f.claim]))).map(f => f.rowNum);
    for (const f of facts) {
      if (superseded.has(JSON.stringify([f.rowNum, f.claim]))) continue;
      if (forgottenRows.has(f.rowNum) || forgottenLegacyText.has(f.claim) || withdrawnClaims.has(f.claim)) continue;
      const old = liveByRow.get(f.rowNum);
      if (!old) continue;
      const projected = {
        fact: f.claim, confidence: Math.fround(f.confidence), source_slug: safeSourceSlug(f.source),
        kind: f.kind ?? null, notability: f.notability ?? null,
        valid_from: f.validFrom ?? null, valid_until: f.validUntil ?? null,
        claim_metric: f.claimMetric ?? null, claim_value: f.claimValue ?? null,
        claim_unit: f.claimUnit ?? null, claim_period: f.claimPeriod ?? null, event_type: f.eventType ?? null,
      };
      if (Object.entries(projected).every(([key, value]) => old[key] === value)) {
        keepIds.push(old.id);
        keepRows.add(f.rowNum);
      }
    }

    const delParams: unknown[] = [pageSlug];
    if (scope !== null) delParams.push(scope);
    delParams.push(keepIds);
    const del = await tx.query<{ c: number }>(
      `WITH d AS (
         DELETE FROM entity_facts
          WHERE source_markdown_slug = $1
            AND forgotten_at IS NULL${delScope}
            AND NOT (id = ANY($${delParams.length}::bigint[]))
          RETURNING 1
       )
       SELECT COUNT(*)::int AS c FROM d`,
      delParams,
    );
    let added = 0;
    for (const f of facts) {
      if (superseded.has(JSON.stringify([f.rowNum, f.claim]))) continue;
      // A forgotten row stays forgotten across a fence rebuild (by row_num; legacy
      // NULL-row tombstones by text).
      if (forgottenRows.has(f.rowNum) || forgottenLegacyText.has(f.claim)) continue;
      if (withdrawnClaims.has(f.claim) || keepRows.has(f.rowNum)) continue;
      const insParams: unknown[] = [
        pageSlug,
        f.claim,
        f.confidence,
        safeSourceSlug(f.source),
        FENCE_WRITER,
        pageSlug,
        f.rowNum,
        f.kind ?? null,
        f.notability ?? null,
        f.validFrom ?? null,
        f.validUntil ?? null,
        f.claimMetric ?? null,
        f.claimValue ?? null,
        f.claimUnit ?? null,
        f.claimPeriod ?? null,
        f.eventType ?? null,
      ];
      if (scope !== null) insParams.push(scope);
      await tx.query(
        `INSERT INTO entity_facts
           (entity_slug, fact, confidence, source_slug, source_chunk_id,
            written_by, source_markdown_slug, row_num,
            kind, notability, valid_from, valid_until,
            claim_metric, claim_value, claim_unit, claim_period, event_type${insCol})
         VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11,
                 $12, $13, $14, $15, $16${insVal})`,
        insParams,
      );
      added += 1;
    }
    return { removed: del.rows[0]?.c ?? 0, added, ...(keepRows.size > 0 ? { unchanged: keepRows.size } : {}),
      ...(supersededRows.length > 0 ? { superseded_rows: supersededRows } : {}) };
  });
}

/**
 * Purge a page's fence-owned facts (used by page_delete). A soft-deleted page
 * must not keep serving its fence facts; explicit (NULL source_markdown_slug)
 * facts are left intact.
 */
export async function purgeFenceFactsForPage(
  storage: Storage,
  pageSlug: string,
): Promise<{ removed: number }> {
  validateSlug(pageSlug);
  const r = await storage.engine().query<{ c: number }>(
    `WITH d AS (
       DELETE FROM entity_facts WHERE source_markdown_slug = $1 RETURNING 1
     )
     SELECT COUNT(*)::int AS c FROM d`,
    [pageSlug],
  );
  return { removed: r.rows[0]?.c ?? 0 };
}
