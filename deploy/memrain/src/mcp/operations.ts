/**
 * Single source of truth for the MCP tool surface.
 *
 * Each tool is declared once here as an `Operation` — a name, a description,
 * and a `params` map of `ParamDef`s. The JSON-Schema `inputSchema` that
 * `tool_defs.ts` exposes to MCP clients is DERIVED from this contract by
 * `operationInputSchema`, so the schema can never drift from the param
 * declarations (the previous failure mode: 25 hand-maintained inline schemas).
 *
 * `tests/tool_defs_contract.test.ts` pins the generated output against a
 * snapshot of the original hand-written defs, so this refactor is provably a
 * zero-behavior change.
 */

// Expressiveness floor (deliberate): a ParamDef can express
// type/description/minimum/maximum/enum, plus a literal `items` schema for an
// array. A tool that needs a JSON-Schema construct this can't carry (`default`, `pattern`,
// `format`, `oneOf`, nested `properties`) is the escape hatch — hand-write that
// tool's def in tool_defs.ts instead of routing it through the generator, so a
// constraint is never silently dropped expecting the generator to carry it.
import { OperationError } from "../core/operation-error.ts";
import { nearest } from "../core/did-you-mean.ts";

export type ParamType = "string" | "integer" | "number" | "boolean" | "object" | "array";

export interface ParamDef {
  type: ParamType;
  description?: string;
  /** Inclusive lower bound (integer/number). */
  minimum?: number;
  /** Inclusive upper bound (integer/number). */
  maximum?: number;
  /** Allowed string values. */
  enum?: readonly string[];
  /** Listed in the schema's `required` array when true. */
  required?: boolean;
  /**
   * JSON Schema of an array's elements, emitted verbatim. Advertised only:
   * validateParams checks the array itself, and the handler checks each
   * element.
   */
  items?: Readonly<Record<string, unknown>>;
}

export interface Operation {
  name: string;
  callShape?: string;
  description: string;
  /**
   * Authorization scope, co-located with the op. A `"write"` op needs a write
   * source grant (public callers without one are denied); an `"admin"` op needs
   * the admin scope; an `"agent"` op needs the standalone agent scope; default
   * `"read"`. The scope hierarchy lives in
   * core/scope.ts. `WRITE_SCOPED_TOOLS` is DERIVED from this field (see
   * below) so the write set has a single source of truth on the op itself, not
   * a parallel hand-kept list.
   */
  scope?: "read" | "write" | "admin" | "agent";
  /**
   * `"retrieval"`: the result carries stored text, so a non-operator caller's
   * copy is scanned for credentials on the way out (core/output-redaction.ts).
   * Every read op carries it unless it returns only counts, names and config.
   */
  outputRedaction?: "retrieval";
  /** Declaration order is preserved into `properties` + `required`. */
  params: Record<string, ParamDef>;
  /**
   * Names agents reach for that are not this op's arguments, each mapped to
   * the declared one it meant (or `{ hint }` when nothing maps). Used only to
   * word the unknown-argument error: the call is still refused, never remapped.
   */
  argAliases?: Readonly<Record<string, string | { hint: string }>>;
}

/** Build a single JSON-Schema property object from a ParamDef. */
export function paramDefToSchema(def: ParamDef): Record<string, unknown> {
  const out: Record<string, unknown> = { type: def.type };
  if (def.minimum !== undefined) out.minimum = def.minimum;
  if (def.maximum !== undefined) out.maximum = def.maximum;
  if (def.enum !== undefined) out.enum = [...def.enum];
  if (def.items !== undefined) out.items = structuredClone(def.items);
  if (def.description !== undefined) out.description = def.description;
  return out;
}

/** Build the full `inputSchema` (draft-7 object schema) for an operation. */
export function operationInputSchema(op: Operation): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, def] of Object.entries(op.params)) {
    properties[key] = paramDefToSchema(def);
    if (def.required) required.push(key);
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  schema.additionalProperties = false;
  return schema;
}

/**
 * Enforce the declared param contract for one operation: a PRESENT param must
 * match its declared type, enum membership, and numeric bounds. Throws
 * `OperationError('invalid_params')` so the dispatch catch renders the
 * structured envelope.
 *
 * Scope decisions:
 *   - A required param that is absent, null or "" is refused here, with the
 *     op's argument list in the suggestion. The per-handler guards stay as the
 *     fallback for callers that bypass the contract; whitespace-only values are
 *     still theirs to judge, since several tools accept them.
 *   - Unknown params ARE rejected, with a did-you-mean hint: a misspelled key
 *     (`page_put {body}` for `markdown_body`) used to be dropped silently and
 *     the write went ahead without it. `MEMRAIN_MCP_LENIENT_ARGS=1` restores the
 *     old accept-and-ignore behavior for a client that cannot be fixed yet.
 *
 * Safe to enforce uniformly: the MCP client derives its params FROM this same
 * contract (the ParamDefs generate the advertised inputSchema), so a
 * well-formed call can never be rejected here — only a malformed one, which the
 * handler would have rejected anyway. Catches the constraints the schema
 * already advertises but individual handlers may not all check by hand.
 */
export function validateParams(
  op: Operation,
  params: Record<string, unknown>,
): void {
  rejectUnknownParams(op, params);
  rejectMissingRequired(op, params);
  const fail = (key: string, reason: string, suggestion: string): never => {
    throw new OperationError(
      "invalid_params",
      `${op.name}: \`${key}\` ${reason}`,
      suggestion,
    );
  };
  for (const [key, def] of Object.entries(op.params)) {
    const v = params[key];
    // Skip ONLY absent params (required presence is checked above). A present `null`
    // is NOT skipped: the contract's declared types are non-nullable
    // (paramDefToSchema emits a bare `type`, never `["t","null"]`), so an
    // explicit null is a malformed value and must fail the type check below
    // rather than slip through to a handler's `?? default`.
    if (v === undefined) continue;

    switch (def.type) {
      case "integer":
        if (typeof v !== "number" || !Number.isInteger(v)) {
          fail(key, "must be an integer", `Pass \`${key}\` as a whole number.`);
        }
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) {
          fail(key, "must be a finite number", `Pass \`${key}\` as a number.`);
        }
        break;
      case "boolean":
        if (typeof v !== "boolean") {
          fail(key, "must be a boolean", `Pass \`${key}\` as true or false.`);
        }
        break;
      case "string":
        if (typeof v !== "string") {
          fail(key, "must be a string", `Pass \`${key}\` as a string.`);
        }
        break;
      case "object":
        // typeof null === "object", so null must be rejected explicitly; an
        // array is an object too but not a valid JSON object value here.
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          fail(key, "must be an object", `Pass \`${key}\` as a JSON object.`);
        }
        break;
      case "array":
        if (!Array.isArray(v)) {
          fail(key, "must be an array", `Pass \`${key}\` as a JSON array.`);
        }
        break;
    }

    if (def.enum && !(typeof v === "string" && def.enum.includes(v))) {
      fail(
        key,
        `must be one of: ${def.enum.join(", ")}`,
        `Pass \`${key}\` as one of: ${def.enum.join(", ")}.`,
      );
    }
    if (
      (def.type === "integer" || def.type === "number") &&
      typeof v === "number"
    ) {
      if (def.minimum !== undefined && v < def.minimum) {
        fail(key, `must be >= ${def.minimum}`, `Pass \`${key}\` >= ${def.minimum}.`);
      }
      if (def.maximum !== undefined && v > def.maximum) {
        fail(key, `must be <= ${def.maximum}`, `Pass \`${key}\` <= ${def.maximum}.`);
      }
    }
  }
}

/** Empty optional read filters mean omission; writes retain their exact values. */
export function normalizeOptionalArgs(op: Operation, params: Record<string, unknown>): Record<string, unknown> {
  if (!operationAnnotations(op).readOnlyHint) return params;
  return Object.fromEntries(Object.entries(params).filter(([key, value]) => {
    const def = Object.hasOwn(op.params, key) ? op.params[key] : undefined;
    if (!def || def.required || key === "source_ids") return true;
    return !(value === null || value === "" || (Array.isArray(value) && value.length === 0) ||
      (value === 0 && def.minimum !== undefined && def.minimum >= 1));
  }));
}

/** One line per argument for a refusal's suggestion: first sentence of its description. */
const MAX_ARG_HINT_CHARS = 120;

function describeArg(key: string, def: ParamDef): string {
  const first = (def.description ?? "").split(/(?<=\.)\s/)[0]!.trim().replace(/\.$/, "");
  const hint = first.length > MAX_ARG_HINT_CHARS ? `${first.slice(0, MAX_ARG_HINT_CHARS)}…` : first;
  return hint ? `\`${key}\` (${def.type}): ${hint}` : `\`${key}\` (${def.type})`;
}

function rejectMissingRequired(op: Operation, params: Record<string, unknown>): void {
  const entries = Object.entries(op.params);
  const missing = entries
    .filter(([k, d]) => d.required && (params[k] === undefined || params[k] === null || params[k] === ""))
    .map(([k]) => `\`${k}\``);
  if (missing.length === 0) return;
  const required = entries.filter(([, d]) => d.required).map(([k, d]) => describeArg(k, d));
  const optional = entries.filter(([, d]) => !d.required).map(([k, d]) => describeArg(k, d));
  const suggestion = [
    `Required: ${required.join("; ")}.`,
    ...(op.callShape ? [`Call shape: ${op.callShape}`] : []),
    ...(optional.length > 0 ? [`Optional: ${optional.join("; ")}.`] : []),
  ].join(" ");
  throw new OperationError(
    "invalid_params",
    `${op.name}: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required`,
    suggestion,
  );
}

/** Caps on what an unknown-argument error echoes back from the payload. */
const MAX_UNKNOWN_REPORTED = 5;
const MAX_UNKNOWN_KEY_CHARS = 64;

