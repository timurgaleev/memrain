/**
 * Durable-queue handler for `remediation` jobs.
 *
 * The doctor self-heal layer (`core/remediation.ts`) enqueues one durable job
 * per safe deterministic fix. This module registers the single `remediation`
 * handler that dispatches on `payload.action`:
 *
 *   - "reembed-source" → re-embed a source stuck at 0% coverage.
 *   - "cycle-phase"    → re-run a wedged maintenance-cycle phase.
 *
 * memrain has NO server-side subagent runtime, so each action is a plain durable
 * job the ordinary worker executes. The runners are injectable
 * (`RemediationDeps`) so the dispatch logic stays trivially testable.
 *
 * reembed-source runs the embed backfill against the worker's own storage,
 * pinned to the job's `source_id`. It only fills missing vectors: it never
 * deletes an existing one, whatever the signature-change env knob says. A run
 * that had work, embedded nothing and still leaves chunks unembedded throws, so
 * the job retries or dead-letters instead of reporting a success that fixed
 * nothing. A pin that owns no live document, a payload missing its target and
 * a missing runner fail at once: no retry can change them.
 *
 * To activate in the live worker, call `registerRemediationHandlers(storage)`
 * once at worker startup (alongside `new Worker(...)`).
 */
import { type JobHandler, UnrecoverableJobError } from "./types.ts";
import type { Storage } from "../storage.ts";
import type { Engine } from "../engine/interface.ts";
import { registerHandler } from "./handlers.ts";
import { REMEDIATION_JOB_KIND } from "../remediation.ts";
import { runEmbedBackfill } from "../embed-backfill.ts";

/** Injectable runners so the handler never hard-couples to cycle/embed code. */
export interface RemediationDeps {
  /** Re-embed a source that is stuck at 0% coverage. */
  reembedSource?: (sourceId: string) => Promise<Record<string, unknown> | void>;
  /** Re-run one maintenance-cycle phase. */
  runCyclePhase?: (phase: string) => Promise<Record<string, unknown> | void>;
  /** Embedder seam for the default re-embed runner; production uses Titan. */
  embed?: (text: string) => Promise<number[]>;
}

/**
 * Build the `remediation` job handler. Exported for tests, which inject fake
 * deps and assert the correct runner fires for each `payload.action`.
 */
export function makeRemediationHandler(deps: RemediationDeps = {}): JobHandler {
  return async (payload) => {
    const action = typeof payload["action"] === "string" ? payload["action"] : "";
    switch (action) {
      case "reembed-source": {
        const sourceId = payload["source_id"];
        if (typeof sourceId !== "string" || sourceId.length === 0) {
          throw new UnrecoverableJobError("remediation reembed-source: missing source_id");
        }
        if (!deps.reembedSource) {
          throw new UnrecoverableJobError(
            "remediation reembed-source: no runner (register the handler with storage)",
          );
        }
        const out = (await deps.reembedSource(sourceId)) ?? {};
        const candidates = out["candidates"];
        // `remaining` is the recount after the run: another embedder (the
        // indexer, a concurrent backfill) may have filled the chunks this run
        // failed on, and a source with nothing left to embed is fixed.
        if (
          typeof candidates === "number" &&
          candidates > 0 &&
          out["embedded"] === 0 &&
          out["remaining"] !== 0
        ) {
          throw new Error(
            `remediation reembed-source: 0/${candidates} chunks embedded for source ${sourceId}`,
          );
        }
        return { action, source_id: sourceId, ...out };
      }
      case "cycle-phase": {
        const phase = typeof payload["phase"] === "string" ? payload["phase"] : "";
        if (phase.length === 0) {
          throw new UnrecoverableJobError("remediation cycle-phase: missing phase");
        }
        const run = deps.runCyclePhase ?? defaultRunCyclePhase;
        const out = await run(phase);
        return { action, phase, ...(out ?? {}) };
      }
      default:
        throw new UnrecoverableJobError(`remediation: unknown action '${action}'`);
    }
  };
}

/**
 * Register the `remediation` handler on the process-local registry, with the
 * re-embed runner bound to `storage`. Idempotent per process. Call once at
 * worker startup.
 */
export function registerRemediationHandlers(
  storage: Storage,
  deps: RemediationDeps = {},
): void {
  const reembedSource =
    deps.reembedSource ?? makeBackfillReembed(storage.engine(), deps.embed);
  registerHandler(REMEDIATION_JOB_KIND, makeRemediationHandler({ ...deps, reembedSource }));
}

function makeBackfillReembed(
  engine: Engine,
  embed: RemediationDeps["embed"],
): (sourceId: string) => Promise<Record<string, unknown>> {
  return async (sourceId) => {
    // A pin that matches no live document (a display label such as
    // '(unclassified)', or a source removed since the plan) would report
    // candidates=0 and pass as a success that fixed nothing.
    const owned = await engine.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM documents
       WHERE source_id = $1 AND deleted_at IS NULL AND NOT archived`,
      [sourceId],
    );
    if (Number(owned.rows[0]?.n ?? 0) === 0) {
      throw new UnrecoverableJobError(`remediation reembed-source: no live documents for source ${sourceId}`);
    }
    const r = await runEmbedBackfill(engine, {
      sourceId,
      // Explicit, so MEMRAIN_REEMBED_ON_SIGNATURE_CHANGE can never turn a
      // gap-fill into a delete-and-re-embed.
      reembedOnSignatureChange: false,
      ...(embed ? { embed } : {}),
    });
    const out: Record<string, unknown> = {
      candidates: r.candidates,
      embedded: r.embedded,
      failed: r.failed,
      last_id: r.lastId,
    };
    if (r.candidates > 0 && r.embedded === 0) {
      const left = await runEmbedBackfill(engine, {
        sourceId,
        reembedOnSignatureChange: false,
        dryRun: true,
      });
      out["remaining"] = left.candidates;
    }
    return out;
  };
}

/**
 * Default cycle-phase runner. Lazily imports the cycle command and runs the
 * single named phase. Best-effort: throws (→ job retry) if unavailable.
 */
async function defaultRunCyclePhase(
  phase: string,
): Promise<Record<string, unknown> | void> {
  const mod = (await import("../../commands/cycle.ts")) as Record<string, unknown>;
  const fn = mod["runCycle"];
  if (typeof fn !== "function") {
    throw new UnrecoverableJobError(
      "remediation cycle-phase: no cycle runner available (inject deps.runCyclePhase)",
    );
  }
  return (await (fn as (o: { phases: string[] }) => Promise<Record<string, unknown> | void>)(
    { phases: [phase] },
  )) as Record<string, unknown> | void;
}
