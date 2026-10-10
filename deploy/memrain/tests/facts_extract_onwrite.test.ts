/**
 * Item 1 — on-write fact extraction: the eligibility predicate, the bounded
 * in-memory queue, and the best-effort per-page extractor (with an injected
 * fake Sonnet so no Bedrock call happens).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  isFactsExtractionEligible,
  factsExtractionEnabled,
  extractFactsForPage,
} from "../src/core/facts-extract.ts";
import {
  FactsQueue,
  __resetFactsQueueForTests,
} from "../src/core/facts-queue.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";
import { putPage } from "../src/core/pages.ts";
import { QUARANTINE_KEY } from "../src/core/quarantine.ts";

const LONG_BODY =
  "Alice said she will move to Gotham in March and prefers tea over coffee. " +
  "She now leads the Acme onboarding project.";

/** Fake Sonnet returning a fixed one-fact JSON payload; records call count. */
function fakeSonnet(): { fn: SonnetFn; calls: () => number } {
  let n = 0;
  const fn: SonnetFn = async () => {
    n += 1;
    return {
      text: JSON.stringify({
        facts: [
          {
            fact: "prefers tea over coffee",
            kind: "preference",
            entity: "people/alice",
            confidence: 0.9,
            notability: "medium",
          },
        ],
      }),
      modelId: "eu.anthropic.claude-sonnet-4-6",
      usage: { inputTokens: 120, outputTokens: 40 },
    };
  };
  return { fn, calls: () => n };
}

describe("isFactsExtractionEligible", () => {
  it("accepts a long-enough prose page", () => {
    expect(isFactsExtractionEligible("note", LONG_BODY, "notes/x")).toEqual({
      ok: true,
    });
    expect(isFactsExtractionEligible("meeting", LONG_BODY).ok).toBe(true);
  });

  it("rejects an entity/structured page type", () => {
    const r = isFactsExtractionEligible("person", LONG_BODY);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toBe("kind:person");
  });

  it("rejects a too-short body", () => {
    const r = isFactsExtractionEligible("note", "short");
    expect(r).toEqual({ ok: false, reason: "too_short" });
  });

  it("rejects the subagent scratch namespace", () => {
    const r = isFactsExtractionEligible("note", LONG_BODY, "wiki/agents/foo");
    expect(r).toEqual({ ok: false, reason: "subagent_namespace" });
  });
});

describe("factsExtractionEnabled", () => {
  it("is OFF by default and ON only for 1/true", () => {
    expect(factsExtractionEnabled(undefined)).toBe(false);
    expect(factsExtractionEnabled("0")).toBe(false);
    expect(factsExtractionEnabled("1")).toBe(true);
    expect(factsExtractionEnabled("TRUE")).toBe(true);
  });
});

