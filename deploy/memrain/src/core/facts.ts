/**
 * Entity facts — append-only fact ledger per entity, plus the
 * `entityRecall` aggregator that returns the entity's page row +
 * top-confidence facts + most-recent timeline events in a single
 * call. The combined response is what the agent reaches for when
 * the operator asks "what do I know about X?".
 *
 * Schema: `entity_facts` (migration 018).
 *
 * Writes are append-only, but a RESTATEMENT is not a new claim: an identical
 * claim about the same subject, from the same source and the same writer,
 * refreshes the row already on file instead of stacking a twin (see
 * `findLiveClaim` — the same identity the consolidate phase promotes takes
 * under). Chunk-sourced facts keep their narrower index-backed idempotency on
 * (entity_slug, fact, source_chunk_id, speaker) on top of it (migration 132).
 */
import type { Storage } from "./storage.ts";
import type { Engine } from "./engine/interface.ts";
import { andSourceScope } from "./source-scope.ts";
import { embedText } from "./embedding.ts";
import { getPage, validateSlug, type PageRow } from "./pages.ts";
import {
  getEntityTimeline,
  type TimelineEventRow,
} from "./timeline.ts";
import {
  DEFAULT_FACT_KIND,
  effectiveConfidence,
  factDecayEnabled,
} from "./facts-decay.ts";
import {
  classifyFact,
  defaultClassifierLlmFn,
  CHEAP_THRESHOLD,
  FALLBACK_THRESHOLD,
  type FactCandidate,
} from "./facts-classify.ts";
import type { LlmFn } from "./llm/haiku.ts";
import type { BudgetTracker } from "./budget.ts";
import { guardFields } from "./secret-scan.ts";
import { withdrawLockKey } from "./fact-withdrawals.ts";
import { deadlockSafeTransaction } from "./retry.ts";

/**
 * Insert-time dedup / supersede knobs (migration 038 fact embedding + the
 * facts-classify cascade). Providing this object OPTS IN to the classify path
 * for this call regardless of env (the test seam); production callers leave it
 * undefined and let `MEMRAIN_FACTS_DEDUP` govern. All fields default sensibly.
 */
export interface FactDedupOptions {
  /** Embedder for the new fact (tests). Defaults to the Bedrock Titan path. */
  embed?: (text: string) => Promise<number[]>;
  /** Haiku seam for the classifier step (tests). Defaults to the shared helper
   *  ONLY when `MEMRAIN_FACTS_DEDUP_LLM` is on; otherwise the LLM step is skipped. */
  llmFn?: LlmFn;
  /** Budget guard for the paid classifier call. */
  budget?: BudgetTracker;
  /** Model id used for budget pricing. */
  modelId?: string;
  /** Cosine fast-path threshold (default 0.95). */
  cheapThreshold?: number;
  /** Classifier-failure fallback threshold (default 0.92). */
  fallbackThreshold?: number;
  /** Cap on entity-prefiltered candidates fetched (default 5). */
  candidateLimit?: number;
}

export interface AddFactInput {
  entity_slug: string;
  fact: string;
  confidence?: number;
  source_slug?: string;
  source_chunk_id?: string;
  /**
   * Who recorded the claim. Omitted -> the row is credited to
   * `UNATTRIBUTED_WRITER`: provenance is an invariant of the ledger, not a
   * courtesy of one caller, and "we never recorded it" is a fact worth stating
   * out loud rather than leaving as a NULL every reader has to interpret.
   */
  written_by?: string;
  /**
   * Tenant source scope (migration 047). Omitted -> the column DEFAULT
   * 'default' applies, preserving whole-brain behavior.
   */
  source_id?: string;
  /** Fact category (migration 037). Validated against the CHECK set; an
   *  omitted or unrecognized value floors to `DEFAULT_FACT_KIND` so the claim
   *  ages (a NULL kind is invisible to decay). */
  kind?: string;
  /** Notability ordinal (migration 037). Validated against the CHECK set; an
   *  unrecognized value is dropped to NULL. */
  notability?: string;
  /**
   * Validity anchor (migration 037 `valid_from`): the calendar date the claim
   * became true, which is NOT the same as when it was recorded. A backfilled
   * transcript carries the conversation's own date; omitted -> NULL, and the
   * decay/recency surfaces fall back to `written_at` as before. Accepts
   * `YYYY-MM-DD` or a full ISO timestamp (reduced to its UTC calendar date).
   */
  valid_from?: string;
  /**
   * Typed-claim metadata (migration 070). Present when the fact is a numeric
   * claim; drives the metric-trajectory regression + drift analysis. All
   * optional and free-form. `claim_metric` is normalized to lowercase
   * snake_case; a non-finite `claim_value` is dropped to NULL.
   */
  claim_metric?: string;
  claim_value?: number;
  claim_unit?: string;
  claim_period?: string;
  /** Event-shaped row marker (migration 070), e.g. `meeting`, `job_change`. */
  event_type?: string;
  /**
   * Lifecycle metadata (migration 085). `visibility` gates remote reads
   * ('private' default | 'world'); `context` is a free-text situational note;
   * `source_session` is the opaque capture-session id behind the recall
   * session filter. All optional; an unrecognized visibility falls back to
   * the column DEFAULT 'private'.
   */
  visibility?: string;
  context?: string;
  source_session?: string;
  /**
   * Who asserted the claim (migration 130): 'user' | 'assistant' | 'other'.
   * Anything else, or omitted, stores NULL — the speaker was not recorded.
   * Part of the claim's identity: an assistant's suggestion never refreshes
   * the user's own claim of the same words.
   */
  attributed_to?: string;
  /**
   * Insert-time dedup / supersede. Present -> opt in for this call; absent ->
   * governed by `MEMRAIN_FACTS_DEDUP` (default OFF, exact-tuple dedup only).
   */
  dedup?: FactDedupOptions;
}

/** Allowed `kind` values — mirrors the migration 037 CHECK constraint. */
const KIND_VALUES: ReadonlySet<string> = new Set([
  "event",
  "preference",
  "commitment",
  "belief",
  "fact",
]);
/** Allowed `notability` values — mirrors the migration 037 CHECK constraint. */
const NOTABILITY_VALUES: ReadonlySet<string> = new Set(["high", "medium", "low"]);
/** Allowed `visibility` values — mirrors the migration 085 CHECK constraint. */
const VISIBILITY_VALUES: ReadonlySet<string> = new Set(["private", "world"]);
/** Allowed `attributed_to` values — mirrors the migration 130 CHECK constraint. */
const ATTRIBUTION_VALUES: ReadonlySet<string> = new Set(["user", "assistant", "other"]);

