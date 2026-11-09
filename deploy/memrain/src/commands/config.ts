/**
 * `memrain config <show|get|set|unset>` — DB-plane runtime config (migration
 * 088). Mutates MEMRAIN_* knobs without a redeploy: rows overlay onto
 * process.env at every Storage.init for vars the container did not set (env
 * always wins). The write substrate behind `memrain search tune --apply`.
 *
 *   show                       list all stored keys (values redacted)
 *   get <key>                  print the effective value (exit 1 when missing);
 *                              stderr names the env var or row it came from
 *   set <key> <value> [--force]
 *                              upsert a known typed key; --force permits custom keys;
 *                              a MEMEX_ key is stored as MEMRAIN_
 *   unset <key>                delete one knob (MEMRAIN_X and MEMEX_X alike)
 *   unset --pattern <prefix>   delete every key with this prefix; a
 *                              MEMRAIN_/MEMEX_ prefix covers both spellings
 */
import { validateConfigValue, CONFIG_KEY_TYPES } from "../core/runtime-config-schema.ts";
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { legacyEnv } from "../core/env-compat.ts";
import {
  canonicalKey,
  ENV_ONLY_KEYS,
  getRuntimeConfig,
  isOverlayProjected,
  legacyKey,
  setRuntimeConfig,
  unsetRuntimeConfigKeys,
  listRuntimeConfig,
  unsetRuntimeConfigForPattern,
  isRuntimeConfigKey,
  redactConfigValue,
  resolveRuntimeConfig,
} from "../core/runtime-config.ts";

export type ConfigSub = "show" | "get" | "set" | "unset";

export interface ConfigCmdOptions {
  sub: ConfigSub;
  key?: string;
  value?: string;
  /** `unset --pattern <prefix>` bulk delete. */
  pattern?: string;
  /** Allow an unknown key on `set`; known values remain type-checked. */
  force?: boolean;
  /** Test seam — config file path (same idiom as runCall). */
  configPath?: string;
}

export async function runConfig(opts: ConfigCmdOptions): Promise<number> {
  const validated = opts.sub === "set" && opts.key && opts.value !== undefined
    ? validateConfigValue(opts.key, opts.value, opts.force) : undefined;
  if (validated && !validated.ok) {
    console.error(`memrain config: ${validated.error}`);
    return 2;
  }
  const storage = new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const engine = storage.engine();
    switch (opts.sub) {
      case "show": {
        const rows = await listRuntimeConfig(engine);
        console.log(
          JSON.stringify(
            {
              ok: true,
              count: rows.length,
              entries: rows.map((r) => ({
                key: r.key,
                value: redactConfigValue(r.key, r.value),
                updated_at: r.updated_at,
              })),
              note: "container env always wins over these; serve picks changes up on restart",
            },
            null,
            2,
          ),
        );
        return 0;
      }
      case "get": {
        if (!opts.key) {
          console.error("memrain config get: <key> is required");
          return 1;
        }
        if (!isRuntimeConfigKey(opts.key)) {
          const v = await getRuntimeConfig(engine, opts.key);
          if (v === null) {
            console.error(`memrain config: key not found: ${opts.key}`);
            return 1;
          }
          console.log(v);
          return 0;
        }
        const resolved = await resolveRuntimeConfig(engine, opts.key, realEnv(opts.key));
        if (resolved === null) {
          console.error(`memrain config: key not found: ${opts.key}`);
          return 1;
        }
        console.log(resolved.value);
        console.error(`memrain config: ${canonicalKey(opts.key)} from ${resolved.source} ${resolved.key}`);
        return 0;
      }
      case "set": {
        if (!opts.key || opts.value === undefined) {
          console.error("memrain config set: <key> <value> are required");
          return 1;
        }
        const value = validated?.ok ? validated.value : opts.value;
        const stored = await setRuntimeConfig(engine, opts.key, value);
        if (stored !== opts.key) {
          console.error(`memrain config: ${opts.key} is the pre-rename spelling; stored as ${stored}`);
        }
        if (!Object.hasOwn(CONFIG_KEY_TYPES, stored)) {
          console.error(`memrain config: WARN — custom key '${stored}' stored with --force` +
            (!isRuntimeConfigKey(stored) ? "; outside the knob alphabet, so it is not overlaid" : ""));
        }
        const env = realEnv(stored);
        const overriding = [stored, legacyKey(stored)].find(name => env[name] !== undefined);
        if (overriding) console.error(`memrain config: WARN — environment ${overriding} overrides this stored value`);
        if (ENV_ONLY_KEYS.has(stored)) console.error("memrain config: WARN — this knob is environment-only; the stored row is ignored");
        console.error("memrain config: serve reads stored settings on restart; actual environment values still take precedence");
        console.log(`Set ${stored} = ${redactConfigValue(stored, value)}`);
        return 0;
      }
      case "unset": {
        if (opts.pattern !== undefined) {
          if (opts.pattern.length === 0) {
            console.error("memrain config unset: --pattern needs a non-empty prefix");
            return 1;
          }
          const keys = await unsetRuntimeConfigForPattern(engine, opts.pattern);
          console.log(
            JSON.stringify(
              { ok: true, deleted: keys.length, keys: keys.sort() },
              null,
              2,
            ),
          );
          return 0;
        }
        if (!opts.key) {
          console.error("memrain config unset: <key> or --pattern <prefix> is required");
          return 1;
        }
        const removed = await unsetRuntimeConfigKeys(engine, opts.key);
        if (removed.length === 0) {
          console.error(`memrain config: key not found: ${opts.key}`);
          return 1;
        }
        console.log(`Unset ${removed.join(", ")}`);
        return 0;
      }
      default: {
        const _exhaustive: never = opts.sub;
        throw new Error(`memrain config: unknown subcommand '${_exhaustive}'`);
      }
    }
  });
}

/**
 * The real environment for one knob: values the overlay projected at
 * Storage.init are not env, and a `MEMRAIN_X` the startup shim copied from
 * `MEMEX_X` is reported under the legacy name that actually set it.
 */
function realEnv(key: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of [canonicalKey(key), legacyKey(key)]) {
    if (!isOverlayProjected(name)) env[name] = process.env[name];
  }
  const canon = canonicalKey(key);
  if (legacyEnv.mapped.includes(canon) && env[legacyKey(key)] !== undefined) {
    env[canon] = undefined;
  }
  return env;
}
