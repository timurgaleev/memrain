import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../src/core/storage.ts";
import { PostgresEngine } from "../../src/core/engine/postgres.ts";

export function storageEngines(pgUrl: string | undefined) {
  return [
    {
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
    },
    ...(pgUrl ? [{
      name: "Postgres",
      open: async () => {
        const name = `integrity_${process.pid}_${Math.floor(Math.random() * 1e9)}`;
        const admin = new PostgresEngine({ url: pgUrl, max: 1 });
        try {
          await admin.exec(`CREATE DATABASE ${name}`);
        } finally {
          await admin.close();
        }
        const url = new URL(pgUrl);
        url.pathname = `/${name}`;
        const storage = new Storage(new PostgresEngine({ url: url.toString(), max: 2 }));
        await storage.init();
        return { storage, close: async () => {
          await storage.close();
          const cleanup = new PostgresEngine({ url: pgUrl, max: 1 });
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
