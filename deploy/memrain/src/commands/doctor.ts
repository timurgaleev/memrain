/**
 * `memrain doctor` — self-diagnostics. Prints a structured report and
 * exits 0 on healthy / 1 on any failure. Intended to run in seconds —
 * no embedding calls or full sweeps. Suitable for cron probes and CI
 * smoke tests.
 *
 * Checks:
 *   - config file exists and parses
 *   - PGLite opens and migrations are applied
 *   - schema rows make sense (documents/chunks/embeddings counts non-negative)
 *   - vault path exists and is readable (when configured)
 *   - reports last_indexed_mtime spread (oldest / newest / count)
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { inspectDataDir, describeDataDir } from "../core/engine/pglite-diagnose.ts";
import { Storage } from "../core/storage.ts";
import { closeQuietly } from "./with-storage.ts";
import {
  loadConfig,
  defaultConfigPath,
  selfIssuedMismatch,
  LEGACY_YAML_NAME,
  YAML_NAME,
} from "../core/config.ts";
import type { Config, DatabaseConfig } from "../core/config.ts";
import {
  categorize,
  couldNotCheck,
  worstStatus,
  type CheckCategory,
  type CheckStatus,
} from "../core/doctor-categories.ts";
import { rankIssues, type RankedIssue } from "../core/doctor-cause-rank.ts";
import {
  brainHealthMetrics,
  collectPerSourceHealth,
  UNCLASSIFIED_BUCKET,
  type PerSourceHealth,
} from "../core/source-health.ts";
import { countStalePagesForExtraction, LINK_EXTRACTOR_VERSION_TS } from "../core/links.ts";
import { countStaleChunkerDocs } from "../core/chunker-version.ts";
import { checkCycleFreshness } from "../core/cycle-freshness.ts";
import {
  checkGrammars,
  checkStaleLocks,
  checkQueueHealth,
  checkSchemaVersion,
  checkEmbeddingWidth,
  checkInvalidIndexes,
  checkDuplicatePages,
  checkQuarantinedPages,
  checkJunkEntityHubs,
} from "../core/doctor-ops.ts";
import { checkConnectorHealth } from "../core/connectors/health.ts";
import { checkEmbedBacklog } from "../core/doctor-embed.ts";
import {
  checkFederationHealth,
  checkOauthClientHealth,
  checkOauthClientHygiene,
  checkPatScopesRecorded,
  checkSourceRoutingHealth,
  checkDocumentIdDrift,
} from "../core/doctor-tenancy.ts";
import { latestEvalSnapshot, type EvalSnapshotRow } from "../core/eval-snapshot.ts";
import { latestContradictionRun } from "../core/synthesis/contradictions.ts";
import { Queue } from "../core/jobs/queue.ts";
import {
  buildRemediationPlan,
  submitRemediation,
  type BrokenSource,
  type RemediationInput,
  type RemediationPlan,
} from "../core/remediation.ts";
import { VERSION } from "../version.ts";
import { legacyEnv, type LegacyEnvReport } from "../core/env-compat.ts";
import { classifyLegacyRows, listRuntimeConfig } from "../core/runtime-config.ts";

/**
 * Detail line for the engine check.
 *
 * Exported and pure because the bug it fixes is invisible from the pglite side:
 * `path` exists only on the pglite variant, so reading it straight off the
 * `DatabaseConfig` union rendered `undefined` on every postgres brain — which
 * is what production runs — and the one check whose job is naming the engine
 * said nothing about it. A test driving `runDoctor` cannot catch that without a
 * live postgres, so the branch lives here where both variants are one call away.
 */
export function engineCheckDetail(db: DatabaseConfig): string {
  return db.type === "pglite" ? db.path : `engine=${db.type}`;
}

interface Check {
  name: string;
  /**
   * The exit-code driver, kept binary on purpose: a `warn` stays true, so a
   * degraded-but-running brain never turns every cron probe red.
   */
  ok: boolean;
  /** The honest verdict — see CheckStatus. Invariant: ok === (status !== "fail"). */
  status: CheckStatus;
  detail?: string;
}

function snapshotCi(detail: Record<string, unknown>, key: string): string {
  const ci = detail[key] as { lo?: unknown; hi?: unknown } | undefined;
  if (!ci || typeof ci.lo !== "number" || typeof ci.hi !== "number") return "";
  return ` [${ci.lo.toFixed(2)}–${ci.hi.toFixed(2)}]`;
}

