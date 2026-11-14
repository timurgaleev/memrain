/**
 * Provider leases (migration 156): a cap on parallel calls to one provider
 * family, shared by every process on the database. Off unless
 * MEMRAIN_PROVIDER_LEASES names a limit, e.g. `bedrock:haiku=2,bedrock:sonnet=1`.
 *
 * A call holds one `provider_leases` row while it runs. Acquiring takes a
 * transaction-scoped advisory lock on the key (released at commit, so it
 * survives a transaction pooler), deletes rows past their expiry (a holder
 * that died), counts the rest and inserts only below the limit. A call that
 * finds no free slot waits a bounded time, then is refused unsent with
 * `ProviderLeaseBusy`; the job worker defers such a job without spending a
 * retry.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Engine } from "../engine/interface.ts";

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_POLL_MS = 250;
const MAX_LIMIT = 1000;

export class ProviderLeaseBusy extends Error {
  constructor(readonly key: string) {
    super(`provider_lease_busy: every ${key} slot is in use`);
    this.name = "ProviderLeaseBusy";
  }
}

export function isProviderLeaseBusy(e: unknown): e is ProviderLeaseBusy {
  return e instanceof ProviderLeaseBusy || (e instanceof Error && e.name === "ProviderLeaseBusy");
}

/** `key=limit` pairs; a malformed pair is skipped with a warning. */
export function parseLeaseLimits(raw: string | undefined, warn: (msg: string) => void = m => console.warn(`[leases] ${m}`)): Map<string, number> {
  const out = new Map<string, number>();
  for (const pair of (raw ?? "").split(",").map(s => s.trim()).filter(Boolean)) {
    const m = /^([a-z0-9][a-z0-9._-]*:[a-z0-9._-]+)=(\d+)$/.exec(pair);
    const limit = m ? Number(m[2]) : 0;
    if (!m || limit < 1 || limit > MAX_LIMIT) {
      warn(`ignoring MEMRAIN_PROVIDER_LEASES entry ${JSON.stringify(pair)} (expected provider:family=N, N 1-${MAX_LIMIT})`);
      continue;
    }
    out.set(m[1]!, limit);
  }
  return out;
}

/** `provider:family`, the family read from the model id (haiku, sonnet, embed, ...). */
export function leaseKeyForModel(provider: string, modelId: string): string {
  const id = modelId.toLowerCase();
  const family = ["haiku", "sonnet", "opus", "embed", "nova"].find(f => id.includes(f))
    ?? id.replace(/[^a-z0-9._-]/g, "").slice(0, 60);
  return `${provider}:${family}`;
}

export interface LeaseOwner {
  owner: string;
  ownerJob?: string | null;
  ttlMs?: number;
}

/** One slot under `key`, or null when all `limit` are held. */
export async function tryAcquireLease(engine: Engine, key: string, limit: number, who: LeaseOwner): Promise<string | null> {
  const id = randomUUID();
  return engine.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`memrain:lease:${key}`]);
    await tx.query(`DELETE FROM provider_leases WHERE lease_key = $1 AND expires_at <= NOW()`, [key]);
    const held = Number((await tx.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM provider_leases WHERE lease_key = $1`, [key])).rows[0]!.n);
    if (held >= limit) return null;
    await tx.query(
      `INSERT INTO provider_leases (id, lease_key, owner, owner_job, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + $5 * INTERVAL '1 millisecond')`,
      [id, key, who.owner, who.ownerJob ?? null, who.ttlMs ?? DEFAULT_TTL_MS],
    );
    return id;
  });
}

export async function releaseLease(engine: Engine, id: string): Promise<void> {
  await engine.query(`DELETE FROM provider_leases WHERE id = $1`, [id]);
}

function envMs(raw: string | undefined, fallback: number): number {
  const v = raw?.trim();
  return v && /^\d+$/.test(v) ? Number(v) : fallback;
}

export interface LeaseCallOptions {
  env?: NodeJS.ProcessEnv;
  waitMs?: number;
  pollMs?: number;
  ownerJob?: string | null;
}

const OWNER = `${hostname()}:${process.pid}`;

/**
 * Run `fn` holding a slot of the call's provider family, when a limit covers
 * it; otherwise run it directly without touching the database. A lease
 * bookkeeping error (not a full pool) lets the call through: the limiter
 * paces calls, it must not take a working provider path down with it.
 */
export async function withProviderLease<T>(
  engine: Engine | null,
  provider: string,
  model: string,
  fn: () => Promise<T>,
  opts: LeaseCallOptions = {},
): Promise<T> {
  const env = opts.env ?? process.env;
  if (!engine || !env.MEMRAIN_PROVIDER_LEASES) return fn();
  const key = leaseKeyForModel(provider, model);
  const limit = parseLeaseLimits(env.MEMRAIN_PROVIDER_LEASES).get(key);
  if (limit === undefined) return fn();
  const ttlMs = envMs(env.MEMRAIN_PROVIDER_LEASE_TTL_S, DEFAULT_TTL_MS / 1000) * 1000;
  const deadline = Date.now() + (opts.waitMs ?? envMs(env.MEMRAIN_PROVIDER_LEASE_WAIT_MS, DEFAULT_WAIT_MS));
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  let id: string | null = null;
  try {
    for (;;) {
      id = await tryAcquireLease(engine, key, limit, { owner: OWNER, ownerJob: opts.ownerJob ?? null, ttlMs });
      if (id || Date.now() >= deadline) break;
      await Bun.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  } catch (e) {
    console.warn(`[leases] ${key} lease bookkeeping failed, calling unleased: ${e instanceof Error ? e.message : String(e)}`);
    return fn();
  }
  if (!id) throw new ProviderLeaseBusy(key);
  try {
    return await fn();
  } finally {
    await releaseLease(engine, id).catch((e: unknown) =>
      console.warn(`[leases] release of ${key} failed (expires on its own): ${e instanceof Error ? e.message : String(e)}`));
  }
}
