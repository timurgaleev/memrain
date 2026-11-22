/**
 * The admin grant editor over HTTP: preview (`dry_run`) answers the plan, what
 * it widens and a keyed `plan_hash`; apply goes through only when the revision
 * and the plan recomputed under the row lock both still match, and a widening
 * apply needs a passkey step-up from the last five minutes.
 *
 * Driven through createAdminAuth with real passkey ceremonies (software
 * authenticator) and a real admin session cookie, the way the panel calls it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { Storage } from "../src/core/storage.ts";
import { createAdminAuth, type AdminAuth } from "../src/http/admin.ts";
import { handleAdminApi, type AdminApiDeps } from "../src/http/admin-api.ts";
import { grantPlanCanonical, OAuthProvider, type ClientGrantSnapshot } from "../src/core/oauth-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import { setCredentialMinTrust } from "../src/core/token-min-trust.ts";
import { SoftAuthenticator } from "./helpers/soft-authenticator.ts";

const BOOT = "boot-secret-token-for-grant-editor-tests";
const ORIGIN = "https://brain.example.com";
const RP_ID = "brain.example.com";
const INTERNAL = "http://brain.example.com";
const MIN = 60_000;
const HOUR = 60 * MIN;

let tmp: string;
let storage: Storage;
let auth: AdminAuth;
let clock: number;
let clientId: string;

function tick(ms: number): void {
  clock += ms;
  setSystemTime(new Date(clock));
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-grant-editor-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: "acme", kind: "other", pathPrefix: "/acme" });
  await registerSource(storage.engine(), { id: "beta", kind: "other", pathPrefix: "/beta" });
});
afterAll(async () => {
  setSystemTime();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const TABLES = ["admin_auth_events", "admin_setup_links", "admin_recovery_codes", "admin_passkeys", "admin_owner"];
beforeEach(async () => {
  for (const t of TABLES) await storage.engine().query(`DELETE FROM ${t}`);
  clock = Date.now();
  setSystemTime(new Date(clock));
  auth = createAdminAuth({ bootstrapToken: BOOT, publicUrl: ORIGIN, storage });
  const reg = await new OAuthProvider({ engine: storage.engine() }).registerClientManual(
    "editor-agent",
    ["client_credentials"],
    "read write",
    [],
    "default",
  );
  clientId = reg.clientId;
  // A client issued from a narrowed preset: starter surface, $2.00/day, member floor.
  await storage.engine().query(
    `UPDATE oauth_clients SET tool_surface = 'starter', budget_usd_per_day = 2.00, min_trust = 'member' WHERE client_id = $1`,
    [clientId],
  );
});
afterEach(() => setSystemTime());

type Deps = Partial<Pick<AdminApiDeps, "sessionFresh" | "signGrantPlan">>;

class Browser {
  jar = new Map<string, string>();
  constructor(
    readonly origin: string = ORIGIN,
    readonly deps: () => Deps = () => ({ sessionFresh: auth.sessionFresh, signGrantPlan: auth.signGrantPlan }),
  ) {}

  absorb(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0") || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async call(path: string, body?: unknown): Promise<Response> {
    const method = body === undefined ? "GET" : "POST";
    const headers: Record<string, string> = { "cf-connecting-ip": "198.51.100.7" };
    if (method !== "GET") {
      headers.origin = this.origin;
      headers["content-type"] = "application/json";
    }
    if (this.jar.size > 0) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const req = new Request(`${INTERNAL}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const url = new URL(req.url);
    const res = (await auth.handleAuthRoute(req, url))
      ?? (await handleAdminApi(req, url, {
        storage,
        requireAdmin: auth.requireAdmin,
        sessionCooldown: auth.sessionCooldown,
        publicUrl: ORIGIN,
        ...this.deps(),
      }))
      ?? new Response("Not Found", { status: 404 });
    this.absorb(res);
    return res;
  }
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.clone().json()) as Record<string, unknown>;
}

async function bearerLink(): Promise<string> {
  const req = new Request(`${INTERNAL}/admin/api/setup-links`, { method: "POST", headers: { authorization: `Bearer ${BOOT}` } });
  const res = (await auth.handleAuthRoute(req, new URL(req.url)))!;
  expect(res.status).toBe(200);
  const url = ((await res.json()) as { url: string }).url;
  return url.slice(url.indexOf("#enroll/") + "#enroll/".length);
}

/** Owner enrolled from a setup link, past the cooldown, signed in again: a passkey session with no step-up yet. */
async function passkeyOwner(): Promise<{ b: Browser; soft: SoftAuthenticator }> {
  const first = new Browser();
  const soft = new SoftAuthenticator(ORIGIN, RP_ID);
  expect((await first.call("/admin/api/passkey/enroll/redeem", { token: await bearerLink() })).status).toBe(200);
  const reg = await first.call("/admin/api/passkey/register/options", {});
  const regOpts = ((await reg.json()) as { optionsJSON: PublicKeyCredentialCreationOptionsJSON }).optionsJSON;
  expect((await first.call("/admin/api/passkey/register/verify", { response: soft.register(regOpts), label: "Laptop" })).status).toBe(200);
  tick(25 * HOUR);
  const b = new Browser();
  const lo = await b.call("/admin/api/passkey/login/options", {});
  const loOpts = ((await lo.json()) as { optionsJSON: PublicKeyCredentialRequestOptionsJSON }).optionsJSON;
  expect((await b.call("/admin/api/passkey/login/verify", { response: soft.assert(loOpts) })).status).toBe(200);
  return { b, soft };
}

