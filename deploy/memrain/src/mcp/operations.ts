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

/** Upper bound on `request_id` length (checked by the dispatch handler). */
export const MAX_REQUEST_ID_LEN = 128;

const expectedVersionParam = int({
  minimum: 0,
  description:
    "page_get version or page_versions version_n; 0 requires absence (deleted pages keep versions: use current_version from a failed 0). Mismatch writes nothing, returns current_version. Omit: unconditional, subject to precondition policy.",
});
const forceParam = bool({
  description:
    "Deliberate unconditional overwrite; not with expected_version.",
});
const requestIdParam = str({
  description:
    `Optional retry id (1-${MAX_REQUEST_ID_LEN} chars), retained 7 days. Same id+args replays the first result (replayed:true) without writing; changed args refused.`,
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
      "Ranked vector+keyword chunks, paths and titles, fused by reciprocal rank. Date/type/slug-prefix filters precede limits. Hits are not exhaustive. meta exposes vectorEnabled/degraded. Empty results include a recovery hint.",
    argAliases: { query: "q", limit: "k" },
    params: {
      source_ids: arr({ items: { type: "string" }, description: "≤100 exact source IDs within your grant (omitted: whole grant). [] reads nothing; a forbidden ID refuses." }),
      types: arr({ items: { type: "string" }, description: "≤20 lower-case page types; matches live pages and their mirrors/file twins, never non-page documents. Empty: no filter." }),
      slug_prefix: str({ description: "Literal canonical slug prefix (e.g. projects/x/), no wildcards; applied before limits." }),
      q: str({ ...req, description: "Natural-language query." }),
      k: int({ minimum: 1, maximum: 100, description: "Number of hits to return. Default 20." }),
      token_budget: int({
        minimum: 1,
        maximum: 200000,
        description:
          "Cap returned title + content (~chars/4 tokens), including trust frames. Keep whole hits in rank order; stop before the first that overflows.",
      }),
      since: str({
        description:
          "Keep hits whose content date (effective, else updated) is >= this: ISO-8601 date/datetime or a duration back from now (7d/2w/6m/1y).",
      }),
      until: str({
        description:
          "Upper bound on the content date: ISO date/time (YYYY-MM-DD includes the whole day), or duration back from now: 7d/2w/6m/1y.",
      }),
      offset: int({
        minimum: 0,
        maximum: 1000,
        description:
          "Skip the first N ranked hits (pagination), after ranking.",
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
    name: "page_put",
    callShape: "{slug, markdown_body, expected_version?}",
    scope: "write",
    description:
      "Create/replace a DB-canonical page; identical content is a no-op, changes append history. Prefer page_edit for partial changes. The search mirror is written before return (search_indexed); if that fails the page is still saved and the hourly housekeeping indexes it. MEMRAIN_REQUIRE_WRITE_PRECONDITION makes missing expected_version/force warn or refuse with precondition_required + current_version. Public writes need MEMRAIN_PUBLIC_WRITE=1.",
    params: {
      reason: str({ description: "Optional one-line reason, ≤500 code points, trimmed and secret-scanned; stored only with a new version." }),
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
          "Optional caller id for the audit trail (skill slug, recipe, …).",
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
      wait_for_index: bool({ description: "No effect: the search mirror is always written before return." }),
      expected_version: expectedVersionParam,
      force: forceParam,
      request_id: requestIdParam,
    },
  },
  {
    name: "page_append",
    scope: "write",
    description:
      "Append to an existing page body and add a version; use page_put to create. Returns search_indexed once the search mirror is written. Public writes require MEMRAIN_PUBLIC_WRITE=1.",
    argAliases: { markdown: "content" },
    params: {
      slug: str(req),
      content: str(req),
      written_by: str(),
      wait_for_index: bool({ description: "No effect: the search mirror is always written before return." }),
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
      "Atomically apply 1..50 ordered exact-text body replacements, keeping title/frontmatter. Copy unique old_text from page_get; misses/duplicates give edit_no_match/edit_ambiguous_match. Facts/takes fences are protected (edit_protected_span). Requires expected_version; a conflict returns current_version. Returns version and a diff capped at 8 KB (diff_truncated). Indexing as page_put. Public writes need MEMRAIN_PUBLIC_WRITE=1.",
    params: {
      reason: str({ description: "Optional one-line reason, ≤500 code points, trimmed and secret-scanned; stored only with a new version." }),
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
          "Optional caller id for the audit trail (skill slug, recipe, …).",
      }),
      wait_for_index: bool({ description: "No effect: the search mirror is always written before return." }),
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
      reason: str({ description: "Optional one-line reason, ≤500 code points, trimmed and secret-scanned; stored only with a new version." }),
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
      "Undelete a soft-deleted page (clears deleted_at). The inverse of page_delete; no-op if the page is missing or already live. Requires source-scoped write or internal token; static public bearer forbidden.",
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
      reason: str({ description: "Optional one-line reason, ≤500 code points, trimmed and secret-scanned; stored only with a new version." }),
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
      "List pages; sort defaults to updated_desc (newest first). tag is normalized; since is an ISO timestamp; limit default 50. include_deleted:true adds soft-deleted pages with deleted_at.",
    argAliases: {
      prefix: "slug_prefix",
    },
    params: {
      source_ids: arr({ items: { type: "string" }, description: "≤100 exact source IDs within your grant (omitted: whole grant). [] reads nothing; a forbidden ID refuses." }),
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
          "Default 1.0 for agent-asserted edges. Use <1.0 only for deterministic-extractor outputs whose surface form was ambiguous.",
      }),
      source_chunk_id: str(),
      allowAdHocType: bool(),
    },
  },
  {
    name: "unlink",
    scope: "write",
    description:
      "Remove a manually created typed link. Returns removed and derived_from_text for edges still supplied by markdown/frontmatter/mentions; edit the source page with page_edit to remove those. Idempotent. Requires source-scoped write or internal token; static public bearer forbidden.",
    params: {
      source_slug: str(req),
      target_slug: str(req),
      type: str(req),
    },
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
      "Remove a tag from a page. Idempotent (removing an absent tag is a no-op). Requires source-scoped write or internal token; static public bearer forbidden.",
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
    name: "get_links",
    outputRedaction: "retrieval",
    description:
      "Edges touching slug, grouped by type and outbound/inbound direction (source/target respectively). Groups sort by type, outbound first; edges newest first. limit caps each direction; default 1000.",
    params: {
      status: str({ enum: ["all", "active", "expired", "future"], description: "Manual link validity; default all; end date exclusive." }),
      as_of: str({ description: "YYYY-MM-DD for a status other than all; default today UTC." }),
      slug: str(req),
      limit: int({ minimum: 1, maximum: 1000 }),
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
      "Show the calling identity and grant: client_id, scopes, write_source, read_sources, is_public, owner, requester_scope, operator, bound_slug_prefixes, budget_usd_per_day, spent_today_usd, spend_id and callable_tools. Unscoped read_sources is null; absent grant fields are null. callable_tools matches tools/list. Reveals only the caller's auth context, no corpus or Bedrock call.",
    params: {},
  },
  {
    name: "purge_deleted_pages",
    scope: "admin",
    description:
      "HARD-delete pages soft-deleted over older_than_hours ago (default 720) with versions, aliases, links, raw_data, tags, redirects, facts on them, synthesis output and secret originals only they held. Returns slugs, count, ttl_hours, per-table counts. Admin scope in the owning source or internal token; never the public bearer.",
    params: {
      older_than_hours: num({
        minimum: 0,
        description: "Age cutoff in hours. Pages soft-deleted longer ago than this are reaped. Default 720 (30 days).",
      }),
      slugs: arr({
        items: { type: "string" },
        description: "Only these slugs, and only those soft-deleted past the cutoff; their text is tombstoned so no later write brings it back (memrain unpurge clears it). Omit to reap every expired page.",
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
      "Per-source diagnostic: the source row plus its live health (document/chunk counts, embed coverage, staleness lag). A scoped caller may only query a source inside its grant. Read-only; no LLM.",
    params: {
      id: str({ ...req, description: "Source id." }),
    },
  },
  {
    name: "run_doctor",
    description:
      "Run the brain health checks and return a structured report: schema version, stats, embed coverage, stale locks, housekeeping freshness and OAuth client hygiene. Operator-only; read-only; never mutates; no LLM.",
    params: {},
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

/** Mutating tools that delete or overwrite, as opposed to purely adding. */
const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  "page_rename",
  "index",
  "page_put",
  "page_edit",
  "page_delete",
  "page_revert",
  "unlink",
  "remove_tag",
  "purge_deleted_pages",
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
  const mutating = op.scope === "write" || op.scope === "admin";
  if (!mutating) return { readOnlyHint: true, openWorldHint: false };
  return {
    readOnlyHint: false,
    destructiveHint: DESTRUCTIVE_TOOLS.has(op.name),
    ...(IDEMPOTENT_TOOLS.has(op.name) ? { idempotentHint: true } : {}),
    openWorldHint: false,
  };
}
