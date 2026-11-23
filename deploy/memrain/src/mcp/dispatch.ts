/**
 * MCP tool dispatcher — turns a `tools/call` request body into a call
 * against existing core functions. Returns MCP-shaped content blocks
 * (`{ type: "text", text: "..." }`).
 *
 * Error handling: any thrown error becomes an `isError: true` result
 * (per MCP spec) instead of a JSON-RPC error envelope. JSON-RPC errors
 * are reserved for protocol-level failures (malformed request etc.).
 */
import { andSourceScope } from "../core/source-scope.ts";
import { pageBodyWindow } from "../core/page-window.ts";
import { oversizedResultError } from "../core/result-size.ts";
import { posix } from "node:path";
import type { Storage } from "../core/storage.ts";
import {
  type AuthInfo,
  effectiveReadSourceIdsForIngress,
  effectiveWriteSourceIdForIngress,
  tenantFailClosedEnabled,
  isNoSourceSentinel,
} from "../core/auth-info.ts";
import { hybridSearch, type SearchOptions } from "../core/search/hybrid.ts";
import { applyTokenBudget } from "../core/search/token-budget.ts";
import { frameMarkedContent, markChunkTrust, markExternalChunks } from "../core/trust-frame.ts";
import { principalTier, type TrustTier } from "../core/trust-tier.ts";
import { publicSearchMeta, type SearchMeta } from "../core/search/search-meta.ts";
import { resolveDateBoundary, validatePageFilters, type PageFilters } from "../core/search/filters.ts";
import { indexDocument, indexFile } from "../core/indexer.ts";
import { findBacklinks } from "../core/backlinks.ts";
import { TEXT_ENTITY_TYPES, type EntityType } from "../core/entities.ts";
import { collectPerSourceHealth } from "../core/source-health.ts";
import {
  isWithinAllowedRoot,
  loadAllowedRootSpellings,
  PathGuardConfigError,
} from "../core/path_guard.ts";
import {
  putPage,
  listPagesPage,
  appendPage,
  deletePage,
  renamePage,
  restorePage,
  revertPage,
  getPage,
  getPageExact,
  type listPages,
  pageVersions,
  validateSlug,
  KNOWN_PAGE_TYPES,
  isDiarySourcePath,
  type PageInput,
} from "../core/pages.ts";
import type { Engine } from "../core/engine/interface.ts";
import { isExcludedOrphanWriter } from "../core/orphan-policy.ts";
import { addLink, removeLink, syncWikilinksForPage, slugifyTarget } from "../core/links.ts";
import { bumpLastRetrievedAt } from "../core/last-retrieved.ts";
import { mirrorPage, mirrorPageVerdict, removePageFromSearch, isPageSourcePath } from "../core/page-index.ts";
import { applyQuarantineVisibility, quarantineContent, redactQuarantinePage } from "./quarantine-read.ts";
import { type QuarantineVerdict, readQuarantineVerdict } from "../core/quarantine.ts";
import { outputRedactionEnabled, redactToolResult } from "../core/output-redaction.ts";
import { capHitSnippets, searchSnippetChars } from "../core/search/snippet-cap.ts";
import { allowedFingerprints } from "../core/secret-scan.ts";
import { getChunksForPage, getChunksForSource } from "../core/chunks-read.ts";
import { resolveSlugs, slugReferenceCounts } from "../core/slug-resolve.ts";
import { searchExact } from "../core/search/exact.ts";
import { addTag, removeTag, getTags } from "../core/tags.ts";
import { getLinksPage } from "../core/links-read.ts";
import { brainIdentity } from "../core/identity.ts";
import { purgeDeletedPages } from "../core/pages-purge.ts";
import { pageEditResponse, parsePageEdits } from "../core/page-edit.ts";
import { isPublicMcpToolForbidden } from "../http/public_guard.ts";
import { federatedReadScope, listSources, getSource, resolveSourceForPath, SOURCE_KINDS, type SourceKind } from "../core/sources.ts";
import { runLiteDoctor } from "../core/lite-doctor.ts";
import { checkClientBudget, runWithSpendClient } from "../core/budget.ts";
// Public-ingress body redaction is shared with the REST routes via a
// neutral core module so neither ingress layer imports the other (an
// http/ import here created a module cycle).
import {
  redactBodies,
  redactBody,
  redactBacklinks,
  publicReadBodiesAllowed,
  publicSafeErrorMessage,
} from "../core/public_redaction.ts";
import { databaseOperationError } from "../core/database-error.ts";
import { OperationError, PageNotFoundError, isOperationError } from "../core/operation-error.ts";
import { suggestSlugs } from "../core/slug-suggest.ts";
import { MAX_REQUEST_ID_LEN, OPERATIONS, normalizeOptionalArgs, validateParams } from "./operations.ts";
import {
  claimWriteRequest,
  completeWriteRequest,
  releaseWriteRequest,
  writeRequestArgsHash,
  type WriteRequestKey,
} from "../core/write-requests.ts";
import { hasScope } from "../core/scope.ts";
import { insufficientScopeChallenge } from "../http/oauth-metadata.ts";
import { dispatchRefusal, forcedSurfaceRefusal, SLUG_PARAMS_BY_WRITE_TOOL, visibleToolDefs } from "./visibility.ts";
import { narrowReadSources, readsFederatedScope } from "./read-source-filter.ts";
import { OPERATOR_ACCESS, resolveCallerAccess, type CallerAccess } from "../core/caller-access.ts";
import { assertRequesterScope, requesterScopeState } from "../core/requester-scope.ts";
import { fenceOwnerOnlyHits, narrowOwnerOnlyScope, ownerOnlyPageSlugs } from "../core/owner-only.ts";

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
  /** MCP `_meta` — out-of-band data attached to a result. */
  _meta?: Record<string, unknown>;
}

