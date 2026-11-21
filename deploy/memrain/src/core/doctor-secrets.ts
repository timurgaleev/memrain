/**
 * Doctor check `secret-exposure`: has the stored text been audited with the
 * current secret-scanner rules, and is anything it found still in place?
 *
 * Reads the last whole-brain `memrain secrets audit` run (every store, no
 * source filter) from secret_audit_runs; it never scans. When every rule
 * change since that run reached agent transcripts only, a transcript-lane
 * audit under the current rules completes it, since connector mail is never
 * rescanned for those rules. Warn, never fail: stored text that predates a rule is a
 * pending operator task, not a broken brain.
 */
import type { Engine } from "./engine/interface.ts";
import type { OpsCheckResult } from "./doctor-ops.ts";
import { latestSecretAuditRun, latestTranscriptLaneRun, type SecretAuditRunSummary } from "./secret-audit.ts";
import { SECRET_SCAN_VERSION, TRANSCRIPT_ONLY_SCAN_VERSIONS } from "./secret-scan.ts";

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
  const lane = run.scan_version < SECRET_SCAN_VERSION ? await transcriptLaneCompletes(engine, run.scan_version) : null;
  if (run.scan_version < SECRET_SCAN_VERSION && lane === null) {
    problems.push(`last audit used scanner v${run.scan_version}, current is v${SECRET_SCAN_VERSION}`);
  }
  if (lane && !lane.applied && lane.hits_total > 0) {
    problems.push(`${lane.hits_total} hit(s) in ${lane.rows_affected} transcript page(s) not yet redacted`);
  }
  if (lane && lane.applied && lane.errors_total > 0) {
    problems.push(`${lane.errors_total} transcript page(s) the last apply could not rewrite`);
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
      detail: `audited ${run.finished_at} with scanner v${run.scan_version}` +
        (lane ? `, transcripts audited with scanner v${lane.scan_version} at ${lane.finished_at}` : "") +
        "; nothing left to redact",
    };
  }
  return {
    ok: true,
    status: "warn",
    detail: `${problems.join("; ")} — rotate what it lists, then \`memrain secrets audit --apply --yes\``,
  };
}

/** The transcript-lane run that brings a store audit at `from` up to the current rules, or null. */
async function transcriptLaneCompletes(engine: Engine, from: number): Promise<SecretAuditRunSummary | null> {
  for (let v = from + 1; v <= SECRET_SCAN_VERSION; v++) {
    if (!TRANSCRIPT_ONLY_SCAN_VERSIONS.has(v)) return null;
  }
  const lane = await latestTranscriptLaneRun(engine);
  return lane !== null && lane.scan_version >= SECRET_SCAN_VERSION ? lane : null;
}

/**
 * Doctor check `secret-store`: can this host read the redacted originals the
 * store keeps, does every entry still have a page that holds it, and does an
 * encrypted backup hold the store as it is now? Counts and key ids only.
 */
export async function checkSecretStore(engine: Engine): Promise<OpsCheckResult> {
  const { loadKek } = await import("./connectors/vault.ts");
  const { unreferencedSecretOriginals } = await import("./secret-store.ts");
  const { readBackupStatus, secretStoreBackupDue } = await import("./secret-store-backup.ts");
  const key = loadKek();
  const r = await engine.query<{ entries: number; other_key: number }>(
    // scope: operator-only doctor count over the whole store
    `SELECT count(*)::int AS entries, count(*) FILTER (WHERE kek_id IS DISTINCT FROM $1)::int AS other_key FROM secret_store`,
    [key.kek?.id ?? null],
  );
  const { entries, other_key: otherKey } = r.rows[0] ?? { entries: 0, other_key: 0 };
  if (key.kek === null) {
    return entries === 0
      ? { ok: true, status: "ok", detail: `off: redacted originals are not kept (${key.reason})` }
      : { ok: true, status: "warn", detail: `${entries} kept original(s) cannot be read here: ${key.reason}` };
  }
  const problems: string[] = [];
  if (otherKey > 0) problems.push(`${otherKey} of ${entries} kept original(s) are sealed with a key this host does not hold`);
  const unreferenced = await unreferencedSecretOriginals(engine);
  if (unreferenced > 0) problems.push(`${unreferenced} kept original(s) no page holds any more`);
  if (await secretStoreBackupDue(engine)) {
    const last = readBackupStatus();
    problems.push(last.last_success ? `the store changed since the last backup (${last.last_success.at})` : "the store was never backed up");
    if (last.last_failure) problems.push(`the last backup failed at ${last.last_failure.at}`);
  }
  if (problems.length === 0) return { ok: true, status: "ok", detail: `${entries} kept original(s), all readable and backed up` };
  return { ok: true, status: "warn", detail: `${problems.join("; ")} — \`memrain secrets backup\` writes an encrypted backup` };
}
