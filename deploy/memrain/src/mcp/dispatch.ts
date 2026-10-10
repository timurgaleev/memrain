/**
 * MCP tool dispatcher — turns a `tools/call` request body into a call
 * against existing core functions. Returns MCP-shaped content blocks
 * (`{ type: "text", text: "..." }`).
 *
 * Error handling: any thrown error becomes an `isError: true` result
 * (per MCP spec) instead of a JSON-RPC error envelope. JSON-RPC errors
 * are reserved for protocol-level failures (malformed request etc.).
 */
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Storage } from "../core/storage.ts";
import {
  type AuthInfo,
  effectiveReadSourceIdsForIngress,
  effectiveTakesHolders,
  effectiveWriteSourceIdForIngress,
  tenantFailClosedEnabled,
  isNoSourceSentinel,
  NO_SOURCE_SENTINEL,
} from "../core/auth-info.ts";
import { hybridSearch, type SearchOptions } from "../core/search/index.ts";
import { publicSearchMeta, type SearchMeta } from "../core/search/search-meta.ts";
import { resolveDateBoundary } from "../core/search/filters.ts";
import { indexDocument, indexFile } from "../core/indexer.ts";
import { findBacklinks } from "../core/backlinks.ts";
import {
  brainHealthMetrics,
  collectPerSourceHealth,
} from "../core/source-health.ts";
import {
  isWithinAllowedRoot,
  loadAllowedRootSpellings,
  PathGuardConfigError,
} from "../core/path_guard.ts";
import {
  logFriction,
  VALID_FRICTION_KINDS,
  type FrictionKind,
} from "../core/friction.ts";
import type { EntityType } from "../core/entities.ts";
import { makeCaptureCallback } from "../core/eval-capture.ts";
import {
  putPage,
  appendPage,
  deletePage,
  restorePage,
  revertPage,
  getPage,
  listPages,
  pageVersions,
  KNOWN_PAGE_TYPES,
  isDiarySourcePath,
  type PageInput,
} from "../core/pages.ts";
import type { Engine } from "../core/engine/interface.ts";
import { isExcludedOrphanWriter } from "../core/orphan-policy.ts";
import { applyRecallBudget } from "../core/recall-budget.ts";
import {
  addLink,
  removeLink,
  graphNeighbors,
  graphQuery,
  traverseGraph,
  syncWikilinksForPage,
  syncVerbLinksForPage,
  slugifyTarget,
  stampLinksExtracted,
  type GraphNeighborsOptions,
  type GraphQueryOptions,
  type TraverseGraphOptions,
} from "../core/links.ts";
import { syncMentionsForPage } from "../core/gazetteer.ts";
import { syncTypedLinksForPage, typedLinksEnabled } from "../core/typed-links.ts";
import { bumpLastRetrievedAt } from "../core/last-retrieved.ts";
import { linkVerbInferEnabled } from "../core/link-verb-infer.ts";
import {
  mirrorPage,
  removePageFromSearch,
  isPageSourcePath,
} from "../core/page-index.ts";
import { getChunksForPage, getChunksForSource } from "../core/chunks-read.ts";
import { resolveSlugs } from "../core/slug-resolve.ts";
import { addTag, removeTag, getTags } from "../core/tags.ts";
import { relationalRecall } from "../core/search/relational-recall.ts";
import { relationalRecallLlm } from "../core/search/relational-llm.ts";
import { getLinks, listLinkSources } from "../core/links-read.ts";
import {
  findOrphans,
  findExperts,
  findContradictions,
  listProbedContradictions,
  findTrajectory,
  type FindOrphansOptions,
  type FindExpertsOptions,
  type FindContradictionsOptions,
  type FindTrajectoryOptions,
} from "../core/insights.ts";
import { getRecentSalience, findAnomalies } from "../core/usage-insights.ts";
import { recallFact, forgetFact } from "../core/facts-recall.ts";
import { brainIdentity } from "../core/identity.ts";
import { purgeDeletedPages } from "../core/pages-purge.ts";
import { queryRefine } from "../core/search/query-refine.ts";
import { codeCallers, codeCallees, codeDefs, codeRefs } from "../core/code-graph.ts";
import { runRecursiveWalk } from "../core/code-walk.ts";
import { parseWindow, volunteerContext, volunteerUsageStats } from "../core/context/volunteer.ts";
import { buildContextPack, type ContextPackOpts } from "../core/context/context-pack.ts";
import {
  logVolunteerEventsFireAndForget,
  volunteerEventRowsFrom,
} from "../core/context/volunteer-events.ts";
import { runAdvisor } from "../core/advisor/run.ts";
import { listBrainSkillpacks, getBrainSkill } from "../core/skillpack/brain-resident.ts";
import {
  listConcepts,
  listTakes,
  searchTakes,
  getCalibrationProfile,
  getTakesScorecard,
  getTakesCalibration,
} from "../core/synthesis/reads.ts";
import { listRecentTranscripts } from "../core/transcripts-read.ts";
import { setTakeStatus } from "../core/synthesis/takes.ts";
import { syncTakesFromFence } from "../core/synthesis/takes-canon.ts";
import { hasFenceMarker } from "../core/fence-shared.ts";
import { VERSION } from "../version.ts";
import {
  reconcileFactsForPage,
  purgeFenceFactsForPage,
} from "../core/facts-reconcile.ts";
import {
  factsExtractionEnabled,
  isFactsExtractionEligible,
  extractFactsForPage,
  extractFactsOnDemand,
} from "../core/facts-extract.ts";
import { getFactsQueue } from "../core/facts-queue.ts";
import {
  getTimelineForDate,
  getSince,
  getOnThisDay,
  getLastSeen,
} from "../core/chronicle.ts";
import {
  mergeOntologyFact,
  getOntology,
  discoverOntologyDimensions,
  findOntologyConflicts,
} from "../core/ontology-facts.ts";
import { loadChronicleContext } from "../core/context/chronicle-context.ts";
import { renderTimelineNarrative } from "../core/chronicle/narrative.ts";
import { chronicleEnabled } from "../core/chronicle/config.ts";
import { isChronicleEligible } from "../core/chronicle/eligibility.ts";
import type {
  ChronicleTimelineOpts,
  OntologyConflict,
  OntologyObservationInput,
  OntologyReadOpts,
  OntologyValue,
} from "../core/chronicle/types.ts";
import {
  addTimelineEvent,
  getEntityTimeline,
  type ListTimelineOptions,
} from "../core/timeline.ts";
import { syncBodyTimelineForPage, type BodyTimelineSyncResult } from "../core/timeline-body.ts";
import {
  addFact,
  listFacts,
  listSupersessions,
  entityRecall,
  type ListFactsOptions,
  type ListSupersessionsOptions,
  type EntityRecallOptions,
} from "../core/facts.ts";
import { putRawData, getRawData } from "../core/raw-data.ts";
import { logIngest, getIngestLog } from "../core/ingest-log.ts";
import { Queue } from "../core/jobs/queue.ts";
import { PAGE_MIRROR_JOB_KIND } from "../core/jobs/page-mirror-handler.ts";
import { isKnownJobKind, knownJobKinds } from "../core/jobs/handlers.ts";
import { getJobProgress } from "../core/jobs/lifecycle.ts";
import { runThink, type ThinkOptions, type ThinkResult } from "../core/synthesis/think.ts";
import { isNoGrant } from "../core/source-scope.ts";
import {
  persistThinkSynthesis,
  saveThinkTake,
} from "../core/synthesis/think-persist.ts";
import { listSources, getSource, resolveSourceForPath, SOURCE_KINDS, type SourceKind } from "../core/sources.ts";
import { cacheStats } from "../core/search/query-cache.ts";
import { currentDocumentClock } from "../core/generation.ts";
import {
  readWorkerLock,
  DEFAULT_WORKER_LOCK_ID,
} from "../core/jobs/worker-lock.ts";
import {
  checkFederationHealth,
  checkOauthClientHealth,
  checkOauthClientHygiene,
  checkSourceRoutingHealth,
  checkDocumentIdDrift,
  type TenancyCheck,
} from "../core/doctor-tenancy.ts";
import { couldNotCheck, worstStatus } from "../core/doctor-categories.ts";
import {
  checkStaleLocks,
  checkQueueHealth,
  checkSchemaVersion,
  checkEmbeddingWidth,
  checkInvalidIndexes,
} from "../core/doctor-ops.ts";
import { checkConnectorHealth } from "../core/connectors/health.ts";
import {
  checkClientBudget,
  runWithSpendClient,
} from "../core/budget.ts";
import { MODE_BUNDLES, isSearchMode, expansionActive } from "../core/search/mode.ts";
import { looksConceptShaped } from "../core/search/query-intent.ts";
import {
  cancelJob,
  getJob,
  listJobs,
  submitJob,
  type ListJobsOptions,
  type SubmitJobInput,
} from "../core/jobs/dag.ts";
// Public-ingress body redaction is shared with the REST routes via a
// neutral core module so neither ingress layer imports the other (an
// http/ import here created a module cycle).
import {
  redactBodies,
  redactBody,
  redactFacts,
  redactTimeline,
  redactBacklinks,
  redactJob,
  redactGraphLinks,
  publicReadBodiesAllowed,
  publicSafeErrorMessage,
} from "../core/public_redaction.ts";
import { OperationError, PageNotFoundError, isOperationError } from "../core/operation-error.ts";
import { suggestSlugs } from "../core/slug-suggest.ts";
import { getBrainHotMemoryMeta, invalidateHotMemoryMeta } from "../core/hot-memory-meta.ts";
import { normalizeAddFactItems, runAddFactBatch } from "../core/facts-batch.ts";
import { replaceFact } from "../core/facts-replace.ts";
import { similarActiveAfterForget } from "../core/facts-similar-active.ts";
import { ReferenceDateError, resolveThinkTemporalContext } from "../core/synthesis/think-temporal.ts";
import { MAX_REQUEST_ID_LEN, OPERATIONS, validateParams } from "./operations.ts";
import {
  claimWriteRequest,
  completeWriteRequest,
  releaseWriteRequest,
  writeRequestArgsHash,
  type WriteRequestKey,
} from "../core/write-requests.ts";
import { hasScope } from "../core/scope.ts";
import { insufficientScopeChallenge } from "../http/oauth-metadata.ts";
import { dispatchRefusal, SLUG_PARAMS_BY_WRITE_TOOL } from "./visibility.ts";

export { OPERATOR_ONLY_TOOLS } from "./visibility.ts";

// Operation lookup by tool name, built once (the contract is static).
const OP_BY_NAME = new Map(OPERATIONS.map((o) => [o.name, o]));

export interface ToolCallRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ToolContentBlock {
  type: "text";
  text: string;
}

export interface ToolCallResult {
  content: ToolContentBlock[];
  isError?: boolean;
  /** MCP `_meta` — out-of-band data attached to a result. Used for the
   *  best-effort `brain_hot_memory` injection (see the dispatchTool wrapper). */
  _meta?: Record<string, unknown>;
}

const VALID_ENTITY_TYPES: ReadonlySet<EntityType> = new Set([
  "wikilink",
  "tag",
  "date",
]);

/**
 * Tools that stamp/filter on the caller's WRITE source (they receive
 * `writeSource` in the dispatch switch). Under the fail-closed policy an
 * authenticated public principal with NO write grant must be rejected on these
 * before any handler runs — never allowed to default to the 'default' tenant.
 * A non-write op is unaffected (reads keep their own scope resolver).
 *
 * The set is DERIVED from each op's `scope: "write"` field in operations.ts (the
 * single source of truth), so a new write op declares its scope once on the op
 * and is automatically gated here — no separate list to keep in lock-step. The
 * source_id FK is still the backstop if one is ever mis-tagged (the sentinel
 * can't reference a real row).
 */

export function slugUnderPrefixes(
  slug: string,
  prefixes: readonly string[],
): boolean {
  return prefixes.some(
    (p) => slug === p || slug.startsWith(p.endsWith("/") ? p : `${p}/`),
  );
}

/**
 * link/unlink accept PERMISSIVE input that addLink/removeLink slugify before
 * storing — the fence must judge the value that will be STORED, not the raw
 * string, or a mixed-script input (a non-Latin first segment ASCII-folds
 * away entirely) would fold OUT of
 * the checked prefix after passing the check. Page/fact tools validate their
 * slug params raw (no normalization), so raw comparison is correct there.
 */
const SLUGIFIED_FENCE_TOOLS: ReadonlySet<string> = new Set(["link", "unlink"]);

/** Throws unless every mutated slug of `tool` falls under one of `prefixes`. */
function enforceSlugPrefixFence(
  tool: string,
  args: Record<string, unknown>,
  prefixes: readonly string[],
): void {
  const slugParams = SLUG_PARAMS_BY_WRITE_TOOL[tool];
  if (!slugParams) {
    throw new OperationError(
      "permission_denied",
      `tool '${tool}' is not callable by a slug-bound client`,
      "This client is bound to slug prefixes; only slug-addressed write tools are allowed.",
    );
  }
  for (const param of slugParams) {
    const value = args[param];
    // A missing/malformed value is the param validator's problem; the fence
    // only judges slugs that are actually present as strings.
    if (typeof value !== "string" || value.length === 0) continue;
    const judged = SLUGIFIED_FENCE_TOOLS.has(tool) ? slugifyTarget(value) : value;
    if (!slugUnderPrefixes(judged, prefixes)) {
      throw new OperationError(
        "permission_denied",
        `slug '${value}' is outside this client's bound prefixes`,
        `Writes are confined to: ${prefixes.join(", ")}.`,
      );
    }
  }
}

/** Per-call options the transport supplies. */
export interface DispatchOptions {
  /** True when the request arrived over the public ingress
   *  (`brain.<domain>/mcp` via Cloudflare). Read tools then redact note
   *  bodies unless `MEMRAIN_PUBLIC_READ_BODIES` is opted-in — identical to
   *  the REST routes so the two ingress paths cannot diverge. */
  isPublic?: boolean;
  /** Resolved caller identity. When present, its source grant scopes every
   *  read (to `allowedSources`/`sourceId`) and stamps every write
   *  (`sourceId`). Absent → unscoped (local/internal whole-brain access). */
  authInfo?: AuthInfo;
  /**
   * Query-embedder injection for the two search-backed tools (`search`,
   * `query`), forwarded verbatim to `SearchOptions.embedQuery`
   * (`core/search/hybrid.ts:236`). Set ONLY by hermetic benches, so the vector
   * arm runs on deterministic vectors instead of Bedrock. Production never
   * passes this — no transport reads it.
   */
  embedQuery?: SearchOptions["embedQuery"];
  /** This server's OAuth issuer, named in the step-up challenge a scope
   *  refusal carries so the client can find the authorization server. */
  issuer?: string;
}

/**
 * Public entry: dispatch the tool call, then best-effort attach the
 * `_meta.brain_hot_memory` payload (recent live facts, see core/hot-memory-meta.ts).
 *
 * The injection is gated hard: it runs ONLY for a successful, non-public,
 * UNSCOPED (operator / trusted-local, `authInfo === undefined`) call, and is a
 * no-op unless MEMRAIN_HOT_MEMORY_META=1. The payload carries raw fact text of
 * every visibility, so it must never reach a public or tenant-scoped caller.
 * Any error here is swallowed — the meta hook can NEVER fail a tool call.
 */
export async function dispatchTool(
  storage: Storage,
  req: ToolCallRequest,
  opts: DispatchOptions = {},
): Promise<ToolCallResult> {
  // Every paid Bedrock call inside this dispatch books against the calling
  // client, so `budget_usd_per_day` covers all of them and not only the three
  // ops whose handler happens to echo `spentUsd`.
  const auth = opts.authInfo;
  const spendClient = auth
    ? {
        clientId: auth.spendId ?? auth.clientId,
        ...(auth.budgetUsdPerDay !== undefined ? { capUsd: auth.budgetUsdPerDay } : {}),
      }
    : null;
  const result = await runWithSpendClient(spendClient, () =>
    dispatchToolInner(storage, req, opts),
  );
  const injectable =
    !result.isError &&
    !(opts.isPublic ?? false) &&
    opts.authInfo === undefined;
  if (injectable) {
    try {
      const readSources = effectiveReadSourceIdsForIngress(opts.authInfo, {
        failClosed: tenantFailClosedEnabled(),
      });
      const meta = await getBrainHotMemoryMeta(storage, readSources !== undefined ? { sourceIds: readSources } : {});
      if (meta) return { ...result, _meta: meta };
    } catch {
      // Best-effort: never let the meta hook fail the underlying tool call.
    }
  }
  return result;
}

/** Tools whose `id` is an entity_facts id a client may hold as a string. */
const FACT_ID_TOOLS = new Set(["recall", "forget_fact"]);
// Anchored with a bounded repeat, so matching is linear in the input; 16
// digits covers every safe integer and the isSafeInteger check below drops
// the few 16-digit values above 2^53.
const CANONICAL_FACT_ID = /^[1-9]\d{0,15}$/;

/**
 * A fact id may come back as the canonical decimal string: JSON clients that
 * keep 64-bit ids as text, and callers that stored an id handed out before ids
 * were normalized to numbers. Only that exact shape is converted, on a copy;
 * anything else is left for the integer check to refuse.
 */
export function coerceFactIdArg(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!FACT_ID_TOOLS.has(name)) return args;
  const id = args["id"];
  if (typeof id !== "string" || !CANONICAL_FACT_ID.test(id)) return args;
  const n = Number(id);
  if (!Number.isSafeInteger(n)) return args;
  return { ...args, id: n };
}

