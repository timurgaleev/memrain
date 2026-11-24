/**
 * The operational figures behind the admin Health page that the corpus stats
 * do not carry: schema state, the last housekeeping run, today's brain-wide
 * spend against its cap, and what waits for the operator in the write-gate and
 * quarantine queues. Read-only; the queues themselves are worked from the CLI
 * (`memrain write-gate`, `memrain quarantine`), so this reports counts only.
 */
import type { Engine } from "./engine/interface.ts";
import { diffMigrationIds, discoverMigrations } from "./migrate.ts";
import { lastHousekeepingRun } from "./housekeeping.ts";
import { brainDailyCapUsd, brainDaySpendUsd } from "./budget.ts";

export interface AdminHealthReport {
  migrations: {
    /** Highest applied migration id, 0 on an empty schema. */
    head: number;
    applied: number;
    /** False when this build could not read its own migration files. */
    files_readable: boolean;
    pending: number[];
    ahead: number[];
    gaps: number[];
  };
  housekeeping: { finished_at: string; errors: number } | null;
  spend_today: { usd: number; cap_usd: number | null };
  review: {
    /** Write-gate holds awaiting approve or reject. */
    write_gate_holds: number;
    /** Gated rows still held. */
    row_holds: number;
    /** Documents hidden from search by the quarantine marker. */
    quarantined: number;
  };
}

async function migrationState(engine: Engine): Promise<AdminHealthReport["migrations"]> {
  const r = await engine.query<{ id: number }>(`SELECT id::int AS id FROM migrations ORDER BY id`);
  const applied = r.rows.map((row) => Number(row.id));
  const head = applied.length > 0 ? Math.max(...applied) : 0;
  let available: number[] | null = null;
  try {
    available = discoverMigrations().map((m) => m.id);
  } catch {
    // A build packaged without its migration files reports what is applied.
  }
  const drift = available === null ? { pending: [], ahead: [], gaps: [] } : diffMigrationIds(applied, available);
  return { head, applied: applied.length, files_readable: available !== null, ...drift };
}

async function reviewCounts(engine: Engine): Promise<AdminHealthReport["review"]> {
  // scope: operator-only the admin session is the operator; only queue sizes leave here
  const r = await engine.query<{ holds: number | string; rows: number | string; quarantined: number | string }>(
    `SELECT
       (SELECT count(*) FROM write_gate_holds WHERE decision IS NULL)::int AS holds,
       (SELECT count(*) FROM write_gate_row_holds WHERE status = 'held')::int AS rows,
       (SELECT count(*) FROM documents WHERE frontmatter ? 'quarantine')::int AS quarantined`,
  );
  const row = r.rows[0];
  return {
    write_gate_holds: Number(row?.holds ?? 0),
    row_holds: Number(row?.rows ?? 0),
    quarantined: Number(row?.quarantined ?? 0),
  };
}

export async function adminHealthReport(engine: Engine, now: Date = new Date()): Promise<AdminHealthReport> {
  const last = await lastHousekeepingRun(engine);
  return {
    migrations: await migrationState(engine),
    housekeeping: last === null ? null : { finished_at: last.finishedAt, errors: last.errors },
    spend_today: { usd: await brainDaySpendUsd(engine, now), cap_usd: brainDailyCapUsd() },
    review: await reviewCounts(engine),
  };
}
