/**
 * Facts-fence reconciliation (#extract_facts) — project a page's `## Facts`
 * fence into entity_facts, source-scoped wipe + re-insert, preserving
 * legacy/explicit facts, with re-read+hash concurrency guard, malformed-fence
 * protection, row clamps, and delete purge.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage, deletePage } from "../src/core/pages.ts";
import { addFact } from "../src/core/facts.ts";
import { forgetFact } from "../src/core/facts-recall.ts";
import { renderFactsFence, type ParsedFact } from "../src/core/facts-fence.ts";
import {
  factsFenceEnabled,
  purgeFenceFactsForPage,
  reconcileFactsForPage,
} from "../src/core/facts-reconcile.ts";

let tmp: string;
let storage: Storage;

function clearEnv(): void {
  delete process.env.MEMRAIN_FACTS_FENCE;
}

beforeEach(async () => {
  clearEnv();
  tmp = mkdtempSync(join(tmpdir(), "memrain-facts-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  clearEnv();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

interface RawFact {
  entity_slug: string;
  fact: string;
  confidence: number;
  source_slug: string | null;
  source_markdown_slug: string | null;
  row_num: number | null;
  written_by: string | null;
}

async function factsFor(page: string): Promise<RawFact[]> {
  const r = await storage.engine().query<RawFact>(
    `SELECT entity_slug, fact, confidence, source_slug, source_markdown_slug,
            row_num, written_by
       FROM entity_facts WHERE entity_slug = $1 ORDER BY row_num NULLS FIRST, id`,
    [page],
  );
  return r.rows;
}

function fenceBody(facts: ParsedFact[]): string {
  return `# Alice\n\nSome prose.\n\n## Facts\n${renderFactsFence(facts)}\n`;
}

/** Put a page with the given body and reconcile it (returns the reconcile result). */
async function putAndReconcile(slug: string, body: string) {
  const r = await putPage(storage, { slug, type: "person", markdown_body: body });
  return reconcileFactsForPage(storage, slug, r.content_hash);
}

describe("factsFenceEnabled", () => {
  it("is ON by default, OFF only on an explicit 0", () => {
    expect(factsFenceEnabled(undefined)).toBe(true);
    expect(factsFenceEnabled("1")).toBe(true);
    expect(factsFenceEnabled("0")).toBe(false);
  });
});

