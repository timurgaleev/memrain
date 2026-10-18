/**
 * Admin data + provisioning endpoints (increment A2). Each route 401s without
 * an admin session, then wraps Memrain's tenant provisioning + brain stats.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { createAdminAuth } from "../src/http/admin.ts";
import { handleAdminApi, type AdminApiDeps } from "../src/http/admin-api.ts";
import { ADMIN_TOOL_RESPONSE_CAP, ADMIN_TOOLS, sanitizeAdminToolArgs } from "../src/http/admin-tool.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import { adminPanelSearchKnobs, dispatchTool } from "../src/mcp/dispatch.ts";
import { OPERATIONS } from "../src/mcp/operations.ts";
import { RateLimiter } from "../src/mcp/rate_limit.ts";
import { resolveSearchKnobs } from "../src/core/search/hybrid.ts";
import { __resetHotMemoryMetaCacheForTests } from "../src/core/hot-memory-meta.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";
import { _resetTelemetryWriterForTest, getTelemetryWriter } from "../src/core/search/telemetry.ts";
import { adminTimeseries, type AdminTimeseries } from "../src/core/admin-timeseries.ts";
import type { OnboardingStatus } from "../src/core/admin-onboarding.ts";
import { addLink, type GraphHubs } from "../src/core/links.ts";
import { deletePage, putPage, restorePage } from "../src/core/pages.ts";

const BOOT = "boot-secret";
let tmp: string;
let storage: Storage;
let auth: ReturnType<typeof createAdminAuth>;
let cookie: string;

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:8080${path}`, init);
}
async function call(
  path: string,
  init?: RequestInit,
  extra?: Pick<AdminApiDeps, "toolLimiter" | "embedQuery">,
): Promise<Response | null> {
  return handleAdminApi(req(path, init), new URL(`http://localhost:8080${path}`), {
    storage,
    requireAdmin: auth.requireAdmin,
    ...extra,
  });
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-adminapi-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  auth = createAdminAuth({ bootstrapToken: BOOT });
  const login = await auth.handleAuthRoute(
    req("/admin/login", { method: "POST", body: JSON.stringify({ token: BOOT }) }),
    new URL("http://localhost:8080/admin/login"),
  );
  cookie = (login!.headers.get("Set-Cookie") ?? "").split(";")[0]!;
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const authed = (extra?: RequestInit): RequestInit => ({ ...extra, headers: { ...(extra?.headers ?? {}), cookie } });

describe("admin-api auth gating", () => {
  it("401s every data route without a session", async () => {
    expect((await call("/admin/api/full-stats"))?.status).toBe(401);
    expect((await call("/admin/api/agents"))?.status).toBe(401);
    expect((await call("/admin/api/api-keys"))?.status).toBe(401);
    expect((await call("/admin/api/api-keys", { method: "POST", body: "{}" }))?.status).toBe(401);
    expect((await call("/admin/api/api-keys/revoke", { method: "POST", body: "{}" }))?.status).toBe(401);
    expect((await call("/admin/api/register-client", { method: "POST", body: "{}" }))?.status).toBe(401);
    expect((await call("/admin/api/update-client-ttl", { method: "POST", body: "{}" }))?.status).toBe(401);
    expect((await call("/admin/api/rescope-client", { method: "POST", body: "{}" }))?.status).toBe(401);
    expect((await call("/admin/api/grant-audit?client_id=x"))?.status).toBe(401);
    expect((await call("/admin/api/revoke-client", { method: "POST", body: "{}" }))?.status).toBe(401);
    expect((await call("/admin/api/timeseries"))?.status).toBe(401);
    expect((await call("/admin/api/graph/hubs"))?.status).toBe(401);
    expect((await call("/admin/api/onboarding"))?.status).toBe(401);
  });
  it("401s an unknown /admin/api path when unauthenticated (no path disclosure)", async () => {
    expect((await call("/admin/api/nope"))?.status).toBe(401);
  });
  it("refuses an authed mutating request from another origin", async () => {
    for (const path of ["/admin/api/api-keys", "/admin/api/revoke-grant", "/admin/api/set-redirect-uris"]) {
      const cross = await call(path, authed({ method: "POST", body: "{}", headers: { origin: "https://evil.localhost:8080" } }));
      expect(cross?.status).toBe(403);
      const sibling = await call(path, authed({ method: "POST", body: "{}", headers: { "sec-fetch-site": "same-site" } }));
      expect(sibling?.status).toBe(403);
    }
    const same = await call("/admin/api/api-keys", authed({ method: "POST", body: "{}", headers: { origin: "http://localhost:8080" } }));
    expect(same?.status).not.toBe(403);
    expect((await call("/admin/api/full-stats", authed({ headers: { origin: "https://evil.localhost:8080" } })))?.status).toBe(200);
  });
  it("returns null for an authed unknown /admin/api path (falls through to 404)", async () => {
    expect(await call("/admin/api/nope", authed())).toBeNull();
  });
});

describe("admin-api data routes (authed)", () => {
  it("full-stats returns health + corpus counts", async () => {
    const r = await call("/admin/api/full-stats", authed());
    expect(r?.status).toBe(200);
    const body = (await r!.json()) as { health: unknown; counts: { documents: number } | null };
    expect(body.health).toBeDefined();
    expect(body.counts).not.toBeNull();
  });

  it("full-stats?counts=0 returns health without the corpus counts", async () => {
    const r = await call("/admin/api/full-stats?counts=0", authed());
    expect(r?.status).toBe(200);
    const body = (await r!.json()) as { health: unknown; counts: unknown };
    expect(body.health).toBeDefined();
    expect(body.counts).toBeNull();
  });

  it("requests returns a paginated (empty) request log", async () => {
    const r = await call("/admin/api/requests?page=1", authed());
    expect(r?.status).toBe(200);
    const body = (await r!.json()) as { page: number; total: number; rows: unknown[] };
    expect(body.page).toBe(1);
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it("jobs/watch returns status counts + recent jobs", async () => {
    const e = storage.engine();
    await e.query(`INSERT INTO jobs (id, kind, status) VALUES ('j1','sweep','succeeded')`);
    const r = await call("/admin/api/jobs/watch", authed());
    expect(r?.status).toBe(200);
    const body = (await r!.json()) as { counts: { status: string; n: number }[]; recent: { kind: string }[] };
    expect(body.counts.find((c) => c.status === "succeeded")?.n).toBe(1);
    expect(body.recent[0]?.kind).toBe("sweep");
  });

  it("requests + jobs/watch 401 without a session", async () => {
    expect((await call("/admin/api/requests"))?.status).toBe(401);
    expect((await call("/admin/api/jobs/watch"))?.status).toBe(401);
  });

  it("calibration/profile returns null when none computed, gated when unauth", async () => {
    expect((await call("/admin/api/calibration/profile"))?.status).toBe(401);
    const r = await call("/admin/api/calibration/profile", authed());
    expect(r?.status).toBe(200);
    const body = (await r!.json()) as { profile: unknown };
    expect(body.profile).toBeNull(); // fresh brain — no synthesis calibration run yet
  });
});

interface AgentRow {
  auth_type: "oauth" | "api_key";
  id: string;
  name: string;
  scope: string | null;
  token_ttl: number | null;
  grant_revision: number | null;
  status: string;
  usage: { requests_today: number; total_requests: number; last_used_at: string | null };
}

describe("admin-api credential management (authed)", () => {
  it("mints, lists, and revokes an API key; the token verifies until revoked", async () => {
    const mint = await call("/admin/api/api-keys", authed({ method: "POST", body: JSON.stringify({ name: "key-1" }) }));
    expect(mint?.status).toBe(200);
    const minted = (await mint!.json()) as { ok: boolean; name: string; token: string };
    expect(minted.ok).toBe(true);
    expect(minted.token.startsWith("memrain_")).toBe(true);

    // Only the hash persists — the plaintext never touches the table.
    const stored = await storage.engine().query<{ token_hash: string }>(
      "SELECT token_hash FROM access_tokens WHERE name = 'key-1'",
    );
    expect(stored.rows[0]?.token_hash).not.toBe(minted.token);

    // The minted token authenticates through the legacy verify path.
    const provider = new OAuthProvider({ engine: storage.engine() });
    const info = await provider.verifyAccessToken(minted.token);
    expect(info.clientName).toBe("key-1");

    // A second active key with the same name is rejected.
    const dup = await call("/admin/api/api-keys", authed({ method: "POST", body: JSON.stringify({ name: "key-1" }) }));
    expect(dup?.status).toBe(400);

    // List shows it active.
    const list = await call("/admin/api/api-keys", authed());
    const listBody = (await list!.json()) as { count: number; keys: Array<{ name: string; status: string }> };
    expect(listBody.keys.find((k) => k.name === "key-1")?.status).toBe("active");

    // Revoke; the token stops verifying and a second revoke 404s.
    const rev = await call("/admin/api/api-keys/revoke", authed({ method: "POST", body: JSON.stringify({ name: "key-1" }) }));
    expect(rev?.status).toBe(200);
    await expect(provider.verifyAccessToken(minted.token)).rejects.toThrow();
    const again = await call("/admin/api/api-keys/revoke", authed({ method: "POST", body: JSON.stringify({ name: "key-1" }) }));
    expect(again?.status).toBe(404);
  });

  it("reports spend by model, feature and spender", async () => {
    await storage.engine().query(
      `INSERT INTO mcp_spend_log (client_id, operation, spend_cents, model, input_tokens, output_tokens)
       VALUES ('someone', 'think', 150, 'sonnet', 10, 5)`,
    );
    const ok = await call("/admin/api/spend/report?days=3", authed());
    expect(ok?.status).toBe(200);
    const body = (await ok!.json()) as { days: number; total_usd: number; by_client: { key: string }[] };
    expect(body.days).toBe(3);
    expect(body.total_usd).toBeCloseTo(1.5, 9);
    expect(body.by_client[0]?.key).toBe("someone");
    expect((await call("/admin/api/spend/report?days=0", authed()))?.status).toBe(400);
    expect((await call("/admin/api/spend/report"))?.status).toBe(401);
  });

  it("keeps a key's daily cap when the name is revoked and minted again", async () => {
    // Spend is booked under the name, so a fresh row with no cap would uncap it.
    const first = await call("/admin/api/api-keys", authed({ method: "POST", body: JSON.stringify({ name: "capped-key" }) }));
    expect(first?.status).toBe(200);
    const provider = new OAuthProvider({ engine: storage.engine() });
    expect(await provider.setClientBudget("capped-key", 1.5)).toBe(true);
    await call("/admin/api/api-keys/revoke", authed({ method: "POST", body: JSON.stringify({ name: "capped-key" }) }));

    const second = await call("/admin/api/api-keys", authed({ method: "POST", body: JSON.stringify({ name: "capped-key" }) }));
    const minted = (await second!.json()) as { token: string };
    expect((await provider.verifyAccessToken(minted.token)).budgetUsdPerDay).toBe(1.5);
  });

  it("registers an OAuth client with a token_ttl the exchange honors", async () => {
    const reg = await call(
      "/admin/api/register-client",
      authed({ method: "POST", body: JSON.stringify({ name: "agent-a", scopes: "read write", token_ttl: 120 }) }),
    );
    expect(reg?.status).toBe(200);
    const body = (await reg!.json()) as {
      ok: boolean;
      client_id: string;
      client_secret: string | null;
      grant_types: string[];
      token_ttl: number | null;
    };
    expect(body.client_id.startsWith("memrain_cl_")).toBe(true);
    expect(body.client_secret?.startsWith("memrain_cs_")).toBe(true);
    expect(body.grant_types).toEqual(["client_credentials"]); // no redirect_uris → machine client
    expect(body.token_ttl).toBe(120);

    // The half-wired TTL write side is closed: the exchange reads it back.
    const provider = new OAuthProvider({ engine: storage.engine() });
    const tokens = await provider.exchangeClientCredentials(body.client_id, body.client_secret!, "read");
    expect(tokens.expires_in).toBe(120);
  });

  it("defaults browser clients to authorization_code grants and 400s malformed input", async () => {
    const reg = await call(
      "/admin/api/register-client",
      authed({
        method: "POST",
        body: JSON.stringify({ name: "web", redirect_uris: ["https://example.com/cb"] }),
      }),
    );
    const body = (await reg!.json()) as { grant_types: string[] };
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);

    const badScope = await call(
      "/admin/api/register-client",
      authed({ method: "POST", body: JSON.stringify({ name: "x", scopes: ["read write"] }) }),
    );
    expect(badScope?.status).toBe(400); // space-in-element array shape

    const badTtl = await call(
      "/admin/api/register-client",
      authed({ method: "POST", body: JSON.stringify({ name: "x", token_ttl: -5 }) }),
    );
    expect(badTtl?.status).toBe(400);

    const ghostSource = await call(
      "/admin/api/register-client",
      authed({ method: "POST", body: JSON.stringify({ name: "x", source: "ghost" }) }),
    );
    expect(ghostSource?.status).toBe(400); // explicit source scope is validated

    const ghostRead = await call(
      "/admin/api/register-client",
      authed({ method: "POST", body: JSON.stringify({ name: "x", source: "default", read: ["default", "ghost"] }) }),
    );
    expect(ghostRead?.status).toBe(400); // every federated-read id is validated too
  });

  it("update-client-ttl sets and clears the override, 404s unknown clients", async () => {
    const reg = await call(
      "/admin/api/register-client",
      authed({ method: "POST", body: JSON.stringify({ name: "agent-b" }) }),
    );
    const { client_id } = (await reg!.json()) as { client_id: string };

    const set = await call(
      "/admin/api/update-client-ttl",
      authed({ method: "POST", body: JSON.stringify({ client_id, token_ttl: 900 }) }),
    );
    expect(set?.status).toBe(200);
    let row = await storage.engine().query<{ token_ttl: number | null }>(
      "SELECT token_ttl FROM oauth_clients WHERE client_id = $1",
      [client_id],
    );
    expect(Number(row.rows[0]?.token_ttl)).toBe(900);

    // null clears back to the server default.
    const clear = await call(
      "/admin/api/update-client-ttl",
      authed({ method: "POST", body: JSON.stringify({ client_id, token_ttl: null }) }),
    );
    expect(clear?.status).toBe(200);
    row = await storage.engine().query<{ token_ttl: number | null }>(
      "SELECT token_ttl FROM oauth_clients WHERE client_id = $1",
      [client_id],
    );
    expect(row.rows[0]?.token_ttl).toBeNull();

    const missing = await call(
      "/admin/api/update-client-ttl",
      authed({ method: "POST", body: JSON.stringify({ client_id: "nope", token_ttl: 60 }) }),
    );
    expect(missing?.status).toBe(404);

    const bad = await call(
      "/admin/api/update-client-ttl",
      authed({ method: "POST", body: JSON.stringify({ client_id, token_ttl: "soon" }) }),
    );
    expect(bad?.status).toBe(400);
  });

  it("rescope-client changes the tenancy grant; new tokens carry it", async () => {
    const reg = await call(
      "/admin/api/register-client",
      authed({ method: "POST", body: JSON.stringify({ name: "agent-e", scopes: "read" }) }),
    );
    const { client_id, client_secret } = (await reg!.json()) as { client_id: string; client_secret: string };

    await registerSource(storage.engine(), { id: "acme", kind: "other", pathPrefix: "/acme" });

    const res = await call(
      "/admin/api/rescope-client",
      authed({ method: "POST", body: JSON.stringify({ client_id, source: "acme" }) }),
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { ok: boolean; source_id: string; federated_read: string[] };
    expect(body.ok).toBe(true);
    expect(body.source_id).toBe("acme");
    expect(body.federated_read).toEqual(["acme"]); // read defaults to [source], like registration

    const row = await storage.engine().query<{ source_id: string; federated_read: string[] }>(
      "SELECT source_id, federated_read FROM oauth_clients WHERE client_id = $1",
      [client_id],
    );
    expect(row.rows[0]?.source_id).toBe("acme");
    expect(row.rows[0]?.federated_read).toEqual(["acme"]);

    // A token exchanged after the rescope carries the new scope.
    const provider = new OAuthProvider({ engine: storage.engine() });
    const tokens = await provider.exchangeClientCredentials(client_id, client_secret);
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.sourceId).toBe("acme");
    expect(info.allowedSources).toEqual(["acme"]);

    // Unknown source ids 400 — write source and read set alike.
    const ghost = await call(
      "/admin/api/rescope-client",
      authed({ method: "POST", body: JSON.stringify({ client_id, source: "ghost" }) }),
    );
    expect(ghost?.status).toBe(400);
    const ghostBody = (await ghost!.json()) as { error: string; reasons: { code: string; detail: string }[] };
    expect(ghostBody.error).toBe("invalid_grant");
    expect(ghostBody.reasons[0]?.code).toBe("unknown_source");
    expect(ghostBody.reasons[0]?.detail).toContain("ghost");
    const ghostRead = await call(
      "/admin/api/rescope-client",
      authed({ method: "POST", body: JSON.stringify({ client_id, source: "acme", read: ["acme", "ghost"] }) }),
    );
    expect(ghostRead?.status).toBe(400);

    const missing = await call(
      "/admin/api/rescope-client",
      authed({ method: "POST", body: JSON.stringify({ client_id: "nope", source: "acme" }) }),
    );
    expect(missing?.status).toBe(404);
  });

  it("rescope-client is revision-checked, previewable and audited", async () => {
    const reg = await call(
      "/admin/api/register-client",
      authed({ method: "POST", body: JSON.stringify({ name: "agent-g", scopes: "read" }) }),
    );
    const { client_id } = (await reg!.json()) as { client_id: string };
    await registerSource(storage.engine(), { id: "acme", kind: "other", pathPrefix: "/acme" });
    const rescope = (payload: Record<string, unknown>) =>
      call("/admin/api/rescope-client", authed({ method: "POST", body: JSON.stringify({ client_id, ...payload }) }));
    const revisionOf = async () =>
      Number(
        (
          await storage.engine().query<{ grant_revision: number }>(
            "SELECT grant_revision FROM oauth_clients WHERE client_id = $1",
            [client_id],
          )
        ).rows[0]?.grant_revision,
      );

    const dry = await rescope({ source: "acme", dry_run: true, bound_slug_prefixes: ["inbox"] });
    expect(dry?.status).toBe(200);
    const dryBody = (await dry!.json()) as { dry_run: boolean; revision: number; changed: string[] };
    expect(dryBody.dry_run).toBe(true);
    expect(dryBody.revision).toBe(0);
    expect(dryBody.changed).toEqual(["source_id", "federated_read", "bound_slug_prefixes"]);
    expect(await revisionOf()).toBe(0);

    const ok = await rescope({ source: "acme", expected_revision: 0, bound_slug_prefixes: ["inbox"], tenant_mode: "client" });
    expect(ok?.status).toBe(200);
    expect(((await ok!.json()) as { revision: number }).revision).toBe(1);

    const stale = await rescope({ source: "default", expected_revision: 0 });
    expect(stale?.status).toBe(409);
    expect(await stale!.json()).toEqual({ error: "grant_conflict", expected: 0, actual: 1 });
    expect(await revisionOf()).toBe(1);

    const invalid = await rescope({ source: "ghost", bound_slug_prefixes: ["NOT A SLUG"] });
    expect(invalid?.status).toBe(400);
    const invalidBody = (await invalid!.json()) as { error: string; reasons: { code: string }[] };
    expect(invalidBody.error).toBe("invalid_grant");
    expect(invalidBody.reasons.map((r) => r.code)).toEqual(["unknown_source", "invalid_prefix"]);

    for (const bad of [{ expected_revision: -1 }, { expected_revision: "0" }, { dry_run: "yes" }, { tenant_mode: "team" }]) {
      expect((await rescope({ source: "acme", ...bad }))?.status).toBe(400);
    }

    // null clears the fence.
    const cleared = await rescope({ source: "acme", bound_slug_prefixes: null, expected_revision: 1 });
    expect(((await cleared!.json()) as { after: { bound_slug_prefixes: unknown } }).after.bound_slug_prefixes).toBeNull();

    const audit = await call(`/admin/api/grant-audit?client_id=${client_id}`, authed());
    expect(audit?.status).toBe(200);
    const rows = ((await audit!.json()) as { rows: { revision: number; via: string; actor: string; before: unknown }[] }).rows;
    expect(rows.map((r) => r.revision)).toEqual([2, 1]);
    expect(rows[0]).toMatchObject({ via: "admin_api", actor: "admin" });
    expect(JSON.stringify(rows)).not.toContain("secret");

    expect((await call("/admin/api/grant-audit", authed()))?.status).toBe(400);
    expect((await call(`/admin/api/grant-audit?client_id=${client_id}`))?.status).toBe(401);
  });

  it("revoke-client soft-deletes and kills live tokens", async () => {
    const reg = await call(
      "/admin/api/register-client",
      authed({ method: "POST", body: JSON.stringify({ name: "agent-c", scopes: "read" }) }),
    );
    const { client_id, client_secret } = (await reg!.json()) as { client_id: string; client_secret: string };

    const provider = new OAuthProvider({ engine: storage.engine() });
    const tokens = await provider.exchangeClientCredentials(client_id, client_secret);
    await provider.verifyAccessToken(tokens.access_token); // live before revoke

    const rev = await call(
      "/admin/api/revoke-client",
      authed({ method: "POST", body: JSON.stringify({ client_id }) }),
    );
    expect(rev?.status).toBe(200);
    const revBody = (await rev!.json()) as { revoked: boolean; tokens_deleted: number };
    expect(revBody.revoked).toBe(true);
    expect(revBody.tokens_deleted).toBeGreaterThan(0);

    // Both the issued token and fresh exchanges are dead.
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    await expect(provider.exchangeClientCredentials(client_id, client_secret)).rejects.toThrow();

    const missing = await call(
      "/admin/api/revoke-client",
      authed({ method: "POST", body: JSON.stringify({ client_id: "nope" }) }),
    );
    expect(missing?.status).toBe(404);
  });

  it("agents view unifies OAuth clients + API keys with per-credential usage", async () => {
    const reg = await call(
      "/admin/api/register-client",
      authed({ method: "POST", body: JSON.stringify({ name: "agent-d", token_ttl: 60 }) }),
    );
    const { client_id } = (await reg!.json()) as { client_id: string };
    await call("/admin/api/api-keys", authed({ method: "POST", body: JSON.stringify({ name: "key-d" }) }));

    // Usage joins on token_name (the credential id the request logger stamps).
    await storage.engine().query(
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, status, created_at) VALUES
         ($1, 'caller', 'search', 'success', now()),
         ($1, 'caller', 'search', 'success', now() - interval '2 days'),
         ('key-d', 'caller', 'get_page', 'success', now()),
         ($1, 'caller', 'tools/list', 'success', now() + interval '1 minute'),
         ($1, 'caller', 'webhook_ingest', 'error', now() + interval '1 minute')`,
      [client_id],
    );

    const r = await call("/admin/api/agents", authed());
    expect(r?.status).toBe(200);
    const body = (await r!.json()) as { count: number; agents: AgentRow[] };
    const oauth = body.agents.find((a) => a.auth_type === "oauth" && a.id === client_id)!;
    const key = body.agents.find((a) => a.auth_type === "api_key" && a.name === "key-d")!;
    expect(oauth.status).toBe("active");
    expect(oauth.token_ttl).toBe(60);
    expect(oauth.grant_revision).toBe(0);
    expect(key.grant_revision).toBeNull();
    // Handshakes and webhook deliveries are not usage: counts and last-used skip them.
    expect(oauth.usage.total_requests).toBe(2);
    expect(oauth.usage.requests_today).toBe(1);
    expect(new Date(oauth.usage.last_used_at!).getTime()).toBeLessThanOrEqual(Date.now());
    expect(key.usage.total_requests).toBe(1);
    expect(key.usage.last_used_at).not.toBeNull();
  });
});

describe("admin-api observability endpoints", () => {
  it("agents/spend reports today's spend + pending vs cap", async () => {
    const e = storage.engine();
    await e.query(`INSERT INTO oauth_clients (client_id, client_name, budget_usd_per_day) VALUES ('c1','Client One',1.00)`);
    await e.query(`INSERT INTO mcp_spend_log (client_id, operation, spend_cents) VALUES ('c1', 'think', 50)`);
    await e.query(`INSERT INTO mcp_spend_reservations (reservation_id, client_id, estimated_cents, model, provider, status, expires_at) VALUES ('r1', 'c1', 20, 'm', 'p', 'pending', now() + interval '1 hour')`);
    const r = await call("/admin/api/agents/spend", authed());
    const body = (await r!.json()) as { agents: Record<string, unknown>[] };
    const row = body.agents.find((a) => a.client_id === "c1")!;
    expect(Number(row.spent_cents_today)).toBe(50);
    expect(Number(row.pending_cents)).toBe(20);
    expect(Number(row.cap_usd_per_day)).toBe(1);
  });

  it("requests filters by operation and returns redacted params", async () => {
    const e = storage.engine();
    await e.query(`INSERT INTO mcp_request_log (operation, status, params) VALUES ('search','success','{"q":"hi"}'::jsonb)`);
    await e.query(`INSERT INTO mcp_request_log (operation, status) VALUES ('page_put','success')`);
    const r = await call("/admin/api/requests?operation=search", authed());
    const body = (await r!.json()) as { rows: Record<string, unknown>[]; total: number };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.operation).toBe("search");
    expect(body.rows[0]?.params).toBeTruthy();
    expect(body.total).toBe(1);
  });

  it("stats + health-indicators return auth rollups", async () => {
    const e = storage.engine();
    await e.query(`INSERT INTO oauth_clients (client_id, client_name) VALUES ('c2','C2')`);
    await e.query(`INSERT INTO mcp_request_log (operation, status) VALUES ('x','error')`);
    const stats = (await (await call("/admin/api/stats", authed()))!.json()) as Record<string, number>;
    expect(stats.connected_agents).toBeGreaterThanOrEqual(1);
    expect(stats.requests_today).toBeGreaterThanOrEqual(1);
    const hi = (await (await call("/admin/api/health-indicators", authed()))!.json()) as Record<string, number>;
    expect(hi.error_rate_24h).toBeGreaterThan(0);
  });
});

describe("admin tool route", () => {
  const TOOL = "/admin/api/tool";
  const json = { "content-type": "application/json" };
  const post = (body: unknown, headers: Record<string, string> = json): RequestInit =>
    authed({ method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers });
  const tool = (name: string, args?: Record<string, unknown>, extra?: Pick<AdminApiDeps, "toolLimiter" | "embedQuery">) =>
    call(TOOL, post(args === undefined ? { name } : { name, arguments: args }), {
      embedQuery: deterministicEmbedQuery,
      ...extra,
    });
  const seedPage = async (slug: string, body = "Alice works on the graph explorer.") => {
    const r = await dispatchTool(storage, { name: "page_put", arguments: { slug, markdown_body: body } });
    expect(r.isError).toBeFalsy();
  };
  const seedDoc = async (id: string, text: string) => {
    await writeDocumentTransaction(
      storage,
      { documentId: id, sourcePath: `/${id}.md`, title: id, frontmatter: {}, embeddingModel: "deterministic-test" },
      [{ text, entities: [], embedding: deterministicEmbed(text) }],
    );
  };
  const withEnv = async (vars: Record<string, string>, run: () => Promise<void>) => {
    const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
      await run();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  const logRows = async (op: string, want: number) => {
    let rows: { agent_name: string | null; token_name: string | null; status: string }[] = [];
    for (let i = 0; i < 20; i++) {
      rows = (
        await storage.engine().query<{ agent_name: string | null; token_name: string | null; status: string }>(
          "SELECT agent_name, token_name, status FROM mcp_request_log WHERE operation = $1 ORDER BY id",
          [op],
        )
      ).rows;
      if (rows.length >= want) break;
      await Bun.sleep(50);
    }
    return rows;
  };

  it("B-T1 401s without a session and 403s a cross-origin POST", async () => {
    expect((await call(TOOL, { method: "POST", body: "{}", headers: json }))?.status).toBe(401);
    const cross = await call(TOOL, post({ name: "get_tags", arguments: { slug: "a" } }, { ...json, origin: "http://evil.example" }));
    expect(cross?.status).toBe(403);
  });

  it("B-T2 405s a GET", async () => {
    const r = await call(TOOL, authed());
    expect(r?.status).toBe(405);
    expect(await r!.json()).toEqual({ ok: false, error: "method_not_allowed" });
  });

  it("B-T3 accepts only the exact application/json media type", async () => {
    const body = { name: "get_tags", arguments: { slug: "notes/a" } };
    expect((await call(TOOL, post(body, {})))?.status).toBe(415);
    expect((await call(TOOL, post(body, { "content-type": "text/plain" })))?.status).toBe(415);
    const tricky = await call(TOOL, post(body, { "content-type": "text/plain; application/json" }));
    expect(tricky?.status).toBe(415);
    expect(await tricky!.json()).toEqual({ ok: false, error: "unsupported_media_type" });
    await seedPage("notes/a");
    const ok = await call(TOOL, post(body, { "content-type": "Application/JSON; charset=utf-8" }));
    expect(ok?.status).toBe(200);
  });

  it("B-T4 413s a declared or streamed body over the cap", async () => {
    const declared = await call(TOOL, post("{}", { ...json, "content-length": "20000" }));
    expect(declared?.status).toBe(413);
    const big = new TextEncoder().encode(`{"name":"get_tags","arguments":{"slug":"${"a".repeat(20_000)}"}}`);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < big.length; i += 4096) c.enqueue(big.slice(i, i + 4096));
        c.close();
      },
    });
    const streamed = await call(TOOL, authed({ method: "POST", body: stream, headers: json, duplex: "half" } as RequestInit));
    expect(streamed?.status).toBe(413);
  });

  it("B-T5 400s a malformed request body", async () => {
    const invalidJson = await call(TOOL, post("{nope", json));
    expect(invalidJson?.status).toBe(400);
    expect(((await invalidJson!.json()) as { error: string }).error).toBe("invalid_json");
    for (const body of [{ name: "get_tags", arguments: [] }, { name: "get_tags", arguments: null }, { name: 7 }, [], "str", null]) {
      const r = await call(TOOL, post(JSON.stringify(body)));
      expect(r?.status).toBe(400);
      expect(((await r!.json()) as { error: string }).error).toBe("invalid_request");
    }
  });

  it("B-T6 refuses every tool off the allowlist, prototype names included", async () => {
    for (const name of ["think", "jobs_submit", "jobs_cancel", "page_put", "query", "Search", "search ", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const r = await tool(name, {});
      expect(r?.status).toBe(403);
      expect(await r!.json()).toEqual({ ok: false, error: "tool_not_allowed" });
    }
  });

  it("B-T6 allowlist holds 18 read tools plus the two tag writes", () => {
    expect(ADMIN_TOOLS.size).toBe(18);
    for (const name of ADMIN_TOOLS) {
      const op = OPERATIONS.find((o) => o.name === name);
      expect(op).toBeDefined();
      if (name === "add_tag" || name === "remove_tag") expect(op!.scope).toBe("write");
      else expect(op!.scope).toBeUndefined();
    }
  });

  it("B-T7 sanitiser keeps listed keys, clamps numbers and drops the rest", () => {
    const s = sanitizeAdminToolArgs("search", { q: "alice", k: 1000, offset: -5, mode: "tokenmax", expand: true, explain: true, token_budget: 5 });
    expect(s).toEqual({ ok: true, args: { q: "alice", k: 20, offset: 0 } });
    expect(sanitizeAdminToolArgs("search", { q: "a", k: 3.9 })).toEqual({ ok: true, args: { q: "a", k: 3 } });
    expect(sanitizeAdminToolArgs("search", { q: "a", k: Number.NaN })).toEqual({ ok: true, args: { q: "a" } });
    expect(sanitizeAdminToolArgs("entity_recall", { slug: "people/alice", mode: "tokenmax", redact_body: false })).toEqual({
      ok: true,
      args: { slug: "people/alice" },
    });
    const proto = sanitizeAdminToolArgs("search", JSON.parse("{\"__proto__\":{\"polluted\":1},\"q\":\"x\"}") as Record<string, unknown>);
    expect(proto.ok).toBe(true);
    if (proto.ok) {
      expect(Object.hasOwn(proto.args, "__proto__")).toBe(false);
      expect(Object.getPrototypeOf(proto.args)).toBe(Object.prototype);
      expect((proto.args as Record<string, unknown>)["polluted"]).toBeUndefined();
    }
    const long = sanitizeAdminToolArgs("page_get", { slug: "a".repeat(600) });
    expect(long.ok).toBe(false);
    expect(sanitizeAdminToolArgs("page_list", { limit: "5", include_deleted: true })).toEqual({ ok: true, args: {} });
    expect(sanitizeAdminToolArgs("page_list", { sort: "random", limit: 500 })).toEqual({ ok: true, args: { limit: 50 } });
    expect(sanitizeAdminToolArgs("page_get", { slug: "a", fuzzy: "yes", include_deleted: true })).toEqual({ ok: true, args: { slug: "a" } });
    expect(sanitizeAdminToolArgs("recall", { id: "42" })).toEqual({ ok: true, args: { id: 42 } });
    expect(sanitizeAdminToolArgs("recall", { id: "0x2a" })).toEqual({ ok: true, args: {} });
    expect(sanitizeAdminToolArgs("recall", { id: 0 })).toEqual({ ok: true, args: { id: 1 } });
    expect(sanitizeAdminToolArgs("chronicle_day", { date: "2026-10-01", narrative: true })).toEqual({ ok: true, args: { date: "2026-10-01" } });
  });

  it("B-T7 rejects an over-long string through the route", async () => {
    const r = await tool("get_tags", { slug: "a".repeat(600) });
    expect(r?.status).toBe(400);
    expect(((await r!.json()) as { error: string }).error).toBe("invalid_arguments");
  });

  it("B-T8 strips include_deleted even with LENIENT args on", async () => {
    await seedPage("notes/gone");
    const del = await dispatchTool(storage, { name: "page_delete", arguments: { slug: "notes/gone" } });
    expect(del.isError).toBeFalsy();
    await withEnv({ MEMRAIN_MCP_LENIENT_ARGS: "1" }, async () => {
      const r = await tool("page_list", { include_deleted: true });
      expect(r?.status).toBe(200);
      const body = (await r!.json()) as { data: { pages: { slug: string }[] } };
      expect(body.data.pages.map((p) => p.slug)).not.toContain("notes/gone");
    });
  });

  it("B-T9 returns the page without _meta even with hot-memory meta on", async () => {
    await seedPage("people/alice");
    await storage.engine().query(
      `INSERT INTO entity_facts (entity_slug, fact, kind, source_id) VALUES ('people/alice', 'likes graphs', 'fact', 'default')`,
    );
    await withEnv({ MEMRAIN_HOT_MEMORY_META: "1" }, async () => {
      __resetHotMemoryMetaCacheForTests();
      const control = await dispatchTool(storage, { name: "page_get", arguments: { slug: "people/alice" } });
      expect(control._meta).toBeDefined();
      const panel = await dispatchTool(storage, { name: "page_get", arguments: { slug: "people/alice" } }, { adminPanel: true });
      expect(panel._meta).toBeUndefined();
      const r = await tool("page_get", { slug: "people/alice" });
      expect(r?.status).toBe(200);
      const body = (await r!.json()) as Record<string, unknown> & { ok: boolean; data: { ok: boolean; page: { slug: string } } };
      expect(body.ok).toBe(true);
      expect(body.data.ok).toBe(true);
      expect(body.data.page.slug).toBe("people/alice");
      expect(Object.keys(body).sort()).toEqual(["data", "ok"]);
      expect(JSON.stringify(body)).not.toContain("brain_hot_memory");
    });
    __resetHotMemoryMetaCacheForTests();
  });

  it("B-T10 panel page_get leaves last_retrieved_at alone; MCP page_get bumps it", async () => {
    await seedPage("notes/touch");
    const read = async () =>
      (await storage.engine().query<{ t: string | null }>("SELECT last_retrieved_at::text AS t FROM pages WHERE slug = 'notes/touch'")).rows[0]?.t ?? null;
    expect(await read()).toBeNull();
    expect((await tool("page_get", { slug: "notes/touch" }))?.status).toBe(200);
    expect(await read()).toBeNull();
    await dispatchTool(storage, { name: "page_get", arguments: { slug: "notes/touch" } }, {});
    expect(await read()).not.toBeNull();
  });

  it("B-T11 page_list rows carry no body or compiled truth", async () => {
    await seedPage("notes/listed");
    const r = await tool("page_list", { limit: 10 });
    expect(r?.status).toBe(200);
    const body = (await r!.json()) as { data: { pages: Record<string, unknown>[] } };
    expect(body.data.pages.length).toBeGreaterThan(0);
    for (const row of body.data.pages) {
      expect(row).not.toHaveProperty("markdown_body");
      expect(row).not.toHaveProperty("compiled_truth");
      expect(typeof row.slug).toBe("string");
    }
  });

  it("B-T12 maps tool errors to 422 without leaking raw text", async () => {
    const missing = await tool("page_get", {});
    expect(missing?.status).toBe(422);
    expect(((await missing!.json()) as { error: string }).error).toBe("invalid_params");
    const unknown = await tool("page_get", { slug: "notes/never-written" });
    expect(unknown?.status).toBe(422);
    expect(((await unknown!.json()) as { error: string }).error).toBe("not_found");
    // A plain-text failure (not an envelope) is reduced to a constant code.
    const plain = await tool("page_get", { slug: "Bad Slug!" });
    expect(plain?.status).toBe(422);
    expect(await plain!.json()).toEqual({ ok: false, error: "tool_error" });
  });

  it("B-T13 writes an audit row as admin-panel with no token name, flag off", async () => {
    const prev = process.env.MEMRAIN_REQUEST_LOG_DB;
    delete process.env.MEMRAIN_REQUEST_LOG_DB;
    try {
      await seedPage("notes/audited");
      expect((await tool("page_get", { slug: "notes/audited" }))?.status).toBe(200);
      expect((await tool("page_get", { slug: "notes/nope" }))?.status).toBe(422);
      const rows = await logRows("page_get", 2);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.agent_name === "admin-panel" && r.token_name === null)).toBe(true);
      expect(rows.map((r) => r.status)).toEqual(["success", "error"]);
    } finally {
      if (prev !== undefined) process.env.MEMRAIN_REQUEST_LOG_DB = prev;
    }
  });

  it("B-T13c audits refused calls: unknown tool, bad arguments, rate limit", async () => {
    const prev = process.env.MEMRAIN_REQUEST_LOG_DB;
    delete process.env.MEMRAIN_REQUEST_LOG_DB;
    try {
      expect((await tool("page_put", { slug: "x" }))?.status).toBe(403);
      expect((await tool("search", { q: "x".repeat(5000) }))?.status).toBe(400);
      const toolLimiter = new RateLimiter({ capacity: 0, refillPerSecond: 0 });
      expect((await tool("search", { q: "alice" }, { toolLimiter }))?.status).toBe(429);
      expect((await logRows("page_put", 1)).map((r) => [r.agent_name, r.status])).toEqual([["admin-panel", "error"]]);
      expect((await logRows("search", 2)).map((r) => r.status)).toEqual(["error", "error"]);
    } finally {
      if (prev !== undefined) process.env.MEMRAIN_REQUEST_LOG_DB = prev;
    }
  });

  it("B-T13b logs an oversized result as an error, not a success", async () => {
    const prev = process.env.MEMRAIN_REQUEST_LOG_DB;
    delete process.env.MEMRAIN_REQUEST_LOG_DB;
    try {
      await seedPage("notes/huge", "word ".repeat(ADMIN_TOOL_RESPONSE_CAP / 4));
      const r = await tool("page_get", { slug: "notes/huge" });
      expect(r?.status).toBe(422);
      expect(await r!.json()).toEqual({ ok: false, error: "response_too_large" });
      const rows = await logRows("page_get", 1);
      expect(rows.map((row) => row.status)).toEqual(["error"]);
    } finally {
      if (prev !== undefined) process.env.MEMRAIN_REQUEST_LOG_DB = prev;
    }
  });

  it("B-T14 rate-limits only the embedding calls", async () => {
    await seedPage("people/alice");
    const toolLimiter = new RateLimiter({ capacity: 1, refillPerSecond: 0 });
    expect((await tool("search", { q: "alice" }, { toolLimiter }))?.status).toBe(200);
    const limited = await tool("search", { q: "alice" }, { toolLimiter });
    expect(limited?.status).toBe(429);
    expect(limited!.headers.get("Retry-After")).toBe("2");
    expect(await limited!.json()).toEqual({ ok: false, error: "rate_limited", retry_after_s: 2 });
    expect((await tool("entity_recall", { slug: "people/alice", query: "graphs" }, { toolLimiter }))?.status).toBe(429);
    expect((await tool("entity_recall", { slug: "people/alice", query: "  " }, { toolLimiter }))?.status).toBe(200);
    expect((await tool("entity_recall", { slug: "people/alice" }, { toolLimiter }))?.status).toBe(200);
    expect((await tool("page_get", { slug: "people/alice" }, { toolLimiter }))?.status).toBe(200);
  });

  it("B-T14b a search the browser dropped skips its query embed", async () => {
    await seedDoc("doc_alice", "alice works on the graph explorer");
    let embeds = 0;
    const embedQuery = async (text: string) => {
      embeds++;
      return deterministicEmbedQuery(text);
    };
    const body = { name: "search", arguments: { q: "alice graph" } };
    const dropped = new AbortController();
    dropped.abort();
    const r = await call(TOOL, { ...post(body), signal: dropped.signal }, { embedQuery });
    expect(r?.status).toBe(499);
    expect(await r!.json()).toEqual({ ok: false, error: "client_aborted" });
    expect(embeds).toBe(0);
    expect((await call(TOOL, post(body), { embedQuery }))?.status).toBe(200);
    expect(embeds).toBe(1);
  });

  it("B-T15 search runs with every paid stage off under every paid env flag", async () => {
    await seedDoc("doc_alice", "alice works on the graph explorer");
    await withEnv(
      {
        MEMRAIN_INTENT_LLM: "1",
        MEMRAIN_GRAPH_RERANK: "1",
        MEMRAIN_RERANK: "1",
        MEMRAIN_QUERY_EXPANSION: "1",
        MEMRAIN_GRAPH_SIGNALS: "1",
        MEMRAIN_COSINE_RESCORE: "1",
        MEMRAIN_RELATIONAL_ARM: "1",
        MEMRAIN_SEARCH_MODE: "tokenmax",
      },
      async () => {
        const knobs = adminPanelSearchKnobs("who is alice");
        expect(knobs.intent).toBe("factual");
        const resolved = resolveSearchKnobs({ ...knobs });
        expect(resolved.rerankWanted).toBe(false);
        expect(resolved.graphRerankOn).toBe(false);
        expect(resolved.expansionEnabled).toBe(false);
        expect(resolved.graphSignalsOn).toBe(false);
        expect(resolved.cosineRescoreOn).toBe(false);
        expect(resolved.relationalArmOn).toBe(false);
        const r = await tool("search", { q: "alice graph explorer", mode: "tokenmax", expand: true });
        expect(r?.status).toBe(200);
        const body = (await r!.json()) as { ok: boolean; data: { ok: boolean; hits: unknown[]; meta?: { degraded: string[] } } };
        expect(body.data.ok).toBe(true);
        expect(body.data.hits.length).toBeGreaterThan(0);
        // Every paid stage books a reservation before it calls Bedrock, even one
        // that then fails for want of credentials.
        const booked = await storage.engine().query<{ n: number }>(
          `SELECT ((SELECT count(*) FROM mcp_spend_reservations) + (SELECT count(*) FROM mcp_spend_log))::int AS n`,
        );
        expect(booked.rows[0]?.n).toBe(0);
      },
    );
  });

  it("B-T16 panel searches are not captured as eval candidates", async () => {
    await seedDoc("doc_alice", "alice works on the graph explorer");
    const config = storage.config();
    expect(config).not.toBeNull();
    config!.evalCapture = { enabled: true };
    const count = async () =>
      Number((await storage.engine().query<{ n: number }>("SELECT count(*)::int AS n FROM eval_candidates")).rows[0]?.n ?? 0);
    expect((await tool("search", { q: "alice graph" }))?.status).toBe(200);
    expect(await count()).toBe(0);
    const control = await dispatchTool(storage, { name: "search", arguments: { q: "alice graph" } }, { embedQuery: deterministicEmbedQuery });
    expect(control.isError).toBeFalsy();
    expect(await count()).toBeGreaterThan(0);
  });

  it("B-T16b panel searches leave the query cache and search telemetry alone", async () => {
    await seedDoc("doc_alice", "alice works on the graph explorer");
    _resetTelemetryWriterForTest();
    const e = storage.engine();
    const counts = async () => {
      await getTelemetryWriter().flush();
      await new Promise((r) => setTimeout(r, 50));
      const r = await e.query<{ cache: number; tele: number }>(
        `SELECT (SELECT count(*) FROM query_cache)::int AS cache,
                (SELECT COALESCE(sum(count), 0) FROM search_telemetry)::int AS tele`,
      );
      return r.rows[0]!;
    };
    expect((await tool("search", { q: "alice graph" }))?.status).toBe(200);
    expect(await counts()).toEqual({ cache: 0, tele: 0 });
    const control = await dispatchTool(storage, { name: "search", arguments: { q: "alice graph" } }, { embedQuery: deterministicEmbedQuery });
    expect(control.isError).toBeFalsy();
    const after = await counts();
    expect(after.cache).toBeGreaterThan(0);
    expect(after.tele).toBeGreaterThan(0);
    _resetTelemetryWriterForTest();
  });

  it("B-T17 full-stats counts facts, entities and links", async () => {
    const r = await call("/admin/api/full-stats", authed());
    const body = (await r!.json()) as { counts: Record<string, unknown> };
    expect(typeof body.counts.facts).toBe("number");
    expect(typeof body.counts.entities).toBe("number");
    expect(typeof body.counts.links).toBe("number");
  });

  it("B-T18 panel log rows do not count as agent traffic or errors", async () => {
    const e = storage.engine();
    await e.query(`INSERT INTO mcp_request_log (agent_name, operation, status) VALUES (NULL, 'search', 'success')`);
    await e.query(`INSERT INTO mcp_request_log (token_name, agent_name, operation, status) VALUES ('pat-a', 'admin-panel', 'search', 'success')`);
    const read = async () => ({
      stats: (await (await call("/admin/api/stats", authed()))!.json()) as Record<string, number>,
      hi: (await (await call("/admin/api/health-indicators", authed()))!.json()) as Record<string, number>,
    });
    const before = await read();
    expect(before.stats.requests_today).toBe(2);
    expect(before.hi.error_rate_24h).toBe(0);
    await e.query(`INSERT INTO mcp_request_log (token_name, agent_name, operation, status) VALUES (NULL, 'admin-panel', 'page_get', 'error')`);
    const after = await read();
    expect(after.stats.requests_today).toBe(before.stats.requests_today);
    expect(after.hi.error_rate_24h).toBe(0);
    // Handshakes and webhook deliveries are not agent calls either.
    await e.query(`INSERT INTO mcp_request_log (token_name, agent_name, operation, status) VALUES ('pat-a', 'pat', 'tools/list', 'error')`);
    await e.query(`INSERT INTO mcp_request_log (token_name, agent_name, operation, status) VALUES ('pat-a', 'pat', 'webhook_ingest', 'error')`);
    const handshakes = await read();
    expect(handshakes.stats.requests_today).toBe(before.stats.requests_today);
    expect(handshakes.hi.error_rate_24h).toBe(0);
  });
});

describe("admin overview charts, graph hubs and onboarding", () => {
  const DAY = 86_400_000;
  const dayKey = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);
  const getJson = async <T>(path: string): Promise<T> => {
    const r = await call(path, authed());
    expect(r?.status).toBe(200);
    return (await r!.json()) as T;
  };
  const series = <T extends { day: string }>(rows: T[], daysAgo: number) => rows.find((r) => r.day === dayKey(daysAgo));
  const withEnv = async (vars: Record<string, string | undefined>, run: () => Promise<void>) => {
    const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await run();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it("timeseries rejects days outside 7, 30 and 90", async () => {
    for (const bad of ["0", "8", "367", "7.5", "abc", ""]) {
      const r = await call(`/admin/api/timeseries?days=${bad}`, authed());
      expect(r?.status).toBe(400);
      expect(await r!.json()).toEqual({ error: "days must be 7, 30 or 90" });
    }
    const body = await getJson<AdminTimeseries>("/admin/api/timeseries");
    expect(body.days).toBe(30);
    expect(body.buckets).toHaveLength(30);
  });

  it("timeseries returns exactly N zero-filled UTC buckets on an empty brain", async () => {
    const body = await getJson<AdminTimeseries>("/admin/api/timeseries?days=7");
    expect(body.days).toBe(7);
    expect(body.buckets).toHaveLength(7);
    expect([...body.buckets].sort()).toEqual(body.buckets);
    expect(body.buckets[6]).toBe(dayKey(0));
    expect(body.buckets[0]).toBe(dayKey(6));
    expect(body.since).toBe(`${dayKey(6)}T00:00:00.000Z`);
    for (const arr of [body.requests, body.searches, body.spend, body.content]) {
      expect(arr.map((r) => r.day)).toEqual(body.buckets);
    }
    expect(body.requests.every((r) => r.requests === 0 && r.errors === 0)).toBe(true);
    expect(body.searches.every((r) => r.searches === 0)).toBe(true);
    expect(body.spend.every((r) => r.usd === 0 && r.priced_calls === 0 && r.unpriced_calls === 0)).toBe(true);
    expect(body.content.every((r) => r.pages_created === 0 && r.page_edits === 0 && r.facts_added === 0)).toBe(true);
    const zero = { requests: 0, errors: 0, searches: 0, usd: 0, priced_calls: 0, unpriced_calls: 0, pages_created: 0, page_edits: 0, facts_added: 0 };
    expect(body.totals).toEqual(zero);
    expect(body.previous).toEqual(zero);
    expect(body.spend_models).toEqual([]);
    expect(body.top_tools).toEqual([]);
    expect(body.top_agents).toEqual([]);
    expect(body.request_log.rows_in_window).toBe(0);
    expect(body.corpus_now).toEqual({ pages: 0, facts: 0 });
  });

  it("timeseries counts agent requests by day and drops panel, handshake and webhook rows", async () => {
    const e = storage.engine();
    const row = (token: string | null, agent: string | null, op: string, status: string, ago: string) =>
      e.query(
        `INSERT INTO mcp_request_log (token_name, agent_name, operation, status, created_at)
         VALUES ($1, $2, $3, $4, now() - $5::interval)`,
        [token, agent, op, status, ago],
      );
    await row("pat-a", "pat", "search", "success", "0 seconds");
    await row("pat-a", "pat", "search", "success", "0 seconds");
    await row("pat-a", "pat", "page_get", "error", "0 seconds");
    await row("pat-x", "admin-panel", "page_get", "success", "0 seconds");
    await row("pat-a", "pat", "rate_limited", "error", "0 seconds");
    await row("pat-a", "pat", "search", "success", "2 days");
    await row("pat-a", "pat", "search", "success", "40 days");
    await row(null, "admin-panel", "search", "success", "0 seconds");
    await row("pat-a", "pat", "tools/list", "success", "0 seconds");
    await row("pat-a", "pat", "webhook_ingest", "success", "0 seconds");
    const body = await getJson<AdminTimeseries>("/admin/api/timeseries?days=7");
    expect(series(body.requests, 0)).toEqual({ day: dayKey(0), requests: 5, errors: 2 });
    expect(series(body.requests, 2)).toEqual({ day: dayKey(2), requests: 1, errors: 0 });
    expect(body.requests.reduce((s, r) => s + r.requests, 0)).toBe(6);
    expect(body.totals.requests).toBe(6);
    expect(body.totals.errors).toBe(2);
    expect(body.request_log.rows_in_window).toBe(6);
    expect(body.top_tools).toEqual([
      { operation: "search", calls: 3, errors: 0 },
      { operation: "page_get", calls: 2, errors: 1 },
      { operation: "rate_limited", calls: 1, errors: 1 },
    ]);
    expect(body.top_tools.reduce((s, t) => s + t.calls, 0)).toBe(body.totals.requests);
    const longer = await getJson<AdminTimeseries>("/admin/api/timeseries?days=90");
    expect(longer.totals.requests).toBe(7);
  });

  it("timeseries spend drops refused calls, counts unpriced rows separately and folds models beyond the top four into __other", async () => {
    const e = storage.engine();
    const spend = (model: string, cents: number | null, outcome: string | null = "ok") =>
      e.query(
        `INSERT INTO mcp_spend_log (client_id, operation, spend_cents, model, outcome) VALUES ('c', 'think', $1, $2, $3)`,
        [cents, model, outcome],
      );
    await spend("alpha", 600);
    await spend("other", 500);
    await spend("gamma", 400);
    await spend("delta", 300);
    await spend("eps", 200);
    await spend("zeta", 100);
    await spend("alpha", 9999, "refused");
    await spend("alpha", null);
    const body = await getJson<AdminTimeseries>("/admin/api/timeseries?days=7");
    expect(body.spend_models).toEqual([
      { key: "alpha", label: "alpha" },
      { key: "other", label: "other" },
      { key: "gamma", label: "gamma" },
      { key: "delta", label: "delta" },
      { key: "__other", label: "Other" },
    ]);
    const today = series(body.spend, 0)!;
    expect(today.by_model.__other).toBeCloseTo(3, 9);
    expect(today.by_model.other).toBeCloseTo(5, 9);
    expect(today.usd).toBeCloseTo(Object.values(today.by_model).reduce((s, v) => s + v, 0), 9);
    expect(today.usd).toBeCloseTo(21, 9);
    expect(today.priced_calls).toBe(6);
    expect(today.unpriced_calls).toBe(1);
    expect(body.totals.usd).toBeCloseTo(21, 9);
    expect(body.totals.priced_calls).toBe(6);
    expect(body.totals.unpriced_calls).toBe(1);
    expect(series(body.spend, 1)!.by_model).toEqual({ alpha: 0, other: 0, gamma: 0, delta: 0, __other: 0 });
  });

  it("timeseries content counts creations and edits as separate events", async () => {
    await putPage(storage, { slug: "notes/p", type: "note", markdown_body: "first" });
    await putPage(storage, { slug: "notes/p", type: "note", markdown_body: "second" });
    await deletePage(storage, "notes/p");
    await restorePage(storage, "notes/p");
    await putPage(storage, { slug: "notes/q", type: "note", markdown_body: "only" });
    await deletePage(storage, "notes/q");
    const e = storage.engine();
    await e.query(`INSERT INTO entity_facts (entity_slug, fact) VALUES ('people/alice', 'leads the launch')`);
    await e.query(`INSERT INTO entity_facts (entity_slug, fact, forgotten_at) VALUES ('people/alice', 'old claim', now())`);
    const body = await getJson<AdminTimeseries>("/admin/api/timeseries?days=7");
    expect(series(body.content, 0)).toEqual({ day: dayKey(0), pages_created: 2, page_edits: 1, facts_added: 2 });
    expect(body.totals.pages_created).toBe(2);
    expect(body.totals.page_edits).toBe(1);
    expect(body.totals.facts_added).toBe(2);
    expect(body.corpus_now).toEqual({ pages: 1, facts: 1 });
  });

  it("timeseries previous window has the same length and cutoff", async () => {
    const e = storage.engine();
    const at = async (iso: string) => {
      await e.query(`INSERT INTO mcp_request_log (token_name, agent_name, operation, status, created_at) VALUES ('t', 'a', 'search', 'success', $1::timestamptz)`, [iso]);
      await e.query(`INSERT INTO mcp_spend_log (client_id, operation, spend_cents, model, outcome, created_at) VALUES ('c', 'think', 100, 'm', 'ok', $1::timestamptz)`, [iso]);
    };
    await at("2026-03-03T00:20:00Z");
    await at("2026-03-03T00:40:00Z");
    await at("2026-03-04T00:10:00Z");
    const early = await adminTimeseries(e, { days: 7, now: new Date("2026-03-10T00:30:00Z") });
    expect(early.since).toBe("2026-03-04T00:00:00.000Z");
    expect(early.totals.requests).toBe(1);
    expect(early.previous.requests).toBe(1);
    expect(early.totals.usd).toBeCloseTo(1, 9);
    expect(early.previous.usd).toBeCloseTo(1, 9);

    await at("2026-03-03T11:50:00Z");
    await at("2026-03-03T12:10:00Z");
    const midday = await adminTimeseries(e, { days: 7, now: new Date("2026-03-10T12:00:00Z") });
    expect(midday.totals.requests).toBe(1);
    // 00:20, 00:40 and 11:50 on 03-03 fall before the 12:00 cutoff; 12:10 does not.
    expect(midday.previous.requests).toBe(3);
    expect(midday.previous.priced_calls).toBe(3);
  });

  it("timeseries reads searches from search_telemetry by date", async () => {
    const e = storage.engine();
    const tele = (date: string, mode: string, intent: string, count: number) =>
      e.query(`INSERT INTO search_telemetry (date, mode, intent, count) VALUES ($1, $2, $3, $4)`, [date, mode, intent, count]);
    await tele(dayKey(0), "hybrid", "general", 3);
    await tele(dayKey(0), "keyword", "entity", 2);
    await tele(dayKey(1), "hybrid", "general", 4);
    await tele(dayKey(1), "keyword", "entity", 1);
    await tele(dayKey(8), "hybrid", "general", 6);
    await tele(dayKey(7), "hybrid", "general", 50);
    const body = await getJson<AdminTimeseries>("/admin/api/timeseries?days=7");
    expect(series(body.searches, 0)?.searches).toBe(5);
    expect(series(body.searches, 1)?.searches).toBe(5);
    expect(body.totals.searches).toBe(5);
    // The previous period's partial day (7 days ago) is left out like today's.
    expect(body.previous.searches).toBe(6);
  });

  it("timeseries top agents show the OAuth client name, not its id", async () => {
    const e = storage.engine();
    await e.query(`INSERT INTO oauth_clients (client_id, client_name) VALUES ('memrain_cl_live', 'Desk Agent')`);
    await e.query(`INSERT INTO oauth_clients (client_id, client_name, deleted_at) VALUES ('memrain_cl_gone', 'Old Agent', now())`);
    const row = (token: string, n: number) =>
      e.query(
        `INSERT INTO mcp_request_log (token_name, agent_name, operation, status)
         SELECT $1, $1, 'search', 'success' FROM generate_series(1, $2::int)`,
        [token, n],
      );
    await row("memrain_cl_live", 3);
    await row("memrain_cl_gone", 2);
    await row("pat-z", 1);
    const body = await getJson<AdminTimeseries>("/admin/api/timeseries?days=7");
    expect(body.top_agents).toEqual([
      { id: "memrain_cl_live", agent: "Desk Agent", calls: 3 },
      { id: "memrain_cl_gone", agent: "Old Agent", calls: 2 },
      { id: "pat-z", agent: "pat-z", calls: 1 },
    ]);
  });

  const page = (slug: string) => putPage(storage, { slug, type: "note", title: slug.toUpperCase(), markdown_body: "plain text" });
  const link = (s: string, t: string) => addLink(storage, { source_slug: s, target_slug: t, type: "mentions" });

  it("graph hubs counts only links between visible pages", async () => {
    for (const s of ["notes/a", "notes/b", "notes/c", "notes/d"]) await page(s);
    await link("notes/a", "notes/b");
    await link("notes/c", "notes/b");
    await link("notes/b", "notes/d");
    await link("notes/a", "notes/x");
    await link("notes/b", "notes/c");
    await deletePage(storage, "notes/d");
    const body = await getJson<GraphHubs>("/admin/api/graph/hubs");
    expect(body.hubs.map((h) => h.slug)).toEqual(["notes/b", "notes/c", "notes/a"]);
    expect(body.hubs[0]).toEqual({ slug: "notes/b", title: "NOTES/B", type: "note", in_degree: 2, out_degree: 1, degree: 3 });
    expect(body.hubs[1]).toMatchObject({ in_degree: 1, out_degree: 1, degree: 2 });
    expect(body.hubs[2]).toMatchObject({ in_degree: 0, out_degree: 1, degree: 1 });
    expect(body.total_links).toBe(3);
    expect(body.linked_pages).toBe(3);
    expect(body.total_pages).toBe(3);

    for (const s of ["notes/e", "notes/f"]) await page(s);
    await link("notes/e", "notes/f");
    const tied = await getJson<GraphHubs>("/admin/api/graph/hubs");
    // Equal degree orders by in-degree, then by slug.
    expect(tied.hubs.map((h) => h.slug)).toEqual(["notes/b", "notes/c", "notes/f", "notes/a", "notes/e"]);
  });

  it("graph hubs on a brain with no links", async () => {
    await page("notes/lonely");
    const body = await getJson<GraphHubs>("/admin/api/graph/hubs");
    expect(body).toEqual({ hubs: [], linked_pages: 0, total_links: 0, total_pages: 1 });
  });

  it("graph hubs clamps limit and rejects a non-integer", async () => {
    for (let i = 0; i < 60; i++) await page(`notes/n${i}`);
    for (let i = 0; i < 59; i++) await link(`notes/n${i}`, `notes/n${i + 1}`);
    expect((await getJson<GraphHubs>("/admin/api/graph/hubs")).hubs).toHaveLength(20);
    expect((await getJson<GraphHubs>("/admin/api/graph/hubs?limit=500")).hubs).toHaveLength(50);
    expect((await getJson<GraphHubs>("/admin/api/graph/hubs?limit=0")).hubs).toHaveLength(1);
    for (const bad of ["abc", "7.5", ""]) {
      const r = await call(`/admin/api/graph/hubs?limit=${bad}`, authed());
      expect(r?.status).toBe(400);
      expect(await r!.json()).toEqual({ error: "limit must be a whole number from 1 to 50" });
    }
  });

  it("onboarding on a fresh brain reports every step undone", async () => {
    await withEnv({ MEMRAIN_PUBLIC_URL: "https://brain.example.com" }, async () => {
      const body = await getJson<OnboardingStatus>("/admin/api/onboarding");
      expect(body).toEqual({
        mcp_url: "https://brain.example.com/mcp",
        public_url_set: true,
        steps: {
          credential: { done: false },
          agent_connected: { done: false, last_seen: null },
          first_page: { done: false, pages: 0 },
          first_search: { done: false, source: null },
        },
      });
    });
    await withEnv({ MEMRAIN_PUBLIC_URL: undefined }, async () => {
      const body = await getJson<OnboardingStatus>("/admin/api/onboarding");
      expect(body.mcp_url).toBe("http://localhost:8080/mcp");
      expect(body.public_url_set).toBe(false);
    });
  });

  it("onboarding marks each step done from real rows", async () => {
    const e = storage.engine();
    await e.query(
      `INSERT INTO access_tokens (name, token_hash, last_used_at) VALUES ('laptop', 'h1', '2026-01-02T03:04:05Z')`,
    );
    await page("notes/first");
    await e.query(`INSERT INTO search_telemetry (date, mode, intent, count) VALUES ($1, 'hybrid', 'general', 1)`, [dayKey(0)]);
    const body = await getJson<OnboardingStatus>("/admin/api/onboarding");
    expect(body.steps).toEqual({
      credential: { done: true },
      agent_connected: { done: true, last_seen: "2026-01-02T03:04:05.000Z" },
      first_page: { done: true, pages: 1 },
      first_search: { done: true, source: "any" },
    });
    await e.query(
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, status, created_at)
       VALUES ('laptop', 'pat', 'search', 'success', '2026-02-01T00:00:00Z')`,
    );
    const after = await getJson<OnboardingStatus>("/admin/api/onboarding");
    expect(after.steps.first_search.source).toBe("agent");
    expect(after.steps.agent_connected.last_seen).toBe("2026-02-01T00:00:00.000Z");
  });

  it("onboarding ignores failed calls and keeps a revoked credential's history", async () => {
    const e = storage.engine();
    await e.query(`INSERT INTO mcp_request_log (token_name, agent_name, operation, status) VALUES ('pat-q', 'pat', 'search', 'error')`);
    await e.query(`INSERT INTO mcp_request_log (token_name, agent_name, operation, status) VALUES (NULL, 'admin-panel', 'search', 'success')`);
    const failed = await getJson<OnboardingStatus>("/admin/api/onboarding");
    expect(failed.steps.agent_connected).toEqual({ done: false, last_seen: null });
    expect(failed.steps.first_search).toEqual({ done: false, source: null });

    await e.query(
      `INSERT INTO access_tokens (name, token_hash, last_used_at, revoked_at)
       VALUES ('gone', 'h2', '2026-01-05T00:00:00Z', '2026-01-06T00:00:00Z')`,
    );
    const revoked = await getJson<OnboardingStatus>("/admin/api/onboarding");
    expect(revoked.steps.agent_connected.done).toBe(true);
    expect(revoked.steps.credential.done).toBe(false);
  });

  it("onboarding keeps progress after the first page is deleted and the client revoked", async () => {
    const e = storage.engine();
    await page("notes/only");
    await e.query(`INSERT INTO oauth_clients (client_id, client_name) VALUES ('memrain_cl_r', 'Gone Agent')`);
    await e.query(
      `INSERT INTO mcp_request_log (token_name, agent_name, operation, status, created_at)
       VALUES ('memrain_cl_r', 'memrain_cl_r', 'page_get', 'success', '2026-03-01T00:00:00Z')`,
    );
    await e.query(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/only'`);
    await e.query(`UPDATE oauth_clients SET deleted_at = now() WHERE client_id = 'memrain_cl_r'`);
    const body = await getJson<OnboardingStatus>("/admin/api/onboarding");
    expect(body.steps.first_page).toEqual({ done: true, pages: 0 });
    expect(body.steps.agent_connected).toEqual({ done: true, last_seen: "2026-03-01T00:00:00.000Z" });
    expect(body.steps.credential.done).toBe(false);
  });

  it("onboarding counts a completed OAuth sign-in as a connection", async () => {
    const e = storage.engine();
    await e.query(`INSERT INTO oauth_clients (client_id, client_name) VALUES ('memrain_cl_o', 'Web Agent')`);
    const before = await getJson<OnboardingStatus>("/admin/api/onboarding");
    expect(before.steps.credential.done).toBe(true);
    expect(before.steps.agent_connected.done).toBe(false);
    await e.query(
      `INSERT INTO oauth_tokens (token_hash, token_type, client_id, created_at) VALUES ('th', 'access', 'memrain_cl_o', '2026-01-09T00:00:00Z')`,
    );
    const after = await getJson<OnboardingStatus>("/admin/api/onboarding");
    expect(after.steps.agent_connected).toEqual({ done: true, last_seen: "2026-01-09T00:00:00.000Z" });
  });

  it("requests response carries db_enabled", async () => {
    await withEnv({ MEMRAIN_REQUEST_LOG_DB: undefined }, async () => {
      const off = await getJson<{ db_enabled: boolean }>("/admin/api/requests");
      expect(off.db_enabled).toBe(false);
    });
    await withEnv({ MEMRAIN_REQUEST_LOG_DB: "1" }, async () => {
      const on = await getJson<{ db_enabled: boolean }>("/admin/api/requests");
      expect(on.db_enabled).toBe(true);
      const ts = await getJson<AdminTimeseries>("/admin/api/timeseries?days=7");
      expect(ts.request_log.db_enabled).toBe(true);
    });
  });

  it("requests and timeseries carry the request-log retention window", async () => {
    await withEnv({ MEMRAIN_REQUEST_LOG_RETENTION_DAYS: undefined }, async () => {
      const r = await getJson<{ retention_days: number | null }>("/admin/api/requests");
      expect(r.retention_days).toBe(180);
      const ts = await getJson<AdminTimeseries>("/admin/api/timeseries?days=7");
      expect(ts.request_log.retention_days).toBe(180);
    });
    await withEnv({ MEMRAIN_REQUEST_LOG_RETENTION_DAYS: "0" }, async () => {
      const r = await getJson<{ retention_days: number | null }>("/admin/api/requests");
      expect(r.retention_days).toBeNull();
      const ts = await getJson<AdminTimeseries>("/admin/api/timeseries?days=7");
      expect(ts.request_log.retention_days).toBeNull();
    });
  });
});