/**
 * The eval-trend detail for a probe snapshot that ran. Rows written before the
 * probe stored bootstrap intervals render exactly as they always did.
 */
export function evalTrendDetail(
  snap: Pick<EvalSnapshotRow, "ran_at" | "total_queries" | "scored" | "mean_rr" | "hit_rate" | "detail"> &
    Partial<Pick<EvalSnapshotRow, "status">>,
): string {
  if (snap.status === "error") {
    const err = typeof snap.detail?.["error"] === "string" ? snap.detail["error"] : "unknown error";
    return `last probe ${snap.ran_at}: FAILED — nothing measured (${err})`;
  }
  // A zero-query replay scores 0/0. Rendering that as mean_rr=0.000 reads as
  // "measured, and bad" when the truth is "not measured" — the advisor's
  // eval_set_empty finding carries the fix.
  if (snap.total_queries === 0) {
    return `last probe ${snap.ran_at}: eval set EMPTY — nothing measured ` +
      `(register queries: memrain eval-replay capture)`;
  }
  const detail = snap.detail ?? {};
  return `last probe ${snap.ran_at}: mean_rr=${snap.mean_rr.toFixed(3)}` +
    `${snapshotCi(detail, "mean_rr_ci95")} ` +
    `hit_rate=${snap.hit_rate.toFixed(3)}${snapshotCi(detail, "hit_rate_ci95")} ` +
    `(scored ${snap.scored}/${snap.total_queries})` +
    (snap.status === "capped" ? " capped: part of the eval set was not replayed" : "");
}

/**
 * A check that RAN to completion: a pass, or a real failure the exit code
 * gates on. The two fields are derived from one boolean here so they can never
 * drift apart — the honest three-state cases (`warn`) are written out
 * explicitly instead.
 */
function verdict(name: string, ok: boolean, detail: string): Check {
  return { name, ok, status: ok ? "ok" : "fail", detail };
}

/**
 * Legacy `MEMEX_*` env names the startup shim mapped onto `MEMRAIN_*`. A name
 * set identically under both spellings is not counted. Names only, never values.
 */
export function legacyEnvCheck(report: LegacyEnvReport): Check {
  if (report.mapped.length === 0) {
    return { name: "legacy-env-names", ok: true, status: "ok", detail: "no legacy MEMEX_* env names in use" };
  }
  const names = report.mapped.map((n) => n.replace(/^MEMRAIN_/, "MEMEX_"));
  return {
    name: "legacy-env-names",
    ok: true,
    status: "warn",
    detail: `${names.length} legacy env name(s) in use; rename to MEMRAIN_* before 1.1.0: ${names.join(", ")}`,
  };
}

/**
 * `~/.memex` next to a separate `~/.memrain`. One directory reached through
 * both paths (same device and inode) is not a split.
 */
export function legacyConfigDirCheck(home: string): Check {
  const legacy = join(home, ".memex");
  const current = join(home, ".memrain");
  let split = false;
  if (existsSync(legacy) && existsSync(current)) {
    const a = statSync(legacy);
    const b = statSync(current);
    split = a.dev !== b.dev || a.ino !== b.ino;
  }
  return split
    ? {
        name: "legacy-config-dir",
        ok: true,
        status: "warn",
        detail: `${legacy} exists beside ${current}; keep one config directory`,
      }
    : { name: "legacy-config-dir", ok: true, status: "ok", detail: "no legacy config directory beside the new one" };
}

/** Both overlay files beside config.json: the new one is read, the legacy one is ignored. */
export function configYamlCheck(configPath: string): Check {
  const dir = dirname(configPath);
  const current = join(dir, YAML_NAME);
  const legacy = join(dir, LEGACY_YAML_NAME);
  return existsSync(current) && existsSync(legacy)
    ? {
        name: "config-yml",
        ok: true,
        status: "warn",
        detail: `${current} and ${legacy} both exist; only ${YAML_NAME} is read, fold ${LEGACY_YAML_NAME} into it`,
      }
    : { name: "config-yml", ok: true, status: "ok", detail: "one overlay file at most" };
}

