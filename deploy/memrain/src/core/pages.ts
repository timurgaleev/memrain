/**
 * Pages — DB-canonical CRUD over the page store added in migration 015.
 *
 * Every write goes through this module: it computes the content hash,
 * decides whether the write is a no-op (idempotent re-put with identical
 * content) or a real edit, and appends a row to `page_versions`. Higher
 * layers (HTTP route, MCP dispatch) never touch the SQL directly.
 *
 * Indexing of the resulting page into the legacy `documents` / `chunks`
 * / `embeddings` store is a separate concern owned by a later wiring
 * commit — `putPage` returns enough information for a caller to drive
 * that step (slug + content_hash + chunkable body) without pulling
 * Bedrock into this module.
 */
import { auditSecrets, guardEchoes, guardSecrets, guardSecretsDeep, guardWrite, type EchoDictionary, type SecretFinding } from "./secret-scan.ts";
import { createHash } from "node:crypto";
import type { Storage } from "./storage.ts";
import type { Engine } from "./engine/interface.ts";
import { bumpPageGeneration } from "./generation.ts";
import { wellFormJsonbValue } from "./well-form.ts";
import { extractAliasNorms, setPageAliases } from "./page-aliases.ts";
import { resolveSlugWithAlias, setSlugAlias } from "./slug-aliases.ts";
import { OperationError, PageNotFoundError, type PublicErrorEnvelope } from "./operation-error.ts";
import { andSourceScope } from "./source-scope.ts";
import { carryFactWithdrawals } from "./fact-withdrawals.ts";
import { deadlockSafeTransaction } from "./retry.ts";
import { recordWriteRequest, type WriteRequestKey } from "./write-requests.ts";
import { applyPageEdits, assertScanKeptFences, pageEditResponse, type PageEdit } from "./page-edit.ts";

// Catalogue of well-known page types. Not enforced at the DB level (see
// migration 015 comment); kept here so application code can normalise +
// validate at the boundary. New types may be passed through if the
// caller opts in to `allowAdHocType: true`.
export const KNOWN_PAGE_TYPES = [
  "concept",
  "person",
  "company",
  "meeting",
  "idea",
  "journal",
  "note",
  "email",
  "event",
  "diary",
  "decision",
  "task",
  "source",
] as const;

export type KnownPageType = (typeof KNOWN_PAGE_TYPES)[number];

/**
 * Slug first-segment → page type. A page at `people/alice` is a `person`
 * without the caller spelling it out — the vault's folder convention already
 * encodes the type. Used to INFER `type` when a put omits it (an explicit
 * type always wins). Plural and singular prefixes both map.
 */
const SLUG_PREFIX_TYPE: Record<string, KnownPageType> = {
  people: "person", person: "person", persons: "person",
  companies: "company", company: "company", orgs: "company", org: "company",
  meetings: "meeting", meeting: "meeting",
  ideas: "idea", idea: "idea",
  journal: "journal", journals: "journal",
  notes: "note", note: "note",
  emails: "email", email: "email",
  events: "event", event: "event",
  decisions: "decision", decision: "decision",
  tasks: "task", task: "task",
  concepts: "concept", concept: "concept",
  sources: "source", source: "source",
};

// Life Chronicle namespaces are two-segment: a page under `life/events/…` is an
// event projection, one under `life/diary/…` is private interiority. The plain
// first-segment `life` is ambiguous, so these two-segment prefixes are matched
// ahead of the single-segment table.
const SLUG_PREFIX2_TYPE: Record<string, KnownPageType> = {
  "life/events": "event",
  "life/diary": "diary",
};

/** Infer a page type from a slug's leading path segments, or null if unknown.
 *  A two-segment Life Chronicle prefix (life/events, life/diary) wins over the
 *  first-segment convention. */
export function inferPageType(slug: string): KnownPageType | null {
  if (typeof slug !== "string") return null;
  const parts = slug.toLowerCase().split("/");
  const seg2 = parts.slice(0, 2).join("/");
  if (SLUG_PREFIX2_TYPE[seg2]) return SLUG_PREFIX2_TYPE[seg2];
  const seg = parts[0] ?? "";
  return SLUG_PREFIX_TYPE[seg] ?? null;
}

/** A search-mirror source_path pointing at a diary page. Mirror ids are
 *  `page://<slug>` (default tenant) or `page://<sourceId>/<slug>` (scoped), so a
 *  diary page (slug `life/diary/…`) appears either right after the scheme or
 *  after a tenant prefix — match the slug segment, not just the scheme. */
export function isDiarySourcePath(sourcePath: string): boolean {
  return (
    sourcePath.startsWith("page://life/diary/") ||
    sourcePath.startsWith("page-truth://life/diary/") ||
    sourcePath.includes("/life/diary/")
  );
}

// Slug grammar:
//   - lowercase/caseless letters of any script, combining marks, digits, hyphen
//     (\p{Ll}\p{Lm}\p{Lo}\p{M}\p{N} — ASCII slugs are a strict subset)
//   - optional `/` namespaces (each segment must satisfy the same rule)
//   - 1..256 chars total
// Keep in sync with the copies in links.ts / insights.ts.
const SLUG_WORD = "[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}\\p{N}]";
// Same set plus the hyphen, for every position after a segment's first char.
const SLUG_TAIL = "[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}\\p{N}-]";
const SLUG_RE = new RegExp(
  `^${SLUG_WORD}${SLUG_TAIL}*(?:\\/${SLUG_WORD}${SLUG_TAIL}*)*$`,
  "u",
);
const MAX_SLUG_LEN = 256;

/** Static hint for an append whose target page is missing. */
const CREATE_IT_FIRST = "Create the page with page_put first.";

export function validateSlug(slug: string): void {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("page slug must be a non-empty string");
  }
  if (slug.length > MAX_SLUG_LEN) {
    throw new Error(`page slug exceeds ${MAX_SLUG_LEN} chars`);
  }
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `page slug must match kebab-case with optional / namespaces (got ${JSON.stringify(
        slug,
      )})`,
    );
  }
}

export interface PageInput {
  slug: string;
  /** Page type. OPTIONAL: when omitted it is inferred from the slug's first
   *  segment (`people/…` → person), falling back to `note`. An explicit type
   *  always wins. */
  type?: string;
  title?: string;
  compiled_truth?: Record<string, unknown>;
  markdown_body?: string;
  /**
   * An explicit empty `markdown_body` over a page that has a body is refused
   * unless this is set: an empty string is far more often a caller bug than an
   * intent to wipe the page. (An OMITTED body keeps the page's current body.)
   */
  allowEmptyBody?: boolean;
  /**
   * Append this to the page's CURRENT body instead of replacing it. The body is
   * read under the slug's write lock, so concurrent appends each land after the
   * last — `appendPage` uses it; `markdown_body` is ignored when it is set.
   */
  appendContent?: string;
  /** Caller identifier for the audit trail. */
  written_by?: string;
  /** Allow a type that isn't in KNOWN_PAGE_TYPES. Default false. */
  allowAdHocType?: boolean;
  /**
   * Owning source (tenant). Defaults to 'default'. A write to a slug already
   * owned by a different source is refused (no cross-tenant overwrite).
   */
  source_id?: string;
  /**
   * Optimistic concurrency: the version the caller last read (`page_get`'s
   * `version`, the top `page_versions` row). Checked under the slug lock; a
   * different current version refuses the write with `VersionConflictError`.
   * 0 means "the page must not exist yet". A soft-deleted slug keeps its
   * version counter, so it is not at 0: a write that resurrects it passes the
   * current version the conflict reports. Omitted = no check.
   */
  expectedVersion?: number;
  /** A claimed `request_id` (write-requests.ts): its receipt commits with this write. */
  receipt?: WriteRequestKey;
  /**
   * Replace exact spans of the CURRENT body instead of writing a whole one
   * (page_edit). Applied to the body read under the slug's write lock, after
   * the version check; `markdown_body` is ignored when it is set.
   */
  edits?: PageEdit[];
  /**
   * What to do when this write would overwrite a live page without naming the
   * version it read (`expectedVersion`): `warn` writes and reports it, `refuse`
   * writes nothing. Unset = no check. Only MCP page_put sets it.
   */
  preconditionPolicy?: "warn" | "refuse";
  /** The authenticated principal behind the write (page_versions.written_by_principal). */
  written_by_principal?: string;
}