const VALID_ENTITY_TYPES: ReadonlySet<EntityType> = new Set(TEXT_ENTITY_TYPES);

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
   * Query-embedder injection for `search`, forwarded verbatim to
   * `SearchOptions.embedQuery`. Set only by hermetic tests, so the vector arm
   * runs on deterministic vectors instead of Bedrock.
   */
  embedQuery?: SearchOptions["embedQuery"];
  /** This server's OAuth issuer, named in the step-up challenge a scope
   *  refusal carries so the client can find the authorization server. */
  issuer?: string;
  /** Set by the admin panel route and the read-only access audit: the
   *  operator's own browsing leaves no retrieval touch on page_get. Transports never set it. */
  adminPanel?: boolean;
  /** The admin panel request's own abort signal: a search the browser dropped skips its query embed. */
  signal?: AbortSignal;
  /** Set by the /mcp transport only: the operator's MEMRAIN_MCP_FORCE_SURFACE applies to this call. */
  mcpIngress?: boolean;
}

/**
 * Public entry: dispatch the tool call under the calling client's spend
 * scope, then redact a non-operator's retrieval results.
 */
export async function dispatchTool(
  storage: Storage,
  req: ToolCallRequest,
  opts: DispatchOptions = {},
): Promise<ToolCallResult> {
  // Every paid Bedrock call inside this dispatch (the query and page embeds)
  // books against the calling client.
  const auth = opts.authInfo;
  const spendClient = auth
    ? {
        clientId: auth.spendId ?? auth.clientId,
        ...(auth.budgetUsdPerDay !== undefined ? { capUsd: auth.budgetUsdPerDay } : {}),
      }
    : null;
  const dispatched = await runWithSpendClient(spendClient, () => dispatchToolInner(storage, req, opts));
  const enriched = withPageAdminUrl(req, dispatched, opts);
  // The operator reads stored text as it is; everyone else gets retrieval
  // results scanned for credentials that predate (or slipped past) the write scan.
  const isOperator = opts.authInfo === undefined && !(opts.isPublic ?? false);
  const result =
    !isOperator && OP_BY_NAME.get(req.name)?.outputRedaction === "retrieval" && outputRedactionEnabled()
      ? redactToolResult(enriched, allowedFingerprints())
      : enriched;
  return boundedResult(req.name, result, opts.isPublic ?? false);
}

