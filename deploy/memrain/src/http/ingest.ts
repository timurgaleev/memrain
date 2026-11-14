/**
 * POST /ingest — webhook capture endpoint, the non-MCP front door for
 * Apple Shortcuts / Zapier / IFTTT-style capture.
 *
 * Surface:
 *   - auth: an OAuth bearer with the `write` scope (the server ingress
 *     resolves the token to an AuthInfo; static-bearer and anonymous
 *     callers are refused — the OAuth gate IS the trust boundary)
 *   - rate limit: 100 events / 10 s per client key
 *   - byte cap: `MEMRAIN_INGEST_MAX_BYTES` (default 1 MiB), stream-counted
 *   - content types: text-shaped only (markdown / plain / html / json);
 *     unknown `text/*` degrades to text/plain, binary is 415 in v1
 *   - idempotency: same content from the same credential into the same
 *     source is the SAME durable job (job id embeds the SHA-256 content hash)
 *   - response: 202 + job_id — capture is queued, not synchronous
 *
 * The heavy lifting happens in the `ingest_capture` job: the worker lands
 * the payload as a page (default slug `inbox/YYYY-MM-DD-<hash6>`) through
 * the SAME page_put dispatch path MCP writes use, so wikilink sync, the
 * search mirror, and tenancy stamping (the caller's write source) all
 * apply. Events always carry `untrusted_payload: true` — the input came
 * over the network from an authenticated but otherwise untrusted source.
 */
import { auditRejection, auditSecrets, guardSecrets, SecretRejectedError, type SecretFinding } from "../core/secret-scan.ts";
import { looksBinary } from "../core/binary-guard.ts";
import { wellFormJsonbValue } from "../core/well-form.ts";
import { createHash } from "node:crypto";
import type { Storage } from "../core/storage.ts";
import type { AuthInfo } from "../core/auth-info.ts";
import {
  effectiveWriteSourceIdForIngress,
  isNoSourceSentinel,
  parsePrincipalRef,
  tenantFailClosedEnabled,
} from "../core/auth-info.ts";
import { InvalidTokenError, OAuthProvider, type PrincipalGrant } from "../core/oauth-provider.ts";
import { LEGACY_HEADER_PREFIX } from "../core/brand.ts";
import { hasScope } from "../core/scope.ts";
import { validateSlug } from "../core/pages.ts";
import { Queue } from "../core/jobs/queue.ts";
import { registerHandler } from "../core/jobs/handlers.ts";
import { dispatchTool, slugUnderPrefixes } from "../mcp/dispatch.ts";
import { readBodyWithCap } from "./body_limit.ts";
import { logIngest } from "../core/ingest-log.ts";
import { runWithSpendClient } from "../core/budget.ts";

import { UnrecoverableJobError } from "../core/jobs/types.ts";
import { INGEST_CAPTURE_JOB_KIND, TRANSCRIPTS_INGEST_JOB_KIND } from "../core/jobs/kinds.ts";
import { parseTranscriptJsonl } from "../core/transcripts/detect.ts";
import { ingestSessions, prepareSession, type PreparedSession } from "../core/transcripts/ingest.ts";
import { sessionBaseSlug } from "../core/transcripts/render.ts";
import {
  sessionsFromPayload,
  TRANSCRIPT_PUSH_CONTENT_TYPE,
  transcriptPushMaxBytes,
} from "../core/transcripts/push.ts";
import { JSONL_TRANSCRIPT_FORMATS } from "../core/transcripts/types.ts";

export { INGEST_CAPTURE_JOB_KIND, TRANSCRIPTS_INGEST_JOB_KIND };

const DEFAULT_INGEST_MAX_BYTES = 1_048_576; // 1 MiB

/** Max payload bytes for POST /ingest (env-overridable). */
export function ingestMaxBytes(): number {
  const raw = process.env.MEMRAIN_INGEST_MAX_BYTES;
  if (!raw) return DEFAULT_INGEST_MAX_BYTES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INGEST_MAX_BYTES;
}

