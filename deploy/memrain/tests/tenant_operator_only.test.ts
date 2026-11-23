/**
 * Latent multi-tenant read-scope holes closed (security review F1–F4):
 *  - F1/F2: operator-only operational tools (stats/run_doctor) are refused for
 *    an authenticated tenant token, allowed for the static/internal path.
 *  - F3: the MEMRAIN_TENANT_FAIL_CLOSED floor is reachable for ANY authenticated
 *    principal with no grant (not only isPublic===true), and the static bearer
 *    (authInfo===undefined) is never scoped.
 *  - F4: resolveRequestedScope keys "trusted" on authInfo===undefined, and a scoped
 *    caller may only name a source inside its grant (empty grant → rejected).
 * Pure-function assertions (no DB) plus a dispatch gate check with an in-memory PGLite.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import {
  effectiveReadSourceIdsForIngress,
  effectiveWriteSourceIdForIngress,
  resolveRequestedScope,
  NO_SOURCE_SENTINEL,
  type AuthInfo,
} from "../src/core/auth-info.ts";

const tenant = (sourceId?: string): AuthInfo => ({
  token: "t",
  clientId: "c",
  scopes: ["read"],
  ...(sourceId ? { sourceId, allowedSources: [sourceId] } : {}),
  isPublic: false,
});

describe("F3 — fail-closed floor is reachable for any authenticated principal", () => {
  it("an OAuth tenant (isPublic:false) with NO grant reads/writes nothing when failClosed", () => {
    const scopeless = tenant(); // authInfo present, no sourceId/allowedSources
    // Reads resolve to an empty grant; writes keep the sentinel the gate refuses.
    expect(effectiveReadSourceIdsForIngress(scopeless, { failClosed: true })).toEqual([]);
    expect(effectiveWriteSourceIdForIngress(scopeless, { failClosed: true })).toBe(
      NO_SOURCE_SENTINEL,
    );
  });
  it("the static bearer (authInfo===undefined) is NEVER scoped, floor on or off", () => {
    expect(effectiveReadSourceIdsForIngress(undefined, { failClosed: true })).toBeUndefined();
    expect(effectiveWriteSourceIdForIngress(undefined, { failClosed: true })).toBeUndefined();
  });
  it("a granted tenant resolves to its own source (unchanged)", () => {
    expect(effectiveReadSourceIdsForIngress(tenant("acme"), { failClosed: true })).toEqual([
      "acme",
    ]);
    expect(effectiveWriteSourceIdForIngress(tenant("acme"), { failClosed: true })).toBe("acme");
  });
});

describe("F4 — resolveRequestedScope keys trust on authInfo===undefined", () => {
  it("a tenant cannot pose as trusted-local to grab all sources", () => {
    expect(resolveRequestedScope(tenant("acme"), undefined, true)).not.toEqual({});
  });
  it("a tenant naming a source outside its grant is rejected", () => {
    expect(() => resolveRequestedScope(tenant("acme"), "other", false)).toThrow();
  });
  it("a tenant with an EMPTY grant naming any source is rejected (no pass-through)", () => {
    expect(() => resolveRequestedScope(tenant(), "any", false)).toThrow();
  });
  it("the trusted-local path (undefined auth) may name any source / all", () => {
    expect(resolveRequestedScope(undefined, undefined, true)).toEqual({});
    expect(resolveRequestedScope(undefined, "whatever", false)).toEqual({ sourceId: "whatever" });
  });
});

describe("F1/F2 — operator-only tools refuse a tenant token", () => {
  let tmp: string;
  let storage: Storage;
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "memrain-oponly-"));
    storage = new Storage({ dbPath: join(tmp, "db"), dataDir: tmp } as never);
    await storage.init();
  });
  afterAll(async () => {
    await storage.close();
    await rm(tmp, { recursive: true, force: true });
  });

  for (const name of ["stats", "run_doctor"]) {
    it(`${name} → permission_denied for a tenant token`, async () => {
      const res = await dispatchTool(
        storage,
        { name, arguments: {} },
        { authInfo: tenant("acme"), isPublic: false },
      );
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res)).toContain("operator-only");
    });
  }

  it("stats works for the static/internal path (no authInfo) — not operator-denied", async () => {
    const res = await dispatchTool(storage, { name: "stats", arguments: {} }, {});
    expect(JSON.stringify(res)).not.toContain("operator-only");
  });
});
