/**
 * Connection budget inside one process.
 *
 * Long holders — the maintenance cycle, the embed backfill, the contextual
 * re-embed — can each keep a connection busy for minutes. With
 * MEMRAIN_PG_POOL_RESERVE=1 they share at most pool-max − 1 slots
 * (MEMRAIN_PG_POOL_MAX, default 10), so one connection always stays free for
 * /health, job claims and lock renewals. A long holder that starts another
 * inside itself does not take a second slot. MEMRAIN_SEARCH_MAX_CONCURRENT
 * bounds concurrent searches the same way. Both are off by default.
 *
 * MEMRAIN_PG_APPLICATION_NAME tags every connection in pg_stat_activity
 * (for example `memrain:<tenant>:serve`); unset, postgres-js's default stands.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { Semaphore } from "./concurrency.ts";
import { couldNotCheck } from "./doctor-categories.ts";
import type { Engine } from "./engine/interface.ts";
import type { TenancyCheck } from "./doctor-tenancy.ts";

const DEFAULT_POOL_MAX = 10;

function positiveInt(name: string): number | undefined {
  const raw = process.env[name]?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n > 0 ? n : undefined;
}

function reserveEnabled(): boolean {
  const v = process.env["MEMRAIN_PG_POOL_RESERVE"];
  return v === "1" || v === "true";
}

export function poolMax(): number {
  return positiveInt("MEMRAIN_PG_POOL_MAX") ?? DEFAULT_POOL_MAX;
}

/** Slots long holders may share: all but one connection, never fewer than one. */
export function longHoldSlots(max: number): number {
  return Math.max(1, max - 1);
}

interface Gate { width: number; sem: Semaphore; inside: AsyncLocalStorage<true> }

function gate(current: Gate | null, width: number): Gate {
  return current && current.width === width
    ? current
    : { width, sem: new Semaphore(width), inside: new AsyncLocalStorage<true>() };
}

async function through<T>(g: Gate, fn: () => Promise<T>): Promise<T> {
  if (g.inside.getStore()) return fn();
  const release = await g.sem.acquire();
  try {
    return await g.inside.run(true, fn);
  } finally {
    release();
  }
}

let longGate: Gate | null = null;
let searchGate: Gate | null = null;

/** Run a long-holding job inside the reserve budget (a pass-through while the reserve is off). */
export function withLongHold<T>(fn: () => Promise<T>): Promise<T> {
  if (!reserveEnabled()) return fn();
  longGate = gate(longGate, longHoldSlots(poolMax()));
  return through(longGate, fn);
}

/** Run one search inside MEMRAIN_SEARCH_MAX_CONCURRENT (a pass-through while unset). */
export function withSearchSlot<T>(fn: () => Promise<T>): Promise<T> {
  const width = positiveInt("MEMRAIN_SEARCH_MAX_CONCURRENT");
  if (width === undefined) return fn();
  searchGate = gate(searchGate, width);
  return through(searchGate, fn);
}

/** The configured application_name, restricted to `[A-Za-z0-9:._-]` and Postgres's 63 bytes. */
export function applicationName(): string | undefined {
  const raw = process.env["MEMRAIN_PG_APPLICATION_NAME"];
  if (raw === undefined) return undefined;
  const clean = raw.replace(/[^\w:.-]/g, "").slice(0, 63);
  return clean.length > 0 ? clean : undefined;
}

export interface ConnectionBudgetInput {
  maxConnections: number;
  reserved: number;
  /** Pool size of one process. */
  poolMax: number;
  /** Processes opening such a pool against this database (MEMRAIN_PG_POOL_PROCESSES, default 1). */
  processes: number;
  /** Connections open right now. */
  inUse: number;
}

const BUDGET_SHARE = 0.8;

export function connectionBudgetVerdict(i: ConnectionBudgetInput): { status: "ok" | "warn"; detail: string } {
  const usable = Math.max(0, i.maxConnections - i.reserved);
  const planned = i.poolMax * i.processes;
  const limit = Math.floor(usable * BUDGET_SHARE);
  const facts = `max_connections ${i.maxConnections} − ${i.reserved} reserved = ${usable} usable; ` +
    `planned ${planned} (pool ${i.poolMax} × ${i.processes} process(es)); ${i.inUse} open now`;
  if (planned > limit || i.inUse > limit) {
    return { status: "warn", detail: `${facts}. Over 80% of usable connections; lower MEMRAIN_PG_POOL_MAX or put a pooler in front.` };
  }
  return { status: "ok", detail: facts };
}

/** Doctor `db-connection-budget`: planned and open connections against the server's limit. */
export async function checkConnectionBudget(engine: Engine): Promise<TenancyCheck> {
  const name = "db-connection-budget";
  if (engine.kind !== "postgres") return { name, ok: true, status: "ok", detail: "not applicable to PGLite" };
  try {
    const r = await engine.query<{ max: string; reserved: string; in_use: number }>(
      `SELECT current_setting('max_connections') AS max,
              current_setting('superuser_reserved_connections') AS reserved,
              (SELECT count(*)::int FROM pg_stat_activity WHERE backend_type = 'client backend') AS in_use`,
    );
    const row = r.rows[0];
    const verdict = connectionBudgetVerdict({
      maxConnections: Number(row?.max ?? 0),
      reserved: Number(row?.reserved ?? 0),
      poolMax: poolMax(),
      processes: positiveInt("MEMRAIN_PG_POOL_PROCESSES") ?? 1,
      inUse: Number(row?.in_use ?? 0),
    });
    return { name, ok: true, status: verdict.status, detail: verdict.detail };
  } catch (e) {
    return couldNotCheck(name, e);
  }
}