async function stepUp(b: Browser, soft: SoftAuthenticator): Promise<void> {
  const res = await b.call("/admin/api/passkey/reauth/options", {});
  const opts = ((await res.json()) as { optionsJSON: PublicKeyCredentialRequestOptionsJSON }).optionsJSON;
  expect((await b.call("/admin/api/passkey/reauth/verify", { response: soft.assert(opts) })).status).toBe(200);
}

/** A bootstrap-token session (no passkey involved). */
async function operator(deps?: () => Deps): Promise<Browser> {
  const b = deps ? new Browser(ORIGIN, deps) : new Browser();
  expect((await b.call("/admin/login", { token: BOOT })).status).toBe(200);
  return b;
}

interface ClientState {
  revision: number;
  audits: number;
  row: Record<string, unknown>;
}

async function state(): Promise<ClientState> {
  const r = await storage.engine().query<Record<string, unknown>>(
    `SELECT source_id, federated_read, scope, tool_surface, budget_usd_per_day::float8 AS budget_usd_per_day, min_trust, grant_revision
       FROM oauth_clients WHERE client_id = $1`,
    [clientId],
  );
  const a = await storage.engine().query<{ n: number }>("SELECT count(*)::int AS n FROM oauth_grant_audit WHERE client_id = $1", [clientId]);
  const row = r.rows[0]!;
  return { revision: Number(row.grant_revision), audits: Number(a.rows[0]!.n), row };
}

interface Preview {
  revision: number;
  plan_hash: string;
  widens: string[];
  changed: string[];
  before: ClientGrantSnapshot;
  after: ClientGrantSnapshot;
}

async function preview(b: Browser, change: Record<string, unknown>, revision = 0): Promise<Preview> {
  const res = await b.call("/admin/api/rescope-client", { client_id: clientId, ...change, expected_revision: revision, dry_run: true });
  expect(res.status).toBe(200);
  return (await res.json()) as Preview;
}

function apply(b: Browser, change: Record<string, unknown>, p: Pick<Preview, "revision" | "plan_hash">): Promise<Response> {
  return b.call("/admin/api/rescope-client", { client_id: clientId, ...change, expected_revision: p.revision, plan_hash: p.plan_hash });
}

const WIDEN = { source: "acme", read: ["acme"], tool_surface: "full", budget_usd_per_day: 5, min_trust: "agent" };
const NARROW = { tool_surface: "verbs", budget_usd_per_day: 1, min_trust: "owner" };