/** OAuth clients registered while the self-issued provider is off: a recreated config.json. */
export function oauthSelfIssuedCheck(config: Config, liveOauthClients: number): Check {
  const mismatch = selfIssuedMismatch(config, liveOauthClients);
  return mismatch
    ? verdict("oauth-self-issued-config", false, mismatch)
    : verdict(
        "oauth-self-issued-config",
        true,
        `self-issued OAuth ${config.auth?.selfIssued?.enabled === true ? "on" : "off"}; ${liveOauthClients} live client(s)`,
      );
}

/** A check as rendered: the raw check plus its category. */
interface CategorizedCheck extends Check {
  category: CheckCategory;
}

export interface DoctorOptions {
  /** Override the config path. Tests use this to point at a temp dir
   *  (Bun's `os.homedir()` caches at process start, so HOME env tricks
   *  don't work). Defaults to `~/.memrain/config.json`. */
  configPath?: string;
  /** Override argv (defaults to process.argv.slice(2)). Tests drive the
   *  remediation flags through this without touching the global argv. */
  argv?: string[];
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<void> {
  const checks: Check[] = [];
  let config: ReturnType<typeof loadConfig> | null = null;

  // 1. config file
  const cfgPath = opts.configPath ?? defaultConfigPath();
  if (!existsSync(cfgPath)) {
    checks.push(
      verdict("config", false, `missing at ${cfgPath} — run 'memrain init --pglite'`),
    );
  } else {
    try {
      config = loadConfig(cfgPath);
      checks.push(verdict("config", true, cfgPath));
    } catch (e) {
      // Not a "could not check": an unparseable config IS the fault.
      checks.push(
        verdict("config", false, e instanceof Error ? e.message : String(e)),
      );
    }
  }

  // 2. PGLite + schema
  let storage: Storage | null = null;
  if (config) {
    try {
      storage = new Storage(config);
      await storage.init();
      checks.push(verdict("pglite", true, engineCheckDetail(config.database)));
    } catch (e) {
      // A diagnosis you can only get by opening the thing that will not open is
      // no diagnosis. Read the directory itself — pure filesystem, no driver.
      const detail =
        config.database.type === "pglite" && config.database.path
          ? `${e instanceof Error ? e.message : String(e)} | ${describeDataDir(
              inspectDataDir(config.database.path),
            )}`
          : e instanceof Error
            ? e.message
            : String(e);
      // A brain whose engine will not open is broken, not merely unmeasured —
      // this catch stays a hard fail.
      checks.push(verdict("pglite", false, detail));
    }
  }

  // 3. stats + last_indexed_mtime spread
  if (storage) {
    try {
      const stats = await storage.stats();
      checks.push(
        verdict(
          "stats",
          stats.documents >= 0 && stats.chunks >= 0,
          `documents=${stats.documents} chunks=${stats.chunks} embeddings=${stats.embeddings}`,
        ),
      );

      const r = await storage
        .raw()
        .query<{ oldest: number | string | null; newest: number | string | null; n: number }>(
          `SELECT MIN(last_indexed_mtime) AS oldest,
                  MAX(last_indexed_mtime) AS newest,
                  COUNT(last_indexed_mtime)::int AS n
           FROM documents`,
        );
      const row = r.rows[0];
      // BIGINT comes back as `number` from PGLite, `string` from postgres-js;
      // coerce so `new Date(...)` produces a sane value either way.
      const toNum = (v: unknown): number | null => {
        if (v === null || v === undefined) return null;
        const x = typeof v === "number" ? v : Number(v);
        return Number.isFinite(x) ? x : null;
      };
      const oldest = toNum(row?.oldest);
      const newest = toNum(row?.newest);
      const n = row?.n ?? 0;
      checks.push(
        verdict(
          "index-spread",
          true,
          n === 0
            ? "no documents indexed yet"
            : `n=${n} oldest=${
                oldest ? new Date(oldest).toISOString() : "n/a"
              } newest=${
                newest ? new Date(newest).toISOString() : "n/a"
              }`,
        ),
      );
    } catch (e) {
      // The core tables not answering is a broken brain, not an unmeasured one.
      checks.push(
        verdict("stats", false, e instanceof Error ? e.message : String(e)),
      );
    }

    // 3b. brain health metrics (embed coverage / lag / queue / failed jobs).
    // Informational by design: a failed job in the last 24h is the only
    // unambiguous "broken" signal, so that alone gates ok. Coverage / lag /
    // queue are surfaced in the detail for the operator to judge — a brain can
    // legitimately run with partial embedding coverage (graph-only sources, a
    // pending backfill), so the doctor reports it rather than declaring it bad.
    try {
      const h = await brainHealthMetrics(storage.raw());
      checks.push(
        verdict(
          "source-health",
          h.failed_jobs_24h === 0,
          `embed_coverage=${(h.embed_coverage_pct * 100).toFixed(1)}% ` +
            `(${h.embedded_chunks}/${h.embeddable_chunks} embeddable` +
            `${h.code_chunks > 0 ? `, ${h.code_chunks} code graph-only` : ""}) ` +
            `lag=${h.lag_seconds === null ? "n/a" : `${h.lag_seconds}s`} ` +
            `queue=${h.queue_depth} failed_24h=${h.failed_jobs_24h}`,
        ),
      );
    } catch (e) {
      // Same substrate as `stats` — if this cannot answer, the brain is broken.
      checks.push(
        verdict("source-health", false, e instanceof Error ? e.message : String(e)),
      );
    }

    // Link-extraction lag (migration 051). Informational by design (ok:true):
    // a backlog of un-extracted pages degrades graph coverage but a brain can
    // legitimately run with it (autopilot off, a fresh import). Surfaced so the
    // operator can re-put / sweep. After mig 051 every pre-existing page reads
    // stale (NULL watermark) until it is next written — that backlog is the
    // point of the check.
    try {
      const e = storage.raw();
      const totalR = await e.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL",
      );
      const total = totalR.rows[0]?.n ?? 0;
      const stale = total > 0 ? await countStalePagesForExtraction(e, { versionTs: LINK_EXTRACTOR_VERSION_TS }) : 0;
      const pct = total > 0 ? ((stale / total) * 100).toFixed(1) : "0.0";
      checks.push(
        verdict(
          "links-extraction-lag",
          true,
          `${stale}/${total} page(s) stale for link extraction (${pct}%)`,
        ),
      );
    } catch (e) {
      checks.push(couldNotCheck("links-extraction-lag", e));
    }

    // Chunker-version lag (migration 052). Informational (ok:true): documents
    // chunked under an older chunker version would re-chunk + re-embed on the
    // next reindex. Zero until a chunker constant is bumped (every doc starts at
    // the grandfather version 1).
    try {
      const stale = await countStaleChunkerDocs(storage.raw());
      checks.push(
        verdict(
          "chunker-version-lag",
          true,
          `${stale} document(s) stale for re-chunk (chunker version bumped)`,
        ),
      );
    } catch (e) {
      checks.push(couldNotCheck("chunker-version-lag", e));
    }

    // Cycle liveness: a wedged maintenance loop otherwise surfaces only via the
    // downstream links-extraction-lag proxy. Warn-tier until the snapshot
    // stream goes stale (fails only past the fail threshold, under ENFORCE).
    try {
      const fresh = await checkCycleFreshness(storage.raw());
      checks.push({
        name: "cycle-freshness",
        ok: fresh.ok,
        status: fresh.status,
        detail: fresh.detail,
      });
    } catch (e) {
      checks.push(couldNotCheck("cycle-freshness", e));
    }

    // Ops probes (substrate already exists): an orphaned cycle lock past TTL, a
    // wedged job in the queue, an unapplied migration, an embedding-width vs
    // config drift, or the same content indexed under multiple slugs. A probe
    // that throws reports its own `warn` so one bad probe can't abort the
    // report — and can't pass for a healthy one either.
    for (const [name, probe] of [
      ["stale-locks", checkStaleLocks],
      ["queue-health", checkQueueHealth],
      ["schema-version", checkSchemaVersion],
      ["embedding-width", checkEmbeddingWidth],
      ["invalid-indexes", checkInvalidIndexes],
      ["duplicate-pages", checkDuplicatePages],
      ["quarantined-pages", checkQuarantinedPages],
      ["junk-entity-hubs", checkJunkEntityHubs],
      ["code-grammars", checkGrammars],
      ["connector-health", checkConnectorHealth],
      ["embed-backlog", checkEmbedBacklog],
    ] as const) {
      try {
        const r = await probe(storage.raw());
        checks.push({ name, ok: r.ok, status: r.status, detail: r.detail });
      } catch (e) {
        checks.push(couldNotCheck(name, e));
      }
    }

    // Tenancy / auth checks — the two subsystems where a silent misconfig is
    // a cross-tenant leak (broken confidential client, mis-routed writes) or
    // an invisibly dead tenant (0% embed coverage inside the brain average).
    // Each check turns its own probe errors into a `warn` verdict.
    checks.push(await checkFederationHealth(storage.raw()));
    checks.push(await checkOauthClientHealth(storage.raw()));
    checks.push(await checkOauthClientHygiene(storage.raw()));
    if (config) {
      try {
        checks.push(oauthSelfIssuedCheck(config, await storage.liveOauthClientCount()));
      } catch (e) {
        checks.push(couldNotCheck("oauth-self-issued-config", e));
      }
    }
    checks.push(await checkPatScopesRecorded(storage.raw()));
    checks.push(await checkSourceRoutingHealth(storage.raw()));
    checks.push(await checkDocumentIdDrift(storage.raw()));

    // Legacy runtime_config rows. A MEMEX_X row with no MEMRAIN_X row is still
    // in effect through the fallback and must be re-set under the new name
    // before 1.1.0; one a MEMRAIN_X row overrides is inert stored data. Names
    // only, never values.
    try {
      const rows = await listRuntimeConfig(storage.raw());
      const { legacyOnly, shadowed } = classifyLegacyRows(rows.map((r) => r.key));
      const shadowNote =
        shadowed.length > 0 ? `; ${shadowed.length} shadowed legacy row(s), inert: ${shadowed.join(", ")}` : "";
      checks.push(
        legacyOnly.length > 0
          ? {
              name: "runtime-config-legacy-rows",
              ok: true,
              status: "warn",
              detail:
                `${legacyOnly.length} legacy-only runtime_config row(s); re-set each as MEMRAIN_* ` +
                `(memrain config set MEMRAIN_<name> <value>) before 1.1.0: ${legacyOnly.join(", ")}${shadowNote}`,
            }
          : verdict(
              "runtime-config-legacy-rows",
              true,
              `no legacy-only runtime_config rows${shadowNote}`,
            ),
      );
    } catch (e) {
      checks.push(couldNotCheck("runtime-config-legacy-rows", e));
    }

    // Chronicle projection health — timeline_events rows projected from an event
    // page that has since been soft-deleted. The read path hides these (it joins
    // on the event page's deleted_at IS NULL), so they are dangling projections
    // invisible at query time: a cleanup backlog, not a live fault. Always
    // ok:true; per-source so a multi-tenant operator sees which tenant to purge.
    // Wrapped so a pre-migration brain (no event_slug column) reports rather
    // than fails.
    try {
      const r = await storage.raw().query<{ source_id: string | null; n: number }>(
        `SELECT ep.source_id AS source_id, count(*)::int AS n
           FROM timeline_events te
           JOIN pages ep ON ep.slug = te.event_slug
          WHERE te.event_slug IS NOT NULL AND ep.deleted_at IS NOT NULL
          GROUP BY ep.source_id
          ORDER BY n DESC, source_id`,
      );
      const total = r.rows.reduce((s, row) => s + Number(row.n), 0);
      const perSource = r.rows
        .map((row) => `${row.source_id ?? "(unclassified)"}: ${Number(row.n)}`)
        .join(", ");
      checks.push(
        verdict(
          "chronicle-projection-health",
          true,
          total === 0
            ? "no orphaned timeline projections"
            : `${total} timeline projection(s) reference a soft-deleted event page ` +
              `(${perSource}) — hidden at read time; purge to clear the backlog`,
        ),
      );
    } catch (e) {
      checks.push(
        couldNotCheck("chronicle-projection-health", e, "pre-migration schema?"),
      );
    }

    // Per-source embed coverage (opt-in via MEMRAIN_DOCTOR_PER_SOURCE=1). In a
    // multi-tenant deploy one tenant's embedding can break (0% coverage while
    // it has embeddable chunks) invisibly inside the whole-brain average. This
    // WARNS by listing those sources but never gates (ok:true) — a source can
    // legitimately sit at 0% mid-backfill. Off by default to keep single-tenant
    // reports quiet.
    if (process.env.MEMRAIN_DOCTOR_PER_SOURCE === "1") {
      try {
        const rows = await collectPerSourceHealth(storage.raw());
        const broken = rows.filter(
          (r) => r.embeddable_chunks > 0 && r.embedded_chunks === 0,
        );
        checks.push({
          name: "per-source-embed-coverage",
          ok: true,
          status: broken.length === 0 ? "ok" : "warn",
          detail:
            broken.length === 0
              ? `${rows.length} source(s), none at 0% embed coverage`
              : `${broken.length} source(s) at 0% embed coverage: ` +
                broken
                  .map((r) => `${r.source_id} (0/${r.embeddable_chunks})`)
                  .join(", "),
        });
      } catch (e) {
        checks.push(couldNotCheck("per-source-embed-coverage", e));
      }
    }
  }