async function dispatchToolInner(
  storage: Storage,
  req: ToolCallRequest,
  opts: DispatchOptions = {},
): Promise<ToolCallResult> {
  const args = coerceFactIdArg(req.name, req.arguments ?? {});
  // Mirror the REST layer's public-read policy exactly: redact bodies on
  // public ingress unless the operator opted into MEMRAIN_PUBLIC_READ_BODIES.
  const redact =
    (opts.isPublic ?? false) && !publicReadBodiesAllowed();
  // Graph-edge provenance (source_chunk_id, written_at, confidence, row id)
  // is structural metadata — NOT a note body — so it is stripped on ANY
  // public ingress, independent of MEMRAIN_PUBLIC_READ_BODIES (that flag only
  // governs free-text bodies). The public graph projection keeps slugs + the
  // edge type regardless; provenance is never returned publicly.
  const redactGraph = opts.isPublic ?? false;
  // The caller's tenant grant: read scope (union of allowed sources) + the
  // single write source. Undefined when no authInfo → unscoped whole-brain
  // (local CLI / internal token), preserving single-tenant behavior.
  const readSources = effectiveReadSourceIdsForIngress(opts.authInfo, {
    failClosed: tenantFailClosedEnabled(),
  });
  // The write source, with the same fail-closed floor as reads: an
  // authenticated PUBLIC principal holding no write grant resolves to the
  // NO_SOURCE_SENTINEL, which the gate below turns into permission_denied on any
  // write op — it must NEVER fall through and stamp the shared 'default' tenant.
  // Undefined (static bearer / trusted-local / OAuth non-public) stays unscoped.
  const writeSourceRaw = effectiveWriteSourceIdForIngress(opts.authInfo, {
    failClosed: tenantFailClosedEnabled(),
  });
  const writeDenied = isNoSourceSentinel(writeSourceRaw);
  const writeSource = writeDenied ? undefined : writeSourceRaw;
  // The operator identity: trusted-local / static-bearer over internal ingress.
  // Per-call `mode` escalation and think save/take persistence key on this.
  const isOperator = opts.authInfo === undefined && !(opts.isPublic ?? false);
  // Untrusted caller for the chronicle surface: any public-ingress OR OAuth
  // tenant principal. Drives diary/private redaction in the ontology reads —
  // defence-in-depth on top of the public denylist (the public bearer can't
  // reach chronicle tools at all).
  const remote = (opts.isPublic ?? false) || opts.authInfo !== undefined;
  // The token's takes-holder allow-list (mig 072, enforced since mig 091):
  // undefined for the operator path and knobless credentials.
  const takesHolders = effectiveTakesHolders(opts.authInfo);
  try {
    // Tool-level gates, in order: the fail-closed write gate (a scopeless
    // authenticated principal on a write op, default-OFF unless
    // MEMRAIN_TENANT_FAIL_CLOSED=1), operator-only tools for any authenticated
    // tenant principal, the per-op OAuth scope, and a slug-bound client's
    // deny-by-default on write ops that name no slug. The static daily bearer
    // and trusted-local path (`authInfo === undefined`) are the operator and
    // pass all of them. tools/list asks the same predicate (mcp/visibility.ts),
    // so a listed tool is never refused here.
    const refusal = dispatchRefusal(req.name, opts.authInfo);
    if (refusal?.kind === "no_write_source") {
      throw new OperationError(
        "permission_denied",
        `no write source is granted to this client for '${req.name}'`,
        "Request a write scope for your client, or use a scoped token.",
      );
    }
    if (refusal?.kind === "operator_only") {
      throw new OperationError(
        "permission_denied",
        `tool '${req.name}' is operator-only and not callable by a tenant token`,
        "Use the per-source 'source_health' tool for tenant-scoped health.",
      );
    }
    if (refusal?.kind === "insufficient_scope" && opts.authInfo !== undefined) {
      const { requiredScope } = refusal;
      const scopeRefusal = new OperationError(
        "insufficient_scope",
        `tool '${req.name}' requires the '${requiredScope}' scope`,
        "Request a token granted the required scope.",
      );
      // The Bearer challenge a client would get on an HTTP 403, carried in
      // the result because a tool call's HTTP status is always 200. A client
      // that understands it re-authorizes for the wider scope (step-up).
      const stepUp = [...new Set([...(opts.authInfo.scopes ?? []), requiredScope])];
      return {
        ...errResult(JSON.stringify(scopeRefusal.toEnvelope(opts.isPublic ?? false))),
        _meta: { "mcp/www_authenticate": insufficientScopeChallenge(stepUp, opts.issuer) },
      };
    }
    if (refusal?.kind === "slug_bound") {
      throw new OperationError(
        "permission_denied",
        `tool '${req.name}' is not callable by a slug-bound client`,
        "This client is bound to slug prefixes; only slug-addressed write tools are allowed.",
      );
    }
    // Enforce the declared param contract (type / enum / min-max of present
    // params) before dispatch. Known tools only — an unknown name falls through
    // to the switch default. Throws OperationError('invalid_params'), rendered
    // by the catch below.
    const op = OP_BY_NAME.get(req.name);
    if (op) validateParams(op, args);
    // Per-client slug-prefix write fence (oauth_clients.bound_slug_prefixes):
    // a bound principal may mutate only slugs under its prefixes. Deny-by-
    // default — a write/admin op that names no slug (index, extract_facts,
    // think, …) is refused for bound clients, so a new write tool can never
    // bypass the fence by omission. Unbounded clients are unaffected.
    const boundPrefixes = opts.authInfo?.boundSlugPrefixes;
    if (
      boundPrefixes &&
      boundPrefixes.length > 0 &&
      (op?.scope === "write" || op?.scope === "admin")
    ) {
      enforceSlugPrefixFence(req.name, args, boundPrefixes);
    }
    switch (req.name) {
      case "search":
        return await callSearch(
          storage,
          args,
          redact,
          readSources,
          isOperator,
          opts.embedQuery,
        );
      case "index":
        return await callIndex(storage, args, writeSource, isOperator);
      case "backlinks":
        return await callBacklinks(storage, args, redact, readSources, remote);
      case "stats":
        return await callStats(storage);
      case "source_health":
        return await callSourceHealth(storage, readSources);
      case "log_friction":
        return await callLogFriction(storage, args);
      case "page_put":
        return await withWriteRequest(storage, req.name, args, writeRequestPrincipal(opts, writeSource), (receipt) =>
          callPagePut(
            storage,
            args,
            writeSource,
            opts.isPublic ?? false,
            remoteWriterIdentity(opts),
            receipt,
          ),
        );
      case "page_append":
        return await withWriteRequest(storage, req.name, args, writeRequestPrincipal(opts, writeSource), (receipt) =>
          callPageAppend(
            storage,
            args,
            writeSource,
            opts.isPublic ?? false,
            remoteWriterIdentity(opts),
            receipt,
          ),
        );
      case "page_delete":
        return await callPageDelete(storage, args, writeSource);
      case "page_restore":
        return await callPageRestore(storage, args, writeSource, opts.isPublic ?? false);
      case "page_revert":
        return await callPageRevert(storage, args, writeSource, opts.isPublic ?? false);
      case "page_get":
        return await callPageGet(storage, args, redact, readSources, remote);
      case "page_list":
        return await callPageList(storage, args, redact, readSources, remote);
      case "page_versions":
        return await callPageVersions(storage, args, redact, readSources, remote);
      case "link":
        return await callLink(storage, args, writeSource);
      case "unlink":
        return await callUnlink(storage, args, writeSource);
      case "graph_neighbors":
        return await callGraphNeighbors(storage, args, redactGraph, readSources, remote);
      case "graph_query":
        return await callGraphQuery(storage, args, redactGraph, readSources, remote);
      case "traverse_graph":
        return await callTraverseGraph(storage, args, readSources, remote);
      case "get_chunks":
        return await callGetChunks(storage, args, readSources, remote);
      case "resolve_slugs":
        return await callResolveSlugs(storage, args, readSources, remote);
      case "add_tag":
        return await callAddTag(storage, args, writeSource);
      case "remove_tag":
        return await callRemoveTag(storage, args, writeSource);
      case "get_tags":
        return await callGetTags(storage, args, readSources);
      case "relational_recall":
        return await callRelationalRecall(
          storage,
          args,
          readSources,
          opts.authInfo,
          remote,
        );
      case "add_fact":
        return await withWriteRequest(storage, req.name, args, writeRequestPrincipal(opts, writeSource), () =>
          callAddFact(
            storage,
            args,
            writeSource,
            opts.isPublic ?? false,
            writerIdentity(opts),
            opts.authInfo?.boundSlugPrefixes,
            remote,
          ),
        );
      case "add_timeline_event":
        return await withWriteRequest(storage, req.name, args, writeRequestPrincipal(opts, writeSource), () =>
          callAddTimelineEvent(storage, args, writeSource),
        );
      case "entity_facts":
        return await callEntityFacts(storage, args, redact, readSources, remote);
      case "entity_timeline":
        return await callEntityTimeline(storage, args, redact, readSources);
      case "entity_recall":
        return await callEntityRecall(storage, args, redact, readSources, remote);
      case "jobs_submit":
        return await callJobsSubmit(storage, args);
      case "jobs_list":
        return await callJobsList(storage, args, redact);
      case "jobs_get":
        return await callJobsGet(storage, args, redact);
      case "jobs_cancel":
        return await callJobsCancel(storage, args);
      case "jobs_logs":
        return await callJobsLogs(storage, args, redact);
      case "submit_agent": {
        // Loaded on use: the agent modules import dispatchTool themselves, so a
        // static import here would close a module cycle.
        const { submitTenantAgent } = await import("../core/agent/submit.ts");
        return jsonResult(await submitTenantAgent(storage, opts.authInfo, args));
      }
      case "get_agent_job": {
        const { getAgentJobForOwner } = await import("../core/agent/submit.ts");
        return jsonResult(await getAgentJobForOwner(storage, opts.authInfo, args["job_id"]));
      }
      case "get_links":
        return await callGetLinks(storage, args, readSources, remote);
      case "list_link_sources":
        return await callListLinkSources(storage, readSources);
      case "find_orphans":
        return await callFindOrphans(storage, args, readSources, remote);
      case "find_experts":
        return await callFindExperts(storage, args, readSources, remote);
      case "find_contradictions":
        return await callFindContradictions(storage, args, readSources, remote);
      case "find_trajectory":
        return await callFindTrajectory(storage, args, readSources);
      case "get_recent_salience":
        return await callGetRecentSalience(storage, args, readSources, remote);
      case "find_anomalies":
        return await callFindAnomalies(storage, args, readSources, remote);
      case "recall":
        return await callRecall(storage, args, readSources, remote);
      case "forget_fact":
        return await callForgetFact(storage, args, writeSource, remote);
      case "get_brain_identity":
        return await callGetBrainIdentity(storage, readSources);
      case "whoami":
        return callWhoami(opts.authInfo, readSources, opts.isPublic ?? false);
      case "purge_deleted_pages":
        return await callPurgeDeletedPages(storage, args, writeSource);
      case "query":
        return await callQuery(storage, args, readSources, isOperator, opts.embedQuery);
      case "code_callers":
        return await callCodeCallers(storage, args, readSources);
      case "code_callees":
        return await callCodeCallees(storage, args, readSources);
      case "code_def":
        return await callCodeDefs(storage, args, readSources);
      case "code_refs":
        return await callCodeRefs(storage, args, readSources);
      case "code_blast":
        return await callCodeWalk(storage, args, readSources, "callers");
      case "code_flow":
        return await callCodeWalk(storage, args, readSources, "callees");
      case "volunteer_context":
        return await callVolunteerContext(storage, args, readSources, remote);
      case "context_pack":
        return await callContextPack(storage, args, redact, readSources, remote);
      case "advisor":
        return await callAdvisor(storage, readSources);
      case "list_brain_skillpack":
        return await callListBrainSkillpack();
      case "list_concepts":
        return await callListConcepts(storage, args, readSources);
      case "list_takes":
        return await callListTakes(storage, args, readSources, takesHolders);
      case "set_take_status":
        return await callSetTakeStatus(storage, args, writeSource);
      case "takes_search":
        return await callSearchTakes(storage, args, readSources, takesHolders);
      case "get_calibration_profile":
        return await callGetCalibrationProfile(storage, readSources);
      case "takes_scorecard":
        return await callTakesScorecard(storage, args, readSources, takesHolders);
      case "takes_calibration":
        return await callTakesCalibration(storage, args, readSources, takesHolders);
      case "extract_facts": {
        const canPersist =
          !writeDenied &&
          (opts.authInfo === undefined ||
            hasScope(opts.authInfo.scopes ?? [], "write"));
        return await withClientSpend(storage, opts.authInfo, "extract_facts", () =>
          callExtractFacts(storage, args, readSources, {
            ...(writeSource ? { writeSource } : {}),
            canPersist: canPersist && !(opts.isPublic ?? false),
          }),
        );
      }
      case "think":
        return await withClientSpend(storage, opts.authInfo, "think", () =>
          callThink(storage, args, {
            isOperator,
            ...(opts.embedQuery ? { embedQuery: opts.embedQuery } : {}),
            ...(readSources ? { readSources } : {}),
            ...(writeSource ? { writeSource } : {}),
          }),
        );
      case "fact_supersessions":
        return await callFactSupersessions(storage, args, redact, readSources);
      case "put_raw_data":
        return await callPutRawData(storage, args, writeSource);
      case "get_raw_data":
        return await callGetRawData(storage, args, readSources, remote);
      case "log_ingest":
        return await callLogIngest(storage, args, writeSource);
      case "get_ingest_log":
        return await callGetIngestLog(storage, args, readSources);
      case "retry_job":
        return await callRetryJob(storage, args);
      case "get_job_progress":
        return await callGetJobProgress(storage, args);
      case "sources_list":
        return await callSourcesList(storage, args, readSources);
      case "sources_status":
        return await callSourcesStatus(storage, args, readSources);
      case "get_status_snapshot":
        return await callStatusSnapshot(storage);
      case "run_doctor":
        return await callRunDoctor(storage);
      case "list_skills":
        return callListSkills();
      case "get_skill":
        return callGetSkill(args);
      case "get_recent_transcripts":
        return await callGetRecentTranscripts(storage, args, redact, readSources, remote);
      case "chronicle_day":
        return await callChronicleDay(storage, args, readSources, remote);
      case "chronicle_since":
        return await callChronicleSince(storage, args, readSources, remote);
      case "chronicle_on_this_day":
        return await callChronicleOnThisDay(storage, args, readSources, remote);
      case "chronicle_last_seen":
        return await callChronicleLastSeen(storage, args, readSources, remote);
      case "ontology_get":
        return await callOntologyGet(storage, args, readSources, remote);
      case "ontology_propose":
        return await callOntologyPropose(storage, args, writeSource);
      case "ontology_dimensions":
        return await callOntologyDimensions(storage, readSources, remote);
      case "ontology_conflicts":
        return await callOntologyConflicts(storage, args, readSources, remote);
      case "volunteer_chronicle":
        return await callVolunteerChronicle(storage, args, readSources, remote);
      case "chronicle_backfill":
        return await callChronicleBackfill(storage, args, readSources);
      default:
        throw new OperationError(
          "not_found",
          `unknown tool: ${req.name}`,
          "Call tools/list for the available tools.",
        );
    }
  } catch (e) {
    // A KNOWN, validated failure carries a structured envelope: the agent gets
    // a machine code + recovery hint instead of a bare string. On public
    // ingress `toEnvelope` withholds the free-text `message` (see
    // operation-error.ts), so only the constrained code + static suggestion/
    // docs cross the boundary.
    if (e instanceof PageNotFoundError) {
      const withHint = await withSlugSuggestions(storage, e, {
        isPublic: opts.isPublic ?? false,
        readSources,
        writeSource,
        remote,
      });
      return errResult(JSON.stringify(withHint.toEnvelope(opts.isPublic ?? false)));
    }
    if (isOperationError(e)) {
      return errResult(JSON.stringify(e.toEnvelope(opts.isPublic ?? false)));
    }
    // A raw exception (Postgres schema, DSN host, stack internals) must NOT
    // leak across the public boundary; fully redact it there, log server-side.
    return errResult(publicSafeErrorMessage(e, opts.isPublic ?? false));
  }
}

/**
 * Name the pages a missed slug most likely meant, drawn only from what this
 * caller can read. Any public-ingress caller gets none, OAuth tenants included:
 * `suggestion` survives public redaction, so a dynamic slug list must never be
 * rendered with isPublic=true. A remote caller never sees a diary slug. The lookup is a hint on an
 * error path, so its own failure leaves the plain not_found.
 */
async function withSlugSuggestions(
  storage: Storage,
  e: PageNotFoundError,
  ctx: { isPublic: boolean; readSources: string[] | undefined; writeSource: string | undefined; remote: boolean },
): Promise<PageNotFoundError> {
  if (ctx.isPublic) return e;
  let slugs: string[];
  try {
    slugs = await suggestSlugs(storage, e.slug, {
      sourceIds: ctx.readSources,
      writeSource: ctx.writeSource,
      ...(ctx.remote ? { exclude: (slug: string, type: string | null) => isDiaryPage(type ?? undefined, slug) } : {}),
    });
  } catch (err) {
    console.error("[page-not-found] slug suggestions failed:", err instanceof Error ? err.message : err);
    return e;
  }
  if (slugs.length === 0) return e;
  const hint = `Did you mean ${slugs.map((s) => `\`${s}\``).join(", ")}?`;
  return new PageNotFoundError(e.slug, e.suggestion ? `${hint} ${e.suggestion}` : hint);
}

/**
 * Who a `request_id` belongs to: the grant, not the transport. An OAuth or PAT
 * caller is its client (and enrollment, on a shared connector) plus its write
 * source; the static public bearer is `public`; the trusted local path is
 * `operator`. Two callers never share a key space, so one cannot replay — or
 * probe — another's results.
 */
export function writeRequestPrincipal(opts: DispatchOptions, writeSource: string | undefined): string {
  const auth = opts.authInfo;
  const parts = [
    auth !== undefined ? `client:${auth.clientId}` : opts.isPublic ? "public" : "operator",
  ];
  if (auth?.spendId !== undefined && auth.spendId !== auth.clientId) parts.push(`enrollment:${auth.spendId}`);
  if (writeSource !== undefined) parts.push(`source:${writeSource}`);
  return parts.join("|");
}

/**
 * Run a write under its optional `request_id`: a retry of a completed call
 * replays the stored result with `replayed: true` and writes nothing.
 *
 * `run` gets the claimed key. A page write passes it down so its receipt
 * commits in the same transaction as the page; from then on the key reads as
 * done even if the derived work after the commit fails or the process dies,
 * and a retry replays that receipt instead of writing again. A failure before
 * the commit leaves no receipt, and only then is the claim released for a
 * retry to run the write. add_fact and add_timeline_event are one statement
 * with no work after it, and a re-run of either collapses onto the row already
 * on file, so for them the receipt stored after the call is enough.
 */
async function withWriteRequest(
  storage: Storage,
  tool: string,
  args: Record<string, unknown>,
  principal: string,
  run: (receipt: WriteRequestKey | undefined) => Promise<ToolCallResult>,
): Promise<ToolCallResult> {
  const requestId = args["request_id"];
  if (requestId === undefined) return run(undefined);
  if (typeof requestId !== "string" || requestId.trim().length === 0 || requestId.length > MAX_REQUEST_ID_LEN) {
    throw new OperationError(
      "invalid_params",
      `${tool}: \`request_id\` must be a non-blank string of at most ${MAX_REQUEST_ID_LEN} characters`,
      "Pass a short caller-generated id such as a UUID.",
    );
  }
  const engine = storage.engine();
  const claim = await claimWriteRequest(engine, { principal, tool, requestId }, writeRequestArgsHash(args));
  if (claim.kind === "replay") return jsonResult({ ...claim.result, replayed: true });
  const key: WriteRequestKey = { principal, tool, requestId, claimedAt: claim.claimedAt };
  let result: ToolCallResult;
  try {
    result = await run(key);
  } catch (e) {
    await releaseWriteRequest(engine, key);
    throw e;
  }
  const text = result.content[0]?.type === "text" ? result.content[0].text : undefined;
  if (result.isError || text === undefined) {
    await releaseWriteRequest(engine, key);
    return result;
  }
  try {
    await completeWriteRequest(engine, key, JSON.parse(text) as Record<string, unknown>);
  } catch (e) {
    // A page write keeps the receipt its transaction stamped, which still
    // blocks a second write; only the fuller response is lost.
    console.error(`[write-request] could not store the result of ${tool} ${requestId}:`, e instanceof Error ? e.message : e);
  }
  return result;
}

/**
 * The optimistic-concurrency pair every conditional write takes. `force: true`
 * states an unconditional overwrite, so it cannot also name a version.
 */
function writePrecondition(tool: string, args: Record<string, unknown>): { expectedVersion?: number } {
  const expected = args["expected_version"];
  if (expected !== undefined && args["force"] === true) {
    throw new OperationError(
      "invalid_params",
      `${tool}: \`expected_version\` and \`force: true\` cannot be combined`,
      "Pass the version you read for a conditional write, or force: true for an intentional overwrite.",
    );
  }
  return typeof expected === "number" ? { expectedVersion: expected } : {};
}

function errResult(msg: string): ToolCallResult {
  return {
    content: [{ type: "text", text: msg }],
    isError: true,
  };
}

function jsonResult(payload: unknown): ToolCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

