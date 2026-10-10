/**
 * `memrain eval --config-a/--config-b`: per-side env flags, interleaving,
 * paired statistics, fail-closed errors and the recorded A/B row. Hermetic:
 * the searchFn seam returns canned rankings over a two-page PGLite brain.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runEval,
  runConfigHash,
  parseEvalConfig,
  type EvalOptions,
} from "../src/commands/eval.ts";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { deterministicEmbed } from "./det-embed.ts";

const FLAG = "MEMRAIN_RANK_METADATA_GATE";
const tmp = mkdtempSync(join(tmpdir(), "memrain-eval-ab-"));
const cfgDir = join(tmp, ".memrain");
const cfgPath = join(cfgDir, "config.json");
const dbPath = join(cfgDir, "brain.pglite");
const qrelsPath = join(tmp, "qrels.json");

type SearchFn = NonNullable<EvalOptions["searchFn"]>;

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  console.error = () => {};
  return {
    lines,
    restore: () => {
      console.log = orig;
      console.error = origErr;
    },
  };
}

async function run(opts: EvalOptions): Promise<{ code: number; out: Record<string, unknown> }> {
  const cap = capture();
  try {
    await runEval({ qrelsPath, configPath: cfgPath, ...opts });
  } finally {
    cap.restore();
  }
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { code, out: cap.lines.length ? JSON.parse(cap.lines.join("\n")) : {} };
}

beforeAll(async () => {
  mkdirSync(cfgDir, { recursive: true });
  const seed = new Storage({ dbPath });
  await seed.init();
  try {
    for (const path of ["notes/a.md", "notes/b.md"]) {
      await writeDocumentTransaction(
        seed,
        { documentId: path, sourcePath: path, title: path, frontmatter: {}, embeddingModel: "deterministic-test" },
        [{ text: path, entities: [], embedding: deterministicEmbed(path) }],
      );
    }
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
        { id: "q1", query: "alpha", expected_paths: ["notes/a.md"] },
        { id: "q2", query: "beta", expected_paths: ["notes/b.md"] },
        { id: "q3", query: "beta again", expected_paths: ["notes/b.md"], cluster: "beta" },
        { id: "q4", query: "beta once more", expected_paths: ["notes/b.md"], cluster: "beta" },
      ],
    }),
  );
});

afterEach(() => {
  delete process.env[FLAG];
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Finds notes/b.md only while the flag is on in the process env. */
const flagSensitive: SearchFn = async (_s, query) => {
  if (query === "alpha") return ["notes/a.md"];
  return process.env[FLAG] === "1" ? ["notes/b.md"] : ["notes/x.md"];
};