async function dispatchToolInner(
  storage: Storage,
  req: ToolCallRequest,
  opts: DispatchOptions = {},
): Promise<ToolCallResult> {
  const originalArgs = req.arguments ?? {};
  const operation = OP_BY_NAME.get(req.name);
  const args = operation ? normalizeOptionalArgs(operation, originalArgs) : originalArgs;
  // Mirror the REST layer's public-read policy exactly: redact bodies on
  // public ingress unless the operator opted into MEMRAIN_PUBLIC_READ_BODIES.
  const redact =
    (opts.isPublic ?? false) && !publicReadBodiesAllowed();
  // The caller's tenant grant: read scope (union of allowed sources) + the
  // single write source. Undefined when no authInfo → unscoped whole-brain
  // (local CLI / internal token), preserving single-tenant behavior.
  let grantedReadSources = effectiveReadSourceIdsForIngress(opts.authInfo, {
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
  const isOperator = opts.authInfo === undefined && !(opts.isPublic ?? false);
  // A credential bound to the brain owner reads as the owner (owner-only
  // sources and diary pages), so it is not `remote`. Until the access settings
  // are read, every authenticated caller counts as remote (fail closed).
  let remote = (opts.isPublic ?? false) || opts.authInfo !== undefined;
  let access: CallerAccess = OPERATOR_ACCESS;
  // Content safety (quarantine withholding, outside-text framing) keys on the
  // ingress, not on what the caller may read: the owner's agent is still an agent.
  const untrusted = (opts.isPublic ?? false) || opts.authInfo !== undefined;
  try {
    if (req.name === "search") opts.signal?.throwIfAborted();
    // A malformed or out-of-grant source_ids is refused before anything is read.
    narrowReadSources(req.name, args, grantedReadSources);
    access = await resolveCallerAccess(() => storage.engine(), opts.authInfo, opts.isPublic ?? false);
    assertRequesterScope(OP_BY_NAME.get(req.name), req.name, opts.authInfo, opts.isPublic ?? false, access.brain);
    if (access.owner) remote = false;
    // A grant that names no source: an unqualified read then reaches only the
    // default and federated sources. A grant that lists sources keeps them all.
    const unscopedGrant = grantedReadSources === undefined;
    grantedReadSources = narrowOwnerOnlyScope(grantedReadSources, access.brain, remote);
    // Tool-level gates, in order: the fail-closed write gate, operator-only
    // tools for any authenticated principal, the per-op OAuth scope, a
    // slug-bound client's deny-by-default on write ops that name no slug, and
    // a narrowed tool surface. The static bearer and trusted-local path
    // (`authInfo === undefined`) are the operator and pass all of them.
    // tools/list asks the same predicate (mcp/visibility.ts), so a listed tool
    // is never refused here.
    const refusal = (opts.mcpIngress === true ? forcedSurfaceRefusal(req.name) : null) ?? dispatchRefusal(req.name, opts.authInfo);
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
        "Use sources_status for per-source health.",
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
    if (refusal?.kind === "credential_unsupported") {
      throw new OperationError(
        "permission_denied",
        "credential_unsupported: this credential carries a read floor (min_trust), which this brain does not enforce",
        "Ask the brain owner for a credential without a minimum trust tier.",
      );
    }
    if (refusal?.kind === "tool_surface" && refusal.forced) {
      throw new OperationError(
        "permission_denied",
        `tool '${req.name}' is not on the '${refusal.surface}' tool surface`,
        `The brain operator has narrowed every connection to the '${refusal.surface}' surface for now; use a tool on it.`,
      );
    }
    if (refusal?.kind === "tool_surface") {
      throw new OperationError(
        "permission_denied",
        `tool '${req.name}' is not on this credential's '${refusal.surface}' tool surface`,
        "Ask the brain owner to widen this credential's tool surface in admin → Credentials.",
      );
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
    // to the switch default.
    const op = OP_BY_NAME.get(req.name);
    if (op) validateParams(op, args);
    let readSources = narrowReadSources(req.name, args, grantedReadSources);
    if (unscopedGrant && readsFederatedScope(req.name, args)) {
      readSources = await federatedReadScope(storage.engine(), readSources);
    }
    // Per-client slug-prefix write fence (oauth_clients.bound_slug_prefixes):
    // a bound principal may mutate only slugs under its prefixes. Deny-by-
    // default — a write/admin op that names no slug is refused for bound
    // clients, so a new write tool can never bypass the fence by omission.
    const boundPrefixes = opts.authInfo?.boundSlugPrefixes;
    if (
      boundPrefixes &&
      boundPrefixes.length > 0 &&
      (op?.scope === "write" || op?.scope === "admin")
    ) {
      enforceSlugPrefixFence(req.name, args, boundPrefixes);
    }
    switch (req.name) {
      case "search_exact": {
        const result = await searchExact(storage, args["phrase"] as string, {
          caseSensitive: args["case_sensitive"] === true,
          slugPrefix: typeof args["slug_prefix"] === "string" ? args["slug_prefix"] : undefined,
          type: typeof args["type"] === "string" ? args["type"] : undefined,
          limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
          sourceIds: readSources, excludeDiary: remote,
        });
        const closed = remote ? await ownerOnlyPageSlugs(storage.engine(), result.hits.map((h) => h.slug)) : new Set<string>();
        const open = closed.size > 0 ? result.hits.filter((h) => !closed.has(h.slug)) : result.hits;
        const hits = redact ? open.map(({ snippet: _snippet, ...hit }) => hit) : open;
        return jsonResult({ ok: true, ...result, hits,
          ...(!result.complete ? { hint: "Narrow slug_prefix or type, or increase limit (up to 200), before claiming all matches were returned." } : {}),
        });
      }
      case "search":
        return await callSearch(storage, args, { redact, readSources, isOperator, remote, embedQuery: opts.embedQuery, signal: opts.signal });
      case "index":
        return await callIndex(storage, args, writeSource, isOperator, principalTier(writerPrincipal(opts)));
      case "backlinks":
        return await callBacklinks(storage, args, redact, readSources, remote);
      case "stats":
        return await callStats(storage);
      case "page_put":
        return await withWriteRequest(storage, req.name, args, writeRequestPrincipal(opts, writeSource), (receipt) =>
          callPagePut(
            storage,
            args,
            writeSource,
            opts.isPublic ?? false,
            remoteWriterIdentity(opts),
            receipt,
            writerPrincipal(opts),
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
            writerPrincipal(opts),
          ),
        );
      case "page_edit":
        requireOwnWriteSource(req.name, opts.authInfo, writeSource);
        return await withWriteRequest(storage, req.name, args, writeRequestPrincipal(opts, writeSource), (receipt) =>
          callPageEdit(storage, args, {
            writeSource,
            isPublic: opts.isPublic ?? false,
            redact,
            remote,
            readSources,
            remoteIdentity: remoteWriterIdentity(opts),
            principal: writerPrincipal(opts),
            receipt,
          }),
        );
      case "page_rename": {
        requireOwnWriteSource(req.name, opts.authInfo, writeSource);
        const result = await renamePage(storage, args["from"] as string, args["to"] as string, {
          expectedVersion: args["expected_version"] as number,
          source_id: writeSource,
          written_by: remoteWriterIdentity(opts) ?? "page_rename",
          writtenByPrincipal: writerPrincipal(opts),
          manual: true,
          excludeDiary: remote,
        });
        return jsonResult({ ok: result.renamed, ...result });
      }
      case "page_delete":
        return await callPageDelete(storage, args, writeSource, writerPrincipal(opts));
      case "page_restore":
        return await callPageRestore(storage, args, writeSource, opts.isPublic ?? false, writerPrincipal(opts));
      case "page_revert":
        return await callPageRevert(storage, args, writeSource, opts.isPublic ?? false, writerPrincipal(opts));
      case "page_get":
        return await callPageGet(storage, args, redact, readSources, remote, seesPrincipal(opts), opts.adminPanel !== true,
          !(opts.adminPanel === true && isOperator), untrusted);
      case "page_list":
        return await callPageList(storage, args, redact, readSources, remote, untrusted);
      case "page_versions":
        return await callPageVersions(storage, args, redact, readSources, remote, seesPrincipal(opts), opts.isPublic === true, untrusted);
      case "link":
        return await callLink(storage, args, writeSource);
      case "unlink":
        return await callUnlink(storage, args, writeSource);
      case "get_chunks":
        return await callGetChunks(storage, args, readSources, remote);
      case "resolve_slugs":
        return await callResolveSlugs(storage, args, readSources, remote, redact);
      case "add_tag":
        return await callAddTag(storage, args, writeSource);
      case "remove_tag":
        return await callRemoveTag(storage, args, writeSource);
      case "get_tags":
        return await callGetTags(storage, args, readSources);
      case "get_links":
        return await callGetLinks(storage, args, readSources, remote);
      case "get_brain_identity":
        return await callGetBrainIdentity(storage, readSources);
      case "whoami":
        return await callWhoami(storage, opts.authInfo, readSources, opts.isPublic ?? false, access);
      case "purge_deleted_pages":
        requireOwnWriteSource(req.name, opts.authInfo, writeSource);
        return await callPurgeDeletedPages(storage, args, writeSource);
      case "sources_list":
        return await callSourcesList(storage, args, readSources);
      case "sources_status":
        return await callSourcesStatus(storage, args, readSources);
      case "run_doctor":
        return jsonResult(await runLiteDoctor(storage));
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
        readSources: grantedReadSources,
        writeSource,
        remote,
      });
      return errResult(JSON.stringify(withHint.toEnvelope(opts.isPublic ?? false)));
    }
    if (isOperationError(e)) {
      return errResult(JSON.stringify(e.toEnvelope(opts.isPublic ?? false)));
    }
    const withhold = opts.isPublic ?? false;
    const databaseError = databaseOperationError(e);
    if (databaseError) return errResult(JSON.stringify(databaseError.toEnvelope(withhold)));
    // A raw exception (Postgres schema, DSN host, stack internals) must NOT
    // leak across the public boundary; fully redact it there, log server-side.
    return errResult(publicSafeErrorMessage(e, withhold));
  }
}

async function callSearch(
  storage: Storage,
  args: Record<string, unknown>,
  ctx: {
    redact: boolean;
    readSources: string[] | undefined;
    isOperator: boolean;
    remote: boolean;
    embedQuery: SearchOptions["embedQuery"] | undefined;
    signal: AbortSignal | undefined;
  },
): Promise<ToolCallResult> {
  const { redact, readSources, isOperator, remote } = ctx;
  const q = args["q"];
  if (typeof q !== "string" || q.length === 0) {
    throw new OperationError(
      "invalid_params",
      "search: `q` is required",
      "Pass a non-empty `q` string.",
    );
  }
  const k = typeof args["k"] === "number" ? args["k"] : 20;
  const offset =
    typeof args["offset"] === "number"
      ? Math.max(0, Math.floor(args["offset"]))
      : 0;
  const searchOpts: SearchOptions = { k: k + offset };
  if (typeof args["token_budget"] === "number") searchOpts.tokenBudget = args["token_budget"];
  if (readSources !== undefined) searchOpts.sourceIds = readSources;
  if (ctx.signal) searchOpts.signal = ctx.signal;
  if (ctx.embedQuery) searchOpts.embedQuery = ctx.embedQuery;
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
    return resolveDateBoundary(v, name);
  };
  const pageFilters = searchPageFilters(args);
  Object.assign(searchOpts, pageFilters);
  const typeNotice = await pageTypeNotice(storage, pageFilters, readSources, !isOperator);
  const since = dateBound("since");
  const until = dateBound("until");
  if (since) searchOpts.since = since;
  if (until) searchOpts.until = until;
  let meta: SearchMeta | undefined;
  searchOpts.onMeta = (m) => {
    meta = m;
  };
  const hitsAll = await hybridSearch(storage, q, searchOpts);
  const hitsOffset = offset > 0 ? hitsAll.slice(offset) : hitsAll;
  // Diary and owner-only fences: a non-operator caller never receives a
  // life/diary/* page's chunks or a page derived from an owner-only source.
  const hits = await fenceOwnerOnlyHits(storage.engine(), fenceDiaryHits(hitsOffset, !remote), remote);
  // Public ingress: drop page-derived mirror hits entirely. A page slug
  // (`page://people/<name>`) and title are author-written identifiers — the
  // exact PII the redaction layer suppresses — and search is a free-text
  // enumeration surface.
  const visible = redact
    ? (hits as unknown as Record<string, unknown>[]).filter(
        (h) =>
          !(
            typeof h["sourcePath"] === "string" &&
            isPageSourcePath(h["sourcePath"])
          ),
      )
    : hits;
  const snippets = capHitSnippets(
    (redact
      ? redactBodies(visible as unknown as Record<string, unknown>[])
      : visible) as Array<{ chunkId: string; content: string; sourcePath: string }>,
    searchSnippetChars(),
    readSources,
  );
  const out = redact ? snippets : await frameSearchHits(storage, snippets, readSources, searchOpts.tokenBudget);
  if (meta && out.length < snippets.length) meta = { ...meta, degraded: [...new Set([...meta.degraded, "budget_truncated" as const])] };
  // Non-operators see corpus-independent reason codes only: counts are an
  // existence oracle even when bodies are opted in.
  const metaOut = responseSearchMeta(meta, out.length, isOperator);
  const metaField = metaOut ? { meta: metaOut } : {};
  if (out.length === 0) {
    return jsonResult({ ok: true, hits: out, ...emptyRetrievalHint(readSources, metaOut), ...metaField, ...typeNotice });
  }
  return jsonResult({ ok: true, hits: out, ...metaField, ...typeNotice });
}

