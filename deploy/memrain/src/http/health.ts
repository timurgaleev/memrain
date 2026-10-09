/**
 * /health endpoint — liveness only.
 *
 * A bare `SELECT 1` raced against a 3 s timeout. Two reasons (both from
 * a past incident):
 *   1. Corpus stats behind an unauthenticated internet-reachable probe
 *      disclose the brain's size to anonymous callers — stats now live
 *      only behind `/admin/api/full-stats` (admin auth).
 *   2. Full `stats()` runs several count(*) queries; on a saturated
 *      pool those can hang past the orchestrator's health deadline and
 *      trigger restart cascades. A liveness probe must answer fast or
 *      503, never hang.
 *
 * Still reports the engine `kind` (`pglite` or `postgres`) so monitoring
 * can tell at a glance which backend is in use after a cutover.
 *
 * While maintenance mode is on the body also carries `maintenance: true`, so a
 * deploy script or an operator's curl can see that ingress must stay shut
 * without credentials. The key is absent otherwise, and no switch detail or
 * count is ever exposed here.
 */
import type { Storage } from "../core/storage.ts";
import { VERSION } from "../version.ts";

/** 3 s leaves headroom under the usual 5 s orchestrator health deadline. */
export const HEALTH_TIMEOUT_MS = 3000;

export interface LivenessResult {
  status: 200 | 503;
  body: Record<string, unknown>;
}

/**
 * Pure probe: race `SELECT 1` against the timeout, return a tagged
 * result. No Response coupling so tests can drive it with a mock
 * storage. The timer is cleared when the query wins so fast probes
 * don't accumulate pending timers.
 */
export async function probeLiveness(
  storage: Storage,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
  maintenance = false,
): Promise<LivenessResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      storage.engine().query("SELECT 1"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("health_timeout")), timeoutMs);
      }),
    ]);
    return {
      status: 200,
      body: {
        ok: true,
        db: storage.engine().kind,
        // The BUILD stamp, not package.json — that one is pinned at 0.1.0 on
        // purpose (see version.ts), so reporting it made /health answer the
        // same string for every image ever built. A deploy check that reads
        // this field could not tell a fresh container from a stale one.
        version: VERSION,
        // Measured at boot, never per probe. Informational: a rolled-back image
        // under a newer schema still serves, so this never turns /health red.
        schema_ahead: storage.schemaAhead(),
        ...(maintenance ? { maintenance: true } : {}),
      },
    };
  } catch (e) {
    // /health is unauthenticated and internet-reachable — never echo the
    // raw exception (it would leak the DSN host / Postgres internals on a
    // DB outage). Distinguish only timeout vs failure.
    const timedOut = e instanceof Error && e.message === "health_timeout";
    return {
      status: 503,
      body: {
        ok: false,
        error: timedOut
          ? "health check timed out (database pool may be saturated)"
          : "database connection failed",
        ...(maintenance ? { maintenance: true } : {}),
      },
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export async function handleHealth(
  storage: Storage,
  maintenance = false,
): Promise<Response> {
  const result = await probeLiveness(storage, HEALTH_TIMEOUT_MS, maintenance);
  return Response.json(result.body, { status: result.status });
}
