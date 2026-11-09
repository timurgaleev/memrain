import type { Engine } from "./engine/interface.ts";
import type { OpsCheckResult } from "./doctor-ops.ts";
import { embeddableChunkFragment } from "./embed-skip.ts";
import { EMBED_GAPS_MAX_FAILURES } from "./cycle/embed-gaps.ts";

export async function checkCyclePhaseHealth(engine: Engine): Promise<OpsCheckResult> {
  const { rows } = await engine.query<{ phase: string; last_run_at: string; total: number }>(
    `SELECT phase, last_run_at::text, count(*) OVER ()::int AS total FROM cycle_phase_runs
      WHERE last_status = 'fail' ORDER BY last_run_at DESC, phase LIMIT 20`,
  );
  return { ok: true, status: rows.length ? "warn" : "ok", detail: rows.length
    ? `${rows[0]!.total} phase(s) last failed: ${rows.map(r => `${r.phase} at ${r.last_run_at}`).join('; ')}; inspect cycle logs before retrying`
    : "no phase's latest run failed" };
}

export async function checkMaintenanceHeld(engine: Engine): Promise<OpsCheckResult> {
  const failures = await engine.query<{ phase: string; n: number }>(
    `SELECT phase, count(*)::int AS n FROM synth_failures
      WHERE attempts >= 3 AND next_eligible_at > now() GROUP BY phase ORDER BY phase`,
  );
  const chunks = await engine.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.embed_failures >= $1 AND ${embeddableChunkFragment("d", "c")}
        AND NOT EXISTS (SELECT 1 FROM embeddings em WHERE em.chunk_id = c.id)`, [EMBED_GAPS_MAX_FAILURES],
  );
  const n = chunks.rows[0]?.n ?? 0;
  const held = n + failures.rows.reduce((sum, r) => sum + r.n, 0);
  return { ok: true, status: held ? "warn" : "ok", detail:
    `synthesis backoff with >=3 failures: ${failures.rows.map(r => `${r.phase}=${r.n}`).join(', ') || 'none'}; embedding-held chunks=${n} (threshold ${EMBED_GAPS_MAX_FAILURES})` +
    (held ? "; correct the model/input failure first; synthesis retries after backoff or a content/model change; memrain embed retries held chunks explicitly" : "") };
}
