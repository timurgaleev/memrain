import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { identifierTokens } from "../src/core/search/identifier-probe.ts";
import { keywordIdentifierSearch } from "../src/core/search/keyword.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { linearityRatio } from "./helpers/cpu-time.ts";

it("scans punctuation before a rejecting URL suffix in linear time", () => {
  const run = (size: number) => {
    const query = `https://example.com/${".".repeat(size)}x`;
    for (let i = 0; i < 16; i++) expect(identifierTokens(query)).toEqual([]);
  };
  run(2000);
  run(8000);
  expect(linearityRatio(() => run(2000), () => run(8000))).toBeLessThan(9);
});

it("does not block the process on a large punctuation run", async () => {
  const script = `import { identifierTokens } from ${JSON.stringify(fileURLToPath(new URL("../src/core/search/identifier-probe.ts", import.meta.url)))}; process.stdout.write(JSON.stringify(identifierTokens('%'.repeat(262144))));`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    expect(code).toBe(0);
    expect(output).toBe("[]");
  } finally { clearTimeout(timer); child.kill(); }
});

it("declines an oversized probe rather than silently dropping identifiers from its AND", async () => {
  let calls = 0;
  const engine = { query: async () => { calls++; return { rows: [] }; } } as unknown as Engine;
  for (const q of ["find " + Array.from({ length: 17 }, (_, i) => `INV-${i}`).join(" "), "find #412 " + "x".repeat(8192)]) {
    await expect(keywordIdentifierSearch(engine, q, 20)).rejects.toThrow("identifier probe limit");
    expect(calls).toBe(0);
    expect(identifierTokens(q)).toEqual([]);
  }
});

it("detects prose in one pass without confusing an identifier prefix with another identifier", async () => {
  let calls = 0;
  const engine = { query: async () => { calls++; return { rows: [] }; } } as unknown as Engine;
  expect(await keywordIdentifierSearch(engine, "INV-1 INV-10", 20)).toEqual([]);
  expect(calls).toBe(0);
});