/**
 * The `meta` block search returns. The operator gets the full meta with
 * `returned` re-counted after the offset and fences; everyone else gets the
 * corpus-independent form.
 */
function responseSearchMeta(
  meta: SearchMeta | undefined,
  returned: number,
  isOperator: boolean,
): SearchMeta | ReturnType<typeof publicSearchMeta> | undefined {
  if (!meta) return undefined;
  if (!isOperator) return publicSearchMeta(meta);
  return { ...meta, returned };
}

/** Stamp and frame chunks from outside text, then apply the token budget. */
async function frameSearchHits<T extends { chunkId: string; content: string; title?: string | null }>(
  storage: Storage, hits: readonly T[], readSources?: string[], tokenBudget?: number,
) {
  const framed = (await markChunkTrust(storage.engine(), hits, readSources)).map(frameMarkedContent);
  return tokenBudget === undefined ? framed : applyTokenBudget(framed, tokenBudget);
}

/**
 * Everything a page_put or page_edit does after the page row commits: the
 * page's wikilinks, then its search mirror, inline. Returns the response fields
 * it produces.
 */
async function afterPageWrite(
  storage: Storage,
  r: { slug: string; changed: boolean },
  writeSource: string | undefined,
  isPublic: boolean,
  op: "page_put" | "page_edit" | "page_append",
): Promise<Record<string, unknown>> {
  if (!r.changed) return {};
  // Fetch the canonical row once: an omitted title lands as NULL while an
  // omitted body keeps the page's current one, so the stored row — not the
  // caller's input — is what actually became searchable.
  const page = await getPage(storage, r.slug);
  if (!page) return {};
  // The links carry the PAGE's source, not the caller's: an unscoped operator
  // write onto a named-source page must not re-home its edges to `default`.
  // A scoped caller can only reach a page it owns, so for it the two are the
  // same value.
  await syncWikilinksForPage(storage, r.slug, page.markdown_body ?? "", page.source_id ?? writeSource);
  return await mirrorInline(storage, page, isPublic || writeSource !== undefined, op);
}

/**
 * Mirror a written page into search, inline. `search_indexed: false` means the
 * mirror failed and was logged: the page write already committed, and the
 * hourly housekeeping indexes any live page without a current mirror.
 */
async function mirrorInline(
  storage: Storage,
  page: { slug: string; title: string | null; markdown_body: string; content_hash?: string; source_id?: string | null },
  remote: boolean,
  op: "page_put" | "page_append" | "page_edit",
): Promise<{ search_indexed: boolean; quarantined?: QuarantineVerdict }> {
  const v = await mirrorPageVerdict(storage, page, { remote, timingLabel: op });
  return { search_indexed: v.ok, ...(v.quarantined ? { quarantined: v.quarantined } : {}) };
}

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

