/**
 * LongMemEval dataset cache: the pinned file is downloaded to a temporary
 * name, verified against its sha256 and only then renamed into place, so a
 * failed or tampered download never leaves a cache entry behind.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DatasetChecksumError,
  DatasetFetchError,
  DatasetFormatError,
  LONGMEMEVAL_S_CLEANED,
  ensureDataset,
  parseDataset,
  type DatasetSpec,
} from "../src/eval/longmemeval/dataset.ts";

const BODY = JSON.stringify([{
  question_id: "q1", question_type: "single-session-user", question: "Where did I park?",
  answer: "Level 3", question_date: "2023/05/01 (Mon) 10:00",
  haystack_dates: ["2023/04/30 (Sun) 09:00"], haystack_session_ids: ["s1"],
  haystack_sessions: [[{ role: "user", content: "I parked on level 3.", has_answer: true }]],
  answer_session_ids: ["s1"],
}]);
const SHA = createHash("sha256").update(BODY).digest("hex");
const SPEC: DatasetSpec = { url: "https://example.invalid/lme.json", sha256: SHA, bytes: Buffer.byteLength(BODY), file: "lme.json" };

function respond(body: string): typeof fetch {
  return (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
}

describe("ensureDataset", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "memrain-lme-cache-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("pins the cleaned LongMemEval-S file by revision and checksum", () => {
    expect(LONGMEMEVAL_S_CLEANED.url).toContain("/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/");
    expect(LONGMEMEVAL_S_CLEANED.url).toEndWith("longmemeval_s_cleaned.json");
    expect(LONGMEMEVAL_S_CLEANED.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("downloads, verifies and caches the file, then serves the cache without fetching", async () => {
    const path = await ensureDataset(SPEC, { cacheDir: dir, fetchFn: respond(BODY) });
    expect(readdirSync(dir)).toEqual([SPEC.file]);
    let fetched = 0;
    const again = await ensureDataset(SPEC, {
      cacheDir: dir,
      fetchFn: (async () => { fetched++; return new Response(BODY); }) as unknown as typeof fetch,
    });
    expect(again).toBe(path);
    expect(fetched).toBe(0);
  });

  it("refuses a checksum mismatch and leaves nothing in the cache", async () => {
    await expect(ensureDataset(SPEC, { cacheDir: dir, fetchFn: respond(`${BODY} `) }))
      .rejects.toBeInstanceOf(DatasetChecksumError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("reports a network failure as retryable and leaves nothing in the cache", async () => {
    const failing = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const err = await ensureDataset(SPEC, { cacheDir: dir, fetchFn: failing }).catch((e) => e);
    expect(err).toBeInstanceOf(DatasetFetchError);
    expect(String(err.message)).toContain(SPEC.url);
    expect(readdirSync(dir)).toEqual([]);
    const notFound = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    await expect(ensureDataset(SPEC, { cacheDir: dir, fetchFn: notFound })).rejects.toBeInstanceOf(DatasetFetchError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a cached file that no longer matches its checksum", async () => {
    writeFileSync(join(dir, SPEC.file), "tampered");
    await expect(ensureDataset(SPEC, { cacheDir: dir, fetchFn: respond(BODY) }))
      .rejects.toBeInstanceOf(DatasetChecksumError);
  });
});

describe("parseDataset", () => {
  it("reads questions and keeps the answer labels off the turns", () => {
    const [q] = parseDataset(BODY);
    expect(q!.question_id).toBe("q1");
    expect(q!.answer).toBe("Level 3");
    expect(q!.sessions).toEqual([{ id: "s1", date: "2023/04/30 (Sun) 09:00",
      turns: [{ role: "user", content: "I parked on level 3." }] }]);
    expect(JSON.stringify(q!.sessions)).not.toContain("has_answer");
  });

  it("refuses a record whose session arrays disagree", () => {
    const bad = JSON.parse(BODY);
    bad[0].haystack_dates = [];
    expect(() => parseDataset(JSON.stringify(bad))).toThrow(DatasetFormatError);
  });

  it("refuses a file that is not a list of questions", () => {
    expect(() => parseDataset("{}")).toThrow(DatasetFormatError);
  });
});
