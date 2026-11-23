/**
 * Write transcript sessions into the brain as `conversation` pages.
 *
 * Per session: every message and the title are scanned for credentials
 * before anything is rendered, so under the `reject` disposition a session
 * is refused whole rather than landing with some parts written. Parts go
 * through `putPage`, whose content-hash no-op makes a re-run of an unchanged
 * export write nothing; only parts that changed are mirrored into search.
 * Parts past the session's new end (it shrank) are soft-deleted and dropped
 * from search, within the same source only.
 *
 * A session whose parts cannot be written (a part slug owned by another
 * source, or merged away) is reported as failed and the run moves on: one
 * moved or merged session must not strand every session after it.
 */
import type { Storage } from "../storage.ts";
import type { EmbedFn } from "../indexer.ts";
import { deletePage, putPage } from "../pages.ts";
import { mirrorPage, removePageFromSearch } from "../page-index.ts";
import { logIngest } from "../ingest-log.ts";
import { OperationError } from "../operation-error.ts";
import {
  auditRejection,
  auditSecrets,
  describeFindings,
  guardEchoes,
  guardSecrets,
  SecretRejectedError,
  type EchoDictionary,
  secretDisposition,
  type SecretFinding,
  fingerprintSecret,
  type SecretOriginal,
  trailingDanglingLabel,
  withSecretOriginals,
} from "../secret-scan.ts";
import { allowedSecretFingerprints } from "../secret-store.ts";
import { loadKek, seal, unseal, type Sealed } from "../vault.ts";
import { renderSession, sessionBaseSlug, type RenderedPart } from "./render.ts";
import type { TranscriptSession } from "./types.ts";
import type { TrustTier } from "../trust-tier.ts";

export const TRANSCRIPT_PAGE_TYPE = "conversation";
const WRITTEN_BY = "transcripts-ingest";
/** Slugs listed on the summary ingest_log row; the counts carry the rest. */
const LOG_SLUG_CAP = 500;

export interface PreparedSession {
  session: TranscriptSession;
  base: string;
  parts: RenderedPart[];
  findings: SecretFinding[];
  /** The values this preparation redacted, by fingerprint, for the part writes to seal. Memory only. */
  originals: Map<string, SecretOriginal>;
}

export interface PrepareSessionOptions {
  /** Fingerprints the owner allowed in the session's source (restored false positives): left in place. */
  allow?: ReadonlySet<string>;
}

/**
 * Redact (or, under `reject`, refuse) credentials across the whole session,
 * with the transcript lane's rules, then render it. Pure: throws
 * SecretRejectedError before any part exists.
 */
export function prepareSession(session: TranscriptSession, opts: PrepareSessionOptions = {}): PreparedSession {
  const base = sessionBaseSlug(session);
  const where = `transcript '${base}'`;
  const findings: SecretFinding[] = [];
  const originals = new Map<string, SecretOriginal>();
  // One dictionary for the whole session: a token claimed in message 9 is
  // also swept from the title and messages 1-8 that echoed it bare.
  const echo: EchoDictionary = new Map();
  return withSecretOriginals({ originals, allow: opts.allow ?? new Set() }, () => {
    const guard = (text: string, leadingDangling: ReturnType<typeof trailingDanglingLabel> = null): string => {
      const r = guardSecrets(text, where, { echo, transcriptRules: true, leadingDangling });
      findings.push(...r.findings);
      return r.text;
    };
    const sweep = (text: string): string => guardEchoes(text, echo, findings);
    const title = session.title === null ? null : guard(session.title);
    // A label that ends one message (`here is my API key:`) reads the first line of the next.
    const texts = session.messages.map((m, i) => guard(m.text, i > 0 ? trailingDanglingLabel(session.messages[i - 1]!.text) : null));
    const clean: TranscriptSession = {
      ...session,
      title: title === null ? null : sweep(title),
      messages: session.messages.map((m, i) => ({ ...m, text: sweep(texts[i]!) })),
    };
    return { session: clean, base, parts: renderSession(clean), findings, originals };
  });
}

