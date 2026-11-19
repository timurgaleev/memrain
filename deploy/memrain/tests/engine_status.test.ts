import { afterAll, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEngineStatus, inspectPostgresUrl, classifyEngineError } from "../src/commands/engine-status.ts";
import { PostgresEngine } from "../src/core/engine/postgres.ts";

const dir = mkdtempSync(join(tmpdir(), "memrain-engine-status-"));
const configPath = join(dir, "config.json");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
it("redacts credentials and query values and rejects unescaped credential delimiters", () => {
  const parsed = inspectPostgresUrl("postgres://person:p%40ss@localhost/brain?sslmode=require&password=PRIVATE");
  expect(parsed).toEqual({ ok: true, endpoint: "postgres://localhost/brain?sslmode=require" });
  for (const password of ["a@b", "a/b", "a?b", "a#b", "a:b", "a%b"]) {
    expect(inspectPostgresUrl(`postgres://user:${password}@localhost/brain`)).toEqual({ ok: false });
  }
});
it("classifies connection failures without returning their payload", () => {
  for (const [code, status] of [["28P01", "auth"], ["3D000", "db_missing"], ["ENOTFOUND", "dns"], ["ECONNREFUSED", "refused"], ["CONNECT_TIMEOUT", "timeout"], ["CERT_HAS_EXPIRED", "ssl"]] as const) {
    expect(classifyEngineError({ code, message: "PRIVATE" })).toBe(status);
  }
});
it("probes one connection, reports missing vector, and closes on connection failure", async () => {
  const saved = process.env.MEMRAIN_POSTGRES_URL;
  process.env.MEMRAIN_POSTGRES_URL = "postgres://user:PRIVATE@localhost/brain?sslmode=disable";
  writeFileSync(configPath, JSON.stringify({ database: { type: "postgres" }, embedding: { provider: "bedrock-titan" }, storage: {} }));
  const ready = spyOn(PostgresEngine.prototype, "ready").mockResolvedValue();
  const query = spyOn(PostgresEngine.prototype, "query").mockResolvedValue({ rows: [] });
  const close = spyOn(PostgresEngine.prototype, "close").mockResolvedValue();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await runEngineStatus({ configPath, probe: true, json: true })).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0]![0])).status).toBe("vector_missing");
    expect(ready).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    ready.mockRejectedValue(Object.assign(new Error("PRIVATE"), { code: "28P01" }));
    expect(await runEngineStatus({ configPath, probe: true, json: true })).toBe(1);
    expect(JSON.parse(String(log.mock.calls[1]![0])).status).toBe("auth");
    expect(close).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join(" ")).not.toContain("PRIVATE");
  } finally {
    if (saved === undefined) delete process.env.MEMRAIN_POSTGRES_URL; else process.env.MEMRAIN_POSTGRES_URL = saved;
    ready.mockRestore(); query.mockRestore(); close.mockRestore(); log.mockRestore();
  }
});
it("probes a pooled tenant the way its brain connects: no session startup parameter", async () => {
  const keys = ["MEMRAIN_POSTGRES_URL", "MEMRAIN_PG_POOLER", "MEMRAIN_POSTGRES_DIRECT_URL", "MEMRAIN_PG_PREPARE"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.MEMRAIN_POSTGRES_URL = "postgres://user:PRIVATE@pgbouncer-t1:6432/brain?sslmode=disable";
  process.env.MEMRAIN_PG_POOLER = "pgbouncer";
  process.env.MEMRAIN_POSTGRES_DIRECT_URL = "postgres://user:PRIVATE@db/brain?sslmode=require";
  process.env.MEMRAIN_PG_PREPARE = "0";
  writeFileSync(configPath, JSON.stringify({ database: { type: "postgres" }, embedding: { provider: "bedrock-titan" }, storage: {} }));
  let seen: ReturnType<PostgresEngine["options"]> | undefined;
  let pooler: string | undefined;
  const ready = spyOn(PostgresEngine.prototype, "ready").mockImplementation(async function (this: PostgresEngine) {
    seen = this.options();
    pooler = this.pooler;
  });
  const query = spyOn(PostgresEngine.prototype, "query").mockResolvedValue({ rows: [{}] });
  const close = spyOn(PostgresEngine.prototype, "close").mockResolvedValue();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await runEngineStatus({ configPath, probe: true, json: true })).toBe(0);
    expect(pooler).toBe("pgbouncer");
    expect(seen!.max).toBe(1);
    expect(seen!.connection).not.toHaveProperty("statement_timeout");
    expect(seen!.connection).not.toHaveProperty("idle_in_transaction_session_timeout");
    expect(seen).toHaveProperty("prepare", false);
    process.env.MEMRAIN_PG_POOLER = "pgpool";
    expect(await runEngineStatus({ configPath, probe: true, json: true })).toBe(1);
    expect(JSON.parse(String(log.mock.calls[1]![0])).status).toBe("config_invalid");
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    ready.mockRestore(); query.mockRestore(); close.mockRestore(); log.mockRestore();
  }
});
