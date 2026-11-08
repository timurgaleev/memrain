import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { frameExternal } from "../src/core/trust-frame.ts";
import { putPage } from "../src/core/pages.ts";
import { addFact } from "../src/core/facts.ts";
import { buildContextPack } from "../src/core/context/context-pack.ts";

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
});