  checks.push(legacyEnvCheck(legacyEnv));
  try {
    checks.push(legacyConfigDirCheck(homedir()));
  } catch (e) {
    checks.push(couldNotCheck("legacy-config-dir", e));
  }
  checks.push(configYamlCheck(cfgPath));

  // 4. vault path (only when configured)
  const vault =
    process.env.MEMRAIN_VAULT_PATH ?? config?.storage.vault ?? null;
  if (vault) {
    try {
      const st = statSync(vault);
      if (!st.isDirectory()) {
        checks.push(
          verdict("vault", false, `${vault} exists but is not a directory`),
        );
      } else {
        checks.push(verdict("vault", true, vault));
      }
    } catch {
      // A configured vault that will not stat is a misconfigured host, not an
      // unmeasured one — a hard fail, as before.
      checks.push(verdict("vault", false, `${vault} not readable`));
    }
  } else {
    checks.push(verdict("vault", true, "not configured (recipe disabled)"));
  }

  // 3c. retrieval-quality trend — the nightly eval probe's latest snapshot.
  // Informational (never fails the doctor): a probe that has not run yet is a
  // "not configured" state, not a broken brain. Surfaces the trend axes so the
  // operator sees quality drift without re-running retrieval.
  if (storage) {
    try {
      const snap = await latestEvalSnapshot(storage.engine());
      checks.push(
        verdict(
          "eval-trend",
          true,
          !snap
            ? "retrieval-quality probe has not run yet (memrain eval-probe / systemd timer)"
            : evalTrendDetail(snap),
        ),
      );
    } catch (e) {
      checks.push(couldNotCheck("eval-trend", e));
    }
  }

