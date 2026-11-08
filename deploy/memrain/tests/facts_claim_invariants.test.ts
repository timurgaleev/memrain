/**
 * Three invariants of the `entity_facts` ledger, one per defect they close:
 *
 *   (a) A RESTATEMENT IS NOT A NEW CLAIM. With on-write extraction running,
 *       every re-save of an eligible page pushed the same claims through
 *       `addFact` again and the ledger grew a copy of each, per save, forever.
 *       The identity that decides "already on file" is the ledger's own —
 *       subject + tenant source + writer + text — the same tuple the
 *       consolidate phase promotes takes under, so the two cannot disagree.
 *
 *   (b) EVERY CLAIM AGES. Decay reads `kind`; a row that lands with the column
 *       blank is invisible to it and outlives every claim that named one.
 *
 *   (c) EVERY CLAIM NAMES A WRITER. add_fact enforced it for its own callers,
 *       which left the invariant false for the table — the CLI, the extractor
 *       and a caller naming only a source page all landed NULL.
 *
 * (b) and (c) are asserted over rows written through EVERY path that reaches
 * the ledger — direct, fence reconcile, consolidated take — because a guard
 * that only holds on the path the test happens to use is not an invariant.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import {
  addFact,
  findLiveClaim,
  listFacts,
  UNATTRIBUTED_WRITER,
} from "../src/core/facts.ts";
import { forgetFact } from "../src/core/facts-recall.ts";
import { writeExtractedFacts } from "../src/core/facts-extract.ts";
import { reconcileFactsForPage } from "../src/core/facts-reconcile.ts";
import { consolidateFactsPhase } from "../src/core/cycle/consolidate-facts.ts";
import {
  DEFAULT_FACT_KIND,
  HALFLIFE_DAYS,
  effectiveConfidence,
} from "../src/core/facts-decay.ts";
import {
  FACTS_FENCE_BEGIN,
  FACTS_FENCE_END,
} from "../src/core/facts-fence.ts";

let tmp: string;
let storage: Storage;

const E = "people/alice";

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-claim-inv-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

interface LedgerRow {
  id: number;
  fact: string;
  kind: string | null;
  written_by: string | null;
  confidence: number;
  valid_from: string | null;
  valid_until: string | null;
  written_at: string;
}

/** `entity_facts.source_id` is FK-checked, so a tenant must exist first. */
async function seedSource(id: string): Promise<void> {
  await storage
    .engine()
    .query(
      "INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING",
      [id, `/${id}`],
    );
}

