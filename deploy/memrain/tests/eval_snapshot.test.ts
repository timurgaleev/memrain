/**
 * eval_snapshots (migration 068) — the nightly probe's durable history.
 * PGLite-backed; ReplayReport is hand-built (no live retrieval needed).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  recordEvalSnapshot,
  recordFailedEvalSnapshot,
  latestEvalSnapshot,
} from "../src/core/eval-snapshot.ts";
import { recordQuery, type replayAll, type ReplayReport } from "../src/core/eval-replay.ts";
import { evalTrendDetail } from "../src/commands/doctor.ts";
import { probeOnce } from "../src/commands/eval-probe.ts";
import { collectEvalBlind } from "../src/core/advisor/collectors.ts";
import type { AdvisorContext } from "../src/core/advisor/types.ts";
import { revertMigration, runMigrations } from "../src/core/migrate.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-evalsnap-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

function report(overrides: Partial<ReplayReport> = {}): ReplayReport {
  return {
    ok: true,
    ranAt: new Date().toISOString(),
    totalQueries: 5,
    scored: 4,
    meanRR: 0.42,
    hitRate: 0.8,
    meanRRCi95: { lo: 0.21, hi: 0.63 },
    hitRateCi95: { lo: 0.5, hi: 1 },
    replayedIdsSha256: "a".repeat(64),
    unscored: { count: 1, returnedAny: 1 },
    perQuery: [],
    ...overrides,
  };
}

async function seedQueries(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await recordQuery(storage.engine(), { id: `q${i}`, query: `query ${i}`, tag: "good", expectedDocId: `d${i}` });
  }
}

function replayStub(fn: (limit: number | undefined) => Promise<ReplayReport>): typeof replayAll {
  return (_s, opts) => fn(opts?.limit);
}

describe("eval snapshots", () => {
  it("records a row and reads it back as the latest", async () => {
    const { id } = await recordEvalSnapshot(storage.engine(), report());
    expect(id).toBeGreaterThan(0);
    const latest = await latestEvalSnapshot(storage.engine());
    expect(latest?.scored).toBe(4);
    expect(latest?.mean_rr).toBeCloseTo(0.42, 5);
    expect(latest?.hit_rate).toBeCloseTo(0.8, 5);
  });

  it("keeps the baseline/stability blocks in detail", async () => {
    await recordEvalSnapshot(
      storage.engine(),
      report({
        baseline: {
          paired: 4,
          meanRR: 0.4,
          hitRate: 0.75,
          deltaMeanRR: 0.02,
          deltaHitRate: 0.05,
          deltaMeanRRCi95: { lo: -0.1, hi: 0.15 },
          deltaHitRateCi95: { lo: -0.25, hi: 0.25 },
          significantDrop: false,
        },
      }),
    );
    const latest = await latestEvalSnapshot(storage.engine());
    expect((latest?.detail as { baseline?: { deltaMeanRR: number } }).baseline?.deltaMeanRR).toBeCloseTo(0.02, 5);
  });

  it("returns the newest of several snapshots", async () => {
    await recordEvalSnapshot(storage.engine(), report({ ranAt: "2026-01-01T00:00:00Z", meanRR: 0.1 }));
    await recordEvalSnapshot(storage.engine(), report({ ranAt: "2026-06-01T00:00:00Z", meanRR: 0.9 }));
    const latest = await latestEvalSnapshot(storage.engine());
    expect(latest?.mean_rr).toBeCloseTo(0.9, 5);
  });

  it("records a zero-scored run (empty eval set)", async () => {
    await recordEvalSnapshot(
      storage.engine(),
      report({ totalQueries: 0, scored: 0, meanRR: 0, hitRate: 0 }),
    );
    const latest = await latestEvalSnapshot(storage.engine());
    expect(latest?.total_queries).toBe(0);
    expect(latest?.scored).toBe(0);
  });

  it("records the replayed-set hash and the unscored count in detail", async () => {
    await recordEvalSnapshot(storage.engine(), report());
    const latest = await latestEvalSnapshot(storage.engine());
    expect(latest?.status).toBe("ok");
    expect(latest?.detail["replayed_ids_sha256"]).toBe("a".repeat(64));
    expect(latest?.detail["unscored"]).toEqual({ count: 1, returnedAny: 1 });
  });

  it("round-trips the bootstrap intervals through detail", async () => {
    await recordEvalSnapshot(storage.engine(), report());
    const latest = await latestEvalSnapshot(storage.engine());
    expect(latest?.detail["mean_rr_ci95"]).toEqual({ lo: 0.21, hi: 0.63 });
    expect(latest?.detail["hit_rate_ci95"]).toEqual({ lo: 0.5, hi: 1 });
  });
});

describe("probe run status", () => {
  it("records ok when the replay covered the whole eval set", async () => {
    await seedQueries(2);
    const out = await probeOnce(storage, {}, replayStub(async () => report({ totalQueries: 2 })));
    expect(out.status).toBe("ok");
    expect((await latestEvalSnapshot(storage.engine()))?.status).toBe("ok");
  });

  it("records capped when the limit left part of the eval set out", async () => {
    await seedQueries(3);
    let seenLimit: number | undefined;
    const out = await probeOnce(
      storage,
      { limit: 2 },
      replayStub(async (limit) => {
        seenLimit = limit;
        return report({ totalQueries: 2 });
      }),
    );
    expect(seenLimit).toBe(2);
    expect(out.status).toBe("capped");
    const latest = await latestEvalSnapshot(storage.engine());
    expect(latest?.status).toBe("capped");
    expect(evalTrendDetail(latest!)).toContain("capped");
  });

  it("counts the eval set before the replay, so a mid-run capture is not a cap", async () => {
    await seedQueries(2);
    const out = await probeOnce(
      storage,
      {},
      replayStub(async () => {
        await recordQuery(storage.engine(), { id: "late", query: "late", tag: "good" });
        return report({ totalQueries: 2 });
      }),
    );
    expect(out.status).toBe("ok");
  });

  it("records an error row and rethrows when the replay throws", async () => {
    await expect(
      probeOnce(storage, {}, replayStub(async () => {
        throw new Error("bedrock unreachable");
      })),
    ).rejects.toThrow("bedrock unreachable");
    const latest = await latestEvalSnapshot(storage.engine());
    expect(latest?.status).toBe("error");
    expect(latest?.detail["error"]).toBe("bedrock unreachable");
    expect(evalTrendDetail(latest!)).toContain("FAILED");
    expect(evalTrendDetail(latest!)).not.toContain("EMPTY");
  });

  it("does not read a failed run as an empty eval set", async () => {
    await recordFailedEvalSnapshot(storage.engine(), new Date().toISOString(), "boom");
    const findings = await collectEvalBlind.collect({
      engine: storage.raw(),
      version: "1.0.0",
      now: new Date(),
    } as AdvisorContext);
    expect(findings).toEqual([]);
  });
});

describe("migration 121", () => {
  it("reverts to the pre-status table, dropping failed rows, and re-applies", async () => {
    const e = storage.engine();
    await recordEvalSnapshot(e, report());
    await recordFailedEvalSnapshot(e, new Date().toISOString(), "boom");
    await expect(
      e.query(`INSERT INTO eval_snapshots (status) VALUES ('weird')`),
    ).rejects.toThrow();

    await revertMigration(e, 121);
    const cols = await e.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'eval_snapshots' AND column_name = 'status'`,
    );
    expect(cols.rows).toEqual([]);
    const rows = await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM eval_snapshots`);
    expect(rows.rows[0]!.n).toBe(1);

    // A reader on the reverted (pre-121) table still gets the latest row.
    expect((await latestEvalSnapshot(e))?.status).toBe("ok");

    const again = await runMigrations(e);
    expect(again.applied.map((m) => m.id)).toEqual([121]);
    expect((await latestEvalSnapshot(e))?.status).toBe("ok");
  });
});

describe("doctor eval-trend detail", () => {
  const row = {
    ran_at: "2026-09-19 02:30:00+00",
    total_queries: 9,
    scored: 9,
    mean_rr: 0.611,
    hit_rate: 0.889,
  };

  it("appends the intervals from a snapshot that stored them", async () => {
    await recordEvalSnapshot(storage.engine(), report({ meanRR: 0.611, hitRate: 0.889 }));
    const latest = await latestEvalSnapshot(storage.engine());
    expect(evalTrendDetail(latest!)).toContain("mean_rr=0.611 [0.21–0.63] hit_rate=0.889 [0.50–1.00] (scored 4/5)");
  });

  it("renders a legacy row byte-identically to the pre-interval format", () => {
    expect(evalTrendDetail({ ...row, detail: { ok: true } })).toBe(
      "last probe 2026-09-19 02:30:00+00: mean_rr=0.611 hit_rate=0.889 (scored 9/9)",
    );
  });

  it("still reports an empty eval set as unmeasured", () => {
    expect(evalTrendDetail({ ...row, total_queries: 0, scored: 0, detail: {} })).toContain("EMPTY");
  });
});
