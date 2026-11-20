/**
 * Every Bedrock client is built on `bedrockClientConfig`, which sends one
 * attempt: the spend wallet retries and holds each attempt's worst case, so a
 * client keeping the SDK's own retries would send several billed requests
 * under one hold.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

describe("Bedrock clients", () => {
  it("are all built on bedrockClientConfig", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/new BedrockRuntimeClient\(/g)) {
        // The extension's own hook carries credentials only, not the attempt count.
        const args = text.slice(match.index, match.index + 300).replaceAll("extension().bedrockClientConfig(", "");
        if (!args.includes("bedrockClientConfig(")) offenders.push(`${file.slice(SRC.length + 1)}:${text.slice(0, match.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