async function ledger(): Promise<LedgerRow[]> {
  const r = await storage.engine().query<LedgerRow>(
    `SELECT id, fact, kind, written_by, confidence,
            valid_from::text  AS valid_from,
            valid_until::text AS valid_until,
            written_at::text  AS written_at
       FROM entity_facts WHERE forgotten_at IS NULL ORDER BY id`,
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// (a) a restatement refreshes the claim on file
// ---------------------------------------------------------------------------

describe("restating a claim", () => {
  it("re-runs the same extraction without growing the ledger", async () => {
    const extracted = [
      { fact: "runs the Gotham office", kind: "fact" as const, entity: E, confidence: 0.8, notability: "medium" as const },
      { fact: "prefers tea", kind: "preference" as const, entity: E, confidence: 0.6, notability: "low" as const },
    ];
    const opts = { sourceSlug: "notes/standup" };
    const first = await writeExtractedFacts(storage, extracted, opts);
    // The same page, saved again: identical claims, identical writer.
    const second = await writeExtractedFacts(storage, extracted, opts);
    expect(first.written).toBe(2);
    expect(second.written).toBe(0);
    expect(await listFacts(storage, E)).toHaveLength(2);
  });

  it("re-anchors written_at so a restated claim ages from the restatement", async () => {
    const first = await addFact(storage, { entity_slug: E, fact: "runs the office" });
    await storage
      .engine()
      .query(`UPDATE entity_facts SET written_at = '2020-01-01T00:00:00Z' WHERE id = $1`, [
        first.id,
      ]);
    await addFact(storage, { entity_slug: E, fact: "runs the office" });
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.written_at.startsWith("2020")).toBe(false);
  });

  it("takes a stated confidence and leaves an omitted one alone", async () => {
    await addFact(storage, { entity_slug: E, fact: "runs the office", confidence: 0.6 });
    // Omitted -> "no opinion", NOT a reset to addFact's 1.0 default.
    await addFact(storage, { entity_slug: E, fact: "runs the office" });
    expect((await ledger())[0]!.confidence).toBeCloseTo(0.6);
    await addFact(storage, { entity_slug: E, fact: "runs the office", confidence: 0.9 });
    expect((await ledger())[0]!.confidence).toBeCloseTo(0.9);
  });

  it("corrects the validity anchor in place", async () => {
    await addFact(storage, { entity_slug: E, fact: "joined Acme" });
    await addFact(storage, {
      entity_slug: E,
      fact: "joined Acme",
      valid_from: "2017-03-04",
    });
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valid_from).toBe("2017-03-04");
  });

  it("keeps a second writer's row: identity includes who said it", async () => {
    await addFact(storage, { entity_slug: E, fact: "runs the office", written_by: "operator" });
    const other = await addFact(storage, {
      entity_slug: E,
      fact: "runs the office",
      written_by: "facts-extract",
    });
    expect(other.inserted).toBe(true);
    expect(await ledger()).toHaveLength(2);
    expect((await listFacts(storage, E))[0]!.collapsed_count).toBe(2);
  });

  it("keeps a second tenant's row: identity includes the source", async () => {
    await seedSource("tenant-a");
    await seedSource("tenant-b");
    await addFact(storage, { entity_slug: E, fact: "runs the office", source_id: "tenant-a" });
    const other = await addFact(storage, {
      entity_slug: E,
      fact: "runs the office",
      source_id: "tenant-b",
    });
    expect(other.inserted).toBe(true);
    expect(await ledger()).toHaveLength(2);
    expect((await listFacts(storage, E))[0]!.collapsed_count).toBe(2);
  });

  it("still inserts a different claim about the same subject", async () => {
    await addFact(storage, { entity_slug: E, fact: "runs the office" });
    const other = await addFact(storage, { entity_slug: E, fact: "runs the Berlin office" });
    expect(other.inserted).toBe(true);
    expect(await ledger()).toHaveLength(2);
    expect(await listFacts(storage, E)).toHaveLength(2);
  });

  it("does not resurrect a claim the operator forgot", async () => {
    const first = await addFact(storage, { entity_slug: E, fact: "runs the office" });
    await forgetFact(storage, first.id!, { reason: "wrong" });
    const again = await addFact(storage, { entity_slug: E, fact: "runs the office" });
    // Neither the tombstone brought back to life nor a fresh copy: the forget
    // withdrew the claim (migration 112).
    expect(again.inserted).toBe(false);
    expect(again.withdrawn).toBe(true);
    expect(again.id).toBeNull();
    expect(await listFacts(storage, E)).toHaveLength(0);
  });

  it("agrees with the consolidate phase about what is already on file", async () => {
    await seedSource("tenant-a");
    const take = await addFact(storage, {
      entity_slug: E,
      fact: "prefers tea",
      written_by: "facts-consolidate",
      source_id: "tenant-a",
    });
    // The identity the consolidate phase looks a take up by — same call, so the
    // two paths cannot drift into separate notions of the same claim.
    const found = await findLiveClaim(storage.engine(), {
      entity_slug: E,
      source_id: "tenant-a",
      fact: "prefers tea",
      written_by: "facts-consolidate",
    });
    expect(found).toBe(take.id!);
  });
});

// ---------------------------------------------------------------------------
// (b) + (c) — asserted over every write path into the ledger
// ---------------------------------------------------------------------------

/** One row per write path: direct, extractor, fence reconcile, consolidated
 *  take. Returns the ledger once all four have landed. */
