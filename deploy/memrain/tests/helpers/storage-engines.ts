import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../src/core/storage.ts";
import { pgTestEngine } from "./pg-test-engine.ts";

// scripts/test-pg.sh migrates one database up front and names it here, so a
// test's database starts as a copy instead of running every migration again.
const PG_TEMPLATE = process.env["MEMRAIN_TEST_POSTGRES_TEMPLATE_DB"];
if (PG_TEMPLATE !== undefined && !/^[a-z_][a-z0-9_]*$/.test(PG_TEMPLATE)) {
  throw new Error(`MEMRAIN_TEST_POSTGRES_TEMPLATE_DB is not a plain database name: ${PG_TEMPLATE}`);
}
// The Postgres run sets this: the Bun sharded job already runs every PGLite
// half (it runs the same files with no Postgres URL), so running them again
// here only doubled the job.
const POSTGRES_ONLY = process.env["MEMRAIN_TEST_POSTGRES_ONLY"] === "1";

export function storageEngines(pgUrl: string | undefined) {
  return [
    ...(pgUrl && POSTGRES_ONLY ? [] : [{
      name: "PGLite",
      open: async () => {
        const tmp = mkdtempSync(join(tmpdir(), "memrain-integrity-"));
        const storage = new Storage({ dbPath: join(tmp, "db") });
        await storage.init();
        return { storage, close: async () => {
          await storage.close();
          rmSync(tmp, { recursive: true, force: true });
        } };
      },
    }]),
    ...(pgUrl ? [{
      name: "Postgres",
      open: async () => {
        const name = `integrity_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
        const admin = pgTestEngine({ url: pgUrl, max: 1 });
        try {
          await admin.exec(PG_TEMPLATE ? `CREATE DATABASE ${name} TEMPLATE ${PG_TEMPLATE}` : `CREATE DATABASE ${name}`);
        } finally {
          await admin.close();
        }
        const url = new URL(pgUrl);
        url.pathname = `/${name}`;
        const storage = new Storage(pgTestEngine({ url: url.toString(), max: 2 }));
        await storage.init();
        return { storage, close: async () => {
          await storage.close();
          const cleanup = pgTestEngine({ url: pgUrl, max: 1 });
          try {
            await cleanup.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
          } finally {
            await cleanup.close();
          }
        } };
      },
    }] : []),
  ];
}
