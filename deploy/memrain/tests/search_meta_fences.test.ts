/**
 * Search meta against the dispatch-side fences, on a real Storage.
 *
 * keyword_zero, budget_truncated and `retrieved` are measured inside
 * hybridSearch, before dispatch drops page-mirror hits (public) and life/diary
 * hits (every non-operator). A non-operator's meta must therefore not change
 * with whether fenced content matches the query: for a term that exists only
 * behind a fence and a term absent from the corpus, the meta is identical. (The
 * bag-of-words vector arm still returns weak neighbours, so hits are non-empty.)
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { registerSource } from "../src/core/sources.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";

const SOURCE = "meta-fence";
const PAGE_TERM = "zqvxmirrorterm";
const DIARY_TERM = "zqvxdiaryterm";
const ABSENT_TERM = "zqvxabsentterm";

const tenant: AuthInfo = {
  token: "tok-meta-fence",
  clientId: "client-meta-fence",
  scopes: ["read"],
  sourceId: SOURCE,
  allowedSources: [SOURCE],
  isPublic: false,
};

let tmp: string;
let storage: Storage;

function payload(result: ToolCallResult): any {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-meta-fence-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: SOURCE, kind: "vault", pathPrefix: "/meta-fence" });
  const docs = [
    { id: "doc_plain", path: "/meta-fence/garden.md", text: "ordinary garden notes about tomatoes" },
    { id: "doc_page", path: "page://people/someone", text: `${PAGE_TERM} appears only in this page mirror` },
    { id: "doc_diary", path: "page://life/diary/2026-07-01", text: `${DIARY_TERM} appears only in this diary entry` },
  ];
  for (const d of docs) {
    await writeDocumentTransaction(
      storage,
      {
        documentId: d.id,
        sourcePath: d.path,
        title: d.id,
        frontmatter: {},
        embeddingModel: "deterministic-test",
        sourceId: SOURCE,
      },
      [{ text: d.text, entities: [], embedding: deterministicEmbed(d.text) }],
    );
  }
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function run(
  name: "search",
  q: string,
  opts: { isPublic?: boolean; authInfo?: AuthInfo },
  extra: Record<string, unknown> = {},
) {
  return payload(
    await dispatchTool(
      storage,
      { name, arguments: { q, ...extra } },
      { ...opts, embedQuery: deterministicEmbedQuery },
    ),
  );
}

describe("search meta does not reveal fenced matches", () => {
  // Healthy rankings are cached, and a cache hit carries no keyword_zero; each
  // term's first search here must be the non-operator one or the contrast is
  // measured against a cache hit.
  it("public search: a page-mirror-only term and an absent term get the same meta", async () => {
    const page = await run("search", PAGE_TERM, { isPublic: true });
    const absent = await run("search", ABSENT_TERM, { isPublic: true });
    for (const h of [...page.hits, ...absent.hits]) expect(h.sourcePath).not.toStartWith("page://");
    expect(page.meta).toEqual(absent.meta);
    expect(page.meta).toEqual({ vectorEnabled: true, degraded: [] });
  });

  it("public search with a token budget does not report budget_truncated for dropped page hits", async () => {
    const page = await run("search", PAGE_TERM, { isPublic: true }, { token_budget: 1 });
    const absent = await run("search", ABSENT_TERM, { isPublic: true }, { token_budget: 1 });
    expect(page.meta).toEqual(absent.meta);
    expect(page.meta.degraded).not.toContain("budget_truncated");
  });

  for (const tool of ["search"] as const) {
    it(`tenant ${tool}: a diary-only term in its own source and an absent term get the same meta`, async () => {
      const diary = await run(tool, DIARY_TERM, { authInfo: tenant });
      const absent = await run(tool, ABSENT_TERM, { authInfo: tenant });
      for (const h of [...diary.hits, ...absent.hits]) expect(h.sourcePath).not.toContain("life/diary");
      expect(diary.meta).toEqual(absent.meta);
      expect(Object.keys(diary.meta).sort()).toEqual(["degraded", "vectorEnabled"]);
    });
  }

  it("the operator does see the fenced terms (the fixture really matches)", async () => {
    const page = await run("search", PAGE_TERM, {});
    const absent = await run("search", "zqvxoperatorabsent", {});
    expect(page.hits.length).toBeGreaterThan(0);
    expect(page.meta.degraded).not.toContain("keyword_zero");
    expect(absent.meta.degraded).toContain("keyword_zero");
  });
});