/** A push's originals ride the queue sealed, never in clear; past this many the rest are not kept. */
const MAX_QUEUED_ORIGINALS = 4096;

function queuedOriginalsAad(sourceId: string, clientId: string): string {
  return `memrain:transcript-originals:v1|${sourceId}|${clientId}`;
}

/**
 * The originals a push's preparation redacted, sealed under the connector key
 * for the queued job, so the worker that writes the pages can keep them. Null
 * when there are none or no key is configured (nothing is kept, as on any write).
 */
export function sealQueuedOriginals(prepared: readonly PreparedSession[], sourceId: string, clientId: string): Sealed | null {
  const all = new Map<string, SecretOriginal>();
  let dropped = 0;
  for (const p of prepared) {
    for (const [fp, o] of p.originals) {
      if (all.has(fp)) continue;
      if (all.size < MAX_QUEUED_ORIGINALS) all.set(fp, o);
      else dropped++;
    }
  }
  if (dropped > 0) console.warn(`[transcripts_ingest] ${dropped} redacted original(s) past ${MAX_QUEUED_ORIGINALS} in one push are not kept`);
  if (all.size === 0) return null;
  const kek = loadKek().kek;
  if (kek === null) return null;
  return seal(kek, JSON.stringify([...all.values()]), queuedOriginalsAad(sourceId, clientId));
}

/** The worker's half of sealQueuedOriginals. A payload it cannot open keeps nothing; the pages are written regardless. */
export function openQueuedOriginals(raw: unknown, sourceId: string, clientId: string): Map<string, SecretOriginal> {
  const out = new Map<string, SecretOriginal>();
  if (raw === undefined || raw === null) return out;
  const kek = loadKek().kek;
  try {
    if (kek === null) throw new Error("no connector key");
    const list = JSON.parse(unseal(kek, raw as Sealed, queuedOriginalsAad(sourceId, clientId))) as unknown;
    if (!Array.isArray(list)) throw new Error("not a list");
    for (const o of list.slice(0, MAX_QUEUED_ORIGINALS) as SecretOriginal[]) {
      // An entry must be the value its fingerprint names; nothing else is kept.
      if (typeof o?.kind === "string" && typeof o.value === "string" && o.fingerprint === fingerprintSecret(o.value)) out.set(o.fingerprint, o);
    }
  } catch {
    console.warn("[transcripts_ingest] the queued redacted originals could not be opened; they are not kept");
  }
  return out;
}

export interface IngestTranscriptsOptions {
  /** Owning source for every part. Defaults to `default`. */
  sourceId?: string;
  /** Where the sessions came from, for the summary ingest_log row. */
  ref?: string;
  /** Test seam: deterministic embedder for the search mirror. */
  embedFn?: EmbedFn;
  /**
   * Write the parts but leave them out of search for now. The cycle's
   * mirror-pages phase indexes and embeds them later, a bounded batch per run,
   * so a bulk backfill does not pay for every embedding up front.
   */
  deferMirror?: boolean;
  /** Mirror as a remote write (a pushed transcript), not an operator one. */
  remote?: boolean;
  /** Ceiling on the parts' trust tier; unset, they are written as before. */
  trustTier?: TrustTier;
  /** Called for every part written or rewritten (not unchanged, not deleted). */
  onPartWritten?: (part: { slug: string; body: string; sourceId: string }) => void;
  /**
   * Checked before each session and each part write: once aborted (a job that
   * lost its lease or timed out), the run throws the signal's reason instead of
   * writing on alongside the attempt that took over.
   */
  signal?: AbortSignal;
  /** Originals redacted before the sessions got here (a push), for the part writes to seal. */
  secretOriginals?: ReadonlyMap<string, SecretOriginal>;
}

