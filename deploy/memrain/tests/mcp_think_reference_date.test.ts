/**
 * think `reference_date` over MCP: accepted when it is a real past or current
 * day, refused as `invalid_params` otherwise — on every path, including the
 * default-OFF and no-grant answers that never spend.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

let tmp: string;
let storage: Storage;
let priorThink: string | undefined;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-thinkref-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  priorThink = process.env["MEMRAIN_THINK"];
  delete process.env["MEMRAIN_THINK"];
});

afterEach(async () => {
  if (priorThink === undefined) delete process.env["MEMRAIN_THINK"];
  else process.env["MEMRAIN_THINK"] = priorThink;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const noGrant: AuthInfo = {
  token: "tok-empty",
  clientId: "client-empty",
  scopes: ["read", "write"],
  allowedSources: [],
  isPublic: false,
};

function think(args: Record<string, unknown>, opts: Parameters<typeof dispatchTool>[2] = {}) {
  return dispatchTool(storage, { name: "think", arguments: { question: "what happened last week?", ...args } }, opts);
}

describe("think reference_date", () => {
  it("accepts a past day", async () => {
    const r = await think({ reference_date: "2024-03-15" });
    expect(r.isError ?? false).toBe(false);
    expect(JSON.parse(r.content[0]!.text).ok).toBe(true);
  });

  for (const bad of ["yesterday", "2024-02-30", "2999-01-01"]) {
    it(`refuses ${bad} as invalid_params`, async () => {
      const r = await think({ reference_date: bad });
      expect(r.isError).toBe(true);
      const env = JSON.parse(r.content[0]!.text) as { error: string; message: string };
      expect(env.error).toBe("invalid_params");
      expect(env.message).toContain("reference_date");
    });
  }

  it("refuses a bad date even for a caller with no readable source", async () => {
    const r = await think({ reference_date: "2999-01-01" }, { authInfo: noGrant });
    expect(JSON.parse(r.content[0]!.text).error).toBe("invalid_params");
  });
});