function rejectUnknownParams(op: Operation, params: Record<string, unknown>): void {
  if (process.env.MEMRAIN_MCP_LENIENT_ARGS === "1") return;
  const declared = Object.keys(op.params);
  const unknown = Object.keys(params).filter((k) => !Object.hasOwn(op.params, k));
  if (unknown.length === 0) return;
  const named = unknown.slice(0, MAX_UNKNOWN_REPORTED).map((k) => {
    const shown = `\`${k.length > MAX_UNKNOWN_KEY_CHARS ? `${k.slice(0, MAX_UNKNOWN_KEY_CHARS)}…` : k}\``;
    const alias = op.argAliases && Object.hasOwn(op.argAliases, k) ? op.argAliases[k] : undefined;
    if (typeof alias === "object") return `${shown}: ${alias.hint}`;
    const hint = alias !== undefined && Object.hasOwn(op.params, alias) ? alias : nearest(k, declared);
    return hint ? `${shown}: did you mean \`${hint}\`?` : `${shown} is not an argument.`;
  });
  const more = unknown.length > MAX_UNKNOWN_REPORTED
    ? ` (+${unknown.length - MAX_UNKNOWN_REPORTED} more)`
    : "";
  const accepted = declared.length > 0
    ? `Accepted arguments: ${declared
      .map((k) => (op.params[k]!.required ? `\`${k}\` (required)` : `\`${k}\``))
      .join(", ")}.`
    : `${op.name} takes no arguments.`;
  // The caller's key names go only into the suggestion: `message` is what the
  // request log persists, and it records just the count.
  throw new OperationError(
    "invalid_params",
    `${op.name}: ${unknown.length} unknown argument(s)`,
    `${named.join(" ")}${more} ${accepted}${op.callShape ? ` Call shape: ${op.callShape}` : ""}`,
  );
}

// --- helpers to keep the contract terse + matching the original defs --------
const str = (o: Omit<ParamDef, "type"> = {}): ParamDef => ({ type: "string", ...o });
const int = (o: Omit<ParamDef, "type"> = {}): ParamDef => ({ type: "integer", ...o });
const num = (o: Omit<ParamDef, "type"> = {}): ParamDef => ({ type: "number", ...o });
const bool = (o: Omit<ParamDef, "type"> = {}): ParamDef => ({ type: "boolean", ...o });
const obj = (o: Omit<ParamDef, "type"> = {}): ParamDef => ({ type: "object", ...o });
const arr = (o: Omit<ParamDef, "type"> = {}): ParamDef => ({ type: "array", ...o });
const req = { required: true } as const;
const takeWriteParams = {
  slug: str({ ...req, description: "Owning live page slug." }),
  expected_version: int({ ...req, minimum: 1, description: "Required current page version." }),
  dry_run: bool({ description: "Preview the bounded row diff without writes or model calls." }),
  plan_hash: str({ description: "Optional SHA-256 from the matching preview." }),
  reason: str({ description: "Optional version reason, up to 500 Unicode code points." }),
  wait_for_index: bool({ description: "Wait for the search mirror after applying." }),
};
const takeFields = {
  claim: str({ description: "Single-line claim, up to 4000 Unicode code points." }),
  kind: str({ enum: ["fact", "take", "bet", "hunch", "prediction", "judgment"] }),
  weight: num({ minimum: 0, maximum: 1 }),
  since: str({ description: "Start date, YYYY-MM-DD." }),
  until: str({ description: "End date, YYYY-MM-DD; requires since." }),
  source: str({ description: "Single-line citation, up to 4000 Unicode code points." }),
};

/** Upper bound on `request_id` length (checked by the dispatch handler). */
export const MAX_REQUEST_ID_LEN = 128;

const expectedVersionParam = int({
  minimum: 0,
  description:
    "Require this page_get version/page_versions version_n; 0 requires absence. Deleted pages retain versions: use current_version from a failed 0 attempt. Mismatch writes nothing and returns current_version. Omit for an unconditional write, subject to precondition policy.",
});
const forceParam = bool({
  description:
    "Overwrite unconditionally, on purpose. Cannot be combined with expected_version.",
});
const requestIdParam = str({
  description:
    `Optional retry id (1-${MAX_REQUEST_ID_LEN} chars), retained 7 days. Same id+arguments replays the first result (replayed:true), without writing; changed arguments are refused.`,
});

export const OPERATIONS: readonly Operation[] = [
  {
    name: "search_exact",
    outputRedaction: "retrieval",
    description: "Find literal substrings in live page bodies and compiled truth, without ranking or embeddings. Returns slug, title, source_id and one snippet per matching page. complete:true means every match was returned; false means limit or a 2-second timeout. scanned counts eligible pages examined (null on timeout). Scoped to your sources; excludes hidden pages. Internal-only.",
    params: {
      phrase: str({ ...req, description: "Literal phrase, 1 to 500 characters. %, _ and backslash have no special meaning." }),
      case_sensitive: bool(),
      slug_prefix: str(),
      type: str(),
      limit: int({ minimum: 1, maximum: 200, description: "Maximum matching pages; default 100." }),
    },
  },
  {
    name: "search",
    outputRedaction: "retrieval",
    description:
      "Ranked vector+keyword chunks, paths and titles. Language/symbol/date/type/slug-prefix filters precede limits and bypass cache. Broad concept/set questions can use query expand:true (paid, default-off); search has no expand. Hits are not exhaustive. meta exposes vectorEnabled/degraded; intent/mode/cache/counts are operator-only. Empty results include a recovery hint.",
    argAliases: { query: "q", limit: "k" },
    params: {
      source_ids: arr({ items: { type: "string" }, description: "Narrow to ≤100 exact source IDs in your grant. Omitted uses grant; [] reads nothing; any forbidden ID refuses the call." }),
      types: arr({ items: { type: "string" }, description: "Up to 20 lower-case page type names. Matches canonical live pages and their indexed mirrors/file twins; non-page documents are excluded. Empty means no type filter." }),
      slug_prefix: str({ description: "Literal canonical page slug prefix, e.g. projects/x/. No wildcards. Applied before retrieval limits." }),
      q: str({ ...req, description: "Natural-language query." }),
      k: int({ minimum: 1, maximum: 100, description: "Number of hits to return. Default 20." }),
      token_budget: int({
        minimum: 1,
        maximum: 200000,
        description:
          "Cap returned title + content (~chars/4 tokens), including trust frames. Keep whole hits in rank order; stop before the first that overflows. Omitted: mode default.",
      }),
      lang: str({
        description:
          "Filter to chunks of a source language (chunks.language, e.g. 'typescript', 'python'). Code chunks only.",
      }),
      symbol_kind: str({
        description:
          "Filter to chunks of a symbol kind (chunks.symbol_type, e.g. 'function', 'class', 'method').",
      }),
      since: str({
        description:
          "Keep only hits whose content date COALESCE(effective_date, updated_at) is >= this bound: an ISO-8601 date/datetime, or a relative duration like '7d' / '2w' / '6m' / '1y' (back from now).",
      }),
      until: str({
        description:
          "Upper bound on COALESCE(effective_date,updated_at): ISO date/time (YYYY-MM-DD includes the whole day), or duration back from now: 7d/2w/6m/1y.",
      }),
      near_symbol: str({
        description:
          "Anchor retrieval at this qualified symbol name (e.g. 'BrainEngine::searchKeyword'). Its chunk(s) join the candidate set and seed a structural walk of the code call graph. Code corpora only.",
      }),
      walk_depth: int({
        minimum: 0,
        maximum: 2,
        description:
          "Structural walk depth 0-2 (default 0 = off). Expands the anchors through code_edges_symbol with 1/(1+hop) score decay. Code corpora only; bypasses the query cache.",
      }),
      explain: bool({
        description:
          "Stamp each hit with a per-signal ranking attribution (`explain`: base score + the factor every boost stage contributed + reranker delta). Bypasses the query cache.",
      }),
      offset: int({
        minimum: 0,
        maximum: 1000,
        description:
          "Skip the first N ranked hits (pagination). Applied after ranking; the widened fetch bypasses nothing else.",
      }),
      mode: str({
        enum: ["conservative", "balanced", "tokenmax"],
        description:
          "Per-call search mode bundle. Honored ONLY for the operator (local/static-bearer) caller; a tenant token's mode is silently ignored (it cannot escalate to the paid tokenmax bundle).",
      }),
    },
  },
  {
    name: "index",
    scope: "write",
    description:
      "Index a markdown document. Either pass `path` (an absolute path the daemon can read) or `sourcePath` + `text` (in-memory).",
    params: {
      path: str({ description: "Absolute path to a .md file." }),
      sourcePath: str(),
      text: str(),
    },
  },
  {
    name: "backlinks",
    outputRedaction: "retrieval",
    description:
      "Find what links to a target. Default type `wikilink`: `name` (a page name or slug, any script) is resolved to its canonical page slug, redirects and declared aliases included, and the pages linking to it are returned (`sourcePath` is the page's `page://` path, `surfaceForm` the target slug). Type `tag` / `date`: documents whose chunks mention that tag or date.",
    params: {
      name: str(req),
      type: str({ enum: ["wikilink", "tag", "date"] }),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "stats",
    description:
      "Counts of indexed documents / chunks / embeddings. Cheap; no Bedrock calls.",
    params: {},
  },
  {
    name: "source_health",
    description:
      "Source-scoped document/chunk counts, embeddable coverage (excluding code), and staleness lag. Only local/unscoped callers see the NULL-source (unclassified) bucket and whole-brain health roll-up. Read-only, cheap, no Bedrock.",
    params: {},
  },
  {
    name: "log_friction",
    description:
      "Record a friction event — used by the agent to flag when retrieval missed, an answer felt wrong, a tool errored out, OR when a recall produced an unexpectedly good hit (`delight`). When invoked from a skill, include extra.skill = '<skill-slug>' so `memrain friction propose-fix` can group the event with the skill that fired it. Set `severity` to confused/error/blocker/nit on negative kinds for triage.",
    // Appends a friction_events row that has no source axis, so a read-scoped
    // token must not reach it — the op is a mutation and is tagged as one.
    scope: "write",
    params: {
      kind: str({
        ...req,
        enum: [
          "search-miss",
          "wrong-answer",
          "tool-error",
          "low-confidence",
          "other",
          "delight",
          "phase-marker",
          "interrupted",
        ],
      }),
      query: str(),
      reason: str(),
      sourcePath: str(),
      severity: str({ enum: ["confused", "error", "blocker", "nit"] }),
      extra: obj(),
    },
  },
  {
    name: "page_put",
    callShape: "{slug, markdown_body, expected_version?}",
    scope: "write",
    description:
      "Create/replace a DB-canonical page; identical content is a no-op, changes append history. Prefer page_edit for partial changes. Mirrors normally return search_indexed; queued ones return search_pending + search_job_id; wait_for_index waits. MEMRAIN_REQUIRE_WRITE_PRECONDITION makes missing expected_version/force warn or refuse with precondition_required + current_version. Public writes need MEMRAIN_PUBLIC_WRITE=1.",
    params: {
      reason: str({ description: "Optional trimmed one-line reason, ≤500 Unicode code points; secret-scanned, stored only with a new version." }),
      slug: str({
        ...req,
        description:
          "kebab-case identifier with optional `/` namespaces (e.g. people/alice, journal/2026/05/2026-05-18). New slugs cannot have repeated or trailing hyphens in any segment; existing slugs remain writable.",
      }),
      type: str({
        description:
          "Optional: concept/person/company/meeting/idea/journal/note/email/event/decision/task/source. Inferred from slug prefix (people/→person), else note. Other types require allowAdHocType:true.",
      }),
      title: str(),
      compiled_truth: obj({
        description:
          "Editable jsonb header (tags, related slugs, tier, enriched_at, …).",
      }),
      markdown_body: str(),
      written_by: str({
        description:
          "Optional caller identifier for the audit trail (skill slug, recipe name, …).",
      }),
      allowAdHocType: bool(),
      allow_empty_body: bool({
        description:
          "Clear the page's body on purpose. Without it an empty markdown_body over a page that has one is refused; an OMITTED markdown_body keeps the current body.",
      }),
      allow_shrink: bool({
        description:
          "Allow an intentional replacement smaller than half of a body over 32 KiB when the write-precondition policy is enabled. Prefer page_edit for partial changes.",
      }),
      wait_for_index: bool({
        description:
          "Write the search mirror before returning even when mirrors are queued, so the page is searchable the moment this call returns. Slower.",
      }),
      expected_version: expectedVersionParam,
      force: forceParam,
      request_id: requestIdParam,
    },
  },
  {
    name: "page_append",
    scope: "write",
    description:
      "Append to an existing page body and add a version; use page_put to create. Search readiness returns search_indexed, or search_pending + search_job_id for queued mirrors (normally seconds). wait_for_index:true waits for search readiness. Public writes require MEMRAIN_PUBLIC_WRITE=1.",
    argAliases: { markdown: "content" },
    params: {
      slug: str(req),
      content: str(req),
      written_by: str(),
      wait_for_index: bool({
        description:
          "Write the search mirror before returning even when mirrors are queued, so the page is searchable the moment this call returns. Slower.",
      }),
      request_id: requestIdParam,
    },
  },
  {
    name: "page_edit",
    callShape: "{slug, expected_version, edits:[{old_text, new_text}]}",
    scope: "write",
    // The diff quotes the stored lines around the edit.
    outputRedaction: "retrieval",
    description:
      "Atomically apply 1..50 ordered exact-text body replacements, preserving title/frontmatter. Copy unique old_text from page_get; misses/duplicates give edit_no_match/edit_ambiguous_match. Facts/takes fences and markers are protected (edit_protected_span); use their writers. Requires expected_version; conflict returns current_version. Returns version and diff capped at 8 KB (diff_truncated). Indexing follows page_put; wait_for_index waits. Public writes need MEMRAIN_PUBLIC_WRITE=1.",
    params: {
      reason: str({ description: "Optional trimmed one-line reason, ≤500 Unicode code points; secret-scanned, stored only with a new version." }),
      slug: str({ ...req, description: "The page to edit; it must exist." }),
      expected_version: int({
        ...req,
        minimum: 1,
        description:
          "The page's current version (`version` from page_get). On a mismatch nothing is written and the error names the current version.",
      }),
      edits: arr({
        ...req,
        items: {
          type: "object",
          properties: {
            old_text: { type: "string", minLength: 1, description: "Exact text to replace; must occur exactly once." },
            new_text: { type: "string", description: "Replacement text; empty deletes old_text." },
          },
          required: ["old_text", "new_text"],
          additionalProperties: false,
        },
        description: "1 to 50 replacements, applied in order, all or nothing.",
      }),
      written_by: str({
        description:
          "Optional caller identifier for the audit trail (skill slug, recipe name, …).",
      }),
      wait_for_index: bool({
        description:
          "Write the search mirror before returning even when mirrors are queued, so the change is searchable the moment this call returns. Slower.",
      }),
      request_id: requestIdParam,
    },
  },
  {
    name: "page_rename",
    scope: "write",
    description:
      "Rename a page, carrying its history, facts, links and timeline and redirecting the old slug. Requires expected_version from page_get. Refuses imported pages; rename them upstream. Old search mirrors are removed immediately; the next cycle indexes the new slug. Both slugs must be within your write grant. Static public bearer: forbidden.",
    params: {
      from: str(req),
      to: str(req),
      expected_version: int({ ...req, minimum: 1 }),
    },
  },
  {
    name: "page_delete",
    scope: "write",
    description:
      "Idempotent soft-delete: sets deleted_at, retains page and version history. Requires source-scoped write or internal token; static public bearer forbidden.",
    params: {
      reason: str({ description: "Optional trimmed one-line reason, ≤500 Unicode code points; secret-scanned, stored only with a new version." }),
      slug: str(req),
      written_by: str(),
      expected_version: expectedVersionParam,
      force: forceParam,
    },
  },
  {
    name: "page_restore",
    scope: "write",
    description:
      "Undelete a soft-deleted page (clears deleted_at). The inverse of page_delete; no-op if the page is missing or already live. WRITE — static public bearer: forbidden; authenticated token: requires the `write` scope (source-scoped); internal token: allowed.",
    params: {
      slug: str(req),
      written_by: str(),
    },
  },
  {
    name: "page_revert",
    scope: "write",
    description:
      "Restore a prior body snapshot as a NEW version, retaining history. version names the target version_n from page_versions. Requires source-scoped write or internal token; static public bearer forbidden.",
    params: {
      reason: str({ description: "Optional trimmed one-line reason, ≤500 Unicode code points; secret-scanned, stored only with a new version." }),
      slug: str(req),
      version: int({ ...req, minimum: 1 }),
      written_by: str(),
      expected_version: expectedVersionParam,
      force: forceParam,
    },
  },
  {
    name: "page_get",
    outputRedaction: "retrieval",
    description:
      "Read a page or error on absence. fuzzy:true resolves a unique fuzzy miss; multiple candidates return ambiguous_slug + candidates. include_deleted:true exposes soft-deleted pages with deleted_at for restoration. Pass returned version as expected_version on later writes to guard races.",
    params: {
      slug: str(req),
      source_id: str({ description: "Owning source from a search result; narrows the caller's read grant, never expands it." }),
      version: int({ minimum: 1, maximum: 2147483647, description: "Read stored body/truth/hash plus written_at; version differs from current_version. Identity/title stay current. Missing snapshot: version_not_found." }),
      offset: int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "UTF-8 byte offset for a body window; use the returned next_offset to continue." }),
      max_bytes: int({ minimum: 4, maximum: 262144, description: "Body window size in UTF-8 bytes (default 256 KiB). Windows return body_window instead of markdown_body; use page_edit or page_append to change a page." }),
      fuzzy: bool({ description: "Fuzzy slug resolution on a miss (default false)." }),
      include_deleted: bool({ description: "Surface soft-deleted pages (default false)." }),
      include_quarantined: bool({
        description:
          "Admin-only quarantined body access. Others receive metadata, quarantined and notice:page_quarantined, without body.",
      }),
    },
  },
  {
    name: "page_list",
    outputRedaction: "retrieval",
    description:
      "List pages, newest-first by default. Optional filters: `type`, `tag` (normalized), `since` (ISO timestamp), `limit` (1..100, default 50). `sort` picks the order (updated_desc default | updated_asc | created_desc | slug); `include_deleted:true` adds soft-deleted pages with deleted_at populated.",
    argAliases: {
      prefix: "slug_prefix",
    },
    params: {
      source_ids: arr({ items: { type: "string" }, description: "Narrow to ≤100 exact source IDs in your grant. Omitted uses grant; [] reads nothing; any forbidden ID refuses the call." }),
      type: str(),
      since: str(),
      tag: str({ description: "Filter to pages carrying this tag." }),
      sort: str({ enum: ["updated_desc", "updated_asc", "created_desc", "slug"] }),
      include_deleted: bool({ description: "Include soft-deleted pages (default false)." }),
      include_body: bool({ description: "Include markdown_body and compiled_truth (default true). Set false for metadata-only listing." }),
      slug_prefix: str({ description: "Literal slug prefix, e.g. projects/x/ for a subtree. No wildcards or relative paths." }),
      cursor: str({ description: "Opaque next_cursor from a previous page with the same filters, sort and source access. Limit and include_body may change. complete:true means no more rows at read time." }),
      // Clamp: list_pages caps at 100 (default 50) — a 1000-row
      // window is a needless enumeration amplifier for scoped tokens.
      limit: int({ minimum: 1, maximum: 100 }),
    },
  },
  {
    name: "page_versions",
    outputRedaction: "retrieval",
    description:
      "Version history, newest first. Metadata by default; include_body:true adds authorized body/truth snapshots. Operator/admin callers also receive written_by_principal (null for legacy/internal versions).",
    params: {
      slug: str(req),
      limit: int({ minimum: 1, maximum: 200 }),
      include_body: bool({ description: "Include body_snapshot and compiled_truth_snapshot (default false). Quarantine and public redaction still apply." }),
    },
  },
  {
    name: "link",
    scope: "write",
    description:
      "Assert a typed source→target link; repeating (source,target,type) updates confidence/chunk_id. Confidence defaults 1. works_at/located_at hold one value at a time: a new dated value closes the open one; an overlap, or no valid_from once dated, is refused (link_interval_conflict). Public writes require MEMRAIN_PUBLIC_WRITE=1.",
    params: {
      valid_from: str({ description: "Optional inclusive start YYYY-MM-DD. Omission preserves the stored bound; an existing bound cannot change." }),
      valid_until: str({ description: "Optional exclusive end YYYY-MM-DD. Must follow valid_from; an existing bound cannot change." }),
      source_slug: str({
        ...req,
        description:
          "The source page slug. Must reference an existing page (FK constraint).",
      }),
      target_slug: str({
        ...req,
        description:
          "The target slug (soft reference; the page may or may not yet exist). Loose names like `Alice Smith` are normalised to `alice-smith`.",
      }),
      type: str({
        ...req,
        description:
          "One of: wikilink, mentions, works_at, attended, founded, advises, invested_in, knows, met, located_at, related_to, supersedes, contradicts. Pass allowAdHocType=true to accept other types.",
      }),
      confidence: num({
        minimum: 0,
        maximum: 1,
        description:
          "0..1, default 1.0 for agent-asserted edges. Use <1.0 only for deterministic-extractor outputs whose surface form was ambiguous.",
      }),
      source_chunk_id: str(),
      allowAdHocType: bool(),
    },
  },
  {
    name: "unlink",
    scope: "write",
    description:
      "Remove a manually created typed link. Returns removed and derived_from_text for edges still supplied by markdown/frontmatter/mentions; edit the source page with page_edit to remove those. Idempotent. WRITE — static public bearer: forbidden; authenticated token: requires write scope in its source; internal token: allowed.",
    params: {
      source_slug: str(req),
      target_slug: str(req),
      type: str(req),
    },
  },
  {
    name: "graph_neighbors",
    outputRedaction: "retrieval",
    description:
      "Links touching slug, newest first, with direction per row. Select outbound, inbound or both and optional type.",
    params: {
      status: str({ enum: ["all", "active", "expired", "future"], description: "Filter manual link validity; default all. Half-open end date." }),
      as_of: str({ description: "Calendar date YYYY-MM-DD for an explicit status other than all; defaults to today UTC." }),
      slug: str(req),
      type: str({ description: "Filter to a single link type." }),
      direction: str({
        enum: ["outbound", "inbound", "both"],
        description: "Default `both`.",
      }),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "graph_query",
    outputRedaction: "retrieval",
    description:
      "Typed links matching type and at least one of source_slug/target_slug; e.g. works_at + a person source finds their companies, or a company target finds its people.",
    params: {
      status: str({ enum: ["all", "active", "expired", "future"], description: "Filter manual link validity; default all. Half-open end date." }),
      as_of: str({ description: "Calendar date YYYY-MM-DD for an explicit status other than all; defaults to today UTC." }),
      type: str(req),
      source_slug: str(),
      target_slug: str(),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "traverse_graph",
    outputRedaction: "retrieval",
    description:
      "Breadth-first graph walk; each node appears once at shortest depth. truncated means eligible nodes within max_depth exceeded limit: narrow type/depth. Direction defaults outbound (also inbound/both); depth default 3, range 1..10; limit default 100, range 1..1000.",
    params: {
      status: str({ enum: ["all", "active", "expired", "future"], description: "Filter manual link validity; default all. Half-open end date." }),
      as_of: str({ description: "Calendar date YYYY-MM-DD for an explicit status other than all; defaults to today UTC." }),
      start_slug: str(req),
      direction: str({ enum: ["outbound", "inbound", "both"] }),
      type: str(),
      max_depth: int({ minimum: 1, maximum: 10 }),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "add_fact",
    callShape: "{entity_slug, fact} or {entity_slug, items:[{fact}]}",
    scope: "write",
    description:
      "Record an entity claim; corrections create new facts. Identical entity/source/writer claims refresh (inserted:false). Withdrawn entity/source/visibility claims stay withdrawn across case/whitespace changes (withdrawn:true,id:null). Default private is operator-only; tenants use world to recall writes. Provenance: source_slug/source_chunk_id/written_by, else caller; public cannot set written_by. replaces supersedes a live fact, returning replaced. Batch ≤20 items inherits top-level defaults; all validate before writing. Results include saved/failed/partial and outcomes; all-failed is a tool error, mixed status:partial. Public forbids items/replaces; writes need MEMRAIN_PUBLIC_WRITE=1.",
    argAliases: { facts: "items", memories: "items", text: "fact", content: "fact", claim: "fact", entity: "entity_slug", subject: "entity_slug" },
    params: {
      valid_from: str({ description: "Date the claim became true (YYYY-MM-DD or ISO timestamp, stored as its UTC date)." }),
      kind: str({ enum: ["event", "preference", "commitment", "belief", "fact"] }),
      notability: str({ enum: ["high", "medium", "low"] }),
      claim_metric: str({ description: "Metric name; normalized to lower-case snake_case." }),
      claim_value: num({ description: "Finite numeric value; put the unit in claim_unit." }),
      claim_unit: str(),
      claim_period: str(),
      entity_slug: str({
        description:
          "Entity (e.g. people/alice); required unless every batch item names one. A bare name resolves uniquely within your write source (entity_resolved_from), else stays unchanged with entity_unresolved and ≤5 candidates. Qualified slugs need not exist.",
      }),
      fact: str({ description: "Short claim, one sentence. Required unless `items` is given." }),
      confidence: num({ minimum: 0, maximum: 1 }),
      source_slug: str({ description: "Page the fact was extracted from." }),
      source_chunk_id: str(),
      written_by: str(),
      visibility: str({
        enum: ["private", "world"],
        description:
          "Who may read the fact back. `private` (the default) is operator-only; `world` is also readable by tenant-scoped and public callers. Ignored on public ingress, which always writes `private`.",
      }),
      request_id: requestIdParam,
      replaces: int({
        minimum: 1,
        description:
          "Id of a live fact in your own source that this fact replaces. Not combinable with `items` (put it on the item instead).",
      }),
      items: arr({
        description:
          "Batch 1..20 {fact,entity_slug?,confidence?,visibility?,replaces?}, instead of fact. Items override top-level valid_from/kind/notability/claim_metric/value/unit/period defaults.",
      }),
    },
  },
  {
    name: "add_timeline_event",
    outputRedaction: "retrieval",
    callShape: "{slug, occurred_at, event}",
    scope: "write",
    description:
      "Append a timeline event to an existing page. Returns the stored row, including the original on a duplicate, subject to read redaction. Correct a mistake by appending a new event describing the correction; the original remains. Idempotent on (slug, occurred_at, source_chunk_id) when source_chunk_id is provided. WRITE — refused on public ingress unless the operator sets MEMRAIN_PUBLIC_WRITE=1.",
    argAliases: { date: "occurred_at", summary: "event" },
    params: {
      slug: str({
        ...req,
        description:
          "The page the event is attached to. Must reference an existing page (FK CASCADE).",
      }),
      occurred_at: str({
        ...req,
        description:
          "When the event happened (ISO-8601). Not when it was recorded.",
      }),
      event: str(req),
      source_chunk_id: str(),
      request_id: requestIdParam,
    },
  },
  {
    name: "entity_facts",
    outputRedaction: "retrieval",
    description:
      "Entity facts ordered by confidence (default) or recency; omit entity_slug for cross-entity recall. Filter by written_at since, originating source_slug, capture session, case-insensitive grep or private/world visibility. include_forgotten adds audit tombstones for internal callers; public forces it off.",
    params: {
      entity_slug: str({ description: "Entity to scope to. Omit for a cross-entity recall." }),
      query: str({ description: "Semantic focus: one Titan embedding of first 512 characters, cosine ≥0.35; also facts_groups without entity_slug. Public ignores it; unavailable embedding returns normal order + hint." }),
      since: str(),
      source_slug: str(),
      order: str({ enum: ["confidence", "recency"] }),
      session: str({ description: "Filter to facts captured under this session id." }),
      grep: str({ description: "Case-insensitive substring filter on the fact text." }),
      visibility: str({ enum: ["private", "world"], description: "Filter by fact visibility." }),
      include_forgotten: bool({ description: "Include tombstoned (forgotten) rows. Internal-only; default false." }),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "fact_supersessions",
    outputRedaction: "retrieval",
    description:
      "Supersession audit log: facts retired WITH a replacement pointer (forgotten_at + superseded_by both set), newest retirement first. Each row is the RETIRED fact; superseded_by points at its replacement. Optional `entity_slug` / `since` (ISO, on the retirement time) / `limit` (1..1000, default 50). Tenant-scoped. Read-only; no LLM.",
    params: {
      entity_slug: str({ description: "Confine to one entity's ledger." }),
      since: str({ description: "ISO lower bound on forgotten_at." }),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "entity_timeline",
    outputRedaction: "retrieval",
    description:
      "Chronological event log for a page. Newest-first. Optional `since` / `until` date bounds.",
    params: {
      slug: str(req),
      since: str(),
      until: str(),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "entity_recall",
    outputRedaction: "retrieval",
    description:
      "One-shot 'what do I know about X?' aggregator. Returns the entity's page (compiled_truth + body) plus top-confidence facts plus most-recent timeline events in a single call. The page may be null when the entity exists only as a soft-stub (facts + timeline allowed, page not yet promoted). A fact that conflicts with another visible typed claim lists the peer ids in contested_with.",
    argAliases: { entity: "slug" },
    params: {
      slug: str(req),
      query: str({
        description:
          "Optional semantic fact focus (e.g. funding history), replacing confidence order; falls back to confidence when embedding is unavailable.",
      }),
      fact_limit: int({ minimum: 1, maximum: 200 }),
      timeline_limit: int({ minimum: 1, maximum: 200 }),
      redact_body: bool({
        description:
          "When true, strips markdown_body from the page row. The HTTP public-bearer path forces this on by default; internal MCP callers default false.",
      }),
      token_budget: int({
        minimum: 1,
        description:
          "Approximate whole-response token cap, measured on serialized visible rows after redaction. Server reallocates unused page/facts/timeline shares and truncates the body. budget reports facts_dropped, timeline_dropped, page_truncated and page_dropped; page:null with page_dropped means it did not fit, not that it is absent.",
      }),
      include_pending: bool({
        description:
          "Piggy-back `pending_consolidation_count` (live facts not yet folded into a consolidated take) on the response. One round trip; field omitted when false.",
      }),
    },
  },
  {
    name: "jobs_submit",
    description:
      "Submit a durable job; `kind` must be a registered handler kind. Idempotent when `idempotency_key` is provided (re-submit returns the existing row). Optional `parent_job_id` records a fan-out edge so the parent can detect fan-in via the child-done inbox. WRITE — refused on public ingress.",
    params: {
      kind: str(req),
      payload: obj(),
      priority: int({ minimum: 1, maximum: 10 }),
      max_retries: int({ minimum: 0, maximum: 10 }),
      parent_job_id: str(),
      idempotency_key: str(),
      not_before: str(),
      timeout_ms: int({ minimum: 1, maximum: 2147483647 }),
    },
  },
  {
    name: "jobs_cancel",
    description:
      "Cancel a pending job. By default cascades to all pending descendants. WRITE — refused on public ingress.",
    params: {
      id: str(req),
      cascade: bool(),
      reason: str(),
    },
  },
  {
    name: "jobs_list",
    outputRedaction: "retrieval",
    description:
      "List jobs newest-first. Optional filters: status, kind, parent_job_id, since (ISO timestamp), limit (1..1000, default 100).",
    params: {
      status: str(),
      kind: str(),
      parent_job_id: str(),
      since: str(),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "jobs_get",
    outputRedaction: "retrieval",
    description:
      "Get the full detail of a job including payload, result, children, and unread child-done inbox count.",
    params: { id: str(req) },
  },
  {
    name: "jobs_logs",
    outputRedaction: "retrieval",
    description:
      "Compact log view of a job: status, retries, last_error, children count + status breakdown, unread inbox count. Designed to fit in a single chat reply.",
    params: { id: str(req) },
  },
  {
    name: "daemons_status",
    description:
      "Background daemons: each one's schedule, lane, whether it is enabled or paused (and by whom), its last window or run, failures in a row and next window; plus a global pause and which process leads the scheduler. Operator only.",
    params: {},
  },
  {
    name: "daemons_control",
    description:
      "Pause or resume a background daemon (`daemon: \"all\"` for every one). A pause stops new runs; resuming a daemon lifts its pauses for every source unless source_id is given, and restarts its failure count. Operator only.",
    params: {
      action: str({ ...req, enum: ["pause", "resume"] }),
      daemon: str({ ...req, description: "Daemon name (see daemons_status) or \"all\"." }),
      source_id: str({ description: "Only this source's runs of the named daemon." }),
      reason: str({ description: "Shown in status; up to 200 characters." }),
    },
  },
  {
    name: "submit_agent",
    description:
      "Queue a read-only research agent that runs under your own grant: it reads only your sources, uses only the read tools your client is bound to, spends against your daily budget, and stops if your grant is revoked or changed. Returns a job_id; poll get_agent_job. Needs the 'agent' scope, a daily budget on your client, and a free slot under your client's concurrency limit. Writes nothing.",
    scope: "agent",
    params: {
      task: str({ ...req, description: "What the agent should find out, in plain language (at most 8 KB)." }),
      max_usd: num({ description: "Spend ceiling for this job in USD; clamped to the brain's per-job ceiling." }),
    },
  },
  {
    name: "get_agent_job",
    outputRedaction: "retrieval",
    description:
      "Status and answer of an agent job you submitted with submit_agent: status, stop_reason, final_text, cost_usd, turns and an error when it failed. A job that is not yours reads as not found.",
    scope: "agent",
    params: { job_id: str(req) },
  },
  {
    name: "get_chunks",
    outputRedaction: "retrieval",
    description:
      "Return a page's (or document's) content chunks in order. Pass `slug` (resolved through the page's page://<slug> search mirror) or `source_path` (a raw document). At least one is required. Returns at most limit chunks (default 200), ordered by chunk_index with an id tie-break; truncated:true means more remain. Continue with from_index increased by the number returned.",
    params: {
      slug: str(),
      source_path: str(),
      from_index: int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Zero-based position in the ordered, source-filtered result (default 0)." }),
      limit: int({ minimum: 1, maximum: 200 }),
    },
  },
  {
    name: "resolve_slugs",
    description:
      "Resolve names to live slugs: exact slug, then fuzzy title/slug. exact:true matches only slug/title/basename/declared alias/email (compiled_truth.email or identity.email; email needs body access). Reports ambiguity even at limit:1. Hits: slug,title,score,referenced_by_count (distinct visible referring pages in scope).",
    argAliases: { slugs: "query" },
    params: {
      query: str(req),
      exact: bool(),
      limit: int({ minimum: 1, maximum: 100 }),
    },
  },
  {
    name: "add_tag",
    scope: "write",
    description:
      "Add a tag to a page (normalized: trim + lowercase). Idempotent. The page must exist. WRITE — refused on public ingress unless the operator sets MEMRAIN_PUBLIC_WRITE=1.",
    params: {
      slug: str(req),
      tag: str(req),
    },
  },
  {
    name: "remove_tag",
    scope: "write",
    description:
      "Remove a tag from a page. Idempotent (removing an absent tag is a no-op). WRITE — static public bearer: forbidden; authenticated token: requires the `write` scope (source-scoped); internal token: allowed.",
    params: {
      slug: str(req),
      tag: str(req),
    },
  },
  {
    name: "get_tags",
    outputRedaction: "retrieval",
    description:
      "List a page's tags in lexical order. Empty list for an unknown or untagged page.",
    params: { slug: str(req) },
  },
  {
    name: "relational_recall",
    outputRedaction: "retrieval",
    description:
      "Deterministic relational query — resolves a seed entity from a natural-language relationship question ('who does alice report to?', 'who works at acme', 'how is alice connected to bob') and fans out typed edges. Returns [{slug, relation, depth}]. No LLM.",
    params: {
      query: str(req),
      limit: int({ minimum: 1, maximum: 200 }),
      depth: int({ minimum: 1, maximum: 6 }),
    },
  },
  {
    name: "get_links",
    outputRedaction: "retrieval",
    description:
      "Edges touching slug, grouped by type and outbound/inbound direction (source/target respectively). Groups sort by type, outbound first; edges newest first. limit caps each direction: default/max 1000, minimum 1.",
    params: {
      status: str({ enum: ["all", "active", "expired", "future"], description: "Filter manual link validity; default all. Half-open end date." }),
      as_of: str({ description: "Calendar date YYYY-MM-DD for an explicit status other than all; defaults to today UTC." }),
      slug: str(req),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "list_link_sources",
    description:
      "The link-type catalogue with live per-type edge counts. Every KNOWN_LINK_TYPES entry is returned (count 0 when unused), plus any ad-hoc type present in the graph (known:false). Ordered by count DESC then type ASC, so the most-used relationship types surface first while the full vocabulary stays discoverable. Returns [{type, count, known}].",
    params: {},
  },
  {
    name: "find_orphans",
    outputRedaction: "retrieval",
    description:
      "Pages with zero inbound links — nothing in the graph references them. The natural enrichment targets (a page nobody links to is new or forgotten). Newest-first. Optional `type` page-type filter; `limit` (1..1000, default 50). Deterministic, no LLM.",
    params: {
      type: str({ description: "Restrict to a single page type (e.g. person)." }),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "wanted_pages",
    outputRedaction: "retrieval",
    description:
      "Unresolved targets linked by live visible pages in your sources, most-referenced first. Returns target_slug,referenced_by,sample_from (≤3 slugs),surface,first_seen. Hidden pages never count. Limit default 50, range 1..200. Deterministic, no LLM.",
    params: {
      limit: int({ minimum: 1, maximum: 200 }),
    },
  },
  {
    name: "find_experts",
    outputRedaction: "retrieval",
    description:
      "With topic: person/company expertise from hybrid search × relationship recency (6-month half-life) × salience. Without topic: graph hubs by distinct live in/out neighbours, excluding unresolved stubs. type overrides topic candidates or filters hubs. Limit default 5, range 1..200; deterministic, no LLM.",
    params: {
      topic: str({
        description:
          "Optional topic query. When set, ranks person/company pages by expertise + recency + salience. When omitted, returns graph link-degree hubs.",
      }),
      type: str({ description: "Restrict to a single page type (overrides the person/company default in topic mode)." }),
      explain: bool({
        description:
          "Topic mode only: include the per-result factor breakdown (expertise, recency, salience) behind `score`.",
      }),
      limit: int({ minimum: 1, maximum: 200 }),
    },
  },
  {
    name: "find_contradictions",
    outputRedaction: "retrieval",
    description:
      "Read conflicts without an LLM call. Default returns explicit contradicts page edges and cached opt-in probe findings (severity/axis/confidence/resolution_command; empty before probing). slug filters either edge endpoint; limit default 20, max 200. mode:typed finds overlapping numeric disagreements; use entity_slug, not slug/severity.",
    params: {
      mode: str({ enum: ["typed"], description: "typed: deterministic overlapping numeric conflicts in the same unit/period/month/source. Omit for asserted/probed findings." }),
      entity_slug: str({ description: "Exact entity filter for typed mode only." }),
      slug: str({ description: "Substring filter; matches either side of the pair (case-insensitive)." }),
      severity: str({
        enum: ["low", "medium", "high"],
        description: "Filter the probed findings by severity (edges have no severity axis).",
      }),
      limit: int({ minimum: 1, maximum: 200 }),
    },
  },
  {
    name: "find_trajectory",
    outputRedaction: "retrieval",
    description:
      "Chronological 'how did this entity change?' log for one slug — the merged, oldest-first view of its entity_facts ledger and its timeline_events. Each fact anchors at its valid_from (else written_at); each event at occurred_at. Optional `since`/`until` ISO bounds on that anchor; `limit` (1..500, default 100). Deterministic, no LLM.",
    params: {
      entity_slug: str({ ...req, description: "The entity to chart (e.g. companies/acme, people/alice)." }),
      metric: str({
        description:
          "Filter to a single canonical metric label (mig070 claim_metric, e.g. 'mrr'); timeline events are excluded for a metric query.",
      }),
      kind: str({
        enum: ["metric", "event", "all"],
        description:
          "Row-shape filter (mig070): 'metric' = typed-claim fact rows only, 'event' = event-shaped rows (event_type facts + timeline events), 'all' (default) = merged chronology.",
      }),
      since: str({ description: "Lower bound (ISO timestamp) on the point's anchor date." }),
      until: str({ description: "Upper bound (ISO timestamp)." }),
      limit: int({ minimum: 1, maximum: 500 }),
    },
  },
  {
    name: "get_recent_salience",
    outputRedaction: "retrieval",
    description:
      "Live pages ranked by the deterministic `salience` score (migration 036: high-emotion tags + graph link-degree, recomputed by the recompute-salience cycle phase) — the 'what matters' read. Optional `type` filter and `days` recency window. No LLM, no Bedrock. Surfaces page slugs/titles — hidden from public ingress.",
    params: {
      type: str({ description: "Filter to a single page type (exact match), e.g. person." }),
      days: int({ minimum: 1, description: "Only pages updated within the last N days. Omit for all-time." }),
      slug_prefix: str({ description: "Optional slug-prefix filter, e.g. 'people' or 'projects/x'." }),
      recency_bias: str({
        enum: ["flat", "on"],
        description:
          "'flat' (default) = pure salience order (historical behavior). 'on' = rank by salience x 1/(1+days_old) — 'what's been salient lately'.",
      }),
      limit: int({ minimum: 1, maximum: 200, description: "Max rows (default 20)." }),
    },
  },
  {
    name: "find_anomalies",
    outputRedaction: "retrieval",
    description:
      "Live-graph outliers: degree_outlier (degree ≥ mean + sigma·stddev) and stale_salient (high salience, updated_at older than staleDays). Uses structural signals, not retrieval/access counters. No LLM; public forbidden (page slugs/titles).",
    params: {
      sigma: num({ minimum: 0, description: "Std-devs above the mean degree to flag a hub (default 2)." }),
      staleDays: int({ minimum: 1, description: "Days an updated_at must lag to count a salient page stale (default 90)." }),
      salienceFloor: num({ minimum: 0, maximum: 1, description: "Salience floor for the stale_salient class (default 0.5)." }),
      limit: int({ minimum: 1, maximum: 200, description: "Max rows per anomaly kind (default 20)." }),
    },
  },
  {
    name: "recall",
    outputRedaction: "retrieval",
    description:
      "Read ONE known numeric fact id: claim, confidence, source and metadata. Unknown/forgotten ids error. For discovery use entity_facts (entity facts), entity_recall (entity context) or search (corpus); this is neither search nor listing.",
    params: {
      id: int({ ...req, minimum: 1, description: "Fact id (entity_facts.id)." }),
    },
  },
  {
    name: "forget_fact",
    scope: "write",
    description:
      "Durably withdraw by id within entity/source/visibility, retiring identical live copies (withdrawn_duplicates). Re-add/extraction/import cannot revive it; no undo, audit retained. Repeats no-op; unknown id gives found:false. Stores optional reason. Returns ≤5 similar_active ids/scores for distinct rewordings: confirm separately. Requires owning-source write; static public forbidden.",
    params: {
      id: int({ ...req, minimum: 1, description: "Fact id to forget (entity_facts.id)." }),
      reason: str({ description: "Optional audit note stored on the forgotten row." }),
    },
  },
  {
    name: "get_brain_identity",
    description:
      "Brain identity + counters for a thin-client banner. Returns the running version, the storage engine kind, and corpus counts (documents / chunks / embeddings / pages / sources) plus the brain's earliest created_at. Counts only — no slugs, titles, or bodies. Cheap; no Bedrock.",
    params: {},
  },
  {
    name: "whoami",
    description:
      "Show the calling identity and grant: client_id, scopes, write_source, read_sources, is_public, operator, bound_slug_prefixes, takes_holders, budget_usd_per_day, spent_today_usd, spend_id and callable_tools. Unscoped read_sources is null; absent grant fields are null. callable_tools matches tools/list. Reveals only the caller's auth context, no corpus or Bedrock call.",
    params: {},
  },
  {
    name: "purge_deleted_pages",
    scope: "admin",
    description:
      "HARD-delete soft-deleted pages older than older_than_hours (default 720 = 30 days; document cycle TTL stays 72). Cascades page versions, aliases and links; also deletes raw_data, tags and redirects to purged slugs, with per-table counts. Returns reaped slugs, count and ttl_hours. Admin scope in the owning source or internal token required; static public bearer forbidden. page_delete needs write scope; purge needs admin.",
    params: {
      older_than_hours: num({
        minimum: 0,
        description: "Age cutoff in hours. Pages soft-deleted longer ago than this are reaped. Default 720 (30 days).",
      }),
      slugs: arr({
        items: { type: "string" },
        description: "Only these slugs, and only those soft-deleted past the cutoff. Omit to reap every expired page.",
      }),
      dry_run: bool({
        description: "Reap nothing; return `planned` (the slugs a real run would reap now) and its `plan_hash`.",
      }),
      expected_plan_hash: str({
        description:
          "The `plan_hash` of an earlier dry run. The purge is refused unless the plan still hashes the same, so exactly the reviewed pages go.",
      }),
    },
  },
  {
    name: "query",
    outputRedaction: "retrieval",
    description:
      "Hybrid retrieval with detail, salience/recency, date/code filters, offset and adaptive_return. expand is paid (mode default); mode overrides are operator-only. refine+weights uses deterministic two-query RRF. Otherwise returns search meta; counts are operator-only. token_budget without k considers 100 hits; explicit k wins. Adds ≤3 lexical ledger facts within budget, respecting source/visibility/diary fences; chunk filters affect hits. Empty results include a recovery hint.",
    params: {
      source_ids: arr({ items: { type: "string" }, description: "Narrow to ≤100 exact source IDs in your grant. Omitted uses grant; [] reads nothing; any forbidden ID refuses the call." }),
      types: arr({ items: { type: "string" }, description: "Up to 20 lower-case page type names. Matches canonical live pages and their indexed mirrors/file twins; non-page documents are excluded. Empty means no type filter." }),
      slug_prefix: str({ description: "Literal canonical page slug prefix, e.g. projects/x/. No wildcards. Applied before retrieval limits." }),
      q: str({ ...req, description: "Natural-language query." }),
      k: int({ minimum: 1, maximum: 100, description: "Number of hits to return. Default 20; without refine, token_budget and no k uses up to 100 candidates." }),
      offset: int({ minimum: 0, maximum: 1000, description: "Skip the first N ranked hits (pagination)." }),
      expand: bool({
        description:
          "Force LLM query expansion on/off for this call (paid Haiku). Omit = mode-bundle default (OFF in conservative/balanced).",
      }),
      detail: str({
        enum: ["low", "medium", "high"],
        description:
          "Result detail: low = compiled-truth-grade brevity (1 chunk per page), medium (default) = per-page dedup, high = all chunks + temporal source-boost bypass.",
      }),
      mode: str({
        enum: ["conservative", "balanced", "tokenmax"],
        description: "Search mode bundle for this call. Operator-only; a tenant token's mode is silently ignored.",
      }),
      salience: str({
        enum: ["off", "on", "strong"],
        description:
          "Mattering bias (pages.salience: emotional weight + link degree + takes). Omit = auto-detect from the query phrasing.",
      }),
      recency: str({
        enum: ["off", "on", "strong"],
        description:
          "Recency boost (per-prefix hyperbolic freshness lift). 'strong' for 'today / right now'. Omit = auto-detect.",
      }),
      since: str({ description: "Keep only hits whose content date is >= this ISO-8601 date." }),
      until: str({ description: "Keep only hits whose content date is <= this ISO-8601 date." }),
      lang: str({ description: "Filter to chunks of a source language (code corpora)." }),
      symbol_kind: str({ description: "Filter to chunks of a symbol kind (code corpora)." }),
      near_symbol: str({ description: "Anchor retrieval at this qualified symbol name (code corpora)." }),
      walk_depth: int({ minimum: 0, maximum: 2, description: "Structural walk depth 0-2 (code corpora)." }),
      token_budget: int({ minimum: 1, maximum: 200000, description: "Cap total returned content size (~chars/4 tokens)." }),
      adaptive_return: bool({
        description:
          "Return a TIGHT intent-sized result set instead of the full top-K (never empty when there are matches; first page only).",
      }),
      explain: bool({ description: "Stamp per-hit ranking attribution. Bypasses the query cache." }),
      refine: str({ description: "LEGACY refinement: second term for the deterministic weighted-RRF blend. When set, only k/weights apply." }),
      primary_weight: num({ minimum: 0, description: "RRF weight for the primary query (refine mode). Default 1." }),
      refine_weight: num({ minimum: 0, description: "RRF weight for the refine term (refine mode). Default 1." }),
    },
  },
  {
    name: "code_callers",
    outputRedaction: "retrieval",
    description:
      "Call sites for symbol name (surface,chunk,path), with language/kind/line bounds and authorized opening snippets. Empty reads carry scoped readiness {state,code_documents,symbols}: not_built/indexing/no_symbols/ready; only ready proves absence. Limit default 200, range 1..1000; optional lang. Deterministic, no LLM.",
    params: {
      name: str({ ...req, description: "Bare symbol name to find callers of (e.g. `hybridSearch`)." }),
      limit: int({ minimum: 1, maximum: 1000 }),
      lang: str({ description: "Only mentions from chunks of this source language (e.g. `typescript`, `python`, `go`)." }),
    },
  },
  {
    name: "code_callees",
    outputRedaction: "retrieval",
    description:
      "Callees of target path:line (innermost definition) or symbol; qualified names restrict sites. resolved_symbol is definition or null. Returns language/kind/line bounds and authorized opening snippets. Empty reads carry scoped readiness; only ready proves absence. Limit default 200/max 1000; optional lang. Deterministic, no LLM.",
    params: {
      target: str({
        ...req,
        description:
          "`<path>:<line>` of a symbol body (e.g. `src/x.ts:42`), or a symbol name, bare or qualified (e.g. `save` or `Repo::save`).",
      }),
      limit: int({ minimum: 1, maximum: 1000 }),
      lang: str({ description: "Only mentions from chunks of this source language (e.g. `typescript`, `python`, `go`)." }),
    },
  },
  {
    name: "code_def",
    outputRedaction: "retrieval",
    description:
      "Find code-def mentions for symbol name across indexed code: surface form, chunk, source path, language, kind, line bounds and an authorized opening snippet. Empty reads carry scoped readiness: not_built, indexing, no_symbols or ready. Only ready proves absence. Deterministic, no LLM; limit defaults 200 (max 1000), optional lang.",
    params: {
      name: str({ ...req, description: "Bare symbol name to locate definitions of (e.g. `hybridSearch`, `Storage`)." }),
      limit: int({ minimum: 1, maximum: 1000 }),
      lang: str({ description: "Only mentions from chunks of this source language (e.g. `typescript`, `python`, `go`)." }),
    },
  },
  {
    name: "code_refs",
    outputRedaction: "retrieval",
    description:
      "Non-call code-ref mentions for symbol name (imports/type uses/other references); complements code_callers. Includes language/kind/line bounds and authorized opening snippets. Empty reads carry scoped readiness {state,code_documents,symbols}: not_built/indexing/no_symbols/ready; only ready proves absence. Limit default 200, range 1..1000; optional lang. Deterministic, no LLM.",
    params: {
      name: str({ ...req, description: "Bare symbol name to find references to (e.g. `hybridSearch`)." }),
      limit: int({ minimum: 1, maximum: 1000 }),
      lang: str({ description: "Only mentions from chunks of this source language (e.g. `typescript`, `python`, `go`)." }),
    },
  },
  {
    name: "code_blast",
    outputRedaction: "retrieval",
    description:
      "Transitive callers by BFS depth for change-impact checks. depth default 5/max 8; max_nodes default 200. Returns result (ok/not_found/ambiguous), depth_groups, cycles_detected, truncation and optional candidates/did_you_mean. Nodes: symbol,chunk_id,def_chunk_id,resolved (definition-backed vs by-name). Empty reads carry scoped readiness; only ready proves absence. No LLM.",
    params: {
      symbol: str({ ...req, description: "Bare or qualified symbol name (e.g. `performSync` or `Foo::performSync`)." }),
      depth: int({ minimum: 1, maximum: 8, description: "Hop cap. Default 5, max 8." }),
      max_nodes: int({ minimum: 1, maximum: 200, description: "Result-set cap. Default 200." }),
      exact: bool({ description: "Skip bare-name disambiguation; treat `symbol` as an exact qualified name." }),
      lang: str({ description: "Walk only chunks of this source language. Omitted: the start symbol's language when all its definitions share one." }),
    },
  },
  {
    name: "code_flow",
    outputRedaction: "retrieval",
    description:
      "Transitive callees by BFS depth; code_blast envelope plus terminal_nodes [{symbol,sink_kind:db_call/http_call/file_io/process_exec}]. depth default 8/max 12; max_nodes default 200. Language-specific names detect sinks; generic get/put/read/write do not. Empty reads carry readiness; only ready proves absence. No LLM.",
    params: {
      symbol: str({ ...req, description: "Entry-point symbol name (bare or qualified)." }),
      depth: int({ minimum: 1, maximum: 12, description: "Hop cap. Default 8, max 12." }),
      max_nodes: int({ minimum: 1, maximum: 200, description: "Result-set cap. Default 200." }),
      exact: bool({ description: "Skip bare-name disambiguation; treat `symbol` as an exact qualified name." }),
      lang: str({ description: "Walk only chunks of this source language. Omitted: the start symbol's language when all its definitions share one." }),
    },
  },
  {
    name: "volunteer_context",
    outputRedaction: "retrieval",
    description:
      "Resolve rolling-window entity mentions to page pointers: alias .9/title .8/slug-suffix .6, +.05 for newest-turn or ≥2-turn mentions; confidence gate and cap N. Returns [{slug,title,display,confidence,arm,rationale,synopsis}]. Deterministic, no Bedrock. Public forbidden (slugs/titles/synopses). stats:true gives approximate per-arm used/volunteered precision from last_retrieved_at.",
    params: {
      window: str({ description: "Conversation window text. 'user:'/'assistant:' line prefixes set the role; unprefixed input is one user turn. Required unless stats:true." }),
      prior_context: str({
        description:
          "Already-surfaced context (pointer blocks / opened page bodies). Pages whose slug appears here are not re-volunteered.",
      }),
      max_pages: int({ minimum: 1, maximum: 5, description: "Max pages volunteered (default 3, cap 5)." }),
      min_confidence: num({ minimum: 0, maximum: 1, description: "Confidence gate 0..1 (default 0.7). At the default, slug-suffix matches never volunteer." }),
      session_id: str({ description: "Opaque session id stamped on each logged volunteer event." }),
      turn: int({ minimum: 0, description: "Turn number stamped on each logged volunteer event." }),
      stats: bool({ description: "Return per-arm used/volunteered precision stats instead of volunteering." }),
      days: int({ minimum: 1, maximum: 3650, description: "Stats window in days (default 30; stats mode only)." }),
    },
  },
  {
    name: "context_delta",
    outputRedaction: "retrieval",
    description: "Bounded recent pages (metadata), facts and events since a date/UTC timestamp; each section has truncated and time_basis. Not a complete change log/snapshot. Read-only, no retrieval touch/inference; internal-only.",
    params: {
      since: str({ ...req, description: "YYYY-MM-DD or UTC ISO timestamp." }),
      limit: int({ minimum: 1, maximum: 100, description: "Maximum items per section; default 20." }),
      source_ids: arr({ items: { type: "string" }, description: "Narrow within your source grant; [] reads nothing." }),
    },
  },
  {
    name: "quarantine_list",
    scope: "admin",
    description: "Operator-only, read-only quarantined IDs/sources/paths/fixed reason codes. No titles, bodies or free-form details. Default 20, max 100.",
    params: {
      limit: int({ minimum: 1, maximum: 100 }),
      source_ids: arr({ items: { type: "string" }, description: "Narrow to exact sources; [] reads nothing." }),
    },
  },
  {
    name: "extraction_review",
    scope: "admin",
    description: "Operator-only metadata candidates: missing same-source entity pages and similar facts from at most 200 recent eligible rows; scanned/scan_truncated report bounds. No queues, merges, deletes or models.",
    params: {
      limit: int({ minimum: 1, maximum: 100 }),
      source_ids: arr({ items: { type: "string" }, description: "Narrow to exact sources; [] reads nothing." }),
    },
  },
  {
    name: "context_pack",
    outputRedaction: "retrieval",
    description:
      "Budgeted entity cards (title,type,facts,events; no body), up to 8: explicit slugs first, then window entities at the volunteer default gate. Adds top decayed facts across the grant, excluding card duplicates. token_budget prioritizes cards; budget reports drops. Hidden/missing slugs both yield no card. Conflicting facts carry contested_with. Operator-pinned pages (MEMRAIN_CONTEXT_CORE_SLUGS) come first as core, charged before cards. Stateless read, no LLM; internal-only.",
    params: {
      slugs: arr({ description: "Entity page slugs to build cards for, in priority order (array of strings)." }),
      window: str({ description: "Conversation window text; entities it names fill the card slots left after `slugs`. 'user:'/'assistant:' line prefixes set the role." }),
      max_entities: int({ minimum: 1, maximum: 8, description: "Max entity cards (default 5, cap 8)." }),
      facts_limit: int({ minimum: 1, maximum: 25, description: "Max brain facts after the cards (default 10, cap 25)." }),
      token_budget: int({ minimum: 200, maximum: 8000, description: "Token budget for cards + facts (default 1500, clamped 200..8000)." }),
    },
  },
  {
    name: "advisor",
    outputRedaction: "retrieval",
    description:
      "Ranked, read-only \"what to do next\" for this brain: pending migrations, version drift, stalled/failed jobs, low embedding coverage, and setup smells. Each finding has a severity (high/medium/low/info), a why-it-matters, and the exact fix command. Never mutates, never calls an LLM. Tell the user; ask before running any fix. Internal-only.",
    params: {},
  },
  {
    name: "list_brain_skillpack",
    outputRedaction: "retrieval",
    description:
      "Read the served deploy/skills catalog (also list_skills): slug, description, triggers, mutating flag, usable_tools/unavailable_tools for your grant. Retrieve with get_skill; listing does not install skills. Host CLI: memrain skillpack builds a tarball + SHA-256 manifest; skillpack lint checks actual tools/commands.",
    params: {},
  },
  {
    name: "list_concepts",
    outputRedaction: "retrieval",
    description:
      "List synthesized concept pages (LLM-derived from the corpus by the synthesize-concepts cycle phase): concept_slug, title, tier (T1/T2/T3), atom_count, narrative. Ordered by atom_count DESC. Read-only; internal-only (derived over private notes).",
    params: {
      limit: int({ minimum: 1, maximum: 200, description: "Max rows (default 50)." }),
    },
  },
  {
    name: "list_takes",
    outputRedaction: "retrieval",
    description:
      "List synthesized 'takes' (opinionated claims the propose-takes phase derived, optionally graded): take_key, claim_text, kind, weight, domain, status (queued/accepted/rejected). Optional filters: `kind`, `domain`; `sort` (generated_at default | weight), `offset` for pagination. Advisory only — never mutates notes. Read-only; internal-only.",
    params: {
      status: str({ enum: ["queued", "accepted", "rejected", "graded"], description: "Filter by review status." }),
      kind: str({ description: "Filter to one take kind (e.g. bet, judgment)." }),
      domain: str({ description: "Filter to one domain tag." }),
      holder: str({ description: "Filter to one holder (world | brain | people/<slug> | companies/<slug>)." }),
      sort: str({ enum: ["generated_at", "weight"], description: "Sort key. Default generated_at (newest first)." }),
      offset: int({ minimum: 0, maximum: 10000, description: "Skip the first N rows." }),
      limit: int({ minimum: 1, maximum: 200, description: "Max rows (default 50)." }),
    },
  },
  {
    name: "set_take_status",
    scope: "write",
    description:
      "Set a synthesized take's review status: mark it 'accepted' or 'rejected' by take_key. Advisory only — never mutates notes, only the take's own review flag. Tenant-scoped: a take_key that isn't yours is a no-op. Internal-only.",
    params: {
      take_key: str({ ...req, description: "The take's take_key (from list_takes)." }),
      status: str({ ...req, enum: ["accepted", "rejected"], description: "New review status." }),
    },
  },
  {
    name: "takes_add",
    scope: "write",
    outputRedaction: "retrieval",
    description: "Append a canonical takes-fence row; retain other rows/history. Requires owned page, current version and permitted holder; records authenticated actor. dry_run previews; optional plan_hash pins it. Static public forbidden.",
    params: { ...takeWriteParams, ...takeFields, claim: { ...takeFields.claim, ...req },
      kind: { ...takeFields.kind, ...req }, holder: str({ ...req, description: "world, brain, people/<slug> or companies/<slug>; constrained by the credential." }) },
  },
  {
    name: "takes_update",
    scope: "write",
    outputRedaction: "retrieval",
    description: "Patch a canonical takes row at the required page version; retain unrelated bytes/rows and holder. Changed claims clear old resolution. dry_run previews; plan_hash pins it. Static public forbidden.",
    params: { ...takeWriteParams, row_num: int({ ...req, minimum: 1, maximum: 2147483647 }),
      ...takeFields, active: bool({ description: "False retracts the row using strikethrough; true reactivates it." }) },
  },
  {
    name: "takes_resolve",
    scope: "write",
    outputRedaction: "retrieval",
    description: "Resolve an active take atomically in its page/ledger. Requires current version and holder permission; actor/time are server-set. dry_run previews; plan_hash pins the request, but apply's timestamp may change after_hash. Static public forbidden.",
    params: { ...takeWriteParams, row_num: int({ ...req, minimum: 1, maximum: 2147483647 }),
      quality: str({ ...req, enum: ["correct", "incorrect", "partial", "unresolvable"] }),
      evidence: str({ description: "Single-line evidence, up to 4000 Unicode code points." }),
      value: num({ description: "Finite numeric result, preserved without display rounding." }), unit: str() },
  },
  {
    name: "takes_search",
    outputRedaction: "retrieval",
    description:
      "Fuzzy-search synthesized 'takes' by claim text (pg_trgm similarity + substring fallback), ranked best-match first: take_key, claim_text, kind, weight, domain, status. Read-only; internal-only.",
    params: {
      q: str({ ...req, description: "Claim text to match." }),
      limit: int({ minimum: 1, maximum: 200, description: "Max rows (default 50)." }),
    },
  },
  {
    name: "get_calibration_profile",
    outputRedaction: "retrieval",
    description:
      "The latest narrative calibration/bias profile (from the calibration-profile phase): grade tallies, accuracy, pattern statements, bias tags. Read-only; internal-only. Null when no profile has been generated yet.",
    params: {},
  },
  {
    name: "takes_scorecard",
    outputRedaction: "retrieval",
    description:
      "Read latest grades of synthesized takes: total/graded/resolved, verdict counts, accuracy=correct/(correct+incorrect), partial_rate, Brier score over correct/incorrect bets versus stated weight. Zero before opt-in grading. Filter domain/holder and generated since/until; source and holder grants apply. Internal-only, no LLM.",
    params: {
      domain: str({ description: "Filter to takes tagged with this domain." }),
      holder: str({ description: "Filter to this holder (world|brain|<slug>). Still gated by the token's takes-holder allow-list." }),
      since: str({ description: "Only takes generated on/after this ISO date (YYYY-MM-DD)." }),
      until: str({ description: "Only takes generated on/before this ISO date (YYYY-MM-DD)." }),
    },
  },
  {
    name: "takes_calibration",
    outputRedaction: "retrieval",
    description:
      "Reliability buckets for latest correct/incorrect take grades: observed hit-rate vs mean stated weight. bucket_size in (0,1], default .1. Empty before grading. Filter domain/holder within source/holder grants. Internal-only, read-only, no LLM.",
    params: {
      bucket_size: num({ minimum: 0, maximum: 1, description: "Bucket width in (0,1]. Default 0.1." }),
      domain: str({ description: "Filter to takes tagged with this domain." }),
      holder: str({ description: "Filter to this holder (world|brain|<slug>). Still gated by the token's takes-holder allow-list." }),
    },
  },
  {
    name: "extract_facts",
    scope: "write",
    description:
      "Extract events, preferences, commitments and beliefs from text OR a source_ref page in your grant. Preview by default; persist:true needs write scope and stores rows in your source. entity_hints steer extraction; session_id and visibility stamp stored facts. Input is sanitized and DATA-fenced. Paid, budget-guarded Bedrock; returns enabled:false unless MEMRAIN_FACTS_EXTRACTION=1. Internal-only.",
    params: {
      text: str({ description: "Raw conversation/transcript text to extract from. Provide this OR `source_ref`." }),
      source_ref: str({ description: "A page slug whose markdown_body is extracted (tenant-scoped). Provide this OR `text`." }),
      persist: bool({ description: "Write the extracted facts to the ledger (default false = preview only). Requires a write grant." }),
      entity_hints: str({ description: "Comma/space-separated canonical entity slugs to steer the extractor." }),
      session_id: str({ description: "Capture-session id stamped on persisted facts." }),
      visibility: str({ enum: ["private", "world"], description: "Default visibility for persisted facts (default private)." }),
    },
  },
  {
    name: "list_skills",
    description:
      "Find skills in this brain's local pack by task. With query, rank by slug, description and triggers (exact slug first), returning up to 5 by default. Without arguments, return the full byte-ordered catalog. Each entry includes triggers, tools split into usable_tools/unavailable_tools for your grant, mutating, requires and writes_to. Fetch a match with get_skill. Read-only; no LLM.",
    params: {
      query: str({ description: "Task or skill name, at most 200 characters." }),
      limit: int({ minimum: 1, maximum: 50, description: "Maximum skills; default 5 with query, otherwise all." }),
    },
  },
  {
    name: "get_skill",
    outputRedaction: "retrieval",
    description:
      "Fetch one brain-resident skill's full markdown body by slug (as returned by list_skills). Returns {slug, description, body, frontmatter, usable_tools, unavailable_tools}, or an error when the slug is unknown. Read-only; no LLM.",
    params: {
      name: str({ ...req, description: "Skill slug exactly as returned by list_skills." }),
    },
  },
  {
    name: "get_recent_transcripts",
    outputRedaction: "retrieval",
    description:
      "Recently-ingested conversation transcript pages (types: meeting, email, journal, note), newest-first, within a day window. Returns each page's slug/type/title/updated_at plus a summary (first ~300 chars) or — with summary=false — the body capped at 100 KB. Tenant-scoped; limit-capped (default 50, max 200). Surfaces page bodies — hidden from public ingress. Read-only; no LLM.",
    params: {
      days: int({ minimum: 0, description: "Only pages updated within the last N days. Default 30." }),
      summary: bool({ description: "true (default) returns a ~300-char summary; false returns the body capped at 100 KB." }),
      limit: int({ minimum: 1, maximum: 200, description: "Max rows (default 50)." }),
    },
  },
  {
    name: "think",
    scope: "write",
    description:
      "Multi-hop cited synthesis from pages, takes, graph and trajectories, with conflicts/gaps. Paid, budget-guarded Sonnet; default-off (ran:false unless MEMRAIN_THINK=1). save writes synthesis/<slug> + evidence; take queues its anchor-pinned headline. Both are operator-only, silently ignored otherwise. rounds 1..3 feeds gaps into scoped retrieval. synthesis_status: ok/empty_answer/not_json/output_truncated/no_llm/model_unusable/llm_error. Failed composition over gathered pages keeps synthesis:null and adds a cited extractive fallback (kind:extractive, no model call, never saved).",
    params: {
      question: str({ ...req, description: "The question to think about." }),
      anchor: str({ description: "Pull the entity subgraph + trajectory around this slug (required for take:true)." }),
      rounds: int({ minimum: 1, maximum: 3, description: "Gather/synthesize rounds; each extra round is a fresh paid call under the run budget. Default 1." }),
      save: bool({ description: "Persist the synthesis as a page + evidence rows. Operator-only; ignored otherwise." }),
      take: bool({ description: "Queue the answer's headline claim as a synth_take on `anchor`. Operator-only; ignored otherwise." }),
      model: str({ description: "Model id override for the synthesis call." }),
      since: str({ description: "Only gather pages whose content date is >= this ISO date." }),
      until: str({ description: "Only gather pages whose content date is <= this ISO date." }),
      with_calibration: bool({ description: "Inject the calibration anti-bias block (opt-in)." }),
      k: int({ minimum: 1, maximum: 50, description: "Page hits to gather (default 12)." }),
      max_takes: int({ minimum: 1, maximum: 100, description: "Take rows to gather (default 20)." }),
      reference_date: str({ description: "The day to treat as today when reading relative dates in the question (YYYY-MM-DD, not in the future). Default: today in the brain's time zone." }),
    },
  },
  {
    name: "put_raw_data",
    scope: "write",
    description:
      "Upsert a page payload keyed by (slug,source), REPLACING the prior payload, not keeping history; max 1 MB. source is a data-provider/importer label, not tenant ownership. Requires a live page (else not_found) in the caller’s write source. Write; public forbidden.",
    params: {
      slug: str({ ...req, description: "The owning page slug; must be a live page." }),
      source: str({ ...req, description: "Data-source label, e.g. an importer name." }),
      data: obj({ ...req, description: "The raw payload (plain JSON object, <= 1 MB serialized)." }),
    },
  },
  {
    name: "get_raw_data",
    outputRedaction: "retrieval",
    description:
      "Read a page's raw_data sidecar rows, newest first. Optional `source` filter to one data-source label; `limit` (1..200, default 50). Tenant-scoped via the owning page. Read-only; no LLM.",
    params: {
      slug: str(req),
      source: str({ description: "Filter to one data-source label." }),
      limit: int({ minimum: 1, maximum: 200 }),
    },
  },
  {
    name: "log_ingest",
    scope: "write",
    description:
      "Append one ingestion-event row to the audit log (importer/webhook runs, absorb outcomes). Stamped with the caller's write source. WRITE.",
    params: {
      source_type: str({ ...req, description: "Event family, e.g. 'facts:absorb' or an importer name." }),
      source_ref: str({ ...req, description: "What was ingested (path, URL, slug)." }),
      pages_updated: arr({ description: "Slugs touched by the run (array of strings)." }),
      summary: str({ description: "One-line human outcome summary." }),
    },
  },
  {
    name: "get_ingest_log",
    outputRedaction: "retrieval",
    description:
      "Recent ingestion-log entries, newest first, scoped to the caller's read set. Optional `source_type` filter; `limit` (1..50, default 20). Read-only; no LLM.",
    params: {
      source_type: str({ description: "Filter to one event family." }),
      limit: int({ minimum: 1, maximum: 50 }),
    },
  },
  {
    name: "retry_job",
    scope: "write",
    description:
      "Re-queue a failed or cancelled job for another attempt (status -> pending, next_attempt_at = now). Returns the refreshed row, or found:false when the id is unknown or the job is not in a retryable state. Operator-only. WRITE — refused on public ingress.",
    params: {
      id: str({ ...req, description: "Job id (see jobs_list)." }),
    },
  },
  {
    name: "get_job_progress",
    outputRedaction: "retrieval",
    description:
      "Read a job's live progress envelope: status + the handler-reported `progress` JSON (mig083). Cheap poll target while a long job runs. Operator-only; read-only.",
    params: {
      id: str({ ...req, description: "Job id (see jobs_list)." }),
    },
  },
  {
    name: "sources_list",
    description:
      "List registered sources (id, kind, path_prefix, policies, boost weight). A scoped caller sees ONLY the sources its grant covers; the operator sees all. Read-only; no LLM.",
    params: {
      kind: str({ description: "Filter by source kind." }),
    },
  },
  {
    name: "sources_status",
    description:
      "Per-source diagnostic: the source row plus its live health (document/chunk counts, embed coverage, staleness lag, failed jobs). A scoped caller may only query a source inside its grant. Read-only; no LLM.",
    params: {
      id: str({ ...req, description: "Source id." }),
    },
  },
  {
    name: "get_status_snapshot",
    outputRedaction: "retrieval",
    description:
      "One-shot operational snapshot for thin-client status: version, corpus stats, brain health (embed coverage, staleness, job queue), query-cache state, and the active job worker lock. Operator-only (exposes whole-brain operational state); read-only; no Bedrock.",
    params: {},
  },
  {
    name: "run_doctor",
    description:
      "Run the thin-client brain health checks and return a structured report: config-free engine checks only (stats, embed coverage/staleness, tenancy/federation health, OAuth client hygiene, source routing, job worker liveness). Operator-only; read-only; never mutates; no LLM.",
    params: {},
  },
  // --- Life Chronicle: timeline reads + per-entity dimensional ontology -------
  // Reads project event pages (life/events/…) into a day/week/since/on-this-day
  // timeline; the ontology surfaces sourced, bi-temporal dimension=value claims
  // per entity. Diary interiority (life/diary/…) is never mined here and is
  // stripped for non-operator callers. The whole surface is internal-only (see
  // FORBIDDEN_MCP_TOOLS_FROM_PUBLIC) — the public bearer reaches none of it.
  {
    name: "chronicle_day",
    outputRedaction: "retrieval",
    description:
      "Life-chronicle timeline for one UTC calendar day (or the ISO week containing it, with `week:true`). Returns the projected events — each a summary/detail joined to its depth page and, for an event projection, the event kind. `narrative:true` also returns a day-by-day prose rendering. Tenant-scoped. Read-only; no LLM.",
    params: {
      date: str({ ...req, description: "UTC calendar day, YYYY-MM-DD." }),
      week: bool({ description: "Expand to the ISO week (Mon–Sun) containing `date`." }),
      kind: str({ description: "Filter event projections by event.kind (e.g. 'meeting')." }),
      narrative: bool({ description: "Also return a readable day-by-day prose summary." }),
      limit: int({ minimum: 1, maximum: 1000, description: "Max events (default 200)." }),
    },
  },
  {
    name: "chronicle_since",
    outputRedaction: "retrieval",
    description:
      "Life-chronicle events on or after a date, oldest-first. Returns the projected timeline rows. Tenant-scoped. Read-only; no LLM.",
    params: {
      since: str({ ...req, description: "Lower-bound UTC date, YYYY-MM-DD (inclusive)." }),
      kind: str({ description: "Filter event projections by event.kind." }),
      limit: int({ minimum: 1, maximum: 1000, description: "Max events (default 20)." }),
    },
  },
  {
    name: "chronicle_on_this_day",
    outputRedaction: "retrieval",
    description:
      "Life-chronicle 'on this day': events from the same month+day in prior years, most-recent-first. `date` defaults to today (UTC). Tenant-scoped. Read-only; no LLM.",
    params: {
      date: str({ description: "Target day, YYYY-MM-DD. Defaults to today (UTC)." }),
      limit: int({ minimum: 1, maximum: 1000, description: "Max events (default 50)." }),
    },
  },
  {
    name: "chronicle_last_seen",
    outputRedaction: "retrieval",
    description:
      "When an entity last appeared in the life chronicle — the most recent timeline day its own page or an event's `who` array references it, plus days_ago. Tenant-scoped. Read-only; no LLM.",
    params: {
      entity: str({ ...req, description: "Entity slug (e.g. people/alice) or name to match." }),
    },
  },
  {
    name: "ontology_get",
    outputRedaction: "retrieval",
    description:
      "The live per-dimension ontology for an entity: the current value on each axis (role, employer, location, …), confidence, provenance, and bi-temporal validity. `asof` time-travels to a past date; `min_confidence` floors the rows; `include_quarantined` surfaces novel/unconfirmed dimensions. Non-operator callers see world-visible rows only and never diary-sourced values. Tenant-scoped. Read-only; no LLM.",
    params: {
      entity: str({ ...req, description: "Entity slug (e.g. people/alice)." }),
      asof: str({ description: "Resolve the ontology as of this YYYY-MM-DD (valid-time travel)." }),
      min_confidence: num({ minimum: 0, maximum: 1, description: "Drop rows below this confidence." }),
      include_quarantined: bool({ description: "Include quarantined (novel/unconfirmed) dimensions." }),
    },
  },
  {
    name: "ontology_propose",
    scope: "write",
    description:
      "Record a dimensional observation about an entity (entity has dimension=value, e.g. role=advisor). Sourced, confidence-weighted, and bi-temporal: a novel dimension lands quarantined, a same-value re-observation corroborates, a different value supersedes forward (or closes a backdated interval). WRITE — refused on public ingress.",
    params: {
      entity: str({ ...req, description: "Entity slug the claim is about (e.g. people/alice)." }),
      dimension: str({ ...req, description: "Axis name (e.g. role, employer, location)." }),
      value: str({ ...req, description: "The value on that axis." }),
      source: str({ description: "Provenance page slug (source_slug); omit for a manual claim." }),
      confidence: num({ minimum: 0, maximum: 1, description: "0..1, default 0.7." }),
      valid_from: str({ description: "Start of validity, YYYY-MM-DD. Default today; null = -infinity." }),
      visibility: str({ enum: ["private", "world"], description: "Row visibility (default private)." }),
    },
  },
  {
    name: "ontology_dimensions",
    outputRedaction: "retrieval",
    description:
      "Which dimension axes exist across the (scoped) corpus and how heavily each is used — [{dimension, entities, observations}], busiest first. Tenant-scoped. Read-only; no LLM.",
    params: {},
  },
  {
    name: "ontology_conflicts",
    outputRedaction: "retrieval",
    description:
      "Entities whose currently-open observations on one dimension disagree — at least two distinct values from at least two distinct sources. For non-operator callers, diary-sourced values are stripped and a conflict that no longer disagrees after that stripping is dropped. Tenant-scoped. Read-only; no LLM.",
    params: {
      min_confidence: num({ minimum: 0, maximum: 1, description: "Floor the observations considered." }),
    },
  },
  {
    name: "volunteer_chronicle",
    outputRedaction: "retrieval",
    description:
      "Push-based chronicle context: the recent timeline plus the validity-resolved ontology for the named entities, composed with zero LLM. Non-operator callers get a redacted view (diary-sourced + private-visibility ontology stripped). Tenant-scoped. Read-only; no LLM.",
    params: {
      days: int({ minimum: 1, maximum: 50, description: "Lookback window for the recent timeline (default 7, cap 50)." }),
      entities: arr({ description: "Entity slugs to resolve current ontology for (array or comma-separated string)." }),
    },
  },
  {
    name: "chronicle_backfill",
    scope: "write",
    description:
      "Enqueue one paid chronicle-extract job per eligible scoped conversation page, excluding diary/events. Returns pages_enqueued and per-page MEMRAIN_CHRONICLE_WRITE_BUDGET_USD for worst-case spend. dry_run:true counts only. Operator-only write; public forbidden.",
    params: {
      dry_run: bool({ description: "Count eligible pages without enqueuing (default false)." }),
      limit: int({ minimum: 1, maximum: 500, description: "Max pages to sweep (default 100, hard cap 500)." }),
    },
  },
];

/**
 * Tools that require a write source grant — DERIVED from each op's `scope: "write"`
 * field (the single source of truth). A public caller with no write source is
 * denied these at the dispatch write-scope gate. Previously a hand-maintained Set
 * in dispatch.ts; deriving it from the op removes the parallel-list drift risk
 * (a new write op could be added to OPERATIONS but forgotten in the Set). The
 * dispatch gate imports this instead of keeping its own copy.
 */
export const WRITE_SCOPED_TOOLS: ReadonlySet<string> = new Set(
  // Admin-scoped mutations (purge_deleted_pages) are included: the fail-closed
  // write gate must reject a scopeless authenticated public principal for them
  // too, before the per-op scope gate even runs.
  OPERATIONS.filter((op) => op.scope === "write" || op.scope === "admin").map(
    (op) => op.name,
  ),
);

/**
 * Tools that change state although the per-op scope gate files them under
 * `read` or `agent`. The jobs_* mutators are operator-only (dispatch's
 * OPERATOR_ONLY_TOOLS), and submit_agent queues paid work; none of them may be
 * advertised as read-only, or a client would auto-approve them.
 */
const MUTATING_OUTSIDE_WRITE_SCOPE: ReadonlySet<string> = new Set([
  "jobs_submit",
  "jobs_cancel",
  "daemons_control",
  "submit_agent",
]);

/** Mutating tools that delete or overwrite, as opposed to purely adding. */
const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  "takes_update",
  "takes_resolve",
  "page_rename",
  "index",
  "page_put",
  "page_edit",
  "page_delete",
  "page_revert",
  "unlink",
  "remove_tag",
  "forget_fact",
  "purge_deleted_pages",
  "jobs_cancel",
  "put_raw_data",
]);

/** Mutating tools whose description promises a repeat call changes nothing. */
const IDEMPOTENT_TOOLS: ReadonlySet<string> = new Set([
  "page_put",
  "page_delete",
  "page_restore",
  "link",
  "unlink",
  "add_tag",
  "remove_tag",
  "forget_fact",
  "set_take_status",
  "put_raw_data",
]);

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

/**
 * MCP tool annotations, derived from the op's scope so a client's
 * confirm-before-write behaviour follows the same classification the dispatch
 * gates enforce. Every tool works on this brain only, hence `openWorldHint`
 * false. The destructive/idempotent hints are only meaningful on a mutating
 * tool, so a read-only one carries neither.
 */
export function operationAnnotations(op: Operation): ToolAnnotations {
  const mutating =
    op.scope === "write" || op.scope === "admin" || MUTATING_OUTSIDE_WRITE_SCOPE.has(op.name);
  if (!mutating) return { readOnlyHint: true, openWorldHint: false };
  return {
    readOnlyHint: false,
    destructiveHint: DESTRUCTIVE_TOOLS.has(op.name),
    ...(IDEMPOTENT_TOOLS.has(op.name) ? { idempotentHint: true } : {}),
    openWorldHint: false,
  };
}
