/**
 * Migrations and DDL never go through a transaction-mode pooler. A pooled
 * engine (MEMRAIN_PG_POOLER) opens a short-lived engine on
 * MEMRAIN_POSTGRES_DIRECT_URL for them; without that URL the work is refused
 * with `pooler_migration_refused` before the first statement is sent.
 */
import type { Engine } from "./interface.ts";

export class PoolerMigrationRefusedError extends Error {
  readonly code = "pooler_migration_refused";
}

export function poolerMigrationRefused(): PoolerMigrationRefusedError {
  return new PoolerMigrationRefusedError(
    "pooler_migration_refused: migrations and DDL do not run through a transaction pooler; " +
      "set MEMRAIN_POSTGRES_DIRECT_URL to the database itself",
  );
}

/**
 * The engine migrations and DDL use: `engine` itself unless it is pooled, else
 * a new direct engine the caller must close. Sends no SQL.
 */
export function directEngineFor(engine: Engine): { engine: Engine; close: () => Promise<void> } {
  if (!engine.pooler) return { engine, close: async () => {} };
  if (!engine.openDirect) throw poolerMigrationRefused();
  const direct = engine.openDirect();
  return { engine: direct, close: () => direct.close() };
}

/** Run `fn` on the engine migrations and DDL use (see directEngineFor). */
export async function withDirectEngine<T>(engine: Engine, fn: (direct: Engine) => Promise<T>): Promise<T> {
  const d = directEngineFor(engine);
  try {
    return await fn(d.engine);
  } finally {
    await d.close();
  }
}
