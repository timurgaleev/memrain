import { existsSync } from "node:fs";
import { loadConfig } from "../core/config.ts";
import { PostgresEngine } from "../core/engine/postgres.ts";
import { PGliteEngine } from "../core/engine/pglite.ts";
import type { Engine } from "../core/engine/interface.ts";

const HINTS = {
  configured: "Configuration inspected; use --probe for one connection without migrations.",
  ok: "Connection and vector extension are available.",
  config_invalid: "Inspect the local config file and MEMRAIN_REQUIRE_POSTGRES.",
  url_missing: "Set MEMRAIN_POSTGRES_URL or database.url in the config file.",
  url_parse_failed: "Check the postgres URL; percent-encode reserved characters in the username/password.",
  auth: "Check the database role and credential source.",
  ssl: "Check the TLS mode and trusted server certificate.",
  dns: "Check the database hostname and DNS resolution.",
  refused: "Check the database endpoint, port and network rules.",
  timeout: "Check endpoint reachability and database availability.",
  db_missing: "Check the configured database name or existing PGLite directory.",
  vector_missing: "The connection works but the vector extension is missing; inspect database setup.",
  other: "Inspect database service logs; no configuration was changed.",
} as const;
type EngineStatus = keyof typeof HINTS;

export function classifyEngineError(error: unknown): EngineStatus {
  const e = error as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  if (code === "28P01" || code === "28000") return "auth";
  if (code === "3D000") return "db_missing";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "ECONNREFUSED") return "refused";
  if (/TIMEOUT|ETIMEDOUT/.test(code) || e?.name === "TimeoutError") return "timeout";
  if (/CERT|TLS|SSL|SELF_SIGNED/.test(code) || /ssl|tls|certificate/i.test(String(e?.message ?? "").slice(0, 500))) return "ssl";
  return e?.cause && e.cause !== error ? classifyEngineError(e.cause) : "other";
}

export function inspectPostgresUrl(raw: string): { ok: boolean; endpoint?: string } {
  try {
    const tail = raw.replace(/^postgres(?:ql)?:\/\//, "");
    const at = tail.lastIndexOf("@");
    if (at >= 0) {
      const credentials = tail.slice(0, at);
      const colon = credentials.indexOf(":");
      const user = colon < 0 ? credentials : credentials.slice(0, colon);
      const password = colon < 0 ? "" : credentials.slice(colon + 1);
      if (/[/:?#@\s]/.test(user) || /[/:?#@\s]/.test(password) || /%(?![0-9a-f]{2})/i.test(credentials)) return { ok: false };
    }
    const parsed = new URL(raw);
    if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || !parsed.hostname || parsed.hash) return { ok: false };
    const ssl = parsed.searchParams.get("sslmode");
    const suffix = ssl && /^(?:disable|allow|prefer|require|verify-ca|verify-full)$/.test(ssl) ? `?sslmode=${ssl}` : "";
    return { ok: true, endpoint: `${parsed.protocol}//${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}${parsed.pathname}${suffix}` };
  } catch { return { ok: false }; }
}

export async function runEngineStatus(opts: { probe?: boolean; json?: boolean; configPath?: string } = {}): Promise<number> {
  let kind = "unknown";
  let source = "config";
  let endpoint: string | undefined;
  let probed = false;
  const emit = (status: EngineStatus) => {
    const ok = status === "ok" || status === "configured";
    const report = { ok, engine: kind, source, ...(endpoint ? { endpoint } : {}), probed, status, hint: HINTS[status] };
    console.log(opts.json ? JSON.stringify(report, null, 2) : `${kind}: ${status}; source=${source}${endpoint ? `; endpoint=${endpoint}` : ''}\n${report.hint}`);
    return ok ? 0 : 1;
  };
  let config;
  try { config = loadConfig(opts.configPath); } catch { return emit("config_invalid"); }
  const db = config.database;
  kind = db.type;
  if (db.type === "pglite" && process.env.MEMRAIN_REQUIRE_POSTGRES === "1") return emit("config_invalid");
  const url = db.type === "postgres" ? process.env.MEMRAIN_POSTGRES_URL ?? db.url : undefined;
  if (db.type === "postgres") {
    source = process.env.MEMRAIN_POSTGRES_URL !== undefined ? "MEMRAIN_POSTGRES_URL" : "config.database.url";
    if (!url) return emit("url_missing");
    const parsed = inspectPostgresUrl(url);
    if (!parsed.ok) return emit("url_parse_failed");
    endpoint = parsed.endpoint;
  } else { source = "config.database.path"; endpoint = db.path; }
  if (!opts.probe) return emit("configured");
  if (db.type === "pglite" && !existsSync(db.path)) return emit("db_missing");
  let engine: Engine | undefined;
  let status: EngineStatus = "ok";
  try {
    probed = true;
    engine = db.type === "postgres" ? new PostgresEngine({ url: url!, max: 1, statementTimeoutMs: 5000 }) : new PGliteEngine({ dbPath: db.path });
    await engine.ready();
    const result = await engine.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    if (result.rows.length === 0) status = "vector_missing";
  } catch (error) { status = classifyEngineError(error); }
  finally {
    try { await engine?.close(); } catch (error) { if (status === "ok") status = classifyEngineError(error); }
  }
  return emit(status);
}
