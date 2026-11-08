/**
 * `add_fact` with `items`: save several facts in one call.
 *
 * Additive to the single-fact contract — a call without `items` is unchanged.
 *
 *  - Every item is validated before any is written; one malformed item refuses
 *    the whole call and nothing lands.
 *  - Top-level `entity_slug`, `confidence`, `visibility`, `source_slug`,
 *    `source_chunk_id` and `written_by` are defaults an item may override
 *    (only the first three are settable per item).
 *  - Items are then written one at a time through the single-fact path. A
 *    write that fails is reported on its item and the rest still run, so the
 *    response says which items were saved (`partial: true` when some were not).
 */
import { OperationError } from "./operation-error.ts";
import { validateSlug } from "./pages.ts";
import { isCalendarDate } from "./effective-date.ts";
import type { AddFactInput } from "./facts.ts";
import type { EntityResolutionFeedback } from "./entity-resolve.ts";

export const FACT_METADATA_KEYS = ["valid_from", "kind", "notability", "claim_metric", "claim_value", "claim_unit", "claim_period"] as const;
type FactMetadata = Pick<AddFactInput, typeof FACT_METADATA_KEYS[number]>;

export function factInputMetadata(args: Record<string, unknown>): FactMetadata {
  for (const key of FACT_METADATA_KEYS) {
    const v = args[key];
    if (v === undefined) continue;
    if (key === "claim_value") {
      if (typeof v !== "number" || !Number.isFinite(v)) refuse("claim_value must be a finite number", "Pass a numeric value, without its unit.");
    } else if (typeof v !== "string") refuse(`${key} must be a string`, "Pass the field as a string, or omit it.");
    if (key === "kind" && !["event", "preference", "commitment", "belief", "fact"].includes(v as string)) refuse("invalid kind", "Use event, preference, commitment, belief or fact.");
    if (key === "notability" && !["high", "medium", "low"].includes(v as string)) refuse("invalid notability", "Use high, medium or low.");
    if (key === "valid_from" && (!isCalendarDate(v as string) || !Number.isFinite(Date.parse(v as string)))) {
      refuse("valid_from must be a real calendar date or ISO timestamp", "Use YYYY-MM-DD or an ISO timestamp; timestamps are anchored to their UTC date.");
    }
  }
  return Object.fromEntries(FACT_METADATA_KEYS.filter(k => args[k] !== undefined).map(k => [k, args[k]])) as FactMetadata;
}

export const ADD_FACT_BATCH_MAX = 20;

const ITEM_KEYS = new Set(["entity_slug", "fact", "confidence", "visibility", "replaces", ...FACT_METADATA_KEYS]);
const SHARED_KEYS = [
  "entity_slug",
  "confidence",
  "visibility",
  "source_slug",
  "source_chunk_id",
  "written_by",
  ...FACT_METADATA_KEYS,
] as const;
const VISIBILITIES = new Set(["private", "world"]);

const ITEM_SHAPE =
  "Each item is { fact, optional entity_slug, confidence, visibility, replaces, valid_from, kind, notability, claim_metric, claim_value, claim_unit, claim_period }; entity_slug and metadata may instead be given once at the top level.";

function refuse(message: string, suggestion: string): never {
  throw new OperationError("invalid_params", `add_fact: ${message}`, suggestion);
}

/**
 * Validate `args.items` and return one single-fact argument record per item,
 * with the top-level defaults folded in. Throws `invalid_params` naming the
 * first bad item; nothing has been written when it does.
 */
