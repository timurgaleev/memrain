import { afterAll, beforeAll, expect, it, spyOn } from "bun:test";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { loadConfig } from "../src/core/config.ts";
import { runModels } from "../src/commands/models.ts";
import { resolveModelWithSource } from "../src/core/llm/resolve-model.ts";

const dir = mkdtempSync(join(tmpdir(), "memrain-models-"));
const configPath = join(dir, "config.json");
const keys = ["MEMRAIN_UTILITY_MODEL", "MEMRAIN_FACTS_MODEL", "MEMRAIN_DEEP_MODEL", ...["THINK", "DRIFT", "CONCEPTS", "EXPANSION", "INTENT", "RERANK", "FACTS_EXTRACT"].map(f => `MEMRAIN_${f}_MODEL`)];
const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
beforeAll(() => {
  for (const key of keys) delete process.env[key];
  writeFileSync(configPath, JSON.stringify({ database: { type: "pglite", path: join(dir, "brain") }, embedding: { provider: "bedrock-titan" }, storage: {} }));
});
afterAll(() => {
  for (const key of keys) { const value = saved[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(dir, { recursive: true, force: true });
});
async function run(probe: boolean, maxCostUsd: number, failure: string | false = false) {
  const client = new BedrockRuntimeClient({ region: "eu-west-1" });
  const send = spyOn(client, "send").mockImplementation(async () => {
    if (failure) throw Object.assign(new Error("PRIVATE provider payload"), { name: failure });
    return { output: { message: { role: "assistant", content: [{ text: "OK" }] } }, usage: { inputTokens: 4, outputTokens: 1 } };
  });
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const code = await runModels({ probe, maxCostUsd, json: true, configPath, client });
    const output = log.mock.calls.flat().join("\n");
    return { code, report: JSON.parse(output), output, calls: send.mock.calls.map(([command]) => { expect(command).toBeInstanceOf(ConverseCommand); return (command as ConverseCommand).input; }) };
  } finally { send.mockRestore(); log.mockRestore(); client.destroy(); }
}
it("keeps override, feature, tier and default provenance aligned with resolution", () => {
  process.env.MEMRAIN_FACTS_MODEL = "tier-sonnet";
  process.env.MEMRAIN_THINK_MODEL = "feature-sonnet";
  try {
    expect(resolveModelWithSource("reasoning", "explicit-sonnet", "think").source).toBe("override");
    expect(resolveModelWithSource("reasoning", undefined, "think")).toMatchObject({ source: "feature_env", model: "feature-sonnet" });
    expect(resolveModelWithSource("reasoning").source).toBe("tier_env");
    expect(resolveModelWithSource("deep")).toMatchObject({ source: "tier_env", key: "MEMRAIN_FACTS_MODEL", model: "tier-sonnet" });
  } finally { delete process.env.MEMRAIN_FACTS_MODEL; delete process.env.MEMRAIN_THINK_MODEL; }
});
it("probes each unique model once with maxTokens=1 and uses normal spend accounting", async () => {
  const result = await run(true, 0.01);
  expect(result.code).toBe(0);
  const unique = new Set<string>(result.report.models.map((r: { model: string }) => r.model));
  expect(result.calls.length).toBe(unique.size);
  expect(new Set(result.calls.map(c => c.modelId))).toEqual(unique);
  for (const call of result.calls) expect(call.inferenceConfig?.maxTokens).toBe(1);
  const storage = new Storage(loadConfig(configPath));
  await storage.init();
  try {
    const logged = await storage.engine().query<{ model: string; input_tokens: number }>("SELECT model, input_tokens FROM mcp_spend_log WHERE operation = 'models-probe' AND outcome = 'ok'");
    expect(new Set(logged.rows.map(r => r.model))).toEqual(unique);
    expect(logged.rows.every(r => Number(r.input_tokens) === 4)).toBe(true);
  } finally { await storage.close(); }
});
it("makes no model calls for a listing or a zero dollar cap", async () => {
  expect((await run(false, 0.01)).calls).toEqual([]);
  const capped = await run(true, 0);
  expect(capped.code).toBe(1);
  expect(capped.calls).toEqual([]);
  expect(capped.report.probes.every((p: { status: string }) => p.status === "budget_refused")).toBe(true);
});
it("returns safe classified errors and refuses unpriced models before sending", async () => {
  const failed = await run(true, 0.01, "AccessDeniedException");
  expect(failed.code).toBe(1);
  expect(failed.report.probes.every((p: { status: string }) => p.status === "access")).toBe(true);
  expect(failed.output).not.toContain("PRIVATE");
  process.env.MEMRAIN_THINK_MODEL = "unknown-model";
  try {
    const result = await run(true, 0.01);
    expect(result.calls.every(c => c.modelId !== "unknown-model")).toBe(true);
    expect(result.report.probes.find((p: { model: string }) => p.model === "unknown-model").status).toBe("budget_refused");
  } finally { delete process.env.MEMRAIN_THINK_MODEL; }
});

it("does not refund a failed attempt's possible spend into later probes", async () => {
  const result = await run(true, 0.0003, "TimeoutError");
  expect(result.code).toBe(1);
  expect(result.calls).toHaveLength(1);
  expect(result.report.probes.some((p: { status: string }) => p.status === "budget_refused")).toBe(true);
});