async function seedEveryWritePath(): Promise<LedgerRow[]> {
  // 1. Direct write, no metadata at all.
  await addFact(storage, { entity_slug: E, fact: "runs the Gotham office" });
  // 2. Extractor write (names its own writer, states a kind).
  await writeExtractedFacts(
    storage,
    [{ fact: "prefers tea", kind: "preference", entity: E, confidence: 0.6, notability: "low" }],
    { sourceSlug: "notes/standup" },
  );
  // 3. Fence reconcile from a legacy narrow fence — no kind column at all.
  const body = [
    FACTS_FENCE_BEGIN,
    "| # | claim | confidence | source |",
    "|---|-------|------------|--------|",
    "| 1 | signs off on the budget | 0.9 | notes/standup |",
    FACTS_FENCE_END,
  ].join("\n");
  const page = await putPage(storage, { slug: E, type: "person", markdown_body: body });
  await reconcileFactsForPage(storage, E, page.content_hash);
  // 4. Consolidated take: three same-vector facts promote one.
  const vec = JSON.stringify(new Array(1024).fill(0).map((_, i) => (i === 0 ? 1 : 0)));
  for (const [fact, conf] of [
    ["was in Metropolis on Tuesday", 0.7],
    ["was seen in Metropolis Tuesday", 0.9],
    ["spent Tuesday in Metropolis", 0.6],
  ] as const) {
    const r = await addFact(storage, { entity_slug: E, fact, confidence: conf, kind: "event" });
    await storage
      .engine()
      .query(`UPDATE entity_facts SET embedding = $1::vector WHERE id = $2`, [vec, r.id]);
  }
  const res = await consolidateFactsPhase(storage.engine(), { minOldestAgeMs: 0 });
  expect(res.takesWritten).toBe(1);
  return ledger();
}

describe("every claim ages", () => {
  it("lands a kind decay can see, whatever path wrote it", async () => {
    const rows = await seedEveryWritePath();
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const row of rows) {
      expect(row.kind).not.toBeNull();
      expect(HALFLIFE_DAYS).toHaveProperty(row.kind!);
    }
  });

  it("leaves no immortal row: confidence decays on every one of them", async () => {
    const rows = await seedEveryWritePath();
    const decade = new Date(Date.now() + 3650 * 86_400_000);
    for (const row of rows) {
      const eff = effectiveConfidence(
        {
          confidence: row.confidence,
          kind: row.kind,
          valid_from: row.valid_from,
          valid_until: row.valid_until,
          written_at: row.written_at,
        },
        decade,
      );
      expect(eff).toBeLessThan(row.confidence);
    }
  });

  it("floors an unstated kind rather than promoting the claim", async () => {
    await addFact(storage, { entity_slug: E, fact: "runs the office" });
    expect((await ledger())[0]!.kind).toBe(DEFAULT_FACT_KIND);
  });

  it("gives the consolidated take the kind of the claim it quotes", async () => {
    const rows = await seedEveryWritePath();
    const take = rows.find((r) => r.written_by === "facts-consolidate");
    // The take restates the highest-confidence member verbatim, so it is that
    // member's kind of claim and ages on that member's half-life.
    expect(take?.fact).toBe("was seen in Metropolis Tuesday");
    expect(take?.kind).toBe("event");
  });
});

describe("every claim names a writer", () => {
  it("holds for every path into the ledger, not just add_fact", async () => {
    const rows = await seedEveryWritePath();
    for (const row of rows) expect(row.written_by).not.toBeNull();
  });

  it("credits the sentinel when the caller names nobody", async () => {
    await addFact(storage, { entity_slug: E, fact: "runs the office" });
    expect((await ledger())[0]!.written_by).toBe(UNATTRIBUTED_WRITER);
  });

  it("treats a blank writer as no writer at all", async () => {
    await addFact(storage, { entity_slug: E, fact: "runs the office", written_by: "   " });
    expect((await ledger())[0]!.written_by).toBe(UNATTRIBUTED_WRITER);
  });

  it("leaves a named writer alone", async () => {
    await addFact(storage, { entity_slug: E, fact: "runs the office", written_by: "capture-cli" });
    expect((await ledger())[0]!.written_by).toBe("capture-cli");
  });
});