export type IngestContentType =
  | "text/markdown"
  | "text/plain"
  | "text/html"
  | "application/json";

const INGEST_ALLOWED_CONTENT_TYPES: ReadonlySet<IngestContentType> = new Set([
  "text/markdown",
  "text/plain",
  "text/html",
  "application/json",
]);

/** The event shape queued for the `ingest_capture` job. */
export interface IngestionEvent {
  /** Owning source (tenant) — ALWAYS the caller's write source. */
  source_id: string;
  source_kind: "webhook";
  source_uri: string;
  received_at: string;
  content_type: IngestContentType;
  content: string;
  /** SHA-256 hex of `content` — the idempotency key material. */
  content_hash: string;
  /** Always true: network input from an authenticated but untrusted client. */
  untrusted_payload: boolean;
  metadata: Record<string, unknown>;
}

/**
 * Structural boundary validator (run again by the job handler — the queue
 * payload crosses a serialization boundary). Returns a reason string or null.
 */
export function validateIngestionEvent(event: unknown): string | null {
  if (event === null || typeof event !== "object") return "event must be an object";
  const e = event as Record<string, unknown>;
  for (const field of [
    "source_id",
    "source_kind",
    "source_uri",
    "received_at",
    "content",
    "content_hash",
  ] as const) {
    if (typeof e[field] !== "string" || (e[field] as string).length === 0) {
      return `${field} must be a non-empty string`;
    }
  }
  if (
    typeof e.content_type !== "string" ||
    !INGEST_ALLOWED_CONTENT_TYPES.has(e.content_type as IngestContentType)
  ) {
    return `content_type must be one of ${[...INGEST_ALLOWED_CONTENT_TYPES].join(", ")}`;
  }
  if (!Number.isFinite(Date.parse(e.received_at as string))) {
    return "received_at must be an ISO 8601 timestamp";
  }
  if (!/^[0-9a-f]{64}$/.test(e.content_hash as string)) {
    return "content_hash must be 64 lowercase hex characters (SHA-256)";
  }
  if (
    e.metadata !== undefined &&
    (e.metadata === null || typeof e.metadata !== "object" || Array.isArray(e.metadata))
  ) {
    return "metadata must be a plain object when present";
  }
  return null;
}

/** Default capture slug: `inbox/YYYY-MM-DD-<hash6>` — stable for the same
 *  content on the same day, and the triage convention a downstream review
 *  skill can promote from. */
export function defaultSlugForEvent(
  event: Pick<IngestionEvent, "content_hash">,
  now: Date = new Date(),
): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `inbox/${y}-${m}-${d}-${event.content_hash.slice(0, 6)}`;
}

/** Map a declared content type onto the closed taxonomy (null = reject 415). */
export function resolveIngestContentType(
  declared: string,
): IngestContentType | null {
  const d = declared.toLowerCase();
  if (d.startsWith("text/markdown")) return "text/markdown";
  if (d.startsWith("text/html")) return "text/html";
  if (d.startsWith("text/plain")) return "text/plain";
  if (d.startsWith("application/json")) return "application/json";
  // Unknown text/* sub-types pass through as text/plain.
  if (d.startsWith("text/")) return "text/plain";
  return null;
}

export interface IngestRouteDeps {
  storage: Storage;
  /** Resolved OAuth identity — undefined means unauthenticated (401). */
  authInfo?: AuthInfo;
  /** Per-client-key limiter (100 events / 10 s in server wiring). */
  allowRequest: () => boolean;
  /** Client IP (rate-limit key holder) recorded on the event metadata. */
  clientIp: string;
}

function err(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status });
}

const INGEST_HEADERS = ["content-type", "source-uri", "slug"] as const;
type IngestHeader = (typeof INGEST_HEADERS)[number];

