import { lstatSync, readFileSync } from "node:fs";

interface BackupOptions { rdsInstance?: string; efsId?: string; copyReport?: string }
type Check = { status: string; [key: string]: unknown };

function describe(args: string[]): Record<string, any> {
  const child = Bun.spawnSync(["aws", ...args, "--output", "json", "--no-cli-pager", "--cli-connect-timeout", "5", "--cli-read-timeout", "10"], {
    env: { ...process.env, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off", AWS_MAX_ATTEMPTS: "1" },
    stdout: "pipe", stderr: "pipe", timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (child.exitCode !== 0) {
    const stderr = new TextDecoder().decode(child.stderr);
    throw new Error(/AccessDenied|UnauthorizedOperation/.test(stderr) ? "permission_denied" : "aws_unavailable");
  }
  return JSON.parse(new TextDecoder().decode(child.stdout));
}

function inspect(run: () => Check): Check {
  try { return run(); }
  catch (error) {
    const reason = error instanceof Error && error.message === "permission_denied" ? "permission_denied" : "unavailable";
    return { status: reason, hint: "Use an operator host with AWS CLI and read permissions; no infrastructure or permissions were changed." };
  }
}

function inspectCopy(path: string): Check {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return { status: "invalid_report" };
    const report = JSON.parse(readFileSync(path, "utf8"));
    if (report.dryRun || !Array.isArray(report.tables) || report.tables.length === 0 || !Array.isArray(report.missing) || !Array.isArray(report.failures)) return { status: "invalid_report" };
    const matched = report.ok === true && report.missing.length === 0 && report.failures.length === 0 &&
      report.tables.every((t: Record<string, unknown>) => t.match === true && typeof t.src === "number" && t.src === t.dst &&
        typeof t.srcHash === "string" && /^[0-9a-f]{64}$/.test(t.srcHash) && t.srcHash === t.dstHash &&
        (!Array.isArray(t.sourceOnlyColumns) || t.sourceOnlyColumns.length === 0));
    const time = typeof report.completedAt === "string" ? Date.parse(report.completedAt) : NaN;
    return { status: matched ? "matched" : "mismatch", tables: report.tables.length,
      completed_at: Number.isFinite(time) ? new Date(time).toISOString() : null,
      report_file_mtime: stat.mtime.toISOString(), note: "Operator-supplied report; only its listed tables were compared. This is not a fresh restore drill." };
  } catch { return { status: "invalid_report" }; }
}

export function runBackupStatus(opts: BackupOptions): number {
  if (!opts.rdsInstance && !opts.efsId && !opts.copyReport) throw new Error("backup status: provide --rds-instance, --efs-id or --copy-report");
  if (opts.rdsInstance && !/^[a-zA-Z][a-zA-Z0-9-]{0,62}$/.test(opts.rdsInstance)) throw new Error("backup status: invalid RDS instance identifier");
  if (opts.efsId && !/^fs-[a-f0-9]{8,40}$/.test(opts.efsId)) throw new Error("backup status: invalid EFS file system id");
  const rds = opts.rdsInstance ? inspect(() => {
    const db = describe(["rds", "describe-db-instances", "--db-instance-identifier", opts.rdsInstance!]).DBInstances?.[0];
    if (!db || !Number.isInteger(db.BackupRetentionPeriod)) throw new Error("missing instance");
    const result = describe(["rds", "describe-db-snapshots", "--db-instance-identifier", opts.rdsInstance!, "--snapshot-type", "automated", "--max-items", "1000"]);
    if (!Array.isArray(result.DBSnapshots)) throw new Error("missing snapshot list");
    const dates = result.DBSnapshots.filter((s: any) => s.Status === "available").map((s: any) => Date.parse(s.SnapshotCreateTime)).filter(Number.isFinite);
    const latest = dates.length ? Math.max(...dates) : null;
    return { status: "inspected", retention_days: db.BackupRetentionPeriod, latest_restorable_at: db.LatestRestorableTime ?? null,
      latest_snapshot_at: latest === null ? null : new Date(latest).toISOString(),
      snapshot_age_hours: latest === null ? null : Math.max(0, (Date.now() - latest) / 3_600_000),
      truncated: Boolean(result.NextToken), snapshot_type: "automated" };
  }) : { status: "not_checked" };
  const efs = opts.efsId ? inspect(() => {
    const policy = describe(["efs", "describe-backup-policy", "--file-system-id", opts.efsId!]).BackupPolicy?.Status;
    if (!["ENABLED", "ENABLING", "DISABLED", "DISABLING"].includes(policy)) throw new Error("missing policy");
    return { status: "inspected", policy, note: "Policy state does not prove a completed recovery point." };
  }) : { status: "not_checked" };
  const copy = opts.copyReport ? inspectCopy(opts.copyReport) : { status: "not_checked" };
  console.log(JSON.stringify({ checked_at: new Date().toISOString(), rds, efs, copy }, null, 2));
  return [rds, efs, copy].some(c => !["not_checked", "inspected", "matched"].includes(c.status)) ? 1 : 0;
}
