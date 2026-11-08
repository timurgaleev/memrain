/**
 * `memrain search diagnose` — arm-by-arm retrieval probe. Hermetic: seeded
 * corpus + deterministic embedder; asserts the per-layer ranks and the
 * verdict line for a hit and for a miss.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSearchDiagnose, pathMatchesTarget } from "../src/commands/search-diagnose.ts";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";

const tmp = mkdtempSync(join(tmpdir(), "memrain-diagnose-test-"));
const cfgDir = join(tmp, ".memex");
const cfgPath = join(cfgDir, "config.json");

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  return { lines, restore: () => (console.log = orig) };
}

beforeAll(async () => {
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    cfgPath,
    JSON.stringify({
      database: { type: "pglite", path: join(cfgDir, "brain.pglite") },
      embedding: {
        provider: "bedrock-titan",
        model: "amazon.titan-embed-text-v2:0",
        region: "eu-west-1",
      },
      storage: {},
    }),
  );
  const storage = new Storage({ dbPath: join(cfgDir, "brain.pglite") });
  await storage.init();
  try {
    await writeDocumentTransaction(
      storage,
      {
        documentId: "doc_target",
        sourcePath: "notes/amphitheater.md",
        title: "Greek amphitheater",
        frontmatter: {},
        embeddingModel: "det",
      },
      [
        {
          text: "the greek amphitheater acoustics were studied in detail",
          entities: [],
          embedding: deterministicEmbed(
            "the greek amphitheater acoustics were studied in detail",
          ),
        },
      ],
    );
    await writeDocumentTransaction(
      storage,
      {
        documentId: "doc_other",
        sourcePath: "notes/opera.md",
        title: "Opera houses",
        frontmatter: {},
        embeddingModel: "det",
      },
      [
        {
          text: "opera houses have different acoustics entirely",
          entities: [],
          embedding: deterministicEmbed("opera houses have different acoustics entirely"),
        },
      ],
    );
  } finally {
    await storage.close();
  }
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("pathMatchesTarget", () => {
  it("matches raw paths, page mirrors, and .md twins", () => {
    expect(pathMatchesTarget("notes/a.md", null, "notes/a")).toBe(true);
    expect(pathMatchesTarget("page://people/x", null, "people/x")).toBe(true);
    expect(pathMatchesTarget("page-truth://t1/people/x", "t1", "people/x")).toBe(true);
    expect(pathMatchesTarget("notes/a.md", null, "notes/b")).toBe(false);
  });
});

describe("runSearchDiagnose", () => {
  it("finds the target across the layers and names the verdict", async () => {
    const cap = capture();
    let code: number;
    try {
      code = await runSearchDiagnose({
        query: "greek amphitheater acoustics",
        target: "notes/amphitheater",
        json: true,
        configPath: cfgPath,
        embedQueryFn: deterministicEmbedQuery,
      });
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const report = JSON.parse(cap.lines.join("\n"));
    expect(report.keyword.rank).toBe(1);
    expect(report.vector.rank).toBe(1);
    expect(report.hybrid.rank).toBe(1);
    expect(report.verdict).toContain("rank 1 in hybrid");
  });

  it("reports an absent target with the per-arm evidence", async () => {
    const cap = capture();
    let code: number;
    try {
      code = await runSearchDiagnose({
        query: "greek amphitheater acoustics",
        target: "notes/nonexistent",
        json: true,
        configPath: cfgPath,
        embedQueryFn: deterministicEmbedQuery,
      });
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);
    const report = JSON.parse(cap.lines.join("\n"));
    expect(report.hybrid.rank).toBeNull();
    expect(report.verdict).toContain("ABSENT");
  });

  it("rejects a missing target with usage exit 2", async () => {
    const code = await runSearchDiagnose({ query: "x", target: "", configPath: cfgPath });
    expect(code).toBe(2);
  });
});

it("diagnoses a missing page without a query or an embedding call", async () => {
  const cap = capture();
  try {
    const code = await runSearchDiagnose({ query: "", target: "notes/nonexistent", configPath: cfgPath, json: true,
      embedQueryFn: async () => { throw new Error("unexpected paid call"); } });
    expect(code).toBe(0);
    const result = JSON.parse(cap.lines.join("\n"));
    expect(result.verdict).toBe("missing");
    expect(result.hint).toContain("slug");
    expect(result).not.toHaveProperty("vector");
  } finally { cap.restore(); }
});
