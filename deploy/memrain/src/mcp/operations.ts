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
    `${named.join(" ")}${more} ${accepted}`,
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

/** Upper bound on `request_id` length (checked by the dispatch handler). */
export const MAX_REQUEST_ID_LEN = 128;

const expectedVersionParam = int({
  minimum: 0,
  description:
    "Write only if the page is still at this version (`version` from page_get, or the top version_n from page_versions); 0 = the page must not exist yet. A deleted page keeps its version counter, so to write over one pass the current_version a 0 attempt reports. On a mismatch nothing is written and the error names the current version. Omit for an unconditional write.",
});
const forceParam = bool({
  description:
    "Overwrite unconditionally, on purpose. Cannot be combined with expected_version.",
});
const requestIdParam = str({
  description:
    `Optional caller-chosen id for this write (1-${MAX_REQUEST_ID_LEN} chars). Retrying with the same id and the same arguments returns the first call's result with \`replayed: true\` and writes nothing; the same id with different arguments is refused. Remembered for 7 days.`,
});

export const OPERATIONS: readonly Operation[] = [
  {
    name: "search",
    description:
      "Hybrid (vector + keyword) search over the indexed corpus. Returns ranked chunks with their parent document path and title. Optional filters (lang / symbol_kind / since / until) are applied post-ranking and bypass the query cache. Has no `expand` knob, and LLM query expansion is off in the default mode bundles — for a concept or landscape question ('everything about X', 'who works on Y'), escalate to `query` with `expand:true`, which widens the keyword arm with generated variants. A nonzero hit count here is not proof that the corpus was exhausted. The response carries `meta`: `vectorEnabled` plus `degraded[]` reason codes (embed_timeout, vector_arm_failed, keyword_zero, budget_truncated, vector_candidates_incomplete) that tell an empty brain from a degraded run; non-public callers also get intent, mode, cache, retrieved and returned.",
    argAliases: { query: "q", limit: "k" },
    params: {
      q: str({ ...req, description: "Natural-language query." }),
      k: int({ minimum: 1, maximum: 100, description: "Number of hits to return. Default 20." }),
      token_budget: int({
        minimum: 1,
        maximum: 200000,
        description:
          "Optional cap on total returned content size (~chars/4 tokens). Hits are kept in rank order; the overflowing tail hit is truncated. Unset = no cap.",
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
          "Keep only hits whose content date COALESCE(effective_date, updated_at) is <= this bound: an ISO-8601 date/datetime (a plain YYYY-MM-DD includes that whole day), or a relative duration like '7d' / '2w' / '6m' / '1y' (back from now).",
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
      "Per-source (per-tenant) operational health: for each source_id it returns document_count, chunk_count, embed coverage (embedded/embeddable chunks, code excluded), and staleness lag. Answers 'which source is broken?' when one tenant's ingestion/embedding stalls. A scoped caller sees only its granted sources' rows (the NULL-source '(unclassified)' bucket is visible to a local/unscoped caller only); an unscoped local caller also gets the whole-brain `health` roll-up. Read-only; cheap; no Bedrock.",
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
    scope: "write",
    description:
      "Create or update a page in the DB-canonical store. Idempotent: re-putting identical content is a no-op. Each real change appends a row to page_versions. Search sees the page once its search mirror is written: by default before this returns (`search_indexed`). When the operator has moved the mirror to a background job, the response carries `search_pending: true` and `search_job_id` instead, and search sees the page once that job runs, normally within seconds. Pass `wait_for_index: true` when you need to search for the page straight away. To change part of a page, prefer page_edit. When the operator sets MEMRAIN_REQUIRE_WRITE_PRECONDITION, overwriting a live page without `expected_version` (or `force: true`) either adds a `warnings` entry or is refused with `precondition_required` and the page's `current_version`. WRITE — refused on public ingress unless the operator sets MEMRAIN_PUBLIC_WRITE=1.",
    params: {
      slug: str({
        ...req,
        description:
          "kebab-case identifier with optional `/` namespaces (e.g. people/alice, journal/2026/05/2026-05-18).",
      }),
      type: str({
        description:
          "One of: concept, person, company, meeting, idea, journal, note, email, event, decision, task, source. OPTIONAL — inferred from the slug's first segment (people/… → person) when omitted, defaulting to note. Pass allowAdHocType=true to accept other types.",
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
      "Append text to an existing page's markdown_body. Creates a new page_versions row. Requires the page to exist (use page_put for first write). Search sees the page once its search mirror is written: by default before this returns (`search_indexed`). When the operator has moved the mirror to a background job, the response carries `search_pending: true` and `search_job_id` instead, and search sees the page once that job runs, normally within seconds. Pass `wait_for_index: true` when you need to search for the page straight away. WRITE — refused on public ingress unless the operator sets MEMRAIN_PUBLIC_WRITE=1.",
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
    scope: "write",
    description:
      "Change part of an existing page without resending it: apply 1 to 50 exact-text replacements `{old_text, new_text}` to its markdown_body, in order, each to the text the previous one left. Each old_text must occur exactly once in the page (copy it from page_get, whitespace included); otherwise nothing is written and the error says which edit failed (`edit_no_match`, `edit_ambiguous_match`). The facts and takes fences are protected: an edit that touches one, or writes a fence marker, is refused (`edit_protected_span`) — use add_fact / forget_fact and the takes tools for those. `expected_version` is required (`version` from page_get); a page that changed since is refused with `version_conflict` and its current version. Title and frontmatter are kept. Returns the new version and a unified diff of the change (cut at 8 KB, `diff_truncated`). Search sees the change as for page_put (`search_indexed`, or `search_pending` + `search_job_id`; `wait_for_index: true` to wait). WRITE — refused on public ingress unless the operator sets MEMRAIN_PUBLIC_WRITE=1.",
    params: {
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
    name: "page_delete",
    scope: "write",
    description:
      "Soft-delete a page (sets deleted_at; the row + page_versions chain stays for audit). Idempotent. WRITE — static public bearer: forbidden; authenticated token: requires the `write` scope (source-scoped); internal token: allowed.",
    params: {
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
      "Roll a page's body back to a prior page_versions snapshot. Creates a NEW version with the old content (history is append-only). `version` is the target version_n (see page_versions). WRITE — static public bearer: forbidden; authenticated token: requires the `write` scope (source-scoped); internal token: allowed.",
    params: {
      slug: str(req),
      version: int({ ...req, minimum: 1 }),
      written_by: str(),
      expected_version: expectedVersionParam,
      force: forceParam,
    },
  },
  {
    name: "page_get",
    description:
      "Read a page by slug. Returns an error if the page does not exist. `fuzzy:true` falls back to fuzzy slug resolution on a miss (a unique candidate is auto-read; multiple candidates return `ambiguous_slug` + the list). `include_deleted:true` surfaces a soft-deleted page with deleted_at populated (restore workflows). The response carries `version`, the page's current version number — pass it as `expected_version` to a later page_put, page_revert or page_delete to write only if nobody changed the page in between.",
    params: {
      slug: str(req),
      fuzzy: bool({ description: "Fuzzy slug resolution on a miss (default false)." }),
      include_deleted: bool({ description: "Surface soft-deleted pages (default false)." }),
    },
  },
  {
    name: "page_list",
    description:
      "List pages, newest-first by default. Optional filters: `type`, `tag` (normalized), `since` (ISO timestamp), `limit` (1..100, default 50). `sort` picks the order (updated_desc default | updated_asc | created_desc | slug); `include_deleted:true` adds soft-deleted pages with deleted_at populated.",
    argAliases: {
      prefix: { hint: "page_list has no prefix filter; filter by `tag`, or find pages with `search`." },
    },
    params: {
      type: str(),
      since: str(),
      tag: str({ description: "Filter to pages carrying this tag." }),
      sort: str({ enum: ["updated_desc", "updated_asc", "created_desc", "slug"] }),
      include_deleted: bool({ description: "Include soft-deleted pages (default false)." }),
      // Clamp: list_pages caps at 100 (default 50) — a 1000-row
      // window is a needless enumeration amplifier for scoped tokens.
      limit: int({ minimum: 1, maximum: 100 }),
    },
  },
  {
    name: "page_versions",
    description:
      "Read the edit history of a page, newest-first. Includes body snapshots and compiled_truth snapshots at every revision. The operator and admin-scoped callers also see `written_by_principal`, the credential each version was written with (null for internal writes and versions older than the column).",
    params: {
      slug: str(req),
      limit: int({ minimum: 1, maximum: 200 }),
    },
  },
  {
    name: "link",
    scope: "write",
    description:
      "Assert a typed link from source_slug to target_slug. Idempotent on (source, target, type) — re-asserting updates confidence + chunk_id. Default confidence 1.0. WRITE — refused on public ingress unless the operator sets MEMRAIN_PUBLIC_WRITE=1.",
    params: {
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
      "Remove a typed link. Idempotent — returns removed=0 if no row matched. WRITE — static public bearer: forbidden; authenticated token: requires the `write` scope (source-scoped); internal token: allowed.",
    params: {
      source_slug: str(req),
      target_slug: str(req),
      type: str(req),
    },
  },
  {
    name: "graph_neighbors",
    description:
      "All links touching `slug` (outbound, inbound, or both), newest-first. Optional `type` filter. Returns the link rows with a per-row `direction` annotation.",
    params: {
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
    description:
      "Typed-relationship query. Requires `type` plus at least one of `source_slug` or `target_slug`. Examples: { type:'works_at', source_slug:'people/alice' } → companies Alice works at; { type:'works_at', target_slug:'companies/acme' } → people who work at Acme.",
    params: {
      type: str(req),
      source_slug: str(),
      target_slug: str(),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "traverse_graph",
    description:
      "Recursive N-hop graph walk from a start slug over the link graph — the multi-hop counterpart to graph_neighbors. Returns each reachable node once at its shortest `depth`. `direction` (outbound|inbound|both, default outbound), optional `type` edge filter, `max_depth` (1..10, default 3), `limit` (1..1000, default 100). Example: {start_slug:'people/alice', direction:'both', max_depth:2} → everyone within 2 hops of Alice.",
    params: {
      start_slug: str(req),
      direction: str({ enum: ["outbound", "inbound", "both"] }),
      type: str(),
      max_depth: int({ minimum: 1, maximum: 10 }),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "add_fact",
    scope: "write",
    description:
      "Append a fact about an entity to the entity_facts ledger. Corrections are new facts, never edits — but restating a claim you already wrote does NOT mint a duplicate: an identical claim about the same entity, from the same source and the same writer, refreshes the row on file and returns its id with `inserted: false`. A claim that differs in any of those is a new row. A claim forgotten with `forget_fact` stays forgotten: re-adding it for the same entity, source and visibility (whitespace and case do not matter) writes nothing and returns `withdrawn: true` with `id: null`. `visibility` decides who can read the fact back: it defaults to `private`, which only the operator can read, so a tenant-scoped caller that wants to recall its own write must pass `visibility: 'world'`. Provenance is recorded on every fact: name `source_slug`, `source_chunk_id` or `written_by` to say where the claim came from, and if you name none the fact is credited to your own caller identity — an unattributed fact cannot be audited or aged against its origin; a public caller cannot set `written_by` at all, since that is the audit field. Pass `replaces: <fact_id>` to retire one of your live facts in favour of this one (it is marked superseded, not withdrawn; the response says `replaced: true|false`). To save several facts in one call pass `items` instead of `fact`: up to 20 objects `{fact, entity_slug?, confidence?, visibility?, replaces?}`, with the top-level `entity_slug`, `confidence`, `visibility`, `source_slug`, `source_chunk_id` and `written_by` as defaults; every item is checked before any is written, and the response lists each item's outcome with `saved`, `failed` and `partial`. `items` and `replaces` are refused on the public ingress. WRITE — internal by default, and reachable from the public ingress only when `MEMRAIN_PUBLIC_WRITE=1` is set.",
    params: {
      entity_slug: str({
        description:
          "The entity the fact is about (e.g. `people/alice`). Soft reference — the entity's page need not exist yet. Required unless every `items` entry names its own.",
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
          "Several facts in one call, 1 to 20 objects `{fact, entity_slug?, confidence?, visibility?, replaces?}`. Replaces `fact`.",
      }),
    },
  },
  {
    name: "add_timeline_event",
    scope: "write",
    description:
      "Append a timeline event to an existing page. Append-only. Idempotent on (slug, occurred_at, source_chunk_id) when source_chunk_id is provided. WRITE — refused on public ingress unless the operator sets MEMRAIN_PUBLIC_WRITE=1.",
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
    description:
      "List facts about an entity, ordered by confidence (default) or recency. `entity_slug` is OPTIONAL: omit it for a cross-entity recall (\"what did I learn recently / this session\") across all entities. Optional `since` filter on written_at and `source_slug` filter to narrow to facts derived from a single page. Lifecycle filters (mig085): `session` (capture-session id), `grep` (case-insensitive substring on the fact text), `visibility` (private|world), `include_forgotten` (surface tombstoned rows for audit; internal callers only — forced off on public ingress).",
    params: {
      entity_slug: str({ description: "Entity to scope to. Omit for a cross-entity recall." }),
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
    description:
      "One-shot 'what do I know about X?' aggregator. Returns the entity's page (compiled_truth + body) plus top-confidence facts plus most-recent timeline events in a single call. The page may be null when the entity exists only as a soft-stub (facts + timeline allowed, page not yet promoted).",
    argAliases: { entity: "slug" },
    params: {
      slug: str(req),
      query: str({
        description:
          "Optional topic to focus the recalled facts on (e.g. 'funding history'). When set, the entity's facts are ranked by semantic similarity to it instead of by confidence. Falls-open: reverts to confidence order when embedding is unavailable.",
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
          "Cap the whole response — page, facts and timeline together — at roughly this many tokens, counting each row as it is serialized rather than its headline text alone. The split is decided server-side and unused allocation flows to the arms that have content, so an all-facts entity spends the budget on facts instead of stranding the page share. The page body is cut to fit rather than emitted whole. The response then carries a `budget` object — `facts_dropped`, `timeline_dropped`, `page_truncated`, and `page_dropped` (the page did not fit at all, so `page: null` here means 'did not fit', not 'no page exists') — so a partial view is never mistaken for a complete one. Applied after redaction, so the counts describe what you can see.",
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
    description:
      "Get the full detail of a job including payload, result, children, and unread child-done inbox count.",
    params: { id: str(req) },
  },
  {
    name: "jobs_logs",
    description:
      "Compact log view of a job: status, retries, last_error, children count + status breakdown, unread inbox count. Designed to fit in a single chat reply.",
    params: { id: str(req) },
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
    description:
      "Status and answer of an agent job you submitted with submit_agent: status, stop_reason, final_text, cost_usd, turns and an error when it failed. A job that is not yours reads as not found.",
    scope: "agent",
    params: { job_id: str(req) },
  },
  {
    name: "get_chunks",
    description:
      "Return a page's (or document's) content chunks in order. Pass `slug` (resolved through the page's page://<slug> search mirror) or `source_path` (a raw document). At least one is required; chunks come back ordered by chunk_index.",
    params: {
      slug: str(),
      source_path: str(),
    },
  },
  {
    name: "resolve_slugs",
    description:
      "Fuzzy-resolve a partial/informal string to canonical page slugs, ranked best-first (exact live-slug → score 1; else pg_trgm similarity over title + slug, soft-deleted excluded). Returns [{slug, title, score}].",
    argAliases: { slugs: "query" },
    params: {
      query: str(req),
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
    description:
      "List a page's tags in lexical order. Empty list for an unknown or untagged page.",
    params: { slug: str(req) },
  },
  {
    name: "relational_recall",
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
    description:
      "All typed edges touching `slug`, grouped by type and direction. An `outbound` group holds edges where the slug is the source; `inbound` where it is the target. Groups are ordered by type then outbound-before-inbound; edges within a group are newest-first. Optional `limit` (1..1000, default 1000) caps the edges scanned per direction.",
    params: {
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
    description:
      "Pages with zero inbound links — nothing in the graph references them. The natural enrichment targets (a page nobody links to is new or forgotten). Newest-first. Optional `type` page-type filter; `limit` (1..1000, default 50). Deterministic, no LLM.",
    params: {
      type: str({ description: "Restrict to a single page type (e.g. person)." }),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "find_experts",
    description:
      "Who knows about a topic — or the graph's hubs. With `topic`: person/company pages ranked by expertise (how strongly their body relates to the topic, via hybrid search) × relationship recency (6-month half-life) × salience. Without `topic`: pages ranked by graph link-degree (distinct live in+out neighbours; unresolved [[wikilink]] stubs don't inflate it). Optional `type` overrides the default person/company candidate set in topic mode, or filters the hub ranking; `limit` (1..200, default 5). Deterministic, no LLM.",
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
    description:
      "Conflicts in the brain, two ways. `contradictions`: page pairs joined by an explicit `contradicts` edge (markers already asserted in the graph). `probed`: LLM-suspected fact conflicts cached by the opt-in probe-contradictions cycle phase (severity/axis/confidence/resolution_command; empty until that phase has run). This tool only READS caches — it never calls an LLM itself. Optional `slug` substring filter (edges only, matches either side); `limit` (1..200, default 20).",
    params: {
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
    description:
      "Deterministic structural OUTLIERS over the live page graph. memrain has no retrieval/access counters, so this keys on the signals it does have: `degree_outlier` (a connectivity hub — link-degree at/above mean + sigma·stddev across live pages) and `stale_salient` (a high-salience page whose updated_at is older than staleDays — important memory gone cold). No LLM. Surfaces page slugs/titles — hidden from public ingress.",
    params: {
      sigma: num({ minimum: 0, description: "Std-devs above the mean degree to flag a hub (default 2)." }),
      staleDays: int({ minimum: 1, description: "Days an updated_at must lag to count a salient page stale (default 90)." }),
      salienceFloor: num({ minimum: 0, maximum: 1, description: "Salience floor for the stale_salient class (default 0.5)." }),
      limit: int({ minimum: 1, maximum: 200, description: "Max rows per anomaly kind (default 20)." }),
    },
  },
  {
    name: "recall",
    description:
      "Read ONE fact by its numeric id from the entity_facts ledger. Returns the fact row (claim, confidence, source, mig037 metadata). Returns an error if the id is unknown or the fact has been forgotten (tombstoned via forget_fact). NOT a search and not a list read — you need an id you already have. To find facts about an entity use `entity_facts`, to ask \"what do I know about X\" use `entity_recall`, and to search the corpus use `search`.",
    params: {
      id: int({ ...req, minimum: 1, description: "Fact id (entity_facts.id)." }),
    },
  },
  {
    name: "forget_fact",
    scope: "write",
    description:
      "Forget (soft-delete) a fact by id — stamps forgotten_at so the fact stops surfacing in recall; the row is retained for audit. The forget is durable: the claim is withdrawn for that entity, source and visibility, every other live copy of it is retired too (`withdrawn_duplicates` counts them), and a later re-add, re-extraction or transcript import of the same claim lands forgotten. There is no undo. Idempotent: a second forget is a no-op (forgotten=false), an unknown id reports found=false. Optional `reason` is stored on the tombstoned row. A forget that flipped a fact also returns `similar_active`: up to 5 other live facts about the same entity that read close to the withdrawn claim (fact ids and similarity scores only, no text) — rewordings the forget did not retire, worth confirming with the user before forgetting them too. WRITE — static public bearer: forbidden; authenticated token: requires the `write` scope (source-scoped); internal token: allowed.",
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
      "Introspect the CALLING identity: the client_id, granted OAuth scopes, the write source, and the read sources this token may see. Returns {client_id, scopes, write_source, read_sources, is_public, operator, bound_slug_prefixes, takes_holders, budget_usd_per_day, spent_today_usd, spend_id, callable_tools}. `read_sources` is null when the caller is unscoped (local CLI / internal token = whole-brain); the per-grant fields are null without a grant. `callable_tools` is exactly the set of tools this caller can call. Reveals only the caller's own auth context — no corpus. Cheap; no Bedrock. Useful for debugging the client_credentials multi-client setup.",
    params: {},
  },
  {
    name: "purge_deleted_pages",
    scope: "admin",
    description:
      "Admin escape hatch: HARD-delete pages whose deleted_at is older than `older_than_hours` (default 72). Cascades to page_versions / page_aliases / links via FK. The manual counterpart to the autopilot purge cycle phase. Returns the count + reaped slugs. WRITE — requires the `admin` scope (source-scoped) or the internal token; never reachable from the static public bearer. Scope split: delete_page = write, purge = admin.",
    params: {
      older_than_hours: num({
        minimum: 0,
        description: "Age cutoff in hours. Pages soft-deleted longer ago than this are reaped. Default 72.",
      }),
    },
  },
  {
    name: "query",
    description:
      "Flagship full-control retrieval: hybrid search over the corpus with every per-call knob exposed — `detail` result granularity (low = 1 chunk/page, medium = default dedup, high = all chunks + temporal treatment), `salience`/`recency` ranking bias (off|on|strong; omit = auto-detected from the query), `since`/`until` content-date window, `offset` pagination, `expand` LLM query expansion (paid; default follows the mode bundle), `mode` bundle override (operator-only), `adaptive_return` intent-sized tight result sets, plus the code filters (lang / symbol_kind / near_symbol / walk_depth). Legacy refinement: pass `refine` (+weights) for the deterministic weighted-RRF two-query blend instead. Without `refine` the response carries the same `meta` block as `search` (vector arm state, degraded reason codes, cache, retrieved/returned).",
    params: {
      q: str({ ...req, description: "Natural-language query." }),
      k: int({ minimum: 1, maximum: 100, description: "Number of hits to return. Default 20." }),
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
    description:
      "Call-graph: who calls the symbol `name`. Returns the `code-caller` mentions (surface form + chunk + source path) over the indexed code corpus. Deterministic, no LLM. An empty result carries `readiness: {state, code_documents, symbols}` for your sources, where state is `not_built` | `indexing` | `no_symbols` | `ready` (`ready` means the symbol really is absent). Optional `limit` (1..1000, default 200).",
    params: {
      name: str({ ...req, description: "Bare symbol name to find callers of (e.g. `hybridSearch`)." }),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "code_callees",
    description:
      "Call-graph: what the symbol enclosing `<path>:<line>` calls. Two-phase — resolves the innermost code-def covering that file:line, then returns its `code-callee` mentions. `resolved_symbol` reports which symbol was matched (null = none covers that line). Deterministic, no LLM. An empty result carries `readiness: {state, code_documents, symbols}` for your sources, where state is `not_built` | `indexing` | `no_symbols` | `ready` (`ready` means the symbol really is absent). Optional `limit` (1..1000, default 200).",
    params: {
      target: str({ ...req, description: "`<path>:<line>` of a call site / symbol body (e.g. `src/x.ts:42`)." }),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "code_def",
    description:
      "Where is the symbol `name` defined. Returns the `code-def` mentions (surface form + chunk + source path) for a bare symbol name across the indexed code corpus. Deterministic, no LLM. Complements `code_callers`/`code_callees` with 'where is X defined'. An empty result carries `readiness: {state, code_documents, symbols}` for your sources, where state is `not_built` | `indexing` | `no_symbols` | `ready` (`ready` means the symbol really is absent). Optional `limit` (1..1000, default 200).",
    params: {
      name: str({ ...req, description: "Bare symbol name to locate definitions of (e.g. `hybridSearch`, `Storage`)." }),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "code_refs",
    description:
      "All references to the symbol `name` — the `code-ref` mentions (imports, type uses, non-call references) over the indexed code corpus. Deterministic, no LLM. Complements `code_callers` (call sites) for proof-grade symbol tracing. An empty result carries `readiness: {state, code_documents, symbols}` for your sources, where state is `not_built` | `indexing` | `no_symbols` | `ready` (`ready` means the symbol really is absent). Optional `limit` (1..1000, default 200).",
    params: {
      name: str({ ...req, description: "Bare symbol name to find references to (e.g. `hybridSearch`)." }),
      limit: int({ minimum: 1, maximum: 1000 }),
    },
  },
  {
    name: "code_blast",
    description:
      "Blast radius: every transitive CALLER of `symbol`, grouped by hop depth (direct → 2-hop → 3-hop). Run before editing a function to size the change. BFS over the resolved code edge graph, bounded by `depth` (default 5, max 8) and `max_nodes` (default 200). Deterministic, no LLM. Returns {result, depth_groups?, cycles_detected?, truncation?, did_you_mean?, candidates?}. `result` is 'ok' | 'not_found' | 'ambiguous'. 'not_found', and 'ok' with empty `depth_groups`, carry `readiness: {state, code_documents, symbols}` for your sources, where state is `not_built` | `indexing` | `no_symbols` | `ready` (`ready` means the symbol really is absent).",
    params: {
      symbol: str({ ...req, description: "Bare or qualified symbol name (e.g. `performSync` or `Foo::performSync`)." }),
      depth: int({ minimum: 1, maximum: 8, description: "Hop cap. Default 5, max 8." }),
      max_nodes: int({ minimum: 1, maximum: 200, description: "Result-set cap. Default 200." }),
      exact: bool({ description: "Skip bare-name disambiguation; treat `symbol` as an exact qualified name." }),
    },
  },
  {
    name: "code_flow",
    description:
      "Execution flow: every transitive CALLEE reachable from the entry-point `symbol`, grouped by hop depth, with terminal side-effect tagging. Run to trace how a request flows to a DB write / HTTP call / file I/O. BFS over the resolved code edge graph, bounded by `depth` (default 8, max 12) and `max_nodes` (default 200). Deterministic, no LLM. Same envelope as `code_blast` plus `terminal_nodes: [{symbol, sink_kind}]` where sink_kind ∈ db_call|http_call|file_io|process_exec. 'not_found' and an empty 'ok' carry `readiness` like `code_blast`.",
    params: {
      symbol: str({ ...req, description: "Entry-point symbol name (bare or qualified)." }),
      depth: int({ minimum: 1, maximum: 12, description: "Hop cap. Default 8, max 12." }),
      max_nodes: int({ minimum: 1, maximum: 200, description: "Result-set cap. Default 200." }),
      exact: bool({ description: "Skip bare-name disambiguation; treat `symbol` as an exact qualified name." }),
    },
  },
  {
    name: "volunteer_context",
    description:
      "Push-based context: given a rolling conversation window, deterministically extract entity candidates, resolve them to existing page pointers (alias 0.9 / title 0.8 / slug-suffix 0.6, + a 0.05 boost for newest-turn or >=2-turn mentions), gate by confidence, cap to N, and return volunteered pages [{slug,title,display,confidence,arm,rationale,synopsis}]. No LLM, no Bedrock. Surfaces page slugs/titles + synopses — hidden from public ingress. Set `stats:true` for the per-arm used/volunteered precision feedback (approximate, derived from last_retrieved_at).",
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
    name: "context_pack",
    description:
      "Budgeted \"what matters now\" pack for the start of a turn: entity cards (title, type, top facts, recent events; no page body) for up to 8 standing entities — explicit `slugs` first, then entities resolved from an optional conversation `window` by the volunteer resolver at its default gate — followed by the top decayed facts across your grant, minus facts already on a card. Trimmed to `token_budget`, cards before facts; `budget` reports what was dropped. A slug you cannot see gives no card, exactly like a missing one. Read-only, stateless, no LLM. Internal-only.",
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
    description:
      "Ranked, read-only \"what to do next\" for this brain: pending migrations, version drift, stalled/failed jobs, low embedding coverage, and setup smells. Each finding has a severity (high/medium/low/info), a why-it-matters, and the exact fix command. Never mutates, never calls an LLM. Tell the user; ask before running any fix. Internal-only.",
    params: {},
  },
  {
    name: "list_brain_skillpack",
    description:
      "List the brain-resident skillpack this brain ships (the local deploy/skills pack) — the same catalog as list_skills: each skill's slug, description, triggers, declared tools split into `usable_tools` (callable by you) and `unavailable_tools`, and whether it mutates. Read-only. The skills are served, not installed: read one with get_skill (list_skills is the flat listing). On the host, `memrain skillpack` builds a tarball with a sha256 manifest for verification and `memrain skillpack lint` checks the pack against the real tools and commands.",
    params: {},
  },
  {
    name: "list_concepts",
    description:
      "List synthesized concept pages (LLM-derived from the corpus by the synthesize-concepts cycle phase): concept_slug, title, tier (T1/T2/T3), atom_count, narrative. Ordered by atom_count DESC. Read-only; internal-only (derived over private notes).",
    params: {
      limit: int({ minimum: 1, maximum: 200, description: "Max rows (default 50)." }),
    },
  },
  {
    name: "list_takes",
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
    name: "takes_search",
    description:
      "Fuzzy-search synthesized 'takes' by claim text (pg_trgm similarity + substring fallback), ranked best-match first: take_key, claim_text, kind, weight, domain, status. Read-only; internal-only.",
    params: {
      q: str({ ...req, description: "Claim text to match." }),
      limit: int({ minimum: 1, maximum: 200, description: "Max rows (default 50)." }),
    },
  },
  {
    name: "get_calibration_profile",
    description:
      "The latest narrative calibration/bias profile (from the calibration-profile phase): grade tallies, accuracy, pattern statements, bias tags. Read-only; internal-only. Null when no profile has been generated yet.",
    params: {},
  },
  {
    name: "takes_scorecard",
    description:
      "Calibration scorecard for synthesized takes graded by the opt-in take-grading phase: total/graded/resolved counts, per-verdict tallies (correct/incorrect/partial/unresolvable), accuracy (correct/(correct+incorrect)), partial_rate, and a Brier score over decided correct∨incorrect bets (stated weight vs outcome). Reads synth_takes × each take's LATEST synth_take_grades row — never calls an LLM. Zero scorecard until takes have been graded. Optional `domain` / `holder` filter and a `since`/`until` generated-date window; tenant-scoped via each take's source document, and a scoped token stays confined to its allowed holders. Read-only; internal-only.",
    params: {
      domain: str({ description: "Filter to takes tagged with this domain." }),
      holder: str({ description: "Filter to this holder (world|brain|<slug>). Still gated by the token's takes-holder allow-list." }),
      since: str({ description: "Only takes generated on/after this ISO date (YYYY-MM-DD)." }),
      until: str({ description: "Only takes generated on/before this ISO date (YYYY-MM-DD)." }),
    },
  },
  {
    name: "takes_calibration",
    description:
      "Reliability-diagram data for graded takes: decided (correct∨incorrect) bets binned by their stated weight, with observed hit-rate vs predicted (mean weight) per bucket — the curve behind the scorecard's Brier. `bucket_size` sets the bin width in (0,1] (default 0.1). Reads synth_takes × latest synth_take_grades; no LLM. Empty until takes are graded. Optional `domain` / `holder` filter; tenant-scoped. Read-only; internal-only.",
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
      "Extract personal-knowledge facts (events, preferences, commitments, beliefs) from conversation text on demand. Default is a PREVIEW (facts returned, nothing persisted); `persist:true` also writes them to the entity_facts ledger (requires a write grant; the caller's write source owns the rows). Pass `text` (raw turn/transcript) OR `source_ref` (an existing page slug whose body is read, tenant-scoped). `entity_hints` (comma/space-separated canonical slugs) steer the extractor; `session_id` + `visibility` stamp persisted facts (mig085). Sanitizes + DATA-fences the input, then calls the paid Bedrock extractor. PAID + default-OFF: returns {enabled:false} unless MEMRAIN_FACTS_EXTRACTION=1. Budget-guarded. Internal-only.",
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
      "Enumerate the brain-resident skillpack this brain ships (the local deploy/skills pack), byte-ordered: each skill's slug, description, `triggers`, declared `tools` split into `usable_tools` (callable by you) and `unavailable_tools`, `mutating`, `requires` and `writes_to`, plus routing `instructions`. Match the task against the triggers, then fetch the skill with get_skill. Read-only; no LLM.",
    params: {},
  },
  {
    name: "get_skill",
    description:
      "Fetch one brain-resident skill's full markdown body by slug (as returned by list_skills). Returns {slug, description, body, frontmatter, usable_tools, unavailable_tools}, or an error when the slug is unknown. Read-only; no LLM.",
    params: {
      name: str({ ...req, description: "Skill slug exactly as returned by list_skills." }),
    },
  },
  {
    name: "get_recent_transcripts",
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
      "Multi-hop synthesis across pages + takes + the entity graph: gathers evidence (hybrid search, take streams, anchor subgraph, trajectories) and produces a cited answer with conflict + gap analysis. PAID + default-OFF: returns {ran:false} unless MEMRAIN_THINK=1 (budget-guarded Sonnet). `save` persists a synthesis/<slug> page + evidence rows and `take` queues the headline claim as a synth_take pinned to `anchor` — both OPERATOR-ONLY (silently ignored for tenant/public callers). `rounds` (1..3) feeds each round's gaps back into retrieval. Tenant-scoped retrieval for scoped callers. Every result carries `synthesis_status` (ok, empty_answer, not_json, output_truncated, no_llm, model_unusable, llm_error), and a failed compose over gathered pages adds `fallback`, a cited extractive digest of those pages (kind:\"extractive\", no model call, never saved) while `synthesis` stays null.",
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
      "Attach a raw payload (API response, headers, importer sidecar) to a page, keyed (slug, source). Newest-wins upsert: re-putting the same key REPLACES the payload (a cache of the latest fetch, not a history). `source` is the DATA-source label ('crustdata', an importer name), NOT the tenant axis; a scoped caller may only attach to a page its own source owns. Payload capped at 1 MB. WRITE — refused on public ingress.",
    params: {
      slug: str({ ...req, description: "The owning page slug (must exist for scoped callers)." }),
      source: str({ ...req, description: "Data-source label, e.g. an importer name." }),
      data: obj({ ...req, description: "The raw payload (plain JSON object, <= 1 MB serialized)." }),
    },
  },
  {
    name: "get_raw_data",
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
    description:
      "Life-chronicle 'on this day': events from the same month+day in prior years, most-recent-first. `date` defaults to today (UTC). Tenant-scoped. Read-only; no LLM.",
    params: {
      date: str({ description: "Target day, YYYY-MM-DD. Defaults to today (UTC)." }),
      limit: int({ minimum: 1, maximum: 1000, description: "Max events (default 50)." }),
    },
  },
  {
    name: "chronicle_last_seen",
    description:
      "When an entity last appeared in the life chronicle — the most recent timeline day its own page or an event's `who` array references it, plus days_ago. Tenant-scoped. Read-only; no LLM.",
    params: {
      entity: str({ ...req, description: "Entity slug (e.g. people/alice) or name to match." }),
    },
  },
  {
    name: "ontology_get",
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
    description:
      "Which dimension axes exist across the (scoped) corpus and how heavily each is used — [{dimension, entities, observations}], busiest first. Tenant-scoped. Read-only; no LLM.",
    params: {},
  },
  {
    name: "ontology_conflicts",
    description:
      "Entities whose currently-open observations on one dimension disagree — at least two distinct values from at least two distinct sources. For non-operator callers, diary-sourced values are stripped and a conflict that no longer disagrees after that stripping is dropped. Tenant-scoped. Read-only; no LLM.",
    params: {
      min_confidence: num({ minimum: 0, maximum: 1, description: "Floor the observations considered." }),
    },
  },
  {
    name: "volunteer_chronicle",
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
      "Sweep conversation-shape pages in scope and enqueue a chronicle-extract job per eligible page (diary/event pages are skipped). Each enqueued page costs one paid extraction — the response reports `pages_enqueued` and the per-page USD budget (MEMRAIN_CHRONICLE_WRITE_BUDGET_USD) so worst-case spend is computable before a real run. `dry_run:true` returns counts only. Operator-only. WRITE — refused on public ingress.",
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
  "submit_agent",
]);

/** Mutating tools that delete or overwrite, as opposed to purely adding. */
const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
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