export interface IngestTranscriptsResult {
  sessions: number;
  sessions_rejected: number;
  parts_written: number;
  parts_unchanged: number;
  parts_deleted: number;
  /** Credentials found (redacted, or left in place under `flag`). */
  redactions: number;
  /** Parts whose search mirror failed; each also has a page-mirror-failed row. */
  mirror_failures: number;
  /** Parts written with the search mirror left to the cycle (`deferMirror`). */
  mirror_deferred: number;
  rejected: Array<{ id: string; reason: string }>;
  /** Sessions that could not be written; earlier parts of one may have landed. */
  sessions_failed: number;
  failed: Array<{ id: string; code: string; reason: string }>;
}

/** Part slugs this session would write that another source already owns. */
async function foreignParts(storage: Storage, prepared: PreparedSession, sourceId: string): Promise<string[]> {
  const r = await storage.engine().query<{ slug: string }>(
    `SELECT slug FROM pages WHERE slug = ANY($1::text[]) AND source_id <> $2`,
    [prepared.parts.map((p) => p.slug), sourceId],
  );
  return r.rows.map((row) => row.slug).sort();
}

/**
 * Audit a refusal once per identical finding set. A re-run of the same export
 * refuses the same session again, and a row per run would bury the first one.
 */
async function auditRejectionOnce(
  storage: Storage,
  e: SecretRejectedError,
  ref: string,
  sourceId: string,
): Promise<void> {
  const seen = await storage.engine().query(
    `SELECT 1 FROM ingest_log
      WHERE source_type = 'secret-rejected' AND source_ref = $1 AND source_id = $2 AND summary = $3
      LIMIT 1`,
    [ref, sourceId, describeFindings(e.findings)],
  );
  if (seen.rows.length === 0) await auditRejection(storage.engine(), e, ref, sourceId);
}

async function staleParts(storage: Storage, base: string, sourceId: string, keep: number): Promise<string[]> {
  const prefix = `${base}-p`;
  // A parameterized LIKE cannot use the slug index under a non-C collation;
  // the range bounds the index scan (a slug-safe prefix ends in `-p`, so `-q`
  // is its successor) and the LIKE keeps the match exact.
  const r = await storage.engine().query<{ slug: string }>(
    `SELECT slug FROM pages
      WHERE slug >= $1 AND slug < $2 AND slug LIKE $3 AND source_id = $4 AND deleted_at IS NULL`,
    [prefix, `${base}-q`, `${prefix}%`, sourceId],
  );
  return r.rows
    .map((row) => row.slug)
    .filter((slug) => {
      const tail = slug.slice(prefix.length);
      return /^\d{1,6}$/.test(tail) && Number(tail) > keep;
    })
    .sort();
}

async function writeSession(
  storage: Storage,
  prepared: PreparedSession,
  sourceId: string,
  opts: IngestTranscriptsOptions,
  result: IngestTranscriptsResult,
  touched: string[],
): Promise<void> {
  let sessionChanged = false;
  try {
    for (const part of prepared.parts) {
      opts.signal?.throwIfAborted();
      const put = await putPage(storage, {
        slug: part.slug,
        type: TRANSCRIPT_PAGE_TYPE,
        allowAdHocType: true,
        title: part.title,
        markdown_body: part.body,
        compiled_truth: part.truth,
        written_by: WRITTEN_BY,
        source_id: sourceId,
        outsideText: true,
        secretOriginals: prepared.originals,
        ...(opts.trustTier ? { trust_tier: opts.trustTier } : {}),
      });
      if (put.held) throw new OperationError("conflict", `Import held: ${put.held}`);
      const body = put.outside_body!;
      if (!put.changed && !put.created) {
        result.parts_unchanged++;
        continue;
      }
      sessionChanged = true;
      result.parts_written++;
      touched.push(part.slug);
      opts.onPartWritten?.({ slug: part.slug, body, sourceId });
      if (opts.deferMirror) {
        result.mirror_deferred++;
        continue;
      }
      const ok = await mirrorPage(
        storage,
        {
          slug: part.slug,
          title: part.title,
          markdown_body: body,
          content_hash: put.content_hash,
          source_id: sourceId,
        },
        { remote: opts.remote === true, timingLabel: "transcripts_ingest", ...(opts.embedFn ? { embedFn: opts.embedFn } : {}) },
      );
      if (!ok) result.mirror_failures++;
    }

    for (const slug of await staleParts(storage, prepared.base, sourceId, prepared.parts.length)) {
      opts.signal?.throwIfAborted();
      const del = await deletePage(storage, slug, WRITTEN_BY, sourceId);
      if (del.already_deleted) continue;
      await removePageFromSearch(storage, slug, sourceId);
      sessionChanged = true;
      result.parts_deleted++;
      touched.push(slug);
    }
  } finally {
    // Audited only when the session was written, so an unchanged re-run leaves
    // no new rows, and also when a later part failed: the parts that landed
    // hold the redactions. Under `flag` the credential is still in each part's
    // text and putPage audits every part it writes; a session row would repeat
    // that.
    if (sessionChanged && secretDisposition() !== "flag") {
      await auditSecrets(storage.engine(), prepared.findings, prepared.base, sourceId);
    }
  }
}

