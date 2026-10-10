/**
 * Stored-secret audit: scan text already in the brain with the CURRENT
 * scanner rules.
 *
 * Write guards keep a credential out of new text, but a row stored before a
 * rule existed (or before the guards existed at all) keeps what it carried,
 * and nothing rewrites it on its own. `memrain secrets audit` walks every store
 * that holds free text in small keyset batches and reports each hit by store,
 * row, field, secret kind, fingerprint and line — never by value or preview.
 *
 * Dry run by default. With `apply` it rewrites what it found: a live page goes
 * through putPage (a new version, written by `secrets-audit`) and is mirrored
 * again; a version snapshot is rewritten in place and stamped `scrubbed_at`
 * (its hash_new then no longer matches its body); every other row is updated
 * in place, only if it still holds the text that was scanned. Each run leaves
 * one `secret_audit_runs` row, counts only, which the `secret-exposure` doctor
 * check reads.
 */
import { createHash } from "node:crypto";
import type { Engine } from "./engine/interface.ts";
import type { Storage } from "./storage.ts";
import { logIngest } from "./ingest-log.ts";
import { lockPageSlugs, putPage } from "./pages.ts";
import { mirrorPage, type MirrorPageOptions } from "./page-index.ts";
import {
  SECRET_SCAN_VERSION,
  describeFindings,
  scanSecrets,
  type EchoDictionary,
  type SecretFinding,
} from "./secret-scan.ts";

export const AUDIT_STORES = [
  "pages",
  "page_versions",
  "entity_facts",
  "timeline_events",
  "synth_atoms",
  "synth_takes",
  "synth_take_grades",
  "synth_concepts",
  "synth_contradictions",
  "chunks",
  "raw_data",
] as const;
export type AuditStore = (typeof AUDIT_STORES)[number];

const BATCH = 200;
const DEFAULT_HIT_LIMIT = 500;

/** One credential found in a stored row. Never carries the value. */
export interface SecretAuditHit {
  kind: AuditStore;
  /** The row: a slug, `slug@vN`, a chunk id, or a numeric id. */
  ref: string;
  field: string;
  secret_kind: string;
  fingerprint: string;
  /** 1-based line in a text field; null for JSON fields. */
  line: number | null;
}

export interface SecretAuditResult {
  run_id: number | null;
  scan_version: number;
  started_at: string;
  finished_at: string;
  source_id: string | null;
  kinds: AuditStore[];
  /** Stores left out because they carry no source column and a source was given. */
  skipped_kinds: AuditStore[];
  applied: boolean;
  rows_scanned: number;
  rows_affected: number;
  hits_total: number;
  by_kind: Record<string, number>;
  by_secret_kind: Record<string, number>;
  code_chunks_affected: number;
  /** Rows rewritten under `apply`. */
  rows_rewritten: number;
  hits: SecretAuditHit[];
  hits_truncated: boolean;
  /** Rows an `apply` could not rewrite, by store and ref (no text). */
  errors: string[];
}

export interface SecretAuditOptions {
  sourceId?: string;
  kinds?: AuditStore[];
  apply?: boolean;
  /** Most hits listed in the result; the counts always cover every hit. Default 500. */
  limit?: number;
  now?: () => Date;
  /** Test seam for the page re-mirror. */
  mirror?: Pick<MirrorPageOptions, "embedFn" | "contextualLlmFn">;
}

interface StoreSpec {
  store: AuditStore;
  /** FROM clause; the audited table is aliased `t`. */
  from: string;
  /** Keyset columns, in order, as `t.<col>`. */
  keys: string[];
  text: string[];
  json: string[];
  sourceCol: string | null;
  extra?: string;
}

