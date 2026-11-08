/**
 * advisor/run.ts — runs the collectors and ranks the findings.
 *
 * Hardcoded collector list: a static array keeps ordering deterministic and the
 * surface auditable. Each collector runs in its OWN try/catch so one failure
 * never kills the whole report. No LLM, no writes — strictly read-only.
 */
import type {
  AdvisorCollector,
  AdvisorContext,
  AdvisorFinding,
  AdvisorReport,
  AdvisorSeverity,
} from "./types.ts";
import {
  collectMigration,
  collectVersion,
  collectStalledJobs,
  collectEmbedCoverage,
  collectUsageShape,
  collectChronicle,
  collectEvalBlind,
  collectTakesUngradeable,
  collectSetupSmells,
} from "./collectors.ts";

/** Deterministic collector order (also the secondary sort key for ranking). */
export const COLLECTORS: AdvisorCollector[] = [
  collectMigration,
  collectVersion,
  collectStalledJobs,
  collectEmbedCoverage,
  collectUsageShape,
  collectChronicle,
  collectEvalBlind,
  collectTakesUngradeable,
  collectSetupSmells,
];

const SEV_RANK: Record<AdvisorSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

/**
 * Rank: high > medium > low > info, ties broken by collector order (stable).
 * The info tail is capped so a connected agent isn't buried in FYIs.
 */
export function rankFindings(
  findings: AdvisorFinding[],
  opts: { infoCap?: number } = {},
): AdvisorFinding[] {
  const order = new Map(COLLECTORS.map((c, i) => [c.id, i] as const));
  const sorted = [...findings].sort((a, b) => {
    const s = SEV_RANK[a.severity] - SEV_RANK[b.severity];
    if (s !== 0) return s;
    return (order.get(a.collector) ?? 99) - (order.get(b.collector) ?? 99);
  });
  const infoCap = opts.infoCap ?? 10;
  const out: AdvisorFinding[] = [];
  let infoSeen = 0;
  for (const f of sorted) {
    if (f.severity === "info") {
      if (infoSeen >= infoCap) continue;
      infoSeen++;
    }
    out.push(f);
  }
  return out;
}

/** Highest severity present in a ranked list, for at-a-glance triage. */
function worstSeverity(findings: AdvisorFinding[]): AdvisorSeverity | null {
  for (const sev of ["high", "medium", "low", "info"] as const) {
    if (findings.some((f) => f.severity === sev)) return sev;
  }
  return null;
}

/**
 * Run every collector and return a ranked report. Resilient: a collector that
 * throws contributes a static failure finding and never aborts the others.
 */
export async function runAdvisor(ctx: AdvisorContext): Promise<AdvisorReport> {
  const all: AdvisorFinding[] = [];
  for (const c of COLLECTORS) {
    try {
      const found = await c.collect(ctx);
      for (const f of found) all.push(f);
    } catch (error) {
      console.error(`[advisor] collector_failed:${c.id}`, error);
      all.push({ id: `collector_failed:${c.id}`, collector: c.id, severity: "medium",
        title: "A diagnostic collector could not complete",
        detail: "This report is incomplete. Inspect server logs for the failed collector and retry.",
      });
    }
  }
  const ranked = rankFindings(all);
  return {
    version: ctx.version,
    generated_at: ctx.now.toISOString(),
    findings: ranked,
    worst: worstSeverity(ranked),
  };
}
