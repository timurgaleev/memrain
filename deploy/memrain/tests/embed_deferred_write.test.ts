/**
 * A write keeps its text when embedding fails for a reason that passes.
 *
 * Locks: a throttle, timeout, 5xx, spent quota or paused circuit during index
 * writes every chunk WITHOUT a vector — keyword-searchable at once, counted in
 * `embeddingDeferred`, and the remaining chunks skip their calls; the page
 * mirror records a `page-mirror-deferred` row. A failure that would repeat
 * (credentials, access, an unknown model, an oversize input, an unclassified
 * error) still fails the write before anything lands. The classifier names the
 * new classes, and an unknown model pauses batch calls on that model.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { indexDocument } from "../src/core/indexer.ts";
import { mirrorPageVerdict } from "../src/core/page-index.ts";
import { keywordSearch } from "../src/core/search/keyword.ts";
import { getIngestLog } from "../src/core/ingest-log.ts";
import { EMBED_DIMENSIONS } from "../src/core/embedding.ts";
import { setSpendLedgerEngine, trackedInvoke } from "../src/core/budget.ts";
import {
  BedrockHalted,
  classifyBedrockError,
  isTransientBedrockError,
  resetBedrockCircuitForTests,
  runInBatchScope,
} from "../src/core/llm/bedrock-errors.ts";

function sdkError(name: string, message: string, status = 400, code?: string): Error {
  const e = new Error(message) as Error & { $metadata: { httpStatusCode: number }; code?: string };
  e.name = name;
  e.$metadata = { httpStatusCode: status };
  if (code) e.code = code;
  return e;
}

const THROTTLE = sdkError("ThrottlingException", "Too many requests", 429);
const TIMEOUT = sdkError("TimeoutError", "Connection timed out after 30000 ms", 0);
const SERVER = sdkError("ServiceUnavailableException", "Service unavailable", 503);
const UNKNOWN_MODEL = sdkError("ValidationException", "The provided model identifier is invalid.");
const NOT_FOUND = sdkError("ResourceNotFoundException", "Could not resolve the foundation model.", 404);
const ACCESS = sdkError("AccessDeniedException", "not authorized to perform bedrock:InvokeModel", 403);
const TOO_LONG = sdkError("ValidationException", "Input is too long for requested model.");
const EXPIRED = sdkError("ExpiredTokenException", "The security token included in the request is expired", 403);

describe("classifying the new failure classes", () => {
  it("names an unknown model, a timeout and a server failure", () => {
    expect(classifyBedrockError(UNKNOWN_MODEL)).toBe("model_not_found");
    expect(classifyBedrockError(NOT_FOUND)).toBe("model_not_found");
    expect(classifyBedrockError(TIMEOUT)).toBe("timeout");
    expect(classifyBedrockError(sdkError("ModelTimeoutException", "model timed out", 408))).toBe("timeout");
    expect(classifyBedrockError(SERVER)).toBe("server");
    expect(classifyBedrockError(sdkError("InternalServerException", "boom", 500))).toBe("server");
    const reset = new Error("socket hang up") as Error & { code: string };
    reset.code = "ECONNRESET";
    expect(classifyBedrockError(reset)).toBe("server");
    // Validation errors that are about the input stay what they were.
    expect(classifyBedrockError(TOO_LONG)).toBe("input_too_long");
    expect(classifyBedrockError(sdkError("ValidationException", "bad field"))).toBe("other");
  });

  it("calls only the passing failures transient", () => {
    for (const e of [THROTTLE, TIMEOUT, SERVER, sdkError("ServiceQuotaExceededException", "quota")]) {
      expect(isTransientBedrockError(e)).toBe(true);
    }
    expect(isTransientBedrockError(new BedrockHalted("access", 0, "paused"))).toBe(true);
    for (const e of [UNKNOWN_MODEL, NOT_FOUND, ACCESS, TOO_LONG, EXPIRED, new Error("boom")]) {
      expect(isTransientBedrockError(e)).toBe(false);
    }
  });
});

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-embed-defer-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  resetBedrockCircuitForTests();
});

afterEach(async () => {
  resetBedrockCircuitForTests();
  setSpendLedgerEngine(null);
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const vec = () => Array.from<number>({ length: EMBED_DIMENSIONS }).fill(0.01);

/** Three paragraphs long enough to land in separate chunks. */
function threeChunkDoc(word: string): string {
  const para = (n: number) => `${word} paragraph ${n}. ` + "Filler sentence to make the paragraph long. ".repeat(40);
  return `# ${word}\n\n${para(1)}\n\n## Second\n\n${para(2)}\n\n## Third\n\n${para(3)}\n`;
}

async function counts(sourcePath: string): Promise<{ chunks: number; embeddings: number }> {
  const r = await storage.engine().query<{ chunks: number; embeddings: number }>(
    `SELECT count(c.id)::int AS chunks, count(e.chunk_id)::int AS embeddings
       FROM documents d JOIN chunks c ON c.document_id = d.id
       LEFT JOIN embeddings e ON e.chunk_id = c.id
      WHERE d.source_path = $1`,
    [sourcePath],
  );
  return r.rows[0] ?? { chunks: 0, embeddings: 0 };
}

