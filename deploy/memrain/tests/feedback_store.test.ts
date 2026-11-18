/**
 * Search-result feedback: how ratings become a page's soft weight, on both
 * engines. A brain without ratings reads every page as neutral; one rater can
 * move a page only as far as its tier allows, however often it votes.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerSource } from "../src/core/sources.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  FEEDBACK_INFLUENCE,
  NEUTRAL_WEIGHT,
  aggregateWeight,
  feedbackMultiplier,
} from "../src/core/feedback/weights.ts";
import { FEEDBACK_MAX_PER_HOUR, feedbackEnabled } from "../src/core/feedback/settings.ts";
import { principalHash, readWeights, recordRating } from "../src/core/feedback/store.ts";

setDefaultTimeout(60_000);

const saved = process.env["MEMRAIN_FEEDBACK"];
afterEach(() => {
  if (saved === undefined) delete process.env["MEMRAIN_FEEDBACK"];
  else process.env["MEMRAIN_FEEDBACK"] = saved;
});

async function page(e: Engine, slug: string, source = "default", hash = "h1"): Promise<void> {
  await e.query(
    `INSERT INTO pages (slug, type, title, content_hash, source_id) VALUES ($1, 'note', $1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET content_hash = EXCLUDED.content_hash`,
    [slug, hash, source],
  );
}

const vote = (rating: -1 | 0 | 1, tier: "owner" | "member" | "agent" = "owner", extra: Partial<Parameters<typeof aggregateWeight>[0][number]> = {}) =>
  ({ rating, tier, signal: "explicit" as const, ageDays: 0, stale: false, ...extra });

describe("feedback weights", () => {
  it("is off unless MEMRAIN_FEEDBACK is on", () => {
    delete process.env["MEMRAIN_FEEDBACK"];
    expect(feedbackEnabled()).toBe(false);
    process.env["MEMRAIN_FEEDBACK"] = "0";
    expect(feedbackEnabled()).toBe(false);
    process.env["MEMRAIN_FEEDBACK"] = "1";
    expect(feedbackEnabled()).toBe(true);
  });

  it("no votes is neutral and neutral changes nothing", () => {
    expect(aggregateWeight([])).toBe(NEUTRAL_WEIGHT);
    expect(feedbackMultiplier(NEUTRAL_WEIGHT)).toBe(1);
    expect(FEEDBACK_INFLUENCE).toBeLessThanOrEqual(0.15);
  });

  it("bounds the multiplier to 1 ± λ whatever the votes", () => {
    const many = Array.from({ length: 500 }, () => vote(1));
    const m = feedbackMultiplier(aggregateWeight(many));
    expect(m).toBeGreaterThan(1);
    expect(m).toBeLessThanOrEqual(1 + FEEDBACK_INFLUENCE);
    expect(feedbackMultiplier(aggregateWeight(many.map(v => ({ ...v, rating: -1 as const }))))).toBeGreaterThanOrEqual(1 - FEEDBACK_INFLUENCE);
  });

  it("weighs a vote by the voter's tier, its signal, its age and whether the page changed since", () => {
    const owner = aggregateWeight([vote(1, "owner")]);
    const member = aggregateWeight([vote(1, "member")]);
    const agent = aggregateWeight([vote(1, "agent")]);
    expect(owner).toBeGreaterThan(member);
    expect(member).toBeGreaterThan(agent);
    expect(agent).toBeGreaterThan(NEUTRAL_WEIGHT);
    expect(aggregateWeight([vote(1, "owner", { signal: "implicit" })])).toBeLessThan(owner);
    expect(aggregateWeight([vote(1, "owner", { ageDays: 90 })])).toBeLessThan(owner);
    expect(aggregateWeight([vote(1, "owner", { stale: true })])).toBeLessThan(owner);
  });
});

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`feedback store (${name})`, () => {
  it("stores only a hash of the principal and moves the page's weight", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await page(e, "notes/a");
      const r = await recordRating(e, { sourceId: "default", slug: "notes/a", principal: "operator", tier: "owner", rating: 1, signal: "explicit", queryId: "7" });
      expect(r).toMatchObject({ ok: true });
      const rows = await e.query<{ principal_hash: string; query_id: string }>(`SELECT principal_hash, query_id FROM retrieval_feedback`);
      expect(rows.rows).toEqual([{ principal_hash: principalHash("operator"), query_id: "7" }]);
      expect(rows.rows[0]!.principal_hash).not.toContain("operator");
      const w = await readWeights(e, ["notes/a", "notes/none"]);
      expect(w.get("notes/a")!).toBeGreaterThan(NEUTRAL_WEIGHT);
      expect(w.has("notes/none")).toBe(false);
    } finally { await db.close(); }
  });

  it("50 negative ratings from one agent token move the multiplier by at most λ·0.25", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await page(e, "notes/a");
      for (let i = 0; i < 50; i++) {
        await recordRating(e, { sourceId: "default", slug: "notes/a", principal: "client:bot", tier: "agent", rating: -1, signal: "explicit", queryId: String(i) });
      }
      const m = feedbackMultiplier((await readWeights(e, ["notes/a"])).get("notes/a")!);
      expect(m).toBeLessThan(1);
      expect(1 - m).toBeLessThanOrEqual(FEEDBACK_INFLUENCE * 0.25 + 1e-6);
    } finally { await db.close(); }
  });

  it("refuses a principal's ratings past the hourly limit", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await page(e, "notes/a");
      for (let i = 0; i < FEEDBACK_MAX_PER_HOUR; i++) {
        expect((await recordRating(e, { sourceId: "default", slug: "notes/a", principal: "member:ann", tier: "member", rating: 1, signal: "explicit" })).ok).toBe(true);
      }
      expect(await recordRating(e, { sourceId: "default", slug: "notes/a", principal: "member:ann", tier: "member", rating: 1, signal: "explicit" }))
        .toEqual({ ok: false, error: "rate_limited" });
      expect((await recordRating(e, { sourceId: "default", slug: "notes/a", principal: "member:bob", tier: "member", rating: 1, signal: "explicit" })).ok).toBe(true);
    } finally { await db.close(); }
  });

  it("refuses a page that is not in the named source, or is gone", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "team", kind: "github", pathPrefix: "/team" });
      await page(e, "team/x", "team");
      expect(await recordRating(e, { sourceId: "default", slug: "team/x", principal: "operator", tier: "owner", rating: 1, signal: "explicit" }))
        .toEqual({ ok: false, error: "not_found" });
      await e.query(`UPDATE pages SET deleted_at = NOW() WHERE slug = 'team/x'`);
      expect(await recordRating(e, { sourceId: "team", slug: "team/x", principal: "operator", tier: "owner", rating: 1, signal: "explicit" }))
        .toEqual({ ok: false, error: "not_found" });
      expect((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM retrieval_feedback`)).rows[0]!.n).toBe(0);
    } finally { await db.close(); }
  });

  it("an edited page reads its weight halfway back to neutral", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await page(e, "notes/a");
      await recordRating(e, { sourceId: "default", slug: "notes/a", principal: "operator", tier: "owner", rating: 1, signal: "explicit" });
      const before = (await readWeights(e, ["notes/a"])).get("notes/a")!;
      await page(e, "notes/a", "default", "h2");
      const after = (await readWeights(e, ["notes/a"])).get("notes/a")!;
      expect(after - NEUTRAL_WEIGHT).toBeCloseTo((before - NEUTRAL_WEIGHT) / 2, 5);
      // A new vote counts the old one at the edited strength, not back at full.
      await recordRating(e, { sourceId: "default", slug: "notes/a", principal: "member:ann", tier: "member", rating: 1, signal: "explicit" });
      const fresh = aggregateWeight([vote(1, "owner", { stale: true }), vote(1, "member")]);
      expect((await readWeights(e, ["notes/a"])).get("notes/a")!).toBeCloseTo(fresh, 5);
    } finally { await db.close(); }
  });

  it("a principal's later vote replaces its earlier one", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await page(e, "notes/a");
      await recordRating(e, { sourceId: "default", slug: "notes/a", principal: "operator", tier: "owner", rating: 1, signal: "explicit" });
      await recordRating(e, { sourceId: "default", slug: "notes/a", principal: "operator", tier: "owner", rating: 0, signal: "explicit" });
      expect((await readWeights(e, ["notes/a"])).get("notes/a")!).toBeCloseTo(NEUTRAL_WEIGHT, 6);
    } finally { await db.close(); }
  });

  it("drops raw ratings older than 180 days and keeps the weight", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await page(e, "notes/a");
      await page(e, "notes/b");
      await recordRating(e, { sourceId: "default", slug: "notes/a", principal: "operator", tier: "owner", rating: 1, signal: "explicit" });
      await e.query(`UPDATE retrieval_feedback SET created_at = NOW() - interval '181 days'`);
      const kept = (await readWeights(e, ["notes/a"])).get("notes/a")!;
      await recordRating(e, { sourceId: "default", slug: "notes/b", principal: "operator", tier: "owner", rating: 1, signal: "explicit" });
      const rows = await e.query<{ slug: string }>(`SELECT slug FROM retrieval_feedback`);
      expect(rows.rows.map(r => r.slug)).toEqual(["notes/b"]);
      expect((await readWeights(e, ["notes/a"])).get("notes/a")!).toBeCloseTo(kept, 6);
    } finally { await db.close(); }
  });
});