/** Normalize a caller-supplied kind to an allowed value, else the decay floor
 *  (never let a bad value reach — and abort on — the CHECK constraint, and
 *  never let a claim land with the blank kind decay cannot see). */
function normaliseKind(k: string | undefined): string {
  if (typeof k !== "string") return DEFAULT_FACT_KIND;
  const v = k.trim().toLowerCase();
  return KIND_VALUES.has(v) ? v : DEFAULT_FACT_KIND;
}

/** Normalize a caller-supplied notability to an allowed value, else NULL. */
function normaliseNotability(n: string | undefined): string | null {
  if (typeof n !== "string") return null;
  const v = n.trim().toLowerCase();
  return NOTABILITY_VALUES.has(v) ? v : null;
}

/** Normalize a caller-supplied visibility, else NULL (column DEFAULT applies). */
function normaliseVisibility(v: string | undefined): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return VISIBILITY_VALUES.has(s) ? s : null;
}

/** Normalize a caller-supplied speaker, else NULL (not recorded). */
function normaliseAttribution(v: string | undefined): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return ATTRIBUTION_VALUES.has(s) ? s : null;
}

/** Canonicalize a free-form label (metric / event_type) to lowercase
 *  snake_case so trajectory grouping is stable; empty/non-string → NULL. */
function normaliseLabel(v: string | undefined): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    // Measured linear through addFact: 0.3 ms net of the DB write at 128 K, on
    // a 128 K underscore run. The collapse above is the cap — it rewrites every
    // run of non-alphanumerics to a SINGLE `_`, so by the time this pattern runs
    // the string cannot hold `__`, and the `_+` attack string is unreachable.
    // eslint-disable-next-line regexp/no-super-linear-move
    .replace(/^_+|_+$/g, "");
  return s.length > 0 ? s : null;
}

/** Reduce a caller-supplied date to the `YYYY-MM-DD` the DATE column stores.
 *  A full ISO timestamp is anchored in UTC so the stored day never drifts with
 *  the process timezone; anything unparseable is dropped to NULL. */
