/**
 * Public-ingress redaction through `dispatchTool`, one seed for every surface.
 *
 * `backlinks` returned `surfaceForm` — the raw note-authored wikilink display
 * text (`[[people/jane|Jane's lawyer]]` → `Jane's lawyer`). Public ingress
 * drops the free-text fields, internal ingress keeps them, and the leak-shaped
 * guard survives a field rename.
 *
 * `search`: the vault-exfil fix routes public-ingress `search` through
 * `redactBodies` in `callSearch` (dispatch.ts) — a DIFFERENT allowlist
 * (`PUBLIC_SAFE_FIELDS`) than the page tools. The shared `redactBodies`
 * function is unit-tested in `internal_auth_and_redaction.test.ts`; this
 * covers the MCP-specific wiring.
 *
 * `backlinks` is stubbed via `mock.module` (it joins the RAG-layer
 * entity_mentions tables, which would need the indexer + Bedrock to seed), and
 * so is `hybridSearch` (no Bedrock query embedding, no pgvector). Graph edges
 * are seeded for real (pure DB). `dispatchTool` is imported AFTER
 * `mock.module` so it binds the stubs.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { addLink } from "../src/core/links.ts";
import { putPage } from "../src/core/pages.ts";
import { findBacklinks as _realFindBacklinks } from "../src/core/backlinks.ts";
import * as _searchNs from "../src/core/search/hybrid.ts";
import type { ToolCallResult } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
// Capture the real implementations by VALUE at file-load time — BEFORE
// beforeAll's `mock.module` swaps them. A live `import * as` namespace would
// point at the mock after the swap; spreading into a plain object here copies
// the real function references while they are still real. `mock.module` is
// process-global and bun does NOT auto-restore it between files, so without
// the afterAll restore the stubs leak into every later file that imports them
// (e.g. tests/backlinks.test.ts, tests/hybrid_cache.test.ts). Order-dependent:
// bun's full-suite loader can hit this file before those on Linux CI but after
// them on macOS — green locally, red in CI.
const _realSearchExports = { ..._searchNs };
const realFindBacklinks = _realFindBacklinks;

const PROVENANCE = ["source_chunk_id", "written_at", "inferred_confidence", "id"];
// migration 029 provenance fields that must never surface on public ingress.
const PROVENANCE_029 = ["context", "link_kind", "origin_slug", "origin_field", "resolution_type"];

const SECRET_SURFACE = "Jane's divorce lawyer at Globex";
const SECRET_PAYLOAD = "/vault/private/acquisition-target-globex.md";
const SECRET_KEY = "index:/vault/private/acquisition-target-globex.md";

const SECRET = "Confidential chunk body — Q3 revenue 4.2M, churn 12%.";

const STUB_META = {
  vectorEnabled: false,
  intent: "topic",
  mode: "conservative",
  cache: "miss",
  degraded: ["embed_timeout", "keyword_zero"],
  retrieved: 7,
  returned: 2,
};

let tmp: string;
let storage: Storage;
let dispatchTool: typeof import("../src/mcp/dispatch.ts")["dispatchTool"];

beforeAll(async () => {
  // Stub the backlinks core. The canned hit carries every allowlisted
  // field plus the free-text `surfaceForm` so the public assertion is a
  // complete allowlist contract AND a leak guard.
  mock.module("../src/core/backlinks.ts", () => ({
    findBacklinks: async () => [
      {
        documentId: "doc-1",
        sourcePath: "/vault/people/jane.md",
        title: "Jane",
        mentionCount: 3,
        surfaceForm: SECRET_SURFACE,
      },
    ],
  }));
  // Stub the only search export dispatch imports. The canned hit carries:
  //  - every allowlisted field (title/sourcePath/score/documentId/chunkId/
  //    kind/rank) so the public `toEqual` is a COMPLETE allowlist contract;
  //  - a body field (`content`) and two non-allowlisted fields (`intent`,
  //    `snippet`) so we prove the fail-safe strips bodies AND novel keys.
  mock.module("../src/core/search/hybrid.ts", () => ({
    hybridSearch: async (
      _storage: unknown,
      _q: string,
      opts: { onMeta?: (m: typeof STUB_META) => void },
    ) => {
      opts.onMeta?.(STUB_META);
      return [
      {
        chunkId: "chunk-1",
        documentId: "doc-1",
        sourcePath: "/vault/secret.md",
        title: "Secret",
        kind: "markdown",
        rank: 1,
        content: SECRET,
        snippet: SECRET,
        score: 0.99,
        intent: "topic",
      },
      // A page-derived mirror hit: its slug (`page://people/jane`) is
      // author-written PII and must be dropped from PUBLIC search entirely,
      // while internal callers still receive it.
      {
        chunkId: "page-chunk-1",
        documentId: "doc-page-1",
        sourcePath: "page://people/jane",
        title: "Jane Doe",
        kind: "markdown",
        rank: 2,
        content: SECRET,
        score: 0.88,
        intent: "topic",
      },
    ];
    },
  }));
  ({ dispatchTool } = await import("../src/mcp/dispatch.ts"));

  tmp = mkdtempSync(join(tmpdir(), "memrain-mcp-public-redact-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();

  await putPage(storage, { slug: "people/alice", type: "person", title: "Alice", allowAdHocType: true });
  await putPage(storage, { slug: "companies/acme", type: "company", title: "Acme", allowAdHocType: true });
  await addLink(storage, {
    source_slug: "people/alice",
    target_slug: "companies/acme",
    type: "works_at",
    confidence: 0.9,
    source_chunk_id: "chunk-secret-provenance",
    // migration 029 provenance — `context` is free-text note content and must
    // NEVER reach a public-bearer caller.
    context: "secret-context-window-from-a-private-note",
    link_kind: "typed_ner",
    origin_slug: "people/alice",
    origin_field: "key_people",
    resolution_type: "qualified",
  });

});

afterAll(async () => {
  // Restore the real modules so the stubs cannot leak into later test files
  // (see the load-time capture comment on the imports above).
  mock.module("../src/core/backlinks.ts", () => ({
    findBacklinks: realFindBacklinks,
  }));
  mock.module("../src/core/search/hybrid.ts", () => _realSearchExports);
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

function parse(r: ToolCallResult): { ok: boolean; links: Record<string, unknown>[] } {
  return JSON.parse((r.content[0] as { text: string }).text);
}

function payload(result: ToolCallResult): any {
  expect(result.isError).toBeFalsy();
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text);
}

/** Leak-shaped guard: the secret must not appear anywhere in the payload. */
function expectNoLeak(result: ToolCallResult): void {
  expect(result.content[0]!.text).not.toContain(SECRET);
}




