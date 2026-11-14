import { afterEach, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  ProviderLeaseBusy,
  leaseKeyForModel,
  parseLeaseLimits,
  releaseLease,
  tryAcquireLease,
  withProviderLease,
} from "../src/core/jobs/rate-leases.ts";
import { setSpendLedgerEngine, trackedInvoke } from "../src/core/budget.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { Worker } from "../src/core/jobs/worker.ts";
import { _resetHandlersForTesting, registerHandler } from "../src/core/jobs/handlers.ts";

const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const OWNER = { owner: "test:1", ttlMs: 60_000 };
const leaseRows = async (e: Engine) => Number((await e.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM provider_leases`)).rows[0]!.n);

afterEach(() => {
  setSpendLedgerEngine(null);
  _resetHandlersForTesting();
});

describe("lease limits and keys", () => {
  it("parses key=limit pairs and skips malformed ones", () => {
    const warns: string[] = [];
    expect([...parseLeaseLimits("bedrock:haiku=2, bedrock:sonnet=1,junk,bedrock:x=0,bedrock:y=-1", w => warns.push(w))])
      .toEqual([["bedrock:haiku", 2], ["bedrock:sonnet", 1]]);
    expect(warns).toHaveLength(3);
    expect(parseLeaseLimits(undefined).size).toBe(0);
  });

  it("keys a model by provider and family", () => {
    expect(leaseKeyForModel("bedrock", HAIKU)).toBe("bedrock:haiku");
    expect(leaseKeyForModel("bedrock", "anthropic.claude-sonnet-4-5-v1:0")).toBe("bedrock:sonnet");
    expect(leaseKeyForModel("bedrock", "amazon.titan-embed-text-v2:0")).toBe("bedrock:embed");
  });

  it("touches no database when no limit covers the call", async () => {
    const engine = { query: () => { throw new Error("queried"); }, transaction: () => { throw new Error("queried"); } } as unknown as Engine;
    expect(await withProviderLease(engine, "bedrock", HAIKU, async () => "sent", { env: {} })).toBe("sent");
  });
});

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`provider leases (${name})`, () => {
  it("admits up to the limit, then frees a slot on release", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const a = await tryAcquireLease(e, "bedrock:haiku", 2, OWNER);
      const b = await tryAcquireLease(e, "bedrock:haiku", 2, OWNER);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(await tryAcquireLease(e, "bedrock:haiku", 2, OWNER)).toBeNull();
      expect(await tryAcquireLease(e, "bedrock:sonnet", 1, OWNER)).not.toBeNull();
      await releaseLease(e, a!);
      expect(await tryAcquireLease(e, "bedrock:haiku", 2, OWNER)).not.toBeNull();
    } finally { await db.close(); }
  });

  it("frees the slot of a holder that died once its lease expires", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await e.query(`INSERT INTO provider_leases (id, lease_key, owner, expires_at) VALUES ('dead', 'bedrock:haiku', 'gone:1', NOW() - INTERVAL '1 second')`);
      expect(await tryAcquireLease(e, "bedrock:haiku", 1, OWNER)).not.toBeNull();
      expect((await e.query(`SELECT 1 FROM provider_leases WHERE id = 'dead'`)).rows).toEqual([]);
    } finally { await db.close(); }
  });

  it("a call that finds every slot taken waits, then is refused without being sent", async () => {
    const db = await open();
    const e = db.storage.engine();
    const env = { MEMRAIN_PROVIDER_LEASES: "bedrock:haiku=1" };
    try {
      await tryAcquireLease(e, "bedrock:haiku", 1, OWNER);
      let sent = false;
      await expect(withProviderLease(e, "bedrock", HAIKU, async () => { sent = true; }, { env, waitMs: 60, pollMs: 10 }))
        .rejects.toBeInstanceOf(ProviderLeaseBusy);
      expect(sent).toBe(false);
      expect(await leaseRows(e)).toBe(1);
    } finally { await db.close(); }
  });

  it("trackedInvoke holds a lease for the call and refuses when none is free", async () => {
    const db = await open();
    const e = db.storage.engine();
    setSpendLedgerEngine(e);
    const prev = { leases: process.env.MEMRAIN_PROVIDER_LEASES, wait: process.env.MEMRAIN_PROVIDER_LEASE_WAIT_MS };
    process.env.MEMRAIN_PROVIDER_LEASES = "bedrock:haiku=1";
    process.env.MEMRAIN_PROVIDER_LEASE_WAIT_MS = "50";
    const call = { operation: "test", model: HAIKU, worstCase: { input: "x", maxOutputTokens: 1 } };
    try {
      let during = -1;
      await trackedInvoke(call, async () => { during = await leaseRows(e); return null; });
      expect(during).toBe(1);
      expect(await leaseRows(e)).toBe(0);

      await tryAcquireLease(e, "bedrock:haiku", 1, OWNER);
      let sent = false;
      await expect(trackedInvoke(call, async () => { sent = true; return null; })).rejects.toBeInstanceOf(ProviderLeaseBusy);
      expect(sent).toBe(false);
    } finally {
      for (const [k, v] of [["MEMRAIN_PROVIDER_LEASES", prev.leases], ["MEMRAIN_PROVIDER_LEASE_WAIT_MS", prev.wait]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      await db.close();
    }
  });

  it("the worker defers a job refused for want of a lease without spending a retry", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      registerHandler("needs_lease", async () => { throw new ProviderLeaseBusy("bedrock:haiku"); });
      const queue = new Queue(e);
      await queue.enqueue({ kind: "needs_lease", id: "j1", maxRetries: 3 });
      await new Worker(queue, { logger: () => {} }).drainOnce();
      const job = (await queue.get("j1"))!;
      expect(job.status).toBe("pending");
      expect(job.retryCount).toBe(0);
      expect(job.deferredCount).toBe(1);
      expect(job.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    } finally { await db.close(); }
  });
});

if (process.env.MEMRAIN_TEST_POSTGRES_URL) describe("provider leases across processes (Postgres)", () => {
  it("racing acquires from two engines never exceed the limit", async () => {
    const pg = storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL).find(x => x.name === "Postgres")!;
    const db = await pg.open();
    const e = db.storage.engine();
    const url = new URL(process.env.MEMRAIN_TEST_POSTGRES_URL!);
    url.pathname = `/${(await e.query<{ name: string }>("SELECT current_database() AS name")).rows[0]!.name}`;
    const other = new PostgresEngine({ url: url.toString(), max: 3 });
    try {
      const got = await Promise.all(Array.from({ length: 8 }, (_, i) => tryAcquireLease(i % 2 ? e : other, "bedrock:haiku", 2, OWNER)));
      expect(got.filter(Boolean)).toHaveLength(2);
      expect(await leaseRows(e)).toBe(2);
    } finally {
      await other.close();
      await db.close();
    }
  });
});
