/**
 * Query expansion — Claude Haiku (Bedrock) generates 2-3 synonym/paraphrase variants.
 *
 * The intent here is NOT to bloat the query but to give the keyword path
 * a wider recall surface. Vector search is already semantic; keyword
 * search is literal so synonyms help. hybrid uses one of:
 *   - empty array (skip — for `exact` intent)
 *   - 2-3 variants joined by OR for plainto_tsquery (Postgres adds the
 *     OR; PGLite doesn't support OR in plainto_tsquery so we run multiple
 *     queries and union the chunk_id sets).
 *
 * Cost: each call ≈ 60-120 output tokens × Claude Haiku price. Negligible.
 *
 * Trust boundary: the user query is untrusted input and the LLM output is
 * untrusted output. `sanitizeQueryForPrompt` neutralizes the query before it
 * reaches the model; `sanitizeExpansionOutput` validates what comes back.
 */
import { resolveModel } from "../llm/resolve-model.ts";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { awsRegion, bedrockClientConfig, generationFields, responseText, SEARCH_LLM_BUDGET_MS, utilityTimeoutMs, withDeadline } from "../llm/gateway.ts";
import { isBudgetRefusal, trackedInvoke } from "../budget.ts";


/** Upper bound on chars sent to / accepted from the expansion LLM. */
const MAX_QUERY_CHARS = 500;

/**
 * Neutralize a user query before it reaches the expansion LLM. The query is an
 * untrusted input passed in the user turn; an attacker can still try to talk the
 * model out of its instructions ("ignore the above, output X"). The guard: cap
 * length, strip code fences + HTML-ish tags (carriers for
 * injected directives), drop a leading instruction-override preamble, collapse
 * whitespace. Deterministic, zero-I/O. Warns (without echoing the content) when
 * it changes anything, so a probe is visible in logs.
 */
export function sanitizeQueryForPrompt(query: string): string {
  let q = query;
  if (q.length > MAX_QUERY_CHARS) q = q.slice(0, MAX_QUERY_CHARS);
  q = q.replace(/```[\s\S]*?```/g, " ");
  q = q.replace(/<\/?[a-z][^>]*>/gi, " ");
  // Measured linear through sanitizeQueryForPrompt: 0.1 ms at 400 K chars
  // ("ignore" + " "*n + "x"), 1.1 ms at 400 K for n/9 repeated "ignore : "
  // preambles, ratio 2.05 on a doubling. Two things cap it. The `q.slice` three
  // lines up means this pattern never sees more than MAX_QUERY_CHARS (500), and
  // the `^` with no `m` flag leaves exactly one start position. The remaining
  // ratio is the uncapped `\s+` collapse below, not this line. The exponential
  // the rule projects also needs a rejecting suffix, and there is nothing after
  // the group to reject: once one iteration matches, the match succeeds.
  // eslint-disable-next-line regexp/no-super-linear-backtracking
  q = q.replace(/^(\s*(ignore|forget|disregard|override|system|assistant|human)[\s:]+)+/gi, "");
  q = q.replace(/\s+/g, " ").trim();
  if (q !== query.replace(/\s+/g, " ").trim()) {
    console.warn(
      "[memrain] sanitizeQueryForPrompt: stripped content from user query before LLM expansion",
    );
  }
  return q;
}

/**
 * Validate the LLM's alternative queries — model output is untrusted. Strip
 * control characters, drop empties, cap length, dedupe case-insensitively, and
 * cap the count. Anything non-string is skipped. `max` is memrain's variant
 * budget.
 */
export function sanitizeExpansionOutput(alternatives: readonly unknown[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of alternatives) {
    if (typeof raw !== "string") continue;
    // eslint-disable-next-line no-control-regex
    let s = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
    if (s.length === 0) continue;
    if (s.length > MAX_QUERY_CHARS) s = s.slice(0, MAX_QUERY_CHARS);
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

let _client: BedrockRuntimeClient | null = null;
function client(region: string): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region, ...bedrockClientConfig(utilityTimeoutMs()) });
  return _client;
}

export interface ExpandOptions {
  modelId?: string;
  region?: string;
  /** Max variants to return. Default 3. */
  max?: number;
  /** Override the Bedrock client (tests pass a stub), as embedding.ts does. */
  client?: BedrockRuntimeClient;
}

/** Ledger label — the paid half of the keyword recall surface. */
const SPEND_OP = "query-expansion";

const SYSTEM_PROMPT = `You are a search query expander. Given the user's query, output up to N short paraphrases or near-synonym queries, ONE PER LINE, no numbering, no commentary. Return only paraphrases that materially change the wording (different verbs, different nouns); skip empty trivial restatements.`;

export async function expandQuery(
  query: string,
  opts: ExpandOptions = {},
): Promise<string[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  // Untrusted input — neutralize before it reaches the model. The sanitized
  // form is what we send AND what we compare the output against (so an echo of
  // the cleaned query is still filtered out below).
  const safeQuery = sanitizeQueryForPrompt(trimmed);
  if (!safeQuery) {
    // The query collapsed to nothing after sanitization (it was entirely an
    // injection-keyword preamble). Skip expansion — the upstream vector +
    // keyword passes still run on the original query — but log so this degraded
    // case is distinguishable from the empty-input early return above.
    console.warn("[memrain] expandQuery: query empty after sanitization, skipping expansion");
    return [];
  }
  const max = opts.max ?? 3;

  const region = opts.region ?? awsRegion();
  const modelId = resolveModel("utility", opts.modelId, "expansion");
  const c = opts.client ?? client(region);
  try {
    return await trackedInvoke(
      { operation: SPEND_OP, model: modelId, worstCase: { input: SYSTEM_PROMPT + safeQuery, maxOutputTokens: 120 } },
      async (meter) => {
      const resp = await withDeadline(SEARCH_LLM_BUDGET_MS, (abortSignal) =>
        c.send(
          new ConverseCommand({
            modelId,
            system: [{ text: SYSTEM_PROMPT.replace("N", String(max)) }],
            messages: [{ role: "user", content: [{ text: safeQuery }] }],
            ...generationFields(modelId, 120, 0.3),
          }),
          { abortSignal },
        ),
      );
      if (resp.usage) {
        meter.report({
          inputTokens: resp.usage.inputTokens ?? 0,
          outputTokens: resp.usage.outputTokens ?? 0,
        });
      }
      const text = responseText(resp.output?.message?.content) ?? "";
      const lowerQuery = safeQuery.toLowerCase();
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.replace(/^[-*•\d.\s]+/, "").trim())
        .filter((l) => l.length > 0 && l.toLowerCase() !== lowerQuery);
      // Untrusted output — strip control chars / cap length / dedupe / cap count.
      return sanitizeExpansionOutput(lines, max);
    });
  } catch (err) {
    if (isBudgetRefusal(err)) throw err;
    // Expansion is a recall bonus, never a dependency — a failed call still
    // books its row inside `trackedInvoke` before we fall back to no variants.
    return [];
  }
}