  // Contradiction-probe trend — surfaces the last suspected-contradictions run's
  // rate + Wilson 95% CI so the operator sees quality drift without re-running
  // the paid probe. Informational (ok:true), like eval-trend; the runs table was
  // written but never read back before.
  if (storage) {
    try {
      const run = await latestContradictionRun(storage.engine());
      checks.push(
        verdict(
          "contradiction-trend",
          true,
          run
            ? `last run ${run.ran_at}: rate=${run.found}/${run.judged} ` +
              `(95% CI ${run.wilson_ci_lower.toFixed(3)}–${run.wilson_ci_upper.toFixed(3)}), ` +
              `$${run.cost_usd.toFixed(4)}`
            : "contradiction probe has not run yet (memrain cycle --phases probe-contradictions)",
        ),
      );
    } catch (e) {
      checks.push(couldNotCheck("contradiction-trend", e));
    }
  }

  // Remediation layer (opt-in). The fast read-only probe above is the DEFAULT;
  // these flags never change behavior unless explicitly passed. `--remediate`
  // wins over `--remediation-plan` when both are given.
  const argv = opts.argv ?? process.argv.slice(2);
  if (argv.includes("--remediation-plan") || argv.includes("--remediate")) {
    let remediationFailed = false;
    try {
      await emitRemediation(storage, checks, argv);
    } catch (e) {
      remediationFailed = true;
      throw e;
    } finally {
      // The finally is what stops a throwing remediation from stranding the
      // engine and its data-directory lock. The split is the same rule the
      // report path uses: quiet only when we are ALREADY failing, because
      // there the close error is a second symptom that would bury the first.
      // On a successful remediation a failed close is the only news there is,
      // and swallowing it would exit 0 on a brain still holding its lock.
      if (storage) {
        if (remediationFailed) await closeQuietly(storage);
        else await storage.close();
      }
    }
    return;
  }

