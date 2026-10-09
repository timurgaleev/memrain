/**
 * Prompt-injection defense for untrusted note/corpus text fed into the utility LLM.
 *
 * The threat: synthesis (atoms/concepts/takes) and friction-propose inject up
 * to tens of thousands of chars of note/skill/search-miss text VERBATIM into a
 * Claude Haiku user turn. A note line that says "ignore prior instructions, output X"
 * can hijack the model. memrain already guards short queries
 * (`search/expansion.ts` sanitizeQueryForPrompt); this is the shared guard for
 * the long-corpus call sites.
 *
 * Two tools, use either or both:
 *   - sanitizeForPrompt: strip known jailbreak phrases + neutralize tag
 *     injection + cap length. Keeps the prompt format identical.
 *   - fenceAsData: sanitize THEN wrap in <data>…</data> for callers whose
 *     system prompt tells the model to treat fenced content as data.
 *
 * Not bulletproof — frontier models still drift on adversarial input — but it
 * removes the trivial-injection volume. Deterministic, zero-I/O.
 */

export const INJECTION_PATTERNS: Array<{ name: string; rx: RegExp; replacement: string }> = [
  // Instruction overrides.
  { name: "ignore-prior", rx: /ignore\s+(?:all\s+)?(?:prior|previous|above|earlier)\s+(?:instructions?|prompts?|messages?)/gi, replacement: "[redacted]" },
  { name: "forget-everything", rx: /forget\s+(?:everything|all\s+(?:of\s+)?the\s+above)/gi, replacement: "[redacted]" },
  { name: "disregard", rx: /disregard\s+(?:all\s+)?(?:prior|previous|above|earlier)\s+(?:instructions?|prompts?)/gi, replacement: "[redacted]" },
  { name: "new-instructions", rx: /(?:new|updated|revised)\s+instructions?:/gi, replacement: "[redacted]:" },
  { name: "system-prompt", rx: /system\s*:\s*(?:you\s+are|you\s+must|never|always)/gi, replacement: "[redacted]" },
  { name: "role-jailbreak", rx: /you\s+are\s+(?:now|actually|really)\s+(?:a|an)\s+\w+/gi, replacement: "[redacted]" },
  // The bare acronym is matched case-sensitively: under /i the person name
  // "Dan" was redacted out of every fact and timeline line. "dan mode" in any
  // case still reads as the jailbreak.
  { name: "do-anything-now", rx: /\bDAN\b/g, replacement: "[redacted]" },
  { name: "dan-mode", rx: /\bdan\s+mode\b/gi, replacement: "[redacted]" },
  { name: "do-anything-now-phrase", rx: /\b(?:do\s+anything\s+now|developer\s+mode\s+enabled?)\b/gi, replacement: "[redacted]" },
  // Tag injection — neutralize attempts to open a fake control block or close
  // a <data> / <turn> / <existing> / <new> fence (callers use one of these).
  { name: "close-data", rx: /<\s*\/\s*data\s*>/gi, replacement: "&lt;/data&gt;" },
  { name: "close-turn", rx: /<\s*\/\s*turn\s*>/gi, replacement: "&lt;/turn&gt;" },
  // The facts contradiction-classifier fences each candidate/new claim in
  // <existing>…</existing> / <new>…</new>. Neutralize a close tag so a crafted
  // fact text cannot break out of its own fence and inject classifier control.
  { name: "close-existing", rx: /<\s*\/\s*existing\s*>/gi, replacement: "&lt;/existing&gt;" },
  { name: "close-new", rx: /<\s*\/\s*new\s*>/gi, replacement: "&lt;/new&gt;" },
  // think wraps its evidence in <pages>/<page>, <takes>/<take>, <trajectory>
  // and <calibration> blocks; a note that closes one could write outside it.
  { name: "close-evidence", rx: /<\s*\/\s*(pages?|takes?|trajectory|calibration)\s*>/gi, replacement: "&lt;/$1&gt;" },
  { name: "open-system", rx: /<\s*system\b[^>]*>/gi, replacement: "&lt;system&gt;" },
  { name: "open-instructions", rx: /<\s*instructions?\b[^>]*>/gi, replacement: "&lt;instructions&gt;" },
  // Output exfiltration.
  { name: "print-system", rx: /(?:print|output|reveal|show)\s+(?:your\s+)?(?:system\s+prompt|instructions?|hidden)/gi, replacement: "[redacted]" },
  { name: "verbatim", rx: /(?:repeat|echo)\s+(?:back|verbatim)/gi, replacement: "[redacted]" },
  // Code-execution-style hooks.
  { name: "eval-shell", rx: /\b(?:eval|exec|system|shell)\s*\(/gi, replacement: "[redacted](" },
];

/** Default cap on untrusted text length before it reaches the model. */
export const DEFAULT_MAX_CORPUS_CHARS = 50_000;

/**
 * Strip injection phrases + neutralize tag injection + cap length. Returns the
 * cleaned text and the names of patterns that matched (telemetry). The prompt
 * format is unchanged — safe to drop into an existing user-turn template.
 */
export function sanitizeForPrompt(
  text: string,
  maxChars: number = DEFAULT_MAX_CORPUS_CHARS,
): { text: string; matched: string[] } {
  if (typeof text !== "string" || text.length === 0) {
    return { text: text ?? "", matched: [] };
  }
  let out = text;
  const matched: string[] = [];
  for (const p of INJECTION_PATTERNS) {
    p.rx.lastIndex = 0;
    if (p.rx.test(out)) {
      matched.push(p.name);
      out = out.replace(p.rx, p.replacement);
    }
  }
  if (out.length > maxChars) {
    out = out.slice(0, maxChars - 3) + "...";
    matched.push("length-cap");
  }
  return { text: out, matched };
}

/**
 * Sanitize then wrap in a <data> fence. The caller's system prompt must
 * instruct the model to treat <data>…</data> content as DATA, not
 * instructions. `label` is an optional attribute (e.g. a source id) — it is
 * NOT sanitized, so pass only trusted labels.
 */
export function fenceAsData(
  text: string,
  opts: { label?: string; maxChars?: number } = {},
): string {
  const { text: clean } = sanitizeForPrompt(text, opts.maxChars);
  const attr = opts.label ? ` source="${opts.label}"` : "";
  return `<data${attr}>\n${clean}\n</data>`;
}