const SPECS: Record<AuditStore, StoreSpec> = {
  pages: {
    store: "pages",
    from: "pages t",
    keys: ["slug"],
    text: ["title", "markdown_body"],
    json: ["compiled_truth"],
    sourceCol: "source_id",
    extra: `t.type, t.source_id, t.deleted_at::text AS deleted_at,
            (SELECT COALESCE(MAX(v.version_n), 0)::int FROM page_versions v WHERE v.slug = t.slug) AS version_n`,
  },
  page_versions: {
    store: "page_versions",
    from: "page_versions t",
    keys: ["slug", "version_n"],
    text: ["body_snapshot"],
    json: ["compiled_truth_snapshot"],
    sourceCol: "source_id",
  },
  entity_facts: { store: "entity_facts", from: "entity_facts t", keys: ["id"], text: ["fact", "context"], json: [], sourceCol: "source_id" },
  timeline_events: { store: "timeline_events", from: "timeline_events t", keys: ["id"], text: ["event", "detail"], json: [], sourceCol: "source_id" },
  synth_atoms: { store: "synth_atoms", from: "synth_atoms t", keys: ["id"], text: ["title", "body", "source_quote", "lesson"], json: [], sourceCol: null },
  synth_takes: { store: "synth_takes", from: "synth_takes t", keys: ["id"], text: ["claim_text"], json: [], sourceCol: null },
  synth_take_grades: { store: "synth_take_grades", from: "synth_take_grades t", keys: ["id"], text: ["reasoning"], json: [], sourceCol: null },
  synth_concepts: { store: "synth_concepts", from: "synth_concepts t", keys: ["id"], text: ["title", "narrative"], json: [], sourceCol: null },
  synth_contradictions: { store: "synth_contradictions", from: "synth_contradictions t", keys: ["id"], text: ["a_text", "b_text"], json: [], sourceCol: "source_id" },
  chunks: {
    store: "chunks",
    from: "chunks t LEFT JOIN documents d ON d.id = t.document_id",
    keys: ["id"],
    text: ["content", "doc_comment"],
    json: [],
    sourceCol: "source_id",
    extra: `COALESCE(d.frontmatter->>'kind' = 'code', false) AS is_code`,
  },
  raw_data: { store: "raw_data", from: "raw_data t", keys: ["id"], text: [], json: ["data"], sourceCol: null },
};

export function isAuditStore(value: string): value is AuditStore {
  return (AUDIT_STORES as readonly string[]).includes(value);
}

/** On unless the variable says `0`, `false`, `off` or `no` — the scanner's own switches. */
function switchedOn(name: string): boolean {
  return !["0", "false", "off", "no"].includes((process.env[name] ?? "").trim().toLowerCase());
}

/** The same allow-list the write guards honour (16-64 hex prefixes of the SHA-256). */
function allowedFingerprints(): Set<string> {
  const allow = new Set<string>();
  for (const entry of (process.env.MEMRAIN_SECRET_SCAN_ALLOW ?? "").split(",")) {
    const s = entry.trim().toLowerCase();
    if (/^[0-9a-f]{16,64}$/.test(s)) allow.add(s);
  }
  return allow;
}

const MARKER = /\[REDACTED:[a-z0-9-]{1,64}:[0-9a-f]{16}\]/g;

function markerCounts(line: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const hit of line.matchAll(MARKER)) m.set(hit[0], (m.get(hit[0]) ?? 0) + 1);
  return m;
}

/**
 * The line each finding landed on. The scan keeps line numbers (a key block
 * becomes its marker plus the newlines it spanned), so a marker on output line
 * n that line n of the stored text did not already carry is a new hit there.
 */
function findingLines(before: string, after: string, findings: SecretFinding[]): Array<number | null> {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length !== b.length) return findings.map(() => null);
  const queues = new Map<string, number[]>();
  for (let i = 0; i < b.length; i++) {
    if (!b[i]!.includes("[REDACTED:")) continue;
    const had = markerCounts(a[i]!);
    for (const [marker, n] of markerCounts(b[i]!)) {
      const fresh = n - (had.get(marker) ?? 0);
      for (let k = 0; k < fresh; k++) {
        const q = queues.get(marker) ?? [];
        q.push(i + 1);
        queues.set(marker, q);
      }
    }
  }
  return findings.map((f) => queues.get(`[REDACTED:${f.kind}:${f.fingerprint}]`)?.shift() ?? null);
}

interface FieldScan {
  value: unknown;
  hits: Array<{ field: string; secret_kind: string; fingerprint: string; line: number | null }>;
}

function scanText(text: string, field: string, echo: EchoDictionary | false, allow: ReadonlySet<string>, highEntropy: boolean): FieldScan {
  const r = scanSecrets(text, allow, { echo, preserveLines: true, highEntropy });
  if (r.findings.length === 0) return { value: text, hits: [] };
  const lines = findingLines(text, r.text, r.findings);
  return {
    value: r.text,
    hits: r.findings.map((f, i) => ({ field, secret_kind: f.kind, fingerprint: f.fingerprint, line: lines[i] ?? null })),
  };
}