describe("FactsQueue", () => {
  afterEach(() => __resetFactsQueueForTests());

  it("runs an enqueued job and counts completion", async () => {
    const q = new FactsQueue();
    let ran = false;
    q.enqueue(async () => {
      ran = true;
    }, "s1");
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toBe(true);
    expect(q.getCounters().completed).toBe(1);
  });

  it("absorbs a job failure into the failed counter (never throws)", async () => {
    const q = new FactsQueue();
    q.enqueue(async () => {
      throw new Error("boom");
    }, "s1");
    await new Promise((r) => setTimeout(r, 0));
    const c = q.getCounters();
    expect(c.failed).toBe(1);
    expect(c.completed).toBe(0);
  });

  it("drops the oldest pending job on overflow", () => {
    const q = new FactsQueue({ cap: 1 });
    // Three synchronous enqueues before any microtask pump runs: the cap-1
    // pending array sheds the two older entries.
    q.enqueue(async () => {}, "s1");
    q.enqueue(async () => {}, "s1");
    q.enqueue(async () => {}, "s1");
    expect(q.getCounters().dropped_overflow).toBe(2);
    expect(q.getCounters().enqueued).toBe(3);
  });

  it("serializes per session: inflight cap 1 holds the second job", async () => {
    const q = new FactsQueue({ cap: 10, perSessionInflightCap: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let secondStarted = false;
    q.enqueue(async () => {
      await gate;
    }, "s1");
    q.enqueue(async () => {
      secondStarted = true;
    }, "s1");
    await new Promise((r) => setTimeout(r, 0));
    expect(q.inflightCount()).toBe(1);
    expect(secondStarted).toBe(false);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(secondStarted).toBe(true);
    expect(q.getCounters().completed).toBe(2);
  });
});

describe("extractFactsForPage", () => {
  let tmp: string;
  let storage: Storage;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-onwrite-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });
  afterEach(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Mark (or create) the mirror document at `path` as quarantined. */
  async function quarantineMirror(path: string): Promise<void> {
    const e = storage.engine();
    const held = `{"${QUARANTINE_KEY}":{"patterns":["test"]}}`;
    await e.query(
      `UPDATE documents SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || $2::jsonb WHERE source_path = $1`,
      [path, held],
    );
    await e.query(
      `INSERT INTO documents (id, source_path, title, frontmatter)
       SELECT 'held-doc', $1, 'held', $2::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM documents WHERE source_path = $1)`,
      [path, held],
    );
  }

  it("makes no call for a page whose search mirror is quarantined", async () => {
    await putPage(storage, { slug: "notes/held", type: "note", markdown_body: LONG_BODY });
    await quarantineMirror("page://notes/held");
    const { fn, calls } = fakeSonnet();
    const r = await extractFactsForPage(storage, {
      slug: "notes/held",
      type: "note",
      body: LONG_BODY,
      sonnetFn: fn,
    });
    expect(calls()).toBe(0);
    expect(r.factsWritten).toBe(0);
  });

  it("writes an extracted fact scoped to the page source", async () => {
    await storage
      .engine()
      .query(
        "INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING",
        ["tenant-a", "tenant-a/"],
      );
    const { fn, calls } = fakeSonnet();
    const r = await extractFactsForPage(storage, {
      slug: "notes/alice-sync",
      type: "note",
      body: LONG_BODY,
      sourceId: "tenant-a",
      sonnetFn: fn,
    });
    expect(calls()).toBe(1);
    expect(r.factsWritten).toBe(1);
    const rows = await storage.engine().query<{
      entity_slug: string;
      source_id: string;
      source_slug: string | null;
      written_by: string | null;
    }>(
      `SELECT entity_slug, source_id, source_slug, written_by
         FROM entity_facts WHERE written_by = 'facts-extract'`,
    );
    expect(rows.rows).toHaveLength(1);
    // slugifyEntity kebab-slugs each path segment, preserving the namespace.
    expect(rows.rows[0]!.entity_slug).toBe("people/alice");
    expect(rows.rows[0]!.source_id).toBe("tenant-a");
    expect(rows.rows[0]!.source_slug).toBe("notes/alice-sync");
  });

  it("returns zero writes when the budget cap is below one call", async () => {
    const { fn, calls } = fakeSonnet();
    const r = await extractFactsForPage(storage, {
      slug: "notes/x",
      type: "note",
      body: LONG_BODY,
      sonnetFn: fn,
      maxBudgetUsd: 0.0000001, // below the pre-flight worst-case ceiling
    });
    expect(calls()).toBe(0); // pre-flight guard skipped the paid call
    expect(r.factsWritten).toBe(0);
  });

  it("default per-write budget affords the truncation retry for a full-window page", async () => {
    // A page at the extractor's input window, cut at the 800-token cap: the
    // retry must fit the DEFAULT per-write ceiling, or long pages lose facts.
    let n = 0;
    const fn: SonnetFn = async () => {
      n += 1;
      if (n === 1) {
        return {
          text: '{"facts": [{"fact": "prefers tea',
          modelId: "eu.anthropic.claude-sonnet-4-6",
          usage: { inputTokens: 4000, outputTokens: 800 },
          stopReason: "max_tokens",
        };
      }
      const ok = await fakeSonnet().fn({ system: "", user: "", maxTokens: 1600 });
      return { ...ok, usage: { inputTokens: 4000, outputTokens: 900 } };
    };
    const saved = process.env["MEMRAIN_FACTS_WRITE_BUDGET_USD"];
    delete process.env["MEMRAIN_FACTS_WRITE_BUDGET_USD"];
    let r;
    try {
      r = await extractFactsForPage(storage, {
        slug: "notes/long",
        type: "note",
        body: LONG_BODY,
        sonnetFn: fn,
        modelId: "eu.anthropic.claude-sonnet-4-6",
      });
    } finally {
      if (saved !== undefined) process.env["MEMRAIN_FACTS_WRITE_BUDGET_USD"] = saved;
    }
    expect(n).toBe(2);
    expect(r.factsWritten).toBe(1);
  });
});