// ---------------------------------------------------------------------------
// backlinks — surfaceForm is note-authored free text
// ---------------------------------------------------------------------------

describe("dispatchTool backlinks redaction", () => {
  it("public ingress omits surfaceForm", async () => {
    const res = await dispatchTool(
      storage,
      { name: "backlinks", arguments: { name: "people/jane" } },
      { isPublic: true },
    );
    const out = payload(res);
    expect(out.hits.length).toBe(1);
    expect(out.hits[0]).not.toHaveProperty("surfaceForm");
    expect(res.content[0]!.text).not.toContain(SECRET_SURFACE);
  });

  it("public ingress preserves allowlisted metadata", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "backlinks", arguments: { name: "people/jane" } },
        { isPublic: true },
      ),
    );
    expect(out.hits[0]).toEqual({
      documentId: "doc-1",
      sourcePath: "/vault/people/jane.md",
      title: "Jane",
      mentionCount: 3,
    });
  });

  it("internal ingress keeps surfaceForm", async () => {
    const out = payload(
      await dispatchTool(storage, {
        name: "backlinks",
        arguments: { name: "people/jane" },
      }),
    );
    expect(out.hits[0].surfaceForm).toBe(SECRET_SURFACE);
  });
});







describe("dispatchTool search redaction", () => {
  it("public ingress strips content (and non-allowlisted fields) from hits", async () => {
    const res = await dispatchTool(
      storage,
      { name: "search", arguments: { q: "revenue" } },
      { isPublic: true },
    );
    const out = payload(res);
    // The page-mirror hit is filtered out → only the vault hit remains.
    expect(out.hits.length).toBe(1);
    expect(out.hits[0]).not.toHaveProperty("content");
    expect(out.hits[0]).not.toHaveProperty("snippet");
    expect(out.hits[0]).not.toHaveProperty("intent");
    expectNoLeak(res);
  });

  it("public ingress drops page-mirror hits entirely (slug is PII)", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "search", arguments: { q: "revenue" } },
        { isPublic: true },
      ),
    );
    expect(
      out.hits.some(
        (h: { sourcePath?: string }) =>
          typeof h.sourcePath === "string" && h.sourcePath.startsWith("page://"),
      ),
    ).toBe(false);
  });

  it("internal ingress retains page-mirror hits", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "search", arguments: { q: "revenue" } },
        { isPublic: false },
      ),
    );
    expect(out.hits.length).toBe(2);
    expect(
      out.hits.some(
        (h: { sourcePath?: string }) => h.sourcePath === "page://people/jane",
      ),
    ).toBe(true);
  });

  it("public ingress preserves allowlisted hit metadata", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "search", arguments: { q: "revenue" } },
        { isPublic: true },
      ),
    );
    expect(out.hits[0]).toEqual({
      chunkId: "chunk-1",
      documentId: "doc-1",
      sourcePath: "/vault/secret.md",
      title: "Secret",
      kind: "markdown",
      rank: 1,
      score: 0.99,
    });
  });

  it("internal ingress returns the full hit including content", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "search", arguments: { q: "revenue" } },
        { isPublic: false },
      ),
    );
    expect(out.hits[0].content).toBe(SECRET);
    expect(out.hits[0].intent).toBe("topic");
  });

  it("default (no opts) is internal — content retained", async () => {
    const out = payload(
      await dispatchTool(storage, {
        name: "search",
        arguments: { q: "revenue" },
      }),
    );
    expect(out.hits[0].content).toBe(SECRET);
  });
});


describe("dispatchTool search MEMRAIN_PUBLIC_READ_BODIES opt-in", () => {
  // Mutates a process-global env var; relies on Bun running tests within a
  // file serially (the default) so the toggle does not bleed elsewhere.
  const ORIGINAL = process.env["MEMRAIN_PUBLIC_READ_BODIES"];
  beforeAll(() => {
    process.env["MEMRAIN_PUBLIC_READ_BODIES"] = "1";
  });
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env["MEMRAIN_PUBLIC_READ_BODIES"];
    else process.env["MEMRAIN_PUBLIC_READ_BODIES"] = ORIGINAL;
  });

  it("public ingress returns content when opted in", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "search", arguments: { q: "revenue" } },
        { isPublic: true },
      ),
    );
    expect(out.hits[0].content).toBe(SECRET);
  });

  it("public meta stays counts-free even when bodies are opted in", async () => {
    const out = payload(
      await dispatchTool(
        storage,
        { name: "search", arguments: { q: "revenue" } },
        { isPublic: true },
      ),
    );
    expect(out.meta).toEqual({ vectorEnabled: false, degraded: ["embed_timeout"] });
  });
});
