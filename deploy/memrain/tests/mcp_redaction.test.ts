/**
 * MCP-ingress body redaction regression test.
 *
 * The v1.2.0 security fix: the public `/mcp` JSON-RPC surface used to
 * return full note bodies. `dispatchTool` now redacts body-bearing read
 * tools when the transport flags `isPublic: true`, mirroring the REST
 * routes via the shared `core/public_redaction.ts` allowlist. The REST
 * path is covered by `internal_auth_and_redaction.test.ts`; this file
 * locks the MCP path so a future refactor cannot silently re-open the
 * vault-exfil hole.
 *
 * Calls `dispatchTool` directly (no HTTP server) and seeds the DB with
 * `putPage` — deterministic and Bedrock-free (avoids `search`, which
 * would require embeddings).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { putPage } from "../src/core/pages.ts";
import { addFact } from "../src/core/facts.ts";
import { addTimelineEvent } from "../src/core/timeline.ts";

const SLUG = "acme-corp";
const SECRET_BODY = "Confidential: Q3 revenue was 4.2M and churn hit 12%.";
const SECRET_FACT = "Acme's undisclosed acquisition target is Globex.";
const SECRET_EVENT = "Signed the confidential Globex term sheet for 9.1M.";

let tmp: string;
let storage: Storage;

// One PGLite instance, seeded once: every case here is a read-only assertion
// against the same page, so a shared fixture is safe and keeps the suite off
// the per-test PGLite cold-init path that flakes on the arm64 CI runner.
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-mcp-redact-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await putPage(storage, {
    slug: SLUG,
    type: "company",
    title: "Acme Corp",
    markdown_body: SECRET_BODY,
    compiled_truth: { sector: "widgets" },
  });
  // World-visible fact: it survives the public path's visibility=['world']
  // floor (mig-085 default is 'private'), so it exercises TEXT redaction —
  // the free-text `fact` is still stripped on public, metadata kept.
  await addFact(storage, {
    entity_slug: SLUG,
    fact: SECRET_FACT,
    visibility: "world",
  });
  await addTimelineEvent(storage, {
    slug: SLUG,
    occurred_at: "2026-02-01T00:00:00Z",
    event: SECRET_EVENT,
  });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Unwrap a dispatch result's JSON payload, asserting it is not an error. */
function payload(result: ToolCallResult): any {
  expect(result.isError).toBeFalsy();
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text);
}

/**
 * Leak-shaped guard: the secret body must not appear ANYWHERE in a public
 * payload. This is stronger than `not.toHaveProperty("markdown_body")` —
 * it survives a field rename (e.g. `markdown_body`→`body`) that would
 * still leak the content under a different key.
 */
function expectNoLeak(result: ToolCallResult): void {
  expect(result.content[0]!.text).not.toContain(SECRET_BODY);
}

// ---------------------------------------------------------------------------
// page_get — the canonical body-bearing read tool
// ---------------------------------------------------------------------------

describe("dispatchTool page_get redaction", () => {
  it("public ingress omits markdown_body", async () => {
    const res = await dispatchTool(
      storage,
      { name: "page_get", arguments: { slug: SLUG } },
      { isPublic: true },
    );
    const out = payload(res);
    expect(out.page).not.toHaveProperty("markdown_body");
    expectNoLeak(res);
  });

  it("public ingress preserves allowlisted metadata", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "page_get", arguments: { slug: SLUG } },
        { isPublic: true },
      ),
    );
    expect(out.page.slug).toBe(SLUG);
    expect(out.page.title).toBe("Acme Corp");
    expect(out.page.compiled_truth).toEqual({ sector: "widgets" });
    expect(out.page).toHaveProperty("content_hash");
  });

  it("internal ingress keeps the full body", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "page_get", arguments: { slug: SLUG } },
        { isPublic: false },
      ),
    );
    expect(out.page.markdown_body).toBe(SECRET_BODY);
  });

  it("default (no opts) is internal — body retained", async () => {
    const out = payload(
      await dispatchTool(storage, { name: "page_get", arguments: { slug: SLUG } }),
    );
    expect(out.page.markdown_body).toBe(SECRET_BODY);
  });
});

// ---------------------------------------------------------------------------
// page_list / page_versions — every body-bearing read path is covered
// ---------------------------------------------------------------------------

describe("dispatchTool page_list redaction", () => {
  it("public ingress strips markdown_body from every row", async () => {
    const res = await dispatchTool(
      storage,
      { name: "page_list", arguments: {} },
      { isPublic: true },
    );
    const out = payload(res);
    expect(out.pages.length).toBeGreaterThan(0);
    for (const p of out.pages) expect(p).not.toHaveProperty("markdown_body");
    expectNoLeak(res);
  });

  it("internal ingress keeps markdown_body", async () => {
    const out = payload(
      await dispatchTool(storage, { name: "page_list", arguments: {} }),
    );
    const seeded = out.pages.find((p: any) => p.slug === SLUG);
    expect(seeded.markdown_body).toBe(SECRET_BODY);
  });
});

describe("dispatchTool page_versions redaction", () => {
  it("public ingress strips body_snapshot from version rows", async () => {
    const res = await dispatchTool(
      storage,
      { name: "page_versions", arguments: { slug: SLUG, include_body: true } },
      { isPublic: true },
    );
    const out = payload(res);
    expect(out.versions.length).toBeGreaterThan(0);
    for (const v of out.versions) expect(v).not.toHaveProperty("body_snapshot");
    expectNoLeak(res);
  });

  it("internal ingress keeps body_snapshot", async () => {
    const out = payload(
      await dispatchTool(storage, {
        name: "page_versions",
        arguments: { slug: SLUG, include_body: true },
      }),
    );
    expect(out.versions[0].body_snapshot).toBe(SECRET_BODY);
  });
});