/**
 * An unconditional overwrite of a live page, refused by
 * MEMRAIN_REQUIRE_WRITE_PRECONDITION=refuse. Carries the current version so
 * the caller can retry with it.
 */
export class PreconditionRequiredError extends OperationError {
  constructor(
    slug: string,
    public readonly currentVersion: number,
  ) {
    super(
      "precondition_required",
      `page '${slug}' exists at version ${currentVersion}; this brain refuses an overwrite that does not name the version it read`,
      "Read the page (page_get), then pass its version as expected_version, or pass force: true to overwrite on purpose.",
    );
    this.name = "PreconditionRequiredError";
  }

  override toEnvelope(isPublic: boolean): PublicErrorEnvelope & { current_version: number } {
    return { ...super.toEnvelope(isPublic), current_version: this.currentVersion };
  }
}

/** The warning a `warn` precondition policy attaches to an unconditional overwrite. */
export const PRECONDITION_WARNING =
  "precondition_missing: this overwrote a live page without expected_version; read the page and pass its version to avoid losing a concurrent update";

/**
 * A conditional write lost the race: the page moved on since the caller read
 * it. Carries the current version in the envelope on every ingress — the
 * caller needs it to re-read and retry, and it is a counter, not content.
 */
export class VersionConflictError extends OperationError {
  constructor(
    slug: string,
    public readonly currentVersion: number,
    public readonly expectedVersion: number,
  ) {
    super(
      "version_conflict",
      `page '${slug}' is at version ${currentVersion}, not the expected ${expectedVersion}; nothing was written`,
      "Re-read the page (page_get or page_versions), reconcile, and retry with its current version, or pass force: true to overwrite on purpose.",
    );
    this.name = "VersionConflictError";
  }

  override toEnvelope(isPublic: boolean): PublicErrorEnvelope & { current_version: number; expected_version: number } {
    return {
      ...super.toEnvelope(isPublic),
      current_version: this.currentVersion,
      expected_version: this.expectedVersion,
    };
  }
}

function checkExpectedVersion(slug: string, current: number, expected: number | undefined): void {
  if (expected !== undefined && current !== expected) {
    throw new VersionConflictError(slug, current, expected);
  }
}

/** The page's current version number — the top of its version chain, 0 when none. */
export async function currentPageVersion(db: Engine, slug: string): Promise<number> {
  const r = await db.query<{ n: number }>(
    "SELECT COALESCE(MAX(version_n), 0)::int AS n FROM page_versions WHERE slug = $1",
    [slug],
  );
  return Number(r.rows[0]?.n ?? 0);
}

export interface PageRow {
  slug: string;
  type: string;
  title: string | null;
  compiled_truth: Record<string, unknown>;
  markdown_body: string;
  content_hash: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** Owning source (tenant). Carried so the search mirror propagates it. */
  source_id: string;
  /** Top of the version chain, read in the same statement as the row. Set only
   *  when read with `withVersion`. */
  version?: number;
}

export interface PutResult {
  slug: string;
  /** New version number assigned to this write (>=1). */
  version_n: number;
  /** SHA-256 of the body after the write. */
  content_hash: string;
  /** True when the body actually changed compared to the prior version. */
  changed: boolean;
  /** True when the row didn't exist before. */
  created: boolean;
  /** Credentials found in the write (redacted unless the disposition is `flag`). */
  secrets_found?: number;
  /** Advisories about a write that went ahead (the `warn` precondition policy). */
  warnings?: string[];
  /** For an `edits` write: the body before and after, for the caller's diff. */
  edited?: { before: string; after: string };
}

export interface PageVersionRow {
  slug: string;
  version_n: number;
  hash_prev: string | null;
  hash_new: string;
  body_snapshot: string;
  compiled_truth_snapshot: Record<string, unknown>;
  written_by: string | null;
  written_at: string;
  /** Only when read with `withPrincipal` (operator/admin views). */
  written_by_principal?: string | null;
}

/** JSON with every object's keys sorted, for an order-free comparison. */
function sortedKeysJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function normaliseType(
  type: string | undefined,
  allowAdHoc: boolean | undefined,
): string {
  if (!type || typeof type !== "string") {
    throw new Error("page type is required");
  }
  const t = type.trim().toLowerCase();
  if (!t) throw new Error("page type cannot be blank");
  if (!allowAdHoc && !KNOWN_PAGE_TYPES.includes(t as KnownPageType)) {
    throw new Error(
      `page type ${JSON.stringify(t)} not in KNOWN_PAGE_TYPES; ` +
        `pass allowAdHocType: true to accept it`,
    );
  }
  return t;
}

/**
 * Idempotent upsert. Two paths:
 *   1. row exists, body+truth+title+type identical → no-op, returns
 *      `changed: false`, no new version row.
 *   2. row exists with different content OR row missing → upsert pages,
 *      append `page_versions` with version_n = max(existing) + 1.
 *
 * A soft-deleted slug takes path 2: the write clears `deleted_at` and the
 * page comes back in place with its version history continued — unless the
 * slug was merged away, in which case the write is refused rather than allowed
 * to shadow the canonical page (see the merge fence below).
 *
 * The whole thing runs in one transaction so a Bedrock failure later in
 * a caller's pipeline cannot leave a page row without its matching
 * version row.
 */
/**
 * Take the per-slug write lock for each slug, in a fixed order so two writers
 * locking the same pair (a rename, a merge) cannot deadlock. Every writer of a
 * page row or its version chain holds it for its transaction: without it two
 * writers read the same row and the same `MAX(version_n)` — an append was lost,
 * a version number reused, a delete flipped under a put. It is transaction-
 * scoped, releases itself at commit or rollback, and covers a slug that has no
 * row yet, which a row lock cannot.
 */
export async function lockPageSlugs(tx: Engine, ...slugs: string[]): Promise<void> {
  for (const slug of [...new Set(slugs)].sort()) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`memrain:page:${slug}`]);
  }
}

