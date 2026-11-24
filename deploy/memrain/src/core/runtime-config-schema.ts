import { nearest } from "./did-you-mean.ts";
import { canonicalKey, isRuntimeConfigKey, listRuntimeConfig } from "./runtime-config.ts";
import type { Engine } from "./engine/interface.ts";
import type { CheckVerdict } from "./doctor-categories.ts";

export type ConfigValueType = "flag" | "int" | "string";

/** Kept in sync with CONFIGURATION.md by test_configuration_doc.py. */
export const CONFIG_KEY_TYPES: Readonly<Record<string, ConfigValueType>> = {
  MEMRAIN_ADMIN_BOOTSTRAP: "string",
  MEMRAIN_ASSUME_PUBLIC: "flag",
  MEMRAIN_AUDIT_DIR: "string",
  MEMRAIN_BOOT_CODE_SWEEP: "flag",
  MEMRAIN_BULK_MAX_RETRIES: "int",
  MEMRAIN_CHAT_RETENTION_DAYS: "int",
  MEMRAIN_CHUNK_OVERLAP: "int",
  MEMRAIN_CODE_PATHS: "string",
  MEMRAIN_CONFIG_PATH: "string",
  MEMRAIN_CONNECTORS_ENABLED: "flag",
  MEMRAIN_CONNECTOR_KEK: "string",
  MEMRAIN_CONNECTOR_KEK_FILE: "string",
  MEMRAIN_CONTENT_SANITY_DISABLE: "string",
  MEMRAIN_CONTROL_URL: "string",
  MEMRAIN_CURATION_BOOST: "string",
  MEMRAIN_CYCLE: "flag",
  MEMRAIN_CYCLE_MAX_USD_PER_DAY: "string",
  MEMRAIN_CYCLE_SKIP_PHASES: "string",
  MEMRAIN_DAEMONS_DISABLED: "string",
  MEMRAIN_DAILY_BUDGET_USD: "string",
  MEMRAIN_DEEP_MODEL: "string",
  MEMRAIN_DEPLOYMENT_IDENTITY: "string",
  MEMRAIN_EMBED_CONCURRENCY: "int",
  MEMRAIN_EMBED_DIM: "int",
  MEMRAIN_EMBED_GAPS: "flag",
  MEMRAIN_EMBED_GAPS_MAX_PER_RUN: "int",
  MEMRAIN_EVENT_LOOP_WATCHDOG_MS: "int",
  MEMRAIN_EMBED_MAX_INFLIGHT: "int",
  MEMRAIN_EMBED_TIMEOUT_MS: "int",
  MEMRAIN_ENABLE_DCR: "flag",
  MEMRAIN_ENABLE_DCR_INSECURE: "flag",
  MEMRAIN_FACTS_MODEL: "string",
  MEMRAIN_GOOGLE_OAUTH_CLIENT_SECRET: "string",
  MEMRAIN_HNSW_ZOMBIE_SWEEP: "flag",
  MEMRAIN_HOST: "string",
  MEMRAIN_HTTP_CORS_ORIGIN: "string",
  MEMRAIN_HTTP_TRUST_PROXY: "flag",
  MEMRAIN_INTERNAL_TOKEN: "string",
  MEMRAIN_JOBS_WORKER: "flag",
  MEMRAIN_KEYWORD_ONLY: "flag",
  MEMRAIN_LLM_MAX_INFLIGHT: "int",
  MEMRAIN_LLM_REASONING_TIMEOUT_MS: "int",
  MEMRAIN_LLM_TIMEOUT_MS: "int",
  MEMRAIN_LLM_UTILITY_TIMEOUT_MS: "int",
  MEMRAIN_LOCK_STEAL_GRACE_SECONDS: "int",
  MEMRAIN_LOG_REQUESTS: "flag",
  MEMRAIN_MAINTENANCE: "flag",
  MEMRAIN_MAX_BODY_BYTES: "int",
  MEMRAIN_MAX_MARKUP_RATIO: "string",
  MEMRAIN_MAX_TYPE_RATIO: "string",
  MEMRAIN_MCP_FORCE_SURFACE: "string",
  MEMRAIN_MCP_INSTRUCTIONS: "string",
  MEMRAIN_MCP_LENIENT_ARGS: "flag",
  MEMRAIN_MCP_MAX_RESULT_BYTES: "int",
  MEMRAIN_MCP_RATE_LIMIT_PER_TOKEN_PER_MINUTE: "int",
  MEMRAIN_MICROSOFT_OAUTH_CLIENT_SECRET: "string",
  MEMRAIN_MIGRATE_BACKOFF_MS: "string",
  MEMRAIN_MIGRATION_LOCK_TIMEOUT: "string",
  MEMRAIN_MIGRATION_STATEMENT_TIMEOUT: "string",
  MEMRAIN_MIRROR_PAGES_MAX_PER_RUN: "int",
  MEMRAIN_NEARDUP_JACCARD: "string",
  MEMRAIN_NO_DB_CONFIG: "flag",
  MEMRAIN_NO_SANITY: "flag",
  MEMRAIN_NOTIFY_WEBHOOK_SECRET: "string",
  MEMRAIN_NOTIFY_WEBHOOK_SECRET_FILE: "string",
  MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE: "flag",
  MEMRAIN_OAUTH_REQUIRE_LOGIN: "flag",
  MEMRAIN_OPERATOR: "string",
  MEMRAIN_ORPHAN_EXCLUDE_EXTRA: "string",
  MEMRAIN_ORPHAN_EXCLUDE_WRITERS: "string",
  MEMRAIN_OUTPUT_REDACTION: "flag",
  MEMRAIN_PAGE_BLOCK_BYTES: "int",
  MEMRAIN_PAGE_MAX_BYTES: "int",
  MEMRAIN_PAGE_WARN_BYTES: "int",
  MEMRAIN_PGLITE_AUTO_ANALYZE: "flag",
  MEMRAIN_PGLITE_NO_LOCK: "flag",
  MEMRAIN_PG_APPLICATION_NAME: "string",
  MEMRAIN_PG_POOL_MAX: "int",
  MEMRAIN_PG_POOL_PROCESSES: "int",
  MEMRAIN_PG_POOL_RESERVE: "flag",
  MEMRAIN_PG_POOLER: "string",
  MEMRAIN_PG_PREPARE: "flag",
  MEMRAIN_PG_STATEMENT_TIMEOUT_MS: "int",
  MEMRAIN_POSTGRES_DIRECT_URL: "string",
  MEMRAIN_POSTGRES_URL: "string",
  MEMRAIN_PUBLIC_AUTH: "string",
  MEMRAIN_PUBLIC_BEARER: "string",
  MEMRAIN_PUBLIC_READ_BODIES: "flag",
  MEMRAIN_PUBLIC_URL: "string",
  MEMRAIN_PUBLIC_WRITE: "flag",
  MEMRAIN_QUERY_EMBED_TIMEOUT_MS: "int",
  MEMRAIN_RANK_PAGE_FUSION: "flag",
  MEMRAIN_REEMBED_ON_SIGNATURE_CHANGE: "flag",
  MEMRAIN_REQUEST_LOG_DB: "flag",
  MEMRAIN_REQUEST_LOG_RETENTION_DAYS: "int",
  MEMRAIN_REQUIRE_MEMBER: "flag",
  MEMRAIN_REQUIRE_POSTGRES: "flag",
  MEMRAIN_REQUIRE_WRITE_PRECONDITION: "string",
  MEMRAIN_RERANK_TIMEOUT_MS: "int",
  MEMRAIN_SANITY_DISPOSITION: "string",
  MEMRAIN_SANITY_LITERALS_FILE: "string",
  MEMRAIN_SEARCH_EXCLUDE: "string",
  MEMRAIN_SEARCH_MAX_CONCURRENT: "int",
  MEMRAIN_SEARCH_SNIPPET_CHARS: "int",
  MEMRAIN_SECRET_SCAN_ALLOW: "string",
  MEMRAIN_SECRET_SCAN_DISPOSITION: "string",
  MEMRAIN_SECRET_SCAN_ECHO: "flag",
  MEMRAIN_SECRET_SCAN_HIGH_ENTROPY: "flag",
  MEMRAIN_SLACK_OAUTH_CLIENT_SECRET: "string",
  MEMRAIN_TENANT_FAIL_CLOSED: "flag",
  MEMRAIN_TENANT_ID: "string",
  MEMRAIN_TEST_PGLITE_TEMPLATE: "string",
  MEMRAIN_TRACK_RETRIEVAL: "flag",
  MEMRAIN_TRANSCRIPT_MAX_FILE_BYTES: "int",
  MEMRAIN_UTILITY_MODEL: "string",
  MEMRAIN_VAULT_PATH: "string",
  MEMRAIN_VAULT_PATHS: "string",
  MEMRAIN_VERSION: "string",
  MEMRAIN_WIKILINK_CANONICALIZE: "flag",
  MEMRAIN_WIKILINK_TRGM: "string",
  MEMRAIN_WRITE_GATE_AGENT: "string",
  MEMRAIN_WRITE_GATE_EXTERNAL: "string",
  MEMRAIN_WRITE_GATE_QUARANTINE_SOURCES: "string",
  MEMRAIN_WRITE_GATE_ROWS: "string",
};

