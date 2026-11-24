/**
 * The engine-side doctor checks, shared by `memrain doctor` and the
 * `run_doctor` tool: schema, counts, embed coverage, locks, housekeeping,
 * indexes, quarantine, secrets and OAuth clients. Each probe turns its own
 * failure into a `warn` (core/doctor-categories.ts), so one unreadable probe
 * never makes a serving brain look broken. Read-only; no model is called.
 */
import type { Storage } from "./storage.ts";
import type { Engine } from "./engine/interface.ts";
import { couldNotCheck, worstStatus, type CheckStatus, type CheckVerdict } from "./doctor-categories.ts";
import {
  checkDanglingSlugRedirects,
  checkDuplicatePages,
  checkEmbeddingWidth,
  checkInvalidIndexes,
  checkQuarantinedPages,
  checkRuntimeConfigOverlay,
  checkSchemaVersion,
  checkStaleLocks,
  type OpsCheckResult,
} from "./doctor-ops.ts";
import { checkDbBackends, checkJsonbIntegrity, checkPageVersionStorage } from "./doctor-storage.ts";
import { checkSecretExposure, checkSecretStore } from "./doctor-secrets.ts";
import { checkOauthClientHygiene } from "./doctor-oauth.ts";
import { brainHealthMetrics } from "./source-health.ts";
import { lastHousekeepingRun } from "./housekeeping.ts";
import { checkRuntimeConfigValues } from "./runtime-config-schema.ts";

/** Housekeeping runs hourly; older than this, the serving process is not running it. */
const HOUSEKEEPING_STALE_MS = 3 * 60 * 60 * 1000;

/**
 * Tables an earlier build filled for features this one does not have. Their
 * rows stay as they are, readable again by a build that has those features.
 */
const UNUSED_FEATURE_TABLES = [
  "entity_facts", "timeline_events", "hot_memory", "synth_takes", "synth_atoms", "synth_concepts",
  "synth_contradictions", "connector_accounts", "connector_items", "chat_threads", "chat_messages",
  "jobs", "open_loops", "loop_threads", "notifications", "eval_candidates", "eval_queries",
  "retrieval_feedback", "trust_proposals", "groups",
] as const;

function verdict(name: string, r: OpsCheckResult): CheckVerdict {
  return { name, ok: r.ok, status: r.status, detail: r.detail };
}

async function statsCheck(storage: Storage): Promise<CheckVerdict> {
  const s = await storage.stats();
  return {
    name: "stats",
    ok: s.documents >= 0 && s.chunks >= 0,
    status: "ok",
    detail: `${s.documents} documents / ${s.chunks} chunks / ${s.embeddings} embeddings`,
  };
}

/**
 * Embed coverage of the embeddable chunks. Below half is a `warn`, never a
 * fail: keyword search still finds the rest, and housekeeping embeds the gaps.
 */
async function embedCoverageCheck(engine: Engine): Promise<CheckVerdict> {
  const h = await brainHealthMetrics(engine);
  const pct = (h.embed_coverage_pct * 100).toFixed(1);
  const low = h.embeddable_chunks > 0 && h.embed_coverage_pct < 0.5;
  return {
    name: "embed-coverage",
    ok: true,
    status: low ? "warn" : "ok",
    detail: `${pct}% (${h.embedded_chunks}/${h.embeddable_chunks} embeddable)` +
      (low ? "; housekeeping embeds the gaps hourly, or run memrain embed" : ""),
  };
}

async function housekeepingCheck(engine: Engine, now: Date): Promise<CheckVerdict> {
  const last = await lastHousekeepingRun(engine);
  if (last === null) {
    return { name: "housekeeping", ok: true, status: "ok", detail: "has not run yet; it runs hourly while memrain serve is up" };
  }
  const age = now.getTime() - Date.parse(last.finishedAt);
  const stale = Number.isFinite(age) && age > HOUSEKEEPING_STALE_MS;
  const failed = last.errors > 0;
  return {
    name: "housekeeping",
    ok: true,
    status: stale || failed ? "warn" : "ok",
    detail: `last finished ${last.finishedAt}` +
      (failed ? `; ${last.errors} step(s) failed, see the serve log` : "") +
      (stale ? "; older than 3 hours, so the serving process is not running it" : ""),
  };
}