export async function putPage(
  storage: Storage,
  input: PageInput,
): Promise<PutResult> {
  validateSlug(input.slug);
  // An explicit (non-blank) type always wins; a blank/omitted type is resolved
  // INSIDE the transaction (below), where the existing row is known — so an
  // omitted-type re-put PRESERVES the page's current type rather than
  // re-inferring it. Inference (slug prefix → type, default `note`) applies
  // only when creating a page with no explicit type.
  const explicitType =
    typeof input.type === "string" && input.type.trim() !== ""
      ? normaliseType(input.type, input.allowAdHocType)
      : null;
  // Credentials never reach the page, its title, its truth, its versions or
  // its search mirror.
  const where = `page '${input.slug}'`;
  const callerSourceForAudit = typeof input.source_id === "string" && input.source_id.trim().length > 0 ? input.source_id : null;
  const secretFindings: SecretFinding[] = [];
  const scanned = await guardWrite(storage.engine(), input.slug, callerSourceForAudit, () => {
    // One echo dictionary for the whole write: a token claimed in the title is
    // also redacted where the body repeats it bare, and the other way round.
    const echo: EchoDictionary = new Map();
    const guard = (text: string): string => {
      const r = guardSecrets(text, where, { echo });
      secretFindings.push(...r.findings);
      return r.text;
    };
    return guardEchoes({
      body: guard(input.markdown_body ?? ""),
      append: input.appendContent !== undefined ? guard(input.appendContent) : undefined,
      // Only the replacement text is new content; old_text must keep matching the stored body.
      newTexts: input.edits?.map((e) => guard(e.new_text)),
      title: typeof input.title === "string" ? guard(input.title) : (input.title ?? null),
      truth: guardSecretsDeep(input.compiled_truth ?? {}, where, secretFindings, echo) as Record<string, unknown>,
    }, echo, secretFindings);
  });
  const appendContent = scanned.append;
  const edits = input.edits?.map((e, i) => ({ old_text: e.old_text, new_text: scanned.newTexts![i]! }));
  const writtenByPrincipal = input.written_by_principal ?? null;
  let edited: PutResult["edited"];
  const warnings: string[] = [];
  let body = input.markdown_body === undefined ? "" : scanned.body;
  const truth = scanned.truth;
  let title = scanned.title;
  const writtenBy = input.written_by ?? null;
  // An OMITTED source means "operator, unscoped" — the local CLI, the internal
  // token, the cycle. It is not the `default` tenant. Coercing it to `default`
  // before the ownership check below turned every unscoped write onto a
  // named-source page into permission_denied, which is every page on a brain
  // whose content was moved off `default` (`tenant add` + move). `default` is
  // still the stamp for a NEW page, because the column is NOT NULL.
  // Presence, not truthiness: an omitted/null source is the operator, but an
  // explicitly EMPTY string is a caller that meant to name a source and sent
  // nothing. Treating it as "unscoped" would walk it straight through the
  // ownership fence below, so it is refused instead.
  if (typeof input.source_id === "string" && input.source_id.trim().length === 0) {
    throw new OperationError(
      "invalid_params",
      "source_id must be a non-empty source name when supplied",
      "Omit source_id for an operator write, or name the source.",
    );
  }
  const callerSource = typeof input.source_id === "string" ? input.source_id : null;
  const sourceId = callerSource ?? "default";
  let hashNew = hashBody(body);
  // Sanitize lone UTF-16 surrogates + NUL ONCE, then derive both the jsonb
  // payload and the alias norms from the sanitized value — otherwise a NUL /
  // lone surrogate inside `aliases` would reach the page_aliases TEXT insert
  // (which Postgres rejects) and abort the whole page write (see well-form.ts).
  const safeTruth = wellFormJsonbValue(truth) as Record<string, unknown>;
  let aliasNorms = extractAliasNorms(safeTruth);
  let truthJson = JSON.stringify(safeTruth);

  const engine = storage.engine();
  const writeLocked = async (tx: Engine): Promise<PutResult> => {
    await lockPageSlugs(tx, input.slug);
    const existing = await tx.query<{
      content_hash: string;
      markdown_body: string;
      type: string;
      title: string | null;
      compiled_truth: unknown;
      source_id: string;
      deleted_at: string | null;
      version_n: number;
    }>(
      // Soft-deleted rows are IN scope here: `pages.slug` is the PK, so a
      // re-put of a deleted slug has nowhere to insert. It resurrects the
      // existing row (deleted_at cleared below), keeping the version chain
      // and the owning source intact.
      `SELECT p.content_hash, p.markdown_body, p.type, p.title, p.compiled_truth, p.source_id,
              p.deleted_at::text AS deleted_at,
              COALESCE(MAX(v.version_n), 0) AS version_n
       FROM pages p
       LEFT JOIN page_versions v ON v.slug = p.slug
       WHERE p.slug = $1
       GROUP BY p.content_hash, p.markdown_body, p.type, p.title, p.compiled_truth,
                p.source_id, p.deleted_at`,
      [input.slug],
    );

    // No cross-tenant overwrite: a slug owned by another source is off-limits.
    // Only a caller that NAMES a source is fenced — the same exemption
    // `indexer-tx.ts` grants its trusted local callers, and for the same
    // reason: fencing the unscoped path breaks re-index, sync and the cycle.
    const owner = existing.rows[0]?.source_id;
    // Rows written ALONGSIDE an existing page (versions, aliases, the redirect
    // probe) carry that page's own source, never the caller's `default`
    // fallback — otherwise an unscoped operator write re-homes a tenant's
    // aliases and version chain into `default`, where the owner's scoped reads
    // no longer see them. On a brand-new page there is no owner and the stamp
    // is the caller's.
    if (callerSource !== null && owner !== undefined && owner !== callerSource) {
      throw new OperationError(
        "permission_denied",
        `page '${input.slug}' is owned by another source`,
        "Use a slug within your own source, or request access.",
      );
    }
    checkExpectedVersion(input.slug, Number(existing.rows[0]?.version_n ?? 0), input.expectedVersion);

    const current = existing.rows[0];
    if (
      input.preconditionPolicy !== undefined &&
      input.expectedVersion === undefined &&
      current !== undefined &&
      current.deleted_at === null
    ) {
      if (input.preconditionPolicy === "refuse") {
        throw new PreconditionRequiredError(input.slug, Number(current.version_n));
      }
      warnings.push(PRECONDITION_WARNING);
    }
    if (edits !== undefined) {
      if (current === undefined || current.deleted_at !== null) {
        throw new PageNotFoundError(input.slug, CREATE_IT_FIRST);
      }
      // Each new_text was scanned alone; a credential split across edits, or
      // completed by text already on the page, only exists in the result.
      const applied = applyPageEdits(current.markdown_body, edits);
      const guarded = guardSecrets(applied, where);
      assertScanKeptFences(applied, guarded.text);
      secretFindings.push(...guarded.findings);
      body = guarded.text;
      hashNew = hashBody(body);
      edited = { before: current.markdown_body, after: body };
      // Like an append, an edit changes the body only: title and truth come
      // from the row read under the lock.
      title = current.title;
      const lockedTruth = wellFormJsonbValue(current.compiled_truth ?? {}) as Record<string, unknown>;
      aliasNorms = extractAliasNorms(lockedTruth);
      truthJson = JSON.stringify(lockedTruth);
    } else if (appendContent !== undefined) {
      if (current === undefined || current.deleted_at !== null) {
        throw new PageNotFoundError(input.slug, CREATE_IT_FIRST);
      }
      const sep =
        current.markdown_body.length > 0 && !current.markdown_body.endsWith("\n") ? "\n" : "";
      body = `${current.markdown_body}${sep}${appendContent}`;
      hashNew = hashBody(body);
      // An append changes the body only. Title and truth come from the row read
      // under the lock too, or a title/truth edit that landed between the
      // caller's read and this write would be silently reverted.
      title = current.title;
      const lockedTruth = wellFormJsonbValue(current.compiled_truth ?? {}) as Record<string, unknown>;
      aliasNorms = extractAliasNorms(lockedTruth);
      truthJson = JSON.stringify(lockedTruth);
    } else if (current !== undefined && input.markdown_body === undefined) {
      // An omitted body keeps the page's own — a title or truth update must not
      // blank the page underneath it.
      body = current.markdown_body;
      hashNew = current.content_hash;
    } else if (
      current !== undefined &&
      current.deleted_at === null &&
      body.length === 0 &&
      current.markdown_body.length > 0 &&
      input.allowEmptyBody !== true
    ) {
      throw new OperationError(
        "invalid_params",
        `refusing to replace the body of '${input.slug}' with an empty one`,
        "Pass allowEmptyBody (allow_empty_body) to clear a page on purpose, or omit markdown_body to keep it.",
      );
    }

    // Merge/rename fence — layered on top of the plain upsert below.
    // An id-keyed store would keep no row for a retired slug to bring back.
    // Here `pages.slug` IS the key, and two operations
    // retire a slug behind a `slug_aliases` redirect: `mergePage` folds the stub
    // into a soft-deleted row PLUS a stub→canonical redirect, and `renamePage`
    // deletes the old row outright and leaves old→new. Either way a write to the
    // retired slug would put a live page on a slug whose exact-match read beats
    // redirect resolution (see `getPage`), so it would shadow the canonical and
    // silently undo the merge/rename. Refuse instead — the same rule the
    // append/revert paths already follow: a write never revives a slug that now
    // only holds a redirect.
    //
    // Guards BOTH the resurrect branch and the create branch below, because a
    // rename leaves no row at all — fencing only the soft-deleted case would be
    // half a rule. Never fires for a live row (that is an ordinary update), and
    // only fires once the canonical is live, so a dangling redirect cannot
    // strand the slug forever. A plain soft-deleted slug with no redirect still
    // resurrects unconditionally, by design (see the upsert note below).
    const liveAtSlug = existing.rows[0]?.deleted_at === null;
    if (!liveAtSlug) {
      const redirect = await tx.query<{ canonical_slug: string }>(
        // The canonical must be live IN THE SAME SOURCE. A live page of that
        // slug under another tenant says nothing about this one, and counting
        // it would let a stale cross-source redirect refuse a legitimate write.
        `SELECT a.canonical_slug
           FROM slug_aliases a
           JOIN pages p ON p.slug = a.canonical_slug
                       AND p.deleted_at IS NULL
                       AND p.source_id = $2
          WHERE a.alias_slug = $1 AND a.source_id = $2
          LIMIT 1`,
        [input.slug, existing.rows[0]?.source_id ?? sourceId],
      );
      const canonical = redirect.rows[0]?.canonical_slug;
      if (canonical !== undefined) {
        // Keyed on the redirect, not on how it got there, so a rename that left
        // one behind is fenced on the same terms as a merge.
        throw new OperationError(
          "invalid_params",
          `page '${input.slug}' now redirects to '${canonical}'; ` +
            `bringing it back would shadow the canonical page`,
          "Write to the canonical slug instead.",
        );
      }
    }

    // Resolve the type now that the existing row is known: explicit wins;
    // else preserve the existing page's type (an omitted-type update must NOT
    // re-type the page); else (new page) infer from the slug, default `note`.
    const prevType = existing.rows[0]?.type;
    const type =
      explicitType ??
      prevType ??
      normaliseType(inferPageType(input.slug) ?? "note", input.allowAdHocType);

    if (existing.rows.length === 0) {
      // Brand new page.
      await tx.query(
        `INSERT INTO pages (slug, type, title, compiled_truth,
                            markdown_body, content_hash, source_id)
         VALUES ($1, $2, $3, $4::text::jsonb, $5, $6, $7)`,
        [input.slug, type, title, truthJson, body, hashNew, sourceId],
      );
      await tx.query(
        `INSERT INTO page_versions
           (slug, version_n, hash_prev, hash_new,
            body_snapshot, compiled_truth_snapshot, written_by, source_id, written_by_principal)
         VALUES ($1, 1, NULL, $2, $3, $4::text::jsonb, $5, $6, $7)`,
        [input.slug, hashNew, body, truthJson, writtenBy, sourceId, writtenByPrincipal],
      );
      await bumpPageGeneration(tx, input.slug);
      await setPageAliases(tx, input.slug, aliasNorms, sourceId);
      return {
        slug: input.slug,
        version_n: 1,
        content_hash: hashNew,
        changed: true,
        created: true,
      };
    }

    const prev = existing.rows[0]!;
    // JSONB stores object keys in its own order (shorter first), so the stored
    // truth is compared key-order-free; a raw stringify saw every truth whose
    // keys were written in another order as changed and versioned it again.
    const truthEq =
      typeof prev.compiled_truth === "object" &&
      prev.compiled_truth !== null &&
      sortedKeysJson(prev.compiled_truth) === sortedKeysJson(JSON.parse(truthJson));
    // A soft-deleted row is never idempotent however identical the content:
    // the write must reach the update branch below to clear `deleted_at`.
    const idempotent =
      prev.deleted_at === null &&
      prev.content_hash === hashNew &&
      prev.type === type &&
      prev.title === title &&
      truthEq;

    if (idempotent) {
      return {
        slug: input.slug,
        version_n: prev.version_n,
        content_hash: hashNew,
        changed: false,
        created: false,
      };
    }

    const nextVersion = prev.version_n + 1;
    // `deleted_at = NULL` is unconditional.
    // The tradeoff is deliberate: any later write to the slug — a
    // synthesis phase, an importer — undoes an operator's `page_delete` and
    // brings the page back in place. A delete that must stick needs the slug
    // to stop being written, or a purge.
    await tx.query(
      `UPDATE pages
         SET type = $2,
             title = $3,
             compiled_truth = $4::text::jsonb,
             markdown_body = $5,
             content_hash = $6,
             updated_at = NOW(),
             deleted_at = NULL
       WHERE slug = $1`,
      [input.slug, type, title, truthJson, body, hashNew],
    );
    await tx.query(
      `INSERT INTO page_versions
         (slug, version_n, hash_prev, hash_new,
          body_snapshot, compiled_truth_snapshot, written_by, source_id, written_by_principal)
       VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8, $9)`,
      [
        input.slug,
        nextVersion,
        prev.content_hash,
        hashNew,
        body,
        truthJson,
        writtenBy,
        prev.source_id ?? sourceId,
        writtenByPrincipal,
      ],
    );
    await bumpPageGeneration(tx, input.slug);
    // The page's OWN source, not the caller's fallback: a scoped caller can
    // only reach a page it owns (fenced above), and an unscoped operator must
    // leave the owner's aliases where the owner can read them.
    await setPageAliases(tx, input.slug, aliasNorms, prev.source_id ?? sourceId);
    return {
      slug: input.slug,
      version_n: nextVersion,
      content_hash: hashNew,
      changed: true,
      created: false,
    };
  };
  const result = await engine.transaction(async (tx) => {
    const r = await writeLocked(tx);
    if (input.receipt !== undefined) {
      // A retry replays this receipt when the derived work after the commit
      // failed, so an edit stores page_edit's response shape, not the row's.
      const receipt =
        edits !== undefined
          ? pageEditResponse(r, edits.length, edited, secretFindings.length > 0 ? secretFindings.length : undefined)
          : { ok: true, ...r, ...(warnings.length > 0 ? { warnings } : {}) };
      await recordWriteRequest(tx, input.receipt, receipt);
    }
    return r;
  });
  const extras = {
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(edited !== undefined ? { edited } : {}),
  };
  // A no-op stored nothing, so there is nothing new to audit; under `flag` the
  // credential sits in the unchanged body and would otherwise be re-audited on
  // every identical re-put.
  if (secretFindings.length === 0) return { ...result, ...extras };
  if (result.changed) await auditSecrets(engine, secretFindings, input.slug, callerSource);
  return { ...result, ...extras, secrets_found: secretFindings.length };
}

