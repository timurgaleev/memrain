import { afterAll, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const dir = mkdtempSync(join(tmpdir(), "backup-status-"));
const log = join(dir, "calls");
const aws = join(dir, "aws");
writeFileSync(aws, `#!${process.execPath}\nimport { appendFileSync } from "node:fs";
appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.FIXTURE_DENY === "1") { console.error("AccessDenied: PRIVATE-CREDENTIAL-MARKER"); process.exit(1); }
const op = process.argv[3];
console.log(JSON.stringify(op === "describe-db-instances" ? { DBInstances: [{ BackupRetentionPeriod: 7, LatestRestorableTime: "2026-01-02T00:00:00Z" }] } : op === "describe-db-snapshots" ? { DBSnapshots: [{ Status: "available", SnapshotCreateTime: "2026-01-01T00:00:00Z" }, { Status: "creating", SnapshotCreateTime: "2026-01-03T00:00:00Z" }] } : { BackupPolicy: { Status: "ENABLED" } }));
`);
chmodSync(aws, 0o700);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function run(deny = false) {
  return Bun.spawnSync([process.execPath, "src/cli.ts", "backup", "status", "--rds-instance", "fixture-db", "--efs-id", "fs-01234567"], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FIXTURE_LOG: log, FIXTURE_DENY: deny ? "1" : "0" }, stdout: "pipe", stderr: "pipe",
  });
}
it("reports retention, available snapshot age and EFS policy using only describe calls", () => {
  const result = run();
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(new TextDecoder().decode(result.stdout));
  expect(report.rds).toMatchObject({ status: "inspected", retention_days: 7, latest_snapshot_at: "2026-01-01T00:00:00.000Z" });
  expect(report.rds.snapshot_age_hours).toBeGreaterThan(0);
  expect(report.efs).toMatchObject({ status: "inspected", policy: "ENABLED" });
  expect(report.copy).toMatchObject({ status: "not_checked" });
  const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls.map(args => args[1]).sort()).toEqual(["describe-backup-policy", "describe-db-instances", "describe-db-snapshots"]);
});
it("reports unavailable permission instead of pretending backup coverage is verified", () => {
  const result = run(true);
  expect(result.exitCode).toBe(1);
  const text = new TextDecoder().decode(result.stdout);
  expect(text).toContain("permission_denied");
  expect(text).not.toContain("PRIVATE-CREDENTIAL-MARKER");
});
it("distinguishes a matching copy receipt from preview or mismatched evidence", () => {
  const path = join(dir, "copy.json");
  const summary = { ok: true, completedAt: "2026-01-01T00:00:00Z", missing: [], failures: [], tables: [
    { name: "pages", src: 2, dst: 2, srcHash: "a".repeat(64), dstHash: "a".repeat(64), match: true },
  ] };
  const check = (value: unknown) => {
    writeFileSync(path, JSON.stringify(value));
    const child = Bun.spawnSync([process.execPath, "src/cli.ts", "backup", "status", "--copy-report", path], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    return { code: child.exitCode, copy: JSON.parse(new TextDecoder().decode(child.stdout)).copy };
  };
  expect(check(summary)).toMatchObject({ code: 0, copy: { status: "matched", completed_at: "2026-01-01T00:00:00.000Z", tables: 1 } });
  expect(check({ ...summary, dryRun: true })).toMatchObject({ code: 1, copy: { status: "invalid_report" } });
  expect(check({ ...summary, tables: [{ ...summary.tables[0], dstHash: "b".repeat(64) }] })).toMatchObject({ code: 1, copy: { status: "mismatch" } });
});
