import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "memrain-diagnostic-cli-"));
const config = join(dir, "config.json");
const base = { embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" }, storage: {} };
beforeAll(() => writeFileSync(config, JSON.stringify({ ...base, database: { type: "pglite", path: join(dir, "brain") } })));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function cli(args: string[], extra: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bun", "src/cli.ts", ...args], { cwd: join(import.meta.dir, ".."), env: {
    ...process.env, MEMRAIN_CONFIG_PATH: config, MEMRAIN_REQUIRE_POSTGRES: "0", ...extra,
  }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: new TextDecoder().decode(p.stdout), err: new TextDecoder().decode(p.stderr) };
}
it("engine status inspects a local configuration without creating its database", () => {
  const r = cli(["engine", "status", "--json"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toMatchObject({ engine: "pglite", probed: false });
  expect(existsSync(join(dir, "brain"))).toBe(false);
});
it("models lists effective feature overrides and registered prices without invoking Bedrock", () => {
  const r = cli(["models", "--json"], { MEMRAIN_THINK_MODEL: "eu.anthropic.claude-sonnet-test", MEMRAIN_NO_DB_CONFIG: "1" });
  expect(r.code).toBe(0);
  const report = JSON.parse(r.out);
  expect(report.models.find((m: { feature?: string }) => m.feature === "think")).toMatchObject({ model: "eu.anthropic.claude-sonnet-test", source: "feature_env", key: "MEMRAIN_THINK_MODEL", price: { inputPer1M: 3, outputPer1M: 15 } });
  expect(report.probes).toEqual([]);
});
