/**
 * `memrain trust proposals|accept|reject` — the owner's queue of lower-tier
 * writes that would have replaced a more trusted fact.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTrust } from "../src/commands/trust.ts";
import { Storage } from "../src/core/storage.ts";
import { addFact } from "../src/core/facts.ts";
import { replaceFact } from "../src/core/facts-replace.ts";

const tmp = mkdtempSync(join(tmpdir(), "memrain-trust-cli-"));
const cfgDir = join(tmp, ".memrain");
const cfgPath = join(cfgDir, "config.json");
const dbPath = join(cfgDir, "brain.pglite");

async function run(opts: Omit<Parameters<typeof runTrust>[0], "configPath">): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    return { code: await runTrust({ ...opts, configPath: cfgPath }), out: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

beforeAll(async () => {
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({
    database: { type: "pglite", path: dbPath },
    embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
    storage: {},
  }));
  const storage = new Storage({ dbPath });
  await storage.init();
  try {
    for (const who of ["ivy", "jon"]) {
      const old = await addFact(storage, { entity_slug: `people/${who}`, fact: `${who} lives in Rome` });
      const fresh = await addFact(storage, { entity_slug: `people/${who}`, fact: `${who} lives in Milan`, written_by_principal: "client:bot" });
      await replaceFact(storage.engine(), old.id!, fresh.id!, undefined);
    }
  } finally {
    await storage.close();
  }
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("memrain trust", () => {
  it("lists pending proposals with both facts quoted as data", async () => {
    const r = await run({ sub: "proposals", json: true });
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.out) as Array<{ entity_slug: string; old_tier: string; new_tier: string }>;
    expect(rows.map(x => x.entity_slug).sort()).toEqual(["people/ivy", "people/jon"]);
    expect(rows.every(x => x.old_tier === "owner" && x.new_tier === "agent")).toBe(true);
    const human = await run({ sub: "proposals" });
    expect(human.out).toContain(JSON.stringify("ivy lives in Milan"));
  });

  it("accepts one and rejects the other as the operator; a second decision fails", async () => {
    const rows = JSON.parse((await run({ sub: "proposals", json: true })).out) as Array<{ id: number; entity_slug: string }>;
    const ivy = rows.find(x => x.entity_slug === "people/ivy")!;
    const jon = rows.find(x => x.entity_slug === "people/jon")!;
    expect((await run({ sub: "accept", id: ivy.id })).code).toBe(0);
    expect((await run({ sub: "reject", id: jon.id })).code).toBe(0);
    expect((await run({ sub: "accept", id: jon.id })).code).toBe(1);
    expect(JSON.parse((await run({ sub: "proposals", json: true })).out)).toEqual([]);
    const all = JSON.parse((await run({ sub: "proposals", json: true, all: true })).out) as Array<{ entity_slug: string; status: string; decided_by: string }>;
    expect(all.find(x => x.entity_slug === "people/ivy")).toMatchObject({ status: "accepted", decided_by: "operator" });
    expect(all.find(x => x.entity_slug === "people/jon")).toMatchObject({ status: "rejected", decided_by: "operator" });
  });
});