/**
 * The `x-memrain-<name>` headers, each falling back to its legacy
 * `x-memex-<name>` spelling. A header sent under both names with different
 * values is refused rather than resolved: picking one could land a capture at
 * a slug the sender did not mean.
 */
function readIngestHeaders(req: Request): Record<IngestHeader, string | null> | { ambiguous: string } {
  const out = {} as Record<IngestHeader, string | null>;
  for (const name of INGEST_HEADERS) {
    const current = req.headers.get(`x-memrain-${name}`);
    const legacy = req.headers.get(`${LEGACY_HEADER_PREFIX}${name}`);
    if (current !== null && legacy !== null && current !== legacy) return { ambiguous: `x-memrain-${name}` };
    out[name] = current ?? legacy;
  }
  return out;
}

/**
 * Clients with a transcript push in flight. A push buffers up to the
 * transcript cap, so one at a time per client keeps a single write token from
 * holding many of those buffers at once under the general rate limit.
 */
const transcriptPushesInFlight = new Set<string>();

export async function handleIngestRoute(
  req: Request,
  deps: IngestRouteDeps,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (!deps.allowRequest()) {
    return Response.json(
      {
        error: "rate_limit_exceeded",
        message: "too many /ingest events; backoff and retry",
      },
      { status: 429, headers: { "Retry-After": "10" } },
    );
  }
  const auth = deps.authInfo;
  if (!auth) {
    return err(
      401,
      "unauthorized",
      "POST /ingest requires an OAuth bearer token (write scope)",
    );
  }
  if (!hasScope(auth.scopes ?? [], "write")) {
    return err(
      403,
      "insufficient_scope",
      "POST /ingest requires the 'write' scope",
    );
  }

  const headers = readIngestHeaders(req);
  // A session log is far larger than a capture, so it gets its own cap; the
  // type is read from the headers before a byte of the body is.
  const pushingTranscript =
    !("ambiguous" in headers) &&
    (headers["content-type"] || req.headers.get("content-type") || "").toLowerCase().startsWith(TRANSCRIPT_PUSH_CONTENT_TYPE);
  // The larger cap is buffered only for a client that may write somewhere.
  if (pushingTranscript && isNoSourceSentinel(effectiveWriteSourceIdForIngress(auth, { failClosed: tenantFailClosedEnabled() }))) {
    return err(403, "permission_denied", "no write source is granted to this client for POST /ingest");
  }
  if (pushingTranscript) {
    if (transcriptPushesInFlight.has(auth.clientId)) {
      return Response.json(
        { error: "push_in_flight", message: "a transcript push from this client is still being read; retry when it finishes" },
        { status: 429, headers: { "Retry-After": "5" } },
      );
    }
    transcriptPushesInFlight.add(auth.clientId);
    try {
      const read = await readBodyWithCap(req, transcriptPushMaxBytes());
      if (!read.ok) return read.response;
      if (read.buf.byteLength === 0) return err(400, "empty_body", "POST /ingest requires a non-empty body");
      return await handleTranscriptPush(deps, auth, read.buf);
    } finally {
      transcriptPushesInFlight.delete(auth.clientId);
    }
  }
  const read = await readBodyWithCap(req, ingestMaxBytes());
  if (!read.ok) return read.response;
  if (read.buf.byteLength === 0) {
    return err(400, "empty_body", "POST /ingest requires a non-empty body");
  }

  if ("ambiguous" in headers) {
    return err(
      400,
      "ambiguous_header",
      `${headers.ambiguous} and its legacy x-memex- spelling carry different values; send one`,
    );
  }

  // Callers whose transport pins Content-Type (e.g. a JSON-only webhook hop)
  // can declare the intended type via X-Memrain-Content-Type (or the legacy
  // X-Memex-Content-Type).
  const declared = (
    headers["content-type"] ||
    req.headers.get("content-type") ||
    ""
  ).toLowerCase();
  const contentType = resolveIngestContentType(declared);
  if (contentType === null) {
    return err(
      415,
      "unsupported_content_type",
      `content_type '${declared}' not supported. Use one of: ` +
        `${[...INGEST_ALLOWED_CONTENT_TYPES].join(", ")}. Binary content ` +
        "(image/audio/video/pdf) is not yet supported via POST /ingest.",
    );
  }

  // The declared type is the caller's word; the bytes are the evidence.
  if (looksBinary(read.buf)) {
    return err(415, "binary_content", "POST /ingest takes text; the body is a binary file");
  }
  // The binary probe reads only the head; a NUL further on would fail the
  // job insert (jsonb refuses U+0000) as a 500.
  const text = new TextDecoder().decode(read.buf);
  if (text.includes("\u0000")) {
    return err(400, "invalid_content", "the body carries U+0000; send text");
  }
  const sourceUri = (
    headers["source-uri"] ||
    `mcp-webhook:${auth.clientId}:${Date.now()}`
  ).slice(0, 1024);
  const callerSlug = headers.slug ?? undefined;
  if (callerSlug !== undefined) {
    try {
      validateSlug(callerSlug);
    } catch (e) {
      return err(400, "invalid_slug", e instanceof Error ? e.message : "invalid slug");
    }
  }

  // Tenancy: the event is stamped with the CALLER's write source — a webhook
  // client can never direct a capture into another tenant's source. Same
  // fail-closed floor as the MCP write path: under MEMRAIN_TENANT_FAIL_CLOSED a
  // scopeless authenticated client is rejected instead of falling through to
  // the shared 'default' tenant.
  const writeSourceRaw = effectiveWriteSourceIdForIngress(auth, {
    failClosed: tenantFailClosedEnabled(),
  });
  if (isNoSourceSentinel(writeSourceRaw)) {
    return err(
      403,
      "permission_denied",
      "no write source is granted to this client for POST /ingest",
    );
  }
  // Slug-prefix write fence (oauth_clients.bound_slug_prefixes): the same
  // fence the MCP write gate enforces. A bound client must name a slug and
  // it must fall under its prefixes — otherwise the capture worker would
  // land a page at a fence-evading slug. The prefixes also ride the event
  // metadata so the worker's re-dispatch stays fenced (defense in depth).
  const boundPrefixes = auth.boundSlugPrefixes;
  if (boundPrefixes && boundPrefixes.length > 0) {
    if (!callerSlug || !slugUnderPrefixes(callerSlug, boundPrefixes)) {
      return err(
        403,
        "permission_denied",
        `slug ${JSON.stringify(callerSlug ?? null)} is outside this client's bound prefixes`,
      );
    }
  }

  // Scanned here, not only when the capture job stores it: the job payload
  // itself sits in the jobs table. Scanned only after the tenancy gates, so a
  // client with no grant learns nothing about the body and leaves no audit row
  // in someone else's ingest_log.
  let content: string;
  let secretFindings: SecretFinding[];
  try {
    const scanned = guardSecrets(text, "POST /ingest body");
    content = scanned.text;
    secretFindings = scanned.findings;
  } catch (e) {
    if (e instanceof SecretRejectedError) {
      void auditRejection(
        deps.storage.engine(),
        e,
        `mcp-webhook:${auth.clientId}`,
        writeSourceRaw ?? "default",
      ).catch(() => {});
    }
    return err(400, "secret_in_content", e instanceof Error ? e.message : "credential in content");
  }
  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
  const event: IngestionEvent = {
    source_id: writeSourceRaw ?? "default",
    source_kind: "webhook",
    source_uri: sourceUri,
    received_at: new Date().toISOString(),
    content_type: contentType,
    content,
    content_hash: contentHash,
    untrusted_payload: true, // ALWAYS true for network input
    metadata: {
      ip: deps.clientIp,
      user_agent: req.headers.get("user-agent") ?? "",
      client_id: auth.clientId,
      ...(callerSlug ? { slug: callerSlug } : {}),
      ...(boundPrefixes && boundPrefixes.length > 0
        ? { bound_slug_prefixes: boundPrefixes }
        : {}),
    },
  };
  const invalid = validateIngestionEvent(event);
  if (invalid) return err(400, "invalid_event", invalid);

  try {
    const queue = new Queue(deps.storage.engine());
    // Idempotency: same content from the same credential into the same source
    // is a single durable job — retries and double-submits collapse.
    const job = await queue.enqueue({
      kind: INGEST_CAPTURE_JOB_KIND,
      id: `ingest:webhook:${auth.clientId}:${ingestSubmitterKey(event.source_id, auth)}:${contentHash}`,
      payload: {
        event,
        ...(callerSlug ? { slug: callerSlug } : {}),
        // Which credential queued this, so the worker can re-check it live.
        ...(auth.principal ? { principal: auth.principal } : {}),
      },
    });

    // Ingestion audit trail (mig 087): one ingest_log row per ACCEPTED event,
    // so webhook capture runs are inspectable via get_ingest_log alongside
    // importer/absorb runs. Fire-and-forget — never blocks the 202.
    void logIngest(deps.storage.engine(), {
      source_type: "webhook:capture",
      source_ref: sourceUri,
      pages_updated: [],
      summary: `accepted ${read.buf.byteLength}B ${contentType} -> job ${job.id}`,
      source_id: event.source_id,
    }).catch(() => {});
    void auditSecrets(deps.storage.engine(), secretFindings, sourceUri, event.source_id ?? null).catch(() => {});

    // Fail-visible request log (fixed-shape safe params: no caller-controlled
    // keys, no content). Fire-and-forget — never blocks the 202.
    void deps.storage
      .engine()
      .query(
        `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params)
         VALUES ($1, $2, $3, $4, $5, $6::text::jsonb)`,
        [
          auth.clientId,
          auth.clientId,
          "webhook_ingest",
          0,
          "success",
          JSON.stringify({
            content_type: contentType,
            content_hash: contentHash,
            bytes: read.buf.byteLength,
            job_id: job.id,
          }),
        ],
      )
      .catch(() => {});

    return Response.json(
      {
        job_id: job.id,
        content_hash: contentHash,
        source_id: event.source_id,
        message: "Accepted. Event queued for ingestion.",
      },
      { status: 202 },
    );
  } catch (e) {
    console.error(
      "[memrain] POST /ingest queue submission error:",
      e instanceof Error ? e.message : e,
    );
    return err(500, "queue_submission_failed", "could not queue the event");
  }
}

