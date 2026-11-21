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
import { OPS_CHECK_NAMES } from "../src/core/doctor-categories.ts";
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

describe("checkSecretExposure", () => {
  it("is an ops check", () => {
    expect(OPS_CHECK_NAMES.has("secret-exposure")).toBe(true);
  });

  it("warns when the brain was never audited", async () => {
    const r = await checkSecretExposure(storage.engine(), NOW);
    expect(r.status).toBe("warn");
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("never audited");
  });

  it("ignores unfinished, source-filtered and partial-store runs", async () => {
    await run({ finished: null });
    await run({ source: "default" });
    await run({ kinds: ["pages"] });
    expect((await checkSecretExposure(storage.engine(), NOW)).detail).toContain("never audited");
  });

  it("is ok after a recent clean audit under the current rules", async () => {
    await run({});
    const r = await checkSecretExposure(storage.engine(), NOW);
    expect(r.status).toBe("ok");
  });

  it("is ok after a recent applied audit that found hits", async () => {
    await run({ applied: true, hits: 4 });
    expect((await checkSecretExposure(storage.engine(), NOW)).status).toBe("ok");
  });

  it("warns when an applied run could not rewrite every row", async () => {
    await run({ applied: true, hits: 4, errors: 1 });
    const r = await checkSecretExposure(storage.engine(), NOW);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("could not rewrite");
  });

  it("warns on unapplied hits", async () => {
    await run({ hits: 3 });
    const r = await checkSecretExposure(storage.engine(), NOW);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("3 hit(s)");
  });

  it("warns on an audit under older scanner rules", async () => {
    await run({ version: SECRET_SCAN_VERSION - 1 });
    const r = await checkSecretExposure(storage.engine(), NOW);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain(`scanner v${SECRET_SCAN_VERSION - 1}`);
  });

  it("warns on an audit older than 30 days", async () => {
    await run({ finished: "2026-08-01T00:00:00Z" });
    const r = await checkSecretExposure(storage.engine(), NOW);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("days old");
  });

  describe("a rule change that reaches agent transcripts only", () => {
    const previous = SECRET_SCAN_VERSION - 1;
    it("counts a clean transcript-lane audit under the current rules as complete", async () => {
      expect([...TRANSCRIPT_ONLY_SCAN_VERSIONS].sort()).toEqual([7, 8]);
      expect(TRANSCRIPT_ONLY_SCAN_VERSIONS.has(SECRET_SCAN_VERSION)).toBe(true);
      await run({ version: previous });
      await run({ version: SECRET_SCAN_VERSION, kinds: ["pages"], lane: "transcripts", applied: true, hits: 2 });
      const r = await checkSecretExposure(storage.engine(), NOW);
      expect(r.status).toBe("ok");
      expect(r.detail).toContain(`transcripts audited with scanner v${SECRET_SCAN_VERSION}`);
    });

    it("still warns while the transcript-lane audit has hits it did not redact", async () => {
      await run({ version: previous });
      await run({ version: SECRET_SCAN_VERSION, kinds: ["pages"], lane: "transcripts", hits: 4 });
      const r = await checkSecretExposure(storage.engine(), NOW);
      expect(r.status).toBe("warn");
      expect(r.detail).toContain("4 hit(s)");
    });

    it("does not count a pages-only run that was not the transcript lane", async () => {
      await run({ version: previous });
      await run({ version: SECRET_SCAN_VERSION, kinds: ["pages"] });
      const r = await checkSecretExposure(storage.engine(), NOW);
      expect(r.status).toBe("warn");
      expect(r.detail).toContain(`scanner v${previous}`);
    });

    it("does not stretch over a rule change that reaches every store", async () => {
      await run({ version: 5 });
      await run({ version: SECRET_SCAN_VERSION, kinds: ["pages"], lane: "transcripts", applied: true });
      const r = await checkSecretExposure(storage.engine(), NOW);
      expect(r.status).toBe("warn");
      expect(r.detail).toContain("scanner v5");
    });
  });
});