describe("A/B env flags", () => {
  it("sets a config's env for its own queries only, and restores it", async () => {
    const seen: string[] = [];
    const spy: SearchFn = async (s, query, cfg, k) => {
      seen.push(`${cfg.name}:${process.env[FLAG] ?? "unset"}`);
      return flagSensitive(s, query, cfg, k);
    };
    const { code, out } = await run({
      config: { name: "off" },
      configB: { name: "on", env: { [FLAG]: "1" } },
      searchFn: spy,
    });
    expect(code).toBe(0);
    // Interleaved: A first on even queries, B first on odd ones.
    expect(seen).toEqual([
      "off:unset", "on:1",
      "on:1", "off:unset",
      "off:unset", "on:1",
      "on:1", "off:unset",
    ]);
    expect(process.env[FLAG]).toBeUndefined();
    const a = out.a as { meanRecall: number };
    const b = out.b as { meanRecall: number };
    expect(a.meanRecall).toBe(0.25);
    expect(b.meanRecall).toBe(1);
  });

  it("reports paired statistics per metric, Holm-adjusted, with clusters", async () => {
    const { out } = await run({
      config: { name: "off" },
      configB: { name: "on", env: { [FLAG]: "1" } },
      searchFn: flagSensitive,
    });
    const paired = out.paired as {
      aggregate_only: boolean;
      metrics: Record<string, { delta: number; p_value: number; p_holm: number; clusters: number; wins: number; ties: number }>;
    };
    expect(paired.aggregate_only).toBe(false);
    expect(Object.keys(paired.metrics).sort()).toEqual(["hit@5", "mrr", "ndcg@5"]);
    const hit = paired.metrics["hit@5"]!;
    expect(hit.delta).toBe(0.75);
    expect([hit.wins, hit.ties]).toEqual([3, 1]);
    // q1, q2 and the "beta" cluster: three sign-flip units.
    expect(hit.clusters).toBe(3);
    expect(hit.p_holm).toBeGreaterThanOrEqual(hit.p_value);
    const latency = out.latency as { a: { p50Ms: number }; ratio_p50: number | null };
    expect(typeof latency.a.p50Ms).toBe("number");
    expect((out.receipt as { ids_sha256: string }).ids_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("exits 1 and falls back to aggregates when a query throws on one side", async () => {
    const throwsOnB: SearchFn = async (s, query, cfg, k) => {
      if (cfg.name === "on" && query === "beta") throw new Error("bedrock timeout");
      return flagSensitive(s, query, cfg, k);
    };
    const { code, out } = await run({
      config: { name: "off" },
      configB: { name: "on", env: { [FLAG]: "1" } },
      searchFn: throwsOnB,
    });
    expect(code).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.errors).toEqual({ a: 0, b: 1 });
    expect(out.paired).toEqual({ aggregate_only: true, paired: 3, unpaired: ["q2"] });
  });

  it("records a kind 'ab' row with the receipt and the statistics", async () => {
    const { code, out } = await run({
      config: { name: "off" },
      configB: { name: "on", env: { [FLAG]: "1" } },
      searchFn: flagSensitive,
      record: true,
    });
    expect(code).toBe(0);
    const id = out.snapshot_id as number;
    const storage = new Storage({ dbPath });
    await storage.init();
    try {
      const r = await storage.engine().query<{ kind: string; detail: Record<string, unknown> }>(
        `SELECT kind, detail FROM eval_snapshots WHERE id = $1`,
        [id],
      );
      expect(r.rows[0]!.kind).toBe("ab");
      const detail = r.rows[0]!.detail;
      expect(detail.split).toBe("all");
      expect((detail.paired as { aggregate_only: boolean }).aggregate_only).toBe(false);
      expect(detail.run_config_hash_a).not.toBe(detail.run_config_hash_b);
    } finally {
      await storage.close();
    }
  });
});

describe("run fingerprint with env", () => {
  it("moves with a ranking flag, and an env override equals the same process env", () => {
    const off = runConfigHash({}, 5, "q");
    const on = runConfigHash({ env: { [FLAG]: "1" } }, 5, "q");
    expect(on).not.toBe(off);
    expect(process.env[FLAG]).toBeUndefined();
    process.env[FLAG] = "1";
    expect(runConfigHash({}, 5, "q")).toBe(on);
  });

  it("covers an override outside the known ranking knobs", () => {
    expect(runConfigHash({ env: { MEMRAIN_SOMETHING_NEW: "1" } }, 5, "q")).not.toBe(
      runConfigHash({}, 5, "q"),
    );
  });
});

describe("parseEvalConfig env", () => {
  it("accepts MEMRAIN_* string values and refuses anything else", () => {
    expect(parseEvalConfig(`{"env":{"${FLAG}":"1"}}`).env).toEqual({ [FLAG]: "1" });
    expect(() => parseEvalConfig(`{"env":{"AWS_PROFILE":"x"}}`)).toThrow(/MEMRAIN_/);
    expect(() => parseEvalConfig(`{"env":{"${FLAG}":1}}`)).toThrow(/string value/);
    expect(() => parseEvalConfig(`{"env":["x"]}`)).toThrow(/object/);
  });
});
