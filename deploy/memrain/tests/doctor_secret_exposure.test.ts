/**
 * Doctor `secret-exposure`: reads the last whole-brain secret audit run and
 * warns when there is none, when it used older scanner rules, when it is more
 * than 30 days old, or when its hits were never redacted. It never scans.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { checkSecretExposure } from "../src/core/doctor-secrets.ts";
import { SECRET_SCAN_VERSION, TRANSCRIPT_ONLY_SCAN_VERSIONS } from "../src/core/secret-scan.ts";
import { AUDIT_STORES } from "../src/core/secret-audit.ts";

let tmp: string;
let storage: Storage;
const NOW = new Date("2026-10-10T12:00:00Z");

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-doctor-secrets-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function run(o: {
  version?: number;
  finished?: string | null;
  applied?: boolean;
  hits?: number;
  source?: string | null;
  kinds?: string[];
  errors?: number;
  lane?: string;
}): Promise<void> {
  await storage.engine().query(
    `INSERT INTO secret_audit_runs (scan_version, started_at, finished_at, source_id, applied, rows_affected, hits_total, kinds, errors_total, lane)
     VALUES ($1, COALESCE($2::timestamptz, now()), $2::timestamptz, $3, $4, $5, $5, $6::text[], $7, $8)`,
    [
      o.version ?? SECRET_SCAN_VERSION,
      o.finished === undefined ? "2026-10-09T12:00:00Z" : o.finished,
      o.source ?? null,
      o.applied ?? false,
      o.hits ?? 0,
      o.kinds ?? [...AUDIT_STORES],
      o.errors ?? 0,
      o.lane ?? null,
    ],
  );
}

