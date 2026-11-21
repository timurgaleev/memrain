/**
 * Multi-tenant isolation — the reads the isolation matrix cannot judge by
 * token alone.
 *
 * `tenant_isolation_matrix.test.ts` drives every read tool through scalar,
 * federated, cross-tenant and no-grant callers over the shared two-tenant seed
 * (`helpers/tenant_seed.ts`). What stays here needs a sharper assertion than
 * "no foreign token, some own token": per-type COUNTS (`list_link_sources`),
 * BOTH halves of a merged ledger (`find_trajectory`), an operator-only refusal
 * (`list_concepts`), and the grant echo (`whoami`).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import {
  A, A_EVENT, A_FACT, auth, B, B_EVENT, B_FACT, ENTITY_SLUG, seedTenantContract,
} from "./helpers/tenant_seed.ts";

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

describe("contract: link counts honour source scope", () => {
  it("list_link_sources: per-type counts reflect only the caller's edges", async () => {
    const countFor = (rows: any[], type: string) => rows.find((r) => r.type === type)?.count ?? 0;
    const a = (await call("list_link_sources", {}, auth(A))).sources as any[];
    const b = (await call("list_link_sources", {}, auth(B))).sources as any[];
    const all = (await call("list_link_sources", {})).sources as any[];
    expect(countFor(a, "contradicts")).toBe(1);
    expect(countFor(b, "contradicts")).toBe(1);
    expect(countFor(all, "contradicts")).toBe(2);
  });
});

describe("contract: insight reads honour source scope", () => {
  it("find_trajectory: the merged ledger stays source-scoped", async () => {
    // A tenant token reads world facts only; the seed writes them private.
    await storage.engine().query("UPDATE entity_facts SET visibility = 'world' WHERE fact = ANY($1::text[])", [[A_FACT, B_FACT]]);
    const a = JSON.stringify(await call("find_trajectory", { entity_slug: ENTITY_SLUG }, auth(A)));
    expect(a).toContain(A_FACT);
    expect(a).toContain(A_EVENT);
    expect(a).not.toContain(B_FACT);
    expect(a).not.toContain(B_EVENT);
    const b = JSON.stringify(await call("find_trajectory", { entity_slug: ENTITY_SLUG }, auth(B)));
    expect(b).toContain(B_FACT);
    expect(b).not.toContain(A_FACT);
  });
});

describe("contract: operator-only reads + identity", () => {
  it("list_concepts: operator-only — a tenant token is denied, operator sees the global set", async () => {
    // synth_concepts is a GLOBAL aggregate with no source_id axis
    // (migrations/045_synthesis.sql) — concepts cluster atoms across every source.
    // Rather than leak that cross-tenant set to a scoped caller, list_concepts is
    // operator-only (v1.79.2): a tenant token is refused; the unscoped operator
    // path sees the whole-brain set.
    const a = JSON.stringify(await call("list_concepts", {}, auth(A)));
    expect(a).toContain("permission_denied");
    const all = JSON.stringify(await call("list_concepts", {}));
    expect(all).toContain("AAA_CONCEPT_narrative");
    expect(all).toContain("BBB_CONCEPT_narrative");
  });

  it("whoami: read scope reflects the caller's grant; unscoped is whole-brain", async () => {
    const a = await call("whoami", {}, auth(A));
    expect(a.read_sources).toEqual([A]);
    expect(a.write_source).toBe(A);
    const unscoped = await call("whoami", {});
    expect(unscoped.read_sources).toBeNull();
  });
});