function withPageAdminUrl(req: ToolCallRequest, result: ToolCallResult, opts: DispatchOptions): ToolCallResult {
  if (result.isError || !req.name.startsWith("page_") || OP_BY_NAME.get(req.name)?.scope !== "write" ||
      opts.isPublic || opts.authInfo?.isPublic || (opts.authInfo && !hasScope(opts.authInfo.scopes, "admin"))) return result;
  const issuer = opts.issuer ?? process.env.MEMRAIN_PUBLIC_URL;
  if (!issuer) return result;
  let base: URL;
  try { base = new URL(issuer); } catch { return result; }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) return result;
  const payload = JSON.parse(result.content[0]!.text);
  const slug = req.name === "page_rename" ? payload.to_slug : payload.slug;
  if (payload.ok !== true || typeof slug !== "string") return result;
  const baseUrl = base.toString();
  let end = baseUrl.length;
  while (end > 0 && baseUrl[end - 1] === "/") end--;
  const adminUrl = `${baseUrl.slice(0, end)}/admin/#page/${encodeURIComponent(slug)}`;
  return { ...result, content: result.content.map((block, index) => index === 0
    ? { ...block, text: JSON.stringify({ ...payload, admin_url: adminUrl }) } : block) };
}

function boundedResult(tool: string, result: ToolCallResult, isPublic: boolean): ToolCallResult {
  if (result.isError) return result;
  const error = oversizedResultError(tool, result);
  return error ? errResult(JSON.stringify(error.toEnvelope(isPublic))) : result;
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
 * An authenticated client with no write source is let through the tool gate
 * while MEMRAIN_TENANT_FAIL_CLOSED is off, and then reads as unscoped — the
 * operator's view. page_edit would write past the ownership fence and
 * purge_deleted_pages would reap every tenant's pages, so both refuse it.
 */
function requireOwnWriteSource(tool: string, authInfo: AuthInfo | undefined, writeSource: string | undefined): void {
  if (authInfo === undefined || writeSource !== undefined) return;
  throw new OperationError(
    "permission_denied",
    `no write source is granted to this client for '${tool}'`,
    "Request a token bound to a write source.",
  );
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
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function searchPageFilters(args: Record<string, unknown>): PageFilters {
  const filters: PageFilters = {
    ...(args["types"] !== undefined ? { types: args["types"] as string[] } : {}),
    ...(typeof args["slug_prefix"] === "string" ? { slugPrefix: args["slug_prefix"] } : {}),
  };
  validatePageFilters(filters);
  return filters;
}

async function pageTypeNotice(storage: Storage, filters: PageFilters, sources: string[] | undefined, remote: boolean): Promise<Record<string, unknown>> {
  if (!filters.types?.length) return {};
  const params: unknown[] = [];
  const scope = andSourceScope("source_id", sources, params);
  const rows = await storage.engine().query<{ type: string }>(
    `SELECT DISTINCT type FROM pages WHERE deleted_at IS NULL${scope}${remote ? " AND slug NOT LIKE 'life/diary/%'" : ""} ORDER BY type`, params,
  );
  const available = rows.rows.map(r => r.type).filter(t => !remote || !isDiaryPage(t, ""));
  const unknown = filters.types.filter(t => !available.includes(t));
  return unknown.length ? { notice: "unknown_page_types", unknown_types: unknown, available_types: available } : {};
}

/** Receives only caller-visible meta; hidden matches must not change the hint. */
function emptyRetrievalHint(readSources?: string[], meta?: Pick<SearchMeta, "degraded">): Record<string, unknown> {
  if (readSources?.length === 0) return { hint: { status: "grant_sources_empty", try: ["Ask the operator to grant a readable source."] } };
  const reasons = meta?.degraded.filter(r => r !== "keyword_zero") ?? [];
  return { hint: reasons.length > 0
    ? { status: "retrieval_degraded", reasons, try: ["Retry the query; check server health if this persists."] }
    : { status: "retrieval_healthy", try: ["Use fewer or different terms.", "Broaden the date, type or slug filters."] } };
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
  trustTier: TrustTier = "owner",
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
      { remote, trustTier },
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
  if (remote) { opts.excludeTarget = isDiarySlug; opts.excludeDiary = true; }
  opts.includeOverflow = true;
  let hits = await findBacklinks(storage, name, opts);
  // Diary fence: drop backlinks originating from a diary page (its mirror
  // source_path carries the life/diary/* slug) for a non-operator caller.
  // Edges into a diary target are dropped by `excludeTarget` above; this
  // drops edges out of a diary page.
  if (remote) hits = hits.filter((h) => !isDiarySourcePath(h.sourcePath));
  const requested = opts.limit ?? 50;
  const truncated = hits.length > requested;
  hits = hits.slice(0, requested);
  // Public ingress: `surfaceForm` is note-authored free text — strip it,
  // mirroring the search/page/fact body redaction policy.
  const out = redact
    ? redactBacklinks(hits as unknown as Record<string, unknown>[])
    : hits;
  return jsonResult({ ok: true, name, hits: out, truncated });
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
  if (typeof args.reason === "string") input.change_reason = args.reason;
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

/**
 * MEMRAIN_REQUIRE_WRITE_PRECONDITION: what an MCP page_put that overwrites a
 * live page without `expected_version` (and without `force: true`) gets —
 * `off` (default) nothing, `warn` a `warnings` entry, `refuse` the
 * `precondition_required` error. Only MCP page_put reads it: putPage's
 * internal callers write without a version on purpose.
 */
export function writePreconditionPolicy(): "warn" | "refuse" | undefined {
  const v = (process.env["MEMRAIN_REQUIRE_WRITE_PRECONDITION"] ?? "").trim().toLowerCase();
  if (v === "warn") return "warn";
  if (v === "refuse" || v === "1" || v === "true") return "refuse";
  return undefined;
}

async function callPagePut(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
  isPublic = false,
  remoteIdentity?: string,
  receipt?: WriteRequestKey,
  principal?: string,
): Promise<ToolCallResult> {
  const input = asPageInput(args, remoteIdentity);
  if (typeof input === "string") return errResult(input);
  if (writeSource) input.source_id = writeSource;
  const { expectedVersion } = writePrecondition("page_put", args);
  if (expectedVersion !== undefined) input.expectedVersion = expectedVersion;
  if (receipt !== undefined) input.receipt = receipt;
  if (principal !== undefined) input.written_by_principal = principal;
  const policy = writePreconditionPolicy();
  if (policy !== undefined && args["force"] !== true) input.preconditionPolicy = policy;
  if (args["allow_shrink"] === true) input.allowShrink = true;
  input.requireCleanNewSlug = true;
  const r = await putPage(storage, input);
  const derived = await afterPageWrite(storage, r, writeSource, isPublic, "page_put");
  return jsonResult({ ok: true, ...r, ...derived });
}

/**
 * page_edit: exact-text replacements on a live page, under the same gates as
 * page_put (public write flag, write source, slug-prefix fence) plus two of
 * its own. A matcher answers whether text is in the page, so it is a read:
 * where this ingress withholds page bodies, or the page is a diary a remote
 * caller may not see, it is refused or reads as not found. And the page must
 * be the caller's own — another source's page reads as not found, never as
 * "owned by another source".
 */
async function callPageEdit(
  storage: Storage,
  args: Record<string, unknown>,
  ctx: {
    writeSource: string | undefined;
    isPublic: boolean;
    redact: boolean;
    remote: boolean;
    readSources: string[] | undefined;
    remoteIdentity: string | undefined;
    principal: string;
    receipt: WriteRequestKey | undefined;
  },
): Promise<ToolCallResult> {
  const slug = args["slug"];
  if (typeof slug !== "string" || slug.length === 0) {
    throw new OperationError("invalid_params", "page_edit: `slug` is required", "Pass the slug of the page to edit.");
  }
  const expected = args["expected_version"];
  if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 1) {
    throw new OperationError(
      "invalid_params",
      "page_edit: `expected_version` is required",
      "Read the page with page_get and pass its `version`.",
    );
  }
  const edits = parsePageEdits(args["edits"]);
  if (ctx.redact) {
    throw new OperationError(
      "permission_denied",
      "page_edit: page bodies are not readable on this ingress",
      "Use page_put to replace the whole page.",
    );
  }
  // The diff and the matcher both read the page, so the caller must be able to
  // read it as well as write it: a write grant outside the read grant, or a
  // token with a read grant and no write source, must not open a read path.
  const scope = ctx.writeSource !== undefined ? [ctx.writeSource] : ctx.readSources;
  const current = await getPageExact(storage, slug, scope);
  if (
    !current ||
    (ctx.readSources !== undefined && !ctx.readSources.includes(current.source_id)) ||
    (ctx.remote && isDiaryPage(current.type, current.slug))
  ) {
    throw new PageNotFoundError(slug, "page_edit changes an existing page; create it with page_put first.");
  }
  const writtenBy = sanitizeWrittenBy(args["written_by"], ctx.remoteIdentity);
  const r = await putPage(storage, {
    slug,
    edits,
    change_reason: args.reason as string | undefined,
    expectedVersion: expected,
    allowAdHocType: true, // the page's own type
    written_by_principal: ctx.principal,
    ...(writtenBy !== undefined ? { written_by: writtenBy } : {}),
    ...(ctx.writeSource !== undefined ? { source_id: ctx.writeSource } : {}),
    ...(ctx.receipt !== undefined ? { receipt: ctx.receipt } : {}),
  });
  const derived = await afterPageWrite(storage, r, ctx.writeSource, ctx.isPublic, "page_edit");
  return jsonResult({
    ...pageEditResponse(r, edits.length, r.edited, r.secrets_found),
    ...derived,
  });
}

/** A diary/journal page. Its interiority is kept verbatim and never re-derived
 *  into facts OR chronicle events — a privacy invariant above the generic gates
 *  (facts admits type 'journal'; this refuses it). */
export function isDiaryPage(type: string | undefined, slug: string): boolean {
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
  if (pg === null) return false;
  return isDiaryPage(pg.type, pg.slug) || (await ownerOnlyPageSlugs(storage.engine(), [pg.slug])).has(pg.slug);
}

async function callPageAppend(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
  isPublic = false,
  remoteIdentity?: string,
  receipt?: WriteRequestKey,
  principal?: string,
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
    ...(principal !== undefined ? { written_by_principal: principal } : {}),
  });
  const derived = await afterPageWrite(storage, r, writeSource, isPublic, "page_append");
  const { append_start: _appendStart, ...response } = r;
  return jsonResult({
    ok: true,
    ...response,
    ...derived,
  });
}

