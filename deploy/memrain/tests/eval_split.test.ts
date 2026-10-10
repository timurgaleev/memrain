/**
 * Dev/sealed qrels: the split filter, the sealed-run rules (A/B only, under a
 * pre-registration, recorded, once), and `memrain eval qrels build`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abRunRefusal,
  filterSplit,
  loadQrels,
  runEval,
  type EvalOptions,
} from "../src/commands/eval.ts";
import { runEvalGate } from "../src/commands/eval-compare.ts";
import { buildQrels, isSealed, runEvalQrelsBuild } from "../src/commands/eval-qrels.ts";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { recordQuery } from "../src/core/eval-replay.ts";
import { deterministicEmbed } from "./det-embed.ts";

const tmp = mkdtempSync(join(tmpdir(), "memrain-eval-split-"));
const cfgDir = join(tmp, ".memrain");
const cfgPath = join(cfgDir, "config.json");
const dbPath = join(cfgDir, "brain.pglite");
const qrelsPath = join(tmp, "qrels.json");
const preregPath = join(tmp, "prereg.md");

function quiet(): { lines: string[]; errors: string[]; restore: () => void } {
  const lines: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
  return {
    lines,
    errors,
    restore: () => {
      console.log = log;
      console.error = err;
    },
  };
}

beforeAll(async () => {
  mkdirSync(cfgDir, { recursive: true });
  const seed = new Storage({ dbPath });
  await seed.init();
  try {
    for (const path of ["notes/a.md", "notes/b.md", "notes/gone.md"]) {
      await writeDocumentTransaction(
        seed,
        { documentId: path, sourcePath: path, title: path, frontmatter: {}, embeddingModel: "deterministic-test" },
        [{ text: path, entities: [], embedding: deterministicEmbed(path) }],
      );
    }
    await seed.engine().query(`UPDATE documents SET deleted_at = now() WHERE id = 'notes/gone.md'`);
    const e = seed.engine();
    await recordQuery(e, { id: "c1", query: "alpha", tag: "good", expectedDocId: "notes/a.md" });
    await recordQuery(e, { id: "c2", query: "beta", tag: "bad", expectedDocId: "notes/b.md" });
    await recordQuery(e, { id: "c3", query: "no answer", tag: "good" });
    await recordQuery(e, { id: "c4", query: "deleted", tag: "good", expectedDocId: "notes/gone.md" });
  } finally {
    await seed.close();
  }
  writeFileSync(
    cfgPath,
    JSON.stringify({
      database: { type: "pglite", path: dbPath },
      embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
      storage: {},
    }),
  );
  writeFileSync(
    qrelsPath,
    JSON.stringify({
      queries: [
        { id: "d1", query: "alpha", expected_paths: ["notes/a.md"] },
        { id: "d2", query: "beta", expected_paths: ["notes/b.md"], split: "dev" },
        { id: "s1", query: "beta sealed", expected_paths: ["notes/b.md"], split: "sealed" },
      ],
    }),
  );
  writeFileSync(preregPath, "hypothesis: B lifts nDCG@5\n");
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const canned: NonNullable<EvalOptions["searchFn"]> = async (_s, query) =>
  query.startsWith("alpha") ? ["notes/a.md"] : ["notes/b.md"];

describe("filterSplit", () => {
  it("treats unlabelled queries as dev and leaves sealed ones out of dev", () => {
    const q = loadQrels(qrelsPath);
    expect(filterSplit(q, "dev").queries.map((x) => x.id)).toEqual(["d1", "d2"]);
    expect(filterSplit(q, "sealed").queries.map((x) => x.id)).toEqual(["s1"]);
    expect(filterSplit(q, "all").queries).toHaveLength(3);
    expect(filterSplit(q, "dev").sha256).toBe(q.sha256);
  });

  it("refuses an unknown split label and an empty split", () => {
    const bad = join(tmp, "bad.json");
    writeFileSync(bad, JSON.stringify({ queries: [{ id: "x", query: "x", expected_paths: [], split: "test" }] }));
    expect(() => loadQrels(bad)).toThrow(/split 'test'/);
    const devOnly = join(tmp, "dev-only.json");
    writeFileSync(devOnly, JSON.stringify({ queries: [{ id: "x", query: "x", expected_paths: [] }] }));
    expect(() => filterSplit(loadQrels(devOnly), "sealed")).toThrow(/no sealed queries/);
  });
});

describe("sealed runs", () => {
  it("run only as a recorded A/B under a prereg", () => {
    expect(abRunRefusal({ ab: false, split: "sealed" })).toMatch(/only as an A\/B/);
    expect(abRunRefusal({ ab: true, split: "sealed" })).toMatch(/--prereg/);
    expect(abRunRefusal({ ab: true, split: "sealed", preregPath: "p" })).toMatch(/--record/);
    expect(abRunRefusal({ ab: true, split: "sealed", preregPath: "p", record: true })).toBeNull();
    expect(abRunRefusal({ ab: false, split: "dev", record: true })).toMatch(/--record/);
    expect(abRunRefusal({ ab: true, split: "dev" })).toBeNull();
  });

  it("score the sealed queries once per prereg and refuse the second run", async () => {
    let calls = 0;
    const counting: NonNullable<EvalOptions["searchFn"]> = async (s, q, c, k) => {
      calls++;
      return canned(s, q, c, k);
    };
    const opts: EvalOptions = {
      qrelsPath,
      configPath: cfgPath,
      config: { name: "off" },
      configB: { name: "on", env: { MEMRAIN_RANK_EXACT_LOOKUP: "1" } },
      split: "sealed",
      preregPath,
      record: true,
      searchFn: counting,
    };
    const first = quiet();
    try {
      await runEval(opts);
    } finally {
      first.restore();
    }
    expect(Number(process.exitCode ?? 0)).toBe(0);
    const out = JSON.parse(first.lines.join("\n"));
    expect(out.receipt.split).toBe("sealed");
    expect(out.receipt.prereg_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.receipt.sealed_ids_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(out.a.perQuery.map((q: { id: string }) => q.id)).toEqual(["s1"]);
    expect(calls).toBe(2);

    const second = quiet();
    try {
      await runEval(opts);
    } finally {
      second.restore();
    }
    expect(Number(process.exitCode)).toBe(1);
    process.exitCode = 0;
    expect(second.errors.join(" ")).toMatch(/already scored under this prereg/);
    // Refused before any query ran.
    expect(calls).toBe(2);

    // Another pre-registration is another experiment.
    const prereg2 = join(tmp, "prereg-2.md");
    writeFileSync(prereg2, "hypothesis: B lifts MRR\n");
    const third = quiet();
    try {
      await runEval({ ...opts, preregPath: prereg2 });
    } finally {
      third.restore();
    }
    expect(Number(process.exitCode ?? 0)).toBe(0);
  });

  it("are not gated", async () => {
    const cap = quiet();
    let code: number;
    try {
      code = await runEvalGate({
        qrelsPath,
        configPath: cfgPath,
        split: "sealed" as "dev",
        searchFn: canned,
      });
    } finally {
      cap.restore();
    }
    expect(code).toBe(1);
  });
});

describe("eval qrels build", () => {
  it("splits by a seeded hash of the id, stable as the set grows", () => {
    const ids = Array.from({ length: 400 }, (_, i) => `q${i}`);
    const sealed = ids.filter((id) => isSealed(id, 42, 0.3));
    expect(sealed.length).toBeGreaterThan(80);
    expect(sealed.length).toBeLessThan(160);
    expect(ids.filter((id) => isSealed(id, 42, 0.3))).toEqual(sealed);
    expect(ids.filter((id) => isSealed(id, 7, 0.3))).not.toEqual(sealed);
    const rows = ids.map((id) => ({ id, query: id, source_path: `p/${id}.md` }));
    const small = buildQrels(rows.slice(0, 50), { sealedFraction: 0.3, seed: 42 });
    const big = buildQrels(rows, { sealedFraction: 0.3, seed: 42 });
    const splitOf = new Map(big.queries.map((q) => [q.id, q.split]));
    for (const q of small.queries) expect(splitOf.get(q.id)).toBe(q.split!);
  });

  it("writes live captured queries to a 0600 .local.json and refuses other names", async () => {
    const out = join(tmp, "out", "qrels.live.local.json");
    const cap = quiet();
    let code: number;
    try {
      code = await runEvalQrelsBuild({
        out,
        configPath: cfgPath,
        sealedFraction: 0.5,
        seed: 42,
        expectedTop1: ["c2"],
      });
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const qrels = JSON.parse(readFileSync(out, "utf-8"));
    // c3 names no document, c4's document is deleted.
    expect(qrels.queries.map((q: { id: string }) => q.id)).toEqual(["c1", "c2"]);
    expect(qrels.queries[1]).toMatchObject({
      query: "beta",
      expected_paths: ["notes/b.md"],
      expected_top1: true,
    });
    expect(qrels.queries[0].expected_top1).toBeUndefined();
    for (const q of qrels.queries) expect(["dev", "sealed"]).toContain(q.split);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(loadQrels(out).queries).toHaveLength(2);

    const cap2 = quiet();
    try {
      expect(await runEvalQrelsBuild({ out: join(tmp, "qrels.json"), configPath: cfgPath })).toBe(1);
      expect(
        await runEvalQrelsBuild({ out, configPath: cfgPath, expectedTop1: ["c3"] }),
      ).toBe(1);
    } finally {
      cap2.restore();
    }
  });
});
