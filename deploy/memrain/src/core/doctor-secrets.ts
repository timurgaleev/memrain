/**
 * Doctor check `secret-exposure`: has the stored text been audited with the
 * current secret-scanner rules, and is anything it found still in place?
 *
 * Reads the last whole-brain `memrain secrets audit` run (every store, no
 * source filter) from secret_audit_runs;
 * it never scans. Warn, never fail: stored text that predates a rule is a
 * pending operator task, not a broken brain.
 */
import type { Engine } from "./engine/interface.ts";
import type { OpsCheckResult } from "./doctor-ops.ts";
import { latestSecretAuditRun } from "./secret-audit.ts";
import { SECRET_SCAN_VERSION } from "./secret-scan.ts";

/** An audit older than this no longer speaks for what was written since. */
export const SECRET_AUDIT_MAX_AGE_DAYS = 30;

export async function checkSecretExposure(engine: Engine, now: Date = new Date()): Promise<OpsCheckResult> {
  const run = await latestSecretAuditRun(engine);
  if (!run) {
    return {
      ok: true,
      status: "warn",
      detail: "stored text was never audited for secrets — run `memrain secrets audit`",
    };
  }
  const problems: string[] = [];
  if (run.scan_version < SECRET_SCAN_VERSION) {
    problems.push(`last audit used scanner v${run.scan_version}, current is v${SECRET_SCAN_VERSION}`);
  }
  const ageDays = (now.getTime() - Date.parse(run.finished_at)) / 86_400_000;
  if (ageDays > SECRET_AUDIT_MAX_AGE_DAYS) {
    problems.push(`last audit is ${Math.floor(ageDays)} days old`);
  }
  if (!run.applied && run.hits_total > 0) {
    problems.push(
      `${run.hits_total} hit(s) in ${run.rows_affected} row(s) not yet redacted` +
        (run.code_chunks_affected > 0 ? ` (${run.code_chunks_affected} code chunk(s))` : ""),
    );
  }
  if (run.applied && run.errors_total > 0) {
    problems.push(`${run.errors_total} row(s) the last apply could not rewrite`);
  }
  if (problems.length === 0) {
    return {
      ok: true,
      status: "ok",
      detail: `audited ${run.finished_at} with scanner v${run.scan_version}; nothing left to redact`,
    };
  }
  return {
    ok: true,
    status: "warn",
    detail: `${problems.join("; ")} — rotate what it lists, then \`memrain secrets audit --apply --yes\``,
  };
}