function normaliseDate(v: string | undefined): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** A finite numeric claim value, else NULL. */
function normaliseClaimValue(v: number | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A trimmed non-empty free-form string cell, else NULL. */
function normaliseText(v: string | undefined): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

/**
 * Insert-time dedup is opt-in. An explicit `input.dedup` enables it for the
 * call (tests / callers); otherwise `MEMRAIN_FACTS_DEDUP` governs. The paid Haiku
 * classifier step is separately gated by `MEMRAIN_FACTS_DEDUP_LLM` — with it off
 * only the free cosine fast-path runs.
 */
export function factsDedupEnabled(
  env: string | undefined = process.env.MEMRAIN_FACTS_DEDUP,
): boolean {
  const v = (env ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export function factsDedupLlmEnabled(
  env: string | undefined = process.env.MEMRAIN_FACTS_DEDUP_LLM,
): boolean {
  const v = (env ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

interface ResolvedDedup {
  embed: (text: string) => Promise<number[]>;
  llmFn?: LlmFn;
  budget?: BudgetTracker;
  modelId?: string;
  cheapThreshold: number;
  fallbackThreshold: number;
  candidateLimit: number;
}

/** Resolve the effective dedup config, or null when the path is off. */
function resolveDedup(input: AddFactInput): ResolvedDedup | null {
  const d = input.dedup;
  if (d) {
    const llmFn = d.llmFn ?? (factsDedupLlmEnabled() ? defaultClassifierLlmFn() : undefined);
    return {
      embed: d.embed ?? ((t) => embedText(t)),
      ...(llmFn ? { llmFn } : {}),
      ...(d.budget ? { budget: d.budget } : {}),
      ...(d.modelId ? { modelId: d.modelId } : {}),
      cheapThreshold: d.cheapThreshold ?? CHEAP_THRESHOLD,
      fallbackThreshold: d.fallbackThreshold ?? FALLBACK_THRESHOLD,
      candidateLimit: d.candidateLimit ?? 5,
    };
  }
  if (!factsDedupEnabled()) return null;
  const llmFn = factsDedupLlmEnabled() ? defaultClassifierLlmFn() : undefined;
  return {
    embed: (t) => embedText(t),
    ...(llmFn ? { llmFn } : {}),
    cheapThreshold: CHEAP_THRESHOLD,
    fallbackThreshold: FALLBACK_THRESHOLD,
    candidateLimit: 5,
  };
}

/**
 * `entity_facts.id` is BIGSERIAL, and the Postgres driver hands int8 back as a
 * string while PGLite returns a number. Every id that leaves this module goes
 * through here so a client sees one JSON type on both engines and can pass the
 * id straight back to `recall` / `forget_fact`. Throws instead of returning NaN
 * so a corrupt value fails loudly rather than being written to a response.
 */
export function toFactId(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" || typeof v === "bigint" ? Number(v) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`fact id is not a positive safe integer: ${String(v).slice(0, 32)}`);
  }
  return n;
}

function toFactIdOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : toFactId(v);
}

/** Normalize the BIGINT id columns of a fact row (see `toFactId`). */
export function normalizeFactRow<
  T extends { id: number; superseded_by: number | null; consolidated_into: number | null },
>(row: T): T {
  return {
    ...row,
    id: toFactId(row.id),
    superseded_by: toFactIdOrNull(row.superseded_by),
    consolidated_into: toFactIdOrNull(row.consolidated_into),
  };
}

/**
 * Entity-prefiltered nearest-neighbour candidates for the classifier, scored by
 * cosine similarity (`1 - <=> distance`) and ordered best-first. Scoped to the
 * new fact's effective source so dedup never crosses a tenant boundary, and to
 * live (non-tombstoned) embedded rows.
 */
async function fetchDedupCandidates(
  storage: Storage,
  entitySlug: string,
  vecJson: string,
  effectiveSource: string,
  limit: number,
  attributedTo: string | null,
): Promise<FactCandidate[]> {
  const r = await storage.engine().query<{
    id: number;
    fact: string;
    kind: string | null;
    cos: number;
  }>(
    `SELECT id, fact, kind, 1 - (embedding <=> $2::vector) AS cos
       FROM entity_facts
      WHERE entity_slug = $1
        AND forgotten_at IS NULL
        AND embedding IS NOT NULL
        AND source_id = $3
        -- dimensional ontology rows have their own read path; never a dedup match.
        AND dimension IS NULL
        -- one speaker's claim never collapses onto another's (mig130).
        AND attributed_to IS NOT DISTINCT FROM $5::text
      ORDER BY embedding <=> $2::vector
      LIMIT $4`,
    [entitySlug, vecJson, effectiveSource, limit, attributedTo],
  );
  return r.rows.map((row) => ({
    id: toFactId(row.id),
    fact: row.fact,
    kind: row.kind,
    cos: Number(row.cos),
  }));
}

/**
 * Writer credited to a claim whose caller named none. The MCP `add_fact` tool
 * credits its own identity, but it is one caller of many — the CLI, the
 * extractor and every future writer reach the ledger through `addFact`, so the
 * invariant "every fact names a writer" belongs here. A sentinel beats a NULL:
 * it says provenance was never recorded, which is a readable answer, where NULL
 * is a hole every read surface has to guess at.
 */
export const UNATTRIBUTED_WRITER = "unattributed";

/**
 * The ledger's identity for "this claim is already on file": one subject, one
 * tenant source, one writer, byte-identical text. It is the tuple the
 * consolidate phase already promotes takes under (cycle/consolidate-facts.ts),
 * shared so the two paths cannot drift into separate notions of the same claim.
 *
 * `source_id` is the EFFECTIVE source ('default' when a caller left the column
 * to its DEFAULT), so a re-save that omits the tenant still matches its own
 * earlier write.
 *
 * `attributed_to` (migration 130) is part of it: the assistant recommending
 * something is not the user claiming it, so one never refreshes the other.
 * Omitted means NULL — a claim with no recorded speaker, as every legacy row
 * and every consolidated take is.
 */
export interface ClaimIdentity {
  entity_slug: string;
  source_id: string;
  fact: string;
  written_by: string;
  attributed_to?: string | null;
}

/** The narrow query surface an Engine and an in-transaction handle both meet. */
type Queryable = Pick<Engine, "query">;

/**
 * Id of the LIVE row already holding this claim, or null. Tombstoned rows are
 * excluded on purpose: a forgotten claim stays forgotten, and re-asserting it
 * never quietly resurrects the row the operator retired (the withdrawal ledger,
 * migration 112, keeps it from landing live at all). Dimensional ontology rows (mig097) have their own write path and are
 * never a match here.
 */
export async function findLiveClaim(
  q: Queryable,
  id: ClaimIdentity,
): Promise<number | null> {
  const r = await q.query<{ id: number }>(
    `SELECT id FROM entity_facts
      WHERE entity_slug = $1 AND source_id = $2 AND fact = $3 AND written_by = $4
        AND attributed_to IS NOT DISTINCT FROM $5::text
        AND forgotten_at IS NULL
        AND dimension IS NULL
      ORDER BY id
      LIMIT 1`,
    [id.entity_slug, id.source_id, id.fact, id.written_by, id.attributed_to ?? null],
  );
  return toFactIdOrNull(r.rows[0]?.id);
}

/**
 * A claim with a speaker adopts the live row holding the same claim with no
 * speaker recorded (every row written before migration 130): the same identity,
 * or — for a chunk-sourced claim — the same (entity, fact, chunk) in the same
 * source. The row takes the speaker instead of a twin landing beside it, so a
 * re-extraction does not duplicate the legacy ledger. Only a NULL row is ever
 * adopted, so one speaker's claim never takes over another's. Returns the
 * adopted id, or null.
 */
export async function adoptUnattributedClaim(
  q: Queryable,
  id: ClaimIdentity & { attributed_to: string },
  chunkId: string | null,
): Promise<number | null> {
  const r = await q.query<{ id: number }>(
    `UPDATE entity_facts SET attributed_to = $5
      WHERE attributed_to IS NULL
        AND id = (
          SELECT e.id FROM entity_facts e
           WHERE e.entity_slug = $1 AND e.source_id = $2 AND e.fact = $3
             AND (e.written_by = $4 OR ($6::text IS NOT NULL AND e.source_chunk_id = $6))
             AND e.attributed_to IS NULL
             AND e.forgotten_at IS NULL
             AND e.dimension IS NULL
             -- never take a chunk tuple this speaker already holds
             AND NOT EXISTS (
               SELECT 1 FROM entity_facts o
                WHERE o.entity_slug = e.entity_slug AND o.fact = e.fact
                  AND o.source_chunk_id = e.source_chunk_id AND o.attributed_to = $5
             )
           ORDER BY e.id
           LIMIT 1)
      RETURNING id`,
    [id.entity_slug, id.source_id, id.fact, id.written_by, id.attributed_to, chunkId],
  );
  return toFactIdOrNull(r.rows[0]?.id);
}

export interface FactRow {
  id: number;
  entity_slug: string;
  fact: string;
  confidence: number;
  source_slug: string | null;
  source_chunk_id: string | null;
  written_by: string | null;
  written_at: string;
  /** mig037 metadata. NULL on legacy rows / a fence without these columns. */
  kind: string | null;
  notability: string | null;
  /** DATE text `YYYY-MM-DD` or NULL. */
  valid_from: string | null;
  valid_until: string | null;
  /** mig085 lifecycle. 'private' on every pre-085 row (backfilled DEFAULT). */
  visibility: string;
  superseded_by: number | null;
  consolidated_into: number | null;
  context: string | null;
  source_session: string | null;
  /** mig130 speaker ('user' | 'assistant' | 'other'); NULL when not recorded. */
  attributed_to: string | null;
  /** mig043 tombstone; NULL on every live row (the default read set). */
  forgotten_at: string | null;
}

export interface AddFactResult {
  id: number | null;
  entity_slug: string;
  /** False when the claim was already on file — the row on file was refreshed
   *  (see `findLiveClaim`) or the chunk tuple collided — so nothing new landed. */
  inserted: boolean;
  /** Set when the claim was withdrawn by an earlier forget (migration 112):
   *  nothing was written and `id` is null. */
  withdrawn?: true;
}

/**
 * True when a forget has withdrawn this claim for this source, visibility and
 * subject (migration 112). The claim key is computed by the same SQL function
 * the insert trigger uses, so the two cannot disagree on what "the same claim"
 * means.
 */
export async function isClaimWithdrawn(
  q: Queryable,
  key: { source_id: string; visibility: string; entity_slug: string; fact: string },
): Promise<boolean> {
  const r = await q.query<{ hit: number }>(
    `SELECT 1 AS hit FROM fact_withdrawals
      WHERE source_id = $1 AND visibility = $2 AND entity_slug = $3
        AND claim_key = memrain_fact_claim_key($4)`,
    [key.source_id, key.visibility, key.entity_slug, key.fact],
  );
  return r.rows.length > 0;
}

function normaliseConfidence(c: number | undefined): number {
  if (c === undefined) return 1.0;
  if (typeof c !== "number" || Number.isNaN(c)) {
    throw new TypeError("confidence must be a number in [0, 1]");
  }
  if (c < 0 || c > 1) {
    throw new Error("confidence must be in [0, 1]");
  }
  return c;
}

/**
 * Append a fact about an entity.
 *
 * A claim already on file under the same identity (subject, tenant source,
 * writer, text — `findLiveClaim`) is REFRESHED, not duplicated: re-saving a page
 * re-asserts its claims, it does not add new ones, and the ledger used to grow a
 * copy per save. Chunk-sourced facts additionally keep the index-backed
 * idempotency on (entity_slug, fact, source_chunk_id, speaker), which still catches a
 * re-emit that changed writer; a re-emit carrying a different `valid_from`
 * corrects the stored date in place instead of being swallowed.
 */
export async function addFact(
  storage: Storage,
  input: AddFactInput,
): Promise<AddFactResult> {
  validateSlug(input.entity_slug);
  if (typeof input.fact !== "string" || input.fact.length === 0) {
    throw new Error("fact must be a non-empty string");
  }
  const conf = normaliseConfidence(input.confidence);
  const sourceSlug = input.source_slug ?? null;
  if (sourceSlug !== null) validateSlug(sourceSlug);
  const chunkId = input.source_chunk_id ?? null;
  // Provenance is an invariant of the ledger: a caller that names no writer is
  // credited to the sentinel rather than landing anonymous. Blank / whitespace
  // is not provenance either.
  const writtenBy = normaliseText(input.written_by) ?? UNATTRIBUTED_WRITER;
  const kind = normaliseKind(input.kind);
  const notability = normaliseNotability(input.notability);
  const validFrom = normaliseDate(input.valid_from);
  // Typed-claim metadata (mig070): normalized-or-NULL, stamped only when set.
  const claimMetric = normaliseLabel(input.claim_metric);
  const claimValue = normaliseClaimValue(input.claim_value);
  const claimUnit = normaliseText(input.claim_unit);
  const claimPeriod = normaliseText(input.claim_period);
  const eventType = normaliseLabel(input.event_type);
  // Lifecycle metadata (mig085): normalized-or-NULL, stamped only when set so
  // the columns' DEFAULTs apply otherwise.
  const visibility = normaliseVisibility(input.visibility);
  const sourceSession = normaliseText(input.source_session);
  const attributedTo = normaliseAttribution(input.attributed_to);
  // Tenant scope (mig047): stamp source_id only when provided so the NOT NULL
  // column's DEFAULT 'default' applies otherwise (never pass NULL).
  const sourceId =
    typeof input.source_id === "string" && input.source_id.length > 0
      ? input.source_id
      : null;
  const effectiveSource = sourceId ?? "default";
  // Credentials never reach the ledger — nor the dedup embed, which would send
  // them to the embedding provider.
  const { fact, context } = await guardFields(
    storage.engine(),
    `fact:${input.entity_slug}`,
    sourceId,
    `fact on '${input.entity_slug}'`,
    { fact: input.fact, context: input.context },
  );
  const factContext = normaliseText(context);

  // A forgotten claim stays forgotten. Checked before the restatement lookup
  // and the paid embed/classify path: a withdrawn claim costs nothing and
  // writes nothing. The insert trigger enforces the same rule for every other
  // write path; this only spares the tombstone and the Bedrock call.
  if (
    await isClaimWithdrawn(storage.engine(), {
      source_id: effectiveSource,
      visibility: visibility ?? "private",
      entity_slug: input.entity_slug,
      fact,
    })
  ) {
    return {
      id: null,
      entity_slug: input.entity_slug,
      inserted: false,
      withdrawn: true,
    };
  }

  // Restatement collapse. Free, deterministic and always on, so it runs BEFORE
  // the paid embed/classify path below: the same claim, same subject, same
  // source, same writer is the row already on file, and every re-save of an
  // eligible page used to mint another copy of it (the ledger only ever grew).
  // Provenance stays with the first sighting — a later page restating the claim
  // refreshes it rather than forking the ledger's account of it.
  const onFile = await findLiveClaim(storage.engine(), {
    entity_slug: input.entity_slug,
    source_id: effectiveSource,
    fact,
    written_by: writtenBy,
    attributed_to: attributedTo,
  });
  if (onFile !== null) {
    await refreshClaim(storage.engine(), onFile, {
      // An omitted confidence is "no opinion", never a reset to the 1.0
      // default — the same rule `valid_from` already follows below.
      confidence: input.confidence === undefined ? null : conf,
      validFrom,
    });
    return { id: onFile, entity_slug: input.entity_slug, inserted: false };
  }
  if (attributedTo !== null) {
    const adopted = await adoptUnattributedClaim(
      storage.engine(),
      { entity_slug: input.entity_slug, source_id: effectiveSource, fact, written_by: writtenBy, attributed_to: attributedTo },
      chunkId,
    );
    if (adopted !== null) {
      await refreshClaim(storage.engine(), adopted, {
        confidence: input.confidence === undefined ? null : conf,
        validFrom,
      });
      return { id: adopted, entity_slug: input.entity_slug, inserted: false };
    }
  }

  // Insert-time dedup / supersede (opt-in). Embed the new fact, fetch its
  // entity-prefiltered nearest neighbours, and classify. A "duplicate" collapses
  // (return the matched id, inserted:false); a "supersede" tombstones the old
  // fact after the new one lands. Falls-open: an embed failure skips the whole
  // path and the fact inserts as usual.
  let supersededId: number | null = null;
  let embeddingJson: string | null = null;
  const dedup = resolveDedup(input);
  if (dedup) {
    let vec: number[] | null = null;
    try {
      vec = await dedup.embed(fact);
    } catch {
      vec = null;
    }
    if (vec && vec.length > 0) {
      embeddingJson = JSON.stringify(vec);
      const candidates = await fetchDedupCandidates(
        storage,
        input.entity_slug,
        embeddingJson,
        effectiveSource,
        dedup.candidateLimit,
        attributedTo,
      );
      const verdict = await classifyFact({ fact, kind }, candidates, {
        ...(dedup.llmFn ? { llmFn: dedup.llmFn } : {}),
        ...(dedup.budget ? { budget: dedup.budget } : {}),
        ...(dedup.modelId ? { modelId: dedup.modelId } : {}),
        cheapThreshold: dedup.cheapThreshold,
        fallbackThreshold: dedup.fallbackThreshold,
      });
      if (verdict.decision === "duplicate") {
        return {
          id: verdict.matchedId,
          entity_slug: input.entity_slug,
          inserted: false,
        };
      }
      if (verdict.decision === "supersede") supersededId = verdict.supersededId;
    }
  }

  // Build the INSERT dynamically: the always-present columns plus whichever of
  // notability / source_id / embedding are set. `embedding` needs a
  // ::vector cast; the rest are plain placeholders.
  const cols = [
    "entity_slug",
    "fact",
    "confidence",
    "source_slug",
    "source_chunk_id",
    "written_by",
    "kind",
  ];
  const params: unknown[] = [
    input.entity_slug,
    fact,
    conf,
    sourceSlug,
    chunkId,
    writtenBy,
    kind,
  ];
  if (notability !== null) {
    cols.push("notability");
    params.push(notability);
  }
  if (validFrom !== null) {
    cols.push("valid_from");
    params.push(validFrom);
  }
  if (claimMetric !== null) {
    cols.push("claim_metric");
    params.push(claimMetric);
  }
  if (claimValue !== null) {
    cols.push("claim_value");
    params.push(claimValue);
  }
  if (claimUnit !== null) {
    cols.push("claim_unit");
    params.push(claimUnit);
  }
  if (claimPeriod !== null) {
    cols.push("claim_period");
    params.push(claimPeriod);
  }
  if (eventType !== null) {
    cols.push("event_type");
    params.push(eventType);
  }
  if (visibility !== null) {
    cols.push("visibility");
    params.push(visibility);
  }
  if (factContext !== null) {
    cols.push("context");
    params.push(factContext);
  }
  if (sourceSession !== null) {
    cols.push("source_session");
    params.push(sourceSession);
  }
  if (attributedTo !== null) {
    cols.push("attributed_to");
    params.push(attributedTo);
  }
  if (sourceId !== null) {
    cols.push("source_id");
    params.push(sourceId);
  }
  if (embeddingJson !== null) {
    cols.push("embedding");
    params.push(embeddingJson);
  }
  const placeholders = cols.map((c, i) =>
    c === "embedding" ? `$${i + 1}::vector` : `$${i + 1}`,
  );
  // Chunk-sourced facts keep the exact-tuple idempotency guard; manual facts
  // (NULL chunk) always insert.
  const conflict =
    chunkId !== null
      ? `ON CONFLICT (entity_slug, fact, source_chunk_id, (COALESCE(attributed_to, '')))
           WHERE source_chunk_id IS NOT NULL
           DO NOTHING`
      : "";
  // The ledger check above ran before the paid window, unlocked; a forget can
  // commit while the embed/classify call is in flight. Recheck under the same
  // shared lock the insert trigger takes, so either this sees the committed
  // withdrawal and writes nothing, or the forget's post-lock sweep sees this row.
  //
  // The insert and its two corrections commit together: a crash between them
  // would otherwise leave a superseded claim live beside its replacement, or the
  // corrected date lost while the row it belongs to stayed. Retried on a
  // deadlock, because the tombstone waits on an existing row's lock while this
  // transaction holds the withdraw lock shared.
  const landed = await deadlockSafeTransaction(storage.engine(), async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock_shared(hashtext($1))", [
      withdrawLockKey(effectiveSource),
    ]);
    if (
      await isClaimWithdrawn(tx, {
        source_id: effectiveSource,
        visibility: visibility ?? "private",
        entity_slug: input.entity_slug,
        fact,
      })
    ) {
      return null;
    }
    const r = await tx.query<{ id: number }>(
      `INSERT INTO entity_facts (${cols.join(", ")})
       VALUES (${placeholders.join(", ")})
       ${conflict}
       RETURNING id`,
      params,
    );
    const newId = toFactIdOrNull(r.rows[0]?.id);
    const inserted = chunkId === null ? true : r.rows.length > 0;

    // A re-emitted chunk fact collapses onto the row already on file, so a
    // CORRECTED validity date would otherwise never land — exactly the backfill
    // `valid_from` exists for. The identity stays (entity, fact, chunk): it is
    // the same claim, only its anchor moved, and widening the key would spawn a
    // second row per correction instead. Two rules keep the re-run honest: an
    // omitted date means "no opinion", never "erase the one on file", and an
    // unchanged date touches nothing.
    if (!inserted && validFrom !== null) {
      await tx.query(
        `UPDATE entity_facts
            SET valid_from = $4::date
          WHERE entity_slug = $1 AND fact = $2 AND source_chunk_id = $3
            AND attributed_to IS NOT DISTINCT FROM $5::text
            AND valid_from IS DISTINCT FROM $4::date`,
        [input.entity_slug, fact, chunkId, validFrom, attributedTo],
      );
    }

    // Retire the superseded fact only once the replacement actually landed. The
    // tombstone reuses the mig043 forget columns plus the mig085 `superseded_by`
    // pointer (so chains are SQL-traversable), and — paired with the reconcile
    // tombstone-preservation — survives a fence rebuild rather than resurrecting.
    if (inserted && supersededId !== null && newId !== null) {
      await tx.query(
        `UPDATE entity_facts
            SET forgotten_at = NOW(), forgotten_reason = $2,
                forgotten_cause = 'supersede', superseded_by = $3
          WHERE id = $1 AND forgotten_at IS NULL`,
        [supersededId, `superseded by fact ${newId}`, newId],
      );
    }
    return { id: newId, inserted };
  });
  if (landed === null) {
    return {
      id: null,
      entity_slug: input.entity_slug,
      inserted: false,
      withdrawn: true,
    };
  }
  return { id: landed.id, entity_slug: input.entity_slug, inserted: landed.inserted };
}