export interface AppendInput {
  slug: string;
  /** Text to append. A leading newline is added between existing body and the
   *  new chunk only when needed (so callers don't have to worry about it). */
  content: string;
  written_by?: string;
  /**
   * Owning source (tenant). When set, the target page is resolved within this
   * source only — a caller cannot append to a page they do not own (it reads
   * as not found).
   */
  source_id?: string;
  /** A claimed `request_id` (write-requests.ts): its receipt commits with this write. */
  receipt?: WriteRequestKey;
  /** The authenticated principal behind the write (page_versions.written_by_principal). */
  written_by_principal?: string;
}

export async function appendPage(
  storage: Storage,
  input: AppendInput,
): Promise<PutResult> {
  validateSlug(input.slug);
  if (typeof input.content !== "string" || input.content.length === 0) {
    throw new Error("appendPage: content is required");
  }
  const scope = input.source_id ? [input.source_id] : undefined;
  // Exact read (NOT redirect-aware): a write must target the literal slug. If
  // this slug was renamed away, appending must fail (not found), never
  // silently resurrect the old slug that now only holds a redirect.
  const current = await getPageExact(storage, input.slug, scope);
  if (!current) {
    throw new PageNotFoundError(input.slug, CREATE_IT_FIRST);
  }
  // Tenant write scope (mig047): a scoped caller must NEVER adopt the found
  // row's source_id — that is how an unresolved/mis-scoped principal could
  // append into (and re-stamp) another tenant's page. The scoped getPage above
  // already confines resolution to `input.source_id`, so a mismatch here means
  // a source-blind row leaked through; fail closed rather than write across it.
  // Unscoped (local/CLI) keeps the found row's source_id, unchanged.
  if (input.source_id && current.source_id !== input.source_id) {
    throw new PageNotFoundError(input.slug, CREATE_IT_FIRST);
  }
  const writeSourceId = input.source_id ?? current.source_id;
  // The body itself is NOT built here: putPage appends to the body it reads
  // under the slug's write lock, so racing appends each land after the last
  // instead of all starting from the body read above.
  // Type, title and truth are taken from the locked row inside putPage.
  return putPage(storage, {
    slug: input.slug,
    appendContent: input.content,
    written_by: input.written_by,
    source_id: writeSourceId,
    allowAdHocType: true, // existing type, definitionally allowed
    ...(input.receipt !== undefined ? { receipt: input.receipt } : {}),
    ...(input.written_by_principal !== undefined ? { written_by_principal: input.written_by_principal } : {}),
  });
}

