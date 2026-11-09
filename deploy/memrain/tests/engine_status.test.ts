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
  const parsed = inspectPostgresUrl("postgres://person:PRIVATE%40password@localhost/brain?sslmode=require&password=PRIVATE");
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
