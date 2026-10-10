/**
 * The authority a tenant agent job runs under: the snapshot taken at submit,
 * and the live re-check that refuses it once the client row stops backing it —
 * deleted, revised, the `agent` scope or the daily cap withdrawn, the read set
 * or the bound tools narrowed. A passing check rebuilds an identity that reads
 * only the snapshot's sources and never carries a scope the token lacked.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import {
  AgentGrantRevoked,
  intersectBoundTools,
  parseAuthority,
  payloadSha256,
  resolveLiveAuthority,
  snapshotAuthority,
  type AgentAuthority,
} from "../src/core/agent/authority.ts";
import { AGENT_READ_TOOLS } from "../src/core/agent/tools.ts";

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;
let clientId: string;
let auth: AuthInfo;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-agent-authority-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: "alpha", kind: "other", pathPrefix: "tenant:alpha" });
  await registerSource(storage.engine(), { id: "beta", kind: "other", pathPrefix: "tenant:beta" });
  provider = new OAuthProvider({ engine: storage.raw() });
  const reg = await provider.registerClientManual("pilot", ["client_credentials"], "agent read write", [], "alpha");
  clientId = reg.clientId;
  await provider.setClientBudget(clientId, 0.5);
  const tokens = await provider.exchangeClientCredentials(clientId, reg.clientSecret!, "agent read");
  auth = { ...(await provider.verifyAccessToken(tokens.access_token)), isPublic: false };
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function snap(tools: readonly string[] = AGENT_READ_TOOLS): Promise<AgentAuthority> {
  const r = await storage.engine().query<{ grant_revision: number }>(
    "SELECT grant_revision FROM oauth_clients WHERE client_id = $1",
    [clientId],
  );
  return snapshotAuthority(auth, {
    grantRevision: Number(r.rows[0]!.grant_revision),
    tools,
    payload: { task: "t", max_usd: 0.1 },
  });
}

async function refusal(s: AgentAuthority): Promise<string> {
  try {
    await resolveLiveAuthority(storage.engine(), s);
  } catch (err) {
    expect(err).toBeInstanceOf(AgentGrantRevoked);
    return (err as AgentGrantRevoked).reason;
  }
  throw new Error("expected the live check to refuse");
}

describe("resolveLiveAuthority", () => {
  it("rebuilds the tenant identity from a live grant", async () => {
    const s = await snap();
    const live = await resolveLiveAuthority(storage.engine(), s);
    expect(live.clientId).toBe(clientId);
    expect(live.sourceId).toBe("alpha");
    expect(live.allowedSources).toEqual(["alpha"]);
    expect(live.token).toBe("");
    // The token asked for agent + read; the client's write scope is not added.
    expect([...live.scopes].sort()).toEqual(["agent", "read"]);
    // Left unset so the spend chokepoint reads the live cap on every call.
    expect(live.budgetUsdPerDay).toBeUndefined();
    expect(live.spendId).toBeUndefined();
  });

  it("refuses a hard-deleted client", async () => {
    const s = await snap();
    await storage.engine().query("DELETE FROM oauth_clients WHERE client_id = $1", [clientId]);
    expect(await refusal(s)).toBe("client revoked");
  });

  it("refuses a soft-deleted client", async () => {
    const s = await snap();
    await storage.engine().query("UPDATE oauth_clients SET deleted_at = NOW() WHERE client_id = $1", [clientId]);
    expect(await refusal(s)).toBe("client revoked");
  });

  it("refuses once the grant revision moves, even for a no-op rescope", async () => {
    const s = await snap();
    await provider.rescopeClient(clientId, { sourceId: "alpha" }, { actor: "test", via: "cli" });
    expect(await refusal(s)).toBe("grant changed");
  });

  it("refuses once the agent scope is withdrawn", async () => {
    const s = await snap();
    await storage.engine().query("UPDATE oauth_clients SET scope = 'read write' WHERE client_id = $1", [clientId]);
    expect(await refusal(s)).toBe("agent scope withdrawn");
  });

  it("refuses once the daily cap is cleared", async () => {
    const s = await snap();
    // setClientBudget bumps the revision, which refuses first; clear the cap
    // behind its back so this check is the one that fires.
    await storage.engine().query("UPDATE oauth_clients SET budget_usd_per_day = NULL WHERE client_id = $1", [clientId]);
    expect(await refusal(s)).toBe("daily budget cleared");
  });

  it("refuses a read set changed behind the revision's back", async () => {
    const s = await snap();
    await storage.engine().query(
      "UPDATE oauth_clients SET federated_read = ARRAY['alpha','beta'] WHERE client_id = $1",
      [clientId],
    );
    expect(await refusal(s)).toBe("read sources changed");
  });

  it("refuses once bound_tools no longer covers the job's tools", async () => {
    const s = await snap(["search", "page_get"]);
    await storage.engine().query("UPDATE oauth_clients SET bound_tools = ARRAY['search'] WHERE client_id = $1", [clientId]);
    expect(await refusal(s)).toBe("bound tools narrowed");
  });

  it("accepts bound_tools that still cover the job's tools", async () => {
    const s = await snap(["search"]);
    await storage.engine().query(
      "UPDATE oauth_clients SET bound_tools = ARRAY['search','page_get'] WHERE client_id = $1",
      [clientId],
    );
    await expect(resolveLiveAuthority(storage.engine(), s)).resolves.toBeDefined();
  });
});

describe("snapshotAuthority", () => {
  it("refuses a caller with no read grant", () => {
    const bare: AuthInfo = { token: "t", clientId: "c", scopes: ["agent"], isPublic: false };
    expect(() => snapshotAuthority(bare, { grantRevision: 0, tools: ["search"], payload: {} })).toThrow(
      /non-empty read grant/,
    );
  });

  it("records the enrollment as the spender when there is one", () => {
    const enrolled: AuthInfo = { ...auth, spendId: "enr-1" };
    const s = snapshotAuthority(enrolled, { grantRevision: 0, tools: ["search"], payload: {} });
    expect(s.spender).toBe("enr-1");
    expect(s.clientId).toBe(clientId);
  });

  it("survives a JSON round trip through parseAuthority", async () => {
    const s = await snap();
    expect(parseAuthority(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("parseAuthority refuses malformed snapshots", async () => {
    const s = await snap();
    for (const bad of [
      null,
      [],
      { ...s, v: 2 },
      { ...s, readSourceIds: [] },
      { ...s, tools: [] },
      { ...s, grantRevision: "0" },
      { ...s, payloadSha256: "abc" },
    ]) {
      expect(() => parseAuthority(bad)).toThrow(/malformed/);
    }
  });
});

describe("payloadSha256", () => {
  it("does not depend on key order", () => {
    expect(payloadSha256({ task: "a", max_usd: 0.1 })).toBe(payloadSha256({ max_usd: 0.1, task: "a" }));
    expect(payloadSha256({ task: "a" })).not.toBe(payloadSha256({ task: "b" }));
  });
});

describe("intersectBoundTools", () => {
  it("keeps the allowlist when the client binds no tools", () => {
    expect(intersectBoundTools(AGENT_READ_TOOLS, null)).toEqual([...AGENT_READ_TOOLS]);
  });

  it("narrows to the bound tools, in allowlist order, and never adds one", () => {
    expect(intersectBoundTools(AGENT_READ_TOOLS, ["page_get", "page_put", "search"])).toEqual(["search", "page_get"]);
    expect(intersectBoundTools(AGENT_READ_TOOLS, [])).toEqual([]);
  });
});
