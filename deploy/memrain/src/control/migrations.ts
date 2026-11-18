/**
 * The control database's own migration set (`core/migrations-control/`), with
 * its own numbering from 001. Same runner as a brain's migrations; only the
 * directories differ.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Engine } from "../core/engine/interface.ts";
import { revertMigration, runMigrations, type MigrationResult } from "../core/migrate.ts";

const here = dirname(fileURLToPath(import.meta.url));

export const CONTROL_MIGRATIONS_DIR = resolve(here, "../core/migrations-control");
export const CONTROL_DOWN_DIR = resolve(here, "../core/migrations-control-down");

export function migrateControl(engine: Engine): Promise<MigrationResult> {
  return runMigrations(engine, CONTROL_MIGRATIONS_DIR);
}

export function revertControl(engine: Engine, id: number): Promise<{ id: number; name: string }> {
  return revertMigration(engine, id, CONTROL_DOWN_DIR);
}