export async function ingestSessions(
  storage: Storage,
  sessions: readonly TranscriptSession[],
  opts: IngestTranscriptsOptions = {},
): Promise<IngestTranscriptsResult> {
  const sourceId = opts.sourceId ?? "default";
  const engine = storage.engine();
  // Checked up front: otherwise an unregistered source fails on the first
  // page insert, after the whole export was parsed and scanned.
  const known = await engine.query(`SELECT 1 FROM sources WHERE id = $1`, [sourceId]);
  if (known.rows.length === 0) {
    throw new OperationError(
      "invalid_params",
      `unknown source '${sourceId}'`,
      "Register it with `memrain sources register`, or omit --source.",
    );
  }
  const result: IngestTranscriptsResult = {
    sessions: sessions.length,
    sessions_rejected: 0,
    parts_written: 0,
    parts_unchanged: 0,
    parts_deleted: 0,
    redactions: 0,
    mirror_failures: 0,
    mirror_deferred: 0,
    rejected: [],
    sessions_failed: 0,
    failed: [],
  };
  const touched: string[] = [];
  const allow = await allowedSecretFingerprints(engine, sourceId);

  for (const session of sessions) {
    opts.signal?.throwIfAborted();
    let prepared: PreparedSession;
    try {
      prepared = prepareSession(session, { allow });
      for (const [fingerprint, original] of opts.secretOriginals ?? []) {
        if (!prepared.originals.has(fingerprint)) prepared.originals.set(fingerprint, original);
      }
    } catch (e) {
      if (!(e instanceof SecretRejectedError)) throw e;
      await auditRejectionOnce(storage, e, sessionBaseSlug(session), sourceId);
      result.sessions_rejected++;
      result.rejected.push({ id: session.id, reason: e.message });
      continue;
    }
    result.redactions += prepared.findings.length;

    const foreign = await foreignParts(storage, prepared, sourceId);
    if (foreign.length > 0) {
      result.sessions_failed++;
      result.failed.push({
        id: session.id,
        code: "permission_denied",
        // The slugs are another tenant's; a count is all this caller may learn.
        reason: `${foreign.length} part(s) owned by another source; re-run with that --source`,
      });
      continue;
    }
    try {
      await writeSession(storage, prepared, sourceId, opts, result, touched);
    } catch (e) {
      if (!(e instanceof OperationError)) throw e;
      result.sessions_failed++;
      result.failed.push({ id: session.id, code: e.code, reason: e.message });
    }
  }

  if (touched.length > 0) {
    await logIngest(engine, {
      source_type: "transcripts",
      source_ref: opts.ref ?? null,
      pages_updated: touched.slice(0, LOG_SLUG_CAP),
      summary:
        `sessions ${result.sessions}, parts written ${result.parts_written}, ` +
        `unchanged ${result.parts_unchanged}, deleted ${result.parts_deleted}, ` +
        `rejected ${result.sessions_rejected}, failed ${result.sessions_failed}, ` +
        `redactions ${result.redactions}`,
      source_id: sourceId,
    });
  }
  return result;
}