export interface GetPageOptions {
  /** Surface a soft-deleted page (deleted_at populated) instead of hiding it. */
  includeDeleted?: boolean;
  /**
   * Also read the page's current version, in the same statement as the body,
   * so the pair can serve as an `expected_version` precondition: a write that
   * commits between two separate reads would pair the old body with the new
   * version, and a conditional put would then overwrite an edit never seen.
   */
  withVersion?: boolean;
}

export async function getPage(
  storage: Storage,
  slug: string,
  sourceIds?: readonly string[],
  opts: GetPageOptions = {},
): Promise<PageRow | null> {
  validateSlug(slug);
  const row = await getPageExact(storage, slug, sourceIds, opts);
  if (row) return row;
  // Miss — the slug may be an OLD name a rename/merge left a redirect for
  // (migration 067). Resolve one hop through the redirect registry and re-read.
  // Zero-cost on the hot path (a live page never reaches here); the extra
  // round-trip is paid only on an actual miss. A redirect that doesn't move the
  // slug (none registered / pre-067 brain) short-circuits without a re-query.
  const canonical = await resolveSlugWithAlias(storage, slug, sourceIds);
  if (canonical === slug) return null;
  return getPageExact(storage, canonical, sourceIds, opts);
}

/** Exact `pages` read by slug, tenant-scoped. No redirect resolution — the
 *  single-hop primitive `getPage` layers the redirect on top of. */
/**
 * Read a page by its exact slug — no rename-redirect hop. A background job that
 * acts for one write uses this: the redirect registry spans every source, so
 * following it could land on another tenant's page.
 */
export async function getPageExact(
  storage: Storage,
  slug: string,
  sourceIds?: readonly string[],
  opts: GetPageOptions = {},
): Promise<PageRow | null> {
  const params: unknown[] = [slug];
  const scope = andSourceScope("source_id", sourceIds, params);
  const deletedFilter = opts.includeDeleted === true ? "" : " AND deleted_at IS NULL";
  const versionCol = opts.withVersion === true
    ? `,
            (SELECT COALESCE(MAX(v.version_n), 0) FROM page_versions v WHERE v.slug = pages.slug)::int AS version`
    : "";
  const r = await storage.engine().query<PageRow>(
    `SELECT slug, type, title, compiled_truth,
            markdown_body, content_hash, source_id,
            created_at::text AS created_at,
            updated_at::text AS updated_at,
            deleted_at::text AS deleted_at${versionCol}
       FROM pages
       WHERE slug = $1${deletedFilter}${scope}`,
    params,
  );
  return r.rows[0] ?? null;
}

export const LIST_PAGES_SORTS = [
  "updated_desc",
  "updated_asc",
  "created_desc",
  "slug",
] as const;
export type ListPagesSort = (typeof LIST_PAGES_SORTS)[number];

// Whitelisted ORDER BY per sort key — the enum is validated at the boundary
// AND mapped through this table so an unsupported string can never reach SQL.
const PAGE_SORT_SQL: Record<ListPagesSort, string> = {
  updated_desc: "updated_at DESC",
  updated_asc: "updated_at ASC",
  created_desc: "created_at DESC",
  slug: `slug COLLATE "C" ASC`,
};

export interface ListPagesOptions {
  type?: string;
  since?: string;
  limit?: number;
  /** Filter to pages carrying this tag (normalized: trim + lowercase). */
  tag?: string;
  /** Sort order. Default `updated_desc` (the historical ordering). */
  sort?: ListPagesSort;
  /** Include soft-deleted pages (deleted_at populated). Default false. */
  includeDeleted?: boolean;
  /** Restrict to these owning sources. Omit → unscoped (whole brain); `[]` → nothing. */
  sourceIds?: readonly string[];
}

