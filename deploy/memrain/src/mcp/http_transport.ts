/**
 * MCP HTTP transport — POST /mcp accepting JSON-RPC 2.0 requests.
 *
 * Supported methods:
 *   - `initialize`               handshake: capabilities, the stamped build
 *                                version and the memrain operating contract
 *   - `tools/list`               the tools this caller can call (mcp/visibility.ts)
 *   - `tools/call`               { name, arguments } → tool result
 *   - `ping`                     health probe (returns {})
 *
 * Anything else returns -32601 (method not found). Malformed JSON gets
 * -32700 (parse error). Spec: https://www.jsonrpc.org/specification
 *
 * MCP spec for HTTP transport allows either a single JSON-RPC object or
 * an array (batched). We handle both.
 */
import type { Storage } from "../core/storage.ts";
import { MEMRAIN_RESPONSE_VERSION } from "./response-contract.ts";
import { dispatchTool } from "./dispatch.ts";
import { ingressRefusal, visibleToolDefs } from "./visibility.ts";
import { logToolCall } from "./param-redaction.ts";
import { logToolCallToDb } from "./request-log-db.ts";
import { publishToolCallEvent } from "../http/admin-events.ts";
import { RateLimiter } from "./rate_limit.ts";
import { parseJsonBody } from "../http/body_limit.ts";
import { publicSafeErrorMessage } from "../core/public_redaction.ts";
import type { AuthInfo } from "../core/auth-info.ts";
import { resolveClientKey } from "../http/client-key.ts";
import { resolveServerInfo, resolveServerInstructions } from "./server-instructions.ts";

/**
 * The MCP revisions this server speaks, oldest first. Each one's required
 * server behaviour is met: 2025-06-18 adds only optional result fields
 * (structured output, resource links, `title`) plus the protocol-version
 * header checked below, and 2025-11-25's additions for a tools-only HTTP server
 * are optional too (icons, tasks, incremental consent). The JSON Schema dialect
 * change to 2020-12 is harmless: the generated inputSchemas use only keywords
 * both drafts read the same way.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1]!;

/** The version `initialize` answers with: the client's own when supported,
 *  else the latest (lifecycle spec: the client then decides whether to stay). */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}
const SERVER_INFO = resolveServerInfo();

export interface McpHandlerOptions {
  storage: Storage;
  /**
   * Public-traffic limiter (one bucket per Cf-Connecting-Ip). Default
   * tightens to capacity=30, refill=1/s — chat-equivalent burst.
   */
  publicRateLimiter?: RateLimiter;
  /**
   * Internal-traffic limiter (a single "internal" bucket). The
   * internal callers (e.g. the bridge or future recipe workers) may
   * burst legitimately and should not share the per-IP public cap.
   * Default capacity=300, refill=10/s.
   */
  internalRateLimiter?: RateLimiter;
  /** @deprecated alias for `publicRateLimiter`; kept for tests. */
  rateLimiter?: RateLimiter;
  /** Override the IP key extraction (e.g. for tests). */
  clientKey?: (req: Request) => string;
  /** Predicate for tools that must NOT be callable from public requests
   *  (mutating ones — `index`, `log_friction`). The server route layer
   *  passes per-request `isPublic` and we cross-reference. */
  forbidPublicTool?: (toolName: string) => boolean;
  /**
   * Per-token-id limiter (one bucket per OAuth `clientId`), applied AFTER the
   * per-IP check. A single greedy OAuth client rotating egress IPs (claude.ai /
   * ChatGPT fleets do) would otherwise get a fresh per-IP bucket per IP and
   * never trip a cap. Absent → no per-token limiting (behaviour unchanged).
   * Only consulted when `ctx.authInfo.clientId` is present.
   */
  perTokenRateLimiter?: RateLimiter;
}