describe("reconcileFactsForPage", () => {
  it("projects fence rows into entity_facts keyed by source + row_num", async () => {
    const r = await putAndReconcile(
      "people/alice",
      fenceBody([
        { rowNum: 1, claim: "ex-CFO at Acme", confidence: 0.9, source: "meetings/m1", active: true },
        { rowNum: 2, claim: "lives in Berlin", confidence: 1.0, active: true },
      ]),
    );
    expect(r.added).toBe(2);
    const facts = await factsFor("people/alice");
    expect(facts.map((f) => f.fact)).toEqual(["ex-CFO at Acme", "lives in Berlin"]);
    expect(facts[0]).toMatchObject({
      entity_slug: "people/alice",
      source_slug: "meetings/m1",
      source_markdown_slug: "people/alice",
      row_num: 1,
      written_by: "memrain:facts-fence",
    });
    expect(facts[1]!.source_slug).toBeNull();
  });

  it("replaces the page's fence facts on re-reconcile", async () => {
    await putAndReconcile(
      "people/alice",
      fenceBody([{ rowNum: 1, claim: "old fact", confidence: 1, active: true }]),
    );
    const r = await putAndReconcile(
      "people/alice",
      fenceBody([{ rowNum: 1, claim: "new fact", confidence: 1, active: true }]),
    );
    expect(r.removed).toBe(1);
    expect(r.added).toBe(1);
    expect((await factsFor("people/alice")).map((f) => f.fact)).toEqual(["new fact"]);
  });

  it("excludes struck (retracted) fence rows", async () => {
    await putAndReconcile(
      "people/alice",
      fenceBody([
        { rowNum: 1, claim: "active fact", confidence: 1, active: true },
        { rowNum: 2, claim: "retracted fact", confidence: 1, active: false },
      ]),
    );
    expect((await factsFor("people/alice")).map((f) => f.fact)).toEqual(["active fact"]);
  });

  it("preserves a legacy/explicit fact (NULL source_markdown_slug)", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    await addFact(storage, { entity_slug: "people/alice", fact: "explicit fact" });
    await putAndReconcile(
      "people/alice",
      fenceBody([{ rowNum: 1, claim: "fence fact v2", confidence: 1, active: true }]),
    );
    const facts = await factsFor("people/alice");
    expect(facts.some((f) => f.fact === "explicit fact" && f.source_markdown_slug === null)).toBe(true);
    expect(facts.some((f) => f.fact === "fence fact v2")).toBe(true);
  });

  it("a body with no fence keeps the page's fence facts and reports them", async () => {
    await putAndReconcile(
      "people/alice",
      fenceBody([{ rowNum: 1, claim: "fence fact", confidence: 1, active: true }]),
    );
    const r = await putAndReconcile("people/alice", "# Alice\n\nno fence now\n");
    expect(r).toEqual({ removed: 0, added: 0, fenceAbsent: true, retained: 1 });
    expect((await factsFor("people/alice")).map((f) => f.fact)).toEqual(["fence fact"]);
  });

  it("a malformed fence (markers present, 0 rows) does NOT wipe prior facts", async () => {
    await putAndReconcile(
      "people/alice",
      fenceBody([{ rowNum: 1, claim: "good fact", confidence: 1, active: true }]),
    );
    // markers present but the table body is garbage → parses to 0 rows
    const malformed = `# Alice\n\n## Facts\n<!--- memex:facts:begin -->\nnot a table at all\n<!--- memex:facts:end -->\n`;
    const r = await putAndReconcile("people/alice", malformed);
    expect(r).toEqual({ removed: 0, added: 0 });
    expect((await factsFor("people/alice")).map((f) => f.fact)).toEqual(["good fact"]);
  });

  it("a partially malformed fence (one good + one claimless row) does NOT wipe prior facts", async () => {
    await putAndReconcile(
      "people/alice",
      fenceBody([
        { rowNum: 1, claim: "good fact", confidence: 1, active: true },
        { rowNum: 2, claim: "second fact", confidence: 1, active: true },
      ]),
    );
    // row 2's claim cell is empty → the parser skips it; reconciling the row
    // that DID parse would wipe row 2's prior projection, so reconcile refuses
    const partial = [
      "# Alice",
      "",
      "## Facts",
      "<!--- memex:facts:begin -->",
      "| # | claim | confidence | source |",
      "|---|-------|------------|--------|",
      "| 1 | good fact | 1 | |",
      "| 2 |  | 1 | |",
      "<!--- memex:facts:end -->",
    ].join("\n");
    const r = await putAndReconcile("people/alice", partial);
    expect(r).toEqual({ removed: 0, added: 0, skipped: "malformed_rows" });
    expect((await factsFor("people/alice")).map((f) => f.fact)).toEqual([
      "good fact",
      "second fact",
    ]);
    const kept = (await storage.engine().query("SELECT id, written_at FROM entity_facts WHERE entity_slug='people/alice' AND row_num=1")).rows;
    // fixing the fence (all rows parse again) reconciles normally
    const fixed = await putAndReconcile(
      "people/alice",
      fenceBody([
        { rowNum: 1, claim: "good fact", confidence: 1, active: true },
        { rowNum: 2, claim: "repaired fact", confidence: 1, active: true },
      ]),
    );
    expect(fixed).toEqual({ removed: 1, added: 1, unchanged: 1 });
    expect((await storage.engine().query("SELECT id, written_at FROM entity_facts WHERE entity_slug='people/alice' AND row_num=1")).rows).toEqual(kept);
    expect((await factsFor("people/alice")).map((f) => f.fact)).toEqual([
      "good fact",
      "repaired fact",
    ]);
  });

  it("skips when the content hash no longer matches (concurrency guard)", async () => {
    const w = await putPage(storage, {
      slug: "people/alice",
      type: "person",
      markdown_body: fenceBody([{ rowNum: 1, claim: "v1", confidence: 1, active: true }]),
    });
    // a NEWER write lands before the (stale) reconcile for the first write runs
    await putPage(storage, {
      slug: "people/alice",
      type: "person",
      markdown_body: fenceBody([{ rowNum: 1, claim: "v2", confidence: 1, active: true }]),
    });
    // reconcile carrying the OLD hash must skip — not project v1 over v2
    const r = await reconcileFactsForPage(storage, "people/alice", w.content_hash);
    expect(r).toEqual({ removed: 0, added: 0 });
  });

  it("clamps an out-of-range row_num instead of failing the insert", async () => {
    const r = await putAndReconcile(
      "people/alice",
      fenceBody([{ rowNum: 9_999_999_999_999, claim: "huge row", confidence: 1, active: true }]),
    );
    expect(r.added).toBe(1);
    expect((await factsFor("people/alice"))[0]!.row_num).toBe(2_147_483_647);
  });
});

