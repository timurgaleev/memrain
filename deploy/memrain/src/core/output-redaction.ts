/**
 * Read-side secret redaction for tool results that return stored text.
 *
 * Writes are already scanned (secret-scan.ts), but text stored before a rule
 * existed, or under the `flag` disposition, still holds the credential. A
 * non-operator caller's retrieval result is therefore scanned again on the way
 * out: every string in the JSON payload goes through `scanSecrets`, sharing one
 * echo dictionary for the whole response so a value claimed in one hit is
 * also caught where another hit repeats it bare.
 *
 * Identity fields (ids, slugs, hashes, versions) are passed through verbatim:
 * a client keys follow-up calls on them, and a rewritten id is a broken
 * reference. The work is bounded whatever the response size: nesting deeper
 * than MAX_DEPTH, a string longer than MAX_FIELD_CHARS, and anything past
 * MAX_RESPONSE_CHARS scanned or MAX_FIELDS strings is replaced with
 * OUTPUT_LIMIT_MARKER instead of being returned unscanned.
 */
import {
  type EchoDictionary,
  scanSecrets,
  type SecretFinding,
  sweepEchoes,
  switchedOn,
} from "./secret-scan.ts";

export const OUTPUT_LIMIT_MARKER = "[REDACTED:output_limit]";
export const MAX_DEPTH = 24;
// A whole page body is one field, so the field cap matches the response cap:
// large bodies are scanned, not cut.
export const MAX_FIELD_CHARS = 2 * 1024 * 1024;
export const MAX_RESPONSE_CHARS = 2 * 1024 * 1024;
export const MAX_FIELDS = 8192;

const IDENTITY_KEYS: ReadonlySet<string> = new Set([
  "id",
  "slug",
  "source_id",
  "document_id",
  "chunk_id",
  "page_id",
  "take_key",
  "fact_id",
  "entity_slug",
  "fingerprint",
  "content_hash",
  "hash_prev",
  "hash_new",
  "version",
  "version_n",
  "job_id",
  "request_id",
  "plan_hash",
]);

/** Keys whose value is an identifier: the fixed list, plus `*_id(s)`, `*_slug(s)`, `*_hash`. */
export function isIdentityKey(key: string): boolean {
  return IDENTITY_KEYS.has(key) || /_(?:ids?|slugs?|hash)$/.test(key);
}

/** MEMRAIN_OUTPUT_REDACTION: on unless set to 0, false, off or no. */
export function outputRedactionEnabled(): boolean {
  return switchedOn("MEMRAIN_OUTPUT_REDACTION");
}

export interface RedactableResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

type Holder = Record<string, unknown> | unknown[];

class Redactor {
  readonly findings: SecretFinding[] = [];
  readonly echo: EchoDictionary = new Map();
  limited = 0;
  private chars = 0;
  private fields = 0;
  /** Scanned strings and the echo dictionary size when they were scanned. */
  private readonly slots: Array<{ holder: Holder; key: string | number; echoSize: number }> = [];

  constructor(
    private readonly allow: ReadonlySet<string>,
    private readonly highEntropy: boolean,
  ) {}

  private overBudget(text: string): boolean {
    return text.length > MAX_FIELD_CHARS || this.chars + text.length > MAX_RESPONSE_CHARS;
  }

  private scan(text: string): string {
    if (text.length === 0) return text;
    if (this.fields >= MAX_FIELDS || this.overBudget(text)) {
      this.limited++;
      return OUTPUT_LIMIT_MARKER;
    }
    this.fields++;
    this.chars += text.length;
    const r = scanSecrets(text, this.allow, { echo: this.echo, highEntropy: this.highEntropy });
    for (const f of r.findings) this.findings.push(f);
    return r.text;
  }

  private scanKey(key: string): string {
    if (this.overBudget(key)) {
      this.limited++;
      return OUTPUT_LIMIT_MARKER;
    }
    this.chars += key.length;
    const r = scanSecrets(key, this.allow, { echo: this.echo, highEntropy: this.highEntropy });
    for (const f of r.findings) this.findings.push(f);
    return r.text;
  }

  put(holder: Holder, key: string | number, v: unknown, depth: number, identity: boolean): void {
    const set = (value: unknown): void => {
      (holder as Record<string | number, unknown>)[key] = value;
    };
    if (typeof v === "string") {
      if (identity) return set(v);
      const out = this.scan(v);
      set(out);
      if (out !== OUTPUT_LIMIT_MARKER) this.slots.push({ holder, key, echoSize: this.echo.size });
      return;
    }
    if (v === null || typeof v !== "object") return set(v);
    if (identity && Array.isArray(v) && v.every((x) => x === null || typeof x !== "object")) return set(v);
    if (depth > MAX_DEPTH) {
      this.limited++;
      return set(OUTPUT_LIMIT_MARKER);
    }
    if (Array.isArray(v)) {
      const out: unknown[] = Array.from({ length: v.length });
      set(out);
      for (let i = 0; i < v.length; i++) this.put(out, i, v[i], depth + 1, false);
      return;
    }
    const out: Record<string, unknown> = {};
    set(out);
    for (const [k, inner] of Object.entries(v)) {
      this.put(out, this.scanKey(k), inner, depth + 1, isIdentityKey(k));
    }
  }

  /** Sweep the strings scanned before a later field added to the echo dictionary. */
  finishEchoes(): void {
    const finalSize = this.echo.size;
    if (finalSize === 0) return;
    for (const { holder, key, echoSize } of this.slots) {
      if (echoSize === finalSize) continue;
      const h = holder as Record<string | number, unknown>;
      h[key] = sweepEchoes(h[key] as string, this.echo, this.findings);
    }
  }
}

/**
 * Redact credentials from a successful tool result. `allow` holds the
 * fingerprint prefixes (MEMRAIN_SECRET_SCAN_ALLOW) to leave in place. Returns
 * `result` itself when nothing was found or cut; otherwise a copy whose JSON
 * payloads are re-serialized, an object payload gaining `redacted_secrets`.
 */
export function redactToolResult<T extends RedactableResult>(result: T, allow: ReadonlySet<string>): T {
  if (result.isError) return result;
  const redactor = new Redactor(allow, switchedOn("MEMRAIN_SECRET_SCAN_HIGH_ENTROPY"));
  const blocks = result.content.map((block) => {
    const wrapper: unknown[] = [];
    if (block.type !== "text") return { block, wrapper, json: false };
    let parsed: unknown;
    let json = true;
    try {
      parsed = JSON.parse(block.text);
    } catch {
      parsed = block.text;
      json = false;
    }
    redactor.put(wrapper, 0, parsed, 0, false);
    return { block, wrapper, json };
  });
  redactor.finishEchoes();
  const count = redactor.findings.length;
  if (count === 0 && redactor.limited === 0) return result;
  const content = blocks.map(({ block, wrapper, json }) => {
    if (block.type !== "text") return block;
    const value = wrapper[0];
    if (!json) return { ...block, text: value as string };
    const payload =
      count > 0 && value !== null && typeof value === "object" && !Array.isArray(value)
        ? { ...(value as Record<string, unknown>), redacted_secrets: count }
        : value;
    return { ...block, text: JSON.stringify(payload, null, 2) };
  });
  return { ...result, content };
}
