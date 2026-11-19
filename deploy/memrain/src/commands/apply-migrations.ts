/**
 * `memrain apply-migrations` — manual runner for pending migrations.
 *
 * Storage init already runs migrations on every boot, so this command
 * is mostly an ops/diagnostic tool: confirm the schema matches the
 * shipped migration set without restarting the daemon, or apply a
 * just-pulled migration without bouncing the container.
 *
 * `--down <id> --yes` reverts the latest migration with its down file
 * (`core/migrations-down/`). It is the database half of a rollback inside an
 * upgrade window, run with every app process stopped: it opens the database
 * without migrating it and without the config overlay, so it writes nothing but
 * the down itself.
 */
import { Storage } from "../core/storage.ts";
import { withStorage, closeQuietly } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { runMigrations, discoverMigrations, revertMigration } from "../core/migrate.ts";
import { withDirectEngine } from "../core/engine/direct.ts";

export interface ApplyMigrationsCmdOptions {
  /** Print the migration set without applying. Default false. */
  dryRun?: boolean;
  /** Revert this migration, which must be the latest applied one. */
  down?: number;
  /** Required with `down`. */
  yes?: boolean;
  /** Injection seam for tests; the caller owns its lifecycle. */
  storage?: Storage;
}

export async function runApplyMigrations(
  opts: ApplyMigrationsCmdOptions = {},
): Promise<void> {
  if (opts.dryRun) {
    const files = discoverMigrations();
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "dry-run",
          migrations: files.map((f) => ({ id: f.id, name: f.name })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (opts.down !== undefined) {
    if (!Number.isInteger(opts.down) || opts.down <= 0) {
      throw new Error(`apply-migrations: --down needs a migration id, got ${opts.down}`);
    }
    if (!opts.yes) {
      throw new Error(
        `apply-migrations: --down ${opts.down} reverts a migration; stop every app process, then add --yes`,
      );
    }
    const storage = opts.storage ?? new Storage(loadConfig());
    try {
      const reverted = await withDirectEngine(storage.engine(), async (engine) => {
        await engine.ready();
        return revertMigration(engine, opts.down!);
      });
      console.log(JSON.stringify({ ok: true, mode: "down", reverted }, null, 2));
    } finally {
      if (!opts.storage) await closeQuietly(storage);
    }
    return;
  }

  const config = loadConfig();
  const storage = new Storage(config);
  return withStorage(storage, async () => {
    const r = await withDirectEngine(storage.engine(), (engine) => runMigrations(engine));
    console.log(JSON.stringify({ ok: true, ...r }, null, 2));
  });
}