async function callSearch(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
  readSources?: string[],
  isOperator = false,
  embedQuery?: SearchOptions["embedQuery"],
): Promise<ToolCallResult> {
  const q = args["q"];
  if (typeof q !== "string" || q.length === 0) {
    throw new OperationError(
      "invalid_params",
      "search: `q` is required",
      "Pass a non-empty `q` string.",
    );
  }
  const kArg = args["k"];
  // Default 20 — the hybrid-search return width a client that passes no `k`
  // gets, untrimmed: adaptive return only runs on `adaptive_return: true`, and
  // the score-cliff autocut was rejected (see return-policy.ts).
  let k = 20;
  if (kArg !== undefined) {
    if (!Number.isInteger(kArg) || (kArg as number) < 1 || (kArg as number) > 100) {
      throw new OperationError(
        "invalid_params",
        "search: `k` must be an integer in [1, 100]",
        "Pass `k` as an integer between 1 and 100.",
      );
    }
    k = kArg as number;
  }
  const tbArg = args["token_budget"];
  let tokenBudget: number | undefined;
  if (tbArg !== undefined) {
    if (
      !Number.isInteger(tbArg) ||
      (tbArg as number) < 1 ||
      (tbArg as number) > 200000
    ) {
      throw new OperationError(
        "invalid_params",
        "search: `token_budget` must be an integer in [1, 200000]",
        "Pass `token_budget` as an integer between 1 and 200000.",
      );
    }
    tokenBudget = tbArg as number;
  }
  const onCapture = makeCaptureCallback(storage.engine(), storage.config(), {
    toolName: "mcp.search",
    remote: true,
  });
  // Pagination: fetch offset extra hits in one ranked pass, slice below.
  const offset =
    typeof args["offset"] === "number"
      ? Math.max(0, Math.floor(args["offset"] as number))
      : 0;
  const searchOpts: SearchOptions = { k: k + offset };
  // Per-call mode bundle — OPERATOR ONLY (a tenant token cannot escalate to
  // the paid tokenmax bundle; its mode is silently ignored). Mapped onto
  // per-call knobs, which win over env + active bundle.
  applyPerCallMode(searchOpts, args["mode"], isOperator);
  if (onCapture) searchOpts.onCapture = onCapture;
  if (tokenBudget !== undefined) searchOpts.tokenBudget = tokenBudget;
  if (readSources !== undefined) searchOpts.sourceIds = readSources;
  // Optional per-call filters — strings validated by the op contract.
  if (typeof args["lang"] === "string" && args["lang"]) searchOpts.lang = args["lang"];
  if (typeof args["symbol_kind"] === "string" && args["symbol_kind"]) {
    searchOpts.symbolKind = args["symbol_kind"];
  }
  const dateBound = (name: "since" | "until"): string | undefined => {
    const v = args[name];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") {
      throw new OperationError(
        "invalid_params",
        `search: \`${name}\` must be a string`,
        `Pass \`${name}\` as an ISO date, datetime, or relative duration (7d / 2w / 1y).`,
      );
    }
    // Normalize here so the documented relative forms (7d / 2w / 1y) and
    // whole-day plain dates work over MCP; garbage throws OperationError
    // inside the resolver instead of silently dropping the bound.
    return resolveDateBoundary(v, name);
  };
  const since = dateBound("since");
  const until = dateBound("until");
  if (since) searchOpts.since = since;
  if (until) searchOpts.until = until;
  // Structural two-pass expansion (code graph) — strings/ints validated by the
  // op contract; walk_depth clamped to the engine cap defensively.
  if (typeof args["near_symbol"] === "string" && args["near_symbol"]) {
    searchOpts.nearSymbol = args["near_symbol"];
  }
  if (typeof args["walk_depth"] === "number") {
    searchOpts.walkDepth = Math.min(Math.max(args["walk_depth"], 0), 2);
  }
  // Per-signal ranking attribution (search --explain). Validated as a
  // boolean by the op contract; only an explicit true opts in.
  if (args["explain"] === true) searchOpts.explain = true;
  if (embedQuery) searchOpts.embedQuery = embedQuery;
  let meta: SearchMeta | undefined;
  searchOpts.onMeta = (m) => {
    meta = m;
  };
  const hitsAll = await hybridSearch(storage, q, searchOpts);
  const hitsOffset = offset > 0 ? hitsAll.slice(offset) : hitsAll;
  // Diary fence: a non-operator caller (public bearer OR OAuth tenant, even one
  // scoped into the diary's own source) must never receive life/diary/* page
  // chunks. Public also drops ALL page:// hits just below; this additionally
  // covers the OAuth tenant, whose page hits are otherwise returned verbatim.
  const hits = fenceDiaryHits(hitsOffset, isOperator);
  // Public ingress: drop page-derived mirror hits entirely. A page slug
  // (`page://people/<name>`) and title are author-written identifiers — the
  // exact PII the redaction layer suppresses — and search is a free-text
  // enumeration surface. page_put is internal-only; its content stays
  // internal-only in search too. Internal callers (no redaction) still get
  // page hits. Flip this if public page discovery is ever wanted.
  const visible = redact
    ? (hits as unknown as Record<string, unknown>[]).filter(
        (h) =>
          !(
            typeof h["sourcePath"] === "string" &&
            isPageSourcePath(h["sourcePath"])
          ),
      )
    : hits;
  const out = redact
    ? redactBodies(visible as unknown as Record<string, unknown>[])
    : visible;
  // Non-operators see corpus-independent reason codes only, keyed on the caller
  // rather than on body redaction: counts are an existence oracle even when
  // bodies are opted in.
  const metaOut = responseSearchMeta(meta, out.length, isOperator);
  const metaField = metaOut ? { meta: metaOut } : {};
  // A set-shaped question ("all the companies that…", "what are the different
  // approaches to…") is exactly the shape `search` answers badly when query
  // expansion is off: it returns a plausible non-empty list the caller has no
  // way to tell is partial. Say so, rather than letting the count imply
  // completeness. Advisory only — the hits are unchanged.
  //
  // Read expansion off the RESOLVED options, not the process default: a
  // per-call `mode` (operator-only) sets searchOpts.expansion, so checking the
  // ambient config alone would fire on a caller who already asked for
  // expansion and stay silent for one who turned it off.
  const expansionOn = searchOpts.expansion ?? expansionActive();
  if (looksConceptShaped(q) && !expansionOn) {
    // `query` is internal-only (public_guard forbids it), and even where it is
    // reachable it follows the same expansion chain — so the remedy has to name
    // the parameter, not just the tool. On the public path there is no second
    // tool to point at; the warning still stands on its own.
    const hint = redact
      ? {
          why:
            "This reads as a set-shaped question and query expansion is off — " +
            "these hits may be a partial view rather than the whole set.",
        }
      : {
          use: "query",
          with: { expand: true },
          why:
            "This reads as a set-shaped question and query expansion is off — " +
            "these hits may be a partial view. `query` with `expand: true` " +
            "expands the question first; `query` alone inherits the same " +
            "expansion setting and would not change the outcome.",
        };
    return jsonResult({ ok: true, hits: out, hint, ...metaField });
  }
  return jsonResult({ ok: true, hits: out, ...metaField });
}

/**
 * The `meta` block a search-backed tool returns. The operator gets the full
 * meta with `returned` re-counted after the offset slice. Everyone else (public
 * ingress and OAuth tenants alike) gets the redacted form: `retrieved`,
 * keyword_zero and budget_truncated are measured before hydrate re-scopes the
 * pool and before the diary/page fences, so they would confirm fenced matches.
 */
function responseSearchMeta(
  meta: SearchMeta | undefined,
  returned: number,
  isOperator: boolean,
): SearchMeta | ReturnType<typeof publicSearchMeta> | undefined {
  if (!meta) return undefined;
  return isOperator ? { ...meta, returned } : publicSearchMeta(meta);
}

const URI_SCHEME = /^[a-z][a-z0-9+.-]+:\/\//i;

/**
 * A remote label names a path the daemon's sweeps and cycle may later judge
 * by prefix; `..`, `./` and `//` let the same label read as one source's path
 * and resolve into another's. `page://…` style labels keep their `//`.
 */
function isNormalizedLabel(sourcePath: string): boolean {
  const scheme = URI_SCHEME.exec(sourcePath)?.[0] ?? "";
  const rest = sourcePath.slice(scheme.length);
  if (rest.split("/").some((seg) => seg === ".." || seg === ".")) return false;
  return posix.normalize(rest) === rest || rest === "";
}

/**
 * Why a non-operator's inline label may not be written, or null. A label under
 * a vault/code root names a file the daemon's own re-reads refresh, and one
 * under another source's prefix lands in that source's namespace.
 */
async function inlineLabelSquat(
  engine: Engine,
  sourcePath: string,
  writeSource: string | undefined,
): Promise<string | null> {
  for (const root of loadAllowedRootSpellings()) {
    const base = root.endsWith("/") ? root.slice(0, -1) : root;
    if (sourcePath === base || sourcePath.startsWith(`${base}/`)) {
      return "lies under a configured vault/code root";
    }
  }
  const owner = await resolveSourceForPath(engine, sourcePath);
  if (owner !== null && owner !== writeSource) {
    return `lies under source ${owner}'s path prefix`;
  }
  return null;
}

async function callIndex(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
  isOperator = false,
): Promise<ToolCallResult> {
  const path = args["path"];
  if (typeof path === "string" && path.length > 0) {
    // The `path` form reads a file off the daemon's filesystem. Even though
    // isWithinAllowedRoot caps it to the vault/code roots, only the operator
    // may trigger a server-side file read — public and OAuth tenant callers
    // index inline (`sourcePath` + `text`) only. indexFile carries no write
    // source, so a tenant reaching it would mint an unowned document.
    if (!isOperator) {
      return errResult(
        "index: the `path` form is internal-only; pass `sourcePath` + `text` " +
          "to index inline content",
      );
    }
    let allowed: boolean;
    try {
      allowed = isWithinAllowedRoot(path);
    } catch (e) {
      if (e instanceof PathGuardConfigError) return errResult(e.message);
      throw e;
    }
    if (!allowed) {
      return errResult(
        "index: path is outside the configured MEMRAIN_VAULT_PATHS / " +
          "MEMRAIN_CODE_PATHS roots — refusing to index",
      );
    }
    // indexFile refuses a row a tenant's inline `index` labelled with this path
    // first, the same check every local read of a file makes.
    const r = await indexFile(storage, path);
    return jsonResult({ ok: true, ...r });
  }
  const sourcePath = args["sourcePath"];
  const text = args["text"];
  if (typeof sourcePath === "string" && typeof text === "string") {
    if (!isOperator && !isNormalizedLabel(sourcePath)) {
      return errResult(
        "index: `sourcePath` must be a normalized path — no `.` or `..` " +
          "segments and no repeated `/`",
      );
    }
    if (!isOperator) {
      const squat = await inlineLabelSquat(storage.engine(), sourcePath, writeSource);
      if (squat) return errResult(`index: \`sourcePath\` ${squat}; choose a label in your own namespace`);
    }
    // The `path` form above goes through indexFile, which canonicalizes to an
    // absolute source_path. This form deliberately does NOT: the caller's
    // `sourcePath` is a label in THEIR namespace (a laptop's /vault path, a
    // `page://` slug), and resolving a relative one against the daemon's cwd
    // would mint a local path that no file ever occupied.
    //
    // Trust boundary: the inline `sourcePath`+`text` form is the remote-reachable
    // ingest. Fail-closed — any caller but the operator is untrusted, token
    // holders without a write source included, so gate-owned frontmatter
    // markers get stripped.
    const remote = !isOperator;
    const r = await indexDocument(
      storage,
      { sourcePath, text, ...(writeSource ? { sourceId: writeSource } : {}) },
      { remote },
    );
    return jsonResult({ ok: true, ...r });
  }
  return errResult("index: pass either `path` or both `sourcePath` and `text`");
}

async function callBacklinks(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  const name = args["name"];
  if (typeof name !== "string" || name.length === 0) {
    return errResult("backlinks: `name` is required");
  }
  // The name feeds a trigram scan over every live page in scope.
  if (name.length > 256) {
    return errResult("backlinks: `name` must be at most 256 characters");
  }
  const opts: Parameters<typeof findBacklinks>[2] = {};
  const type = args["type"];
  if (type !== undefined) {
    if (typeof type !== "string" || !VALID_ENTITY_TYPES.has(type as EntityType)) {
      return errResult(`backlinks: invalid type ${String(type)}`);
    }
    opts.type = type as EntityType;
  }
  const limit = args["limit"];
  if (limit !== undefined) {
    if (
      !Number.isInteger(limit) ||
      (limit as number) < 1 ||
      (limit as number) > 1000
    ) {
      return errResult("backlinks: `limit` must be in [1, 1000]");
    }
    opts.limit = limit as number;
  }
  if (readSources !== undefined) opts.sourceIds = readSources;
  if (remote) opts.excludeTarget = isDiarySlug;
  let hits = await findBacklinks(storage, name, opts);
  // Diary fence: drop backlinks originating from a diary page (its mirror
  // source_path carries the life/diary/* slug) for a non-operator caller.
  // Edges into a diary target are dropped by `excludeTarget` above; this
  // drops edges out of a diary page.
  if (remote) hits = hits.filter((h) => !isDiarySourcePath(h.sourcePath));
  // Public ingress: `surfaceForm` is note-authored free text — strip it,
  // mirroring the search/page/fact body redaction policy.
  const out = redact
    ? redactBacklinks(hits as unknown as Record<string, unknown>[])
    : hits;
  return jsonResult({ ok: true, name, hits: out });
}

async function callStats(storage: Storage): Promise<ToolCallResult> {
  const stats = await storage.stats();
  const pageTypes = await pageTypeDistribution(storage.engine());
  return jsonResult({ ok: true, ...stats, page_types: pageTypes });
}

/**
 * How the corpus is typed, and which types nobody declared.
 *
 * `page_put` permits an ad-hoc type, and the brain's own writers use four that
 * are not in KNOWN_PAGE_TYPES. Nothing counted the result, so a typo (`peson`,
 * `Person`) or a writer quietly drifting to a new label stayed invisible until
 * somebody noticed a page missing from a type-filtered read. Counting is the
 * whole fix — this reports, it never rejects.
 */
async function pageTypeDistribution(engine: Engine): Promise<{
  by_type: { type: string; count: number }[];
  unknown_types: string[];
  unknown_pages: number;
}> {
  const r = await engine.query<{ type: string | null; n: string }>(
    `SELECT type, count(*)::text AS n
       FROM pages
      WHERE deleted_at IS NULL
      GROUP BY type
      ORDER BY count(*) DESC, type ASC`,
  );
  const known = new Set<string>(KNOWN_PAGE_TYPES);
  const byType = r.rows.map((row) => ({
    type: row.type ?? "(untyped)",
    count: Number(row.n),
  }));
  const unknown = byType.filter((t) => !known.has(t.type));
  return {
    by_type: byType,
    unknown_types: unknown.map((t) => t.type),
    unknown_pages: unknown.reduce((sum, t) => sum + t.count, 0),
  };
}

/**
 * Per-source health breakdown. `readSources` scopes the rows: a scoped tenant
 * sees only its granted sources (and never the NULL '(unclassified)' bucket);
 * an unscoped local/internal caller (readSources undefined) sees every source
 * plus the whole-brain `health` roll-up. The brain-level metric is only
 * exposed to unscoped callers so a tenant can't read cross-tenant totals.
 */
async function callSourceHealth(
  storage: Storage,
  readSources?: string[],
): Promise<ToolCallResult> {
  const engine = storage.engine();
  const perSource = await collectPerSourceHealth(engine, readSources);
  const payload: Record<string, unknown> = { ok: true, perSource };
  if (readSources === undefined) {
    payload.health = await brainHealthMetrics(engine);
  }
  return jsonResult(payload);
}

const VALID_FRICTION = VALID_FRICTION_KINDS;

const VALID_SEVERITY: ReadonlySet<string> = new Set([
  "confused",
  "error",
  "blocker",
  "nit",
]);

async function callLogFriction(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const kind = args["kind"];
  if (typeof kind !== "string" || !VALID_FRICTION.has(kind as FrictionKind)) {
    return errResult(
      `log_friction: kind must be one of ${[...VALID_FRICTION].join("|")}`,
    );
  }
  const input: Parameters<typeof logFriction>[1] = {
    kind: kind as FrictionKind,
  };
  if (typeof args["query"] === "string") input.query = args["query"];
  if (typeof args["reason"] === "string") input.reason = args["reason"];
  if (typeof args["sourcePath"] === "string") input.sourcePath = args["sourcePath"];
  if (typeof args["severity"] === "string") {
    if (!VALID_SEVERITY.has(args["severity"])) {
      return errResult(
        `log_friction: severity must be one of ${[...VALID_SEVERITY].join("|")}`,
      );
    }
    input.severity = args["severity"] as
      | "confused"
      | "error"
      | "blocker"
      | "nit";
  }
  if (
    args["extra"] !== undefined &&
    typeof args["extra"] === "object" &&
    args["extra"] !== null
  ) {
    input.extra = args["extra"] as Record<string, unknown>;
  }
  await logFriction(storage.engine(), input);
  return jsonResult({ ok: true });
}

// ---------------------------------------------------------------------------
// Page tools — DB-canonical page store. page_put / page_append are
// PUBLIC_WRITE_TOOLS: the public bearer CAN reach them when
// MEMRAIN_PUBLIC_WRITE=1, so their content is untrusted — `isPublic` is threaded
// into the search mirror to strip gate-owned frontmatter markers (see
// indexer.ts trust boundary). page_delete / page_restore / page_revert are in
// FORBIDDEN_MCP_TOOLS_FROM_PUBLIC and never reachable from the public bearer.
// MCP dispatch trusts the transport layer to have already enforced those gates.
// ---------------------------------------------------------------------------

/**
 * Provenance a REMOTE caller may not claim.
 *
 * `page_versions.written_by` is what the orphan policy reads to tell a page the
 * brain wrote for itself from one a person wrote. A remote caller that stamps
 * `extract-atoms` on its own page would drop that page out of the operator's
 * orphan report — the same laundering `add_fact` already refuses. Internal
 * callers (the synthesis phases) are unaffected: they do not come through here.
 */
function sanitizeWrittenBy(
  value: unknown,
  remoteIdentity: string | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (v.length === 0) return undefined;
  if (remoteIdentity === undefined) return v;
  return isExcludedOrphanWriter(v) ? remoteIdentity : v;
}

function asPageInput(
  args: Record<string, unknown>,
  remoteIdentity?: string,
): PageInput | string {
  if (typeof args["slug"] !== "string") return "page_put: `slug` is required";
  // `type` is OPTIONAL: when omitted, putPage infers it from the slug's first
  // segment (people/… → person), defaulting to `note`.
  const input: PageInput = { slug: args["slug"] };
  if (typeof args["type"] === "string") input.type = args["type"];
  if (typeof args["title"] === "string") input.title = args["title"];
  if (
    typeof args["compiled_truth"] === "object" &&
    args["compiled_truth"] !== null
  ) {
    input.compiled_truth = args["compiled_truth"] as Record<string, unknown>;
  }
  if (typeof args["markdown_body"] === "string") {
    input.markdown_body = args["markdown_body"];
  }
  const writtenBy = sanitizeWrittenBy(args["written_by"], remoteIdentity);
  if (writtenBy !== undefined) input.written_by = writtenBy;
  if (args["allow_empty_body"] === true) {
    input.allowEmptyBody = true;
  }
  if (typeof args["allowAdHocType"] === "boolean") {
    input.allowAdHocType = args["allowAdHocType"];
  }
  return input;
}

async function callPagePut(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
  isPublic = false,
  remoteIdentity?: string,
  receipt?: WriteRequestKey,
): Promise<ToolCallResult> {
  const input = asPageInput(args, remoteIdentity);
  if (typeof input === "string") return errResult(input);
  if (writeSource) input.source_id = writeSource;
  const { expectedVersion } = writePrecondition("page_put", args);
  if (expectedVersion !== undefined) input.expectedVersion = expectedVersion;
  if (receipt !== undefined) input.receipt = receipt;
  const r = await putPage(storage, input);
  let mirror: Awaited<ReturnType<typeof mirrorOrQueue>> = {};
  let chronicleBackstop = false;
  let bodyTimeline: BodyTimelineSyncResult | undefined;
  if (r.changed) {
    // Fetch the canonical row once: an omitted title lands as NULL while an
    // omitted body keeps the page's current one, so the stored row — not
    // `input` — is what actually became searchable.
    const page = await getPage(storage, r.slug);
    const body = page?.markdown_body ?? input.markdown_body ?? "";
    // Every derived write below carries the PAGE's source, not the caller's.
    // An unscoped operator write is allowed onto a named-source page
    // (pages.ts), and these reconcilers read an omitted source as "unscoped":
    // links.ts deletes the slug's edges across sources and reinserts them as
    // `default`, and facts-reconcile does the same to fenced facts. The page
    // would keep its owner while its edges, facts and watermark silently moved
    // to another tenant's view. A scoped caller can only reach a page it owns,
    // so for it the two are the same value.
    const derivedSource = page?.source_id ?? writeSource;
    await syncWikilinksForPage(storage, r.slug, body, derivedSource);
    // Gazetteer auto-link (opt-in, MEMRAIN_GAZETTEER=1) — derives `mentions`
    // edges from plain-text references to known entity pages.
    await syncMentionsForPage(storage, r.slug, body, derivedSource);
    // Typed-link inference (opt-in, MEMRAIN_TYPED_LINKS=1) — derive works_at /
    // founded / attended / … edges from frontmatter fields.
    if (typedLinksEnabled() && page) {
      await syncTypedLinksForPage(storage, r.slug, page.type, page.compiled_truth, derivedSource);
    }
    // Verb-context typed edges from prose (opt-in MEMRAIN_LINK_VERB_INFER) —
    // owns link_kind='verb_ner', never touches the edges above.
    if (linkVerbInferEnabled() && page) {
      await syncVerbLinksForPage(storage, r.slug, page.type, body, derivedSource);
    }
    // Dated body lines (`## Timeline` bullets, `### date` headers, citations)
    // become this page's own timeline rows; a keyed diff, so an unchanged
    // section keeps its row ids.
    bodyTimeline = await syncBodyTimelineForPage(storage, r.slug, derivedSource);
    // Advance the link-extraction watermark now that the full edge set is
    // synced (migration 051) — stamped after updated_at, so the staleness
    // predicate reads clean until the next edit / extractor-version bump.
    await stampLinksExtracted(storage.engine(), r.slug, derivedSource);
    // Mirror the page body into the search store so a page written via
    // page_put is findable. Best-effort: the canonical page write already
    // committed and is the source of truth — an embed failure must not fail
    // the write. The cycle backstop reconciles unindexed pages later.
    if (page) {
      mirror = await mirrorOrQueue(storage, page, isPublic || writeSource !== undefined, "page_put", args["wait_for_index"] === true);
      // On-write fact extraction (default-OFF, best-effort). Only on a real
      // content change and only for prose-eligible pages.
      // NOT derivedSource: here `writeSource` only picks the serialization
      // key, and the job's provenance already comes from page.source_id
      // inside. (The chronicle helper below IS caller-trust-gated — it
      // refuses whenever a write source is present.)
      maybeEnqueueFactExtraction(storage, page, writeSource);
      // On-write chronicle backstop (default-OFF, operator-trusted only).
      chronicleBackstop = await maybeEnqueueChronicleExtract(
        storage,
        page,
        writeSource, // trust gate, same as above — not the page's provenance
        isPublic,
      );
    }
  }
  // Facts-fence reconcile on EVERY put (a no-op re-put is the repair path) —
  // it re-reads the current body and guards on content_hash itself. Same rule
  // as the derived writes above: the fence belongs to the page's owner, and an
  // unscoped operator must not re-home another source's facts to `default`.
  const factsSource =
    writeSource ?? (await getPage(storage, r.slug))?.source_id ?? undefined;
  await reconcileFactsForPage(storage, r.slug, r.content_hash, factsSource);
  // Takes-fence canon sync (mig 090): the page fence is the operator-authored
  // source of truth for takes — parse + upsert/supersede rows on every put.
  // Best-effort: a malformed fence must never fail the page write.
  try {
    const fenceBody = (await getPage(storage, r.slug))?.markdown_body ?? "";
    if (hasFenceMarker(fenceBody, "takes")) {
      await syncTakesFromFence(storage.engine(), r.slug, fenceBody);
    }
  } catch (e) {
    console.error("[memrain] takes-fence sync failed (non-fatal):", e);
  }
  return jsonResult({
    ok: true,
    ...r,
    ...mirror,
    ...(chronicleBackstop ? { chronicle_backstop: true } : {}),
    ...(bodyTimeline && (bodyTimeline.derived > 0 || bodyTimeline.removed > 0)
      ? { body_timeline: bodyTimeline }
      : {}),
  });
}

