import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { addFact } from "../src/core/facts.ts";
import { forgetFact } from "../src/core/facts-recall.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { registerSource } from "../src/core/sources.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`withdrawn detail ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  const auth: AuthInfo = { token: "test", clientId: "withdrawals", sourceId: "withdraw-a", allowedSources: ["withdraw-a"], scopes: ["read", "write"], isPublic: false };
  const call = async (args: Record<string, unknown>, remote = true) => {
    const r = await dispatchTool(db.storage, { name: "add_fact", arguments: args }, remote ? { authInfo: auth } : {});
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.content[0]!.text);
  };
  beforeAll(async () => {
    db = await engine.open();
    await registerSource(db.storage.engine(), { id: "withdraw-a", kind: "vault", pathPrefix: "/withdraw-a" });
    for (const source_id of ["default", "withdraw-a"]) for (const visibility of ["world", "private"]) {
      const r = await addFact(db.storage, { entity_slug: "people/withdrawn", fact: "No longer holds", source_id, visibility });
      await forgetFact(db.storage, r.id!, { reason: "PRIVATE_REASON_CANARY" });
    }
  });
  afterAll(async () => { await db.close(); });
  it("explains visible withdrawals in single and batch results without returning reasons", async () => {
    const args = { entity_slug: "people/withdrawn", fact: "NO longer   holds", visibility: "world" };
    const single = await call(args);
    expect(single).toMatchObject({ id: null, withdrawn: true, withdrawn_detail: { source_id: "withdraw-a", visibility: "world", entity_slug: "people/withdrawn", scope: "normalized_claim" } });
    expect(Number.isNaN(Date.parse(single.withdrawn_detail.withdrawn_at))).toBe(false);
    expect(JSON.stringify(single)).not.toContain("PRIVATE_REASON_CANARY");
    const batch = await call({ entity_slug: args.entity_slug, visibility: "world", items: [{ fact: args.fact }] });
    expect(batch.items[0].withdrawn_detail).toEqual(single.withdrawn_detail);
  });
  it("withholds private withdrawal metadata from tenants but keeps the operator audit", async () => {
    const args = { entity_slug: "people/withdrawn", fact: "No longer holds", visibility: "private" };
    const remote = await call(args);
    expect(remote.withdrawn).toBe(true);
    expect(remote.withdrawn_detail).toBeUndefined();
    expect((await call(args, false)).withdrawn_detail).toMatchObject({ source_id: "default", visibility: "private" });
  });
});