export function normalizeAddFactItems(args: Record<string, unknown>): Record<string, unknown>[] {
  const items = args["items"];
  if (!Array.isArray(items) || items.length < 1 || items.length > ADD_FACT_BATCH_MAX) {
    refuse(
      `\`items\` must be an array of 1 to ${ADD_FACT_BATCH_MAX} facts`,
      `Pass items: [{ "fact": "...", "entity_slug": "..." }, ...] with at most ${ADD_FACT_BATCH_MAX} entries.`,
    );
  }
  if (args["fact"] !== undefined) {
    refuse("pass either `fact` or `items`, not both", "Move the single fact into `items`, or drop `items`.");
  }
  if (args["replaces"] !== undefined) {
    refuse(
      "`replaces` names one fact, so it cannot apply to a whole batch",
      'Put `replaces` on the item it belongs to: items: [{ "fact": "...", "replaces": 123 }].',
    );
  }
  const shared: Record<string, unknown> = {};
  for (const key of SHARED_KEYS) if (args[key] !== undefined) shared[key] = args[key];

  return items.map((raw, index) => {
    const at = `items[${index}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      refuse(`${at} must be an object`, ITEM_SHAPE);
    }
    const item = raw as Record<string, unknown>;
    const extra = Object.keys(item).filter((k) => !ITEM_KEYS.has(k));
    if (extra.length > 0) {
      refuse(
        `${at} has ${extra.length} unknown field(s)`,
        `Allowed item fields: ${[...ITEM_KEYS].join(", ")}. Resend the whole batch.`,
      );
    }
    const merged: Record<string, unknown> = { ...shared, ...item };
    factInputMetadata(merged);
    const fact = merged["fact"];
    if (typeof fact !== "string" || fact.trim().length === 0) {
      refuse(`${at}.fact must be a non-empty string`, ITEM_SHAPE);
    }
    const entity = merged["entity_slug"];
    if (typeof entity !== "string" || entity.length === 0) {
      refuse(`${at} names no entity_slug`, ITEM_SHAPE);
    }
    try {
      validateSlug(entity);
    } catch {
      refuse(`${at}.entity_slug is not a valid slug`, "Use a lowercase path slug such as `people/alice`.");
    }
    const confidence = merged["confidence"];
    if (
      confidence !== undefined &&
      (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    ) {
      refuse(`${at}.confidence must be a number in [0, 1]`, ITEM_SHAPE);
    }
    const visibility = merged["visibility"];
    if (visibility !== undefined && !(typeof visibility === "string" && VISIBILITIES.has(visibility))) {
      refuse(`${at}.visibility must be one of: private, world`, ITEM_SHAPE);
    }
    const replaces = merged["replaces"];
    if (replaces !== undefined && !(Number.isSafeInteger(replaces) && (replaces as number) >= 1)) {
      refuse(`${at}.replaces must be a positive integer fact id`, ITEM_SHAPE);
    }
    return merged;
  });
}

export interface BatchItemOutcome extends EntityResolutionFeedback {
  index: number;
  id?: number | null;
  inserted?: boolean;
  withdrawn?: true;
  replaced?: boolean;
  replace_reason?: string;
  error?: { code: string; message: string };
}

export interface AddFactBatchResult {
  items: BatchItemOutcome[];
  saved: number;
  failed: number;
  partial: boolean;
}

/** The fields of a single-fact result a batch item reports. */
interface SingleOutcome extends EntityResolutionFeedback {
  id: number | null;
  inserted: boolean;
  withdrawn?: true;
  replaced?: boolean;
  replace_reason?: string;
}

/**
 * Write each normalized item through `writeOne`, in order. An item whose write
 * throws is reported as failed and the batch carries on; the items already
 * saved stay saved.
 */
export async function runAddFactBatch(
  items: Record<string, unknown>[],
  writeOne: (itemArgs: Record<string, unknown>) => Promise<SingleOutcome>,
): Promise<AddFactBatchResult> {
  const results: BatchItemOutcome[] = [];
  for (const [index, item] of items.entries()) {
    try {
      const r = await writeOne(item);
      results.push({
        index,
        id: r.id,
        inserted: r.inserted,
        ...(r.withdrawn ? { withdrawn: r.withdrawn } : {}),
        ...(r.replaced !== undefined ? { replaced: r.replaced } : {}),
        ...(r.replace_reason !== undefined ? { replace_reason: r.replace_reason } : {}),
        ...(r.entity_slug !== undefined ? { entity_slug: r.entity_slug } : {}),
        ...(r.entity_resolved_from !== undefined ? { entity_resolved_from: r.entity_resolved_from } : {}),
        ...(r.notice !== undefined ? { notice: r.notice, candidates: r.candidates } : {}),
      });
    } catch (e) {
      // Only an OperationError's message goes back to the caller; anything else
      // may carry driver or SQL text, so it is logged and reported plainly.
      if (e instanceof OperationError) {
        results.push({ index, error: { code: e.code, message: e.message } });
      } else {
        console.error(`[add_fact] items[${index}] failed:`, e instanceof Error ? e.message : e);
        results.push({ index, error: { code: "write_failed", message: "the write failed; resend this item" } });
      }
    }
  }
  const failed = results.filter((r) => r.error !== undefined).length;
  return {
    items: results,
    saved: results.length - failed,
    failed,
    partial: failed > 0 && failed < results.length,
  };
}