  // Teardown is REPORTED, not swallowed and not thrown. Throwing would kill
  // the run before it prints the checks it already collected — and the storage
  // reaching here may be one whose init() failed, which is the very case doctor
  // exists to diagnose. But staying silent is the other failure: a close that
  // leaves a PGLite directory lock held would otherwise be an `ok: true` run
  // whose only trace is a stderr line nobody reads. So it becomes a check, and
  // a failing check is what drives the exit code below.
  if (storage) {
    try {
      await storage.close();
    } catch (e) {
      checks.push(
        verdict(
          "storage-teardown",
          false,
          `storage.close() failed: ${e instanceof Error ? e.message : String(e)}` +
            ` — the engine may still hold its data-directory lock, which refuses the next open`,
        ),
      );
    }
  }

  // `ok` (and therefore the exit code) is still driven by the binary field: a
  // warn must NOT turn a degraded-but-running brain into a red cron probe.
  // `status` is the honest rollup beside it — worst check wins, exactly as
  // CycleResult rolls up its phases.
  const pass = checks.every((c) => c.ok);
  const status = worstStatus(checks.map((c) => c.status));

  // Categorize each check (brain / ops / meta) and roll up per-category
  // pass/fail counts so the report shows signal-to-noise on the question the
  // operator is asking, not one flat equal-weight list.
  const categorized: CategorizedCheck[] = checks.map((c) => ({
    ...c,
    category: categorize(c.name),
  }));
  const byCategory: Record<CheckCategory, { ok: number; fail: number }> = {
    brain: { ok: 0, fail: 0 },
    ops: { ok: 0, fail: 0 },
    meta: { ok: 0, fail: 0 },
  };
  for (const c of categorized) {
    byCategory[c.category][c.ok ? "ok" : "fail"]++;
  }
  // Root-cause-first ordering of the failures (ordering only — see
  // doctor-cause-rank.ts honesty contract).
  const rankedFailures: RankedIssue[] = rankIssues(checks);

