/**
 * Fact slots, tagged after extraction. The main extraction call never asks for
 * a slot (asking costs wishes and preferences); this second, small call reads
 * only the facts whose entity is a live person page, of a kind that can state
 * a slot, and tags each with at most one slot (fact-slots.ts). A failed call
 * leaves the facts without slots.
 */
import type { SonnetFn, SonnetUsage } from "./llm/sonnet.ts";
import { STOP_REASON_MAX_TOKENS } from "./llm/sonnet.ts";
import { normalizeSlot, SLOT_DIMENSIONS } from "./fact-slots.ts";
import { parseModelJson } from "./llm/json-output.ts";

/** Kinds that can state where a person lives, who employs them or their role. */
export const SLOT_KINDS: ReadonlySet<string> = new Set(["fact", "event"]);
/** Characters of one fact the tagging call sees. */
export const SLOT_TAG_FACT_CHARS = 400;
export const SLOT_TAG_MAX_FACTS = 10;
export const SLOT_TAG_MAX_TOKENS = 400;

export const SLOT_TAG_SYSTEM = [
  "You tag facts about people with a slot when the fact states one: where the person lives (location), which",
  "organization employs them (employer), or their role or job title (role).",
  'Each input line is "<n>. [<person>] <fact>". Reply with JSON only:',
  `{"slots":[{"i":<n>,"dimension":"${[...SLOT_DIMENSIONS].join("|")}","value":"<the place, organization or title alone>"}]}`,
  "with one entry for each fact that states a slot for the bracketed person, and nothing for every other fact.",
  "- The value must belong to the bracketed person and be stated by the fact.",
  "- A fact saying the value changed (moved, joined, was promoted) carries the new value. A fact that only ends a value",
  '  ("left the company") or states a past one ("used to live in ...") has no slot.',
  "- No slot for plans, wishes, trips, visits or guesses.",
  "- At most one slot per fact.",
].join("\n");

/** The longest input one tagging call sends, for the budget's worst case. */
export const SLOT_TAG_INPUT_CHARS = SLOT_TAG_SYSTEM.length + SLOT_TAG_MAX_FACTS * (SLOT_TAG_FACT_CHARS + 120);
/** Worst-case usage of one tagging call, counting three characters a token to stay on the safe side. */
export const SLOT_TAG_WORST_CASE: SonnetUsage = { inputTokens: Math.ceil(SLOT_TAG_INPUT_CHARS / 3), outputTokens: SLOT_TAG_MAX_TOKENS };

export interface SlotCandidate { fact: string; person: string; entity_slug: string }

export interface SlotTagResult {
  /** One entry per candidate: its slot, or null. */
  slots: Array<{ dimension: string; value: string } | null>;
  failed: boolean;
  usage: SonnetUsage;
  modelId: string;
}

/**
 * One tagging call over at most SLOT_TAG_MAX_FACTS candidates. Throws only
 * what the model call throws; an unreadable or cut answer is `failed` with no
 * slots.
 */
export async function tagSlots(fn: SonnetFn, candidates: readonly SlotCandidate[]): Promise<SlotTagResult> {
  const batch = candidates.slice(0, SLOT_TAG_MAX_FACTS);
  const none = batch.map(() => null);
  const lines = batch.map((c, n) => `${n + 1}. [${c.person.replace(/[[\]\n]/g, " ").slice(0, 100)}] ${c.fact.replace(/\s+/g, " ").slice(0, SLOT_TAG_FACT_CHARS)}`);
  const resp = await fn({ system: SLOT_TAG_SYSTEM, user: lines.join("\n"), maxTokens: SLOT_TAG_MAX_TOKENS });
  const base = { usage: resp.usage, modelId: resp.modelId };
  if (resp.stopReason === STOP_REASON_MAX_TOKENS) return { slots: none, failed: true, ...base };
  const parsed = (parseModelJson(resp.text, "{") as { slots?: unknown } | undefined)?.slots;
  if (!Array.isArray(parsed)) return { slots: none, failed: true, ...base };
  const slots: SlotTagResult["slots"] = [...none];
  for (const s of parsed as Array<{ i?: unknown; dimension?: unknown; value?: unknown }>) {
    const i = typeof s?.i === "number" && Number.isInteger(s.i) ? s.i - 1 : -1;
    if (i < 0 || i >= batch.length || slots[i]) continue;
    slots[i] = normalizeSlot(s.dimension, s.value, batch[i]!.entity_slug);
  }
  return { slots, failed: false, ...base };
}