/**
 * Fold a restatement into the claim already on file. `written_at` always moves:
 * the claim WAS asserted again just now, and it is the anchor decay ages from —
 * leaving it would let a claim the operator keeps restating rot as though it had
 * been said once, a year ago. Confidence and `valid_from` move only when the
 * caller stated one, so an omitted field never overwrites what is on file with
 * an `addFact` default. Everything else — provenance, kind, notability,
 * visibility — stays as first recorded: this is the same claim, and the row on
 * file is the ledger's account of it.
 */
async function refreshClaim(
  q: Queryable,
  id: number,
  patch: { confidence: number | null; validFrom: string | null },
): Promise<void> {
  await q.query(
    `UPDATE entity_facts
        SET written_at = NOW(),
            confidence = COALESCE($2::real, confidence),
            valid_from = COALESCE($3::date, valid_from)
      WHERE id = $1`,
    [id, patch.confidence, patch.validFrom],
  );
}

export interface ListFactsOptions {
  /** ISO timestamp lower bound on written_at. */
  since?: string | Date;
  /** Filter to a single source page. */
  source_slug?: string;
  /** Sort by confidence DESC (default) or written_at DESC. */
  order?: "confidence" | "recency";
  /**
   * A pre-embedded query vector (1024-dim). When present, facts are ranked by
   * cosine similarity to it (migration 038) — embedded facts first, ordered by
   * distance, then unembedded facts by the normal confidence order. Overrides
   * `order`. The caller embeds the query (entityRecall does, falls-open).
   */
  queryVector?: number[];
  limit?: number;
  /**
   * Apply confidence decay (migration 037 `kind`/`valid_until` consumer):
   * facts past `valid_until` are dropped and the rest are re-ranked by
   * `effectiveConfidence` (older facts of a short-lived kind sink). Deterministic
   * and LLM-free. Ignored when `queryVector` is set (semantic order wins) and
   * for `order: "recency"`. Default OFF; `entityRecall` defaults it from
   * `MEMRAIN_FACT_DECAY`.
   */
  decay?: boolean;
  /**
   * Tenant source scope (migration 047). When a list is given, facts are
   * filtered to `source_id = ANY(...)`; `[]` matches nothing. Omitted ->
   * unscoped (whole-brain), preserving current behavior.
   */
  sourceIds?: string[];
  /**
   * Include tombstoned rows (mig043 `forgotten_at IS NOT NULL`). Default
   * false — the mig043 contract: a forgotten fact is invisible to recall.
   */
  include_forgotten?: boolean;
  /** Filter to facts captured under this session id (mig085). */
  session?: string;
  /** Case-insensitive substring filter on the fact text. */
  grep?: string;
  /**
   * Visibility gate (mig085). When a non-empty list is given, only facts
   * whose visibility is in it are returned (a remote reader passes
   * ['world']). Omitted/empty -> all visibilities (operator view).
   */
  visibility?: string[];
}

