import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations, MigrationRetryExhausted } from "../src/core/migrate.ts";
import type { Engine } from "../src/core/engine/interface.ts";

describe("migration deadlock retry", () => {
  for (const exhausted of [false, true]) {
    it(`retries migration deadlocks without querying blockers (${exhausted ? "exhaustion" : "success"})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "memrain-deadlock-migration-"));
      writeFileSync(join(dir, "001_test.sql"), "SELECT 1;");
      const previous = process.env.MEMRAIN_MIGRATE_BACKOFF_MS;
      process.env.MEMRAIN_MIGRATE_BACKOFF_MS = "0";
      let attempts = 0;
      const queries: string[] = [];
      const engine = {
        kind: "postgres",
        async exec() {},
        async query(sql: string) { queries.push(sql); return { rows: [] }; },
        async transaction(fn: (tx: Engine) => Promise<unknown>) {
          attempts += 1;
          const result = await fn(engine as unknown as Engine);
          if (exhausted || attempts === 1) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
          return result;
        },
      };
      try {
        const run = runMigrations(engine as unknown as Engine, dir);
        if (exhausted) await expect(run).rejects.toBeInstanceOf(MigrationRetryExhausted);
        else expect((await run).applied).toHaveLength(1);
        expect(attempts).toBe(exhausted ? 3 : 2);
        expect(queries.some(sql => sql.includes("pg_stat_activity"))).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.MEMRAIN_MIGRATE_BACKOFF_MS;
        else process.env.MEMRAIN_MIGRATE_BACKOFF_MS = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