describe("preview", () => {
  // protects: a preview writes nothing and reports exactly what an apply would change.
  // fails_when: the dry run writes, or omits a field, the widening list or the hash.
  it("lists exactly the changed fields, what widens and a plan hash, and writes nothing", async () => {
    const b = await operator();
    const before = await state();
    const p = await preview(b, WIDEN);
    expect(p.changed).toEqual(["source_id", "federated_read", "tool_surface", "budget_usd_per_day", "min_trust"]);
    expect(p.widens).toEqual(["federated_read", "source_id", "tool_surface", "budget_usd_per_day", "min_trust"]);
    expect(p.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.before).toMatchObject({ tool_surface: "starter", budget_usd_per_day: 2, min_trust: "member" });
    expect(p.after).toMatchObject({ source_id: "acme", tool_surface: "full", budget_usd_per_day: 5, min_trust: "agent" });
    expect((await json(await b.call("/admin/api/rescope-client", { client_id: clientId, ...WIDEN, dry_run: true }))).revoked_unbound)
      .toEqual({ access_tokens: 0, refresh_tokens: 0, codes: 0 });
    expect(await state()).toEqual(before);
  });

  // protects: a source-only edit leaves the per-client limits alone (no defaulting).
  // fails_when: `after` is built from defaults instead of the locked row.
  it("keeps the surface, budget and floor a change does not name", async () => {
    const b = await operator();
    const p = await preview(b, { source: "acme", read: ["acme"] });
    expect(p.changed).toEqual(["source_id", "federated_read"]);
    expect((await apply(b, { source: "acme", read: ["acme"] }, p)).status).toBe(200);
    expect((await state()).row).toMatchObject({ source_id: "acme", tool_surface: "starter", budget_usd_per_day: 2, min_trust: "member" });
  });

  // protects: a preview started from a stale form says so and hands back the current grant.
  it("answers 409 with the current grant when the revision moved since the form loaded", async () => {
    const b = await operator();
    await setCredentialMinTrust(storage.engine(), clientId, "owner");
    const res = await b.call("/admin/api/rescope-client", { client_id: clientId, ...NARROW, expected_revision: 0, dry_run: true });
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body).toMatchObject({ error: "grant_conflict", expected: 0, actual: 1 });
    expect(body.current).toMatchObject({ client_id: clientId, revision: 1, min_trust: "owner" });
  });
});

describe("apply", () => {
  // protects: one reviewed change = one revision and one audit row carrying the new fields.
  it("bumps the revision once and writes one audit row with surface, budget and floor", async () => {
    const b = await operator();
    const p = await preview(b, WIDEN);
    const res = await apply(b, WIDEN, p);
    expect(res.status).toBe(200);
    expect((await json(res)).revision).toBe(1);
    const s = await state();
    expect([s.revision, s.audits]).toEqual([1, 1]);
    expect(s.row).toMatchObject({ source_id: "acme", tool_surface: "full", budget_usd_per_day: 5, min_trust: "agent" });
    const audit = await storage.engine().query<{ before: Record<string, unknown>; after: Record<string, unknown>; via: string }>(
      "SELECT before, after, via FROM oauth_grant_audit WHERE client_id = $1",
      [clientId],
    );
    const row = audit.rows[0]!;
    expect(row.via).toBe("admin_api");
    expect(row.before).toMatchObject({ tool_surface: "starter", budget_usd_per_day: 2, min_trust: "member" });
    expect(row.after).toMatchObject({ tool_surface: "full", budget_usd_per_day: 5, min_trust: "agent" });
  });

  it("refuses an apply without a preview's plan hash or revision", async () => {
    const b = await operator();
    const before = await state();
    expect((await b.call("/admin/api/rescope-client", { client_id: clientId, ...NARROW, expected_revision: 0 })).status).toBe(400);
    expect((await b.call("/admin/api/rescope-client", { client_id: clientId, ...NARROW, plan_hash: "a".repeat(64) })).status).toBe(400);
    expect(await state()).toEqual(before);
  });
});

