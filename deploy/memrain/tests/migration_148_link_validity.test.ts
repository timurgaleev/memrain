import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { revertMigration, runMigrations } from "../src/core/migrate.ts";
import { putPage } from "../src/core/pages.ts";
import { addLink } from "../src/core/links.ts";
import { PostgresEngine } from "../src/core/engine/postgres.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`migration 148 (${name})`, () => {
  if (name === "Postgres") it("retains validity committed by a writer while rollback waits for its table lock", async () => {
    const db = await open();
    const e = db.storage.engine();
    const url = new URL(process.env.MEMRAIN_TEST_POSTGRES_URL!);
    url.pathname = `/${(await e.query<{ name: string }>("SELECT current_database() AS name")).rows[0]!.name}`;
    const observer = new PostgresEngine({ url: url.toString(), max: 1 });
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let writer: Promise<void> | undefined;
    let rollback: Promise<unknown> | undefined;
    try {
      await putPage(db.storage, { slug: "notes/validity-race", markdown_body: "Preserved fixture." });
      await addLink(db.storage, { source_slug: "notes/validity-race", target_slug: "notes/target", type: "related_to" });
      writer = e.transaction(async tx => {
        await tx.exec("UPDATE links SET valid_from='2026-11-01'");
        ready.resolve();
        await release.promise;
      });
      await ready.promise;
      rollback = revertMigration(e, 148).then(() => null, error => error);
      let waiting = false;
      for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
        waiting = (await observer.query<{ waiting: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND relation='links'::regclass AND mode='AccessExclusiveLock' AND NOT granted) AS waiting")).rows[0]!.waiting;
        if (!waiting) await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      release.resolve();
      await writer;
      const outcome = await rollback;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("populated");
      expect((await e.query("SELECT valid_from::text AS valid_from FROM links")).rows).toEqual([{ valid_from: "2026-11-01" }]);
    } finally {
      release.resolve();
      await writer;
      await rollback;
      await observer.close();
      await db.close();
    }
  });
  it("adds only nullable validity metadata and refuses a lossy down migration", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const columns = await e.query("SELECT column_name,is_nullable,data_type FROM information_schema.columns WHERE table_name='links' AND column_name IN ('valid_from','valid_until') ORDER BY column_name");
      expect(columns.rows).toEqual([{ column_name: "valid_from", is_nullable: "YES", data_type: "date" }, { column_name: "valid_until", is_nullable: "YES", data_type: "date" }]);
      await putPage(db.storage, { slug: "notes/migration148", markdown_body: "Preserved body." });
      await addLink(db.storage, { source_slug: "notes/migration148", target_slug: "notes/target", type: "related_to" });
      const before = (await e.query("SELECT to_jsonb(l)-'valid_from'-'valid_until' AS row FROM links l ORDER BY id")).rows;
      await revertMigration(e, 148);
      expect((await e.query("SELECT to_jsonb(l) AS row FROM links l ORDER BY id")).rows).toEqual(before);
      await runMigrations(e);
      expect((await e.query("SELECT to_jsonb(l)-'valid_from'-'valid_until' AS row FROM links l ORDER BY id")).rows).toEqual(before);
      await e.exec("UPDATE links SET valid_from='2026-11-01'");
      await expect(revertMigration(e, 148)).rejects.toThrow("populated");
      expect((await e.query("SELECT valid_from::text AS valid_from FROM links")).rows).toEqual([{ valid_from: "2026-11-01" }]);
    } finally { await db.close(); }
  });
});