/** When decay re-ranks in TS we fetch a wide candidate set first, then trim. */
const DECAY_FETCH_CAP = 1000;

function normaliseSince(v: string | Date): string {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new Error("since: invalid Date");
    return v.toISOString();
  }
  if (typeof v !== "string" || v.length === 0) {
    throw new Error("since must be a non-empty ISO string or Date");
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    // The value arrived with the right type and failed to PARSE; a caller
    // discriminating on TypeError would then treat bad data as a programming
    // mistake.
    // eslint-disable-next-line unicorn/prefer-type-error
    throw new Error(`since: cannot parse ${JSON.stringify(v)}`);
  }
  return d.toISOString();
}

export async function listFacts(
  storage: Storage,
  entitySlug: string | null | undefined,
  opts: ListFactsOptions = {},
): Promise<FactRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  // entity_slug is OPTIONAL: omit it for a cross-entity "what did I learn"
  // recall (an entity-less filtered recall). The visibility floor
  // + source scoping applied by the caller still gate an entity-less scan.
  if (entitySlug !== null && entitySlug !== undefined && entitySlug !== "") {
    validateSlug(entitySlug);
    params.push(entitySlug);
    where.push(`entity_slug = $${params.length}`);
  }
  if (opts.since !== undefined) {
    // `since` is a record-time predicate (written_at), independent of decay's
    // validity-time anchoring (valid_from): "facts recorded since X, then
    // decay-ranked". A fact recorded before `since` is intentionally excluded
    // even if its valid_from is recent -- the two filters compose by design.
    params.push(normaliseSince(opts.since));
    where.push(`written_at >= $${params.length}::timestamptz`);
  }
  if (opts.source_slug !== undefined) {
    validateSlug(opts.source_slug);
    params.push(opts.source_slug);
    where.push(`source_slug = $${params.length}`);
  }
  if (opts.sourceIds !== undefined) {
    params.push(opts.sourceIds);
    where.push(`source_id = ANY($${params.length}::text[])`);
  }
  // Tombstones are invisible by default (the mig043 contract); the audit
  // surfaces opt in explicitly.
  if (opts.include_forgotten !== true) {
    where.push("forgotten_at IS NULL");
  }
  // Dimensional ontology rows (mig097) are read through getOntology, not the
  // free-text fact list — keep them out of every recall/list result.
  where.push("dimension IS NULL");
  if (typeof opts.session === "string" && opts.session.length > 0) {
    params.push(opts.session);
    where.push(`source_session = $${params.length}`);
  }
  if (typeof opts.grep === "string" && opts.grep.length > 0) {
    // Literal substring, not a pattern: escape LIKE metacharacters.
    params.push(`%${opts.grep.replace(/[\\%_]/g, "\\$&")}%`);
    where.push(`fact ILIKE $${params.length} ESCAPE '\\'`);
  }
  if (opts.visibility && opts.visibility.length > 0) {
    params.push(opts.visibility);
    where.push(`visibility = ANY($${params.length}::text[])`);
  }
  const hasQueryVector = !!(opts.queryVector && opts.queryVector.length > 0);
  // Decay re-ranks in TS, so it only applies to the plain confidence path:
  // a semantic query (cosine) or an explicit recency sort take precedence.
  // When `decay` is unset the global `MEMRAIN_FACT_DECAY` flag governs, so every
  // fact-reading surface (entity_facts + entity_recall) honors it uniformly.
  const decay = opts.decay ?? factDecayEnabled();
  const wantDecay = decay && !hasQueryVector && opts.order !== "recency";

  // When decaying, drop rows that are definitely past their `valid_until` at the
  // SQL layer so they do not consume slots in the `DECAY_FETCH_CAP` candidate
  // window (a ledger full of expired rows could otherwise crowd out fresh facts,
  // returning too few). The bound is `>= CURRENT_DATE` (keep today + future):
  // `rankByDecay` makes the exact, timezone-correct expiry call in TS, and this
  // SQL bound is conservative enough that it never drops a row TS would keep,
  // regardless of session timezone.
  if (wantDecay) {
    where.push("(valid_until IS NULL OR valid_until >= CURRENT_DATE)");
  }

  // Semantic order when a query vector is supplied: rank by cosine distance,
  // embedded facts first (NULL distance sorts last), then the normal tiebreak.
  // Every ordering ends in `id DESC`: written_at is only millisecond-resolution
  // (DEFAULT NOW()), so facts written in the same millisecond tie and the row
  // order would otherwise be whatever the scan happens to produce.
  let order: string;
  if (hasQueryVector) {
    params.push(JSON.stringify(opts.queryVector));
    order = `embedding <=> $${params.length}::vector ASC NULLS LAST, confidence DESC, written_at DESC, id DESC`;
  } else {
    order =
      opts.order === "recency"
        ? "written_at DESC, id DESC"
        : "confidence DESC, written_at DESC, id DESC";
  }
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 1000
      ? Math.floor(opts.limit)
      : 100;
  // When decaying, fetch a wide candidate set (confidence-DESC, expired rows
  // already filtered above) then re-rank + trim in TS so the true top-N by
  // effective confidence is returned. A per-entity ledger is small, so the cap
  // is not a correctness risk in practice; the documented residual is an entity
  // with more than DECAY_FETCH_CAP live facts, where a fresh low-confidence fact
  // below the confidence-DESC window could be missed.
  const sqlLimit = wantDecay ? DECAY_FETCH_CAP : limit;
  params.push(sqlLimit);
  const r = await storage.engine().query<FactRow>(
    `SELECT id, entity_slug, fact, confidence,
            source_slug, source_chunk_id, written_by,
            written_at::text AS written_at,
            kind, notability,
            valid_from::text  AS valid_from,
            valid_until::text AS valid_until,
            visibility, superseded_by, consolidated_into,
            context, source_session, attributed_to,
            forgotten_at::text AS forgotten_at
       FROM entity_facts
       WHERE ${where.length > 0 ? where.join(" AND ") : "1=1"}
       ORDER BY ${order}
       LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows.map(normalizeFactRow);
  if (!wantDecay) return rows;
  return rankByDecay(rows, limit);
}

/**
 * Re-rank a fetched fact set by `effectiveConfidence`: drop facts that have
 * decayed to 0 (expired / past `valid_until`), sort by effective confidence
 * DESC with the same `confidence`/`written_at` tiebreak as the SQL path, then
 * trim to `limit`. A single `now` is captured so all rows decay against one
 * clock.
 */
function rankByDecay(rows: FactRow[], limit: number): FactRow[] {
  const now = new Date();
  const scored: { row: FactRow; eff: number }[] = [];
  for (const row of rows) {
    const eff = effectiveConfidence(row, now);
    if (eff > 0) scored.push({ row, eff });
  }
  scored.sort((a, b) => {
    if (b.eff !== a.eff) return b.eff - a.eff;
    if (b.row.confidence !== a.row.confidence) {
      return b.row.confidence - a.row.confidence;
    }
    return b.row.written_at.localeCompare(a.row.written_at);
  });
  return scored.slice(0, limit).map((s) => s.row);
}

// ---------------------------------------------------------------------------
// Lifecycle read surface (mig085 consumers) — supersession audit + the
// pending-consolidation count.
// ---------------------------------------------------------------------------

export interface ListSupersessionsOptions {
  /** Confine to one entity's ledger. Omitted -> brain/scope-wide. */
  entity_slug?: string;
  /** ISO lower bound on the retirement time (`forgotten_at`). */
  since?: string | Date;
  limit?: number;
  /** Tenant source scope (mig047). Omitted -> unscoped; `[]` -> nothing. */
  sourceIds?: string[];
}

/**
 * Supersession audit log: facts that were retired WITH a replacement pointer
 * (`forgotten_at` + `superseded_by` both set), newest retirement first.
 * Each row is the RETIRED fact; `superseded_by` points at its replacement.
 */
export async function listSupersessions(
  storage: Storage,
  opts: ListSupersessionsOptions = {},
): Promise<FactRow[]> {
  const params: unknown[] = [];
  const where: string[] = [
    "forgotten_at IS NOT NULL",
    "superseded_by IS NOT NULL",
    // Dimensional ontology rows have their own read path, not the fact audit.
    "dimension IS NULL",
  ];
  if (opts.entity_slug !== undefined) {
    validateSlug(opts.entity_slug);
    params.push(opts.entity_slug);
    where.push(`entity_slug = $${params.length}`);
  }
  if (opts.since !== undefined) {
    params.push(normaliseSince(opts.since));
    where.push(`forgotten_at >= $${params.length}::timestamptz`);
  }
  if (opts.sourceIds !== undefined) {
    params.push(opts.sourceIds);
    where.push(`source_id = ANY($${params.length}::text[])`);
  }
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 1000
      ? Math.floor(opts.limit)
      : 50;
  params.push(limit);
  const r = await storage.engine().query<FactRow>(
    `SELECT id, entity_slug, fact, confidence,
            source_slug, source_chunk_id, written_by,
            written_at::text AS written_at,
            kind, notability,
            valid_from::text  AS valid_from,
            valid_until::text AS valid_until,
            visibility, superseded_by, consolidated_into,
            context, source_session, attributed_to,
            forgotten_at::text AS forgotten_at
       FROM entity_facts
       WHERE ${where.join(" AND ")}
       ORDER BY forgotten_at DESC
       LIMIT $${params.length}`,
    params,
  );
  return r.rows.map(normalizeFactRow);
}

/**
 * Count live facts not yet folded into a consolidated take by the
 * consolidate-facts cycle phase (mig061 `consolidated = false`). Drives the
 * recall `include_pending` piggy-back.
 */
export async function countUnconsolidatedFacts(
  storage: Storage,
  sourceIds?: string[],
): Promise<number> {
  const params: unknown[] = [];
  const scopeFilter = andSourceScope("source_id", sourceIds, params);
  const r = await storage.engine().query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM entity_facts
      WHERE consolidated = false AND forgotten_at IS NULL
        AND dimension IS NULL${scopeFilter}`,
    params,
  );
  return r.rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// entityRecall — the combined "what do I know about X?" answer.