/** Informational: rows a pre-Lite brain holds for features this build does not have. */
async function unusedFeatureDataCheck(engine: Engine): Promise<CheckVerdict> {
  const counts = await Promise.all(UNUSED_FEATURE_TABLES.map(async (table) => {
    try {
      // scope: operator-only the doctor counts whole tables, never their content
      const r = await engine.query<{ n: number | string }>(`SELECT count(*)::bigint AS n FROM ${table}`);
      return Number(r.rows[0]?.n ?? 0);
    } catch {
      return 0;
    }
  }));
  const total = counts.reduce((a, b) => a + b, 0);
  return {
    name: "unused-feature-data",
    ok: true,
    status: "ok",
    detail: total === 0
      ? "no pre-Lite feature data"
      : `pre-Lite feature data present, unused by Lite: ${total} rows (kept as is)`,
  };
}

/** Every engine check, in report order. */
export async function liteEngineChecks(storage: Storage, now: Date = new Date()): Promise<CheckVerdict[]> {
  const engine = storage.engine();
  const probes: [string, () => Promise<CheckVerdict>][] = [
    ["schema-version", async () => verdict("schema-version", await checkSchemaVersion(engine))],
    ["stats", () => statsCheck(storage)],
    ["embed-coverage", () => embedCoverageCheck(engine)],
    ["embedding-width", async () => verdict("embedding-width", await checkEmbeddingWidth(engine))],
    ["invalid-indexes", async () => verdict("invalid-indexes", await checkInvalidIndexes(engine))],
    ["stale-locks", async () => verdict("stale-locks", await checkStaleLocks(engine))],
    ["housekeeping", () => housekeepingCheck(engine, now)],
    ["runtime-config-overlay", async () => verdict("runtime-config-overlay", await checkRuntimeConfigOverlay(engine))],
    ["runtime-config-values", () => checkRuntimeConfigValues(engine)],
    ["db-backends", async () => verdict("db-backends", await checkDbBackends(engine))],
    ["jsonb-integrity", async () => verdict("jsonb-integrity", await checkJsonbIntegrity(engine))],
    ["page-version-storage", async () => verdict("page-version-storage", await checkPageVersionStorage(engine))],
    ["duplicate-pages", async () => verdict("duplicate-pages", await checkDuplicatePages(engine))],
    ["dangling-slug-redirects", async () => verdict("dangling-slug-redirects", await checkDanglingSlugRedirects(engine))],
    ["quarantined-pages", async () => verdict("quarantined-pages", await checkQuarantinedPages(engine))],
    ["secret-store", async () => verdict("secret-store", await checkSecretStore(engine))],
    ["secret-exposure", async () => verdict("secret-exposure", await checkSecretExposure(engine, now))],
    ["oauth-client-hygiene", () => checkOauthClientHygiene(engine)],
    ["unused-feature-data", () => unusedFeatureDataCheck(engine)],
  ];
  const out: CheckVerdict[] = [];
  for (const [name, probe] of probes) {
    try {
      out.push(await probe());
    } catch (e) {
      out.push(couldNotCheck(name, e));
    }
  }
  return out;
}

export interface LiteDoctorReport {
  ok: boolean;
  status: CheckStatus;
  checks: CheckVerdict[];
}

/** The `run_doctor` report: `ok` is false only when a check failed. */
export async function runLiteDoctor(storage: Storage, now: Date = new Date()): Promise<LiteDoctorReport> {
  const checks = await liteEngineChecks(storage, now);
  return { ok: checks.every((c) => c.ok), status: worstStatus(checks.map((c) => c.status)), checks };
}
