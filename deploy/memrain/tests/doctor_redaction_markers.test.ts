import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { checkRedactionMarkers } from "../src/core/doctor-ops.ts";
import { addFact } from "../src/core/facts.ts";
import { addTimelineEvent } from "../src/core/timeline.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`redaction markers ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => { db = await engine.open(); });
  afterAll(async () => { await db.close(); });
  it("counts contaminated rows by table/source without rewriting or quoting them", async () => {
    expect((await checkRedactionMarkers(db.storage.engine())).status).toBe("ok");
    await registerSource(db.storage.engine(), { id: "marker-source", kind: "vault", pathPrefix: "/marker-source" });
    await putPage(db.storage, { slug: "notes/marker", markdown_body: "source", source_id: "marker-source" });
    const bad = "PRIVATE_BODY [redacted](RDS)";
    await addFact(db.storage, { entity_slug: "people/marker", fact: bad, source_id: "marker-source" });
    await addFact(db.storage, { entity_slug: "people/marker", fact: "Has [REDACTED:api-key:abc123]", source_id: "marker-source" });
    await addTimelineEvent(db.storage, { slug: "notes/marker", occurred_at: "2025-01-01", event: bad, source_id: "marker-source" });
    await db.storage.engine().query("INSERT INTO synth_atoms (atom_key, source_ref, source_kind, source_hash, title, body, model_id) VALUES ('marker-atom', 'notes/marker', 'page', 'h', 'Atom', $1, 'test')", [bad]);
    await db.storage.engine().query("INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, model_id) VALUES ('marker-take', 'notes/marker', 'h', '1', $1, 'test')", [bad]);
    const result = await checkRedactionMarkers(db.storage.engine());
    expect(result).toMatchObject({ ok: true, status: "warn" });
    expect(result.detail).toContain("4 row(s)");
    for (const table of ["entity_facts", "timeline_events", "synth_atoms", "synth_takes"]) expect(result.detail).toContain(`${table}/marker-source=1`);
    expect(result.detail).not.toContain("PRIVATE_BODY");
    expect(result.detail).toContain("superseding");
    expect((await db.storage.engine().query<{ fact: string }>("SELECT fact FROM entity_facts WHERE fact = $1", [bad])).rows).toEqual([{ fact: bad }]);
  });
});