function scanJson(value: unknown, field: string, echo: EchoDictionary | false, allow: ReadonlySet<string>, highEntropy: boolean): FieldScan {
  const hits: FieldScan["hits"] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = scanSecrets(v, allow, { echo, highEntropy });
      for (const f of r.findings) hits.push({ field, secret_kind: f.kind, fingerprint: f.fingerprint, line: null });
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[walk(k) as string] = walk(inner);
      return out;
    }
    return v;
  };
  const out = walk(value);
  return { value: hits.length > 0 ? out : value, hits };
}

function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

type Row = Record<string, unknown>;

function refOf(spec: StoreSpec, row: Row): string {
  if (spec.store === "page_versions") return `${String(row.slug)}@v${String(row.version_n)}`;
  return String(row[spec.keys[0]!]);
}

/** Error text without the message: a driver error can quote the row it failed on. */
function errorTag(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" && code.length > 0) return code;
  return e instanceof Error ? e.name : "error";
}

async function fetchBatch(engine: Engine, spec: StoreSpec, cursor: unknown[] | null, sourceId: string | undefined): Promise<Row[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (cursor) {
    const placeholders = cursor.map((v) => {
      params.push(v);
      return `$${params.length}`;
    });
    where.push(`(${spec.keys.map((k) => `t.${k}`).join(", ")}) > (${placeholders.join(", ")})`);
  }
  if (sourceId !== undefined && spec.sourceCol) {
    params.push(sourceId);
    where.push(`t.${spec.sourceCol} = $${params.length}`);
  }
  const cols = [...spec.keys, ...spec.text, ...spec.json].map((c) => `t.${c}`);
  if (spec.extra) cols.push(spec.extra);
  params.push(BATCH);
  const r = await engine.query<Row>(
    `SELECT ${cols.join(", ")}
       FROM ${spec.from}
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${spec.keys.map((k) => `t.${k}`).join(", ")}
      LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

/** Rewrite one row with its redacted fields. Returns false when the row moved on since the scan. */
async function applyRow(
  storage: Storage,
  spec: StoreSpec,
  row: Row,
  next: Record<string, unknown>,
  opts: SecretAuditOptions,
): Promise<boolean> {
  const engine = storage.engine();
  if (spec.store === "pages" && row.deleted_at === null) {
    const put = await putPage(storage, {
      slug: String(row.slug),
      type: String(row.type),
      allowAdHocType: true,
      title: (next.title ?? row.title ?? undefined) as string | undefined,
      markdown_body: String(next.markdown_body ?? row.markdown_body ?? ""),
      allowEmptyBody: true,
      compiled_truth: (next.compiled_truth ?? parseJson(row.compiled_truth) ?? {}) as Record<string, unknown>,
      written_by: "secrets-audit",
      expectedVersion: Number(row.version_n),
    });
    await mirrorPage(
      storage,
      {
        slug: String(row.slug),
        title: (next.title ?? row.title ?? null) as string | null,
        markdown_body: String(next.markdown_body ?? row.markdown_body ?? ""),
        content_hash: put.content_hash,
        source_id: row.source_id as string | null,
      },
      { remote: false, timingLabel: "secrets-audit", ...(opts.mirror ?? {}) },
    );
    return true;
  }
  const fields = Object.keys(next);
  const params: unknown[] = [];
  const sets = fields.map((f) => {
    const isJson = spec.json.includes(f);
    params.push(isJson ? JSON.stringify(next[f]) : next[f]);
    return `${f} = $${params.length}${isJson ? "::text::jsonb" : ""}`;
  });
  if (spec.store === "page_versions") sets.push("scrubbed_at = now()");
  if (spec.store === "pages" && typeof next.markdown_body === "string") {
    params.push(createHash("sha256").update(next.markdown_body, "utf8").digest("hex"));
    sets.push(`content_hash = $${params.length}`);
  }
  const guards = spec.keys.map((k) => {
    params.push(row[k]);
    return `${k} = $${params.length}`;
  });
  // A page restored since the scan is live again: it needs a new version and
  // a re-mirror, which the next run gives it.
  if (spec.store === "pages") guards.push("deleted_at IS NOT NULL");
  // Only if the row still holds what was scanned: a concurrent edit wins.
  for (const f of fields) {
    const isJson = spec.json.includes(f);
    params.push(isJson ? JSON.stringify(parseJson(row[f])) : row[f]);
    guards.push(`${f} IS NOT DISTINCT FROM $${params.length}${isJson ? "::text::jsonb" : ""}`);
  }
  const table = spec.from.split(" ")[0]!;
  const sql = `UPDATE ${table} SET ${sets.join(", ")} WHERE ${guards.join(" AND ")}`;
  if (spec.store === "pages" || spec.store === "page_versions") {
    return engine.transaction(async (tx) => {
      await lockPageSlugs(tx, String(row.slug));
      const r = await tx.query<{ ok: number }>(`${sql} RETURNING 1 AS ok`, params);
      return r.rows.length > 0;
    });
  }
  const r = await engine.query<{ ok: number }>(`${sql} RETURNING 1 AS ok`, params);
  return r.rows.length > 0;
}

/**
 * Scan the stored text of every selected store. Never returns, logs or stores
 * a matched value; `apply` rewrites what it found.
 */
export async function auditStoredSecrets(storage: Storage, opts: SecretAuditOptions = {}): Promise<SecretAuditResult> {
  const engine = storage.engine();
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const requested = opts.kinds && opts.kinds.length > 0 ? AUDIT_STORES.filter((k) => opts.kinds!.includes(k)) : [...AUDIT_STORES];
  const kinds = opts.sourceId === undefined ? requested : requested.filter((k) => SPECS[k].sourceCol !== null);
  const skipped = requested.filter((k) => !kinds.includes(k));
  const limit = opts.limit ?? DEFAULT_HIT_LIMIT;
  const allow = allowedFingerprints();
  const highEntropy = switchedOn("MEMRAIN_SECRET_SCAN_HIGH_ENTROPY");
  const echoOn = switchedOn("MEMRAIN_SECRET_SCAN_ECHO");

  const run = await engine.query<{ id: number }>(
    `INSERT INTO secret_audit_runs (scan_version, started_at, source_id, kinds, applied)
     VALUES ($1, $2, $3, $4::text[], $5) RETURNING id`,
    [SECRET_SCAN_VERSION, startedAt, opts.sourceId ?? null, kinds, opts.apply === true],
  );
  const runId = run.rows[0]?.id !== undefined ? Number(run.rows[0].id) : null;

  const result: SecretAuditResult = {
    run_id: runId,
    scan_version: SECRET_SCAN_VERSION,
    started_at: startedAt,
    finished_at: startedAt,
    source_id: opts.sourceId ?? null,
    kinds,
    skipped_kinds: skipped,
    applied: opts.apply === true,
    rows_scanned: 0,
    rows_affected: 0,
    hits_total: 0,
    by_kind: {},
    by_secret_kind: {},
    code_chunks_affected: 0,
    rows_rewritten: 0,
    hits: [],
    hits_truncated: false,
    errors: [],
  };

  for (const store of kinds) {
    const spec = SPECS[store];
    let cursor: unknown[] | null = null;
    for (;;) {
      const rows = await fetchBatch(engine, spec, cursor, opts.sourceId);
      if (rows.length === 0) break;
      for (const row of rows) {
        cursor = spec.keys.map((k) => row[k]);
        result.rows_scanned += 1;
        // One echo dictionary per row, shared by its fields, as on the write path.
        const echo: EchoDictionary | false = echoOn ? new Map() : false;
        const next: Record<string, unknown> = {};
        const hits: FieldScan["hits"] = [];
        // Echo-dictionary size when each text field was scanned: a field
        // scanned before a later field claimed a value is swept again below.
        const echoSizeAt = new Map<string, number>();
        for (const f of spec.text) {
          const v = row[f];
          if (typeof v !== "string" || v.length === 0) continue;
          const s = scanText(v, f, echo, allow, highEntropy);
          if (s.hits.length > 0) next[f] = s.value;
          hits.push(...s.hits);
          echoSizeAt.set(f, echo ? echo.size : 0);
        }
        for (const f of spec.json) {
          const v = parseJson(row[f]);
          if (v === null || v === undefined) continue;
          const s = scanJson(v, f, echo, allow, highEntropy);
          if (s.hits.length > 0) next[f] = s.value;
          hits.push(...s.hits);
        }
        if (echo) {
          for (const [f, size] of echoSizeAt) {
            if (echo.size === size) continue;
            // Markers are never claimed again, so only the late echoes are new.
            const current = (next[f] ?? row[f]) as string;
            const s = scanText(current, f, echo, allow, highEntropy);
            if (s.hits.length > 0) next[f] = s.value;
            hits.push(...s.hits);
          }
        }
        if (hits.length === 0) continue;
        const ref = refOf(spec, row);
        result.rows_affected += 1;
        result.hits_total += hits.length;
        result.by_kind[store] = (result.by_kind[store] ?? 0) + hits.length;
        if (store === "chunks" && row.is_code === true) result.code_chunks_affected += 1;
        for (const h of hits) {
          result.by_secret_kind[h.secret_kind] = (result.by_secret_kind[h.secret_kind] ?? 0) + 1;
          if (result.hits.length < limit) result.hits.push({ kind: store, ref, ...h });
          else result.hits_truncated = true;
        }
        if (!opts.apply) continue;
        try {
          if (await applyRow(storage, spec, row, next, opts)) {
            result.rows_rewritten += 1;
            await logIngest(engine, {
              source_type: "secret-audit-redacted",
              source_ref: `${store}:${ref}`,
              summary: describeFindings(hits.map((h) => ({ kind: h.secret_kind, fingerprint: h.fingerprint }))),
              ...(typeof row.source_id === "string" && row.source_id.length > 0 ? { source_id: row.source_id } : {}),
            });
          } else {
            result.errors.push(`${store} ${ref}: changed since it was scanned; run the audit again`);
          }
        } catch (e) {
          result.errors.push(`${store} ${ref}: rewrite failed (${errorTag(e)})`);
        }
      }
      if (rows.length < BATCH) break;
    }
  }

  result.finished_at = now().toISOString();
  if (runId !== null) {
    await engine.query(
      `UPDATE secret_audit_runs
          SET finished_at = $2, rows_scanned = $3, rows_affected = $4, hits_total = $5,
              by_kind = $6::text::jsonb, by_secret_kind = $7::text::jsonb, code_chunks_affected = $8,
              rows_rewritten = $9, errors_total = $10
        WHERE id = $1`,
      [
        runId,
        result.finished_at,
        result.rows_scanned,
        result.rows_affected,
        result.hits_total,
        JSON.stringify(result.by_kind),
        JSON.stringify(result.by_secret_kind),
        result.code_chunks_affected,
        result.rows_rewritten,
        result.errors.length,
      ],
    );
  }
  return result;
}

export interface SecretAuditRunSummary {
  id: number;
  scan_version: number;
  started_at: string;
  finished_at: string;
  source_id: string | null;
  kinds: string[];
  applied: boolean;
  rows_affected: number;
  hits_total: number;
  code_chunks_affected: number;
  /** Rows an applied run could not rewrite. */
  errors_total: number;
}

/**
 * The latest finished whole-brain run: every store, no source filter. A
 * narrower run leaves part of the brain unscanned, so it cannot speak for it.
 */
export async function latestSecretAuditRun(engine: Engine): Promise<SecretAuditRunSummary | null> {
  const r = await engine.query<Record<string, unknown>>(
    `SELECT id, scan_version, started_at::text AS started_at, finished_at::text AS finished_at,
            source_id, kinds, applied, rows_affected, hits_total, code_chunks_affected, errors_total
       FROM secret_audit_runs
      WHERE finished_at IS NOT NULL AND source_id IS NULL AND kinds @> $1::text[]
      ORDER BY finished_at DESC, id DESC
      LIMIT 1`,
    [[...AUDIT_STORES]],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    scan_version: Number(row.scan_version),
    started_at: String(row.started_at),
    finished_at: String(row.finished_at),
    source_id: (row.source_id as string | null) ?? null,
    kinds: Array.isArray(row.kinds) ? (row.kinds as string[]) : [],
    applied: row.applied === true,
    rows_affected: Number(row.rows_affected),
    hits_total: Number(row.hits_total),
    code_chunks_affected: Number(row.code_chunks_affected),
    errors_total: Number(row.errors_total),
  };
}