describe("threat model", () => {
  // Escalation: the page sends a widened `after` next to a reviewed narrowing.
  // fails_when: the server trusts a client-sent snapshot instead of recomputing.
  it("escalation: a client-sent `after` is ignored; only the previewed change applies", async () => {
    const b = await operator();
    const p = await preview(b, NARROW);
    const forgedAfter = { ...p.after, scopes: ["admin"], tool_surface: "full", min_trust: null, budget_usd_per_day: null };
    const res = await b.call("/admin/api/rescope-client", {
      client_id: clientId,
      ...NARROW,
      after: forgedAfter,
      expected_revision: p.revision,
      plan_hash: p.plan_hash,
    });
    expect(res.status).toBe(200);
    expect((await state()).row).toMatchObject({ scope: "read write", tool_surface: "verbs", budget_usd_per_day: 1, min_trust: "owner" });
  });

  // Escalation: a stolen or unattended passkey session widens an agent to admin.
  it("escalation: a widening to admin scope without a fresh step-up is refused and writes nothing", async () => {
    const { b } = await passkeyOwner();
    const change = { scopes: ["admin"] };
    const p = await preview(b, change);
    expect(p.widens).toEqual(["scopes"]);
    const before = await state();
    const res = await apply(b, change, p);
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ error: "reauth_required", widens: ["scopes"] });
    expect(await state()).toEqual(before);
  });

  // Forged hash: an injected script edits the plan and signs it itself.
  // fails_when: the hash is an unkeyed digest a page script can compute.
  it("forged hash: a tampered hash and an unkeyed digest of the edited plan are both refused", async () => {
    const b = await operator();
    const p = await preview(b, NARROW);
    const before = await state();
    const flipped = (p.plan_hash[0] === "0" ? "1" : "0") + p.plan_hash.slice(1);
    const r1 = await apply(b, NARROW, { revision: p.revision, plan_hash: flipped });
    expect(r1.status).toBe(409);
    expect(await json(r1)).toEqual({ error: "plan_changed" });

    const edited = { ...NARROW, tool_surface: "full" };
    const editedAfter: ClientGrantSnapshot = { ...p.after, tool_surface: "full" };
    const unkeyed = createHash("sha256").update(grantPlanCanonical(clientId, p.revision, editedAfter)).digest("hex");
    const r2 = await apply(b, edited, { revision: p.revision, plan_hash: unkeyed });
    expect(r2.status).toBe(409);
    expect(await json(r2)).toEqual({ error: "plan_changed" });
    expect(await state()).toEqual(before);
  });

  // Confused deputy: the UI shows one plan and applies another under the same revision.
  it("a body whose recomputed plan differs from the preview fails plan_changed", async () => {
    const b = await operator();
    const p = await preview(b, NARROW);
    const before = await state();
    const res = await apply(b, { ...NARROW, tool_surface: "starter" }, p);
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: "plan_changed" });
    expect(await state()).toEqual(before);
  });

  // Stale revision: a CLI floor change lands between preview and apply.
  // fails_when: the min_trust writer skips the revision, so apply overwrites it.
  it("stale revision: a CLI trust-floor change between preview and apply fails grant_conflict and survives", async () => {
    const b = await operator();
    const p = await preview(b, { min_trust: "agent", tool_surface: "verbs" });
    await setCredentialMinTrust(storage.engine(), clientId, "owner", { actor: "ops", via: "cli" });
    const res = await apply(b, { min_trust: "agent", tool_surface: "verbs" }, p);
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: "grant_conflict", expected: 0, actual: 1 });
    expect((await state()).row).toMatchObject({ min_trust: "owner", tool_surface: "starter" });
  });

  // Widening without step-up, then the same reviewed plan after one passkey confirmation.
  it("widening needs a step-up from the last five minutes; the same plan applies right after one", async () => {
    const { b, soft } = await passkeyOwner();
    const p = await preview(b, WIDEN);
    const before = await state();
    expect((await apply(b, WIDEN, p)).status).toBe(403);
    expect(await state()).toEqual(before);
    await stepUp(b, soft);
    tick(4 * MIN);
    expect((await apply(b, WIDEN, p)).status).toBe(200);
    expect((await state()).row).toMatchObject({ source_id: "acme", tool_surface: "full" });

    // Six minutes on, the step-up has lapsed again.
    await stepUp(b, soft);
    tick(6 * MIN);
    const p2 = await preview(b, { budget_usd_per_day: null }, 1);
    expect(p2.widens).toEqual(["budget_usd_per_day"]);
    expect((await apply(b, { budget_usd_per_day: null }, p2)).status).toBe(403);
  });

  // Narrowing needs no step-up.
  it("a narrowing-only change applies from a session without a step-up", async () => {
    const { b } = await passkeyOwner();
    const p = await preview(b, NARROW);
    expect(p.widens).toEqual([]);
    expect((await apply(b, NARROW, p)).status).toBe(200);
    expect((await state()).row).toMatchObject({ tool_surface: "verbs", budget_usd_per_day: 1, min_trust: "owner" });
  });

  it("with no passkey enrolled, a bootstrap session widens without a ceremony", async () => {
    const b = await operator();
    tick(30 * MIN);
    const p = await preview(b, WIDEN);
    expect((await apply(b, WIDEN, p)).status).toBe(200);
  });

  it("fails closed for a widening apply when the server wires no step-up check", async () => {
    const b = await operator(() => ({ signGrantPlan: auth.signGrantPlan }));
    const p = await preview(b, WIDEN);
    expect((await apply(b, WIDEN, p)).status).toBe(403);
    const n = await preview(b, NARROW);
    expect((await apply(b, NARROW, n)).status).toBe(200);
  });

  it("refuses a cross-origin apply before anything else", async () => {
    const b = await operator();
    const p = await preview(b, NARROW);
    const evil = new Browser("https://evil.example");
    evil.jar = new Map(b.jar);
    const before = await state();
    expect((await apply(evil, NARROW, p)).status).toBe(403);
    expect(await state()).toEqual(before);
  });
});

