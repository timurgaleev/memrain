/**
 * relationalRecall — deterministic relational-query arm. Offline (PGLite),
 * no Bedrock. Covers intent parsing, seed resolution gating, typed fanout,
 * the `connects` intersection, and fail-open behaviour.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { addLink } from "../src/core/links.ts";
import { putPage } from "../src/core/pages.ts";
import {
  parseRelationalQuery,
  relationalRecall,
  type RelationalRecallMeta,
} from "../src/core/search/relational-recall.ts";

let tmp: string;
let storage: Storage;

const page = (slug: string, type: string) =>
  putPage(storage, { slug, type, title: slug, markdown_body: "x" });

const link = (s: string, t: string, type: string) =>
  addLink(storage, { source_slug: s, target_slug: t, type, allowAdHocType: true });

const slugs = (rows: { slug: string }[]) => rows.map((r) => r.slug).sort();

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-relrecall-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();

  // Graph:
  //   people/alice-smith --works_at--> companies/acme
  //   people/bob         --works_at--> companies/acme
  //   people/alice-smith --founded--> companies/acme
  //   people/alice-smith --invested_in--> companies/widget-co
  //   people/alice-smith --knows--> people/bob
  // For `connects`: alice & bob both touch companies/acme.
  for (const [s, t] of [
    ["people/alice-smith", "person"],
    ["people/bob", "person"],
    ["companies/acme", "company"],
    ["companies/widget-co", "company"],
  ] as const) {
    await page(s, t);
  }
  await link("people/alice-smith", "companies/acme", "works_at");
  await link("people/bob", "companies/acme", "works_at");
  await link("people/alice-smith", "companies/acme", "founded");
  await link("people/alice-smith", "companies/widget-co", "invested_in");
  await link("people/alice-smith", "people/bob", "knows");
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("parseRelationalQuery", () => {
  it("parses 'who works at <seed>' as an inbound works_at query", () => {
    const p = parseRelationalQuery("who works at Acme?");
    expect(p?.kind).toBe("who_rel");
    expect(p?.seeds).toEqual(["Acme"]);
    expect(p?.linkTypes).toEqual(["works_at"]);
    expect(p?.direction).toBe("inbound");
  });

  it("parses an outbound 'where does <seed> work'", () => {
    const p = parseRelationalQuery("where does alice work");
    expect(p?.kind).toBe("who_rel");
    expect(p?.direction).toBe("outbound");
    expect(p?.linkTypes).toEqual(["works_at"]);
    expect(p?.seeds).toEqual(["alice"]);
  });

  it("parses a two-seed 'what connects <a> and <b>'", () => {
    const p = parseRelationalQuery("what connects alice and bob?");
    expect(p?.kind).toBe("connects");
    expect(p?.seeds).toEqual(["alice", "bob"]);
    expect(p?.linkTypes).toBeNull();
  });

  it("strips a leading article and surrounding quotes from the seed", () => {
    const p = parseRelationalQuery('who founded "the Acme"');
    expect(p?.seeds).toEqual(["Acme"]);
  });

  it("rejects a pronoun seed (precision-first)", () => {
    expect(parseRelationalQuery("who founded it")).toBeNull();
  });

  it("returns null for a non-relational passage query", () => {
    expect(parseRelationalQuery("notes about the offsite agenda")).toBeNull();
  });

  it("returns null for an over-long query", () => {
    expect(parseRelationalQuery("who founded " + "x".repeat(600))).toBeNull();
  });
});

describe("relationalRecall", () => {
  it("returns people who work at the resolved seed (inbound typed fanout)", async () => {
    let meta: RelationalRecallMeta | undefined;
    const hits = await relationalRecall(storage, "who works at acme?", {
      onMeta: (m) => (meta = m),
    });
    expect(slugs(hits)).toEqual(["people/alice-smith", "people/bob"]);
    expect(hits.every((h) => h.relation === "works_at" && h.depth === 1)).toBe(true);
    expect(meta?.fired).toBe(true);
    expect(meta?.kind).toBe("who_rel");
    expect(meta?.seeds_resolved).toBe(1);
    expect(meta?.candidates).toBe(2);
  });

  it("resolves a loose seed phrase to its canonical page slug", async () => {
    // "Alice Smith" → people/alice-smith via the exact-tail canonicalizer.
    const hits = await relationalRecall(storage, "where does Alice Smith work");
    expect(slugs(hits)).toEqual(["companies/acme"]);
    expect(hits[0]?.relation).toBe("works_at");
  });

  it("unions multiple link types for one verb without duplicating a slug", async () => {
    // "who founded acme" → founded edges; alice both founded AND works_at acme,
    // but the founded query only walks founded edges → alice once.
    const hits = await relationalRecall(storage, "who founded acme");
    expect(slugs(hits)).toEqual(["people/alice-smith"]);
    expect(hits[0]?.relation).toBe("founded");
  });

  it("finds the shared midpoint for a connects query", async () => {
    const hits = await relationalRecall(storage, "what connects alice-smith and bob?");
    // alice & bob both reach companies/acme (and each other via knows, but
    // endpoints are excluded). acme is the shared midpoint.
    expect(hits.map((h) => h.slug)).toContain("companies/acme");
    expect(hits.every((h) => h.relation === "connects")).toBe(true);
  });

  it("no-ops when the seed does not resolve to a real page", async () => {
    let meta: RelationalRecallMeta | undefined;
    const hits = await relationalRecall(storage, "who founded nonexistent-corp", {
      onMeta: (m) => (meta = m),
    });
    expect(hits).toEqual([]);
    expect(meta?.kind).toBe("who_rel");
    expect(meta?.seeds_resolved).toBe(0);
    expect(meta?.fired).toBe(false);
  });

  it("no-ops on a non-relational query (kind null)", async () => {
    let meta: RelationalRecallMeta | undefined;
    const hits = await relationalRecall(storage, "summary of the q3 plan", {
      onMeta: (m) => (meta = m),
    });
    expect(hits).toEqual([]);
    expect(meta?.kind).toBeNull();
    expect(meta?.fired).toBe(false);
  });

  it("honours the limit cap", async () => {
    const hits = await relationalRecall(storage, "who works at acme?", { limit: 1 });
    expect(hits.length).toBe(1);
  });

  it("applies min_trust before the walk's limit, so an eligible neighbour still fills it", async () => {
    await putPage(storage, { slug: "companies/acme", type: "company", title: "companies/acme", markdown_body: "x, agent edit", written_by_principal: "client:bot" });
    // Unfiltered, the agent-edited page comes first and would take the only slot.
    const first = await relationalRecall(storage, "who introduced me to bob?", { depth: 1, limit: 1 });
    expect(slugs(first)).toEqual(["companies/acme"]);
    const owner = await relationalRecall(storage, "who introduced me to bob?", { depth: 1, limit: 1, filters: { minTrust: "owner" } });
    expect(slugs(owner)).toEqual(["people/alice-smith"]);
  });
});