async function callPageDelete(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
  principal?: string,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_delete: `slug` is required");
  }
  const writtenBy =
    typeof args["written_by"] === "string" ? args["written_by"] : undefined;
  const r = await deletePage(storage, args["slug"], writtenBy, writeSource, {
    changeReason: args.reason as string | undefined,
    ...writePrecondition("page_delete", args),
    ...(principal !== undefined ? { writtenByPrincipal: principal } : {}),
  });
  // A soft-deleted page must stop serving the facts its fence projected (rows
  // an earlier build wrote); explicit (NULL source_markdown_slug) facts are
  // left intact.
  if (!r.already_deleted) {
    validateSlug(args["slug"]);
    await storage.engine().query(`DELETE FROM entity_facts WHERE source_markdown_slug = $1`, [args["slug"]]);
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
  principal?: string,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_restore: `slug` is required");
  }
  const writtenBy =
    typeof args["written_by"] === "string" ? args["written_by"] : undefined;
  const r = await restorePage(storage, args["slug"], writtenBy, writeSource, principal !== undefined ? { writtenByPrincipal: principal } : {});
  if (r.restored) {
    // Re-derive ONLY what delete tore down: the search mirror. Links are not
    // touched by a soft-delete, so they're already intact (this is why
    // restore is narrower than revert, which changes the body).
    const page = await getPage(storage, r.slug);
    if (page) await mirrorPage(storage, page, { remote: isPublic || writeSource !== undefined, timingLabel: "page_restore" });
  }
  return jsonResult({ ok: true, ...r });
}

