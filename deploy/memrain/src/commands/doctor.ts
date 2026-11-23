/**
 * `memrain doctor` — self-diagnostics. Prints a structured report and
 * exits 0 on healthy / 1 on any failure. Intended to run in seconds —
 * no embedding calls or full sweeps. Suitable for cron probes and CI
 * smoke tests.
 *
 * Checks: config present and parsing, the engine opening, the engine checks
 * `run_doctor` shares (core/lite-doctor.ts), legacy names and directories, and
 * the vault path when one is configured.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { inspectDataDir, describeDataDir } from "../core/engine/pglite-diagnose.ts";
import { Storage } from "../core/storage.ts";
import {
  loadConfig,
  defaultConfigPath,
  selfIssuedMismatch,
  LEGACY_YAML_NAME,
  YAML_NAME,
} from "../core/config.ts";
import type { Config, DatabaseConfig } from "../core/config.ts";
import { couldNotCheck, worstStatus, type CheckVerdict } from "../core/doctor-categories.ts";
import { liteEngineChecks } from "../core/lite-doctor.ts";
import { VERSION } from "../version.ts";
import { legacyEnv, type LegacyEnvReport } from "../core/env-compat.ts";
import { classifyLegacyRows, listRuntimeConfig } from "../core/runtime-config.ts";

/**
 * Detail line for the engine check.
 *
 * Exported and pure because the bug it fixes is invisible from the pglite side:
 * `path` exists only on the pglite variant, so reading it straight off the
 * `DatabaseConfig` union rendered `undefined` on every postgres brain — which
 * is what production runs — and the one check whose job is naming the engine
 * said nothing about it. A test driving `runDoctor` cannot catch that without a
 * live postgres, so the branch lives here where both variants are one call away.
 */
export function engineCheckDetail(db: DatabaseConfig): string {
  return db.type === "pglite" ? db.path : `engine=${db.type}`;
}

/** A check as rendered. */
type Check = CheckVerdict;

/**
 * A check that RAN to completion: a pass, or a real failure the exit code
 * gates on. The two fields are derived from one boolean here so they can never
 * drift apart — the honest three-state cases (`warn`) are written out
 * explicitly instead.
 */
function verdict(name: string, ok: boolean, detail: string): Check {
  return { name, ok, status: ok ? "ok" : "fail", detail };
}

/**
 * Legacy `MEMEX_*` env names the startup shim mapped onto `MEMRAIN_*`. A name
 * set identically under both spellings is not counted. Names only, never values.
 */
export function legacyEnvCheck(report: LegacyEnvReport): Check {
  if (report.mapped.length === 0) {
    return { name: "legacy-env-names", ok: true, status: "ok", detail: "no legacy MEMEX_* env names in use" };
  }
  const names = report.mapped.map((n) => n.replace(/^MEMRAIN_/, "MEMEX_"));
  return {
    name: "legacy-env-names",
    ok: true,
    status: "warn",
    detail: `${names.length} legacy env name(s) in use; rename to MEMRAIN_* before 1.1.0: ${names.join(", ")}`,
  };
}

/**
 * `~/.memex` next to a separate `~/.memrain`. One directory reached through
 * both paths (same device and inode) is not a split.
 */
export function legacyConfigDirCheck(home: string): Check {
  const legacy = join(home, ".memex");
  const current = join(home, ".memrain");
  let split = false;
  if (existsSync(legacy) && existsSync(current)) {
    const a = statSync(legacy);
    const b = statSync(current);
    split = a.dev !== b.dev || a.ino !== b.ino;
  }
  return split
    ? {
        name: "legacy-config-dir",
        ok: true,
        status: "warn",
        detail: `${legacy} exists beside ${current}; keep one config directory`,
      }
    : { name: "legacy-config-dir", ok: true, status: "ok", detail: "no legacy config directory beside the new one" };
}

/** Both overlay files beside config.json: the new one is read, the legacy one is ignored. */
export function configYamlCheck(configPath: string): Check {
  const dir = dirname(configPath);
  const current = join(dir, YAML_NAME);
  const legacy = join(dir, LEGACY_YAML_NAME);
  return existsSync(current) && existsSync(legacy)
    ? {
        name: "config-yml",
        ok: true,
        status: "warn",
        detail: `${current} and ${legacy} both exist; only ${YAML_NAME} is read, fold ${LEGACY_YAML_NAME} into it`,
      }
    : { name: "config-yml", ok: true, status: "ok", detail: "one overlay file at most" };
}

/** OAuth clients registered while the self-issued provider is off: a recreated config.json. */
export function oauthSelfIssuedCheck(config: Config, liveOauthClients: number): Check {
  const mismatch = selfIssuedMismatch(config, liveOauthClients);
  return mismatch
    ? verdict("oauth-self-issued-config", false, mismatch)
    : verdict(
        "oauth-self-issued-config",
        true,
        `self-issued OAuth ${config.auth?.selfIssued?.enabled === true ? "on" : "off"}; ${liveOauthClients} live client(s)`,
      );
}