/**
 * Best-effort, default-OFF on-write fact extraction. When
 * MEMRAIN_FACTS_EXTRACTION is enabled AND the page is prose-eligible, enqueue a
 * bounded, fire-and-forget extraction job (paid Sonnet, budget-guarded inside
 * `extractFactsForPage`). NEVER blocks or fails the triggering write — the
 * queue absorbs errors, and a dropped/failed job is re-covered by the
 * conversation-facts backfill cycle phase. The write source scopes both the
 * per-session serialization key and the tenant the facts are written to.
 */
function maybeEnqueueFactExtraction(
  storage: Storage,
  page: { slug: string; type: string; markdown_body: string; source_id?: string },
  writeSource?: string,
): void {
  if (!factsExtractionEnabled()) return;
  // Diary interiority is never mined for facts — a hard privacy invariant that
  // sits above the generic prose gate (which admits type 'journal').
  if (isDiaryPage(page.type, page.slug)) return;
  const eligible = isFactsExtractionEligible(
    page.type,
    page.markdown_body,
    page.slug,
  );
  if (!eligible.ok) return;
  const sessionId = writeSource ?? page.source_id ?? "default";
  getFactsQueue().enqueue(
    () =>
      extractFactsForPage(storage, {
        slug: page.slug,
        type: page.type,
        body: page.markdown_body,
        ...(page.source_id ? { sourceId: page.source_id } : {}),
      }).then(() => undefined),
    sessionId,
  );
}

/** A diary/journal page. Its interiority is kept verbatim and never re-derived
 *  into facts OR chronicle events — a privacy invariant above the generic gates
 *  (facts admits type 'journal'; this refuses it). */
function isDiaryPage(type: string | undefined, slug: string): boolean {
  const t = (type ?? "").trim().toLowerCase();
  return t === "diary" || t === "journal" || slug.startsWith("life/diary/");
}

/** Drop life/diary/* page-mirror hits for a non-operator caller (the diary
 *  fence over the raw-chunk search surfaces). Operator keeps everything. */
function fenceDiaryHits<T>(hits: T[], isOperator: boolean): T[] {
  if (isOperator) return hits;
  return (hits as unknown as Record<string, unknown>[]).filter(
    (h) => !(typeof h["sourcePath"] === "string" && isDiarySourcePath(h["sourcePath"])),
  ) as unknown as T[];
}

/**
 * Direct page-body reads must not confirm a diary page even exists to a
 * non-operator caller. Resolve whether `slug` names diary content in the
 * caller's scope: a life/diary/* slug is diary without a fetch; otherwise a
 * scoped read decides on the page's type (diary/journal). Returns false when
 * the page is missing/out-of-scope (the read then no-ops on its own). Callers
 * translate `true` into the SAME not_found the miss path returns, so a diary
 * page is indistinguishable from an absent one.
 */
async function isRemoteDiaryFenced(
  storage: Storage,
  slug: string,
  readSources: string[] | undefined,
): Promise<boolean> {
  if (isDiaryPage(undefined, slug)) return true;
  const scopeIds = readSources;
  const pg = await getPage(storage, slug, scopeIds);
  return pg !== null && isDiaryPage(pg.type, pg.slug);
}

/**
 * Best-effort, default-OFF on-write chronicle backstop. When MEMRAIN_AUTO_CHRONICLE
 * is enabled AND the page is chronicle-eligible (conversation-shape, not diary/
 * event/dream), enqueue one durable `chronicle_extract` job so the timeline gets
 * projected. Operator-trusted writes ONLY: a public or tenant-scoped write must
 * never feed the operator's life chronicle (writeSource undefined + not public =
 * the unscoped local/internal operator). Failures are logged + swallowed — the
 * backstop can never break the triggering write. Returns whether it enqueued.
 */
/**
 * Dedup id for a chronicle-extract job. Includes an 8-char content-hash prefix
 * so the id is CONTENT-addressed: re-extracting the SAME body collapses onto the
 * prior job (idempotent), but an EDIT changes the hash → a fresh id → a new job.
 * Without the hash the id would collide with a long-finished succeeded/failed
 * row forever (Queue.enqueue is ON CONFLICT DO NOTHING), so edits would never
 * re-extract and a backfill would falsely report work enqueued.
 */
function chronicleJobId(sourceId: string, slug: string, contentHash: string | undefined): string {
  const h = (contentHash ?? "").slice(0, 8) || "nohash";
  return `chronicle_extract:${sourceId}:${slug}:${h}`;
}

