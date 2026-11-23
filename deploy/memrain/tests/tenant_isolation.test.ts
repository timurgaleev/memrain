/**
 * Tenant isolation — the cross-tenant leak contract.
 *
 * Two tenants ('a', 'b') write the same entity. A caller scoped to one source
 * (via DispatchOptions.authInfo) must never see the other's pages, facts,
 * timeline, or links. An unscoped caller (no authInfo — local/internal) still
 * sees everything (back-compat).
 *
 * Bedrock-free: seeds via core writers + asserts through dispatchTool, no
 * `search` (which would need embeddings). Search isolation is structural — the
 * arms filter `documents.source_id` and the page→document bridge stamps it.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { putPage } from "../src/core/pages.ts";
import { seedFact, seedTimelineEvent } from "./helpers/seed-rows.ts";
import { addLink } from "../src/core/links.ts";
import { registerSource } from "../src/core/sources.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { hybridSearch } from "../src/core/search/hybrid.ts";
import { deterministicEmbed } from "./det-embed.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

// Inject the deterministic embedder so the page→chunks bridge never calls Bedrock.
const embedFn = async (text: string) => deterministicEmbed(text);

const ENTITY = "acme";
const A_SLUG = "companies/acme-a";
const B_SLUG = "companies/acme-b";
const A_SECRET = "Tenant-A-only: revenue 4.2M";
const B_SECRET = "Tenant-B-only: revenue 9.9M";
// A-only chunk body (distinct token) so get_chunks leakage is unambiguous.
const A_CHUNK_SECRET = "TenantAChunkSecret-zebra-quartz-9417";
// Target page A's body wikilinks to, so page_put derives a wikilink edge.
const A_LINK_TARGET = "companies/acme-subsidiary-a";

// Read-surface fixtures (BATCH 3): a shared keyword ("quokka") with per-tenant
// secret tokens, mirrored into the search store so a scoped query/hydrate
// proves it filters on documents.source_id. Bedrock-free via the det-embed seam.
const QA_SLUG = "qtest/quokka-a";
const QB_SLUG = "qtest/quokka-b";
const QA_TOKEN = "AlphaSecretAAA";
const QB_TOKEN = "BetaSecretBBB";
const QA_BODY = `quokka ${QA_TOKEN}`;
const QB_BODY = `quokka ${QB_TOKEN}`;

let tmp: string;
let storage: Storage;

function auth(sourceId: string): AuthInfo {
  return {
    token: `tok-${sourceId}`,
    clientId: `client-${sourceId}`,
    scopes: ["read", "write"],
    sourceId,
    allowedSources: [sourceId],
    isPublic: false,
  };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-tenant-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  await registerSource(e, { id: "a", kind: "vault", pathPrefix: "/tenant-a" });
  await registerSource(e, { id: "b", kind: "vault", pathPrefix: "/tenant-b" });

  await putPage(storage, { slug: A_SLUG, type: "company", title: "Acme A", markdown_body: A_SECRET, source_id: "a" });
  await putPage(storage, { slug: B_SLUG, type: "company", title: "Acme B", markdown_body: B_SECRET, source_id: "b" });
  // Entity page needed for FK on timeline_events.slug and facts.entity_slug
  await putPage(storage, { slug: ENTITY, type: "company", title: "Acme Entity" });
  // visibility:"world" — a scoped tenant reader is floored to world-visible
  // facts (mig-085); the tenant isolation here is enforced by source_id, so the
  // facts must clear the world floor to be readable at all.
  await seedFact(storage, { entity_slug: ENTITY, fact: A_SECRET, source_id: "a", visibility: "world" });
  await seedFact(storage, { entity_slug: ENTITY, fact: B_SECRET, source_id: "b", visibility: "world" });
  // Timeline events go on each tenant's OWN page (ownership guard: a scoped caller
  // may only append to a page its own source owns — a tenant cannot annotate the
  // shared/default ENTITY, which would be another tenant's page).
  await seedTimelineEvent(storage, { slug: A_SLUG, occurred_at: "2026-01-01T00:00:00Z", event: A_SECRET, source_id: "a" });
  await seedTimelineEvent(storage, { slug: B_SLUG, occurred_at: "2026-01-02T00:00:00Z", event: B_SECRET, source_id: "b" });
  await addLink(storage, { source_slug: A_SLUG, target_slug: ENTITY, type: "mentions", source_id: "a" });
  await addLink(storage, { source_slug: B_SLUG, target_slug: ENTITY, type: "mentions", source_id: "b" });

  // get_chunks: mirror A's page body into the search store (documents+chunks),
  // exactly as the page bridge would, but offline via the det-embed seam. The
  // mirror document carries source_id "a" so a B-scoped get_chunks must not
  // see A's chunk text.
  await indexPageIntoSearch(
    storage,
    { slug: A_SLUG, title: "Acme A", markdown_body: A_CHUNK_SECRET, source_id: "a" },
    { embedFn },
  );

  // Derived-write stamping: wikilink target page (source_id "a") so A's
  // page_put can derive a resolvable wikilink edge to it.
  await putPage(storage, { slug: A_LINK_TARGET, type: "company", title: "Acme Subsidiary A", markdown_body: "sub", source_id: "a" });

  // BATCH 3 read-surface fixtures — both tenants share the "quokka" keyword so
  // retrieval surfaces both, and only the scope decides which chunk hydrates.
  await indexPageIntoSearch(storage, { slug: QA_SLUG, title: "Quokka A", markdown_body: QA_BODY, source_id: "a" }, { embedFn });
  await indexPageIntoSearch(storage, { slug: QB_SLUG, title: "Quokka B", markdown_body: QB_BODY, source_id: "b" }, { embedFn });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

function payload(result: ToolCallResult): any {
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text);
}

async function call(name: string, args: Record<string, unknown>, authInfo?: AuthInfo): Promise<any> {
  return payload(await dispatchTool(storage, { name, arguments: args }, authInfo ? { authInfo } : {}));
}

describe("tenant isolation via dispatch authInfo", () => {
  it("page_get: A reads its own page", async () => {
    const out = await call("page_get", { slug: A_SLUG }, auth("a"));
    expect(JSON.stringify(out)).toContain(A_SECRET);
  });

  it("get_chunks: B cannot read A's page chunk text", async () => {
    // A's chunk is reachable to A...
    const a = JSON.stringify(await call("get_chunks", { slug: A_SLUG }, auth("a")));
    expect(a).toContain(A_CHUNK_SECRET);
    // ...but B's get_chunks for A's slug must not surface A's chunk body.
    const b = JSON.stringify(await call("get_chunks", { slug: A_SLUG }, auth("b")));
    expect(b).not.toContain(A_CHUNK_SECRET);
  });

  it("derived-write stamping: A's page_put stamps wikilink edges as source 'a' (not 'default')", async () => {
    // page_put through dispatch derives a wikilink edge from the body. With an
    // authInfo write source, the derived edge must inherit 'a' — never the
    // 'default' column default (which would make it whole-brain visible).
    await call(
      "page_put",
      { slug: A_SLUG, type: "company", title: "Acme A", markdown_body: `${A_SECRET}\n\nSee [[${A_LINK_TARGET}]].` },
      auth("a"),
    );
    // Query the links table directly to confirm the stored provenance.
    const rows = await storage.engine().query<{ source_id: string }>(
      `SELECT source_id FROM links
        WHERE source_slug = $1 AND target_slug = $2 AND type = 'wikilink'`,
      [A_SLUG, A_LINK_TARGET],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of rows.rows) {
      expect(r.source_id).toBe("a");
      expect(r.source_id).not.toBe("default");
    }
    // And an unscoped get_links shows the derived edge under source 'a'.
    const unscoped = JSON.stringify(await call("get_links", { slug: A_SLUG }));
    expect(unscoped).toContain(A_LINK_TARGET);
  });

  it("back-compat: an unscoped caller sees both tenants", async () => {
    const all = JSON.stringify(await call("page_list", {}));
    expect(all).toContain(A_SLUG);
    expect(all).toContain(B_SLUG);
  });
});

describe("read-surface scoping (BATCH 3)", () => {
  it("hydrate: scoped hybridSearch hydrates only in-scope chunks; unscoped sees both", async () => {
    const scoped = await hybridSearch(storage, "quokka", {
      k: 10,
      sourceIds: ["a"],
      embedQuery: embedFn,
    });
    const scopedStr = JSON.stringify(scoped);
    expect(scopedStr).toContain(QA_TOKEN);
    expect(scopedStr).not.toContain(QB_TOKEN);
    const unscoped = JSON.stringify(
      await hybridSearch(storage, "quokka", { k: 10, embedQuery: embedFn }),
    );
    expect(unscoped).toContain(QA_TOKEN);
    expect(unscoped).toContain(QB_TOKEN);
  });
});