describe("reconcile honors forget vs supersede tombstones (mig062)", () => {
  async function tombstoneId(page: string, claim: string): Promise<number> {
    const r = await storage.engine().query<{ id: number }>(
      `SELECT id FROM entity_facts WHERE entity_slug = $1 AND fact = $2`,
      [page, claim],
    );
    return r.rows[0]!.id;
  }
  async function liveCount(page: string, claim: string): Promise<number> {
    const r = await storage.engine().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM entity_facts
        WHERE entity_slug = $1 AND fact = $2 AND forgotten_at IS NULL`,
      [page, claim],
    );
    return Number(r.rows[0]!.n);
  }

  it("a superseded fence claim RE-ENTERS on re-put (cause='supersede' excluded from skip-set)", async () => {
    const body = fenceBody([{ rowNum: 1, claim: "title is CFO", confidence: 1, active: true }]);
    await putAndReconcile("people/alice", body);
    const id = await tombstoneId("people/alice", "title is CFO");
    // A supersede (not an operator forget) tombstones the fence-owned claim.
    await forgetFact(storage, id, { cause: "supersede", reason: "superseded by newer" });
    expect(await liveCount("people/alice", "title is CFO")).toBe(0);
    // Re-put the identical page — the fence still declares the claim, so it must
    // re-enter (the operator never forgot it).
    const r = await putAndReconcile("people/alice", body);
    expect(await liveCount("people/alice", "title is CFO")).toBe(1);
    expect(r.added).toBe(1);
  });

  it("a genuinely forgotten fence claim STAYS suppressed on re-put (cause='forget')", async () => {
    const body = fenceBody([{ rowNum: 1, claim: "secret detail", confidence: 1, active: true }]);
    await putAndReconcile("people/bob", body);
    const id = await tombstoneId("people/bob", "secret detail");
    await forgetFact(storage, id); // default cause = 'forget'
    const r = await putAndReconcile("people/bob", body);
    expect(await liveCount("people/bob", "secret detail")).toBe(0);
    expect(r.added).toBe(0);
  });
});

describe("purgeFenceFactsForPage", () => {
  it("removes a page's fence facts but keeps explicit ones", async () => {
    await putPage(storage, { slug: "people/alice", type: "person" });
    await addFact(storage, { entity_slug: "people/alice", fact: "explicit fact" });
    await putAndReconcile(
      "people/alice",
      fenceBody([{ rowNum: 1, claim: "fence fact", confidence: 1, active: true }]),
    );
    await deletePage(storage, "people/alice");
    const r = await purgeFenceFactsForPage(storage, "people/alice");
    expect(r.removed).toBe(1);
    const facts = await factsFor("people/alice");
    expect(facts.map((f) => f.fact)).toEqual(["explicit fact"]);
  });
});