// ---------------------------------------------------------------------------

/** Max chars of `query` embedded for semantic focus (a topic, not a document). */
const MAX_QUERY_LEN = 512;

export interface EntityRecallOptions {
  fact_limit?: number;
  timeline_limit?: number;
  redact_body?: boolean;
  /**
   * Optional topic to focus the recalled facts on. When set, the entity's
   * facts are ranked by semantic similarity to it (migration 038) instead of by
   * confidence. Falls-open: if embedding the query fails (Bedrock down), recall
   * silently reverts to the confidence order.
   */
  query?: string;
  /** Injectable embedder (tests). Defaults to the Bedrock Titan path. */
  embed?: (text: string) => Promise<number[]>;
  /**
   * Apply confidence decay to the recalled facts (mig037 consumer). When
   * undefined, defaults to the `MEMRAIN_FACT_DECAY` env flag. Ignored when
   * `query` (semantic focus) is supplied.
   */
  decay?: boolean;
  /**
   * Tenant source scope (migration 047). Threaded to both the facts and
   * timeline reads. Omitted -> unscoped (whole-brain); `[]` -> nothing.
   */
  sourceIds?: string[];
  /**
   * Visibility gate (mig085), threaded to the facts read exactly as
   * `listFacts` applies it: a non-empty list keeps only facts whose visibility
   * is in it. Recall used to have NO way to express this, so the mig085 floor
   * `entity_facts` enforces was silently bypassed by the aggregator over the
   * same ledger. Omitted/empty -> all visibilities (operator view).
   */
  visibility?: string[];
  /**
   * Piggy-back the scope's pending-consolidation count on the response (one
   * round trip, the `recall --pending` surface). Best-effort: a count
   * failure leaves the field undefined rather than failing the recall.
   */
  include_pending?: boolean;
}