/** Per-request context the server passes to handleMcp. */
export interface McpRequestContext {
  isPublic: boolean;
  /**
   * Whether the caller satisfied the internal-token gate (the server
   * evaluates `MEMRAIN_INTERNAL_TOKEN` and passes the result). Only
   * consulted for write tools on the internal path — read tools and
   * public traffic are unaffected. Defaults to authorized when omitted
   * (e.g. older callers / tests) and when the token is unconfigured, so
   * this is a no-op until the operator sets the token, mirroring the
   * legacy fallthrough of the HTTP `/index` gate.
   */
  internalAuthOk?: boolean;
  /**
   * Resolved identity for OAuth/JWT callers. Present only when an OAuth
   * token was verified at the ingress; absent for static-bearer and
   * internal-token paths (those remain unscoped, preserving current
   * behavior). When set, the dispatcher uses it to scope reads to the
   * caller's granted sources and stamp writes with the caller's sourceId.
   */
  authInfo?: AuthInfo;
  /** This server's OAuth issuer, forwarded to dispatch for step-up challenges. */
  issuer?: string;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INTERNAL = -32603;
const ERR_RATE_LIMITED = -32000; // server-defined band
const ERR_UNAUTHORIZED = -32001; // server-defined band — internal token

// Upper bound on JSON-RPC batch length. Each element is a full dispatch (and a
// paid embed for search-shaped tools), so an unbounded batch is a cost/DoS
// amplifier even after per-element rate-limit charging.
const MAX_BATCH_SIZE = 50;

export function makeMcpHandler(opts: McpHandlerOptions) {
  // Public and internal traffic must NOT share a limiter. A flood of
  // public requests could otherwise starve the internal caller (a
  // recipe / worker), and conversely the internal caller's burst
  // (cron-driven re-index) would trip a public-tuned per-IP cap.
  const publicLimiter =
    opts.publicRateLimiter ?? opts.rateLimiter ?? new RateLimiter();
  const internalLimiter =
    opts.internalRateLimiter ??
    new RateLimiter({ capacity: 300, refillPerSecond: 10 });
  const keyFn = opts.clientKey ?? resolveClientKey;
  const forbidPublic = opts.forbidPublicTool ?? (() => false);
  const perTokenLimiter = opts.perTokenRateLimiter;

  return async function handleMcp(
    req: Request,
    ctx: McpRequestContext = { isPublic: false },
  ): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const limiter = ctx.isPublic ? publicLimiter : internalLimiter;
    const clientId = keyFn(req);
    if (!limiter.allow(clientId)) {
      // Fail-visible but NOT force-written: a hammering client must not turn
      // every 429 into a guaranteed DB INSERT (the limiter would stop
      // shedding DB load). Rejections land in the log only when the sink is
      // enabled via MEMRAIN_REQUEST_LOG_DB, best-effort.
      logToolCallToDb(opts.storage.engine(), {
        tool: "rate_limited",
        agentName:
          ctx.authInfo?.clientId ?? (ctx.isPublic ? "public" : "internal"),
        ...(ctx.authInfo ? { tokenName: ctx.authInfo.clientId } : {}),
        latencyMs: 0,
        ok: false,
        params: null,
        errorMessage: "rate limit exceeded",
      });
      return Response.json(
        rpcError(null, ERR_RATE_LIMITED, "rate limit exceeded"),
        {
          status: 429,
          headers: { "Retry-After": String(limiter.retryAfterSeconds(clientId)) },
        },
      );
    }
    // Per-token-id cap (post-auth): an authenticated OAuth client is capped by
    // its clientId regardless of how many IPs it rotates through. Skipped for
    // unauthenticated callers (no clientId — never collapse them into a shared
    // "undefined" bucket).
    const tokenId = ctx.authInfo?.clientId;
    if (perTokenLimiter && tokenId && !perTokenLimiter.allow(tokenId)) {
      logToolCallToDb(opts.storage.engine(), {
        tool: "rate_limited",
        agentName: tokenId,
        tokenName: tokenId,
        latencyMs: 0,
        ok: false,
        params: null,
        errorMessage: "per-token rate limit exceeded",
      });
      return Response.json(
        rpcError(null, ERR_RATE_LIMITED, "rate limit exceeded"),
        {
          status: 429,
          headers: { "Retry-After": String(perTokenLimiter.retryAfterSeconds(tokenId)) },
        },
      );
    }

    const parsedBody = await parseJsonBody<unknown>(req);
    if (!parsedBody.ok) {
      // parseJsonBody returns 400 / 413; rewrap as JSON-RPC parse error
      // so the MCP client sees the standard envelope.
      const status = parsedBody.response.status;
      return Response.json(
        rpcError(null, ERR_PARSE, status === 413 ? "body too large" : "parse error"),
        { status },
      );
    }
    const raw: unknown = parsedBody.body;

    // Since 2025-06-18 a client names the negotiated revision on every request
    // after `initialize`, and a server MUST refuse one it does not speak. An
    // absent header means 2025-03-26 and is accepted as before.
    const headerVersion = req.headers.get("mcp-protocol-version");
    if (
      headerVersion !== null &&
      !SUPPORTED_PROTOCOL_VERSIONS.includes(headerVersion) &&
      (Array.isArray(raw) || (raw as { method?: string })?.method !== "initialize")
    ) {
      return Response.json(
        rpcError(null, ERR_INVALID_REQUEST, `unsupported MCP-Protocol-Version: ${headerVersion.slice(0, 40)}`),
        { status: 400 },
      );
    }

    // A JSON-RPC notification carries no `id` and expects no response body.
    // The standard MCP post-initialize `notifications/initialized` is
    // acknowledged with an empty 204; without this it would
    // fall through to the switch default and return a -32601 method-not-found.
    if (
      !Array.isArray(raw) &&
      (raw as { method?: string })?.method === "notifications/initialized"
    ) {
      return new Response(null, { status: 204 });
    }

    if (Array.isArray(raw)) {
      // A JSON-RPC batch runs N dispatches but only spent ONE rate-limit token
      // at the top. Cap the batch, then charge the remaining N-1 tokens up front
      // so a single POST of thousands of tools/call (each a paid Bedrock embed)
      // can't amplify past the limiter's capacity.
      if (raw.length > MAX_BATCH_SIZE) {
        return Response.json(
          rpcError(null, ERR_INVALID_REQUEST, `batch too large (max ${MAX_BATCH_SIZE})`),
          { status: 400 },
        );
      }
      for (let i = 1; i < raw.length; i++) {
        if (!limiter.allow(clientId)) {
          return Response.json(
            rpcError(null, ERR_RATE_LIMITED, "rate limit exceeded (batch)"),
            {
              status: 429,
              headers: { "Retry-After": String(limiter.retryAfterSeconds(clientId)) },
            },
          );
        }
      }
      const responses = await Promise.all(
        raw.map((r) =>
          handleSingle(opts.storage, r as JsonRpcRequest, ctx, forbidPublic),
        ),
      );
      return Response.json(responses);
    }
    const single = await handleSingle(
      opts.storage,
      raw as JsonRpcRequest,
      ctx,
      forbidPublic,
    );
    return Response.json(single);
  };
}