describe("step-up on routes that mint or re-point credentials", () => {
  // protects: the grant editor's step-up cannot be sidestepped by minting a new
  // credential or redirecting an existing one instead of widening a grant.
  // fails_when: one of these routes drops off the step-up list.
  const routes: [string, () => Record<string, unknown>][] = [
    ["/admin/api/register-client", () => ({ name: "minted", scopes: "read write admin" })],
    ["/admin/api/api-keys", () => ({ name: "minted-key" })],
    ["/admin/api/enrollments", () => ({ client_id: clientId, source: "acme", label: "x" })],
    ["/admin/api/set-redirect-uris", () => ({ client_id: clientId, redirect_uris: ["https://evil.example/cb"] })],
    ["/admin/api/update-client-ttl", () => ({ client_id: clientId, token_ttl: 7_776_000 })],
  ];
  for (const [route, body] of routes) {
    it(`${route} needs a fresh step-up`, async () => {
      const { b, soft } = await passkeyOwner();
      const before = await state();
      const refused = await b.call(route, body());
      expect(refused.status).toBe(403);
      expect(await json(refused)).toEqual({ error: "reauth_required" });
      expect(await state()).toEqual(before);
      await stepUp(b, soft);
      const after = await b.call(route, body());
      expect(after.status).not.toBe(403);
    });
  }

  it("fails closed when the server wires no step-up check", async () => {
    const b = await operator(() => ({ signGrantPlan: auth.signGrantPlan }));
    expect((await b.call("/admin/api/api-keys", { name: "minted-key" })).status).toBe(403);
  });
});

describe("other grant writers", () => {
  // protects: every write to a client grant column moves the revision, so a
  // preview taken before it turns into grant_conflict instead of overwriting.
  it("update-client-ttl bumps the revision and writes an audit row", async () => {
    const b = await operator();
    const res = await b.call("/admin/api/update-client-ttl", { client_id: clientId, token_ttl: 3600 });
    expect(res.status).toBe(200);
    const s = await state();
    expect([s.revision, s.audits]).toEqual([1, 1]);
    const [row] = await new OAuthProvider({ engine: storage.engine() }).listGrantAudit(clientId);
    expect(row).toMatchObject({ via: "admin_api", before: { token_ttl: null }, after: { token_ttl: 3600, action: "set_token_ttl" } });
  });

  it("recording a client's profile bumps the revision and audits the surface it sets", async () => {
    const provider = new OAuthProvider({ engine: storage.engine() });
    expect(await provider.setClientProfile(clientId, { profile: "writer", catalogVersion: 1, toolSurface: "full" }, { actor: "ops", via: "cli" })).toBe(true);
    const s = await state();
    expect([s.revision, s.audits, s.row.tool_surface]).toEqual([1, 1, "full"]);
    const [row] = await provider.listGrantAudit(clientId);
    expect(row).toMatchObject({ before: { tool_surface: "starter", profile: null }, after: { tool_surface: "full", profile: "writer", action: "set_profile" } });
  });

  it("refuses a budget finer than cents", async () => {
    const b = await operator();
    const res = await b.call("/admin/api/rescope-client", { client_id: clientId, budget_usd_per_day: 2.555, dry_run: true });
    expect(res.status).toBe(400);
    expect((await b.call("/admin/api/rescope-client", { client_id: clientId, budget_usd_per_day: 0.29, dry_run: true })).status).toBe(200);
  });
});

describe("client-grant read", () => {
  it("returns the grant with its revision and profile, and the pickable sources, uncached", async () => {
    const b = await operator();
    const res = await b.call(`/admin/api/client-grant?client_id=${clientId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as { grant: Record<string, unknown>; sources: { id: string }[] };
    expect(body.grant).toMatchObject({
      client_id: clientId,
      client_name: "editor-agent",
      revision: 0,
      source_id: "default",
      tool_surface: "starter",
      budget_usd_per_day: 2,
      min_trust: "member",
    });
    expect(body.sources.map((s) => s.id)).toEqual(expect.arrayContaining(["default", "acme", "beta"]));
    expect((await new Browser().call(`/admin/api/client-grant?client_id=${clientId}`)).status).toBe(401);
    expect((await b.call("/admin/api/client-grant?client_id=nope")).status).toBe(404);
  });
});
