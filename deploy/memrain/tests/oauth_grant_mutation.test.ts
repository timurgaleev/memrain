/**
 * The grant mutation service (`OAuthProvider.rescopeClient`): every applied
 * change bumps the client's grant revision and writes exactly one audit row;
 * a stale expected revision fails with `grant_conflict` and writes nothing;
 * a dry run returns the same diff the apply then records; validation returns
 * every reason code at once and writes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  GrantConflictError,
  GrantNotFoundError,
  GrantValidationError,
  OAuthProvider,
  grantDiff,
  grantSnapshot,
} from "../src/core/oauth-provider.ts";
import type { GrantMutationOptions } from "../src/core/oauth-provider.ts";
import { registerSource } from "../src/core/sources.ts";

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;

const CLI: GrantMutationOptions = { actor: "ops", via: "cli" };

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-grant-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  provider = new OAuthProvider({ engine: storage.raw() });
  await registerSource(storage.raw(), { id: "acme", kind: "other", pathPrefix: "/acme" });
  await registerSource(storage.raw(), { id: "beta", kind: "other", pathPrefix: "/beta" });
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function register(prefixes?: string[]): Promise<{ clientId: string; clientSecret: string }> {
  const reg = await provider.registerClientManual(
    "grant-test",
    ["client_credentials"],
    "read write",
    [],
    "default",
    undefined,
    undefined,
    prefixes,
  );
  return { clientId: reg.clientId, clientSecret: reg.clientSecret! };
}

interface ClientGrantRow {
  source_id: string | null;
  federated_read: string[];
  bound_slug_prefixes: string[] | null;
  tenant_mode: string;
  grant_revision: number;
}

async function clientRow(clientId: string): Promise<ClientGrantRow> {
  const r = await storage.raw().query<ClientGrantRow>(
    `SELECT source_id, federated_read, bound_slug_prefixes, tenant_mode, grant_revision
       FROM oauth_clients WHERE client_id = $1`,
    [clientId],
  );
  return r.rows[0]!;
}

async function auditCount(clientId: string): Promise<number> {
  const r = await storage.raw().query<{ n: number }>(
    "SELECT count(*)::int AS n FROM oauth_grant_audit WHERE client_id = $1",
    [clientId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

describe("migration 110", () => {
  it("starts existing clients at revision 0 with an empty audit trail", async () => {
    const { clientId } = await register();
    expect(Number((await clientRow(clientId)).grant_revision)).toBe(0);
    expect(await auditCount(clientId)).toBe(0);
  });

  it("refuses an audit row with an unknown `via`", async () => {
    await expect(
      storage.raw().query(
        `INSERT INTO oauth_grant_audit (client_id, revision, actor, via, before, after)
         VALUES ('x', 1, 'a', 'web', '{}'::jsonb, '{}'::jsonb)`,
      ),
    ).rejects.toThrow();
  });
});

describe("grant snapshot + diff", () => {
  test("arrays are sorted and an empty fence reads as null", () => {
    const s = grantSnapshot({
      source_id: "acme",
      federated_read: ["beta", "acme"],
      bound_slug_prefixes: [],
      tenant_mode: null,
      scope: "write read",
    });
    expect(s).toEqual({
      source_id: "acme",
      federated_read: ["acme", "beta"],
      bound_slug_prefixes: null,
      tenant_mode: "client",
      scopes: ["read", "write"],
    });
  });

  test("the diff names exactly the fields that differ, order-insensitively", () => {
    const a = grantSnapshot({ source_id: "acme", federated_read: ["acme", "beta"], bound_slug_prefixes: null, tenant_mode: "client", scope: "read write" });
    const b = grantSnapshot({ source_id: "acme", federated_read: ["beta", "acme"], bound_slug_prefixes: ["inbox"], tenant_mode: "enrollment", scope: "write read" });
    const c = grantSnapshot({ source_id: "acme", federated_read: ["acme", "beta"], bound_slug_prefixes: null, tenant_mode: "client", scope: "read" });
    expect(grantDiff(a, a)).toEqual([]);
    expect(grantDiff(a, b)).toEqual(["bound_slug_prefixes", "tenant_mode"]);
    expect(grantDiff(a, c)).toEqual(["scopes"]);
  });
});

describe("rescopeClient — apply", () => {
  it("bumps the revision, updates the grant and writes one matching audit row", async () => {
    const { clientId } = await register();
    const res = await provider.rescopeClient(
      clientId,
      { sourceId: "acme", federatedRead: ["acme", "beta"], boundSlugPrefixes: ["inbox"], tenantMode: "enrollment" },
      { ...CLI, expectedRevision: 0 },
    );
    expect(res.revision).toBe(1);
    expect(res.dryRun).toBe(false);
    expect(res.changed).toEqual(["source_id", "federated_read", "bound_slug_prefixes", "tenant_mode"]);

    const row = await clientRow(clientId);
    expect(row.source_id).toBe("acme");
    expect(row.federated_read).toEqual(["acme", "beta"]);
    expect(row.bound_slug_prefixes).toEqual(["inbox"]);
    expect(row.tenant_mode).toBe("enrollment");
    expect(Number(row.grant_revision)).toBe(1);

    const history = await provider.listGrantAudit(clientId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ client_id: clientId, revision: 1, actor: "ops", via: "cli" });
    expect(history[0]!.before).toEqual({
      source_id: "default",
      federated_read: ["default"],
      bound_slug_prefixes: null,
      tenant_mode: "client",
      scopes: ["read", "write"],
    });
    expect(history[0]!.after).toEqual(res.after);

    const kinds = await storage.raw().query<{ b: string; a: string }>(
      "SELECT jsonb_typeof(before) AS b, jsonb_typeof(after) AS a FROM oauth_grant_audit WHERE client_id = $1",
      [clientId],
    );
    expect(kinds.rows[0]).toEqual({ b: "object", a: "object" });
  });

  it("records a no-op change too, so the attempt is on the record", async () => {
    const { clientId } = await register();
    const res = await provider.rescopeClient(clientId, { sourceId: "default" }, CLI);
    expect(res.changed).toEqual([]);
    expect(res.revision).toBe(1);
    expect(await auditCount(clientId)).toBe(1);
  });

  it("leaving expectedRevision out keeps last-writer-wins, still audited", async () => {
    const { clientId } = await register();
    await provider.rescopeClient(clientId, { sourceId: "acme" }, CLI);
    const res = await provider.rescopeClient(clientId, { sourceId: "beta" }, { actor: "admin", via: "admin_api" });
    expect(res.revision).toBe(2);
    const history = await provider.listGrantAudit(clientId);
    expect(history.map((h) => h.revision)).toEqual([2, 1]);
    expect(history[0]!.before.source_id).toBe("acme");
    expect(history[0]!.via).toBe("admin_api");
  });
});

describe("rescopeClient — revision conflicts", () => {
  it("of two concurrent rescopes at the same revision, exactly one wins", async () => {
    const { clientId } = await register();
    const results = await Promise.allSettled([
      provider.rescopeClient(clientId, { sourceId: "acme" }, { ...CLI, expectedRevision: 0 }),
      provider.rescopeClient(clientId, { sourceId: "beta" }, { ...CLI, expectedRevision: 0 }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const reason = (lost[0] as PromiseRejectedResult).reason as GrantConflictError;
    expect(reason).toBeInstanceOf(GrantConflictError);
    expect(reason.code).toBe("grant_conflict");
    expect(reason.expected).toBe(0);
    expect(reason.actual).toBe(1);

    const winner = (won[0] as PromiseFulfilledResult<{ after: { source_id: string | null } }>).value;
    const row = await clientRow(clientId);
    expect(row.source_id).toBe(winner.after.source_id);
    expect(Number(row.grant_revision)).toBe(1);
    expect(await auditCount(clientId)).toBe(1);
  });

  // PGLite serializes engine.transaction, so the test above passes with or
  // without the row lock. On Postgres (READ COMMITTED) the lock is what keeps
  // two writers at the same revision from both passing the check, so pin it
  // at the source level.
  it("the revision read inside rescopeClient locks the client row", () => {
    const src = readFileSync(join(import.meta.dir, "../src/core/oauth-provider.ts"), "utf8");
    const start = src.indexOf("async rescopeClient(");
    expect(start).toBeGreaterThan(-1);
    const read = src.indexOf("FROM oauth_clients", start);
    const check = src.indexOf("new GrantConflictError(", start);
    expect(read).toBeGreaterThan(start);
    expect(check).toBeGreaterThan(read);
    const lockedRead = src.slice(read, check);
    const end = lockedRead.indexOf("`");
    expect(end).toBeGreaterThan(-1);
    expect(lockedRead.slice(0, end).replace(/\s+/g, " ")).toContain("FOR UPDATE");
  });

  it("a later stale write fails and changes nothing", async () => {
    const { clientId } = await register();
    await provider.rescopeClient(clientId, { sourceId: "acme" }, { ...CLI, expectedRevision: 0 });
    await expect(
      provider.rescopeClient(clientId, { sourceId: "beta" }, { ...CLI, expectedRevision: 0 }),
    ).rejects.toThrow("grant_conflict");
    const row = await clientRow(clientId);
    expect(row.source_id).toBe("acme");
    expect(Number(row.grant_revision)).toBe(1);
    expect(await auditCount(clientId)).toBe(1);
  });

  it("a stale dry run is refused as well", async () => {
    const { clientId } = await register();
    await provider.rescopeClient(clientId, { sourceId: "acme" }, CLI);
    await expect(
      provider.rescopeClient(clientId, { sourceId: "beta" }, { ...CLI, expectedRevision: 0, dryRun: true }),
    ).rejects.toBeInstanceOf(GrantConflictError);
  });
});

describe("rescopeClient — dry run", () => {
  it("writes nothing, and its diff equals the audit diff of the apply that follows", async () => {
    const { clientId } = await register(["inbox"]);
    const change = { sourceId: "acme", federatedRead: ["beta", "acme"], boundSlugPrefixes: [] };
    const dry = await provider.rescopeClient(clientId, change, { ...CLI, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.revision).toBe(0);
    expect(dry.changed).toEqual(["source_id", "federated_read", "bound_slug_prefixes"]);
    const untouched = await clientRow(clientId);
    expect(untouched.source_id).toBe("default");
    expect(untouched.bound_slug_prefixes).toEqual(["inbox"]);
    expect(Number(untouched.grant_revision)).toBe(0);
    expect(await auditCount(clientId)).toBe(0);

    const applied = await provider.rescopeClient(clientId, change, { ...CLI, expectedRevision: dry.revision });
    const [audit] = await provider.listGrantAudit(clientId);
    expect(audit!.before).toEqual(dry.before);
    expect(audit!.after).toEqual(dry.after);
    expect(applied.changed).toEqual(dry.changed);
  });
});

describe("rescopeClient — validation", () => {
  async function reasonsOf(p: Promise<unknown>): Promise<string[]> {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(GrantValidationError);
      return (e as GrantValidationError).reasons.map((r) => r.code);
    }
    throw new Error("expected a validation failure");
  }

  it("rejects an unknown write source, an unknown read source and a bad prefix", async () => {
    const { clientId } = await register();
    expect(await reasonsOf(provider.rescopeClient(clientId, { sourceId: "ghost" }, CLI))).toEqual(["unknown_source"]);
    expect(
      await reasonsOf(provider.rescopeClient(clientId, { sourceId: "acme", federatedRead: ["acme", "ghost"] }, CLI)),
    ).toEqual(["unknown_source"]);
    expect(
      await reasonsOf(provider.rescopeClient(clientId, { sourceId: "acme", boundSlugPrefixes: ["NOT A SLUG"] }, CLI)),
    ).toEqual(["invalid_prefix"]);
    expect(await reasonsOf(provider.rescopeClient(clientId, { sourceId: "acme", federatedRead: [] }, CLI))).toContain(
      "empty_read_set",
    );
  });

  it("returns every reason at once and writes nothing", async () => {
    const { clientId } = await register();
    const codes = await reasonsOf(
      provider.rescopeClient(
        clientId,
        { sourceId: "ghost", federatedRead: ["phantom"], boundSlugPrefixes: ["Bad Prefix", "inbox"] },
        { ...CLI, expectedRevision: 0 },
      ),
    );
    expect(codes).toEqual(["unknown_source", "unknown_source", "invalid_prefix"]);
    const row = await clientRow(clientId);
    expect(row.source_id).toBe("default");
    expect(Number(row.grant_revision)).toBe(0);
    expect(await auditCount(clientId)).toBe(0);
  });
});

describe("rescopeClient — public clients", () => {
  it("refuses to move a public client into client mode while /authorize auto-approves", async () => {
    const saved = process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN;
    delete process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN;
    try {
      const reg = await provider.registerClientManual(
        "public-enroll",
        ["authorization_code", "refresh_token"],
        "read",
        ["https://client.example/cb"],
        "acme",
        undefined,
        "none",
        undefined,
        "enrollment",
      );
      const before = await auditCount(reg.clientId);
      await expect(
        provider.rescopeClient(reg.clientId, { sourceId: "acme", tenantMode: "client" }, CLI),
      ).rejects.toMatchObject({ reasons: [{ code: "public_client_mode" }] });
      expect((await clientRow(reg.clientId)).tenant_mode).toBe("enrollment");
      expect(await auditCount(reg.clientId)).toBe(before);

      process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN = "1";
      await provider.rescopeClient(reg.clientId, { sourceId: "acme", tenantMode: "client" }, CLI);
      expect((await clientRow(reg.clientId)).tenant_mode).toBe("client");
    } finally {
      if (saved === undefined) delete process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN;
      else process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN = saved;
    }
  });

  it("still moves a confidential client into client mode", async () => {
    const { clientId } = await register();
    await provider.rescopeClient(clientId, { sourceId: "acme", tenantMode: "enrollment" }, CLI);
    await provider.rescopeClient(clientId, { sourceId: "acme", tenantMode: "client" }, CLI);
    expect((await clientRow(clientId)).tenant_mode).toBe("client");
  });
});

describe("rescopeClient — missing clients", () => {
  it("unknown and revoked clients are not_found, with no audit row", async () => {
    await expect(provider.rescopeClient("memex_cl_missing", { sourceId: "acme" }, CLI)).rejects.toBeInstanceOf(
      GrantNotFoundError,
    );
    expect(await auditCount("memex_cl_missing")).toBe(0);

    const { clientId } = await register();
    await storage.raw().query("UPDATE oauth_clients SET deleted_at = now() WHERE client_id = $1", [clientId]);
    await expect(provider.rescopeClient(clientId, { sourceId: "acme" }, CLI)).rejects.toThrow("not_found");
    expect(await auditCount(clientId)).toBe(0);
  });
});

describe("rescopeClient — field semantics are unchanged", () => {
  it("fence: absent leaves it, [] clears it, a list replaces it; tenant mode left out stays", async () => {
    const { clientId } = await register(["inbox"]);
    await provider.rescopeClient(clientId, { sourceId: "default", tenantMode: "enrollment" }, CLI);
    let row = await clientRow(clientId);
    expect(row.bound_slug_prefixes).toEqual(["inbox"]);
    expect(row.tenant_mode).toBe("enrollment");

    await provider.rescopeClient(clientId, { sourceId: "default", boundSlugPrefixes: ["projects"] }, CLI);
    row = await clientRow(clientId);
    expect(row.bound_slug_prefixes).toEqual(["projects"]);
    expect(row.tenant_mode).toBe("enrollment");

    await provider.rescopeClient(clientId, { sourceId: "default", boundSlugPrefixes: [] }, CLI);
    expect((await clientRow(clientId)).bound_slug_prefixes).toBeNull();
  });

  it("a token issued before the rescope verifies with the new grant", async () => {
    const { clientId, clientSecret } = await register();
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret);
    const beforeInfo = await provider.verifyAccessToken(tokens.access_token);
    expect(beforeInfo.sourceId).toBe("default");

    await provider.rescopeClient(clientId, { sourceId: "acme", federatedRead: ["acme", "beta"] }, CLI);
    const afterInfo = await provider.verifyAccessToken(tokens.access_token);
    expect(afterInfo.sourceId).toBe("acme");
    expect(afterInfo.allowedSources).toEqual(["acme", "beta"]);
    expect(afterInfo.scopes).toEqual(beforeInfo.scopes);
    expect(afterInfo.clientId).toBe(clientId);
  });
});

describe("listGrantAudit", () => {
  it("returns newest first and honours the limit", async () => {
    const { clientId } = await register();
    for (const s of ["acme", "beta", "default"]) {
      await provider.rescopeClient(clientId, { sourceId: s }, CLI);
    }
    expect((await provider.listGrantAudit(clientId)).map((r) => r.revision)).toEqual([3, 2, 1]);
    expect((await provider.listGrantAudit(clientId, 2)).map((r) => r.revision)).toEqual([3, 2]);
    expect(await provider.listGrantAudit("memex_cl_missing")).toEqual([]);
  });
});

describe("setClientBudget — OAuth client", () => {
  const field = (snap: unknown, key: string): unknown => (snap as Record<string, unknown>)[key];

  it("bumps the revision and writes one audit row carrying the cap before and after", async () => {
    const { clientId } = await register();
    const rev = Number((await clientRow(clientId)).grant_revision);
    expect(await provider.setClientBudget(clientId, 2.5, { actor: "ops", via: "cli" })).toBe(true);
    expect(await provider.setClientBudget(clientId, null, { actor: "ops", via: "admin_api" })).toBe(true);

    expect(Number((await clientRow(clientId)).grant_revision)).toBe(rev + 2);
    const [cleared, set] = await provider.listGrantAudit(clientId);
    expect(set!.actor).toBe("ops");
    expect(set!.via).toBe("cli");
    expect(field(set!.before, "budget_usd_per_day")).toBeNull();
    expect(field(set!.after, "budget_usd_per_day")).toBe(2.5);
    expect(field(set!.after, "action")).toBe("set_budget");
    expect(set!.after.scopes).toEqual(["read", "write"]);
    expect(cleared!.via).toBe("admin_api");
    expect(field(cleared!.before, "budget_usd_per_day")).toBe(2.5);
    expect(field(cleared!.after, "budget_usd_per_day")).toBeNull();
  });

  it("writes nothing for a refused value", async () => {
    const { clientId } = await register();
    await expect(provider.setClientBudget(clientId, -1)).rejects.toThrow();
    expect(await auditCount(clientId)).toBe(0);
  });
});