export async function listPages(
  storage: Storage,
  opts: ListPagesOptions = {},
): Promise<PageRow[]> {
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 1000
      ? Math.floor(opts.limit)
      : 50;
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.includeDeleted !== true) where.push("deleted_at IS NULL");
  if (opts.type) {
    params.push(opts.type.toLowerCase());
    where.push(`type = $${params.length}`);
  }
  if (opts.since) {
    params.push(opts.since);
    where.push(`updated_at >= $${params.length}::timestamptz`);
  }
  if (opts.tag) {
    // Same normalization as the tags CRUD boundary, so `Idea ` matches `idea`.
    params.push(opts.tag.replace(/\s+/g, " ").trim().toLowerCase());
    where.push(
      `EXISTS (SELECT 1 FROM tags t WHERE t.slug = pages.slug AND t.tag = $${params.length})`,
    );
  }
  if (opts.sourceIds !== undefined) {
    params.push([...opts.sourceIds]);
    where.push(`source_id = ANY($${params.length}::text[])`);
  }
  const order =
    PAGE_SORT_SQL[opts.sort ?? "updated_desc"] ?? PAGE_SORT_SQL.updated_desc;
  params.push(limit);
  const sql = `
    SELECT slug, type, title, compiled_truth,
           markdown_body, content_hash, source_id,
           created_at::text AS created_at,
           updated_at::text AS updated_at,
           deleted_at::text AS deleted_at
      FROM pages
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${order}
      LIMIT $${params.length}`;
  const r = await storage.engine().query<PageRow>(sql, params);
  return r.rows;
}

export async function pageVersions(
  storage: Storage,
  slug: string,
  limit = 20,
  sourceIds?: readonly string[],
  opts: { withPrincipal?: boolean } = {},
): Promise<PageVersionRow[]> {
  validateSlug(slug);
  const cap =
    typeof limit === "number" && limit >= 1 && limit <= 200
      ? Math.floor(limit)
      : 20;
  // Tenant scope (mig047): a scoped caller sees only versions stamped to its
  // own source(s). No-op when unset — the full version chain, as today.
  const params: unknown[] = [slug, cap];
  const sourceFilter = andSourceScope("source_id", sourceIds, params);
  const r = await storage.engine().query<PageVersionRow>(
    `SELECT slug, version_n, hash_prev, hash_new,
            body_snapshot, compiled_truth_snapshot,
            written_by, written_at::text AS written_at${opts.withPrincipal === true ? ", written_by_principal" : ""}
       FROM page_versions
       WHERE slug = $1${sourceFilter}
       ORDER BY version_n DESC
       LIMIT $2`,
    params,
  );
  return r.rows;
}

export interface DeleteResult {
  slug: string;
  /** True if the row was already soft-deleted (or absent) — call is idempotent. */
  already_deleted: boolean;
}

/**
 * Soft delete. The row remains in `pages` with `deleted_at` set so the
 * audit chain in `page_versions` stays intact. Hard delete (DROP-cascade)
 * is intentionally not exposed via MCP — a future GC job will sweep
 * pages whose `deleted_at` is older than retention.
 */
export async function deletePage(
  storage: Storage,
  slug: string,
  writtenBy?: string,
  writeSource?: string,
  opts: { expectedVersion?: number; writtenByPrincipal?: string } = {},
): Promise<DeleteResult> {
  validateSlug(slug);
  // Tenant write scope (mig047): when a scoped caller supplies its write source,
  // a slug owned by another source reads as "not found" (no-op / already_deleted)
  // — a scoped delete can never soft-delete a sibling tenant's page. Unset
  // (undefined) → no filter, whole-brain by slug exactly as today.
  const scope =
    typeof writeSource === "string" && writeSource.length > 0 ? writeSource : null;
  const engine = storage.engine();
  return engine.transaction(async (tx) => {
    await lockPageSlugs(tx, slug);
    const params: unknown[] = [slug];
    let sourceFilter = "";
    if (scope !== null) {
      params.push(scope);
      sourceFilter = ` AND source_id = $${params.length}`;
    }
    const r = await tx.query<{ content_hash: string; deleted_at: string | null; source_id: string }>(
      `SELECT content_hash, deleted_at::text AS deleted_at, source_id
         FROM pages WHERE slug = $1${sourceFilter}`,
      params,
    );
    if (opts.expectedVersion !== undefined) {
      // A page outside the caller's scope reads as absent — version 0 — so the
      // conflict never reports another tenant's version chain.
      const current = r.rows.length === 0 ? 0 : await currentPageVersion(tx, slug);
      checkExpectedVersion(slug, current, opts.expectedVersion);
    }
    if (r.rows.length === 0 || r.rows[0]!.deleted_at !== null) {
      return { slug, already_deleted: true };
    }
    const ts = new Date().toISOString();
    await tx.query(
      `UPDATE pages SET deleted_at = NOW(), updated_at = NOW()
        WHERE slug = $1${sourceFilter}`,
      params,
    );
    // Append a tombstone version so the history shows the deletion event.
    const nextN = await tx.query<{ n: number }>(
      `SELECT COALESCE(MAX(version_n), 0)::int + 1 AS n
         FROM page_versions WHERE slug = $1`,
      [slug],
    );
    const tombstone = JSON.stringify({ deleted_at: ts });
    // The marker belongs to the page's owner, so its own scoped history read
    // still sees the deletion.
    await tx.query(
      `INSERT INTO page_versions
         (slug, version_n, hash_prev, hash_new,
          body_snapshot, compiled_truth_snapshot, written_by, written_at, source_id, written_by_principal)
       VALUES ($1, $2, $3, $3, '', $4::text::jsonb, $5, NOW(), $6, $7)`,
      [
        slug,
        nextN.rows[0]!.n,
        r.rows[0]!.content_hash,
        tombstone,
        writtenBy ?? null,
        r.rows[0]!.source_id,
        opts.writtenByPrincipal ?? null,
      ],
    );
    await bumpPageGeneration(tx, slug);
    return { slug, already_deleted: false };
  });
}

export interface RestoreResult {
  slug: string;
  /** True when a soft-deleted page was undeleted; false if missing or live. */
  restored: boolean;
}

/**
 * Undelete a soft-deleted page (clear `deleted_at`). The page row + its full
 * version history are kept on delete specifically so this is possible; without
 * it an accidental `page_delete` is unrecoverable. Records a restore event in
 * the version chain. No-op (restored:false) when the page is missing or live.
 */
