/**
 * Runtime config — the DB-plane knob store behind `memrain config` (migration
 * 088), an engine-config surface over memrain's env-shaped knobs.
 *
 * memrain knobs are MEMRAIN_* env vars read all over the codebase, so instead of
 * threading a config object through every resolver, the DB plane stores
 * env-shaped keys and {@link applyRuntimeEnvOverlay} projects them onto
 * `process.env` at engine-connect time (Storage.init) — ONLY for keys the real
 * environment did not set. Resolution order therefore stays:
 *
 *   per-call SearchOptions → real env → runtime_config row → code default
 *
 * Long-lived processes (serve) read the overlay once at boot; a `config set`
 * against a running server takes effect on the next restart, while every fresh
 * CLI invocation sees it immediately.
 *
 * Key alphabet is locked to ^(MEMRAIN|MEMEX)_[A-Z0-9_]{1,64}$ — the overlay
 * must never become an injection surface for PATH / LD_PRELOAD / NODE_OPTIONS.
 *
 * Both brand prefixes name the same knob. For knob X the effective value is,
 * highest first: env MEMRAIN_X, env MEMEX_X, row MEMRAIN_X, row MEMEX_X (only
 * when no MEMRAIN_X row exists), then the code default. No migration touches
 * the stored rows; the legacy ones are read as they are.
 */
import type { Engine } from "./engine/interface.ts";
import {
  BOOT_CODE_SWEEP_ENV,
  CYCLE_ENV,
  JOBS_WORKER_ENV,
  MAINTENANCE_ENV,
} from "./quiescence.ts";

export const RUNTIME_CONFIG_KEY_RE = /^(?:MEMRAIN|MEMEX)_[A-Z0-9_]{1,64}$/;

const BRAND_PREFIX_RE = /^(?:MEMRAIN|MEMEX)_/;

export function isRuntimeConfigKey(key: string): boolean {
  return RUNTIME_CONFIG_KEY_RE.test(key);
}

/** `MEMEX_X` or `MEMRAIN_X` → `MEMRAIN_X`; any other key is returned as-is. */
export function canonicalKey(key: string): string {
  return BRAND_PREFIX_RE.test(key) ? key.replace(BRAND_PREFIX_RE, "MEMRAIN_") : key;
}

/** `MEMEX_X` or `MEMRAIN_X` → `MEMEX_X`; any other key is returned as-is. */
export function legacyKey(key: string): string {
  return BRAND_PREFIX_RE.test(key) ? key.replace(BRAND_PREFIX_RE, "MEMEX_") : key;
}

/**
 * Knobs that only the real environment may set. A leftover DB row must never
 * stop background work or switch off the Postgres guard, so the overlay skips
 * these under either prefix.
 */
export const ENV_ONLY_KEYS: ReadonlySet<string> = new Set([
  MAINTENANCE_ENV,
  BOOT_CODE_SWEEP_ENV,
  JOBS_WORKER_ENV,
  CYCLE_ENV,
  "MEMRAIN_REQUIRE_POSTGRES",
  "MEMRAIN_EVENT_LOOP_WATCHDOG_MS",
  "MEMRAIN_CONNECTOR_KEK",
  "MEMRAIN_CONNECTOR_KEK_FILE",
]);

/**
 * Keys `setRuntimeConfig` refuses to store at all: the connector key seals
 * tokens kept in this same database, so a copy in runtime_config would let a
 * dump open them.
 */
export const NEVER_STORED_KEYS: ReadonlySet<string> = new Set([
  "MEMRAIN_CONNECTOR_KEK",
  "MEMRAIN_CONNECTOR_KEK_FILE",
]);

/**
 * Sensitive-key detector shared by every display surface so `show` and the
 * `set` confirmation can't drift. Word-segment
 * match: `MEMRAIN_PUBLIC_BEARER` and `FOO_TOKEN` hit, `MEMRAIN_MAX_TOKENS`-style
 * budget knobs deliberately do NOT (TOKENS ≠ TOKEN).
 */
export function isSensitiveConfigKey(key: string): boolean {
  return /(?:^|[._-])(?:key|secret|token|password|pwd|passwd|auth|bearer|credential)(?:[._-]|$)/i.test(
    key,
  );
}

export function redactConfigValue(key: string, value: string): string {
  if (/postgres(?:ql)?:\/\//i.test(value)) {
    return value.replace(/(postgres(?:ql)?:\/\/[^:@/]+:)([^@]+)(@)/gi, "$1***$3");
  }
  if (isSensitiveConfigKey(key)) return "***";
  return value;
}

export interface RuntimeConfigRow {
  key: string;
  value: string;
  updated_at: string;
}

