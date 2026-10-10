/**
 * `_meta.brain_hot_memory` injection: the facts the brain learned in the last
 * 72 hours, read from the entity_facts ledger.
 *
 * Covers the feature gate (default OFF), the live-row filter, decay-weighted
 * ordering, source scoping, cache invalidation on add/forget, and the
 * dispatch-level public/tenant gating. PGLite-backed.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { addFact } from "../src/core/facts.ts";
import {
  getBrainHotMemoryMeta,
  hotMemoryMetaEnabled,
  __resetHotMemoryMetaCacheForTests,
} from "../src/core/hot-memory-meta.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

let tmp: string;
let storage: Storage;
let priorEnv: string | undefined;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-hotmeta-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await storage.engine().query(
    "INSERT INTO sources (id, kind, path_prefix) VALUES ('tenant-a', 'other', '/tenant-a/') ON CONFLICT (id) DO NOTHING",
  );
  priorEnv = process.env["MEMRAIN_HOT_MEMORY_META"];
  __resetHotMemoryMetaCacheForTests();
});

afterEach(async () => {
  if (priorEnv === undefined) delete process.env["MEMRAIN_HOT_MEMORY_META"];
  else process.env["MEMRAIN_HOT_MEMORY_META"] = priorEnv;
  __resetHotMemoryMetaCacheForTests();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

type HotFact = { id: number; fact: string; confidence: number };
const factsOf = (meta: Record<string, unknown> | undefined): HotFact[] | undefined =>
  (meta?.brain_hot_memory as { facts: HotFact[] } | undefined)?.facts;

async function age(id: number, hours: number): Promise<void> {
  await storage.engine().query(
    `UPDATE entity_facts SET written_at = NOW() - make_interval(hours => $2::int) WHERE id = $1`,
    [id, hours],
  );
}

describe("getBrainHotMemoryMeta", () => {
  it("is disabled by default (returns undefined even with facts)", async () => {
    delete process.env["MEMRAIN_HOT_MEMORY_META"];
    expect(hotMemoryMetaEnabled()).toBe(false);
    await addFact(storage, { entity_slug: "people/bob", fact: "likes tea" });
    expect(await getBrainHotMemoryMeta(storage)).toBeUndefined();
  });

  it("surfaces recent ledger facts, decay-weighted", async () => {
    process.env["MEMRAIN_HOT_MEMORY_META"] = "1";
    await addFact(storage, { entity_slug: "people/bob", fact: "recent-medium", confidence: 0.5 });
    // 48h old, full confidence: 1.0 * 0.5^(48/24) = 0.25 < 0.5.
    const old = await addFact(storage, { entity_slug: "companies/acme", fact: "old-high", confidence: 1 });
    await age(old.id!, 48);
    const facts = factsOf(await getBrainHotMemoryMeta(storage));
    expect(facts?.map((f) => f.fact)).toEqual(["recent-medium", "old-high"]);
    expect(facts![1]!.confidence).toBeCloseTo(0.25, 2);
  });

  it("leaves out forgotten facts and anything older than 72 hours", async () => {
    process.env["MEMRAIN_HOT_MEMORY_META"] = "1";
    const stale = await addFact(storage, { entity_slug: "people/bob", fact: "stale" });
    await age(stale.id!, 80);
    const gone = await addFact(storage, { entity_slug: "people/bob", fact: "gone" });
    await storage.engine().query(`UPDATE entity_facts SET forgotten_at = NOW() WHERE id = $1`, [gone.id]);
    expect(await getBrainHotMemoryMeta(storage)).toBeUndefined();
  });

  it("confines the payload to the given sources", async () => {
    process.env["MEMRAIN_HOT_MEMORY_META"] = "1";
    await addFact(storage, { entity_slug: "people/bob", fact: "default-source" });
    await addFact(storage, { entity_slug: "people/bob", fact: "tenant-a-fact", source_id: "tenant-a" });
    const facts = factsOf(await getBrainHotMemoryMeta(storage, { sourceIds: ["tenant-a"] }));
    expect(facts?.map((f) => f.fact)).toEqual(["tenant-a-fact"]);
  });
});

describe("dispatch injection", () => {
  beforeEach(async () => {
    process.env["MEMRAIN_HOT_MEMORY_META"] = "1";
    await addFact(storage, { entity_slug: "people/bob", fact: "held" });
  });

  it("attaches _meta for an internal (unscoped, non-public) call", async () => {
    const r = await dispatchTool(storage, { name: "get_brain_identity", arguments: {} }, {});
    expect(r.isError ?? false).toBe(false);
    expect(factsOf(r._meta)?.map((f) => f.fact)).toEqual(["held"]);
  });

  it("reflects an add_fact and a forget_fact on the next call, despite the cache", async () => {
    const before = await dispatchTool(storage, { name: "get_brain_identity", arguments: {} }, {});
    expect(factsOf(before._meta)?.length).toBe(1);
    const added = await dispatchTool(
      storage,
      { name: "add_fact", arguments: { entity_slug: "people/bob", fact: "fresh" } },
      {},
    );
    expect(factsOf(added._meta)?.map((f) => f.fact).sort()).toEqual(["fresh", "held"]);
    const id = (JSON.parse(added.content[0]!.text) as { id: number }).id;
    const forgot = await dispatchTool(storage, { name: "forget_fact", arguments: { id } }, {});
    expect(factsOf(forgot._meta)?.map((f) => f.fact)).toEqual(["held"]);
  });

  it("never attaches _meta on the public ingress", async () => {
    const r = await dispatchTool(
      storage,
      { name: "get_brain_identity", arguments: {} },
      { isPublic: true },
    );
    expect(r._meta).toBeUndefined();
  });

  it("never attaches _meta for a tenant-scoped (authInfo) call", async () => {
    const authInfo = {
      clientId: "memex_at_x",
      scopes: ["read"],
      allowedSources: ["tenant-a"],
      sourceId: "tenant-a",
    } as unknown as NonNullable<Parameters<typeof dispatchTool>[2]>["authInfo"];
    const r = await dispatchTool(
      storage,
      { name: "get_brain_identity", arguments: {} },
      { authInfo },
    );
    expect(r.isError).toBeFalsy();
    expect(r._meta).toBeUndefined();
  });
});
