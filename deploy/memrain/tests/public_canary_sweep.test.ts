import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { addLink } from "../src/core/links.ts";
import { entityId } from "../src/core/entities.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { OPERATIONS } from "../src/mcp/operations.ts";
import { evaluatePublicGuard, isPublicMcpToolForbidden } from "../src/http/public_guard.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";
import { seedFact, seedTimelineEvent, seedRawData } from "./helpers/seed-rows.ts";

const slug = "notes/canary";
const secret = (kind: string) => `PRIVATE_CANARY_${kind}_753`;
const rows: Array<{ name: string; args?: Record<string, unknown>; canary?: string }> = [
  { name: "search", args: { q: "garden" }, canary: "CHUNK" },
  { name: "backlinks", args: { name: "CanaryTarget" }, canary: "WIKILINK" },
  { name: "page_get", args: { slug }, canary: "BODY" },
  { name: "page_list", args: { include_body: true }, canary: "BODY" },
  { name: "page_versions", args: { slug, include_body: true }, canary: "BODY" },
  // Public deployment metadata, rather than note text.
  { name: "get_brain_identity" }, { name: "whoami" },
];

describe("default public bearer canary sweep", () => {
  let db: Awaited<ReturnType<ReturnType<typeof storageEngines>[number]["open"]>>;
  const savedEnv = new Map<string, string | undefined>();
  beforeAll(async () => {
    for (const key of ["MEMRAIN_PUBLIC_WRITE", "MEMRAIN_PUBLIC_READ_BODIES"]) {
      savedEnv.set(key, process.env[key]);
      process.env[key] = "0";
    }
    db = await storageEngines(undefined)[0]!.open();
    await putPage(db.storage, { slug, markdown_body: secret("BODY") });
    await putPage(db.storage, { slug: "notes/target", markdown_body: "Target" });
    await seedFact(db.storage, { entity_slug: slug, fact: secret("FACT"), visibility: "world" });
    await seedTimelineEvent(db.storage, { slug, occurred_at: "2026-01-01", event: secret("TIMELINE"), detail: secret("DETAIL") });
    await addLink(db.storage, { source_slug: slug, target_slug: "notes/target", type: "mentions", context: secret("LINK_CONTEXT"), source_chunk_id: secret("LINK_PROVENANCE") });
    await seedRawData(db.storage, slug, "manual", { text: secret("RAW") });
    const text = `garden ${secret("CHUNK")}`;
    await writeDocumentTransaction(db.storage, { documentId: "canary-doc", sourcePath: "/canary/garden.md", title: "Garden",
      frontmatter: {}, embeddingModel: "deterministic-test", sourceId: "default" }, [{ text, entities: [], embedding: deterministicEmbed(text) }]);
    const chunks = await db.storage.engine().query<{ id: string }>("SELECT id FROM chunks WHERE document_id = 'canary-doc'");
    const entity = entityId("wikilink", "CanaryTarget");
    await db.storage.engine().query("INSERT INTO entities (id, type, name) VALUES ($1, 'wikilink', 'CanaryTarget')", [entity]);
    await db.storage.engine().query("INSERT INTO entity_mentions (chunk_id, entity_id, surface_form) VALUES ($1, $2, $3)", [chunks.rows[0]!.id, entity, secret("WIKILINK")]);
  });
  afterAll(async () => {
    await db.close();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("requires an explicit test row for every public operation", () => {
    expect(rows.map(r => r.name).sort()).toEqual(OPERATIONS.filter(op => !isPublicMcpToolForbidden(op.name)).map(op => op.name).sort());
  });

  for (const row of rows) it(`${row.name} never returns any private canary`, async () => {
    const args = row.args ?? {};
    const req = new Request("https://brain.example.com/mcp", { method: "POST",
      headers: { "Cf-Connecting-Ip": "192.0.2.1", Authorization: "Bearer canary-test-bearer" },
    });
    const guard = evaluatePublicGuard(req, new URL(req.url), { bearerToken: "canary-test-bearer" });
    expect(guard).toMatchObject({ allow: true, isPublic: true });
    if (!guard.allow) throw new Error("test public bearer was refused");
    const pub = await dispatchTool(db.storage, { name: row.name, arguments: args }, { isPublic: guard.isPublic, embedQuery: deterministicEmbedQuery });
    expect(pub.isError).toBeFalsy();
    expect(JSON.stringify(pub)).not.toContain("PRIVATE_CANARY_");
    const internal = await dispatchTool(db.storage, { name: row.name, arguments: args }, { embedQuery: deterministicEmbedQuery });
    expect(internal.isError).toBeFalsy();
    if (row.canary) expect(JSON.stringify(internal)).toContain(secret(row.canary));
    if (row.name === "whoami") expect(JSON.parse(pub.content[0]!.text)).toMatchObject({ operator: false, is_public: true });
  });

});
