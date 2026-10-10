/**
 * Doctor self-heal / remediation layer.
 *
 * Covers: plan classification (remediable vs human_only vs blocked), the
 * dry-run default submitting nothing, `--remediate` enqueueing a durable job,
 * the per-run budget cap + maxJobs cap, idempotency, and the `remediation`
 * job handler dispatch.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import {
  buildRemediationPlan,
  classifyRemediation,
  autoFixDryViolations,
  submitRemediation,
  REMEDIATION_JOB_KIND,
  type RemediationInput,
} from "../src/core/remediation.ts";
import { makeRemediationHandler } from "../src/core/jobs/remediation-handlers.ts";
import { UnrecoverableJobError } from "../src/core/jobs/types.ts";

describe("classifyRemediation", () => {
  it("maps a 0-coverage source to a remediable + safe re-embed action", () => {
    const input: RemediationInput = {
      signals: [{ check: "source-health", ok: true }],
      brokenSources: [{ source_id: "vault", embeddable_chunks: 42 }],
    };
    const actions = classifyRemediation(input);
    const src = actions.find((a) => a.action === "reembed-source");
    expect(src).toBeDefined();
    expect(src?.status).toBe("remediable");
    expect(src?.safe).toBe(true);
    expect(src?.payload).toEqual({ action: "reembed-source", source_id: "vault" });
    expect(src?.est_usd_cost).toBeGreaterThan(0);
  });

  it("maps a stale cycle to a remediable cycle-phase re-run", () => {
    const actions = classifyRemediation({
      signals: [{ check: "cycle-freshness", ok: true, detail: "WARN: stale" }],
      cycleStale: true,
    });
    const cyc = actions.find((a) => a.action === "cycle-phase");
    expect(cyc?.status).toBe("remediable");
    expect(cyc?.payload).toEqual({ action: "cycle-phase", phase: "embed-stale" });
  });

  it("classifies a missing config as human_only, never remediable", () => {
    const actions = classifyRemediation({
      signals: [{ check: "config", ok: false, detail: "missing" }],
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.status).toBe("human_only");
    expect(actions[0]?.action).toBeUndefined();
    expect(actions[0]?.human_hint).toContain("memrain init");
  });

  it("BLOCKS source/cycle fixes when a root check (pglite) is failing", () => {
    const input: RemediationInput = {
      signals: [{ check: "pglite", ok: false }],
      brokenSources: [{ source_id: "vault", embeddable_chunks: 10 }],
      cycleStale: true,
    };
    const actions = classifyRemediation(input);
    const src = actions.find((a) => a.check === "per-source-embed-coverage");
    const cyc = actions.find((a) => a.check === "cycle-freshness");
    expect(src?.status).toBe("blocked");
    expect(cyc?.status).toBe("blocked");
    expect(src?.blocked_reason).toBeDefined();
    expect(src?.safe).toBe(false);
  });

  it("skips a source with 0 embeddable chunks (nothing to embed)", () => {
    const actions = classifyRemediation({
      signals: [],
      brokenSources: [{ source_id: "empty", embeddable_chunks: 0 }],
    });
    expect(actions.find((a) => a.action === "reembed-source")).toBeUndefined();
  });
});

describe("buildRemediationPlan", () => {
  it("buckets actions and totals only remediable estimates", () => {
    const plan = buildRemediationPlan({
      signals: [{ check: "config", ok: false }],
      brokenSources: [{ source_id: "vault", embeddable_chunks: 20 }],
    });
    // config fail is a root → the source fix is blocked, config is human_only.
    expect(plan.remediable).toHaveLength(0);
    expect(plan.human_only).toHaveLength(1);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.est_total_usd_cost).toBe(0);
  });

  it("is ok:true with no actions on a clean brain", () => {
    const plan = buildRemediationPlan({ signals: [{ check: "config", ok: true }] });
    expect(plan.ok).toBe(true);
    expect(plan.actions).toHaveLength(0);
  });
});

describe("autoFixDryViolations + submitRemediation (durable queue)", () => {
  let tmp: string;
  let storage: Storage;
  let queue: Queue;

  const healthyInput: RemediationInput = {
    signals: [{ check: "source-health", ok: true }],
    brokenSources: [{ source_id: "vault", embeddable_chunks: 30 }],
    cycleStale: true,
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-remediation-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    queue = new Queue(storage.engine());
  });

  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("dry-run is the DEFAULT and submits nothing", async () => {
    const { report } = await submitRemediation(queue, healthyInput);
    expect(report.dry_run).toBe(true);
    expect(report.submitted.every((s) => s.status === "dry_run")).toBe(true);
    const rows = await queue.list({ kind: REMEDIATION_JOB_KIND });
    expect(rows).toHaveLength(0);
  });

  it("--remediate (dryRun:false) enqueues a durable job", async () => {
    const { plan, report } = await submitRemediation(queue, healthyInput, {
      dryRun: false,
    });
    expect(plan.remediable.length).toBeGreaterThan(0);
    expect(report.dry_run).toBe(false);
    expect(report.submitted.some((s) => s.status === "submitted")).toBe(true);
    const rows = await queue.list({ kind: REMEDIATION_JOB_KIND });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.kind).toBe(REMEDIATION_JOB_KIND);
    expect(rows[0]?.payload["check"]).toBeDefined();
  });

  it("is idempotent — a second --remediate does not double-enqueue", async () => {
    await submitRemediation(queue, healthyInput, { dryRun: false });
    const first = await queue.list({ kind: REMEDIATION_JOB_KIND, limit: 500 });
    await submitRemediation(queue, healthyInput, { dryRun: false });
    const second = await queue.list({ kind: REMEDIATION_JOB_KIND, limit: 500 });
    expect(second.length).toBe(first.length);
  });

  it("honours the per-run USD budget cap", async () => {
    // A tiny cap admits nothing (each action costs > 0).
    const report = await autoFixDryViolations(
      queue,
      classifyRemediation(healthyInput),
      { dryRun: false, maxUsd: 0 },
    );
    expect(report.submitted.every((s) => s.status === "skipped_budget")).toBe(true);
    const rows = await queue.list({ kind: REMEDIATION_JOB_KIND });
    expect(rows).toHaveLength(0);
  });

  it("honours the maxJobs cap", async () => {
    const report = await autoFixDryViolations(
      queue,
      classifyRemediation(healthyInput),
      { dryRun: false, maxUsd: 100, maxJobs: 1 },
    );
    expect(report.submitted.filter((s) => s.status === "submitted")).toHaveLength(1);
  });

  it("revives a failed fix the same day instead of reporting a duplicate", async () => {
    const day = new Date("2026-10-10T12:00:00Z");
    const input = { ...healthyInput, now: day };
    const first = await submitRemediation(queue, input, { dryRun: false });
    const id = first.report.submitted.find((s) => s.status === "submitted")!.id;
    expect(id.endsWith(":2026-10-10")).toBe(true);
    const job = await queue.claim({ kinds: [REMEDIATION_JOB_KIND] });
    await queue.fail(job!.id, job!.claimGeneration, "boom", { terminal: true });

    const again = await submitRemediation(queue, input, { dryRun: false });
    const revived = again.report.submitted.find((s) => s.id === job!.id);
    expect(revived?.status).toBe("revived");
    expect((await queue.get(job!.id))?.status).toBe("pending");
  });

  it("a fix that succeeded stays a duplicate today and runs again tomorrow", async () => {
    const today = { ...healthyInput, now: new Date("2026-10-10T23:00:00Z") };
    await submitRemediation(queue, today, { dryRun: false });
    for (let job = await queue.claim(); job; job = await queue.claim()) {
      await queue.complete(job.id, job.claimGeneration, {});
    }
    const same = await submitRemediation(queue, today, { dryRun: false });
    expect(same.report.submitted.every((s) => s.status === "duplicate")).toBe(true);
    const tomorrow = { ...healthyInput, now: new Date("2026-10-11T01:00:00Z") };
    const next = await submitRemediation(queue, tomorrow, { dryRun: false });
    expect(next.report.submitted.every((s) => s.status === "submitted")).toBe(true);
  });
});

describe("remediation job handler dispatch", () => {
  it("dispatches reembed-source to the injected runner", async () => {
    const calls: string[] = [];
    const handler = makeRemediationHandler({
      reembedSource: async (id) => {
        calls.push(`reembed:${id}`);
        return { reembedded: id };
      },
    });
    const out = await handler(
      { action: "reembed-source", source_id: "vault" },
      { job: {} as never },
    );
    expect(calls).toEqual(["reembed:vault"]);
    expect(out).toMatchObject({ action: "reembed-source", source_id: "vault" });
  });

  it("dispatches cycle-phase to the injected runner", async () => {
    const calls: string[] = [];
    const handler = makeRemediationHandler({
      runCyclePhase: async (p) => {
        calls.push(`phase:${p}`);
      },
    });
    await handler({ action: "cycle-phase", phase: "embed-stale" }, { job: {} as never });
    expect(calls).toEqual(["phase:embed-stale"]);
  });

  it("throws on an unknown action", async () => {
    const handler = makeRemediationHandler({});
    await expect(
      handler({ action: "nope" }, { job: {} as never }),
    ).rejects.toThrow("unknown action");
  });

  it("throws when reembed-source is missing source_id", async () => {
    const handler = makeRemediationHandler({ reembedSource: async () => {} });
    await expect(
      handler({ action: "reembed-source" }, { job: {} as never }),
    ).rejects.toThrow("missing source_id");
  });

  it("fails a malformed payload as unrecoverable, so no retry is spent on it", async () => {
    const handler = makeRemediationHandler({ reembedSource: async () => {} });
    for (const payload of [
      { action: "reembed-source" },
      { action: "cycle-phase" },
      { action: "nope" },
    ]) {
      await expect(handler(payload, { job: {} as never })).rejects.toBeInstanceOf(UnrecoverableJobError);
    }
    await expect(
      makeRemediationHandler({})({ action: "reembed-source", source_id: "s" }, { job: {} as never }),
    ).rejects.toBeInstanceOf(UnrecoverableJobError);
  });
});