export async function getRuntimeConfig(
  engine: Engine,
  key: string,
): Promise<string | null> {
  const r = await engine.query<{ value: string }>(
    `SELECT value FROM runtime_config WHERE key = $1`,
    [key],
  );
  return r.rows[0]?.value ?? null;
}

/**
 * Upsert one knob and return the key it was stored under. A knob key is stored
 * under its `MEMRAIN_` spelling whichever prefix it came with; a `MEMEX_` row
 * that already exists is left as it is and is shadowed from then on. A key
 * outside the knob alphabet (one written with `--force`) is stored as given.
 */
export async function setRuntimeConfig(
  engine: Engine,
  key: string,
  value: string,
): Promise<string> {
  const stored = isRuntimeConfigKey(key) ? canonicalKey(key) : key;
  if (NEVER_STORED_KEYS.has(canonicalKey(key))) {
    throw new Error(`${stored} protects data in this database; set it in the environment only`);
  }
  await engine.query(
    `INSERT INTO runtime_config (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [stored, value],
  );
  return stored;
}

/**
 * Delete one knob and return the keys removed. A knob key removes both
 * spellings in one statement, so a legacy row cannot come back through the
 * fallback after its new twin is gone. A key outside the knob alphabet (one
 * written with `--force`) is removed alone.
 */
export async function unsetRuntimeConfigKeys(
  engine: Engine,
  key: string,
): Promise<string[]> {
  const pair = isRuntimeConfigKey(key) ? [canonicalKey(key), legacyKey(key)] : [key, key];
  const r = await engine.query<{ key: string }>(
    `DELETE FROM runtime_config WHERE key IN ($1, $2) RETURNING key`,
    pair,
  );
  return r.rows.map((row) => row.key).sort();
}

/** Delete one knob (both spellings). Returns the number of rows removed. */
export async function unsetRuntimeConfig(
  engine: Engine,
  key: string,
): Promise<number> {
  return (await unsetRuntimeConfigKeys(engine, key)).length;
}

/** List rows, optionally filtered to a key prefix, key-ordered. */
export async function listRuntimeConfig(
  engine: Engine,
  prefix?: string,
): Promise<RuntimeConfigRow[]> {
  if (prefix !== undefined && prefix.length > 0) {
    // Escape LIKE metacharacters so a literal '_' in the prefix stays literal.
    const escaped = prefix.replace(/([\\%_])/g, "\\$1");
    const r = await engine.query<RuntimeConfigRow>(
      `SELECT key, value, updated_at::text AS updated_at
         FROM runtime_config WHERE key LIKE $1 ESCAPE '\\' ORDER BY key`,
      [escaped + "%"],
    );
    return r.rows;
  }
  const r = await engine.query<RuntimeConfigRow>(
    `SELECT key, value, updated_at::text AS updated_at
       FROM runtime_config ORDER BY key`,
  );
  return r.rows;
}

/**
 * The rows an `unset --pattern` removes. A pattern that starts with either
 * brand prefix matches the same suffix under both, so deleting the new rows
 * never re-activates shadowed legacy ones; any other pattern is a literal
 * key prefix.
 */
export async function listRuntimeConfigForPattern(
  engine: Engine,
  pattern: string,
): Promise<RuntimeConfigRow[]> {
  if (!BRAND_PREFIX_RE.test(pattern)) return listRuntimeConfig(engine, pattern);
  const rows = [
    ...(await listRuntimeConfig(engine, canonicalKey(pattern))),
    ...(await listRuntimeConfig(engine, legacyKey(pattern))),
  ];
  return rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Delete exactly the rows `listRuntimeConfigForPattern` lists and return their
 * keys. A brand pattern already lists both spellings; a literal pattern must
 * not take a twin it did not match.
 */
export async function unsetRuntimeConfigForPattern(
  engine: Engine,
  pattern: string,
): Promise<string[]> {
  const removed: string[] = [];
  for (const row of await listRuntimeConfigForPattern(engine, pattern)) {
    const r = await engine.query<{ key: string }>(
      `DELETE FROM runtime_config WHERE key = $1 RETURNING key`,
      [row.key],
    );
    removed.push(...r.rows.map((x) => x.key));
  }
  return removed.sort();
}

/**
 * Split stored keys into legacy-only rows (a `MEMEX_X` with no `MEMRAIN_X`,
 * still in effect through the fallback) and shadowed rows (a `MEMEX_X` that a
 * `MEMRAIN_X` row overrides).
 */
export function classifyLegacyRows(keys: readonly string[]): {
  legacyOnly: string[];
  shadowed: string[];
} {
  const present = new Set(keys);
  const legacyOnly: string[] = [];
  const shadowed: string[] = [];
  for (const key of [...keys].sort()) {
    if (!key.startsWith("MEMEX_") || !isRuntimeConfigKey(key)) continue;
    if (present.has(canonicalKey(key))) shadowed.push(key);
    else legacyOnly.push(key);
  }
  return { legacyOnly, shadowed };
}

export type RuntimeConfigSource = "env" | "runtime_config";

export interface ResolvedRuntimeConfig {
  value: string;
  source: RuntimeConfigSource;
  /** The env var or row key that supplied the value. */
  key: string;
}

/**
 * Resolve a brand-prefixed knob through the precedence above. `env` must be the
 * real environment; values the overlay itself projected are not env.
 */
export async function resolveRuntimeConfig(
  engine: Engine,
  key: string,
  env: Record<string, string | undefined>,
): Promise<ResolvedRuntimeConfig | null> {
  const canon = canonicalKey(key);
  const legacy = legacyKey(key);
  for (const name of [canon, legacy]) {
    const v = env[name];
    if (v !== undefined) return { value: v, source: "env", key: name };
  }
  for (const name of [canon, legacy]) {
    const v = await getRuntimeConfig(engine, name);
    if (v !== null) return { value: v, source: "runtime_config", key: name };
  }
  return null;
}

// Env values the overlay wrote, so a later reader can tell them from real env.
const projected = new Map<string, string>();

/** Whether `process.env[name]` currently holds a value the overlay projected. */
export function isOverlayProjected(name: string): boolean {
  return projected.has(name) && process.env[name] === projected.get(name);
}

/**
 * Project stored knobs onto `process.env` — only where the real environment
 * left the knob unset under both names, so a container-level env always wins.
 * A `MEMRAIN_X` row beats a `MEMEX_X` row. The value is written under
 * `MEMRAIN_X` and also under `MEMEX_X`, for any reader that still uses the
 * legacy name. Returns the row keys applied. Fail-open (missing table mid-migration,
 * transient DB error → no overlay): DB config is an overlay, never a boot
 * dependency. Kill switch: MEMRAIN_NO_DB_CONFIG=1 or MEMEX_NO_DB_CONFIG=1
 * skips entirely.
 */
type OverlayState = "not_loaded" | "disabled" | "missing" | "ready" | "unavailable";
const overlayStates = new WeakMap<Engine, OverlayState>();

export function runtimeOverlayState(engine: Engine): OverlayState {
  return overlayStates.get(engine) ?? "not_loaded";
}

export async function applyRuntimeEnvOverlay(engine: Engine): Promise<string[]> {
  if (process.env["MEMRAIN_NO_DB_CONFIG"] === "1" || process.env["MEMEX_NO_DB_CONFIG"] === "1") {
    overlayStates.set(engine, "disabled");
    return [];
  }
  try {
    const rows = [
      ...(await listRuntimeConfig(engine, "MEMRAIN_")),
      ...(await listRuntimeConfig(engine, "MEMEX_")),
    ];
    // Rows arrive MEMRAIN_ first, so the first row per knob is the winner.
    const winners = new Map<string, RuntimeConfigRow>();
    for (const row of rows) {
      if (!isRuntimeConfigKey(row.key)) continue;
      const canon = canonicalKey(row.key);
      if (!winners.has(canon)) winners.set(canon, row);
    }
    const applied: string[] = [];
    for (const [canon, row] of [...winners].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const legacy = legacyKey(canon);
      const cur = process.env[canon];
      const old = process.env[legacy];
      // A real env value under either name wins.
      if (cur !== undefined && !isOverlayProjected(canon)) continue;
      if (old !== undefined && !isOverlayProjected(legacy)) continue;
      // Already projected by an earlier overlay in this process and left intact.
      // When a caller removed one name of the pair, both are projected again.
      if (cur !== undefined && old !== undefined) continue;
      if (ENV_ONLY_KEYS.has(canon)) {
        console.error(`[memrain] runtime_config ${row.key} ignored: env-only knob`);
        continue;
      }
      process.env[canon] = row.value;
      process.env[legacy] = row.value;
      projected.set(canon, row.value);
      projected.set(legacy, row.value);
      applied.push(row.key);
    }
    overlayStates.set(engine, "ready");
    return applied;
  } catch (e) {
    const raw = e && typeof e === "object" && "code" in e ? String(e.code) : "";
    const code = /^[0-9A-Z]{5}$/.test(raw) ? raw : "unknown";
    overlayStates.set(engine, code === "42P01" ? "missing" : "unavailable");
    if (code !== "42P01") console.error(`[memrain] runtime_config overlay unavailable (SQLSTATE ${code}); continuing with environment/defaults`);
    return [];
  }
}
