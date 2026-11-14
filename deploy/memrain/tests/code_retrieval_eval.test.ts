/**
 * The fixed code-retrieval eval: its questions name real symbols in this
 * repository, and scoring goes through the real hybridSearch over code indexed
 * by the real code indexer. Offline (PGLite, deterministic query embedder).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexCodeFile } from "../src/core/indexer-code.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";
import {
  CODE_RETRIEVAL_QUESTIONS,
  runCodeRetrievalEval,
  type CodeRetrievalQuestion,
} from "../src/eval/code-retrieval.ts";
import { runEvalCode } from "../src/commands/eval-code.ts";
import { deterministicEmbedQuery } from "./det-embed.ts";

setDefaultTimeout(60000);

const PKG = join(import.meta.dir, "..");
const INDEXED = [
  "src/core/synthesis/takes-fence.ts",
  "src/core/facts-fence.ts",
  "src/core/embed-skip.ts",
  "src/core/llm/resolve-model.ts",
  "src/core/rrf.ts",
];

describe("the question set", () => {
  it("holds 15 to 20 questions with unique ids", () => {
    expect(CODE_RETRIEVAL_QUESTIONS.length).toBeGreaterThanOrEqual(15);
    expect(CODE_RETRIEVAL_QUESTIONS.length).toBeLessThanOrEqual(20);
    expect(new Set(CODE_RETRIEVAL_QUESTIONS.map((q) => q.id)).size).toBe(CODE_RETRIEVAL_QUESTIONS.length);
  });

  it("names symbols that this repository actually exports", () => {
    for (const q of CODE_RETRIEVAL_QUESTIONS) {
      const src = readFileSync(join(PKG, q.path), "utf8");
      expect(`${q.id}: ${new RegExp(`export (async )?function ${q.symbol}\\b`).test(src)}`).toBe(`${q.id}: true`);
    }
  });
});

describe("runCodeRetrievalEval", () => {
  const dir = mkdtempSync(join(tmpdir(), "memrain-code-eval-"));
  let storage: Storage;

  beforeAll(async () => {
    storage = new Storage({ dbPath: join(dir, "db") });
    await storage.init();
    for (const f of INDEXED) await indexCodeFile(storage, join(PKG, f));
  });
  afterAll(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
    _resetParsersForTests();
  });

  const onIndexed = () => CODE_RETRIEVAL_QUESTIONS.filter((q) => INDEXED.includes(q.path));

  it("finds the expected symbol within the top five", async () => {
    const r = await runCodeRetrievalEval(storage, { questions: onIndexed(), embedQuery: deterministicEmbedQuery });
    expect(r.state).toBe("scored");
    const facts = r.questions.find((q) => q.symbol === "stripFactsFence")!;
    expect(facts.indexed).toBe(true);
    expect(facts.hit).toBe(true);
    expect(facts.rank).toBeLessThanOrEqual(5);
    expect(r.hit_at_k).toBeGreaterThan(0);
    expect(r.top1_stable).toBe(r.scored);
  });

  it("scores a deliberately wrong expectation as a miss", async () => {
    const wrong: CodeRetrievalQuestion = {
      id: "wrong", query: onIndexed().find((q) => q.symbol === "stripFactsFence")!.query,
      path: "src/core/does-not-exist.ts", symbol: "noSuchSymbol",
    };
    const r = await runCodeRetrievalEval(storage, { questions: [wrong], embedQuery: deterministicEmbedQuery });
    expect(r.questions[0]!.hit).toBe(false);
    expect(r.questions[0]!.indexed).toBe(false);
    expect(r.scored).toBe(0);
  });

  it("refuses to score a brain whose code index is not ready", async () => {
    const empty = new Storage({ dbPath: join(dir, "empty") });
    await empty.init();
    try {
      let searched = 0;
      const r = await runCodeRetrievalEval(empty, {
        questions: onIndexed(),
        embedQuery: async (t) => { searched++; return deterministicEmbedQuery(t); },
      });
      expect(r.state).toBe("unknown");
      expect(r.readiness).not.toBe("ready");
      expect(r.hit_at_k).toBeNull();
      expect(searched).toBe(0);
    } finally {
      await empty.close();
    }
  });

  it("memrain eval code prints the report and exits 1 when nothing can be scored", async () => {
    const out: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
    try {
      expect(await runEvalCode({ storage, json: true, questions: onIndexed(), embedQuery: deterministicEmbedQuery })).toBe(0);
      expect(JSON.parse(out.join("\n")).state).toBe("scored");
      const empty = new Storage({ dbPath: join(dir, "empty-cli") });
      await empty.init();
      try {
        expect(await runEvalCode({ storage: empty, json: true })).toBe(1);
      } finally {
        await empty.close();
      }
    } finally {
      console.log = orig;
    }
  });
});
