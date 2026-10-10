/**
 * Doctor check taxonomy — single source of truth for both axes a check is
 * described by: WHICH LAYER it speaks for (category) and HOW BAD the answer is
 * (status).
 *
 * Every `memrain doctor` check belongs to exactly one category so the report
 * answers the question the operator is actually asking:
 *
 *   - brain : data-integrity signals — "is the brain's actual data healthy?"
 *             (index counts, index-freshness spread)
 *   - ops   : infrastructure / setup — "can the brain even run here?"
 *             (config present + parses, DB engine opens, vault path readable)
 *   - meta  : the doctor / runtime itself; the fallthrough bucket.
 *
 * memrain is brain-only, so there is no fourth `skill` category (agent skill
 * dispatcher) — there is no skill layer to diagnose.
 *
 * Drift contract: every check name that ships in `commands/doctor.ts` MUST
 * appear in exactly one set below. `tests/doctor_categories.test.ts` enforces
 * this. If you add a doctor check, add its name here too — `categorize()`
 * falls through to 'meta' for an unknown name and emits a once-per-process
 * stderr warning so a missing addition surfaces in dev runs before CI.
 */

export type CheckCategory = "brain" | "ops" | "meta";

/**
 * Three-state check outcome — the same vocabulary the maintenance cycle
 * already uses for its phases (`PhaseStatus`, core/cycle/index.ts):
 *
 *   - ok   : the check ran and the brain looks right on that axis.
 *   - warn : a real signal that must not gate — a degraded-but-running brain,
 *            or a check that could not run at all. `ok` stays true, so the
 *            process exit code (what every cron probe reads) is unmoved.
 *   - fail : the brain is broken on that axis; `ok` is false and `doctor`
 *            exits 1.
 *
 * `ok` is the back-compat exit-code view of `status`: `ok === (status !==
 * "fail")`. A check that THREW is a `warn`, never an `ok` — the doctor is not
 * allowed to render "I could not check this" as "this is fine".
 */
export type CheckStatus = "ok" | "warn" | "fail";

/** The full verdict a check reports. `detail` is what the operator reads. */
export interface CheckVerdict {
  name: string;
  ok: boolean;
  status: CheckStatus;
  detail: string;
}

/**
 * Worst outcome of a set: fail beats warn beats ok. Identical rollup to
 * `CycleResult.status` over its phases, so a cycle result and a doctor report
 * answer "how bad is it?" the same way.
 */
export function worstStatus(statuses: Iterable<CheckStatus>): CheckStatus {
  let worst: CheckStatus = "ok";
  for (const s of statuses) {
    if (s === "fail") return "fail";
    if (s === "warn") worst = "warn";
  }
  return worst;
}

/**
 * The verdict for a probe that THREW.
 *
 * The cycle treats a throw as `fail`; the doctor deliberately treats it as
 * `warn`. The doctor is a one-shot probe over a live brain and most of its
 * probes read OPTIONAL substrate (a table a pre-migration brain lacks, a
 * projection an old deploy never wrote). Failing the exit code on those would
 * red every cron probe on a brain that is serving fine — the same cry-wolf
 * that keeps cycle-freshness warn-only. What must never happen again is the
 * old shape: a throw rendered byte-identical to a pass. `warn` keeps the exit
 * code honest AND the report honest.
 *
 * One phrasing for every such detail so an operator (and a grep) recognises
 * "I could not check" wherever it comes from.
 */
export function couldNotCheck(
  name: string,
  e: unknown,
  hint?: string,
): CheckVerdict {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    name,
    ok: true,
    status: "warn",
    detail: `could not check ${name}: ${msg}${hint ? ` (${hint})` : ""}`,
  };
}

/** Data-integrity signals — "is the brain's actual data healthy?" */
export const BRAIN_CHECK_NAMES: ReadonlySet<string> = new Set([
  "stats",
  "index-spread",
  "source-health",
  "links-extraction-lag",
  "chunker-version-lag",
  "cycle-freshness",
  "per-source-embed-coverage",
  "eval-trend",
  "contradiction-trend",
  "federation-health",
  "source-routing-health",
  "document-id-drift",
  "embedding-width",
  "chronicle-projection-health",
  "duplicate-pages",
  "quarantined-pages",
  "junk-entity-hubs",
  "embed-backlog",
]);

/** Infrastructure / setup — "can the brain run here at all?" */
export const OPS_CHECK_NAMES: ReadonlySet<string> = new Set([
  "config",
  "pglite",
  "vault",
  "oauth-client-health",
  "oauth-client-hygiene",
  "pat-scopes-recorded",
  "stale-locks",
  "queue-health",
  "schema-version",
  "invalid-indexes",
  "code-grammars",
  "connector-health",
  "legacy-env-names",
  "legacy-config-dir",
  "runtime-config-legacy-rows",
  "config-yml",
  "oauth-self-issued-config",
  // Only ever pushed when teardown FAILED, so it is absent from a healthy run
  // and the drift test cannot see it — it still has to be named here or it
  // falls through to `meta` with an "uncategorized" warning.
  "storage-teardown",
]);

/** The doctor / runtime itself. Empty today; the fallthrough bucket. */
export const META_CHECK_NAMES: ReadonlySet<string> = new Set<string>([]);

/** Union of every categorized name — the drift-guard comparison set. */
export const KNOWN_CHECK_NAMES: ReadonlySet<string> = new Set<string>([
  ...BRAIN_CHECK_NAMES,
  ...OPS_CHECK_NAMES,
  ...META_CHECK_NAMES,
]);

// Once-per-process guard so an uncategorized check warns once, not per call.
const warned = new Set<string>();

/**
 * Map a check name to its category. Unknown names fall through to 'meta'
 * and warn once per process (a missing drift-set addition).
 */
export function categorize(name: string): CheckCategory {
  if (BRAIN_CHECK_NAMES.has(name)) return "brain";
  if (OPS_CHECK_NAMES.has(name)) return "ops";
  if (META_CHECK_NAMES.has(name)) return "meta";
  if (!warned.has(name)) {
    warned.add(name);
    console.error(
      `[memrain doctor] check '${name}' is uncategorized — add it to ` +
        `core/doctor-categories.ts (defaulting to 'meta')`,
    );
  }
  return "meta";
}

/** Test-only: reset the once-per-process warn guard. */
export function _resetCategoryWarnings(): void {
  warned.clear();
}