async function handleSingle(
  storage: Storage,
  req: JsonRpcRequest,
  ctx: McpRequestContext,
  forbidPublic: (name: string) => boolean,
): Promise<JsonRpcResponse> {
  const id = req?.id ?? null;
  if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return rpcError(id, ERR_INVALID_REQUEST, "invalid JSON-RPC request");
  }

  // Shared identity for the DB request log. `force` makes the sink
  // default-ON for OAuth-authenticated callers (fail-visible), while the
  // static-bearer / internal paths stay behind MEMRAIN_REQUEST_LOG_DB.
  const agentName =
    ctx.authInfo?.clientId ?? (ctx.isPublic ? "public" : "internal");
  const logIdentity = {
    agentName,
    ...(ctx.authInfo ? { tokenName: ctx.authInfo.clientId } : {}),
    force: ctx.authInfo !== undefined,
  };

  switch (req.method) {
    case "initialize": {
      // The contract names only tools this caller can call, judged by the
      // same predicate tools/list uses.
      const visible = new Set(visibleToolDefs(ctx, forbidPublic).map((t) => t.name));
      return rpcOk(id, {
        protocolVersion: negotiateProtocolVersion(req.params?.protocolVersion),
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
        instructions: resolveServerInstructions(process.env, { callable: (name) => visible.has(name) }),
        // memrain's own response-shape version, distinct from the MCP protocol
        // version above: that pins the transport, this pins what memrain puts
        // inside a tool result. A client can refuse to run against a shape it
        // does not know instead of discovering the change in production.
        _meta: { memexResponseVersion: MEMRAIN_RESPONSE_VERSION },
      });
    }
    case "tools/list":
      // Log tools/list too — a client that only ever lists tools should
      // still be visible in the admin Request Log.
      logToolCallToDb(storage.engine(), {
        tool: "tools/list",
        ...logIdentity,
        latencyMs: 0,
        ok: true,
        params: null,
      });
      // Advertise exactly what this caller can call: the ingress walls plus
      // the credential's scope, operator-only and tenant gates, judged by the
      // same predicate tools/call and dispatch use.
      return rpcOk(id, { tools: visibleToolDefs(ctx, forbidPublic) });
    case "tools/call": {
      const params = (req.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (typeof params.name !== "string") {
        return rpcError(id, ERR_INVALID_REQUEST, "tools/call: `name` required");
      }
      const wall = ingressRefusal(params.name, ctx, forbidPublic);
      if (wall?.kind === "public_ingress") {
        logToolCallToDb(storage.engine(), {
          tool: params.name,
          ...logIdentity,
          latencyMs: 0,
          ok: false,
          params: null,
          errorMessage: `forbidden_public: tool ${params.name} is not callable from the public ingress`,
        });
        return rpcError(
          id,
          ERR_INVALID_REQUEST,
          `tool ${params.name} is not callable from the public ingress`,
        );
      }
      // Anonymous bridge path: the write tools (FORBIDDEN_MCP_TOOLS_FROM_PUBLIC)
      // require the shared internal token, closing the kill-chain where a
      // compromised sibling on the docker bridge calls `tools/call
      // name=index` to poison the RAG corpus. Read tools are unaffected,
      // so the bridge's `search` calls keep working with no token.
      //
      // An AUTHENTICATED principal (ctx.authInfo present — OAuth/PAT, never
      // the static public bearer nor a bare bridge sibling) is NOT what this
      // wall defends against; such a caller is gated on
      // scope alone. Authorization for these callers rests in dispatch — the
      // per-op scope gate, OPERATOR_ONLY_TOOLS, the token's source scoping,
      // and the public-redaction bit.
      if (wall?.kind === "internal_token") {
        logToolCallToDb(storage.engine(), {
          tool: params.name,
          ...logIdentity,
          latencyMs: 0,
          ok: false,
          params: null,
          errorMessage: `unauthorized_internal: tool ${params.name} requires the internal token`,
        });
        return rpcError(
          id,
          ERR_UNAUTHORIZED,
          `tool ${params.name} requires the internal token`,
        );
      }
      try {
        const startedAt = Date.now();
        const result = await dispatchTool(
          storage,
          { name: params.name, arguments: params.arguments },
          {
            isPublic: ctx.isPublic,
            authInfo: ctx.authInfo,
            ...(ctx.issuer !== undefined ? { issuer: ctx.issuer } : {}),
          },
        );
        // Opt-in redacted request log (no-op unless MEMRAIN_LOG_REQUESTS set).
        // Names + counts + coarse size only — never raw param values.
        logToolCall(params.name, ctx.isPublic, params.arguments, !result.isError);
        // DB sink — feeds the admin Request Log page. Fire-and-forget +
        // redacted; never blocks or fails the call. On error results the
        // envelope's message/code is re-extracted so the admin reader's
        // error_message column is populated (scope rejections land here).
        const errMsg = result.isError
          ? extractErrorMessage(result.content?.[0]?.text)
          : undefined;
        logToolCallToDb(storage.engine(), {
          tool: params.name,
          ...logIdentity,
          latencyMs: Date.now() - startedAt,
          ok: !result.isError,
          params: params.arguments,
          ...(errMsg !== undefined ? { errorMessage: errMsg } : {}),
        });
        // Push a redacted event to the admin SSE feed (deferred #2). No-op when
        // no admin browser is connected; never raw params.
        publishToolCallEvent({ tool: params.name, agent: agentName, latencyMs: Date.now() - startedAt, ok: !result.isError });
        return rpcOk(id, result);
      } catch (e) {
        // Defensive: dispatchTool already catches + sanitizes, but if it
        // ever throws, don't echo raw exception text to a public caller.
        return rpcError(id, ERR_INTERNAL, publicSafeErrorMessage(e, ctx.isPublic));
      }
    }
    case "ping":
      return rpcOk(id, {});
    default:
      return rpcError(id, ERR_METHOD_NOT_FOUND, `method not found: ${req.method}`);
  }
}

/**
 * Best-effort short failure description from a tool result's error text.
 * The dispatcher serializes either an OperationError envelope
 * (`{error, message?, suggestion?}`) or a sanitized message string.
 */
function extractErrorMessage(text: string | undefined): string {
  if (!text) return "op_error";
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.length > 0) {
      return parsed.message;
    }
    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      return parsed.error;
    }
  } catch {
    /* not an envelope — fall through to the raw text */
  }
  return text.slice(0, 300);
}

function rpcOk(
  id: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const err: JsonRpcResponse["error"] = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id, error: err };
}
