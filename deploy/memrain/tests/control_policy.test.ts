/**
 * The tenant container's reader of its own policy: `tenant_self()` mapped to a
 * TenantPolicy, cached for 30 s, the last good answer kept when the control
 * plane is unreachable, and the isolation stamp judged against this container.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  controlPolicySource,
  ensureControlPolicySource,
  isolationOf,
  resetControlClient,
  type ContainerIdentity,
  type TenantSelf,
} from "../src/control/policy.ts";
import { HOSTING_ENV, setTenantPolicySource, tenantPolicy } from "../src/control/contract.ts";
import { decideOperation, decideRequest } from "../src/core/tenant-guard.ts";
import { POLICY_MAX_STALE_MS } from "../src/control/policy.ts";

const me: ContainerIdentity = { startedAt: new Date("2026-11-18T10:00:00Z"), bootId: "boot-1", imageStamp: "v1.23.0" };

function self(over: Partial<TenantSelf> = {}): TenantSelf {
  return {
    id: "acme",
    status: "active",
    mode: null,
    limits: { maxPages: 10 },
    llm_off: false,
    isolation: { boot_id: "boot-1", image_stamp: "v1.23.0", passed_at: "2026-11-18T10:05:00Z" },
    ...over,
  };
}

describe("isolationOf", () => {
  it("is verified only for a stamp taken after this container started, on the same boot and image", () => {
    expect(isolationOf(self(), me)).toBe("verified");
    expect(isolationOf(self({ isolation: null }), me)).toBe("unverified");
    expect(isolationOf(self({ isolation: { boot_id: "boot-1", image_stamp: "v1.23.0", passed_at: "2026-11-18T09:59:00Z" } }), me))
      .toBe("unverified");
    expect(isolationOf(self({ isolation: { boot_id: "boot-2", image_stamp: "v1.23.0", passed_at: "2026-11-18T10:05:00Z" } }), me))
      .toBe("unverified");
    expect(isolationOf(self({ isolation: { boot_id: "boot-1", image_stamp: "v1.22.0", passed_at: "2026-11-18T10:05:00Z" } }), me))
      .toBe("unverified");
    expect(isolationOf(self(), { ...me, bootId: null })).toBe("unverified");
  });
});

describe("controlPolicySource", () => {
  it("maps tenant_self to the policy and caches it for the TTL", async () => {
    let now = 0;
    let calls = 0;
    const src = controlPolicySource({
      readSelf: async () => { calls++; return self({ status: "suspended", mode: "read-only", llm_off: true }); },
      identity: () => me,
      ttlMs: 30_000,
      now: () => now,
    });
    expect(await src()).toEqual({
      status: "suspended", mode: "read-only", limits: { maxPages: 10 }, llmOff: true, isolation: "verified",
    });
    now = 29_000;
    await src();
    expect(calls).toBe(1);
    now = 30_001;
    await src();
    expect(calls).toBe(2);
  });

  it("keeps the last known policy when the control plane fails, and fails when it never answered", async () => {
    let now = 0;
    let fail = false;
    const src = controlPolicySource({
      readSelf: async () => { if (fail) throw new Error("unreachable"); return self(); },
      identity: () => me,
      ttlMs: 1,
      now: () => now,
    });
    const first = await src();
    fail = true;
    now = 10;
    expect(await src()).toEqual(first);

    const never = controlPolicySource({ readSelf: async () => { throw new Error("unreachable"); }, identity: () => me });
    await expect(never()).rejects.toThrow(/unreachable/);
    const unknown = controlPolicySource({ readSelf: async () => null, identity: () => me });
    await expect(unknown()).rejects.toThrow(/no tenant/);
  });
});

describe("controlPolicySource during a long outage", () => {
  it("keeps the last good policy only up to its maximum age, then fails closed", async () => {
    expect(POLICY_MAX_STALE_MS).toBeLessThanOrEqual(5 * 60_000);
    let now = 0;
    let fail = false;
    const src = controlPolicySource({
      readSelf: async () => { if (fail) throw new Error("unreachable"); return self(); },
      identity: () => me,
      ttlMs: 30_000,
      now: () => now,
    });
    await src();
    fail = true;
    now = POLICY_MAX_STALE_MS - 1;
    expect((await src()).status).toBe("active");
    now = POLICY_MAX_STALE_MS + 1;
    await expect(src()).rejects.toThrow(/unreachable/);
    // The gates then see an unknown policy: nothing but health, reads included.
    expect(decideRequest(null, "read").allow).toBe(false);
    expect(decideOperation(null, "search").allow).toBe(false);
    // The first answer after the outage serves again.
    fail = false;
    expect((await src()).status).toBe("active");
  });
});

describe("decideRequest with the isolation stamp", () => {
  const verified = { status: "active", mode: null, limits: {}, llmOff: false, isolation: "verified" } as const;
  const unverified = { ...verified, isolation: "unverified" } as const;

  it("an unverified container serves only health", () => {
    expect(decideRequest(unverified, "health")).toEqual({ allow: true });
    for (const c of ["auth", "read", "mcp", "write"] as const) {
      expect(decideRequest(unverified, c)).toEqual({ allow: false, status: 503, error: "isolation_unverified" });
    }
    for (const c of ["auth", "read", "mcp", "write"] as const) expect(decideRequest(verified, c)).toEqual({ allow: true });
  });
});

describe("ensureControlPolicySource", () => {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of Object.values(HOSTING_ENV)) saved.set(k, process.env[k]);
    setTenantPolicySource(null);
    resetControlClient();
  });
  afterEach(() => {
    setTenantPolicySource(null);
    resetControlClient();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("installs nothing outside hosting mode or without a Postgres control URL", async () => {
    for (const k of Object.values(HOSTING_ENV)) delete process.env[k];
    expect(ensureControlPolicySource()).toBe(false);
    process.env["MEMRAIN_TENANT_ID"] = "acme";
    process.env["MEMRAIN_CONTROL_URL"] = "not-a-url";
    expect(ensureControlPolicySource()).toBe(false);
    expect(await tenantPolicy()).toBeNull();
  });
});