  console.log(
    JSON.stringify(
      {
        ok: pass,
        status,
        version: VERSION,
        checks: categorized,
        summary: {
          by_category: byCategory,
          ranked_failures: rankedFailures,
        },
      },
      null,
      2,
    ),
  );
  if (!pass) process.exitCode = 1;
}

/** Parse `--flag N` / `--flag=N` as a finite number, else undefined. */
function parseNumFlag(argv: string[], flag: string): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flag && i + 1 < argv.length) {
      const n = Number(argv[i + 1]);
      return Number.isFinite(n) ? n : undefined;
    }
    if (a?.startsWith(`${flag}=`)) {
      const n = Number(a.slice(flag.length + 1));
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}

/**
 * Sources stuck at 0% embed coverage that a reembed-source job can fix.
 *
 * The NULL-source '(unclassified)' bucket is a display label, not a
 * source_id: a backfill pinned to it matches no document, so the job would
 * "succeed" having embedded nothing and doctor would propose it again on
 * every run. Unclassified docs are source-routing-health's finding instead.
 */
export function brokenSourcesFromHealth(rows: PerSourceHealth[]): BrokenSource[] {
  return rows
    .filter(
      (r) =>
        r.source_id !== UNCLASSIFIED_BUCKET &&
        r.embeddable_chunks > 0 &&
        r.embedded_chunks === 0,
    )
    .map((r) => ({ source_id: r.source_id, embeddable_chunks: r.embeddable_chunks }));
}

/**
 * Gather the structured health signals the classifier needs. Kept off the
 * default doctor path — only runs when a remediation flag is passed.
 */
async function gatherRemediationInput(
  storage: Storage | null,
  checks: Check[],
): Promise<RemediationInput> {
  const signals = checks.map((c) => ({
    check: c.name,
    ok: c.ok,
    ...(c.detail !== undefined ? { detail: c.detail } : {}),
  }));
  const input: RemediationInput = { signals };
  if (!storage) return input;
  try {
    const broken = brokenSourcesFromHealth(await collectPerSourceHealth(storage.raw()));
    if (broken.length > 0) input.brokenSources = broken;
  } catch {
    // best-effort — a probe failure just yields no source fixes.
  }
  try {
    const fresh = await checkCycleFreshness(storage.raw());
    // Anything short of `ok` — stale, skewed, or never run at all — is a cycle
    // the classifier should offer to re-run. The old `startsWith("WARN")` read
    // the verdict out of the detail string and missed the two states that
    // carried no prefix.
    input.cycleStale = fresh.status !== "ok";
  } catch {
    // best-effort — leave cycleStale undefined.
  }
  return input;
}