export async function restorePage(
  storage: Storage,
  slug: string,
  writtenBy?: string,
  writeSource?: string,
  opts: { writtenByPrincipal?: string } = {},
): Promise<RestoreResult> {
  validateSlug(slug);
  // Tenant write scope (mig047): a scoped caller can only undelete a page in its
  // own source; another tenant's soft-deleted page reads as "not found"
  // (restored:false). Unset → whole-brain by slug, unchanged.
  const scope =
    typeof writeSource === "string" && writeSource.length > 0 ? writeSource : null;
  const engine = storage.engine();
  return engine.transaction(async (tx) => {
    await lockPageSlugs(tx, slug);
    const params: unknown[] = [slug];
    let sourceFilter = "";
    if (scope !== null) {
      params.push(scope);
      sourceFilter = ` AND source_id = $${params.length}`;
    }
    const r = await tx.query<{ content_hash: string; deleted_at: string | null; source_id: string }>(
      `SELECT content_hash, deleted_at::text AS deleted_at, source_id
         FROM pages WHERE slug = $1${sourceFilter}`,
      params,
    );
    if (r.rows.length === 0 || r.rows[0]!.deleted_at === null) {
      return { slug, restored: false };
    }
    await tx.query(
      `UPDATE pages SET deleted_at = NULL, updated_at = NOW() WHERE slug = $1${sourceFilter}`,
      params,
    );
    const nextN = await tx.query<{ n: number }>(
      `SELECT COALESCE(MAX(version_n), 0)::int + 1 AS n
         FROM page_versions WHERE slug = $1`,
      [slug],
    );
    const marker = JSON.stringify({ restored_at: new Date().toISOString() });
    await tx.query(
      `INSERT INTO page_versions
         (slug, version_n, hash_prev, hash_new,
          body_snapshot, compiled_truth_snapshot, written_by, written_at, source_id, written_by_principal)
       VALUES ($1, $2, $3, $3, '', $4::text::jsonb, $5, NOW(), $6, $7)`,
      [slug, nextN.rows[0]!.n, r.rows[0]!.content_hash, marker, writtenBy ?? null, r.rows[0]!.source_id, opts.writtenByPrincipal ?? null],
    );
    await bumpPageGeneration(tx, slug);
    return { slug, restored: true };
  });
}

export interface RevertResult {
  slug: string;
  /** True when the body was rolled back (false = page missing/deleted, version
   *  not found, target is an event marker, or content already identical). */
  reverted: boolean;
  /** The target version reverted TO (null when not found). */
  from_version: number | null;
  /** The NEW version number created by the revert (null when no change). */
  new_version: number | null;
  reason?: string;
}

/**
 * Roll a page's body back to a prior `page_versions` snapshot. memrain keeps a
 * full body snapshot per version but offered no rollback until now. Reverting
 * creates a NEW version with the old content (history is append-only, never
 * rewritten); reuses `putPage` so type/title are preserved and the change flows
 * through the normal write path (generation bump, links, facts).
 */
export async function revertPage(
  storage: Storage,
  slug: string,
  targetVersion: number,
  writtenBy?: string,
  writeSource?: string,
  opts: { expectedVersion?: number; writtenByPrincipal?: string } = {},
): Promise<RevertResult> {
  validateSlug(slug);
  // Tenant write scope (mig047): confine the page fetch, the version snapshot
  // read, and the re-put to the caller's write source. A slug owned by another
  // tenant resolves to "page not found" here — a scoped revert can never roll
  // back a sibling tenant's page. Unset → whole-brain by slug, unchanged.
  const scope =
    typeof writeSource === "string" && writeSource.length > 0 ? writeSource : null;
  // Exact read (NOT redirect-aware): revert re-puts under this literal slug, so
  // following a redirect here would resurrect a renamed-away slug. A revert of
  // an old slug correctly reports "page not found".
  const page = await getPageExact(storage, slug, scope !== null ? [scope] : undefined);
  if (!page) {
    return { slug, reverted: false, from_version: null, new_version: null, reason: "page not found or deleted" };
  }
  const snapParams: unknown[] = [slug, targetVersion];
  let snapFilter = "";
  if (scope !== null) {
    snapParams.push(scope);
    snapFilter = ` AND source_id = $${snapParams.length}`;
  }
  const snap = await storage.engine().query<{
    body_snapshot: string;
    compiled_truth_snapshot: Record<string, unknown>;
  }>(
    `SELECT body_snapshot, compiled_truth_snapshot
       FROM page_versions WHERE slug = $1 AND version_n = $2${snapFilter}`,
    snapParams,
  );
  const row = snap.rows[0];
  if (!row) {
    return { slug, reverted: false, from_version: null, new_version: null, reason: `version ${targetVersion} not found` };
  }
  // An event marker (delete/restore) carries no real body — refuse to revert to
  // it (it would blank the page); use page_restore for deletion events.
  const truth = row.compiled_truth_snapshot ?? {};
  if (
    Object.hasOwn(truth, "deleted_at") ||
    Object.hasOwn(truth, "restored_at")
  ) {
    return { slug, reverted: false, from_version: targetVersion, new_version: null, reason: "target is a delete/restore event, not a content version" };
  }
  // Preserve the CURRENT title + type: page_versions has no title column, and
  // putPage does NOT preserve an omitted title (it nulls it). Passing the live
  // title keeps revert body-only — and keeps revert-to-identical idempotent
  // (omitting it would null the title, forcing a spurious version).
  const put = await putPage(storage, {
    slug,
    markdown_body: row.body_snapshot,
    // Reverting to a version whose body was empty is a deliberate clear.
    allowEmptyBody: true,
    compiled_truth: truth,
    ...(page.title != null ? { title: page.title } : {}),
    ...(writtenBy ? { written_by: writtenBy } : {}),
    // Stamp the re-put with the caller's write source so putPage's cross-tenant
    // guard accepts it (the page is owned by `scope`, not 'default').
    ...(scope !== null ? { source_id: scope } : {}),
    // Checked by putPage under the slug lock, so an edit that lands between
    // the snapshot read above and the re-put is caught, not reverted over.
    ...(opts.expectedVersion !== undefined ? { expectedVersion: opts.expectedVersion } : {}),
    ...(opts.writtenByPrincipal !== undefined ? { written_by_principal: opts.writtenByPrincipal } : {}),
  });
  return {
    slug,
    reverted: put.changed,
    from_version: targetVersion,
    new_version: put.changed ? put.version_n : null,
  };
}

export interface RenameResult {
  from_slug: string;
  to_slug: string;
  /** True when the page moved; false = source missing, target taken, same slug. */
  renamed: boolean;
  reason?: string;
  /** Per-table rows carried across (observability only). */
  moved?: Record<string, number>;
}

export interface RenameOptions {
  written_by?: string;
  /** Owning source (tenant). When set, the rename resolves + carries ONLY within
   *  this source — a page owned by another tenant reads as "not found". */
  source_id?: string;
}

/**
 * Rename (or merge-forward) a page to a new slug, preserving its history WITHIN
 * the current global-slug-PK model — NO composite-PK / integer-page-id schema
 * change (that overhaul stays deferred; see composite_pk_precursor test).
 *
 * The move is transactional: a new `pages` row is inserted at `toSlug`, every
 * substrate table that keys on the slug is re-pointed old→new, the old row is
 * deleted, and a durable `old→new` redirect is written to `slug_aliases`
 * (migration 067) so stale `[[old-slug]]` wikilinks and direct `page_get
 * old-slug` calls still resolve. Carried tables: page_versions, links
 * (source+target), tags, timeline_events, entity_facts, hot_memory,
 * page_aliases.
 *
 * SEARCH MIRROR: the `documents`/`chunks`/`embeddings` projection is NOT moved
 * here — its ids are derived from the mirror `source_path`, so re-keying it in
 * place would fight the FK graph. Instead the existing cycle backstop
 * (`reconcilePageMirrors`) re-mirrors the new slug and drops the old orphan on
 * its next pass — the same self-healing path a normal page_put relies on. The
 * caller may drop the old mirror eagerly (removePageFromSearch) for immediacy.
 *
 * No-op results (renamed:false): source page missing/deleted, target slug
 * already taken (live OR soft-deleted — the global PK forbids a second row), or
 * from==to.
 */
