import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { putPage } from "../src/core/pages.ts";
import { resolveEntitiesToPointers } from "../src/core/context/reflex.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`entity pointer preference (${name})`, () => {
    let db: Awaited<ReturnType<typeof open>>;
    beforeAll(async () => {
      db = await open();
      await db.storage.engine().query("INSERT INTO sources (id, kind, path_prefix) VALUES ('team', 'other', 'team://') ON CONFLICT DO NOTHING");
      for (const page of [
        { slug: "meetings/alice", title: "Alice Example", type: "meeting" },
        { slug: "people/alice-example", title: "Alice", type: "person" },
        { slug: "people/team-alice", title: "Alice Example", type: "person", source_id: "team" },
      ]) await putPage(db.storage, { ...page, markdown_body: "Description." });
    });
    afterAll(async () => { await db.close(); });

    it("prefers a person suffix over a meeting title and keeps one match per source", async () => {
      const rows = await resolveEntitiesToPointers(db.storage, [{ query: "Alice Example", display: "Alice Example" }]);
      expect(rows.map(r => [r.slug, r.source_id])).toEqual([
        ["people/alice-example", "default"], ["people/team-alice", "team"],
      ]);
      const scoped = await resolveEntitiesToPointers(db.storage, [{ query: "Alice Example", display: "Alice Example" }], { sourceIds: ["team"] });
      expect(scoped.map(r => r.slug)).toEqual(["people/team-alice"]);
    });

    it("prefers the exact slug over typed pages with the same name", async () => {
      await putPage(db.storage, { slug: "alice-example", title: "Reference", markdown_body: "Exact reference." });
      const rows = await resolveEntitiesToPointers(db.storage, [{ query: "Alice Example", display: "Alice Example" }], { sourceIds: ["default"] });
      expect(rows.map(r => r.slug)).toEqual(["alice-example"]);
    });
  });
}