async function maybeEnqueueChronicleExtract(
  storage: Storage,
  page: { slug: string; type: string; markdown_body: string; source_id?: string; content_hash?: string },
  writeSource: string | undefined,
  isPublic: boolean,
): Promise<boolean> {
  if (!chronicleEnabled()) return false;
  if (isPublic || writeSource !== undefined) return false;
  const eligible = isChronicleEligible({
    type: page.type,
    slug: page.slug,
    body: page.markdown_body,
  });
  if (!eligible.ok) return false;
  try {
    const sourceId = page.source_id ?? "default";
    await new Queue(storage.engine()).enqueue({
      kind: "chronicle_extract",
      payload: { slug: page.slug, sourceId },
      id: chronicleJobId(sourceId, page.slug, page.content_hash),
      timeoutMs: 600_000,
    });
    return true;
  } catch (e) {
    console.error(
      `[chronicle] backstop enqueue failed for ${page.slug} (non-fatal):`,
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}

/**
 * Best-effort mirror of a page into the search store. Returns whether the
 * mirror succeeded. Never throws — the DB-canonical page is the source of
 * truth; search is a derived projection the cycle can rebuild.
 */
/**
 * Whether the write path mirrors pages synchronously (the default) or hands the
 * mirror to a `page_mirror` job (`MEMRAIN_PAGE_MIRROR_SYNC=0`). Anything but an
 * explicit 0/false keeps the synchronous path — including the empty string a
 * compose passthrough injects when the knob is unset.
 */
function pageMirrorSync(): boolean {
  const raw = (process.env.MEMRAIN_PAGE_MIRROR_SYNC ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

/**
 * Mirror a written page into search, or queue the mirror. Returns the response
 * fields describing what happened: `search_indexed` (true = mirrored, false =
 * the mirror failed and was logged), or `search_pending` + `search_job_id` when
 * it was queued. A queue failure falls back to mirroring inline, so a write is
 * never left with no mirror on the way.
 */
async function mirrorOrQueue(
  storage: Storage,
  page: { slug: string; title: string | null; markdown_body: string; content_hash?: string; source_id?: string | null },
  remote: boolean,
  op: "page_put" | "page_append",
  waitForIndex: boolean,
): Promise<{ search_indexed?: boolean; search_pending?: true; search_job_id?: string }> {
  if (pageMirrorSync() || waitForIndex) {
    return { search_indexed: await mirrorPage(storage, page, { remote, timingLabel: op }) };
  }
  // One job per write: a content-addressed id would collapse a revert, an A->B->A
  // edit or a title-only change onto a long-finished row and enqueue nothing.
  // The handler mirrors the page as it is when it runs, so an older job landing
  // after a newer one is wasted work, never stale data.
  const id = `page_mirror:${page.source_id ?? "default"}:${page.slug}:${randomUUID()}`;
  try {
    await new Queue(storage.engine()).enqueue({
      kind: PAGE_MIRROR_JOB_KIND,
      payload: { slug: page.slug, remote, op, ...(page.content_hash ? { contentHash: page.content_hash } : {}) },
      id,
      priority: 1,
      timeoutMs: 300_000,
    });
    return { search_pending: true, search_job_id: id };
  } catch (e) {
    console.error(
      `[page-index] could not queue the mirror for ${page.slug}, mirroring inline:`,
      e instanceof Error ? e.message : e,
    );
    return { search_indexed: await mirrorPage(storage, page, { remote, timingLabel: op }) };
  }
}

async function callPageAppend(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
  isPublic = false,
  remoteIdentity?: string,
  receipt?: WriteRequestKey,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_append: `slug` is required");
  }
  if (typeof args["content"] !== "string" || args["content"].length === 0) {
    return errResult("page_append: `content` is required");
  }
  const r = await appendPage(storage, {
    slug: args["slug"],
    content: args["content"],
    ...(() => {
      const w = sanitizeWrittenBy(args["written_by"], remoteIdentity);
      return w !== undefined ? { written_by: w } : {};
    })(),
    ...(writeSource ? { source_id: writeSource } : {}),
    ...(receipt !== undefined ? { receipt } : {}),
  });
  let mirror: Awaited<ReturnType<typeof mirrorOrQueue>> = {};
  let chronicleBackstop = false;
  if (r.changed) {
    const fresh = await getPage(storage, r.slug);
    const body = fresh?.markdown_body ?? "";
    // Derived rows belong to the page's owner, not to an unscoped caller's
    // `default`. A scoped caller can only append to a page it owns, so its own
    // source is the owner and wins over a re-read that could race a rename.
    const derivedSource = writeSource ?? fresh?.source_id;
    await syncWikilinksForPage(storage, r.slug, body, derivedSource);
    await syncMentionsForPage(storage, r.slug, body, derivedSource);
    if (typedLinksEnabled() && fresh) {
      await syncTypedLinksForPage(storage, r.slug, fresh.type, fresh.compiled_truth, derivedSource);
    }
    if (linkVerbInferEnabled() && fresh) {
      await syncVerbLinksForPage(storage, r.slug, fresh.type, body, derivedSource);
    }
    await syncBodyTimelineForPage(storage, r.slug, derivedSource);
    await stampLinksExtracted(storage.engine(), r.slug, derivedSource); // watermark (mig 051)
    if (fresh) {
      mirror = await mirrorOrQueue(storage, fresh, isPublic || writeSource !== undefined, "page_append", args["wait_for_index"] === true);
      maybeEnqueueFactExtraction(storage, fresh, writeSource);
      chronicleBackstop = await maybeEnqueueChronicleExtract(
        storage,
        fresh,
        writeSource,
        isPublic,
      );
    }
  }
  const factsSource = writeSource ?? (await getPage(storage, r.slug))?.source_id;
  await reconcileFactsForPage(storage, r.slug, r.content_hash, factsSource);
  return jsonResult({
    ok: true,
    ...r,
    ...mirror,
    ...(chronicleBackstop ? { chronicle_backstop: true } : {}),
  });
}

async function callPageDelete(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_delete: `slug` is required");
  }
  const writtenBy =
    typeof args["written_by"] === "string" ? args["written_by"] : undefined;
  const r = await deletePage(storage, args["slug"], writtenBy, writeSource, writePrecondition("page_delete", args));
  // A soft-deleted page must stop serving its fence-derived facts; explicit
  // (NULL source_markdown_slug) facts are left intact.
  if (!r.already_deleted) {
    await purgeFenceFactsForPage(storage, args["slug"]);
    // Drop the page's search mirror so a deleted page stops appearing in
    // search hits. Best-effort — the soft-delete already succeeded. A tenant's
    // mirror lives under `page://<source>/<slug>`; removing only the legacy
    // `page://<slug>` left a deleted tenant page searchable until the cycle's
    // orphan sweep, so both are removed.
    try {
      const owner = await storage.engine().query<{ source_id: string | null }>(
        "SELECT source_id FROM pages WHERE slug = $1",
        [args["slug"]],
      );
      const sourceId = owner.rows[0]?.source_id ?? null;
      await removePageFromSearch(storage, args["slug"]);
      if (sourceId && sourceId !== "default") {
        await removePageFromSearch(storage, args["slug"], sourceId);
      }
    } catch (e) {
      console.error(
        `[page-index] failed to drop search mirror for ${args["slug"]}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return jsonResult({ ok: true, ...r });
}

async function callPageRestore(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
  isPublic = false,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_restore: `slug` is required");
  }
  const writtenBy =
    typeof args["written_by"] === "string" ? args["written_by"] : undefined;
  const r = await restorePage(storage, args["slug"], writtenBy, writeSource);
  if (r.restored) {
    // Re-derive ONLY what delete tore down: facts (purged on delete) and the
    // search mirror (dropped on delete). Links/mentions/typed-links are NOT
    // touched by a soft-delete, so they're already intact — no re-sync needed
    // (this is why restore is narrower than revert, which changes the body).
    const page = await getPage(storage, r.slug);
    if (page) {
      await reconcileFactsForPage(storage, r.slug, page.content_hash, page.source_id);
      await mirrorPage(storage, page, { remote: isPublic || writeSource !== undefined, timingLabel: "page_restore" });
    }
  }
  return jsonResult({ ok: true, ...r });
}

async function callPageRevert(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
  isPublic = false,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_revert: `slug` is required");
  }
  const v = args["version"];
  if (!Number.isInteger(v) || (v as number) < 1) {
    return errResult("page_revert: `version` must be a positive integer");
  }
  const writtenBy =
    typeof args["written_by"] === "string" ? args["written_by"] : undefined;
  const r = await revertPage(storage, args["slug"], v as number, writtenBy, writeSource, writePrecondition("page_revert", args));
  if (r.reverted) {
    // The body changed — refresh links, mentions, facts, and the search mirror,
    // exactly as a normal page_put would.
    const page = await getPage(storage, r.slug);
    if (page) {
      const derivedSource = page.source_id;
      await syncWikilinksForPage(storage, r.slug, page.markdown_body, derivedSource);
      await syncMentionsForPage(storage, r.slug, page.markdown_body, derivedSource);
      if (typedLinksEnabled()) {
        await syncTypedLinksForPage(storage, r.slug, page.type, page.compiled_truth, derivedSource);
      }
      if (linkVerbInferEnabled()) {
        await syncVerbLinksForPage(storage, r.slug, page.type, page.markdown_body, derivedSource);
      }
      await syncBodyTimelineForPage(storage, r.slug, derivedSource);
      await stampLinksExtracted(storage.engine(), r.slug, derivedSource); // watermark (mig 051)
      await reconcileFactsForPage(storage, r.slug, page.content_hash, derivedSource);
      await mirrorPage(storage, page, { remote: isPublic || writeSource !== undefined, timingLabel: "page_revert" });
    }
  }
  return jsonResult({ ok: true, ...r });
}

async function callPageGet(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_get: `slug` is required");
  }
  const scopeIds = readSources;
  const fuzzy = args["fuzzy"] === true;
  const includeDeleted = args["include_deleted"] === true && !redact;
  const getOpts = { withVersion: true, ...(includeDeleted ? { includeDeleted: true } : {}) };
  let page: Awaited<ReturnType<typeof getPage>> = null;
  let resolvedSlug: string | undefined;
  try {
    page = await getPage(storage, args["slug"], scopeIds, getOpts);
  } catch (e) {
    // An informal string ("Alice Smith") fails slug validation — with fuzzy on
    // that is the expected entry point, so fall through to resolution.
    if (!fuzzy) throw e;
  }
  if (!page && fuzzy) {
    let candidates = await resolveSlugs(storage, args["slug"], {
      limit: 5,
      ...(scopeIds ? { sourceIds: scopeIds } : {}),
    });
    // Diary fence: a non-operator caller must not learn diary slugs even through
    // the ambiguity list. Drop diary candidates (life/diary/* slug OR type
    // diary/journal) BEFORE branching — if exactly one survives, resolve to it;
    // if none, fall through to the normal not-found shape.
    if (remote && candidates.length > 0) {
      const kept: typeof candidates = [];
      for (const c of candidates) {
        if (!(await isRemoteDiaryFenced(storage, c.slug, scopeIds))) kept.push(c);
      }
      candidates = kept;
    }
    if (candidates.length === 1) {
      page = await getPage(storage, candidates[0]!.slug, scopeIds, getOpts);
      resolvedSlug = candidates[0]!.slug;
    } else if (candidates.length > 1) {
      return jsonResult({
        ok: false,
        error: "ambiguous_slug",
        candidates: candidates.map((c) => c.slug),
      });
    }
  }
  if (!page) throw new PageNotFoundError(args["slug"]);
  // Diary fence: a non-operator caller must not even learn a diary page exists.
  // Throw the SAME not_found as a genuine miss (never permission_denied).
  if (remote && isDiaryPage(page.type, page.slug)) {
    throw new PageNotFoundError(args["slug"]);
  }
  // Retrieval write-back (mig 024): a user just surfaced this page — bump the
  // last_retrieved_at signal the context-volunteer "used" stat reads. Throttled
  // + best-effort; awaited because memrain is single-holder (no fire-and-forget
  // drain needed). page_get is the unambiguous page-surface op; search hits are
  // chunk/document-level and don't carry a page slug, so they don't feed it.
  await bumpLastRetrievedAt(storage.engine(), [page.slug], page.source_id);
  const { version, ...row } = page;
  return jsonResult({
    ok: true,
    page: redact ? redactBody(row as unknown as Record<string, unknown>) : row,
    version: Number(version ?? 0),
    ...(resolvedSlug ? { resolved_slug: resolvedSlug } : {}),
  });
}

async function callPageList(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  const opts: Parameters<typeof listPages>[1] = {};
  if (typeof args["type"] === "string") opts.type = args["type"];
  if (typeof args["since"] === "string") opts.since = args["since"];
  if (typeof args["tag"] === "string" && args["tag"]) opts.tag = args["tag"];
  if (
    args["sort"] === "updated_desc" ||
    args["sort"] === "updated_asc" ||
    args["sort"] === "created_desc" ||
    args["sort"] === "slug"
  ) {
    opts.sort = args["sort"];
  }
  // Soft-deleted rows are operator hygiene — never surfaced on public ingress.
  if (args["include_deleted"] === true && !redact) opts.includeDeleted = true;
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  let pages = await listPages(storage, opts);
  // Diary fence: a non-operator caller never sees diary pages in the listing.
  if (remote) pages = pages.filter((p) => !isDiaryPage(p.type, p.slug));
  const out = redact
    ? pages.map((p) => redactBody(p as unknown as Record<string, unknown>))
    : pages;
  return jsonResult({ ok: true, pages: out });
}

async function callPageVersions(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_versions: `slug` is required");
  }
  // Diary fence: the version chain carries body snapshots. Mirror the miss
  // shape (empty list, not an error) so a diary page is indistinguishable from
  // a slug the caller can't see — pageVersions returns [] for an unknown slug.
  if (remote && (await isRemoteDiaryFenced(storage, args["slug"], readSources))) {
    return jsonResult({ ok: true, versions: [] });
  }
  const limit = typeof args["limit"] === "number" ? args["limit"] : 20;
  const sourceIds = readSources;
  const versions = await pageVersions(storage, args["slug"], limit, sourceIds);
  // Version rows carry body snapshots; redact each through the same
  // page allowlist so public callers see metadata only.
  const out = redact
    ? versions.map((v) => redactBody(v as unknown as Record<string, unknown>))
    : versions;
  return jsonResult({ ok: true, versions: out });
}

// ---------------------------------------------------------------------------
// Graph tools — typed page-to-page links. Writes (link, unlink) are
// in FORBIDDEN_MCP_TOOLS_FROM_PUBLIC; reads (graph_neighbors,
// graph_query) are allowed under the public-bearer but redacted: the
// public projection keeps slugs + the edge type and drops provenance
// (source_chunk_id / written_at), the confidence signal, and the row id.
// ---------------------------------------------------------------------------

async function callLink(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
): Promise<ToolCallResult> {
  if (typeof args["source_slug"] !== "string")
    return errResult("link: `source_slug` is required");
  if (typeof args["target_slug"] !== "string")
    return errResult("link: `target_slug` is required");
  if (typeof args["type"] !== "string")
    return errResult("link: `type` is required");
  const input: Parameters<typeof addLink>[1] = {
    source_slug: args["source_slug"],
    target_slug: args["target_slug"],
    type: args["type"],
  };
  if (typeof args["confidence"] === "number")
    input.confidence = args["confidence"];
  if (typeof args["source_chunk_id"] === "string")
    input.source_chunk_id = args["source_chunk_id"];
  if (typeof args["allowAdHocType"] === "boolean")
    input.allowAdHocType = args["allowAdHocType"];
  if (writeSource) input.source_id = writeSource;
  const r = await addLink(storage, input);
  return jsonResult({ ok: true, ...r });
}

async function callUnlink(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
): Promise<ToolCallResult> {
  if (typeof args["source_slug"] !== "string")
    return errResult("unlink: `source_slug` is required");
  if (typeof args["target_slug"] !== "string")
    return errResult("unlink: `target_slug` is required");
  if (typeof args["type"] !== "string")
    return errResult("unlink: `type` is required");
  const r = await removeLink(storage, {
    source_slug: args["source_slug"],
    target_slug: args["target_slug"],
    type: args["type"],
    ...(writeSource ? { source_id: writeSource } : {}),
  });
  return jsonResult({ ok: true, ...r });
}

async function callGraphNeighbors(
  storage: Storage,
  args: Record<string, unknown>,
  redact: boolean,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string")
    return errResult("graph_neighbors: `slug` is required");
  // Diary fence: never confirm a diary node even by echoing its neighbours.
  if (remote && isDiarySlug(args["slug"])) {
    return jsonResult({ ok: true, slug: args["slug"], links: [] });
  }
  const opts: GraphNeighborsOptions = {};
  if (typeof args["type"] === "string") opts.type = args["type"];
  if (
    args["direction"] === "outbound" ||
    args["direction"] === "inbound" ||
    args["direction"] === "both"
  )
    opts.direction = args["direction"] as GraphNeighborsOptions["direction"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  let links = await graphNeighbors(storage, args["slug"], opts);
  // Drop edges whose OTHER endpoint is a diary page.
  if (remote) links = links.filter((l) => !isDiaryLink(l));
  return jsonResult({
    ok: true,
    slug: args["slug"],
    links: redact
      ? redactGraphLinks(links as unknown as Record<string, unknown>[])
      : links,
  });
}

/** True when either endpoint of a graph edge is a diary slug. */
function isDiaryLink(link: { source_slug?: string; target_slug?: string }): boolean {
  return isDiarySlug(link.source_slug) || isDiarySlug(link.target_slug);
}

async function callGraphQuery(
  storage: Storage,
  args: Record<string, unknown>,
  redact: boolean,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  if (typeof args["type"] !== "string")
    return errResult("graph_query: `type` is required");
  const opts: GraphQueryOptions = { type: args["type"] };
  if (typeof args["source_slug"] === "string")
    opts.source_slug = args["source_slug"];
  if (typeof args["target_slug"] === "string")
    opts.target_slug = args["target_slug"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (!opts.source_slug && !opts.target_slug) {
    return errResult(
      "graph_query: at least one of `source_slug` or `target_slug` is required",
    );
  }
  // Diary fence: a diary slug on either side must not resolve for a tenant.
  if (remote && (isDiarySlug(opts.source_slug) || isDiarySlug(opts.target_slug))) {
    return jsonResult({ ok: true, links: [] });
  }
  if (readSources !== undefined) opts.sourceIds = readSources;
  let links = await graphQuery(storage, opts);
  if (remote) links = links.filter((l) => !isDiaryLink(l));
  return jsonResult({
    ok: true,
    links: redact
      ? redactGraphLinks(links as unknown as Record<string, unknown>[])
      : links,
  });
}

async function callTraverseGraph(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  if (typeof args["start_slug"] !== "string" || args["start_slug"].length === 0) {
    return errResult("traverse_graph: `start_slug` is required");
  }
  // Diary fence: a diary start node yields nothing for a non-operator caller.
  if (remote && isDiarySlug(args["start_slug"])) {
    return jsonResult({ ok: true, start: args["start_slug"], hits: [] });
  }
  const opts: TraverseGraphOptions = {};
  if (typeof args["direction"] === "string")
    opts.direction = args["direction"] as TraverseGraphOptions["direction"];
  if (typeof args["type"] === "string") opts.type = args["type"];
  if (Number.isInteger(args["max_depth"])) opts.maxDepth = args["max_depth"] as number;
  if (Number.isInteger(args["limit"])) opts.limit = args["limit"] as number;
  if (readSources !== undefined) opts.sourceIds = readSources;
  try {
    // Returns only {slug, depth}. Drop any diary node reached along the walk
    // for a non-operator caller.
    let hits = await traverseGraph(storage, args["start_slug"], opts);
    if (remote) hits = hits.filter((h) => !isDiarySlug(h.slug));
    return jsonResult({ ok: true, start: args["start_slug"], hits });
  } catch (e) {
    return errResult(
      `traverse_graph: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function callGetChunks(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  const hasSlug = typeof args["slug"] === "string" && args["slug"].length > 0;
  const hasSrc =
    typeof args["source_path"] === "string" && args["source_path"].length > 0;
  if (!hasSlug && !hasSrc) {
    return errResult("get_chunks: provide `slug` or `source_path`");
  }
  // Diary fence: a non-operator caller gets no diary chunk content. Return an
  // empty set (indistinguishable from a chunk-less / unknown page).
  if (remote) {
    const fenced = hasSlug
      ? await isRemoteDiaryFenced(storage, args["slug"] as string, readSources)
      : isDiarySourcePath(args["source_path"] as string);
    if (fenced) return jsonResult({ ok: true, chunks: [] });
  }
  const sourceIds = readSources;
  const chunks = hasSlug
    ? await getChunksForPage(storage, args["slug"] as string, sourceIds)
    : await getChunksForSource(storage, args["source_path"] as string, sourceIds);
  return jsonResult({ ok: true, chunks });
}

async function callResolveSlugs(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  if (typeof args["query"] !== "string" || args["query"].length === 0) {
    return errResult("resolve_slugs: `query` is required");
  }
  const opts: Parameters<typeof resolveSlugs>[2] = {};
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  let hits = await resolveSlugs(storage, args["query"], opts);
  // Diary fence: never resolve a query to a diary slug for a non-operator caller.
  if (remote) hits = hits.filter((h) => !isDiarySlug(h.slug));
  return jsonResult({ ok: true, query: args["query"], hits });
}

async function callAddTag(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") return errResult("add_tag: `slug` is required");
  if (typeof args["tag"] !== "string") return errResult("add_tag: `tag` is required");
  try {
    await addTag(storage, args["slug"], args["tag"], writeSource);
    return jsonResult({ ok: true, slug: args["slug"], tag: args["tag"] });
  } catch (e) {
    if (e instanceof PageNotFoundError) throw e;
    return errResult(`add_tag: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function callRemoveTag(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") return errResult("remove_tag: `slug` is required");
  if (typeof args["tag"] !== "string") return errResult("remove_tag: `tag` is required");
  await removeTag(storage, args["slug"], args["tag"], writeSource);
  return jsonResult({ ok: true, slug: args["slug"], tag: args["tag"] });
}

async function callGetTags(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") return errResult("get_tags: `slug` is required");
  const sourceIds = readSources;
  const tags = await getTags(storage, args["slug"], sourceIds);
  return jsonResult({ ok: true, slug: args["slug"], tags });
}

async function callRelationalRecall(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  authInfo?: AuthInfo,
  remote = false,
): Promise<ToolCallResult> {
  if (typeof args["query"] !== "string" || args["query"].length === 0) {
    return errResult("relational_recall: `query` is required");
  }
  const query = args["query"];
  const opts: Parameters<typeof relationalRecall>[2] = {};
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (typeof args["depth"] === "number") opts.depth = args["depth"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  // Diary fence, same rule as resolve_slugs: a non-operator caller is never
  // handed a diary slug, whichever arm produced it.
  const fence = (list: { slug: string }[]) =>
    remote ? list.filter((h) => !isDiarySlug(h.slug)) : list;
  const hits = await relationalRecall(storage, query, opts);
  // Opt-in paid fallback (default OFF): when the deterministic regex arm found
  // nothing, ask Sonnet to classify the edge-question and re-run the SAME
  // fanout. Reachable only when MEMRAIN_RELATIONAL_LLM=1 — live MCP stays free.
  if (hits.length === 0 && process.env["MEMRAIN_RELATIONAL_LLM"] === "1") {
    // Forward only the shared scope/paging fields — the two arms carry distinct
    // onMeta shapes, so pass an explicit subset rather than the regex arm's opts.
    const llmOpts: Parameters<typeof relationalRecallLlm>[2] = {};
    if (opts.limit !== undefined) llmOpts.limit = opts.limit;
    if (opts.depth !== undefined) llmOpts.depth = opts.depth;
    if (opts.sourceIds !== undefined) llmOpts.sourceIds = [...opts.sourceIds];
    // Only THIS arm spends Bedrock, so the client-budget refusal wraps it alone —
    // the deterministic arm above stays free and unmetered. The arm reports its
    // real cost through onMeta, echoed to the caller as `spentUsd`.
    let spentUsd = 0;
    llmOpts.onMeta = (meta) => {
      spentUsd = typeof meta.spentUsd === "number" ? meta.spentUsd : 0;
    };
    return await withClientSpend(storage, authInfo, "relational_recall", async () => {
      const llmHits = await relationalRecallLlm(storage, query, llmOpts);
      return jsonResult({ ok: true, query, hits: fence(llmHits), spentUsd });
    });
  }
  return jsonResult({ ok: true, query, hits: fence(hits) });
}

// ---------------------------------------------------------------------------
// Entity-facts + timeline tools (Phase A.3). Writes (add_fact,
// add_timeline_event) are in FORBIDDEN_MCP_TOOLS_FROM_PUBLIC; reads
// (entity_facts, entity_timeline, entity_recall) are open.
// ---------------------------------------------------------------------------

/**
 * Who to credit when the caller supplies no provenance of its own.
 *
 * An unattributed fact cannot be audited, decayed against its origin, or
 * weighed during synthesis — and `add_fact` is reachable over the public write
 * surface. Rejecting the write would be the strict reading, but it throws away
 * a claim the agent wanted recorded; the caller's own identity is provenance,
 * so stamp that instead and keep the ledger complete.
 */
/**
 * The identity to force onto a REMOTE write, or undefined for a trusted local
 * caller whose own provenance is taken at face value.
 */
export function remoteWriterIdentity(opts: DispatchOptions): string | undefined {
  if (opts.isPublic) return "public";
  const id = opts.authInfo?.clientId;
  return id !== undefined && id.length > 0 ? `client:${id}` : undefined;
}

export function writerIdentity(opts: DispatchOptions): string {
  if (opts.isPublic) return "public";
  const id = opts.authInfo?.clientId;
  return id !== undefined && id.length > 0 ? `client:${id}` : "operator";
}

async function callAddFact(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
  isPublic = false,
  fallbackWrittenBy = "operator",
  boundPrefixes?: readonly string[],
  remote = false,
): Promise<ToolCallResult> {
  // Both retire or fan out writes an anonymous caller has no business making.
  if (isPublic && (args["items"] !== undefined || args["replaces"] !== undefined)) {
    throw new OperationError(
      "permission_denied",
      "add_fact: `items` and `replaces` are not available on the public ingress",
      "Send one fact per call, without `replaces`.",
    );
  }
  const bound = boundPrefixes !== undefined && boundPrefixes.length > 0 ? boundPrefixes : undefined;
  const writeOne = (itemArgs: Record<string, unknown>) =>
    addOneFact(storage, itemArgs, writeSource, isPublic, fallbackWrittenBy, bound, remote);
  let body: Record<string, unknown>;
  if (args["items"] !== undefined) {
    const items = normalizeAddFactItems(args);
    // The dispatch-level fence judged only the top-level slug; every item is
    // held to it before anything is written.
    if (bound) for (const item of items) enforceSlugPrefixFence("add_fact", item, bound);
    body = { ...(await runAddFactBatch(items, writeOne)) };
  } else {
    body = { ...(await writeOne(args)) };
  }
  invalidateHotMemoryMeta();
  return jsonResult({ ok: true, ...body });
}

/** One fact through the single-fact path, plus its optional `replaces`. */
async function addOneFact(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource: string | undefined,
  isPublic: boolean,
  fallbackWrittenBy: string,
  boundPrefixes: readonly string[] | undefined,
  remote: boolean,
): Promise<Awaited<ReturnType<typeof addFact>> & { replaced?: boolean; replace_reason?: string }> {
  if (typeof args["entity_slug"] !== "string" || args["entity_slug"].length === 0)
    throw new OperationError("invalid_params", "add_fact: `entity_slug` is required", "Pass the entity the fact is about, e.g. `people/alice`.");
  if (typeof args["fact"] !== "string" || args["fact"].length === 0)
    throw new OperationError("invalid_params", "add_fact: `fact` is required", "Pass a short claim, or several in `items`.");
  const input: Parameters<typeof addFact>[1] = {
    entity_slug: args["entity_slug"],
    fact: args["fact"],
  };
  if (typeof args["confidence"] === "number")
    input.confidence = args["confidence"];
  // Blank and whitespace-only values are not provenance. Left as-is they would
  // suppress the fallback below and land an effectively unattributed row —
  // and an empty source_slug would fail slug validation rather than reading as
  // "omitted".
  const provenanceArg = (key: string): string | undefined => {
    const v = args[key];
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  };
  const sourceSlugArg = provenanceArg("source_slug");
  if (sourceSlugArg !== undefined) input.source_slug = sourceSlugArg;
  const sourceChunkArg = provenanceArg("source_chunk_id");
  if (sourceChunkArg !== undefined) input.source_chunk_id = sourceChunkArg;
  // A public caller does not get to claim provenance: `written_by` is the audit
  // field, and an anonymous writer asserting `operator` would launder its own
  // writes. Dropped on the public path exactly like `visibility` below.
  const writtenByArg = provenanceArg("written_by");
  if (!isPublic && writtenByArg !== undefined) input.written_by = writtenByArg;
  // mig-085 `visibility`, previously unreachable over MCP: every agent write
  // landed on the column DEFAULT 'private', which the read floor then hides
  // from the very caller that wrote it. Passing it through is what makes "you
  // can recall what you published" expressible; the DEFAULT is untouched, so an
  // omitted value still means private.
  //
  // Dropped on public ingress, mirroring how `query`/`decay` are dropped on the
  // read side: an anonymous public writer gains nothing from 'world' (public
  // reads strip the fact text anyway) and would otherwise be able to publish
  // attacker-supplied text into every tenant's recall.
  if (!isPublic && typeof args["visibility"] === "string")
    input.visibility = args["visibility"];
  if (writeSource) input.source_id = writeSource;
  // Provenance is not optional. A caller that named a source page, a source
  // chunk or a writer has said where the claim came from; one that named none
  // is credited to itself rather than landing in the ledger anonymous.
  if (
    input.source_slug === undefined &&
    input.source_chunk_id === undefined &&
    input.written_by === undefined
  ) {
    input.written_by = fallbackWrittenBy;
  }
  const r = await addFact(storage, input);
  const replaces = args["replaces"];
  if (typeof replaces !== "number") return r;
  // The new fact is already committed; a failed retirement must not hide that.
  try {
    const outcome = await replaceFact(
      storage.engine(),
      replaces,
      r.id,
      writeSource ? [writeSource] : undefined,
      boundPrefixes ? (slug) => slugUnderPrefixes(slug, boundPrefixes) : undefined,
      { worldOnly: remote },
    );
    return { ...r, ...outcome };
  } catch (e) {
    console.error("[add_fact] replaces failed:", e instanceof Error ? e.message : e);
    return { ...r, replaced: false, replace_reason: "error" };
  }
}

async function callAddTimelineEvent(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string")
    return errResult("add_timeline_event: `slug` is required");
  if (typeof args["occurred_at"] !== "string")
    return errResult(
      "add_timeline_event: `occurred_at` is required (ISO-8601 string)",
    );
  if (typeof args["event"] !== "string" || args["event"].length === 0)
    return errResult("add_timeline_event: `event` is required");
  const input: Parameters<typeof addTimelineEvent>[1] = {
    slug: args["slug"],
    occurred_at: args["occurred_at"],
    event: args["event"],
  };
  if (typeof args["source_chunk_id"] === "string")
    input.source_chunk_id = args["source_chunk_id"];
  if (writeSource) input.source_id = writeSource;
  const r = await addTimelineEvent(storage, input);
  return jsonResult({ ok: true, ...r });
}

async function callEntityFacts(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  // entity_slug is optional: omit for a cross-entity recall. When present it
  // must be a string.
  const entitySlug =
    typeof args["entity_slug"] === "string" && args["entity_slug"]
      ? (args["entity_slug"] as string)
      : undefined;
  const opts: ListFactsOptions = {};
  if (typeof args["since"] === "string") opts.since = args["since"];
  if (typeof args["source_slug"] === "string")
    opts.source_slug = args["source_slug"];
  if (args["order"] === "recency" || args["order"] === "confidence")
    opts.order = args["order"];
  if (typeof args["session"] === "string" && args["session"])
    opts.session = args["session"];
  if (typeof args["grep"] === "string" && args["grep"]) opts.grep = args["grep"];
  // mig-085 visibility gate, ENFORCED: any non-operator principal (public
  // ingress OR an authenticated tenant token) is floored to world-visible facts
  // regardless of the requested filter; only the operator path may read private
  // rows. Same floor gates the tombstone audit surface.
  //
  // Keyed on the INGRESS SHAPE (`remote`), never on `redact`: `redact` is false
  // whenever the operator sets MEMRAIN_PUBLIC_READ_BODIES, which used to hand a
  // public caller the private rows in full text. That flag governs free-text
  // BODIES; it must never widen a visibility grant. `remote` is a strict
  // superset of the old predicate — a non-empty read set implies an authInfo
  // (effectiveReadSourceIds returns undefined without one), so no caller that
  // was floored before is unfloored now.
  const scopedReader = remote;
  if (scopedReader) {
    opts.visibility = ["world"];
  } else if (args["visibility"] === "private" || args["visibility"] === "world") {
    opts.visibility = [args["visibility"]];
  }
  if (args["include_forgotten"] === true && !scopedReader)
    opts.include_forgotten = true;
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  // Confidence decay is INTERNAL ONLY (mirrors entity_recall `query`/`decay`).
  // It reorders facts and drops expired ones using hidden `kind`/`valid_until`;
  // on the public path the text is redacted but stable ids/confidence remain,
  // so a caller could diff the decayed order against `order:"recency"` (which
  // disables decay) to infer which hidden fact expired/demoted. Force it OFF on
  // public; internal callers get it via the `MEMRAIN_FACT_DECAY` env default.
  if (redact) opts.decay = false;
  if (readSources !== undefined) opts.sourceIds = readSources;
  const facts = await listFacts(storage, entitySlug, opts);
  // Public ingress: `fact` is note-derived private content — strip it,
  // mirroring the search/page body redaction policy.
  const out = redact
    ? redactFacts(facts as unknown as Record<string, unknown>[])
    : facts;
  return jsonResult({ ok: true, entity_slug: entitySlug ?? null, facts: out });
}

async function callEntityTimeline(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string")
    return errResult("entity_timeline: `slug` is required");
  const opts: ListTimelineOptions = {};
  if (typeof args["since"] === "string") opts.since = args["since"];
  if (typeof args["until"] === "string") opts.until = args["until"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  const timeline = await getEntityTimeline(storage, args["slug"], opts);
  // Public ingress: `event` is note-derived private content — strip it.
  const out = redact
    ? redactTimeline(timeline as unknown as Record<string, unknown>[])
    : timeline;
  return jsonResult({ ok: true, slug: args["slug"], timeline: out });
}

async function callEntityRecall(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string")
    return errResult("entity_recall: `slug` is required");
  // Diary fence: entity_recall returns the page body — hide a diary entity from
  // a non-operator caller, mirroring the soft-stub miss (page null, no rows).
  if (remote && (await isRemoteDiaryFenced(storage, args["slug"], readSources))) {
    return jsonResult({ ok: true, page: null, facts: [], timeline: [] });
  }
  const opts: EntityRecallOptions = {};
  // `query` re-orders facts by semantic similarity to caller-supplied text.
  // INTERNAL ONLY: on the public-bearer path (redact) the fact text is stripped
  // but stable identifiers remain, so query-driven REORDERING would be a
  // content oracle (probe which hidden fact moves for "funding" / "health" /
  // …) AND an unbounded per-call Bedrock cost knob. Drop it on public ingress;
  // public recall keeps the fixed confidence order.
  if (!redact && typeof args["query"] === "string" && args["query"].trim())
    opts.query = args["query"];
  // Confidence decay is INTERNAL ONLY for the same reason: it REORDERS facts
  // (and DROPS expired ones) using hidden `kind`/`valid_until` metadata. On the
  // public path the fact text is stripped but stable ids/confidence remain, so
  // a caller could diff decayed vs `order:"recency"` output to infer which
  // hidden fact expired/demoted. Force decay OFF on public; internal recall
  // honors `MEMRAIN_FACT_DECAY` via the recall layer's env default.
  if (redact) opts.decay = false;
  if (typeof args["fact_limit"] === "number")
    opts.fact_limit = args["fact_limit"];
  if (typeof args["timeline_limit"] === "number")
    opts.timeline_limit = args["timeline_limit"];
  if (args["include_pending"] === true) opts.include_pending = true;
  // Public ingress forces body redaction (omits page.markdown_body) via
  // the recall layer's native flag; an explicit `redact_body` arg still
  // wins for internal callers who want to override.
  if (typeof args["redact_body"] === "boolean")
    opts.redact_body = args["redact_body"];
  else if (redact) opts.redact_body = true;
  if (readSources !== undefined) opts.sourceIds = readSources;
  // Same mig-085 floor callEntityFacts applies, on the same ledger: recall
  // reads entity_facts too, so without this a non-operator caller could read a
  // private fact through the aggregator that entity_facts refuses to show it.
  if (remote) opts.visibility = ["world"];
  const r = await entityRecall(storage, args["slug"], opts);
  // `redact_body` only strips the page body; the facts + timeline arrays
  // carry note-derived `fact`/`event` text and must be redacted on public
  // ingress too (mirrors callEntityFacts / callEntityTimeline).
  if (redact) {
    const visible = {
      ...r,
      ok: true,
      // Run the page through the same PUBLIC_SAFE_PAGE_FIELDS allowlist the
      // other page tools use. The recall layer's redact_body only strips
      // markdown_body via destructure, which is NOT fail-safe — a new
      // PageRow field would leak by default here. redactBody keeps recall
      // consistent with page_get/page_list (e.g. drops deleted_at too).
      page: r.page
        ? redactBody(r.page as unknown as Record<string, unknown>)
        : r.page,
      facts: redactFacts(r.facts as unknown as Record<string, unknown>[]),
      timeline: redactTimeline(
        r.timeline as unknown as Record<string, unknown>[],
      ),
    };
    return jsonResult(budgeted(visible));
  }
  return jsonResult(budgeted({ ok: true, ...r }));

  /**
   * One budget across all three arms. Without it a caller under a context
   * budget had to guess the split, fetch, measure and call again — the server
   * is the side that knows the sizes.
   *
   * Applied AFTER redaction, deliberately: budgeting the unredacted rows would
   * make the dropped counts a size oracle for content the caller is not
   * allowed to see.
   */
  function budgeted(payload: Record<string, unknown>): Record<string, unknown> {
    const budget = args["token_budget"];
    if (!(typeof budget === "number" && Number.isFinite(budget) && budget > 0)) {
      return payload;
    }
    const trimmed = applyRecallBudget(
      {
        page: payload["page"] as { markdown_body?: string | null } | null,
        facts: (payload["facts"] ?? []) as Record<string, unknown>[],
        timeline: (payload["timeline"] ?? []) as Record<string, unknown>[],
      },
      budget,
    );
    return {
      ...payload,
      page: trimmed.page,
      facts: trimmed.facts,
      timeline: trimmed.timeline,
      // Say what was cut. A caller that cannot tell "everything" from "what
      // fit" treats a partial answer as complete.
      budget: trimmed.report,
    };
  }
}

// ---------------------------------------------------------------------------
// Jobs DAG tools (Phase A.4). Writes (jobs_submit, jobs_cancel) are
// in FORBIDDEN_MCP_TOOLS_FROM_PUBLIC; reads are open.
// ---------------------------------------------------------------------------

async function callJobsSubmit(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["kind"] !== "string")
    return errResult("jobs_submit: `kind` is required");
  // An unknown kind would sit in the queue and burn its whole retry budget
  // before dead-lettering; refuse it here instead.
  if (!isKnownJobKind(args["kind"])) {
    return errResult(
      `jobs_submit: unknown kind ${JSON.stringify(args["kind"].slice(0, 64))} (known: ${knownJobKinds().join(", ")})`,
    );
  }
  const input: SubmitJobInput = { kind: args["kind"] };
  if (typeof args["payload"] === "object" && args["payload"] !== null)
    input.payload = args["payload"] as Record<string, unknown>;
  if (typeof args["priority"] === "number") input.priority = args["priority"];
  if (typeof args["max_retries"] === "number")
    input.max_retries = args["max_retries"];
  if (typeof args["parent_job_id"] === "string")
    input.parent_job_id = args["parent_job_id"];
  if (typeof args["idempotency_key"] === "string")
    input.idempotency_key = args["idempotency_key"];
  if (typeof args["not_before"] === "string")
    input.not_before = args["not_before"];
  if (typeof args["timeout_ms"] === "number")
    input.timeout_ms = args["timeout_ms"];
  const r = await submitJob(storage.engine(), input);
  return jsonResult({ ok: true, ...r });
}

async function callJobsList(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
): Promise<ToolCallResult> {
  const opts: ListJobsOptions = {};
  if (typeof args["status"] === "string") opts.status = args["status"];
  if (typeof args["kind"] === "string") opts.kind = args["kind"];
  if (typeof args["parent_job_id"] === "string")
    opts.parent_job_id = args["parent_job_id"];
  if (typeof args["since"] === "string") opts.since = args["since"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  const jobs = await listJobs(storage.engine(), opts);
  // Public ingress: drop caller-derived `idempotency_key` (often a path).
  const out = redact
    ? jobs.map((j) => redactJob(j as unknown as Record<string, unknown>))
    : jobs;
  return jsonResult({ ok: true, jobs: out });
}

async function callJobsGet(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
): Promise<ToolCallResult> {
  if (typeof args["id"] !== "string")
    return errResult("jobs_get: `id` is required");
  const job = await getJob(storage.engine(), args["id"]);
  if (!job) return errResult(`jobs_get: ${args["id"]} not found`);
  // Public ingress: `payload`/`result`/`last_error` carry arbitrary
  // note-derived free text (vault paths, snippets) — strip them.
  const out = redact
    ? redactJob(job as unknown as Record<string, unknown>)
    : job;
  return jsonResult({ ok: true, job: out });
}

async function callJobsCancel(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["id"] !== "string")
    return errResult("jobs_cancel: `id` is required");
  const opts: { cascade?: boolean; reason?: string } = {};
  if (typeof args["cascade"] === "boolean") opts.cascade = args["cascade"];
  if (typeof args["reason"] === "string") opts.reason = args["reason"];
  const r = await cancelJob(storage.engine(), args["id"], opts);
  return jsonResult({ ok: true, ...r });
}

async function callJobsLogs(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
): Promise<ToolCallResult> {
  if (typeof args["id"] !== "string")
    return errResult("jobs_logs: `id` is required");
  const job = await getJob(storage.engine(), args["id"]);
  if (!job) return errResult(`jobs_logs: ${args["id"]} not found`);
  const log = {
    id: job.id,
    kind: job.kind,
    status: job.status,
    retry_count: job.retry_count,
    last_error: job.last_error,
    created_at: job.created_at,
    updated_at: job.updated_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    depth: job.depth,
    parent_job_id: job.parent_job_id,
    children_count: job.children.length,
    inbox_unread: job.inbox_unread,
  };
  // Public ingress: `last_error` can echo pgerror text / vault paths.
  const out = redact
    ? redactJob(log as unknown as Record<string, unknown>)
    : log;
  return jsonResult({ ok: true, log: out });
}

// --- Wave 1: graph reads, insights, facts, identity, refinement ---

async function callGetLinks(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("get_links: `slug` is required");
  }
  // Diary fence: a diary node's edge set is hidden from a non-operator caller.
  if (remote && isDiarySlug(args["slug"])) {
    return jsonResult({ ok: true, slug: args["slug"], groups: [] });
  }
  const opts: Parameters<typeof getLinks>[2] = {};
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  let groups = await getLinks(storage, args["slug"], opts);
  // Drop edges to a diary page, then any group left empty.
  if (remote) {
    groups = groups
      .map((g) => ({ ...g, links: g.links.filter((l) => !isDiaryLink(l)) }))
      .filter((g) => g.links.length > 0);
  }
  return jsonResult({ ok: true, slug: args["slug"], groups });
}

async function callListLinkSources(storage: Storage, readSources?: string[]): Promise<ToolCallResult> {
  const sources = await listLinkSources(storage, readSources);
  return jsonResult({ ok: true, sources });
}

async function callFindOrphans(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  const opts: FindOrphansOptions = {};
  if (typeof args["type"] === "string") opts.type = args["type"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  let pages = await findOrphans(storage, opts);
  // Diary fence: these are page rows (slug + title) — a diary page must not
  // surface as an enrichment target for a non-operator caller.
  if (remote) pages = pages.filter((p) => !isDiarySlug(p.slug));
  return jsonResult({ ok: true, pages });
}

async function callFindExperts(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  const opts: FindExpertsOptions = {};
  if (typeof args["type"] === "string") opts.type = args["type"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (typeof args["topic"] === "string") opts.topic = args["topic"];
  if (args["explain"] === true) opts.explain = true;
  if (readSources !== undefined) opts.sourceIds = readSources;
  let experts = await findExperts(storage, opts);
  // Diary fence: the link-degree arm ranks EVERY page type, so a diary page can
  // rank as a hub (and `type: "diary"` reaches the topic arm too).
  if (remote) experts = experts.filter((e) => !isDiarySlug(e.slug));
  return jsonResult({ ok: true, experts });
}

async function callFindContradictions(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  const opts: FindContradictionsOptions = {};
  if (typeof args["slug"] === "string") opts.slug = args["slug"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  // Asserted `contradicts` edges (deterministic graph) + LLM-suspected findings
  // cached by the probe-contradictions phase (migration 064; [] on a pre-064
  // brain or when the probe has never run). Same tenant scope for both.
  const probedOpts: {
    limit?: number;
    sourceIds?: string[];
    severity?: "low" | "medium" | "high";
  } = {};
  if (typeof args["limit"] === "number") probedOpts.limit = args["limit"];
  if (
    args["severity"] === "low" ||
    args["severity"] === "medium" ||
    args["severity"] === "high"
  ) {
    probedOpts.severity = args["severity"];
  }
  if (readSources !== undefined) probedOpts.sourceIds = readSources;
  const [asserted, probed] = await Promise.all([
    findContradictions(storage, opts),
    listProbedContradictions(storage, probedOpts),
  ]);
  // Diary fence: an asserted `contradicts` row carries both page slugs and both
  // page titles, so drop the pair when either endpoint is diary. The probed rows
  // reference facts/takes by id (a_ref/b_ref), never a page — untouched.
  const contradictions = remote ? asserted.filter((c) => !isDiaryLink(c)) : asserted;
  return jsonResult({ ok: true, contradictions, probed });
}

async function callFindTrajectory(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["entity_slug"] !== "string" || args["entity_slug"].length === 0) {
    return errResult("find_trajectory: `entity_slug` is required");
  }
  const opts: FindTrajectoryOptions = {};
  if (typeof args["since"] === "string") opts.since = args["since"];
  if (typeof args["until"] === "string") opts.until = args["until"];
  if (typeof args["metric"] === "string" && args["metric"])
    opts.metric = args["metric"];
  if (args["kind"] === "metric" || args["kind"] === "event" || args["kind"] === "all")
    opts.claimKind = args["kind"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  const points = await findTrajectory(storage, args["entity_slug"], opts);
  return jsonResult({ ok: true, entity_slug: args["entity_slug"], points });
}

async function callGetRecentSalience(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  const opts: Parameters<typeof getRecentSalience>[1] = {};
  if (typeof args["type"] === "string") opts.type = args["type"];
  if (typeof args["days"] === "number") opts.days = args["days"];
  if (typeof args["slug_prefix"] === "string" && args["slug_prefix"])
    opts.slugPrefix = args["slug_prefix"];
  if (args["recency_bias"] === "on") opts.recencyBias = "on";
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  let pages = await getRecentSalience(storage, opts);
  // Diary fence: page rows (slug + title), and `slug_prefix` lets a caller ask
  // for `life/diary/` outright.
  if (remote) pages = pages.filter((p) => !isDiarySlug(p.slug));
  return jsonResult({ ok: true, pages });
}

async function callFindAnomalies(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  const opts: Parameters<typeof findAnomalies>[1] = {};
  if (typeof args["sigma"] === "number") opts.sigma = args["sigma"];
  if (typeof args["staleDays"] === "number") opts.staleDays = args["staleDays"];
  if (typeof args["salienceFloor"] === "number") opts.salienceFloor = args["salienceFloor"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  let anomalies = await findAnomalies(storage, opts);
  // Diary fence: each anomaly is a page row (slug + title).
  if (remote) anomalies = anomalies.filter((a) => !isDiarySlug(a.slug));
  return jsonResult({ ok: true, anomalies });
}

async function callRecall(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  const id = args["id"];
  if (!Number.isInteger(id) || (id as number) < 1) {
    return errResult("recall: `id` must be a positive integer");
  }
  const fact = await recallFact(storage, id as number, readSources);
  // Diary fence: the row carries `source_slug` — the page the fact was extracted
  // from. A diary-sourced fact reads as unknown to a non-operator caller, the
  // same posture the ontology read takes (isDiarySourced).
  if (!fact || (remote && isDiarySourced(fact.source_slug))) {
    throw new OperationError(
      "not_found",
      `recall: fact ${id} not found`,
      "Pass a live fact id (see entity_facts).",
    );
  }
  return jsonResult({ ok: true, fact });
}

async function callForgetFact(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
  remote = false,
): Promise<ToolCallResult> {
  const id = args["id"];
  if (!Number.isInteger(id) || (id as number) < 1) {
    return errResult("forget_fact: `id` must be a positive integer");
  }
  const opts: Parameters<typeof forgetFact>[2] = {};
  if (typeof args["reason"] === "string") opts.reason = args["reason"];
  if (remote) opts.worldOnly = true;
  // A destructive write scopes to the caller's SINGLE write source (a scalar),
  // never the federated READ set — a tenant may read many sources but must only
  // forget within its own write source. Undefined → unscoped, unchanged.
  const scope = writeSource ? [writeSource] : undefined;
  const r = await forgetFact(storage, id as number, opts, scope);
  if (!r.forgotten) return jsonResult({ ok: true, ...r });
  invalidateHotMemoryMeta();
  // Advisory: the forget already committed, so a failed lookup must not turn
  // it into an error.
  let similar: Awaited<ReturnType<typeof similarActiveAfterForget>> | undefined;
  try {
    similar = await similarActiveAfterForget(storage.engine(), r.id, {
      ...(scope ? { sourceIds: scope } : {}),
      remote,
    });
  } catch (e) {
    console.error("[forget_fact] similar_active lookup failed:", e instanceof Error ? e.message : e);
  }
  return jsonResult({ ok: true, ...r, ...(similar ? { similar_active: similar } : {}) });
}

async function callGetBrainIdentity(
  storage: Storage,
  readSources?: string[],
): Promise<ToolCallResult> {
  const id = await brainIdentity(storage, readSources);
  return jsonResult({ ok: true, ...id });
}

/** Introspect the calling identity — the caller's own auth context, no corpus.
 *  Unscoped (no authInfo / no read scope) reports read_sources: null. */
function callWhoami(
  authInfo: AuthInfo | undefined,
  readSources: string[] | undefined,
  isPublic: boolean,
): ToolCallResult {
  return jsonResult({
    ok: true,
    client_id: authInfo?.clientId ?? null,
    scopes: authInfo?.scopes ?? [],
    write_source: authInfo?.sourceId ?? null,
    read_sources: readSources ?? null,
    is_public: isPublic,
  });
}

async function callPurgeDeletedPages(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
): Promise<ToolCallResult> {
  let olderThanHours: number | undefined;
  if (args["older_than_hours"] !== undefined) {
    const v = args["older_than_hours"];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return errResult(
        "purge_deleted_pages: `older_than_hours` must be a non-negative number",
      );
    }
    olderThanHours = v;
  }
  // Scope the reaper to the caller's write source when scoped. Passing
  // `olderThanHours` undefined still triggers the fn's default TTL (72h).
  const scope = writeSource ? [writeSource] : undefined;
  const r = await purgeDeletedPages(storage.engine(), olderThanHours, scope);
  return jsonResult({ ok: true, ...r });
}

/**
 * Flagship full-control retrieval (the `query` op semantics).
 * Legacy compatibility: a non-empty `refine` keeps the deterministic
 * weighted-RRF two-query blend the op originally shipped.
 */
async function callQuery(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  isOperator = false,
  embedQuery?: SearchOptions["embedQuery"],
): Promise<ToolCallResult> {
  const q = args["q"];
  if (typeof q !== "string" || q.length === 0) {
    throw new OperationError(
      "invalid_params",
      "query: `q` is required",
      "Pass a non-empty `q` string.",
    );
  }
  const onCapture = makeCaptureCallback(storage.engine(), storage.config(), {
    toolName: "mcp.query",
    remote: true,
  });
  const refine = typeof args["refine"] === "string" ? args["refine"] : "";
  if (refine) {
    const opts: Parameters<typeof queryRefine>[3] = {};
    if (typeof args["k"] === "number") opts.k = args["k"];
    if (typeof args["primary_weight"] === "number") opts.primaryWeight = args["primary_weight"];
    if (typeof args["refine_weight"] === "number") opts.refineWeight = args["refine_weight"];
    if (readSources !== undefined) opts.sourceIds = readSources;
    if (onCapture) opts.search = { onCapture };
    const hits = await queryRefine(storage, q, refine, opts);
    return jsonResult({ ok: true, hits: fenceDiaryHits(hits, isOperator) });
  }

  const k = typeof args["k"] === "number" ? (args["k"] as number) : 20;
  const offset =
    typeof args["offset"] === "number"
      ? Math.max(0, Math.floor(args["offset"] as number))
      : 0;
  const searchOpts: SearchOptions = { k: k + offset };
  if (onCapture) searchOpts.onCapture = onCapture;
  if (readSources !== undefined) searchOpts.sourceIds = readSources;
  // Paid LLM expansion: explicit per-call value wins; omitted follows the
  // env/mode-bundle chain (OFF in conservative/balanced — cost posture).
  if (typeof args["expand"] === "boolean") searchOpts.expansion = args["expand"];
  if (args["detail"] === "low" || args["detail"] === "medium" || args["detail"] === "high") {
    searchOpts.detail = args["detail"];
  }
  const modeOf = (key: "salience" | "recency"): "off" | "on" | "strong" | undefined => {
    const v = args[key];
    return v === "off" || v === "on" || v === "strong" ? v : undefined;
  };
  const salience = modeOf("salience");
  if (salience) searchOpts.salience = salience;
  const recency = modeOf("recency");
  if (recency) searchOpts.recency = recency;
  const since = isoDateBound("query", args, "since");
  const until = isoDateBound("query", args, "until");
  if (since) searchOpts.since = since;
  if (until) searchOpts.until = until;
  if (typeof args["lang"] === "string" && args["lang"]) searchOpts.lang = args["lang"];
  if (typeof args["symbol_kind"] === "string" && args["symbol_kind"]) {
    searchOpts.symbolKind = args["symbol_kind"];
  }
  if (typeof args["near_symbol"] === "string" && args["near_symbol"]) {
    searchOpts.nearSymbol = args["near_symbol"];
  }
  if (typeof args["walk_depth"] === "number") {
    searchOpts.walkDepth = Math.min(Math.max(args["walk_depth"] as number, 0), 2);
  }
  if (typeof args["token_budget"] === "number") {
    searchOpts.tokenBudget = args["token_budget"] as number;
  }
  if (args["adaptive_return"] === true) searchOpts.adaptiveReturn = true;
  if (args["explain"] === true) searchOpts.explain = true;
  applyPerCallMode(searchOpts, args["mode"], isOperator);
  if (embedQuery) searchOpts.embedQuery = embedQuery;
  let meta: SearchMeta | undefined;
  searchOpts.onMeta = (m) => {
    meta = m;
  };
  const hitsAll = await hybridSearch(storage, q, searchOpts);
  const hitsOffset = offset > 0 ? hitsAll.slice(offset) : hitsAll;
  // Diary fence for the non-operator caller (mirrors callSearch).
  const hits = fenceDiaryHits(hitsOffset, isOperator);
  const metaOut = responseSearchMeta(meta, hits.length, isOperator);
  return jsonResult({ ok: true, hits, ...(metaOut ? { meta: metaOut } : {}) });
}

async function callCodeCallers(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["name"] !== "string" || args["name"].length === 0) {
    return errResult("code_callers: `name` is required");
  }
  const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
  const sourceIds = readSources;
  const result = await codeCallers(storage.engine(), args["name"], limit, sourceIds);
  return jsonResult({ ok: true, ...result });
}

async function callCodeCallees(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["target"] !== "string" || args["target"].length === 0) {
    return errResult("code_callees: `target` is required");
  }
  const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
  const sourceIds = readSources;
  const result = await codeCallees(storage.engine(), args["target"], limit, sourceIds);
  return jsonResult({ ok: true, ...result });
}

async function callCodeDefs(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["name"] !== "string" || args["name"].length === 0) {
    return errResult("code_def: `name` is required");
  }
  const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
  const sourceIds = readSources;
  const result = await codeDefs(storage.engine(), args["name"], limit, sourceIds);
  return jsonResult({ ok: true, ...result });
}

async function callCodeRefs(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["name"] !== "string" || args["name"].length === 0) {
    return errResult("code_refs: `name` is required");
  }
  const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
  const sourceIds = readSources;
  const result = await codeRefs(storage.engine(), args["name"], limit, sourceIds);
  return jsonResult({ ok: true, ...result });
}

async function callCodeWalk(
  storage: Storage,
  args: Record<string, unknown>,
  readSources: string[] | undefined,
  direction: "callers" | "callees",
): Promise<ToolCallResult> {
  if (typeof args["symbol"] !== "string" || args["symbol"].length === 0) {
    return errResult(
      `${direction === "callers" ? "code_blast" : "code_flow"}: \`symbol\` is required`,
    );
  }
  const sourceIds = readSources;
  const depthCapMax = direction === "callers" ? 8 : 12;
  const depth =
    typeof args["depth"] === "number"
      ? Math.min(Math.max(1, Math.floor(args["depth"] as number)), depthCapMax)
      : undefined;
  const maxNodes =
    typeof args["max_nodes"] === "number"
      ? Math.min(Math.max(1, Math.floor(args["max_nodes"] as number)), 200)
      : undefined;
  const exact = args["exact"] === true;
  const result = await runRecursiveWalk(storage.engine(), args["symbol"], {
    direction,
    depth,
    maxNodes,
    sourceIds,
    exact,
  });
  return jsonResult({ ok: true, ...result });
}

async function callVolunteerContext(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  // Stats mode: per-arm used/volunteered precision (feedback loop). `days` is
  // the documented window param; `turn` kept as the legacy fallback. The read
  // scope is threaded so a scoped caller is refused the whole-brain aggregate
  // (permission_denied) instead of being handed every tenant's telemetry — the
  // event log has no source axis to narrow it by (see volunteerUsageStats).
  if (args["stats"] === true) {
    const days =
      typeof args["days"] === "number"
        ? (args["days"] as number)
        : typeof args["turn"] === "number"
          ? (args["turn"] as number)
          : 30;
    const stats = await volunteerUsageStats(storage, days, readSources);
    return jsonResult({ ok: true, ...stats });
  }
  if (typeof args["window"] !== "string" || args["window"].length === 0) {
    return errResult("volunteer_context: `window` is required");
  }
  const turns = parseWindow(args["window"]);
  if (!turns.length) return jsonResult({ ok: true, pages: [] });

  const opts: Parameters<typeof volunteerContext>[1] = { window: turns };
  if (typeof args["max_pages"] === "number") opts.maxPages = args["max_pages"];
  if (typeof args["min_confidence"] === "number") opts.minConfidence = args["min_confidence"];
  if (typeof args["prior_context"] === "string" && args["prior_context"])
    opts.priorContext = args["prior_context"];
  if (readSources !== undefined) opts.sourceIds = readSources;

  let pages = await volunteerContext(storage, opts);
  // Diary fence: a non-operator caller is never volunteered a diary page, the
  // same rule resolve_slugs and the chronicle reads apply.
  if (remote) pages = pages.filter((p) => !isDiarySlug(p.slug));

  // Fire-and-forget feedback log (channel 'op').
  const sessionId = typeof args["session_id"] === "string" ? args["session_id"] : null;
  const turn = typeof args["turn"] === "number" ? (args["turn"] as number) : null;
  logVolunteerEventsFireAndForget(
    storage,
    volunteerEventRowsFrom(pages, { channel: "op", session_id: sessionId, turn }),
  );

  return jsonResult({ ok: true, pages });
}

async function callContextPack(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  if (args["slugs"] !== undefined && !Array.isArray(args["slugs"])) {
    return errResult("context_pack: `slugs` must be an array of strings");
  }
  const opts: ContextPackOpts = { remote };
  if (Array.isArray(args["slugs"])) opts.slugs = args["slugs"];
  if (typeof args["window"] === "string") opts.window = args["window"];
  if (typeof args["max_entities"] === "number") opts.maxEntities = args["max_entities"];
  if (typeof args["facts_limit"] === "number") opts.factsLimit = args["facts_limit"];
  if (typeof args["token_budget"] === "number") opts.tokenBudget = args["token_budget"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  // Same floors as entity_facts / entity_recall: any non-operator caller reads
  // world-visible facts only, and decay (which reorders on hidden metadata) is
  // off wherever bodies are redacted; everyone else gets the MEMRAIN_FACT_DECAY
  // default through the recall layer.
  if (remote) {
    opts.visibility = ["world"];
    opts.fenced = (slug) => isRemoteDiaryFenced(storage, slug, readSources);
  }
  if (redact) {
    opts.decay = false;
    opts.redact = true;
  }
  const pack = await buildContextPack(storage, opts);
  return jsonResult({ ok: true, ...pack });
}

async function callAdvisor(
  storage: Storage,
  readSources?: string[],
): Promise<ToolCallResult> {
  const report = await runAdvisor({
    engine: storage.raw(),
    version: VERSION,
    now: new Date(),
    // Forward the caller's read scope so tenant-owned collectors (chronicle
    // coverage / ontology conflicts) stay source-scoped; a scopeless caller
    // leaves it unset and those collectors fail closed (silent, no leak).
    ...(readSources !== undefined ? { sourceIds: readSources } : {}),
  });
  return jsonResult({ ok: true, ...report });
}

async function callListBrainSkillpack(): Promise<ToolCallResult> {
  return jsonResult({ ok: true, ...listBrainSkillpacks() });
}

async function callListConcepts(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
  const sourceIds = readSources;
  const concepts = await listConcepts(storage.engine(), limit, sourceIds);
  return jsonResult({ ok: true, concepts });
}

async function callListTakes(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  takesHolders?: string[],
): Promise<ToolCallResult> {
  const opts: Parameters<typeof listTakes>[1] = {};
  if (typeof args["status"] === "string") opts.status = args["status"];
  if (typeof args["kind"] === "string" && args["kind"]) opts.kind = args["kind"];
  if (typeof args["domain"] === "string" && args["domain"])
    opts.domain = args["domain"];
  if (typeof args["holder"] === "string" && args["holder"])
    opts.holder = args["holder"];
  if (args["sort"] === "weight" || args["sort"] === "generated_at")
    opts.sort = args["sort"];
  if (typeof args["offset"] === "number") opts.offset = args["offset"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  if (takesHolders) opts.holderAllowList = takesHolders;
  const takes = await listTakes(storage.engine(), opts);
  return jsonResult({ ok: true, takes });
}

async function callSetTakeStatus(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
): Promise<ToolCallResult> {
  if (typeof args["take_key"] !== "string" || args["take_key"].length === 0)
    return errResult("set_take_status: `take_key` is required");
  if (args["status"] !== "accepted" && args["status"] !== "rejected")
    return errResult("set_take_status: `status` must be 'accepted' or 'rejected'");
  const sourceIds = writeSource ? [writeSource] : undefined;
  const r = await setTakeStatus(storage.engine(), args["take_key"], args["status"], sourceIds);
  return jsonResult({ ok: true, ...r });
}

async function callSearchTakes(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  takesHolders?: string[],
): Promise<ToolCallResult> {
  if (typeof args["q"] !== "string" || args["q"].length === 0)
    return errResult("takes_search: `q` is required");
  const opts: Parameters<typeof searchTakes>[1] = { q: args["q"] };
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  if (takesHolders) opts.holderAllowList = takesHolders;
  const takes = await searchTakes(storage.engine(), opts);
  return jsonResult({ ok: true, takes });
}

async function callGetCalibrationProfile(
  storage: Storage,
  readSources?: string[],
): Promise<ToolCallResult> {
  const sourceIds = readSources;
  const profile = await getCalibrationProfile(storage.engine(), sourceIds);
  return jsonResult({ ok: true, profile });
}

async function callTakesScorecard(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  takesHolders?: string[],
): Promise<ToolCallResult> {
  const opts: Parameters<typeof getTakesScorecard>[1] = {};
  if (typeof args["domain"] === "string" && args["domain"]) opts.domain = args["domain"];
  if (typeof args["holder"] === "string" && args["holder"]) opts.holder = args["holder"];
  if (typeof args["since"] === "string" && args["since"]) opts.since = args["since"];
  if (typeof args["until"] === "string" && args["until"]) opts.until = args["until"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  if (takesHolders) opts.holderAllowList = takesHolders;
  const scorecard = await getTakesScorecard(storage.engine(), opts);
  return jsonResult({ ok: true, scorecard });
}

async function callTakesCalibration(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  takesHolders?: string[],
): Promise<ToolCallResult> {
  const opts: Parameters<typeof getTakesCalibration>[1] = {};
  if (typeof args["bucket_size"] === "number") opts.bucketSize = args["bucket_size"];
  if (typeof args["domain"] === "string" && args["domain"]) opts.domain = args["domain"];
  if (typeof args["holder"] === "string" && args["holder"]) opts.holder = args["holder"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  if (takesHolders) opts.holderAllowList = takesHolders;
  const buckets = await getTakesCalibration(storage.engine(), opts);
  return jsonResult({ ok: true, buckets });
}

/**
 * On-demand fact extraction preview. Accepts raw `text` OR a `source_ref` page
 * slug (read tenant-scoped). Returns the extracted facts WITHOUT persisting;
 * PAID + default-OFF, so the {enabled:false} envelope comes back until the
 * MEMRAIN_FACTS_EXTRACTION gate is set. Cross-tenant `source_ref` is a no-op: the
 * scoped getPage returns null and the tool errors not_found.
 */
async function callExtractFacts(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  persistCtx: { writeSource?: string; canPersist?: boolean } = {},
): Promise<ToolCallResult> {
  const persist = args["persist"] === true;
  if (persist && persistCtx.canPersist !== true) {
    throw new OperationError(
      "permission_denied",
      "extract_facts: `persist` requires a write grant",
      "Call without `persist` for the preview, or use a write-scoped token.",
    );
  }
  let text = typeof args["text"] === "string" ? args["text"] : "";
  const sourceRef = typeof args["source_ref"] === "string" ? args["source_ref"] : "";
  if (!text && sourceRef) {
    const page = await getPage(
      storage,
      sourceRef,
      readSources,
    );
    if (!page) {
      throw new PageNotFoundError(
        sourceRef,
        "Pass a valid page slug in `source_ref`, or pass `text` directly.",
      );
    }
    text = page.markdown_body ?? "";
  }
  if (!text) {
    throw new OperationError(
      "invalid_params",
      "extract_facts: provide `text` or `source_ref`",
      "Pass conversation text in `text`, or a page slug in `source_ref`.",
    );
  }
  // Hints are slug-shaped steering only; the extractor sanitizes them again.
  const entityHints =
    typeof args["entity_hints"] === "string"
      ? args["entity_hints"].split(/[,\s]+/).filter(Boolean)
      : undefined;
  const visibility =
    args["visibility"] === "world" || args["visibility"] === "private"
      ? (args["visibility"] as "world" | "private")
      : undefined;
  const result = await extractFactsOnDemand(text, {
    ...(entityHints && entityHints.length ? { entityHints } : {}),
    ...(persist
      ? {
          persist: true,
          storage,
          ...(sourceRef ? { sourceSlug: sourceRef } : {}),
          ...(persistCtx.writeSource ? { sourceId: persistCtx.writeSource } : {}),
          ...(typeof args["session_id"] === "string" && args["session_id"]
            ? { sessionId: args["session_id"] }
            : {}),
          ...(visibility ? { visibility } : {}),
        }
      : {}),
  });
  return jsonResult({ ok: true, ...result });
}

function callListSkills(): ToolCallResult {
  const pack = listBrainSkillpacks();
  return jsonResult({ ok: true, ...pack });
}

function callGetSkill(args: Record<string, unknown>): ToolCallResult {
  const name = typeof args["name"] === "string" ? args["name"] : "";
  if (!name) return errResult("get_skill: `name` is required");
  const skill = getBrainSkill(name);
  if (!skill) return errResult(`get_skill: skill not found: ${name}`);
  return jsonResult({ ok: true, skill });
}

async function callGetRecentTranscripts(
  storage: Storage,
  args: Record<string, unknown>,
  redact: boolean,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  const opts: Parameters<typeof listRecentTranscripts>[1] = {};
  if (typeof args["days"] === "number") opts.days = args["days"];
  if (typeof args["summary"] === "boolean") opts.summary = args["summary"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  let transcripts = await listRecentTranscripts(storage.engine(), opts);
  // Diary fence: `journal` is a listed transcript type — a non-operator caller
  // never sees diary/journal interiority in the recent-transcripts feed.
  if (remote) transcripts = transcripts.filter((t) => !isDiaryPage(t.type, t.slug));
  // Public ingress: `content` is note body — strip it, mirroring the page_list
  // body-redaction policy (slug/type/title metadata stays).
  const out = redact ? transcripts.map((t) => ({ ...t, content: "" })) : transcripts;
  return jsonResult({ ok: true, transcripts: out });
}

// ---------------------------------------------------------------------------
// Stage-2 surface: shared helpers + the new operator/tenant tools.
// ---------------------------------------------------------------------------

/** Validate an optional ISO-8601 date/datetime arg; loud invalid_params on junk. */
function isoDateBound(
  tool: string,
  args: Record<string, unknown>,
  name: "since" | "until",
): string | undefined {
  const v = args[name];
  if (v === undefined || v === null || v === "") return undefined;
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:[T ]|$)/.test(v) ||
    Number.isNaN(Date.parse(v))
  ) {
    throw new OperationError(
      "invalid_params",
      `${tool}: \`${name}\` must be an ISO-8601 date (e.g. 2024-03-15 or 2024-03-15T10:00:00Z)`,
      `Pass \`${name}\` as an ISO date or datetime.`,
    );
  }
  return v;
}

/**
 * Map a per-call `mode` bundle onto per-call SearchOptions knobs — which win
 * over env + the active bundle in resolveSearchKnobs. Honored ONLY for the
 * operator; a tenant/public caller's mode is silently ignored (it must not
 * escalate to the paid tokenmax bundle).
 */
function applyPerCallMode(
  searchOpts: SearchOptions,
  mode: unknown,
  isOperator: boolean,
): void {
  if (!isOperator || typeof mode !== "string" || !isSearchMode(mode)) return;
  const b = MODE_BUNDLES[mode];
  // A knob the caller set explicitly (e.g. `expand`) wins over the bundle.
  if (searchOpts.expansion === undefined) searchOpts.expansion = b.expansion;
  if (searchOpts.rerank === undefined) searchOpts.rerank = b.rerank;
  if (searchOpts.graphSignals === undefined) searchOpts.graphSignals = b.graphSignals;
  if (searchOpts.cosineRescore === undefined) searchOpts.cosineRescore = b.cosineRescore;
  if (searchOpts.relationalArm === undefined) searchOpts.relationalArm = b.relationalArm;
  if (b.tokenBudget !== undefined && searchOpts.tokenBudget === undefined) {
    searchOpts.tokenBudget = b.tokenBudget;
  }
}

/** The paid ops refused up front once the caller's day is spent. */
const PAID_OPS = new Set(["think", "extract_facts", "relational_recall"]);

/**
 * Refuse a paid op from a client whose daily cap is already spent, before the
 * handler starts work it cannot finish. The spending itself is held and booked
 * per call at `trackedInvoke`; an op-level hold here as well would count the
 * same calls twice. Operator callers (no clientId) have no cap axis.
 */
async function withClientSpend(
  storage: Storage,
  authInfo: AuthInfo | undefined,
  operation: string,
  run: () => Promise<ToolCallResult>,
): Promise<ToolCallResult> {
  const clientId = authInfo?.spendId ?? authInfo?.clientId;
  if (!clientId || !PAID_OPS.has(operation)) return run();
  const check = await checkClientBudget(
    storage.engine(),
    clientId,
    new Date(),
    ...(authInfo?.budgetUsdPerDay !== undefined ? [authInfo.budgetUsdPerDay] : []),
  );
  if (!check.allowed) {
    const cap = check.capUsd;
    throw new OperationError(
      "budget_exhausted",
      `daily budget exhausted for this client (spent $${check.spentUsd.toFixed(4)}` +
        (cap !== null ? ` of $${cap.toFixed(2)}` : "") +
        ")",
      "Wait for the UTC day to roll over, or raise the client's budget_usd_per_day.",
    );
  }
  return run();
}

/** First substantive line of a synthesis answer — the take's claim text. */
function headlineClaim(answer: string): string {
  for (const raw of answer.split(/\r?\n/)) {
    const line = raw.replace(/^[#>*\-\s]+/, "").trim();
    if (line.length > 0) return line.slice(0, 500);
  }
  return "";
}

async function callThink(
  storage: Storage,
  args: Record<string, unknown>,
  ctx: {
    isOperator: boolean;
    readSources?: string[];
    writeSource?: string;
    embedQuery?: SearchOptions["embedQuery"];
  },
): Promise<ToolCallResult> {
  const question = args["question"];
  if (typeof question !== "string" || question.trim().length === 0) {
    throw new OperationError(
      "invalid_params",
      "think: `question` is required",
      "Pass a non-empty `question` string.",
    );
  }
  const anchor =
    typeof args["anchor"] === "string" && args["anchor"] ? args["anchor"] : undefined;
  // Remote callers cannot persist via MCP: save/take are
  // honored for the operator only and silently ignored otherwise.
  const safeSave = ctx.isOperator && args["save"] === true;
  const safeTake = ctx.isOperator && args["take"] === true;
  if (safeTake && !anchor) {
    throw new OperationError(
      "invalid_params",
      "think: `take` requires `anchor`",
      "Pass the anchor page slug the take should pin to.",
    );
  }
  const thinkOpts: ThinkOptions = { question };
  if (anchor) thinkOpts.anchors = [anchor];
  if (typeof args["rounds"] === "number") thinkOpts.rounds = args["rounds"] as number;
  if (typeof args["model"] === "string" && args["model"]) thinkOpts.modelId = args["model"];
  const since = isoDateBound("think", args, "since");
  const until = isoDateBound("think", args, "until");
  if (since) thinkOpts.since = since;
  if (until) thinkOpts.until = until;
  if (args["with_calibration"] === true) thinkOpts.withCalibration = true;
  if (typeof args["k"] === "number") thinkOpts.k = args["k"] as number;
  if (typeof args["max_takes"] === "number") thinkOpts.maxTakes = args["max_takes"] as number;
  if (typeof args["reference_date"] === "string") {
    // Checked here as well as in runThink so a bad date is refused on every
    // path, including the no-grant answer below that never reaches runThink.
    try {
      resolveThinkTemporalContext({ referenceDate: args["reference_date"] });
    } catch (e) {
      if (e instanceof ReferenceDateError) {
        throw new OperationError("invalid_params", `think: ${e.message}`, "Pass `reference_date` as a past or current YYYY-MM-DD day.");
      }
      throw e;
    }
    thinkOpts.referenceDate = args["reference_date"];
  }
  if (ctx.readSources !== undefined) thinkOpts.sourceIds = ctx.readSources;
  // Same diary fence as `search`: a failed compose quotes gathered pages
  // verbatim, so a non-operator must never gather life/diary/* at all.
  if (!ctx.isOperator) thinkOpts.fenceDiary = true;
  if (ctx.embedQuery) {
    thinkOpts.embedQuery = ctx.embedQuery;
    thinkOpts.embedFn = ctx.embedQuery;
  }

  // A caller granted no source has no evidence to gather; answer without
  // spending a paid synthesis call.
  if (isNoGrant(ctx.readSources)) {
    const empty: ThinkResult = {
      ran: false,
      reason: "no readable sources in this grant",
      synthesis: null,
      synthesisStatus: "no_llm",
      pagesGathered: 0,
      takesGathered: 0,
      spentUsd: 0,
      modelId: null,
      budgetExhausted: false,
    };
    return jsonResult({
      ok: true,
      ...empty,
      synthesis_status: empty.synthesisStatus,
      save_applied: false,
      take_applied: false,
    });
  }

  const result = await runThink(storage, thinkOpts);

  let saved: Awaited<ReturnType<typeof persistThinkSynthesis>> | undefined;
  if (safeSave && result.synthesis) {
    saved = await persistThinkSynthesis(storage, {
      question,
      result,
      ...(ctx.writeSource ? { sourceId: ctx.writeSource } : {}),
    });
  }
  let takeSaved: Awaited<ReturnType<typeof saveThinkTake>> | undefined;
  if (safeTake && result.synthesis) {
    const claim = headlineClaim(result.synthesis.answer);
    if (claim) {
      takeSaved = await saveThinkTake(storage.engine(), {
        claim,
        anchorSlug: anchor!,
        ...(result.modelId ? { modelId: result.modelId } : {}),
      });
    }
  }
  return jsonResult({
    ok: true,
    ...result,
    synthesis_status: result.synthesisStatus,
    save_applied: safeSave,
    take_applied: safeTake,
    ...(saved ? { saved } : {}),
    ...(takeSaved ? { take: takeSaved } : {}),
  });
}

async function callFactSupersessions(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
  readSources?: string[],
): Promise<ToolCallResult> {
  const opts: ListSupersessionsOptions = {};
  if (typeof args["entity_slug"] === "string" && args["entity_slug"]) {
    opts.entity_slug = args["entity_slug"];
  }
  if (typeof args["since"] === "string" && args["since"]) opts.since = args["since"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  const rows = await listSupersessions(storage, opts);
  const out = redact ? redactFacts(rows as unknown as Record<string, unknown>[]) : rows;
  return jsonResult({ ok: true, supersessions: out });
}

async function callPutRawData(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string" || args["slug"].length === 0) {
    return errResult("put_raw_data: `slug` is required");
  }
  if (typeof args["source"] !== "string" || args["source"].length === 0) {
    return errResult("put_raw_data: `source` is required");
  }
  if (typeof args["data"] !== "object" || args["data"] === null || Array.isArray(args["data"])) {
    return errResult("put_raw_data: `data` must be a JSON object");
  }
  try {
    const r = await putRawData(
      storage,
      args["slug"],
      args["source"],
      args["data"] as Record<string, unknown>,
      writeSource,
    );
    return jsonResult({ ok: true, ...r });
  } catch (e) {
    if (e instanceof PageNotFoundError) throw e;
    return errResult(`put_raw_data: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function callGetRawData(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  remote = false,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string" || args["slug"].length === 0) {
    return errResult("get_raw_data: `slug` is required");
  }
  // Diary fence: raw_data sidecars are page-backed. Mirror the miss (empty rows).
  if (remote && (await isRemoteDiaryFenced(storage, args["slug"], readSources))) {
    return jsonResult({ ok: true, slug: args["slug"], raw_data: [] });
  }
  const opts: Parameters<typeof getRawData>[2] = {};
  if (typeof args["source"] === "string" && args["source"]) opts.source = args["source"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  const rows = await getRawData(storage, args["slug"], opts);
  return jsonResult({ ok: true, slug: args["slug"], raw_data: rows });
}

async function callLogIngest(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
): Promise<ToolCallResult> {
  if (typeof args["source_type"] !== "string" || args["source_type"].length === 0) {
    return errResult("log_ingest: `source_type` is required");
  }
  if (typeof args["source_ref"] !== "string" || args["source_ref"].length === 0) {
    return errResult("log_ingest: `source_ref` is required");
  }
  const pages = Array.isArray(args["pages_updated"])
    ? (args["pages_updated"] as unknown[]).filter(
        (p): p is string => typeof p === "string",
      )
    : [];
  const r = await logIngest(storage.engine(), {
    source_type: args["source_type"],
    source_ref: args["source_ref"],
    pages_updated: pages,
    ...(typeof args["summary"] === "string" ? { summary: args["summary"] } : {}),
    ...(writeSource ? { source_id: writeSource } : {}),
  });
  return jsonResult({ ok: true, ...r });
}

async function callGetIngestLog(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  const opts: Parameters<typeof getIngestLog>[1] = {};
  if (typeof args["source_type"] === "string" && args["source_type"])
    opts.source_type = args["source_type"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  const entries = await getIngestLog(storage.engine(), opts);
  return jsonResult({ ok: true, entries });
}

async function callRetryJob(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["id"] !== "string" || args["id"].length === 0) {
    return errResult("retry_job: `id` is required");
  }
  const queue = new Queue(storage.engine());
  const job = await queue.retry(args["id"]);
  if (!job) {
    return jsonResult({
      ok: true,
      retried: false,
      note: "job not found or not in a retryable state (failed/cancelled)",
    });
  }
  return jsonResult({ ok: true, retried: true, job });
}

async function callGetJobProgress(
  storage: Storage,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (typeof args["id"] !== "string" || args["id"].length === 0) {
    return errResult("get_job_progress: `id` is required");
  }
  const queue = new Queue(storage.engine());
  const progress = await getJobProgress(queue, args["id"]);
  if (!progress) return errResult(`get_job_progress: ${args["id"]} not found`);
  return jsonResult({ ok: true, ...progress });
}

async function callSourcesList(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  const kindArg = typeof args["kind"] === "string" && args["kind"] ? args["kind"] : undefined;
  if (kindArg !== undefined && !(SOURCE_KINDS as readonly string[]).includes(kindArg)) {
    return errResult(`sources_list: unknown kind '${kindArg}'`);
  }
  let rows = await listSources(
    storage.engine(),
    kindArg ? { kind: kindArg as SourceKind } : {},
  );
  // A scoped caller sees only the sources its grant covers; a caller with no
  // grant (`[]`) sees an empty list.
  if (readSources !== undefined) {
    rows = rows.filter((r) => readSources.includes(r.id));
  }
  return jsonResult({ ok: true, count: rows.length, sources: rows });
}

async function callSourcesStatus(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  if (typeof args["id"] !== "string" || args["id"].length === 0) {
    return errResult("sources_status: `id` is required");
  }
  const id = args["id"];
  // Out-of-grant ids answer not_found (not permission_denied) so a scoped
  // caller cannot probe which source ids exist.
  if (readSources !== undefined && !readSources.includes(id)) {
    throw new OperationError(
      "not_found",
      `sources_status: source not found: ${id}`,
      "Pass a source id inside your grant (see sources_list).",
    );
  }
  const engine = storage.engine();
  const source = await getSource(engine, id);
  if (!source) {
    throw new OperationError(
      "not_found",
      `sources_status: source not found: ${id}`,
      "Pass a registered source id (see sources_list).",
    );
  }
  const health = (await collectPerSourceHealth(engine, [id]))[0] ?? null;
  return jsonResult({ ok: true, source, health });
}

async function callStatusSnapshot(storage: Storage): Promise<ToolCallResult> {
  const engine = storage.engine();
  const stats = await storage.stats();
  const health = await brainHealthMetrics(engine);
  const clock = await currentDocumentClock(engine);
  const cache = await cacheStats(engine, clock);
  const worker = await readWorkerLock(engine, DEFAULT_WORKER_LOCK_ID);
  return jsonResult({
    ok: true,
    schema_version: 1,
    version: VERSION,
    stats,
    health,
    cache,
    worker,
  });
}

/**
 * Thin-client doctor: the engine-only check set (no config-file / filesystem
 * checks — those are host concerns the full `memrain doctor` CLI covers).
 */
async function callRunDoctor(storage: Storage): Promise<ToolCallResult> {
  const engine = storage.engine();
  const checks: TenancyCheck[] = [];
  try {
    const stats = await storage.stats();
    checks.push({
      name: "stats",
      ok: true,
      status: "ok",
      detail: `${stats.documents} documents / ${stats.chunks} chunks / ${stats.embeddings} embeddings`,
    });
  } catch (e) {
    checks.push({
      name: "stats",
      ok: false,
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
  try {
    const health = await brainHealthMetrics(engine);
    const covPct = Math.round(health.embed_coverage_pct * 100);
    const covered =
      health.embeddable_chunks === 0 || health.embed_coverage_pct >= 0.5;
    checks.push({
      name: "embed-coverage",
      ok: covered,
      status: covered ? "ok" : "fail",
      detail: `${covPct}% (${health.embedded_chunks}/${health.embeddable_chunks} embeddable), queue ${health.queue_depth}, failed 24h ${health.failed_jobs_24h}`,
    });
  } catch (e) {
    checks.push({
      name: "embed-coverage",
      ok: false,
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
  for (const check of [
    checkFederationHealth,
    checkOauthClientHealth,
    checkOauthClientHygiene,
    checkSourceRoutingHealth,
    checkDocumentIdDrift,
  ]) {
    try {
      checks.push(await check(engine));
    } catch (e) {
      checks.push({
        name: check.name,
        ok: false,
        status: "fail",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
  for (const [name, probe] of [
    ["stale-locks", checkStaleLocks],
    ["queue-health", checkQueueHealth],
    ["schema-version", checkSchemaVersion],
    ["embedding-width", checkEmbeddingWidth],
    ["invalid-indexes", checkInvalidIndexes],
    ["connector-health", checkConnectorHealth],
  ] as const) {
    try {
      const r = await probe(engine);
      checks.push({ name, ok: r.ok, status: r.status, detail: r.detail });
    } catch (e) {
      // A probe that threw is a `warn`, not a pass — the same contract the CLI
      // doctor follows. It stays ok:true so one unreadable probe can't make an
      // otherwise-serving brain look broken to the agent.
      checks.push(couldNotCheck(name, e));
    }
  }
  try {
    const worker = await readWorkerLock(engine, DEFAULT_WORKER_LOCK_ID);
    checks.push(
      worker === null
        ? {
            name: "job-worker",
            ok: true,
            status: "ok",
            detail: "no worker has held the lock yet",
          }
        : {
            name: "job-worker",
            ok: !worker.stale,
            status: worker.stale ? "fail" : "ok",
            detail: worker.stale
              ? `lock holder '${worker.holder}' heartbeat is stale (${worker.staleMs}ms)`
              : `held by '${worker.holder}', heartbeat fresh`,
          },
    );
  } catch (e) {
    checks.push({
      name: "job-worker",
      ok: false,
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
  return jsonResult({
    ok: checks.every((c) => c.ok),
    status: worstStatus(checks.map((c) => c.status)),
    checks,
  });
}

// ---------------------------------------------------------------------------
// Life Chronicle tools — timeline reads + per-entity dimensional ontology.
// The whole surface is internal-only (FORBIDDEN_MCP_TOOLS_FROM_PUBLIC). Every
// chronicle read REQUIRES an explicit tenant scope (the core refuses an empty
// scope by design); `resolveChronicleScope` resolves the unscoped operator to
// the whole-brain source set so a legitimate operator read never trips that
// guard while a scoped tenant stays confined to its grant. The ontology reads
// additionally strip diary-sourced + private rows for non-operator callers.
// ---------------------------------------------------------------------------

/**
 * Resolve the concrete source scope for a chronicle read. A scoped caller keeps
 * its grant, and a caller with no grant reads nothing (`[]` becomes the
 * sentinel, which the chronicle readers match against no source). The
 * unscoped operator gets every known source id (union of pages + entity_facts),
 * so a whole-brain read is deliberate — never an accidental blanket sweep.
 */
async function resolveChronicleScope(
  storage: Storage,
  readSources: string[] | undefined,
  remote: boolean,
): Promise<string[]> {
  if (readSources !== undefined) return readSources.length ? readSources : [NO_SOURCE_SENTINEL];
  // A remote (public bearer / OAuth tenant) caller that resolved to NO scope
  // must FAIL CLOSED — whole-brain expansion is the operator's privilege alone.
  // A grantless authed token reads nothing (sentinel matches no row), never the
  // entire corpus.
  if (remote) return [NO_SOURCE_SENTINEL];
  const r = await storage.engine().query<{ source_id: string }>(
    `SELECT source_id FROM pages WHERE source_id IS NOT NULL
     UNION
     SELECT source_id FROM entity_facts WHERE source_id IS NOT NULL`,
  );
  const ids = r.rows.map((row) => row.source_id).filter(Boolean);
  return ids.length ? ids : [NO_SOURCE_SENTINEL];
}

/** Require a strict YYYY-MM-DD calendar date; loud invalid_params on junk. */
function chronicleDate(v: unknown, tool: string, field: string): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new OperationError(
      "invalid_params",
      `${tool}: \`${field}\` must be a YYYY-MM-DD date`,
      `Pass \`${field}\` as a calendar date, e.g. 2026-07-12.`,
    );
  }
  return v;
}

/** True when an ontology row is diary-sourced (privacy redaction target). */
function isDiarySourced(sourceSlug: string | null | undefined): boolean {
  return (sourceSlug ?? "").startsWith("life/diary/");
}

/** True when a page slug is diary interiority (slug-prefix only — the cheap
 *  fence for slug-emitting graph/backlink reads; no scoped type lookup). */
function isDiarySlug(slug: string | null | undefined): boolean {
  return typeof slug === "string" && slug.startsWith("life/diary/");
}

async function callChronicleDay(
  storage: Storage,
  args: Record<string, unknown>,
  readSources: string[] | undefined,
  remote: boolean,
): Promise<ToolCallResult> {
  const date = chronicleDate(args["date"], "chronicle_day", "date");
  const scope = await resolveChronicleScope(storage, readSources, remote);
  const opts: ChronicleTimelineOpts = { sourceIds: scope };
  // Non-operator callers never see life/diary/* projections (SQL-level).
  if (remote) opts.excludeDiary = true;
  if (args["week"] === true) opts.week = true;
  if (typeof args["kind"] === "string" && args["kind"]) opts.kind = args["kind"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  const events = await getTimelineForDate(storage, date, opts);
  const payload: Record<string, unknown> = { ok: true, date, events };
  if (args["narrative"] === true) payload.narrative = renderTimelineNarrative(events);
  return jsonResult(payload);
}

async function callChronicleSince(
  storage: Storage,
  args: Record<string, unknown>,
  readSources: string[] | undefined,
  remote: boolean,
): Promise<ToolCallResult> {
  const since = chronicleDate(args["since"], "chronicle_since", "since");
  const scope = await resolveChronicleScope(storage, readSources, remote);
  const opts: ChronicleTimelineOpts = { sourceIds: scope };
  if (remote) opts.excludeDiary = true;
  if (typeof args["kind"] === "string" && args["kind"]) opts.kind = args["kind"];
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  const events = await getSince(storage, since, opts);
  return jsonResult({ ok: true, since, events });
}

async function callChronicleOnThisDay(
  storage: Storage,
  args: Record<string, unknown>,
  readSources: string[] | undefined,
  remote: boolean,
): Promise<ToolCallResult> {
  // `date` defaults to today (UTC) when omitted.
  const date =
    args["date"] === undefined
      ? new Date().toISOString().slice(0, 10)
      : chronicleDate(args["date"], "chronicle_on_this_day", "date");
  const scope = await resolveChronicleScope(storage, readSources, remote);
  const opts: ChronicleTimelineOpts = { sourceIds: scope };
  if (remote) opts.excludeDiary = true;
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  const events = await getOnThisDay(storage, date, opts);
  return jsonResult({ ok: true, date, events });
}

async function callChronicleLastSeen(
  storage: Storage,
  args: Record<string, unknown>,
  readSources: string[] | undefined,
  remote: boolean,
): Promise<ToolCallResult> {
  if (typeof args["entity"] !== "string" || args["entity"].length === 0) {
    return errResult("chronicle_last_seen: `entity` is required");
  }
  const scope = await resolveChronicleScope(storage, readSources, remote);
  const result = await getLastSeen(storage, args["entity"], {
    sourceIds: scope,
    ...(remote ? { excludeDiary: true } : {}),
  });
  return jsonResult({ ok: true, ...result });
}

async function callOntologyGet(
  storage: Storage,
  args: Record<string, unknown>,
  readSources: string[] | undefined,
  remote: boolean,
): Promise<ToolCallResult> {
  if (typeof args["entity"] !== "string" || args["entity"].length === 0) {
    return errResult("ontology_get: `entity` is required");
  }
  const scope = await resolveChronicleScope(storage, readSources, remote);
  const opts: OntologyReadOpts = { sourceIds: scope };
  // Validate before the value reaches getOntology's `::date` cast — a junk
  // string must fail as clean invalid_params, not a Postgres cast 500.
  if (args["asof"] !== undefined && args["asof"] !== null && args["asof"] !== "") {
    opts.asof = chronicleDate(args["asof"], "ontology_get", "asof");
  }
  if (typeof args["min_confidence"] === "number") opts.minConfidence = args["min_confidence"];
  if (args["include_quarantined"] === true) opts.includeQuarantined = true;
  // Non-operator callers: restrict to world-visible rows (private never
  // fetched) AND drop any diary-sourced value on top.
  if (remote) opts.worldOnly = true;
  let values: OntologyValue[] = await getOntology(storage, args["entity"], opts);
  if (remote) values = values.filter((v) => !isDiarySourced(v.source_slug));
  return jsonResult({ ok: true, entity: args["entity"], ontology: values });
}

async function callOntologyPropose(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
): Promise<ToolCallResult> {
  if (typeof args["entity"] !== "string" || args["entity"].length === 0) {
    return errResult("ontology_propose: `entity` is required");
  }
  if (typeof args["dimension"] !== "string" || args["dimension"].length === 0) {
    return errResult("ontology_propose: `dimension` is required");
  }
  if (typeof args["value"] !== "string" || args["value"].length === 0) {
    return errResult("ontology_propose: `value` is required");
  }
  // The fail-closed write gate already rejects a scopeless authenticated public
  // principal; the unscoped operator writes to the 'default' tenant (matching
  // the page/fact write default).
  const obs: OntologyObservationInput & { sourceId: string } = {
    entitySlug: args["entity"],
    dimension: args["dimension"],
    value: args["value"],
    sourceId: writeSource ?? "default",
  };
  if (typeof args["source"] === "string" && args["source"]) obs.source_slug = args["source"];
  if (typeof args["confidence"] === "number") obs.confidence = args["confidence"];
  // Validate before the value reaches mergeOntologyFact's `::date` cast.
  if (args["valid_from"] !== undefined && args["valid_from"] !== null && args["valid_from"] !== "") {
    obs.validFrom = chronicleDate(args["valid_from"], "ontology_propose", "valid_from");
  }
  if (args["visibility"] === "private" || args["visibility"] === "world") {
    obs.visibility = args["visibility"];
  }
  const r = await mergeOntologyFact(storage, obs);
  return jsonResult({ ok: true, ...r });
}

async function callOntologyDimensions(
  storage: Storage,
  readSources: string[] | undefined,
  remote: boolean,
): Promise<ToolCallResult> {
  const scope = await resolveChronicleScope(storage, readSources, remote);
  // Non-operator callers count only world-visible rows, so a diary-only or
  // private-only axis never surfaces in the dimension list.
  const dimensions = await discoverOntologyDimensions(storage, {
    sourceIds: scope,
    ...(remote ? { worldOnly: true } : {}),
  });
  return jsonResult({ ok: true, dimensions });
}

async function callOntologyConflicts(
  storage: Storage,
  args: Record<string, unknown>,
  readSources: string[] | undefined,
  remote: boolean,
): Promise<ToolCallResult> {
  const scope = await resolveChronicleScope(storage, readSources, remote);
  const opts: { sourceIds: string[]; minConfidence?: number; worldOnly?: boolean } = {
    sourceIds: scope,
  };
  if (typeof args["min_confidence"] === "number") opts.minConfidence = args["min_confidence"];
  // Non-operator callers: only world-visible observations enter the conflict
  // detection at all, so a private value never reaches the caller (the diary
  // post-strip below is the second, source-slug-based layer).
  if (remote) opts.worldOnly = true;
  let conflicts: OntologyConflict[] = await findOntologyConflicts(storage, opts);
  if (remote) {
    // Strip diary-sourced values, then re-apply the SAME disagreement predicate
    // findOntologyConflicts uses (>=2 distinct values AND >=2 distinct sources).
    // A conflict that degenerates on either axis after stripping is dropped — a
    // survivor would leak that a diary value existed (hard security requirement).
    conflicts = conflicts
      .map((c) => ({
        ...c,
        values: c.values.filter((v) => !isDiarySourced(v.source_slug)),
      }))
      .filter(
        (c) =>
          new Set(c.values.map((v) => v.value)).size >= 2 &&
          new Set(c.values.map((v) => v.source_slug)).size >= 2,
      );
  }
  return jsonResult({ ok: true, conflicts });
}

async function callVolunteerChronicle(
  storage: Storage,
  args: Record<string, unknown>,
  readSources: string[] | undefined,
  remote: boolean,
): Promise<ToolCallResult> {
  const scope = await resolveChronicleScope(storage, readSources, remote);
  // `entities` accepts a string array or a comma/space-separated string.
  const raw = args["entities"];
  const entities = Array.isArray(raw)
    ? raw.filter((e): e is string => typeof e === "string" && e.length > 0)
    : typeof raw === "string"
      ? raw.split(/[,\s]+/).filter(Boolean)
      : [];
  const opts: Parameters<typeof loadChronicleContext>[1] = {
    sourceIds: scope,
    remote,
  };
  if (typeof args["days"] === "number") opts.days = args["days"];
  if (entities.length) opts.entities = entities;
  const context = await loadChronicleContext(storage, opts);
  return jsonResult({ ok: true, ...context });
}

/**
 * Operator maintenance sweep: enqueue a `chronicle_extract` job per eligible
 * conversation-shape page in scope. `dry_run` counts only. Per-page enqueue
 * errors are collected (never swallowed, never abort the sweep). Operator-only
 * (see OPERATOR_ONLY_TOOLS) — reached with an unscoped whole-brain listing.
 */
async function callChronicleBackfill(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
): Promise<ToolCallResult> {
  const dryRun = args["dry_run"] === true;
  // Cost guardrail: default 100, hard cap 500 — one paid extraction per eligible
  // page, so the sweep's worst-case spend must be operator-legible.
  const requested = typeof args["limit"] === "number" ? Math.floor(args["limit"]) : 100;
  const limit = Math.min(Math.max(requested, 1), 500);
  const perPageBudgetUsd = chronicleWriteBudgetUsd();
  const listOpts: Parameters<typeof listPages>[1] = { limit };
  if (readSources !== undefined) listOpts.sourceIds = readSources;
  const pages = await listPages(storage, listOpts);
  const eligible = pages.filter(
    (p) =>
      isChronicleEligible({
        type: p.type,
        slug: p.slug,
        body: p.markdown_body,
      }).ok,
  );
  // Worst-case spend the operator can multiply out before a real run.
  const budget = {
    per_page_budget_usd: perPageBudgetUsd,
    per_page_budget_env: "MEMRAIN_CHRONICLE_WRITE_BUDGET_USD",
  };
  if (dryRun) {
    return jsonResult({
      ok: true,
      dry_run: true,
      scanned: pages.length,
      eligible: eligible.length,
      pages_enqueued: 0,
      ...budget,
    });
  }
  const queue = new Queue(storage.engine());
  const errors: { slug: string; error: string }[] = [];
  let pagesEnqueued = 0;
  for (const p of eligible) {
    const sourceId = p.source_id ?? "default";
    try {
      await queue.enqueue({
        kind: "chronicle_extract",
        payload: { slug: p.slug, sourceId },
        id: chronicleJobId(sourceId, p.slug, p.content_hash),
        timeoutMs: 600_000,
      });
      pagesEnqueued++;
    } catch (e) {
      errors.push({ slug: p.slug, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return jsonResult({
    ok: true,
    dry_run: false,
    scanned: pages.length,
    eligible: eligible.length,
    pages_enqueued: pagesEnqueued,
    ...budget,
    ...(errors.length ? { errors } : {}),
  });
}

/** Per-page USD ceiling one chronicle extraction can spend (report-only here;
 *  the extractor enforces it). Mirrors the extractor's default. */
function chronicleWriteBudgetUsd(): number {
  const raw = (process.env["MEMRAIN_CHRONICLE_WRITE_BUDGET_USD"] ?? "").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0.05;
}