/**
 * The submitter half of a queued ingest job id: the write source and the
 * credential reference the job runs under. One OAuth client can front several
 * people, so the client id alone would fold a second tenant's identical bytes
 * into the first tenant's job. Hashed so the id carries no token hash and no
 * caller-chosen separator.
 */
function ingestSubmitterKey(sourceId: string, auth: AuthInfo): string {
  const p = auth.principal;
  const identity = JSON.stringify([sourceId, p?.kind ?? null, p?.id ?? null, p && p.kind !== "pat" ? p.client_id : null]);
  return createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 32);
}

/** True when every part of a session at `base` (`<base>-p<n>`) falls under
 *  one of the prefixes: the prefix must be a directory above the base. */
function sessionUnderPrefixes(base: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => base.startsWith(p.endsWith("/") ? p : `${p}/`));
}

/**
 * A Codex or Claude Code session log pushed by `memrain transcripts push`.
 * Same gates as a capture (the caller's write source, the slug-prefix fence,
 * a credential scan before anything is queued), then the log is parsed here
 * so an unreadable one is refused now rather than failing in the worker.
 * Errors name counts and reasons, never the log's text.
 */
async function handleTranscriptPush(deps: IngestRouteDeps, auth: AuthInfo, buf: Uint8Array): Promise<Response> {
  if (looksBinary(buf)) {
    return err(415, "binary_content", "a transcript push takes a JSONL session log; the body is a binary file");
  }
  const writeSourceRaw = effectiveWriteSourceIdForIngress(auth, { failClosed: tenantFailClosedEnabled() });
  if (isNoSourceSentinel(writeSourceRaw)) {
    return err(403, "permission_denied", "no write source is granted to this client for POST /ingest");
  }
  const sourceId = writeSourceRaw ?? "default";

  const { sessions, diagnostics } = parseTranscriptJsonl(new TextDecoder().decode(buf), buf.byteLength);
  if (diagnostics.user_turns_missing > 0) {
    return err(
      400,
      "user_turns_missing",
      `read as ${diagnostics.format ?? "unknown"}: assistant turns but no user turn; the session log format may have changed, nothing was queued`,
    );
  }
  if (sessions.length === 0 && diagnostics.empty_sessions > 0 && !diagnostics.format_drift) {
    return Response.json({ ok: true, queued: false, reason: "empty_session", format: diagnostics.format }, { status: 200 });
  }
  if (sessions.length === 0) {
    const reasons = [...new Set(diagnostics.skipped.map((s) => s.reason))].join("; ");
    return err(
      400,
      "transcript_unreadable",
      `no session in ${diagnostics.items} records (format ${diagnostics.format ?? "not recognised"}, ` +
        `${diagnostics.malformed_lines ?? 0} malformed lines${reasons ? `, ${reasons}` : ""}); nothing was queued`,
    );
  }
  if (sessions.some((s) => !JSONL_TRANSCRIPT_FORMATS.has(s.format))) {
    return err(415, "unsupported_transcript", "a transcript push takes a Codex or Claude Code session log");
  }

  const boundPrefixes = auth.boundSlugPrefixes;
  if (boundPrefixes && boundPrefixes.length > 0) {
    const outside = sessions.map(sessionBaseSlug).filter((base) => !sessionUnderPrefixes(base, boundPrefixes));
    if (outside.length > 0) {
      return err(403, "permission_denied", `${outside.length} session(s) fall outside this client's bound prefixes`);
    }
  }

  // Scanned after the tenancy gates, as a capture is: the queued sessions sit
  // in the jobs table, so they hold redacted text only.
  const prepared: PreparedSession[] = [];
  try {
    for (const s of sessions) prepared.push(prepareSession(s));
  } catch (e) {
    if (e instanceof SecretRejectedError) {
      void auditRejection(deps.storage.engine(), e, `transcript-push:${auth.clientId}`, sourceId).catch(() => {});
    }
    return err(400, "secret_in_content", e instanceof Error ? e.message : "credential in content");
  }
  // A `\ud800` or `\u0000` escape in a JSON line becomes a lone surrogate or
  // a NUL only once parsed, so the raw body cannot show it; jsonb refuses both.
  if (prepared.some((p) => JSON.stringify(p.session) !== JSON.stringify(wellFormJsonbValue(p.session)))) {
    return err(400, "invalid_content", "a session carries U+0000 or an unpaired surrogate; nothing was queued");
  }

  const contentHash = createHash("sha256").update(buf).digest("hex");
  const ref = `push:${auth.clientId}:${contentHash.slice(0, 12)}`;
  try {
    const job = await new Queue(deps.storage.engine()).enqueue({
      kind: TRANSCRIPTS_INGEST_JOB_KIND,
      id: `ingest:transcript:${auth.clientId}:${ingestSubmitterKey(sourceId, auth)}:${contentHash}`,
      payload: {
        source_id: sourceId,
        client_id: auth.clientId,
        ref,
        sessions: prepared.map((p) => p.session),
        ...(boundPrefixes && boundPrefixes.length > 0 ? { bound_slug_prefixes: boundPrefixes } : {}),
        ...(auth.principal ? { principal: auth.principal } : {}),
      },
    });
    const parts = prepared.reduce((n, p) => n + p.parts.length, 0);
    void logIngest(deps.storage.engine(), {
      source_type: "transcripts:push",
      source_ref: ref,
      pages_updated: [],
      summary: `accepted ${buf.byteLength}B ${diagnostics.format} log, ${sessions.length} sessions, ${parts} parts -> job ${job.id}`,
      source_id: sourceId,
    }).catch(() => {});
    for (const p of prepared) {
      void auditSecrets(deps.storage.engine(), p.findings, p.base, sourceId).catch(() => {});
    }
    return Response.json(
      {
        job_id: job.id,
        content_hash: contentHash,
        source_id: sourceId,
        format: diagnostics.format,
        sessions: sessions.length,
        parts,
        user_turns: diagnostics.user_turns,
        message: "Accepted. Transcript queued for ingestion.",
      },
      { status: 202 },
    );
  } catch (e) {
    console.error("[memrain] POST /ingest transcript queue error:", e instanceof Error ? e.message : e);
    return err(500, "queue_submission_failed", "could not queue the transcript");
  }
}

