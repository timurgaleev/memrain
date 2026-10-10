/**
 * The links-stale cycle phase re-extracts a capped batch of stale pages per
 * tick, can be switched off, and stops writing once the cycle lock is gone.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { countStalePagesForExtraction } from "../src/core/links.ts";
import { ABORT_SETTLE_MS, ALL_PHASES, runCycleOnce, runPhase } from "../src/core/cycle/index.ts";
import { linksStaleMaxPerCycle, linksStalePhase, type LinksStaleResult } from "../src/core/cycle/links-stale.ts";
import { NOOP_PROGRESS } from "../src/core/output/progress.ts";

let tmp: string;
let storage: Storage;
let prevMax: string | undefined;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-links-stale-phase-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  prevMax = process.env.MEMRAIN_LINKS_STALE_MAX_PER_CYCLE;
  for (let i = 0; i < 5; i++) {
    await putPage(storage, { slug: `notes/n${i}`, markdown_body: `see [[notes/n${(i + 1) % 5}]]` });
  }
});
afterEach(async () => {
  if (prevMax === undefined) delete process.env.MEMRAIN_LINKS_STALE_MAX_PER_CYCLE;
  else process.env.MEMRAIN_LINKS_STALE_MAX_PER_CYCLE = prevMax;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function linkCount(): Promise<number> {
  const r = await storage.engine().query<{ n: number }>(`SELECT count(*)::int AS n FROM links`);
  return r.rows[0]!.n;
}

describe("links-stale phase", () => {
  it("is a default phase and reads its cap from the environment", () => {
    expect(ALL_PHASES).toContain("links-stale");
    expect(linksStaleMaxPerCycle(undefined)).toBe(200);
    expect(linksStaleMaxPerCycle("0")).toBe(0);
    expect(linksStaleMaxPerCycle("25")).toBe(25);
    expect(linksStaleMaxPerCycle("lots")).toBe(200);
  });

  it("re-extracts at most the cap per tick", async () => {
    process.env.MEMRAIN_LINKS_STALE_MAX_PER_CYCLE = "2";
    const r = await runCycleOnce(storage.engine(), { phases: ["links-stale"], storage });
    const detail = r.phases[0]!.detail as LinksStaleResult;
    expect(r.phases[0]!.status).toBe("ok");
    expect(detail).toMatchObject({ ran: true, pagesProcessed: 2, staleRemaining: 3, capHit: true });
    expect(await linkCount()).toBe(2);

    const next = await runCycleOnce(storage.engine(), { phases: ["links-stale"], storage });
    expect((next.phases[0]!.detail as LinksStaleResult).pagesProcessed).toBe(2);
    expect(await countStalePagesForExtraction(storage.engine())).toBe(1);
  });

  it("does nothing when switched off", async () => {
    process.env.MEMRAIN_LINKS_STALE_MAX_PER_CYCLE = "0";
    const r = await runCycleOnce(storage.engine(), { phases: ["links-stale"], storage });
    expect(r.phases[0]!.detail).toMatchObject({ ran: false, reason: "disabled" });
    expect(await countStalePagesForExtraction(storage.engine())).toBe(5);
  });

  it("stops before writing once the lock is gone", async () => {
    let checks = 0;
    // Held for the generation record and the first page, gone after.
    const fence = async () => ++checks <= 2;
    const r = await runPhase(
      storage.engine(),
      "links-stale",
      () => linksStalePhase(storage, { maxPages: 5 }),
      NOOP_PROGRESS,
      undefined,
      ABORT_SETTLE_MS,
      fence,
    );
    expect(r.status).toBe("fail");
    expect(r.error).toContain("lock_stolen");
    // The first page's edges were written, but nothing was stamped.
    expect(await linkCount()).toBe(1);
    expect(await countStalePagesForExtraction(storage.engine())).toBe(5);
  });
});
