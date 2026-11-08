/**
 * ingest_log substrate (migration 087 + core/ingest-log.ts): source_id scoping,
 * the durable facts:absorb writer with stable reason codes, the error
 * classifier, and the on-write extraction path filing a row when the model
 * call is absorbed.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  FACTS_ABSORB_SOURCE_TYPE,
  classifyFactsAbsorbError,
  getIngestLog,
  logIngest,
  writeFactsAbsorbLog,
} from "../src/core/ingest-log.ts";
import { extractFactsForPage } from "../src/core/facts-extract.ts";
import { putPage } from "../src/core/pages.ts";
import { FactsQueue } from "../src/core/facts-queue.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-ingest-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("logIngest / getIngestLog", () => {
  it("writes and reads back a scoped entry", async () => {
    await logIngest(storage.engine(), {
      source_type: "importer:mail",
      source_ref: "mbox-1",
      pages_updated: ["email/one", "email/two"],
      summary: "2 pages",
      source_id: "default",
    });
    const rows = await getIngestLog(storage.engine(), { limit: 5 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_type).toBe("importer:mail");
    expect(rows[0]!.source_id).toBe("default");
    expect(rows[0]!.pages_updated).toEqual(["email/one", "email/two"]);
    // Scope filter: a disjoint tenant sees nothing.
    expect(
      await getIngestLog(storage.engine(), { sourceIds: ["other"] }),
    ).toHaveLength(0);
  });
});

describe("classifyFactsAbsorbError", () => {
  it("maps error shapes to stable reason codes", () => {
    expect(classifyFactsAbsorbError(new Error("Request timed out"))).toBe("gateway_error");
    expect(classifyFactsAbsorbError(new Error("429 Too Many Requests"))).toBe("gateway_error");
    expect(classifyFactsAbsorbError(new Error("ThrottlingException"))).toBe("gateway_error");
    expect(classifyFactsAbsorbError(new Error("Unexpected token < in JSON"))).toBe("parse_failure");
    expect(classifyFactsAbsorbError(new Error("something else entirely"))).toBe("pipeline_error");
    const budget = new Error("cap");
    budget.name = "BudgetExhausted";
    expect(classifyFactsAbsorbError(budget)).toBe("budget_exhausted");
  });
});

describe("writeFactsAbsorbLog", () => {
  it("files a facts:absorb row with `reason: detail` summary", async () => {
    await writeFactsAbsorbLog(
      storage.engine(),
      "notes/today",
      "gateway_error",
      "x".repeat(500),
    );
    const rows = await getIngestLog(storage.engine(), {
      source_type: FACTS_ABSORB_SOURCE_TYPE,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_ref).toBe("notes/today");
    expect(rows[0]!.summary!.startsWith("gateway_error: ")).toBe(true);
    // Detail truncated to 240 chars.
    expect(rows[0]!.summary!.length).toBeLessThanOrEqual("gateway_error: ".length + 240);
  });
});

describe("FactsQueue onError hook", () => {
  it("invokes the hook on job failure; hook errors never cascade", async () => {
    const q = new FactsQueue();
    const seen: unknown[] = [];
    q.enqueue(
      () => Promise.reject(new Error("boom")),
      "s1",
      (err) => {
        seen.push(err);
        throw new Error("hook failure must be swallowed");
      },
    );
    // Drain the microtask pump.
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe("boom");
    expect(q.getCounters().failed).toBe(1);
  });
});

describe("extractFactsForPage absorb path (durable)", () => {
  it("files a row when the model call fails, instead of losing the failure", async () => {
    await putPage(storage, { slug: "notes/failing", markdown_body: "long enough body ".repeat(10) });
    const r = await extractFactsForPage(storage, {
      slug: "notes/failing",
      type: "note",
      body: "long enough body ".repeat(10),
      sonnetFn: () => Promise.reject(new Error("503 Service Unavailable")),
    });
    expect(r.factsWritten).toBe(0);
    const rows = await getIngestLog(storage.engine(), {
      source_type: FACTS_ABSORB_SOURCE_TYPE,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_ref).toBe("notes/failing");
    expect(rows[0]!.summary!.startsWith("gateway_error:")).toBe(true);
  });
});