const INGEST_TERMINAL_CODES: ReadonlySet<string> = new Set([
  "permission_denied", "insufficient_scope", "invalid_params", "secret_detected", "secret_rejected",
  "quarantined", "page_quarantined", "page_shrink_refused", "page_too_large",
]);

/**
 * The write authority a queued job runs under, read from the credential that
 * queued it as it stands now. The payload says WHICH credential (a non-bearer
 * reference), never what it may do: a token revoked, a client deleted, or a
 * grant narrowed away from the write scope or the job's source while the job
 * waited refuses the job for good. A job with no reference predates this and
 * cannot be tied to one credential, so it is refused too; the raw capture
 * stays on the job row.
 */
async function liveWriteAuth(storage: Storage, rawPrincipal: unknown, sourceId: string, job: string): Promise<AuthInfo> {
  const ref = parsePrincipalRef(rawPrincipal);
  if (!ref) throw new UnrecoverableJobError(`refused: ${job}: the job names no principal to re-check`);
  let grant: PrincipalGrant;
  try {
    grant = await new OAuthProvider({ engine: storage.engine() }).resolvePrincipal(ref);
  } catch (e) {
    if (e instanceof InvalidTokenError) throw new UnrecoverableJobError(`refused: ${job}: ${e.message.toLowerCase()}`);
    throw e;
  }
  const { clientName: _clientName, ...live } = grant;
  const auth: AuthInfo = { token: "", ...live, principal: ref, isPublic: false };
  if (!hasScope(auth.scopes, "write")) {
    throw new UnrecoverableJobError(`refused: ${job}: the credential no longer holds the write scope`);
  }
  const writeSource = effectiveWriteSourceIdForIngress(auth, { failClosed: tenantFailClosedEnabled() });
  if (isNoSourceSentinel(writeSource) || (writeSource ?? "default") !== sourceId) {
    throw new UnrecoverableJobError(`refused: ${job}: the credential no longer writes to the job's source`);
  }
  const source = await storage.engine().query(`SELECT 1 FROM sources WHERE id = $1`, [sourceId]);
  if (source.rows.length === 0) throw new UnrecoverableJobError(`refused: ${job}: the job's source no longer exists`);
  return auth;
}

