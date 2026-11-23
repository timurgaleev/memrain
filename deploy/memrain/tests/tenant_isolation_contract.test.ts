/**
 * Multi-tenant isolation — the reads the isolation matrix cannot judge by
 * token alone.
 *
 * `tenant_isolation_matrix.test.ts` drives every read tool through scalar,
 * federated, cross-tenant and no-grant callers over the shared two-tenant seed
 * (`helpers/tenant_seed.ts`). What stays here needs a sharper assertion than
 * "no foreign token, some own token": the grant echo (`whoami`).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { A, auth, seedTenantContract } from "./helpers/tenant_seed.ts";

setDefaultTimeout(30000);

let tmp: string;
let storage: Storage;

function payload(result: ToolCallResult): any {
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text);
}

async function call(
  name: string,
  args: Record<string, unknown>,
  authInfo?: AuthInfo,
): Promise<any> {
  return payload(
    await dispatchTool(storage, { name, arguments: args }, authInfo ? { authInfo } : {}),
  );
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-tenant-contract-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await seedTenantContract(storage);
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("contract: identity", () => {
  it("whoami: read scope reflects the caller's grant; unscoped is whole-brain", async () => {
    const a = await call("whoami", {}, auth(A));
    expect(a.read_sources).toEqual([A]);
    expect(a.write_source).toBe(A);
    const unscoped = await call("whoami", {});
    expect(unscoped.read_sources).toBeNull();
  });
});