/** The plan envelope as emitted: the plan plus the honesty fields. */
export interface RemediationPlanEnvelope extends RemediationPlan {
  /** Names of the checks that failed, present only when some did. */
  failing_checks?: string[];
}

/**
 * Fold the checks' own verdict into the plan envelope.
 *
 * `plan.ok` only ever meant "the classifier produced no actions" — and most
 * check names map to no action at all, so an empty plan was reported as an
 * all-clear while the doctor itself was failing. The honest signal is the
 * checks: a failing check keeps `ok:false` and names itself, so the operator
 * sees the gap that autonomous remediation can't close instead of a blanket
 * green.
 *
 * Pure + exported so the honesty contract is asserted on the envelope rather
 * than through console.log.
 */
export function buildRemediationEnvelope(
  plan: RemediationPlan,
  checks: readonly { name: string; ok: boolean }[],
): RemediationPlanEnvelope {
  const failing = checks.filter((c) => !c.ok).map((c) => c.name);
  return {
    ...plan,
    ok: plan.ok && failing.length === 0,
    ...(failing.length > 0 ? { failing_checks: failing } : {}),
  };
}

/**
 * Emit the remediation plan (read-only) or run `--remediate` (enqueue the safe
 * subset, dry-run by default). Prints a stable JSON envelope. Never mutates on
 * the plan path; `--remediate` submits nothing unless `--execute` (or `--yes`)
 * is passed AND a working engine is available.
 *
 * Exit code follows the same contract as the default report: the checks decide.
 * A remediation run that submitted cleanly while a check is red is still a red
 * brain, and a cron probe reads the exit code, not the JSON. The classifier's
 * own verdict stays where it belongs — inside `plan.ok` — because a proposed
 * action can exist for a check that deliberately never gates (per-source embed
 * coverage), and that must not turn a healthy brain's exit code red.
 */
async function emitRemediation(
  storage: Storage | null,
  checks: Check[],
  argv: string[],
): Promise<void> {
  const input = await gatherRemediationInput(storage, checks);
  const remediate = argv.includes("--remediate");
  const plan = buildRemediationEnvelope(buildRemediationPlan(input), checks);
  const checksOk = checks.every((c) => c.ok);

  if (!remediate) {
    console.log(
      JSON.stringify(
        { mode: "remediation-plan", version: VERSION, ...plan },
        null,
        2,
      ),
    );
    if (!checksOk) process.exitCode = 1;
    return;
  }

  // --remediate: dry-run is the DEFAULT. Only --execute / --yes actually enqueue.
  const dryRun = !(argv.includes("--execute") || argv.includes("--yes"));
  const maxUsd = parseNumFlag(argv, "--max-usd");
  const maxJobs = parseNumFlag(argv, "--max-jobs");

  if (!storage) {
    // No engine → nothing can be enqueued. Emit the plan + a clear note.
    console.log(
      JSON.stringify(
        {
          ok: false,
          submitted: false,
          mode: "remediate",
          version: VERSION,
          note: "no working storage engine — fix config/pglite before remediation jobs can run",
          plan,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const queue = new Queue(storage.engine());
  const { report } = await submitRemediation(queue, input, {
    dryRun,
    ...(maxUsd !== undefined ? { maxUsd } : {}),
    ...(maxJobs !== undefined ? { maxJobs } : {}),
  });
  // `submitted` is the old `ok:true` — "the submission ran". `ok` is the
  // brain's verdict, so the two stay separable: a clean submission against a
  // failing brain reads submitted:true / ok:false.
  console.log(
    JSON.stringify(
      {
        ok: checksOk,
        submitted: true,
        mode: "remediate",
        version: VERSION,
        dry_run: report.dry_run,
        plan,
        report,
      },
      null,
      2,
    ),
  );
  if (!checksOk) process.exitCode = 1;
}
