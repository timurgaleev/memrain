/**
 * K12: a mailbox in the brain must not bury the pages people wrote. The bench
 * runs twice — with its mail noise (newsletters, automatic replies, receipts
 * and invitations that repeat the same names and terms) and without — and the
 * queries tagged `noise:mail` must rank the same pages as well either way.
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { k12Check, runBench, type BenchReport } from "../src/eval/bench/harness.ts";

setDefaultTimeout(180_000);

function fake(overrides: Partial<BenchReport>): BenchReport {
  const metrics = { n: 10, hit_at_5: 1, mrr: 0.9, ndcg_at_10: 0.9, recall_at_10: 1 };
  return {
    ok: true, qrels_sha256: "x", embed_model: "m", mail_noise: true, queries: 10,
    overall: metrics, by_tag: { "noise:mail": metrics }, abstention: { n: 0, returned_any: 0 },
    decoys: { total: 3, passed: [] }, errors: [], spend: { calls: 0, usd: 0 },
    ranked: { q1: ["/bench/vault/a.md"] }, per_query: {}, ...overrides,
  };
}

describe("k12Check", () => {
  it("fails when a mail page takes rank 1 or the tagged queries lose ground", () => {
    const clean = fake({ mail_noise: false });
    expect(k12Check(fake({}), clean).pass).toBe(true);
    const mailFirst = k12Check(fake({ ranked: { q1: ["/bench/mail/newsletter.md", "/bench/vault/a.md"] } }), clean);
    expect(mailFirst.pass).toBe(false);
    expect(mailFirst.mail_rank1).toEqual(["q1"]);
    const worse = fake({ by_tag: { "noise:mail": { n: 10, hit_at_5: 0.9, mrr: 0.85, ndcg_at_10: 0.8, recall_at_10: 0.9 } } });
    expect(k12Check(worse, clean).pass).toBe(false);
  });
});

describe("K12 on the bench", () => {
  it("mail noise moves no tagged query off its page", async () => {
    const withMail = await runBench();
    const withoutMail = await runBench({ includeMail: false });
    const check = k12Check(withMail, withoutMail);
    expect(check.mail_rank1).toEqual([]);
    expect(check.pass).toBe(true);
  });
});