export async function renamePage(
  storage: Storage,
  fromSlug: string,
  toSlug: string,
  opts: RenameOptions = {},
): Promise<RenameResult> {
  validateSlug(fromSlug);
  validateSlug(toSlug);
  if (fromSlug === toSlug) {
    return { from_slug: fromSlug, to_slug: toSlug, renamed: false, reason: "from and to slugs are identical" };
  }
  const scope =
    typeof opts.source_id === "string" && opts.source_id.length > 0
      ? opts.source_id
      : null;
  const writtenBy = opts.written_by ?? null;
  const engine = storage.engine();
  // Deadlock-safe: the fact re-point holds row locks and `carryFactWithdrawals`
  // then takes the withdraw lock, the order a concurrent forget uses too, so
  // Postgres can pick either side as the victim (see retry.ts).
  return deadlockSafeTransaction(engine, async (tx) => {
    await lockPageSlugs(tx, fromSlug, toSlug);
    // Source page must exist, be live, and (when scoped) be owned by the caller.
    const srcParams: unknown[] = [fromSlug];
    let srcFilter = "";
    if (scope !== null) {
      srcParams.push(scope);
      srcFilter = ` AND source_id = $${srcParams.length}`;
    }
    const src = await tx.query<{ source_id: string; content_hash: string }>(
      `SELECT source_id, content_hash FROM pages
        WHERE slug = $1 AND deleted_at IS NULL${srcFilter}`,
      srcParams,
    );
    if (src.rows.length === 0) {
      return { from_slug: fromSlug, to_slug: toSlug, renamed: false, reason: "source page not found or deleted" };
    }
    const ownerSource = src.rows[0]!.source_id;

    // Target slug must be globally free — the `pages.slug` PK forbids a second
    // row for it, even a soft-deleted one.
    const dst = await tx.query<{ slug: string }>(
      `SELECT slug FROM pages WHERE slug = $1`,
      [toSlug],
    );
    if (dst.rows.length > 0) {
      return { from_slug: fromSlug, to_slug: toSlug, renamed: false, reason: "target slug already exists" };
    }

    // Insert the new row as a copy of the old (fresh generation/salience — the
    // cycle re-derives those; created_at carried so provenance survives).
    await tx.query(
      `INSERT INTO pages
         (slug, type, title, compiled_truth, markdown_body,
          content_hash, source_id, created_at, updated_at)
       SELECT $2, type, title, compiled_truth, markdown_body,
              content_hash, source_id, created_at, NOW()
         FROM pages WHERE slug = $1`,
      [fromSlug, toSlug],
    );

    const moved: Record<string, number> = {};
    const move = async (label: string, sql: string, params: unknown[]): Promise<void> => {
      const r = await tx.query<{ one: number }>(sql, params);
      moved[label] = r.rows.length;
    };

    // FK children (ON DELETE CASCADE, no ON UPDATE) — re-point BEFORE deleting
    // the old row so the delete cascades nothing.
    await move(
      "page_versions",
      `UPDATE page_versions SET slug = $2 WHERE slug = $1 RETURNING 1 AS one`,
      [fromSlug, toSlug],
    );
    await move(
      "timeline_events",
      `UPDATE timeline_events SET slug = $2 WHERE slug = $1 RETURNING 1 AS one`,
      [fromSlug, toSlug],
    );
    await move(
      "page_aliases",
      `UPDATE page_aliases SET slug = $2 WHERE slug = $1 RETURNING 1 AS one`,
      [fromSlug, toSlug],
    );
    await move(
      "links_out",
      `UPDATE links SET source_slug = $2 WHERE source_slug = $1 RETURNING 1 AS one`,
      [fromSlug, toSlug],
    );
    // Inbound edges: drop rows that would collide with an existing (source,
    // to, type, source_id) edge before re-pointing, so the UPDATE can't trip
    // the tenant-aware unique key.
    await tx.query(
      `DELETE FROM links l
        WHERE l.target_slug = $1
          AND EXISTS (
            SELECT 1 FROM links x
             WHERE x.source_slug = l.source_slug
               AND x.target_slug = $2
               AND x.type = l.type
               AND x.source_id = l.source_id)`,
      [fromSlug, toSlug],
    );
    await move(
      "links_in",
      `UPDATE links SET target_slug = $2 WHERE target_slug = $1 RETURNING 1 AS one`,
      [fromSlug, toSlug],
    );

    // Non-FK data tables keyed by the slug.
    await move(
      "tags",
      `UPDATE tags SET slug = $2 WHERE slug = $1 RETURNING 1 AS one`,
      [fromSlug, toSlug],
    );
    await move(
      "entity_facts",
      `UPDATE entity_facts SET entity_slug = $2 WHERE entity_slug = $1 RETURNING 1 AS one`,
      [fromSlug, toSlug],
    );
    await tx.query(
      `UPDATE entity_facts SET source_markdown_slug = $2 WHERE source_markdown_slug = $1`,
      [fromSlug, toSlug],
    );
    // Forgotten claims follow the facts to the new slug (migration 112).
    const withdrawnFacts = await carryFactWithdrawals(tx, fromSlug, toSlug, null);
    if (withdrawnFacts > 0) moved.withdrawn_facts = withdrawnFacts;
    await move(
      "hot_memory",
      `UPDATE hot_memory SET entity_slug = $2 WHERE entity_slug = $1 RETURNING 1 AS one`,
      [fromSlug, toSlug],
    );
    await tx.query(
      `UPDATE hot_memory SET source_slug = $2 WHERE source_slug = $1`,
      [fromSlug, toSlug],
    );

    // Drop the old row — its FK children are already moved, so nothing cascades.
    await tx.query(`DELETE FROM pages WHERE slug = $1`, [fromSlug]);

    // Durable redirect old→new (source-scoped) + a tombstone version on the new
    // page so the move shows up in history.
    await setSlugAlias(tx, {
      alias_slug: fromSlug,
      canonical_slug: toSlug,
      source_id: scope ?? ownerSource,
      notes: "rename",
    });
    const nextN = await tx.query<{ n: number }>(
      `SELECT COALESCE(MAX(version_n), 0)::int + 1 AS n
         FROM page_versions WHERE slug = $1`,
      [toSlug],
    );
    const marker = JSON.stringify({ renamed_from: fromSlug, renamed_at: new Date().toISOString() });
    await tx.query(
      `INSERT INTO page_versions
         (slug, version_n, hash_prev, hash_new,
          body_snapshot, compiled_truth_snapshot, written_by, written_at, source_id)
       VALUES ($1, $2, $3, $3, '', $4::text::jsonb, $5, NOW(), $6)`,
      [toSlug, nextN.rows[0]!.n, src.rows[0]!.content_hash, marker, writtenBy, ownerSource],
    );
    await bumpPageGeneration(tx, toSlug);

    return { from_slug: fromSlug, to_slug: toSlug, renamed: true, moved };
  });
}
