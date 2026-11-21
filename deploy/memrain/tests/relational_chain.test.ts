/**
 * Multi-hop relational chains: the deterministic planner (relational-plan.ts)
 * and the bounded hop walk (relational-chain.ts), through relationalRecall and
 * the paid fallback's chain shape. Offline (PGLite), no Bedrock.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { addLink, KNOWN_LINK_TYPES } from "../src/core/links.ts";
import { deletePage, putPage } from "../src/core/pages.ts";
import { CHAIN_LINK_TYPES, parseRelationalPlan, validateChainHops } from "../src/core/search/relational-plan.ts";
import { byteCompare, FRONTIER_CAP, NEIGHBOR_CAP, runRelationalChain } from "../src/core/search/relational-chain.ts";
import { relationalRecall, type RelationalRecallMeta } from "../src/core/search/relational-recall.ts";
import { parseRelationalLlmChain, relationalRecallLlm } from "../src/core/search/relational-llm.ts";
import type { SonnetCallResult, SonnetFn } from "../src/core/llm/sonnet.ts";
import { rankingSignature } from "../src/core/search/query-cache.ts";

let tmp: string;
let storage: Storage;
const savedChainEnv = process.env["MEMRAIN_RELATIONAL_CHAIN"];

const page = (slug: string, type: string, title = slug.split("/").pop()!) =>
  putPage(storage, { slug, type, title, markdown_body: "x", allowAdHocType: true });
const link = (s: string, t: string, type: string) =>
  addLink(storage, { source_slug: s, target_slug: t, type, allowAdHocType: true });
const slugs = (rows: { slug: string }[]) => rows.map(r => r.slug).sort();

beforeAll(async () => {
  delete process.env["MEMRAIN_RELATIONAL_CHAIN"];
  tmp = mkdtempSync(join(tmpdir(), "memrain-relchain-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  // alice --invested_in--> acme, widget, gone (deleted later)
  // carol, dave --founded--> acme; erin --founded--> widget
  // frank --founded--> gone; dave --works_at--> beta (for a 3-hop walk)
  for (const [s, t] of [
    ["people/alice", "person"], ["people/carol", "person"], ["people/dave", "person"],
    ["people/erin", "person"], ["people/frank", "person"],
    ["companies/acme", "company"], ["companies/widget", "company"], ["companies/gone", "company"],
    ["companies/beta", "company"], ["life/diary/2026-11-01", "diary"],
  ] as const) await page(s, t);
  await link("people/alice", "companies/acme", "invested_in");
  await link("people/alice", "companies/widget", "invested_in");
  await link("people/alice", "companies/gone", "invested_in");
  await link("people/carol", "companies/acme", "founded");
  await link("people/dave", "companies/acme", "founded");
  await link("people/erin", "companies/widget", "founded");
  await link("people/frank", "companies/gone", "founded");
  await link("people/dave", "companies/beta", "works_at");
  await deletePage(storage, "companies/gone");
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  if (savedChainEnv === undefined) delete process.env["MEMRAIN_RELATIONAL_CHAIN"];
  else process.env["MEMRAIN_RELATIONAL_CHAIN"] = savedChainEnv;
});

describe("parseRelationalPlan", () => {
  it("plans a two-relation question anchor-outward", () => {
    const r = parseRelationalPlan("who founded the companies that alice invested in?");
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(r.plan.anchor).toBe("alice");
    expect(r.plan.hops).toEqual([
      { linkType: "invested_in", toward: "object" },
      { linkType: "founded", toward: "subject" },
    ]);
  });

  it("reads agent nouns and possessives", () => {
    const r = parseRelationalPlan("founders of alice's portfolio companies");
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(r.plan.anchor).toBe("alice");
    expect(r.plan.hops.map(h => [h.linkType, h.toward])).toEqual([["invested_in", "object"], ["founded", "subject"]]);
  });

  it("maps a tense marker on a state relation to a link status", () => {
    const r = parseRelationalPlan("which companies did the people who formerly worked at acme found");
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") return;
    expect(r.plan.hops[0]).toEqual({ linkType: "works_at", toward: "subject", status: "expired" });
  });

  it("leaves a single relation to the regex parser", () => {
    expect(parseRelationalPlan("who founded acme").kind).toBe("not_applicable");
    expect(parseRelationalPlan("what is the weather").kind).toBe("not_applicable");
  });

  it("refuses shapes it cannot answer rather than guessing", () => {
    expect(parseRelationalPlan("who founded or advised the companies alice invested in").kind).toBe("unsupported");
    expect(parseRelationalPlan("who founded the companies alice invested in before 2020").kind).toBe("unsupported");
    expect(parseRelationalPlan("who founded the companies alice and bob invested in").kind).toBe("unsupported");
    expect(parseRelationalPlan("who works at the meetings alice attended").kind).toBe("unsupported");
  });

  it("walks only link types ingest can write", () => {
    for (const t of CHAIN_LINK_TYPES) expect(KNOWN_LINK_TYPES as readonly string[]).toContain(t);
  });

  it("treats prototype names as plain words", () => {
    const r = parseRelationalPlan("who founded the companies that constructor invested in");
    expect(r.kind).toBe("plan");
    if (r.kind === "plan") expect(r.plan.anchor).toBe("constructor");
    expect(JSON.stringify(parseRelationalPlan("who founded the toString companies alice invested in"))).not.toContain("native code");
    expect(validateChainHops([{ link_type: "constructor", toward: "object" }])).toBeNull();
    expect(validateChainHops([{ link_type: "__proto__", toward: "object" }])).toBeNull();
    expect(validateChainHops([{ link_type: "hasOwnProperty", toward: "subject" }])).toBeNull();
  });

  it("validates a model-supplied hop list", () => {
    expect(validateChainHops([{ link_type: "invested_in", toward: "object" }])).toEqual([{ linkType: "invested_in", toward: "object" }]);
    expect(validateChainHops([{ link_type: "mentions", toward: "object" }])).toBeNull();
    expect(validateChainHops([{ link_type: "founded", toward: "sideways" }])).toBeNull();
    expect(validateChainHops(Array.from({ length: 4 }, () => ({ link_type: "founded", toward: "object" })))).toBeNull();
  });
});

describe("relationalRecall chains", () => {
  const Q = "who founded the companies that alice invested in?";

  it("answers a two-hop question with its path (was empty on the one-hop parser)", async () => {
    let meta: RelationalRecallMeta | undefined;
    const hits = await relationalRecall(storage, Q, { onMeta: (m) => { meta = m; } });
    expect(meta?.kind).toBe("chain");
    expect(slugs(hits)).toEqual(["people/carol", "people/dave", "people/erin"]);
    const dave = hits.find(h => h.slug === "people/dave")!;
    expect(dave.path).toEqual(["people/alice", "companies/acme", "people/dave"]);
    expect(dave.relation).toBe("founded");
    expect(dave.depth).toBe(2);
  });

  it("does not walk through a soft-deleted intermediate page", async () => {
    const hits = await relationalRecall(storage, Q);
    expect(slugs(hits)).not.toContain("people/frank");
  });

  it("MEMRAIN_RELATIONAL_CHAIN=0 keeps the question on the one-hop parser and re-keys the cache", async () => {
    const sigOn = rankingSignature();
    process.env["MEMRAIN_RELATIONAL_CHAIN"] = "0";
    try {
      expect(await relationalRecall(storage, Q)).toEqual([]);
      expect(rankingSignature()).toBe(`${sigOn}:rc=0`);
    } finally {
      delete process.env["MEMRAIN_RELATIONAL_CHAIN"];
    }
  });

  it("walks three hops", async () => {
    const hits = await relationalRecall(storage, "which companies do the founders of the companies alice invested in work at");
    expect(slugs(hits)).toEqual(["companies/beta"]);
    expect(hits[0]!.path).toEqual(["people/alice", "companies/acme", "people/dave", "companies/beta"]);
  });

  it("the last hop may land on a node the path already passed", async () => {
    await link("people/dave", "companies/acme", "works_at");
    try {
      const hits = await relationalRecall(storage, "which companies do the founders of the companies alice invested in work at");
      expect(slugs(hits)).toEqual(["companies/acme", "companies/beta"]);
      expect(hits.find(h => h.slug === "companies/acme")!.path).toEqual(["people/alice", "companies/acme", "people/dave", "companies/acme"]);
    } finally {
      await storage.engine().query(`DELETE FROM links WHERE source_slug = 'people/dave' AND target_slug = 'companies/acme' AND type = 'works_at'`);
    }
  });

  it("a head noun drops landing pages of another chain type before the cap", async () => {
    await page("deals/seed", "deal");
    await page("notes/bet", "note");
    for (const t of ["companies/widget", "deals/seed", "notes/bet"]) await link("people/carol", t, "invested_in");
    const plan = parseRelationalPlan("which companies did the founders of acme invest in");
    expect(plan.kind === "plan" && plan.plan.hops[1]!.nodeType).toBe("company");
    const hits = await relationalRecall(storage, "which companies did the founders of acme invest in");
    expect(slugs(hits)).toEqual(["companies/widget", "notes/bet"]);
  });

  it("an empty scope reads nothing; an out-of-scope link source cuts the walk", async () => {
    expect(await relationalRecall(storage, Q, { sourceIds: [] })).toEqual([]);
    await storage.engine().query(`INSERT INTO sources (id, kind, path_prefix) VALUES ('other', 'other', 'other/') ON CONFLICT DO NOTHING`);
    await storage.engine().query(`UPDATE links SET source_id = 'other' WHERE source_slug = 'people/erin'`);
    try {
      expect(slugs(await relationalRecall(storage, Q, { sourceIds: ["default"] }))).toEqual(["people/carol", "people/dave"]);
    } finally {
      await storage.engine().query(`UPDATE links SET source_id = 'default' WHERE source_slug = 'people/erin'`);
    }
  });

  it("a remote caller never walks through a diary page", async () => {
    await link("life/diary/2026-11-01", "companies/acme", "founded");
    try {
      const operator = await relationalRecall(storage, Q);
      expect(slugs(operator)).toContain("life/diary/2026-11-01");
      const remote = await relationalRecall(storage, Q, { remote: true });
      expect(slugs(remote)).not.toContain("life/diary/2026-11-01");
      expect(slugs(remote)).toEqual(["people/carol", "people/dave", "people/erin"]);
    } finally {
      await storage.engine().query(`DELETE FROM links WHERE source_slug = 'life/diary/2026-11-01'`);
    }
  });

  it("a min_trust floor fences intermediate pages too", async () => {
    await storage.engine().query(`UPDATE pages SET trust_tier = 'external' WHERE slug = 'companies/widget'`);
    try {
      const hits = await relationalRecall(storage, Q, { filters: { minTrust: "owner" } });
      expect(slugs(hits)).not.toContain("people/erin");
      expect(slugs(hits)).toContain("people/carol");
    } finally {
      await storage.engine().query(`UPDATE pages SET trust_tier = NULL WHERE slug = 'companies/widget'`);
    }
  });

  it("bounds fan-out per node and reports truncation", async () => {
    await page("people/hub", "person");
    await page("people/f", "person");
    for (let i = 0; i < NEIGHBOR_CAP + 5; i++) {
      const s = `companies/c${String(i).padStart(3, "0")}`;
      await page(s, "company");
      await link("people/hub", s, "invested_in");
      await link("people/f", s, "founded");
    }
    const run = await runRelationalChain(storage, "people/hub", {
      hops: [{ linkType: "invested_in", toward: "object" }, { linkType: "founded", toward: "subject" }],
      excludeAnchor: false,
    });
    expect(run.status).toBe("truncated");
    expect(run.perHop[0]!.edges).toBe(NEIGHBOR_CAP);
    expect(run.perHop[1]!.frontier).toBe(FRONTIER_CAP);
    expect(run.answers.map(a => a.slug)).toEqual(["people/f"]);
    expect(run.answers[0]!.score).toBe(FRONTIER_CAP);
  });

  it("orders ties by UTF-8 bytes", () => {
    expect(["b", "é", "a", "Ａ"].sort(byteCompare)).toEqual(["a", "b", "é", "Ａ"]);
  });
});

describe("paid fallback chain shape", () => {
  const fake = (body: string): { fn: SonnetFn; calls: () => number } => {
    let n = 0;
    const fn: SonnetFn = async (): Promise<SonnetCallResult> => {
      n += 1;
      return { text: body, modelId: "eu.anthropic.claude-sonnet-test", usage: { inputTokens: 50, outputTokens: 20 } };
    };
    return { fn, calls: () => n };
  };

  it("parses a chain object and rejects an unknown relation", () => {
    expect(parseRelationalLlmChain(`{"kind":"chain","seeds":["alice"],"hops":[{"link_type":"invested_in","toward":"object"}]}`))
      .toEqual({ anchor: "alice", hops: [{ linkType: "invested_in", toward: "object" }] });
    expect(parseRelationalLlmChain(`{"kind":"chain","seeds":["alice"],"hops":[{"link_type":"likes","toward":"object"}]}`)).toBeNull();
  });

  it("one call, then the same chain walk", async () => {
    const f = fake(`{"kind":"chain","seeds":["alice"],"hops":[{"link_type":"invested_in","toward":"object"},{"link_type":"founded","toward":"subject"}]}`);
    const hits = await relationalRecallLlm(storage, "people behind the startups alice put cash into", { sonnetFn: f.fn });
    expect(f.calls()).toBe(1);
    expect(slugs(hits)).toEqual(["people/carol", "people/dave", "people/erin"]);
  });
});