export type ConfigValidation = { ok: true; value: string } | { ok: false; error: string };

export function validateConfigValue(key: string, value: string, force = false): ConfigValidation {
  const canon = canonicalKey(key);
  if (!Object.hasOwn(CONFIG_KEY_TYPES, canon)) {
    if (force) return { ok: true, value };
    const hint = nearest(canon, Object.keys(CONFIG_KEY_TYPES));
    return { ok: false, error: (isRuntimeConfigKey(key) ? `unknown key '${key}'` : `key '${key}' is outside the knob alphabet`) +
      (hint ? `; did you mean ${hint}?` : "") + "; use --force only for a deliberate custom key" };
  }
  const type = CONFIG_KEY_TYPES[canon];
  if (type === "flag") {
    const flag = value.trim().toLowerCase();
    if (["1", "true", "on", "yes"].includes(flag)) return { ok: true, value: "1" };
    if (["0", "false", "off", "no"].includes(flag)) return { ok: true, value: "0" };
    return { ok: false, error: `${canon} requires a boolean (1/0, true/false, on/off, yes/no)` };
  }
  if (type === "int") {
    const n = Number(value.trim());
    if (!/^[+-]?\d+$/.test(value.trim()) || !Number.isSafeInteger(n)) {
      return { ok: false, error: `${canon} requires a safe integer` };
    }
    return { ok: true, value: String(n) };
  }
  return { ok: true, value };
}

export async function checkRuntimeConfigValues(engine: Engine): Promise<CheckVerdict> {
  const rows = await listRuntimeConfig(engine);
  const issues = rows.flatMap(row => {
    const validation = validateConfigValue(row.key, row.value);
    if (!validation.ok) return [`${row.key}: ${Object.hasOwn(CONFIG_KEY_TYPES, canonicalKey(row.key)) ? "invalid value" : "unknown key"}`];
    return validation.value === row.value ? [] : [`${row.key}: noncanonical value`];
  });
  return { name: "runtime-config-values", ok: true, status: issues.length ? "warn" : "ok",
    detail: issues.length ? `${issues.length} row(s) need review: ${issues.slice(0, 20).join(", ")}; nothing rewritten` : "all stored keys and values are canonical" };
}