export interface EntityRecallResult {
  slug: string;
  /** null when the entity has no page row yet (soft-stub case). */
  page: PageRow | null;
  facts: FactRow[];
  timeline: TimelineEventRow[];
  /** Present only when `include_pending` was requested AND the count worked. */
  pending_consolidation_count?: number;
}

/**
 * One-shot recall: the page row (compiled_truth, body) plus top-N
 * highest-confidence facts plus most-recent-N timeline events. The
 * page may be null — facts and timeline can attach to entities that
 * have not yet been promoted into `pages`.
 *
 * `redact_body: true` strips `markdown_body` from the page so the
 * caller (typically a public-bearer HTTP path) gets the agent-safe
 * shape.
 */
export async function entityRecall(
  storage: Storage,
  slug: string,
  opts: EntityRecallOptions = {},
): Promise<EntityRecallResult> {
  validateSlug(slug);
  const factLimit =
    typeof opts.fact_limit === "number" &&
    opts.fact_limit >= 1 &&
    opts.fact_limit <= 200
      ? Math.floor(opts.fact_limit)
      : 25;
  const timelineLimit =
    typeof opts.timeline_limit === "number" &&
    opts.timeline_limit >= 1 &&
    opts.timeline_limit <= 200
      ? Math.floor(opts.timeline_limit)
      : 25;
  // Falls-open semantic focus: embed the query topic; on any failure recall
  // reverts to the confidence order (queryVector stays undefined).
  let queryVector: number[] | undefined;
  if (typeof opts.query === "string" && opts.query.trim()) {
    const embed = opts.embed ?? ((t: string) => embedText(t));
    // Cap the embedded text to bound Bedrock cost/latency (a topic, not a doc).
    const q = opts.query.trim().slice(0, MAX_QUERY_LEN);
    try {
      queryVector = await embed(q);
    } catch {
      queryVector = undefined;
    }
  }
  const listOpts: ListFactsOptions = { limit: factLimit, order: "confidence" };
  if (queryVector) listOpts.queryVector = queryVector;
  // Decay applies only to the plain confidence path (not semantic focus).
  // Pass the caller's flag through (undefined -> listFacts defaults from env).
  else if (opts.decay !== undefined) listOpts.decay = opts.decay;
  if (opts.visibility && opts.visibility.length > 0)
    listOpts.visibility = opts.visibility;
  const scoped = opts.sourceIds;
  if (scoped !== undefined) listOpts.sourceIds = scoped;
  const [page, facts, timeline] = await Promise.all([
    getPage(storage, slug, scoped),
    listFacts(storage, slug, listOpts),
    getEntityTimeline(storage, slug, { limit: timelineLimit, sourceIds: scoped }),
  ]);
  let outPage = page;
  if (page && opts.redact_body) {
    const { markdown_body: _omit, ...rest } = page;
    outPage = rest as PageRow;
  }
  const out: EntityRecallResult = { slug, page: outPage, facts, timeline };
  if (opts.include_pending === true) {
    try {
      out.pending_consolidation_count = await countUnconsolidatedFacts(
        storage,
        scoped,
      );
    } catch (e) {
      // Best-effort: the recall payload still returns; an undefined field
      // tells the caller "couldn't ask" apart from "0 pending".
      console.warn(
        `entityRecall: countUnconsolidatedFacts failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  return out;
}