async function callPageRevert(
  storage: Storage,
  args: Record<string, unknown>,
  writeSource?: string,
  isPublic = false,
  principal?: string,
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
  const r = await revertPage(storage, args["slug"], v as number, writtenBy, writeSource, {
    changeReason: args.reason as string | undefined,
    ...writePrecondition("page_revert", args),
    ...(principal !== undefined ? { writtenByPrincipal: principal } : {}),
  });
  if (r.reverted) {
    // The body changed — refresh the links and the search mirror, exactly as
    // a normal page_put would.
    const page = await getPage(storage, r.slug);
    if (page) {
      await syncWikilinksForPage(storage, r.slug, page.markdown_body, page.source_id);
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
  isAdmin = false,
  touchRetrieval = true,
  windowBodyEnabled = true,
  untrusted = remote,
): Promise<ToolCallResult> {
  if (typeof args["slug"] !== "string") {
    return errResult("page_get: `slug` is required");
  }
  const requestedSource = args["source_id"];
  const scopeIds = typeof requestedSource === "string"
    ? readSources === undefined || readSources.includes(requestedSource) ? [requestedSource] : []
    : readSources;
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
  // A page derived from an owner-only source reads as missing too (core/owner-only.ts).
  if (remote && (await ownerOnlyPageSlugs(storage.engine(), [page.slug])).has(page.slug)) {
    throw new PageNotFoundError(args["slug"]);
  }
  const currentVersion = Number(page.version ?? 0);
  let snapshotWrittenAt: string | undefined;
  if (typeof args["version"] === "number") {
    const [snapshot] = await pageVersions(storage, page.slug, 1, scopeIds, { version: args["version"] });
    if (!snapshot) throw new OperationError(
      "version_not_found", `page version ${args["version"]} was not found`,
      "List available versions with page_versions, then pass one of their version_n values.",
    );
    page = { ...page, markdown_body: snapshot.body_snapshot, compiled_truth: snapshot.compiled_truth_snapshot,
      content_hash: snapshot.hash_new, version: Number(snapshot.version_n) };
    snapshotWrittenAt = snapshot.written_at;
  }
  // Retrieval write-back (mig 024): a user just surfaced this page — bump the
  // last_retrieved_at signal the context-volunteer "used" stat reads. Throttled
  // + best-effort; awaited because memrain is single-holder (no fire-and-forget
  // drain needed). page_get is the unambiguous page-surface op; search hits are
  // chunk/document-level and don't carry a page slug, so they don't feed it.
  if (touchRetrieval) await bumpLastRetrievedAt(storage.engine(), [page.slug], page.source_id);
  const { version, ...row } = page;
  // A page the content-sanity gate hid from search keeps it hidden here too:
  // a non-operator gets the page without its body unless an admin asks for it.
  const quarantined = await readQuarantineVerdict(storage.engine(), page.slug, page.source_id);
  const withheld =
    quarantined !== null && untrusted && !(args["include_quarantined"] === true && isAdmin);
  const out = quarantineContent(row as unknown as Record<string, unknown>, withheld);
  const visible = redact ? redactBody(out) : out;
  // The admin API preserves its page-view contract and enforces its own
  // response cap; MCP and credential-audit reads keep byte windows.
  const window = windowBodyEnabled && typeof visible.markdown_body === "string"
    ? pageBodyWindow(visible.markdown_body, {
      ...(typeof args["offset"] === "number" ? { offset: args["offset"] } : {}),
      ...(typeof args["max_bytes"] === "number" ? { maxBytes: args["max_bytes"] } : {}),
    }) : null;
  const { markdown_body: _body, ...metadata } = visible;
  const { body_window: windowBody, ...windowMeta } = window ?? {};
  return jsonResult({
    ok: true,
    page: window ? { ...metadata, body_window: windowBody } : visible,
    ...windowMeta,
    version: Number(version ?? 0),
    ...(snapshotWrittenAt !== undefined ? { written_at: snapshotWrittenAt, current_version: currentVersion } : {}),
    ...(resolvedSlug ? { resolved_slug: resolvedSlug } : {}),
    ...(quarantined ? { quarantined } : {}),
    ...(withheld ? { notice: "page_quarantined" } : {}),
  });
}

async function callPageList(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
  readSources?: string[],
  remote = false,
  untrusted = remote,
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
  opts.includeBody = args["include_body"] !== false;
  if (typeof args["slug_prefix"] === "string") opts.slugPrefix = args["slug_prefix"];
  const { pages, next_cursor, complete } = await listPagesPage(storage, {
    ...opts, excludeDiary: remote,
    ...(typeof args["cursor"] === "string" ? { cursor: args["cursor"] } : {}),
  });
  const quarantineVisible = await applyQuarantineVisibility(storage.engine(), pages, untrusted);
  const closed = remote ? await ownerOnlyPageSlugs(storage.engine(), quarantineVisible.map((p) => String(p.slug))) : new Set<string>();
  const visible = closed.size > 0 ? quarantineVisible.filter((p) => !closed.has(String(p.slug))) : quarantineVisible;
  const out = redact ? visible.map(redactQuarantinePage) : visible;
  return jsonResult({ ok: true, pages: out, next_cursor, complete });
}

async function callPageVersions(
  storage: Storage,
  args: Record<string, unknown>,
  redact = false,
  readSources?: string[],
  remote = false,
  withPrincipal = false,
  publicIngress = false,
  untrusted = remote,
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
  const versions = await pageVersions(storage, args["slug"], limit, sourceIds, { withPrincipal, includeBody: args["include_body"] === true });
  // Version rows carry body snapshots; redact each through the same
  // page allowlist so public callers see metadata only.
  const visible = await applyQuarantineVisibility(storage.engine(), versions, untrusted);
  const filtered = publicIngress ? visible.map(({ change_reason: _reason, ...row }) => row) : visible;
  const out = redact ? filtered.map(redactQuarantinePage) : filtered;
  return jsonResult({ ok: true, versions: out });
}

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
  if (typeof args.valid_from === "string") input.valid_from = args.valid_from;
  if (typeof args.valid_until === "string") input.valid_until = args.valid_until;
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

/** True when either endpoint of a graph edge is a diary slug. */
function isDiaryLink(link: { source_slug?: string; target_slug?: string }): boolean {
  return isDiarySlug(link.source_slug) || isDiarySlug(link.target_slug);
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
      : isDiarySourcePath(args["source_path"] as string) ||
        (await fenceOwnerOnlyHits(storage.engine(), [{ sourcePath: args["source_path"] as string }], true)).length === 0;
    if (fenced) return jsonResult({ ok: true, chunks: [], truncated: false });
  }
  const sourceIds = readSources;
  const limit = typeof args["limit"] === "number" ? args["limit"] : 200;
  const fromIndex = typeof args["from_index"] === "number" ? args["from_index"] : 0;
  const options = { fromIndex, limit: limit + 1 };
  const chunks = hasSlug
    ? await getChunksForPage(storage, args["slug"] as string, sourceIds, options)
    : await getChunksForSource(storage, args["source_path"] as string, sourceIds, options);
  const marked = await markExternalChunks(storage.engine(), chunks.slice(0, limit), readSources);
  return jsonResult({ ok: true, chunks: marked.map(frameMarkedContent), truncated: chunks.length > limit });
}

async function callResolveSlugs(
  storage: Storage,
  args: Record<string, unknown>,
  readSources?: string[],
  remote = false,
  redact = false,
): Promise<ToolCallResult> {
  if (typeof args["query"] !== "string" || args["query"].length === 0) {
    return errResult("resolve_slugs: `query` is required");
  }
  const exact = args["exact"] === true;
  const limit = typeof args["limit"] === "number" ? args["limit"] : 5;
  const opts: Parameters<typeof resolveSlugs>[2] = { exact, excludeDiary: remote, matchEmail: !redact,
    limit: exact ? Math.max(2, limit) : limit,
  };
  if (readSources !== undefined) opts.sourceIds = readSources;
  const matches = await resolveSlugs(storage, args["query"], opts);
  const selected = matches.slice(0, limit);
  const references = await slugReferenceCounts(storage, selected.map(h => h.slug), opts);
  const hits = selected.map(h => ({ ...h, referenced_by_count: references.get(h.slug) ?? 0 }));
  return jsonResult({ ok: true, query: args["query"], hits, ...(exact ? { ambiguous: matches.length > 1 } : {}) });
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

/**
 * The credential a write arrived on, for `written_by_principal`: the writer
 * identity, plus the enrollment when a shared connector books under one.
 * Taken from the resolved grant, never from an argument.
 */
export function writerPrincipal(opts: DispatchOptions): string {
  const base = writerIdentity(opts);
  const spendId = opts.authInfo?.spendId;
  return spendId !== undefined && spendId.length > 0 && spendId !== opts.authInfo?.clientId
    ? `${base}|enrollment:${spendId}`
    : base;
}

/** Whether a caller may read `written_by_principal`: the operator, or an admin-scoped grant. */
function seesPrincipal(opts: DispatchOptions): boolean {
  if (opts.authInfo === undefined) return !(opts.isPublic ?? false);
  return hasScope(opts.authInfo.scopes ?? [], "admin");
}

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
    return jsonResult({ ok: true, slug: args["slug"], groups: [], truncated: false });
  }
  const opts: Parameters<typeof getLinksPage>[2] = {};
  opts.status = args.status as "all" | "active" | "expired" | "future" | undefined;
  opts.asOf = args.as_of as string | undefined;
  if (typeof args["limit"] === "number") opts.limit = args["limit"];
  if (readSources !== undefined) opts.sourceIds = readSources;
  if (remote) opts.excludeDiary = true;
  let { groups, truncated } = await getLinksPage(storage, args["slug"], opts);
  // Drop edges to a diary page, then any group left empty.
  if (remote) {
    groups = groups
      .map((g) => ({ ...g, links: g.links.filter((l) => !isDiaryLink(l)) }))
      .filter((g) => g.links.length > 0);
  }
  return jsonResult({ ok: true, slug: args["slug"], groups, truncated });
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
async function callWhoami(
  storage: Storage,
  authInfo: AuthInfo | undefined,
  readSources: string[] | undefined,
  isPublic: boolean,
  access: CallerAccess,
): Promise<ToolCallResult> {
  // callable_tools comes from the same predicate as tools/list, so whoami can
  // never claim a tool the caller would be refused.
  const callableTools = visibleToolDefs(
    { isPublic, ...(authInfo !== undefined ? { authInfo } : {}) },
    isPublicMcpToolForbidden,
  ).map((t) => t.name);
  const bound = authInfo?.boundSlugPrefixes;
  const spendId = authInfo ? authInfo.spendId ?? authInfo.clientId : null;
  const budget = authInfo && spendId !== null
    ? await checkClientBudget(storage.engine(), spendId, new Date(), authInfo.budgetUsdPerDay)
    : null;
  return jsonResult({
    ok: true,
    client_id: authInfo?.clientId ?? null,
    scopes: authInfo?.scopes ?? [],
    write_source: authInfo?.sourceId ?? null,
    read_sources: readSources ?? null,
    is_public: isPublic,
    owner: access.owner,
    requester_scope: requesterScopeState(authInfo, isPublic, access.brain),
    operator: authInfo === undefined && !isPublic,
    bound_slug_prefixes: bound !== undefined && bound.length > 0 ? [...bound] : null,
    budget_usd_per_day: budget?.capUsd ?? null,
    spent_today_usd: budget?.spentUsd ?? null,
    spend_id: spendId,
    callable_tools: callableTools,
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
  // `olderThanHours` undefined still triggers the fn's default TTL.
  const scope = writeSource ? [writeSource] : undefined;
  const slugs = args["slugs"];
  if (slugs !== undefined && (!Array.isArray(slugs) || slugs.some((s) => typeof s !== "string"))) {
    return errResult("purge_deleted_pages: `slugs` must be an array of strings");
  }
  const r = await purgeDeletedPages(storage.engine(), olderThanHours, scope, {
    // Naming the pages makes this the owner's purge of them, not the TTL
    // sweep: their text is tombstoned against being written back.
    ...(slugs !== undefined ? { slugs: slugs as string[], tombstone: true } : {}),
    ...(args["dry_run"] === true ? { dryRun: true } : {}),
    ...(typeof args["expected_plan_hash"] === "string" ? { expectedPlanHash: args["expected_plan_hash"] } : {}),
  });
  return jsonResult({ ok: true, ...r });
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

/** True when a page slug is diary interiority (slug-prefix only — the cheap
 *  fence for slug-emitting graph/backlink reads; no scoped type lookup). */
function isDiarySlug(slug: string | null | undefined): boolean {
  return typeof slug === "string" && slug.startsWith("life/diary/");
}