export interface DoctorOptions {
  /** Override the config path. Tests use this to point at a temp dir
   *  (Bun's `os.homedir()` caches at process start, so HOME env tricks
   *  don't work). Defaults to `~/.memrain/config.json`. */
  configPath?: string;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<void> {
  const checks: Check[] = [];
  let config: ReturnType<typeof loadConfig> | null = null;

  // 1. config file
  const cfgPath = opts.configPath ?? defaultConfigPath();
  if (!existsSync(cfgPath)) {
    checks.push(verdict("config", false, `missing at ${cfgPath} — run 'memrain init --pglite'`));
  } else {
    try {
      config = loadConfig(cfgPath);
      checks.push(verdict("config", true, cfgPath));
    } catch (e) {
      // Not a "could not check": an unparseable config IS the fault.
      checks.push(verdict("config", false, e instanceof Error ? e.message : String(e)));
    }
  }

  // 2. engine + schema
  let storage: Storage | null = null;
  if (config) {
    try {
      storage = new Storage(config);
      await storage.init();
      checks.push(verdict("pglite", true, engineCheckDetail(config.database)));
    } catch (e) {
      // A diagnosis you can only get by opening the thing that will not open is
      // no diagnosis. Read the directory itself — pure filesystem, no driver.
      const detail =
        config.database.type === "pglite" && config.database.path
          ? `${e instanceof Error ? e.message : String(e)} | ${describeDataDir(inspectDataDir(config.database.path))}`
          : e instanceof Error
            ? e.message
            : String(e);
      // A brain whose engine will not open is broken, not merely unmeasured.
      checks.push(verdict("pglite", false, detail));
    }
  }

  // 3. the engine checks run_doctor shares, then the host-side ones
  if (storage) {
    checks.push(...await liteEngineChecks(storage));
    if (config) {
      try {
        checks.push(oauthSelfIssuedCheck(config, await storage.liveOauthClientCount()));
      } catch (e) {
        checks.push(couldNotCheck("oauth-self-issued-config", e));
      }
    }
    // Legacy runtime_config rows. A MEMEX_X row with no MEMRAIN_X row is still
    // in effect through the fallback and must be re-set under the new name;
    // one a MEMRAIN_X row overrides is inert stored data. Names only.
    try {
      const rows = await listRuntimeConfig(storage.raw());
      const { legacyOnly, shadowed } = classifyLegacyRows(rows.map((r) => r.key));
      const shadowNote =
        shadowed.length > 0 ? `; ${shadowed.length} shadowed legacy row(s), inert: ${shadowed.join(", ")}` : "";
      checks.push(
        legacyOnly.length > 0
          ? {
              name: "runtime-config-legacy-rows",
              ok: true,
              status: "warn",
              detail:
                `${legacyOnly.length} legacy-only runtime_config row(s); re-set each as MEMRAIN_* ` +
                `(memrain config set MEMRAIN_<name> <value>): ${legacyOnly.join(", ")}${shadowNote}`,
            }
          : verdict("runtime-config-legacy-rows", true, `no legacy-only runtime_config rows${shadowNote}`),
      );
    } catch (e) {
      checks.push(couldNotCheck("runtime-config-legacy-rows", e));
    }
  }

  checks.push(legacyEnvCheck(legacyEnv));
  try {
    checks.push(legacyConfigDirCheck(homedir()));
  } catch (e) {
    checks.push(couldNotCheck("legacy-config-dir", e));
  }
  checks.push(configYamlCheck(cfgPath));

  // 4. vault path (only when configured)
  const vault = process.env.MEMRAIN_VAULT_PATH ?? config?.storage.vault ?? null;
  if (vault) {
    try {
      const st = statSync(vault);
      checks.push(st.isDirectory() ? verdict("vault", true, vault) : verdict("vault", false, `${vault} exists but is not a directory`));
    } catch {
      // A configured vault that will not stat is a misconfigured host.
      checks.push(verdict("vault", false, `${vault} not readable`));
    }
  } else {
    checks.push(verdict("vault", true, "not configured"));
  }

  // Teardown is REPORTED, not swallowed and not thrown: a close that leaves a
  // PGLite directory lock held must not pass as a healthy run.
  if (storage) {
    try {
      await storage.close();
    } catch (e) {
      checks.push(
        verdict(
          "storage-teardown",
          false,
          `storage.close() failed: ${e instanceof Error ? e.message : String(e)}` +
            ` — the engine may still hold its data-directory lock, which refuses the next open`,
        ),
      );
    }
  }

  // `ok` (and therefore the exit code) is driven by the binary field: a warn
  // must NOT turn a degraded-but-running brain into a red cron probe.
  const pass = checks.every((c) => c.ok);
  console.log(
    JSON.stringify({ ok: pass, status: worstStatus(checks.map((c) => c.status)), version: VERSION, checks }, null, 2),
  );
  if (!pass) process.exitCode = 1;
}