/**
 * Register the `ingest_capture` worker handler. The capture lands through the
 * SAME `page_put` dispatch path MCP writes use — link sync, search mirror,
 * and on-write extraction all apply — with a synthetic AuthInfo carrying the
 * event's source so tenancy stamping matches the submitting client.
 */
export function registerIngestCaptureHandler(storage: Storage): void {
  registerHandler(INGEST_CAPTURE_JOB_KIND, async (payload, ctx) => {
    const event = payload.event as IngestionEvent | undefined;
    if (!event) throw new UnrecoverableJobError("refused: ingest_capture: payload.event is required");
    const invalid = validateIngestionEvent(event);
    if (invalid) throw new UnrecoverableJobError(`refused: ingest_capture: invalid event: ${invalid}`);

    const metaSlug =
      typeof event.metadata?.slug === "string" ? (event.metadata.slug as string) : undefined;
    const slug =
      typeof payload.slug === "string" && payload.slug.length > 0
        ? payload.slug
        : metaSlug ?? defaultSlugForEvent(event);

    // The live grant, not the prefixes or client recorded at admission, fences
    // the write: dispatch confines it to the credential's current prefixes.
    const auth = await liveWriteAuth(storage, payload.principal, event.source_id, "ingest_capture");
    if (auth.boundSlugPrefixes && auth.boundSlugPrefixes.length > 0 && !slugUnderPrefixes(slug, auth.boundSlugPrefixes)) {
      throw new UnrecoverableJobError("refused: ingest_capture: the slug is outside the credential's bound prefixes");
    }
    // An abandoned attempt must not write: the one that re-claimed the row will.
    ctx.signal?.throwIfAborted();
    const result = await dispatchTool(
      storage,
      {
        name: "page_put",
        arguments: {
          slug,
          markdown_body: event.content,
          written_by: `webhook:${auth.clientId}`,
        },
      },
      { isPublic: false, authInfo: auth },
    );
    const text = result.content?.[0]?.text ?? "{}";
    if (result.isError) {
      let code: unknown;
      try { code = (JSON.parse(text) as { error?: unknown })?.error; } catch { /* Unknown failures remain retryable. */ }
      if (typeof code === "string" && INGEST_TERMINAL_CODES.has(code)) {
        throw new UnrecoverableJobError(`refused: ingest_capture: page_put ${code}`);
      }
      throw new Error(`ingest_capture: page_put failed: ${text.slice(0, 300)}`);
    }
    let put: Record<string, unknown> = {};
    try {
      put = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* non-JSON tool output — keep the audit fields below */
    }
    return {
      slug,
      ...put,
      untrusted_payload: event.untrusted_payload === true,
      source_kind: event.source_kind,
      source_uri: event.source_uri,
    };
  });

  // A pushed session log: the ingress already parsed, fenced and scanned it;
  // the shape and the fence are checked again because the payload has been
  // through the queue.
  registerHandler(TRANSCRIPTS_INGEST_JOB_KIND, async (payload, ctx) => {
    const sourceId = payload.source_id;
    if (typeof sourceId !== "string" || sourceId === "") throw new UnrecoverableJobError("refused: transcripts_ingest: payload.source_id is required");
    const sessions = sessionsFromPayload(payload.sessions);
    if (typeof sessions === "string") throw new UnrecoverableJobError(`refused: transcripts_ingest: ${sessions}`);
    const boundRaw = payload.bound_slug_prefixes;
    if (boundRaw !== undefined) {
      if (!Array.isArray(boundRaw) || !boundRaw.every((p) => typeof p === "string")) {
        throw new UnrecoverableJobError("refused: transcripts_ingest: bound_slug_prefixes must be strings");
      }
      if (boundRaw.length > 0 && sessions.some((s) => !sessionUnderPrefixes(sessionBaseSlug(s), boundRaw as string[]))) {
        throw new UnrecoverableJobError("refused: transcripts_ingest: a session falls outside the client's bound prefixes");
      }
    }
    const auth = await liveWriteAuth(storage, payload.principal, sourceId, "transcripts_ingest");
    const live = auth.boundSlugPrefixes;
    if (live && live.length > 0 && sessions.some((s) => !sessionUnderPrefixes(sessionBaseSlug(s), live))) {
      throw new UnrecoverableJobError("refused: transcripts_ingest: a session falls outside the credential's bound prefixes");
    }
    const ref = typeof payload.ref === "string" ? payload.ref : "push";
    const run = () =>
      ingestSessions(storage, sessions, { sourceId, ref, remote: true, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    // Paid calls book under who the credential spends as now; the cap is looked
    // up when each call books, so a cap lowered after the push binds the job.
    const result = await runWithSpendClient({ clientId: auth.spendId ?? auth.clientId }, run);
    return { ...result };
  });
}