describe("a write whose embedding fails", () => {
  for (const [label, err] of [
    ["throttle", THROTTLE],
    ["timeout", TIMEOUT],
    ["server error", SERVER],
  ] as const) {
    it(`keeps the text on a ${label}, keyword-searchable, with no vectors`, async () => {
      let calls = 0;
      const embedFn = async () => {
        calls++;
        throw err;
      };
      const r = await indexDocument(storage, { sourcePath: "/vault/zebrafinch.md", text: threeChunkDoc("zebrafinch") }, { embedFn });
      const c = await counts("/vault/zebrafinch.md");
      expect(c.chunks).toBeGreaterThan(1);
      expect(c.embeddings).toBe(0);
      expect(r.embeddingDeferred).toBe(c.chunks);
      // The first failure stands for the rest: no further call waits it out.
      expect(calls).toBe(1);
      const hits = await keywordSearch(storage.engine(), "zebrafinch", 10);
      expect(hits.length).toBeGreaterThan(0);
    });
  }

  for (const [label, err] of [
    ["an unknown model", UNKNOWN_MODEL],
    ["a missing model", NOT_FOUND],
    ["denied access", ACCESS],
    ["expired credentials", EXPIRED],
    ["an oversize input", TOO_LONG],
    ["an unclassified error", new Error("unexpected shape")],
  ] as const) {
    it(`still fails the write on ${label}, before anything lands`, async () => {
      const embedFn = async () => {
        throw err;
      };
      await expect(
        indexDocument(storage, { sourcePath: "/vault/hard.md", text: threeChunkDoc("hardfail") }, { embedFn }),
      ).rejects.toThrow();
      expect((await counts("/vault/hard.md")).chunks).toBe(0);
    });
  }

  it("embeds normally and reports nothing deferred when the call works", async () => {
    const r = await indexDocument(storage, { sourcePath: "/vault/fine.md", text: threeChunkDoc("fine") }, { embedFn: async () => vec() });
    expect(r.embeddingDeferred).toBeUndefined();
    const c = await counts("/vault/fine.md");
    expect(c.embeddings).toBe(c.chunks);
  });

  it("writes a fenced-code symbol without a vector when its embedding defers", async () => {
    const text = [
      "# Fence",
      "",
      "Prose about the loader, long enough to be its own chunk of text.",
      "",
      "```typescript",
      "export function loadWidget() { return makeWidget(); }",
      "```",
    ].join("\n");
    // The prose chunk embeds first; the fence symbol's call is throttled.
    let calls = 0;
    const embedFn = async () => {
      if (++calls > 1) throw THROTTLE;
      return vec();
    };
    const r = await indexDocument(storage, { sourcePath: "/vault/fence.md", text }, { embedFn });
    const fence = await storage.engine().query<{ content: string; embedded: boolean }>(
      `SELECT c.content, e.chunk_id IS NOT NULL AS embedded
         FROM documents d JOIN chunks c ON c.document_id = d.id
         LEFT JOIN embeddings e ON e.chunk_id = c.id
        WHERE d.source_path = '/vault/fence.md' AND c.chunk_source = 'fenced_code'`,
    );
    expect(fence.rows).toHaveLength(1);
    expect(fence.rows[0]!.content).toContain("loadWidget");
    expect(fence.rows[0]!.embedded).toBe(false);
    expect(r.embeddingDeferred).toBeGreaterThanOrEqual(1);
  });

  it("still fails the write when a fenced-code embedding fails for good", async () => {
    const text = "# Fence\n\n```typescript\nexport function loadGadget() { return 1; }\n```\n";
    let calls = 0;
    const embedFn = async () => {
      if (++calls > 1) throw ACCESS;
      return vec();
    };
    await expect(indexDocument(storage, { sourcePath: "/vault/fence-hard.md", text }, { embedFn })).rejects.toThrow();
    expect((await counts("/vault/fence-hard.md")).chunks).toBe(0);
  });

  it("logs a page-mirror-deferred row when a page mirror defers", async () => {
    const v = await mirrorPageVerdict(
      storage,
      { slug: "notes/deferred", title: "Deferred", markdown_body: threeChunkDoc("deferredpage") },
      { remote: false, embedFn: async () => { throw THROTTLE; } },
    );
    expect(v.ok).toBe(true);
    expect(v.embeddingDeferred).toBeGreaterThan(0);
    const log = await getIngestLog(storage.engine(), { limit: 20 });
    const row = log.find((e) => e.source_type === "page-mirror-deferred");
    expect(row?.source_ref).toBe("notes/deferred");
    expect(log.some((e) => e.source_type === "page-mirror-failed")).toBe(false);
  });
});

describe("an unknown model in batch work", () => {
  it("pauses later calls on that model after the first failure", async () => {
    setSpendLedgerEngine(storage.engine());
    const model = "eu.anthropic.claude-typo-v9:0";
    let sends = 0;
    const call = () =>
      trackedInvoke({ operation: "t", model, worstCase: { input: "x", maxOutputTokens: 1 } }, async () => {
        sends++;
        throw UNKNOWN_MODEL;
      });
    await runInBatchScope({ stopped: false, circuit: true }, async () => {
      await call().catch(() => {});
      await expect(call()).rejects.toThrow("BedrockHalted");
    });
    expect(sends).toBe(1);
  });
});
