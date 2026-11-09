import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { frameExternal } from "../src/core/trust-frame.ts";
import { putPage } from "../src/core/pages.ts";
import { addFact } from "../src/core/facts.ts";
import { buildContextPack } from "../src/core/context/context-pack.ts";
import { FENCE_WRITERS } from "../src/core/facts-reconcile.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`context fact provenance ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => { db = await engine.open(); });
  afterAll(async () => { await db.close(); });
  it("labels card and loose facts without revealing the writer credential", async () => {
    await putPage(db.storage, { slug: "projects/provenance", markdown_body: "Provenance project" });
    const origins = [
      ["operator", "operator", "operator"],
      ["custom-agent", "client:private-client|enrollment:secret-name", "agent"],
      ["facts-extract", undefined, "extractor"],
      ["memrain:facts-fence", undefined, "ingest"],
    ] as const;
    for (const [written_by, principal, label] of origins) await addFact(db.storage, {
      entity_slug: "projects/provenance", fact: `${label} claim`, written_by,
      ...(principal ? { written_by_principal: principal } : {}), attributed_to: "assistant", confidence: 0.9,
    });
    for (const slugs of [[], ["projects/provenance"]]) {
      const pack = await buildContextPack(db.storage, { slugs, decay: false });
      const facts = slugs.length ? pack.cards[0]!.facts : pack.facts;
      expect(facts.map(f => f.fact).sort()).toEqual(origins.map(([, , label]) => { const text = `[${label}] (assistant said) ${label} claim`; return label === "agent" ? frameExternal(text) : text; }).sort());
      expect(JSON.stringify(pack)).not.toContain("private-client");
      expect(JSON.stringify(pack)).not.toContain("secret-name");
    }
    const redacted = await buildContextPack(db.storage, { slugs: ["projects/provenance"], redact: true, decay: false });
    expect(redacted.cards[0]!.facts.every(f => f.fact === undefined)).toBe(true);
  });
  it("keeps authenticated client and public facts labelled as agents despite supplied writer labels", async () => {
    const writers = ["facts-extract", "extract-facts", "extract-conversation-facts", "ingest", "ingest:custom", ...FENCE_WRITERS, "operator"];
    const claims = writers.map((_, index) => `Spoof claim ${index}`);
    for (const [index, written_by] of writers.entries()) {
      const slug = `projects/provenance-spoof-${index}`;
      await putPage(db.storage, { slug, markdown_body: "Writer provenance" });
      const fact = claims[index]!;
      await addFact(db.storage, { entity_slug: slug, fact, written_by,
        written_by_principal: index % 2 ? "public" : "client:private-spoof", confidence: 0.9 });
      const pack = await buildContextPack(db.storage, { slugs: [slug], decay: false });
      expect(pack.cards[0]!.facts.map(f => f.fact)).toEqual([frameExternal(`[agent] ${fact}`)]);
      expect(JSON.stringify(pack)).not.toContain("private-spoof");
    }
    const pack = await buildContextPack(db.storage, { slugs: [], factsLimit: 20, decay: false });
    expect(pack.facts.filter(f => f.fact?.includes("Spoof claim")).map(f => f.fact).sort())
      .toEqual(claims.map(fact => frameExternal(`[agent] ${fact}`)).sort());
    expect(JSON.stringify(pack)).not.toContain("private-spoof");
  });
});
