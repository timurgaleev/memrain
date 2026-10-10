/**
 * describeCaller — what whoami reports beyond identity. callable_tools must
 * equal the tools/list set for the same caller; spend comes from the ledger.
 */
import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "../src/core/auth-info.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { describeCaller } from "../src/mcp/caller-capabilities.ts";
import { visibleToolDefs } from "../src/mcp/visibility.ts";

interface Recorded {
  sql: string;
  params: unknown[];
}

/** An engine that answers the day-spend query with fixed cents. */
function ledger(actualCents: number, heldCents: number, cap: number | null = null): { engine: Engine; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const engine = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("budget_usd_per_day")) return { rows: [{ budget_usd_per_day: cap }] };
      return { rows: [{ actual: actualCents, held: heldCents }] };
    },
  } as unknown as Engine;
  return { engine, calls };
}

function token(overrides: Partial<AuthInfo>): AuthInfo {
  return { token: "t", clientId: "client-a", scopes: ["read"], sourceId: "team-a", isPublic: false, ...overrides };
}

const noWall = (): boolean => false;

describe("describeCaller", () => {
  it("lists exactly what tools/list shows, and a read token gets no write tools", async () => {
    const auth = token({ scopes: ["read"], budgetUsdPerDay: null });
    const r = await describeCaller(ledger(0, 0).engine, { authInfo: auth, isPublic: false, forbidPublic: noWall });
    const listed = visibleToolDefs({ isPublic: false, authInfo: auth }, noWall).map((t) => t.name);
    expect(r.callable_tools).toEqual(listed);
    expect(r.callable_tools).toContain("search");
    for (const write of ["page_put", "page_append", "add_fact", "run_doctor", "stats"]) {
      expect(r.callable_tools).not.toContain(write);
    }
    expect(r.operator).toBe(false);
  });

  it("reports the fence, the holders, the cap and today's spend under the enrollment key", async () => {
    const { engine, calls } = ledger(150, 50);
    const r = await describeCaller(engine, {
      authInfo: token({
        scopes: ["read", "write"],
        spendId: "enr-1",
        boundSlugPrefixes: ["notes/a"],
        takesHolders: ["world"],
        budgetUsdPerDay: 5,
      }),
      isPublic: false,
      forbidPublic: noWall,
    });
    expect(r).toMatchObject({
      operator: false,
      bound_slug_prefixes: ["notes/a"],
      takes_holders: ["world"],
      budget_usd_per_day: 5,
      spent_today_usd: 2,
      spend_id: "enr-1",
    });
    expect(r.callable_tools).toContain("page_put");
    // The cap came with the token, so only the spend sum was queried.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params[0]).toBe("enr-1");
  });

  it("looks the cap up when the token did not resolve it", async () => {
    const r = await describeCaller(ledger(0, 0, 3).engine, {
      authInfo: token({}),
      isPublic: false,
      forbidPublic: noWall,
    });
    expect(r.budget_usd_per_day).toBe(3);
    expect(r.spend_id).toBe("client-a");
    expect(r.bound_slug_prefixes).toBeNull();
    expect(r.takes_holders).toBeNull();
  });

  it("gives the operator every tool and no per-principal knobs, without touching the ledger", async () => {
    const { engine, calls } = ledger(999, 0);
    const r = await describeCaller(engine, { authInfo: undefined, isPublic: false, internalAuthOk: true, forbidPublic: noWall });
    expect(r).toMatchObject({
      operator: true,
      bound_slug_prefixes: null,
      takes_holders: null,
      budget_usd_per_day: null,
      spent_today_usd: null,
      spend_id: null,
    });
    expect(r.callable_tools).toContain("run_doctor");
    expect(calls).toHaveLength(0);
  });

  it("does not call the public bearer an operator, and walls what the ingress walls", async () => {
    const forbid = (name: string): boolean => name === "page_put";
    const r = await describeCaller(ledger(0, 0).engine, { authInfo: undefined, isPublic: true, forbidPublic: forbid });
    expect(r.operator).toBe(false);
    expect(r.callable_tools).not.toContain("page_put");
  });
});
