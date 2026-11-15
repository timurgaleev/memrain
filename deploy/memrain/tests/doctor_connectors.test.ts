/**
 * The connector-health doctor check over seeded `recipe_state` rows.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { checkConnectorHealth } from "../src/core/connectors/health.ts";
import { connectorRecipeId, recordRun } from "../src/core/connectors/watermark.ts";
import type { ConnectorRunStatus } from "../src/core/connectors/types.ts";

const NOW = Date.parse("2026-09-19T12:00:00Z");
const DAY = 86_400_000;
let tmp: string;
let storage: Storage;
const savedStall = process.env.MEMRAIN_CONNECTOR_STALL_DAYS;

beforeEach(async () => {
  delete process.env.MEMRAIN_CONNECTOR_STALL_DAYS;
  tmp = mkdtempSync(join(tmpdir(), "memrain-doctor-connectors-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  if (savedStall === undefined) delete process.env.MEMRAIN_CONNECTOR_STALL_DAYS;
  else process.env.MEMRAIN_CONNECTOR_STALL_DAYS = savedStall;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function seed(target: string, status: ConnectorRunStatus, at: number, httpStatus: number | null = null): Promise<void> {
  await recordRun(
    storage.engine(),
    connectorRecipeId("github", target),
    {
      provider: "github",
      target,
      source_id: "gh",
      status,
      at: new Date(at).toISOString(),
      counts: { items: 0, pages_written: 0, pages_unchanged: 0, items_rejected: 0, items_failed: 0 },
      error_class: null,
      http_status: httpStatus,
    },
    new Date(at).toISOString(),
  );
}

describe("checkConnectorHealth", () => {
  it("passes when no connector account exists and no connector has run", async () => {
    expect(await checkConnectorHealth(storage.engine(), NOW)).toEqual({ ok: true, status: "ok", detail: "no connector account and no connector has run" });
  });

  it("passes for a connector with a recent clean run", async () => {
    await seed("acme/widgets@gh", "success", NOW - DAY);
    const r = await checkConnectorHealth(storage.engine(), NOW);
    expect(r.status).toBe("ok");
  });

  it("flags an expired credential as re-auth needed, without failing the doctor", async () => {
    await seed("acme/widgets@gh", "success", NOW - 2 * DAY);
    await seed("acme/widgets@gh", "auth_required", NOW - DAY, 401);
    const r = await checkConnectorHealth(storage.engine(), NOW);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("github:acme/widgets@gh: re-auth needed");
    expect(r.detail).toContain("HTTP 401");
  });

  it("flags a forbidden run the same way", async () => {
    await seed("acme/secret@gh", "forbidden", NOW - DAY, 404);
    expect((await checkConnectorHealth(storage.engine(), NOW)).detail).toContain("re-auth needed");
  });

  it("flags a connector whose last clean run is older than the stall window", async () => {
    await seed("acme/widgets@gh", "success", NOW - 10 * DAY);
    await seed("acme/widgets@gh", "partial", NOW - DAY);
    const r = await checkConnectorHealth(storage.engine(), NOW);
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("stalled");
    process.env.MEMRAIN_CONNECTOR_STALL_DAYS = "30";
    expect((await checkConnectorHealth(storage.engine(), NOW)).status).toBe("ok");
  });

  it("flags a connector that never had a clean run", async () => {
    await seed("acme/widgets@gh", "partial", NOW - DAY);
    expect((await checkConnectorHealth(storage.engine(), NOW)).detail).toContain("no clean run yet");
  });
});