// ---------------------------------------------------------------------------
// entity_recall — redacts via the recall layer's native redact_body flag
// ---------------------------------------------------------------------------

describe("dispatchTool entity_recall redaction", () => {
  it("public ingress omits page.markdown_body", async () => {
    const res = await dispatchTool(
      storage,
      { name: "entity_recall", arguments: { slug: SLUG } },
      { isPublic: true },
    );
    const out = payload(res);
    expect(out.page).not.toHaveProperty("markdown_body");
    expect(out.page.slug).toBe(SLUG);
    expectNoLeak(res);
    // Fail-safe: the recall page must pass the SAME allowlist as page_get,
    // not just have markdown_body destructured off. Every returned key must
    // be in PUBLIC_SAFE_PAGE_FIELDS (so a new PageRow field can't leak here).
    const allowed = new Set([
      "slug",
      "type",
      "title",
      "compiled_truth",
      "content_hash",
      "created_at",
      "updated_at",
    ]);
    for (const k of Object.keys(out.page)) expect(allowed.has(k)).toBe(true);
    expect(out.page).not.toHaveProperty("deleted_at");
  });

  it("internal ingress keeps page.markdown_body", async () => {
    const out = payload(
      await dispatchTool(storage, {
        name: "entity_recall",
        arguments: { slug: SLUG },
      }),
    );
    expect(out.page.markdown_body).toBe(SECRET_BODY);
  });
});

// ---------------------------------------------------------------------------
// entity_facts / entity_timeline — fact + event text are body-equivalent and
// must be stripped on public ingress (same leak class as note bodies).
// ---------------------------------------------------------------------------

describe("dispatchTool entity_facts redaction", () => {
  it("public ingress omits the free-text `fact`", async () => {
    const res = await dispatchTool(
      storage,
      { name: "entity_facts", arguments: { entity_slug: SLUG } },
      { isPublic: true },
    );
    const out = payload(res);
    expect(out.facts.length).toBeGreaterThan(0);
    for (const f of out.facts) expect(f).not.toHaveProperty("fact");
    expect(res.content[0]!.text).not.toContain(SECRET_FACT);
  });

  it("public ingress preserves allowlisted metadata", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "entity_facts", arguments: { entity_slug: SLUG } },
        { isPublic: true },
      ),
    );
    expect(out.facts[0]).toHaveProperty("confidence");
    expect(out.facts[0]).toHaveProperty("written_at");
  });

  it("internal ingress keeps the full fact text", async () => {
    const out = payload(
      await dispatchTool(storage, {
        name: "entity_facts",
        arguments: { entity_slug: SLUG },
      }),
    );
    expect(out.facts.some((f: any) => f.fact === SECRET_FACT)).toBe(true);
  });
});

describe("dispatchTool entity_timeline redaction", () => {
  it("public ingress omits the free-text `event`", async () => {
    const res = await dispatchTool(
      storage,
      { name: "entity_timeline", arguments: { slug: SLUG } },
      { isPublic: true },
    );
    const out = payload(res);
    expect(out.timeline.length).toBeGreaterThan(0);
    for (const e of out.timeline) expect(e).not.toHaveProperty("event");
    expect(res.content[0]!.text).not.toContain(SECRET_EVENT);
  });

  it("internal ingress keeps the full event text", async () => {
    const out = payload(
      await dispatchTool(storage, {
        name: "entity_timeline",
        arguments: { slug: SLUG },
      }),
    );
    expect(out.timeline.some((e: any) => e.event === SECRET_EVENT)).toBe(true);
  });
});

describe("dispatchTool entity_recall facts/timeline redaction", () => {
  it("public ingress strips fact + event text from the recall arrays", async () => {
    const res = await dispatchTool(
      storage,
      { name: "entity_recall", arguments: { slug: SLUG } },
      { isPublic: true },
    );
    const out = payload(res);
    for (const f of out.facts) expect(f).not.toHaveProperty("fact");
    for (const e of out.timeline) expect(e).not.toHaveProperty("event");
    expect(res.content[0]!.text).not.toContain(SECRET_FACT);
    expect(res.content[0]!.text).not.toContain(SECRET_EVENT);
  });

  it("internal ingress keeps fact + event text", async () => {
    const out = payload(
      await dispatchTool(storage, {
        name: "entity_recall",
        arguments: { slug: SLUG },
      }),
    );
    expect(out.facts.some((f: any) => f.fact === SECRET_FACT)).toBe(true);
    expect(out.timeline.some((e: any) => e.event === SECRET_EVENT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MEMRAIN_PUBLIC_READ_BODIES opt-in — operator can disable redaction
// ---------------------------------------------------------------------------

describe("dispatchTool MEMRAIN_PUBLIC_READ_BODIES opt-in", () => {
  // Mutates a process-global env var; relies on Bun running tests within a
  // file serially (the default) so the toggle does not bleed into the
  // redaction cases above.
  const ORIGINAL = process.env["MEMRAIN_PUBLIC_READ_BODIES"];
  beforeEach(() => {
    process.env["MEMRAIN_PUBLIC_READ_BODIES"] = "1";
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["MEMRAIN_PUBLIC_READ_BODIES"];
    else process.env["MEMRAIN_PUBLIC_READ_BODIES"] = ORIGINAL;
  });

  it("public ingress returns the body when opted in", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "page_get", arguments: { slug: SLUG } },
        { isPublic: true },
      ),
    );
    expect(out.page.markdown_body).toBe(SECRET_BODY);
  });
});
