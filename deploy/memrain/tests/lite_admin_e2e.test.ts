/**
 * The cut-down admin panel end to end, through the real server: the owner
 * signs in with a passkey, approves a new OAuth client's /authorize from the
 * panel, the client trades its code for a token and calls /mcp with it. Then
 * the routes the panel keeps answer and the ones it dropped are gone.
 *
 * The server sits behind a TLS-terminating proxy: requests reach it over plain
 * http, the browser's origin is the configured https MEMRAIN_PUBLIC_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import { SoftAuthenticator } from "./helpers/soft-authenticator.ts";

const BOOT = "boot-secret-for-the-lite-admin-e2e";
const ORIGIN = "https://brain.example.com";
const RP_ID = "brain.example.com";
const REDIRECT = "https://client.example/cb";

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;
let server: ServerHandle;
let base: string;
let savedRequireLogin: string | undefined;

beforeAll(async () => {
  savedRequireLogin = process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN;
  delete process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN;
  tmp = mkdtempSync(join(tmpdir(), "memrain-lite-admin-e2e-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  provider = new OAuthProvider({ engine: storage.raw() });
  server = startServer({
    host: "127.0.0.1",
    port: 0,
    storage,
    oauthProvider: provider,
    adminBootstrapToken: BOOT,
    publicUrl: ORIGIN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  if (savedRequireLogin === undefined) delete process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN;
  else process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN = savedRequireLogin;
});

/** A browser on the public origin: a cookie jar and an Origin header on every write. */
class Browser {
  jar = new Map<string, string>();

  async call(path: string, body?: unknown): Promise<Response> {
    // The proxy keeps the browser's Host, so the server sees the public host over http.
    const headers: Record<string, string> = { host: RP_ID };
    if (this.jar.size > 0) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body !== undefined) {
      headers.origin = ORIGIN;
      headers["content-type"] = "application/json";
    }
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      redirect: "manual",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (value === "" || attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }
}

async function setupLinkToken(): Promise<string> {
  const res = await fetch(`${base}/admin/api/setup-links`, { method: "POST", headers: { authorization: `Bearer ${BOOT}` } });
  expect(res.status).toBe(200);
  const url = ((await res.json()) as { url: string }).url;
  return url.slice(url.indexOf("#enroll/") + "#enroll/".length);
}

async function enrollOwner(): Promise<SoftAuthenticator> {
  const soft = new SoftAuthenticator(ORIGIN, RP_ID);
  const b = new Browser();
  expect((await b.call("/admin/api/passkey/enroll/redeem", { token: await setupLinkToken() })).status).toBe(200);
  const opts = await b.call("/admin/api/passkey/register/options", {});
  expect(opts.status).toBe(200);
  const optionsJSON = ((await opts.json()) as { optionsJSON: PublicKeyCredentialCreationOptionsJSON }).optionsJSON;
  expect((await b.call("/admin/api/passkey/register/verify", { response: soft.register(optionsJSON), label: "Laptop" })).status).toBe(200);
  return soft;
}

async function passkeyLogin(b: Browser, soft: SoftAuthenticator): Promise<Response> {
  const opts = await b.call("/admin/api/passkey/login/options", {});
  expect(opts.status).toBe(200);
  const optionsJSON = ((await opts.json()) as { optionsJSON: PublicKeyCredentialRequestOptionsJSON }).optionsJSON;
  return b.call("/admin/api/passkey/login/verify", { response: soft.assert(optionsJSON) });
}

describe("passkey sign-in and owner consent for a new OAuth client", () => {
  // Value: protects=a new client gets a token only after the owner, signed in with a passkey,
  // approves its exact request in the panel; fails_when=the panel cut breaks passkey login,
  // the parked request, approve-resume or the code exchange; why_new=the panel was cut down
  // and nothing drove this chain through the real server with a passkey; seam=none
  it("owner approves the parked /authorize; the client trades the code and calls /mcp", async () => {
    const { clientId, clientSecret } = await provider.registerClientManual(
      "e2e-web", ["authorization_code", "refresh_token"], "read", [REDIRECT], "default",
    );
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: "read",
      state: "st-e2e",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();

    const owner = await enrollOwner();
    const b = new Browser();
    // No session: /authorize mints nothing and sends the browser to sign in.
    const bounced = await b.call(`/authorize?${query}`);
    expect(bounced.status).toBe(302);
    const loginPath = bounced.headers.get("location")!;
    expect(loginPath).toStartWith("/admin/login?return_to=");
    expect((await b.call(loginPath)).status).toBe(302);

    expect((await passkeyLogin(b, owner)).status).toBe(200);
    const pending = await b.call("/admin/api/pending-resume");
    expect(pending.status).toBe(200);
    const shown = (await pending.json()) as { handle: string; redirect_to: string; client_id: string };
    expect(shown.client_id).toBe(clientId);

    // The session alone is not consent.
    const unapproved = await b.call(shown.redirect_to);
    expect(unapproved.headers.get("location")).toStartWith("/admin/login?return_to=");

    const approved = await b.call("/admin/api/approve-resume", { handle: shown.handle });
    expect(approved.status).toBe(200);
    const { redirect_to: target } = (await approved.json()) as { redirect_to: string };
    const issued = await b.call(target);
    expect(issued.status).toBe(302);
    const back = new URL(issued.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("st-e2e");
    const code = back.searchParams.get("code")!;
    expect(code).toMatch(/^memrain_code_/);

    const token = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        client_id: clientId,
        client_secret: clientSecret!,
      }).toString(),
    });
    expect(token.status).toBe(200);
    const { access_token: accessToken } = (await token.json()) as { access_token: string };

    const listed = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(listed.status).toBe(200);
    const tools = ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(tools).toContain("search");
  });
});

describe("the routes the panel keeps", () => {
  async function operator(): Promise<Browser> {
    const b = new Browser();
    expect((await b.call("/admin/login", { token: BOOT })).status).toBe(200);
    return b;
  }

  // Value: protects=every data route a kept page reads answers a signed-in operator;
  // fails_when=the cut drops or breaks one; why_new=the panel was cut down; seam=none
  it("answer a signed-in operator", async () => {
    const b = await operator();
    for (const path of [
      "/admin/api/full-stats", "/admin/api/health-report", "/admin/api/agents", "/admin/api/agents/spend",
      "/admin/api/stats", "/admin/api/health-indicators", "/admin/api/onboarding", "/admin/api/api-keys",
    ]) {
      const res = await b.call(path);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
    const tool = await b.call("/admin/api/tool", { name: "page_list", arguments: { limit: 5 } });
    expect(tool.status).toBe(200);
    expect(((await tool.json()) as { ok: boolean }).ok).toBe(true);
  });

  // Value: protects=the Health page can say what waits in the CLI review queues, the only way
  // to decide them now; fails_when=the report drops a queue or miscounts it; why_new=the
  // Approvals page is gone; seam=none
  it("the health report counts the write-gate and quarantine queues", async () => {
    const b = await operator();
    const before = (await (await b.call("/admin/api/health-report")).json()) as {
      migrations: { head: number; pending: number[] };
      review: { write_gate_holds: number; row_holds: number; quarantined: number };
      spend_today: { usd: number };
    };
    expect(before.migrations.pending).toEqual([]);
    expect(before.migrations.head).toBeGreaterThan(0);
    expect(before.review).toEqual({ write_gate_holds: 0, row_holds: 0, quarantined: 0 });
    expect(before.spend_today.usd).toBe(0);

    const docId = "doc-held-e2e";
    await storage.raw().query(
      `INSERT INTO documents (id, source_path, title, frontmatter) VALUES ($1, 'page://notes/held', 'Held', $2::jsonb)`,
      [docId, { quarantine: { reason: "test" } }],
    );
    await storage.raw().query(
      `INSERT INTO write_gate_holds (source_id, document_id, target_ref, origin, reason_families, detector_version, binding, excerpt)
       VALUES ('default', $1, 'notes/held', 'agent', ARRAY['instruction_like'], 'write-gate/v3', 'b', 'x')`,
      [docId],
    );
    const after = (await (await b.call("/admin/api/health-report")).json()) as { review: Record<string, number> };
    expect(after.review).toEqual({ write_gate_holds: 1, row_holds: 0, quarantined: 1 });
  });

  // Value: protects=the panel cannot give a client a trust floor, which this build refuses at
  // verify and so would lock the client out; clearing an old floor still previews;
  // fails_when=the rescope route accepts a non-null min_trust again; why_new=the editor field
  // was removed; seam=none
  it("rescope refuses to set a trust floor and still previews clearing one", async () => {
    const b = await operator();
    const { clientId } = await provider.registerClientManual(
      "e2e-floor", ["authorization_code", "refresh_token"], "read", [REDIRECT], "default",
    );
    const set = await b.call("/admin/api/rescope-client", { client_id: clientId, min_trust: "member", dry_run: true });
    expect(set.status).toBe(400);
    expect(((await set.json()) as { error: string }).error).toContain("min_trust can only be cleared");
    const clear = await b.call("/admin/api/rescope-client", { client_id: clientId, min_trust: null, dry_run: true });
    expect(clear.status).toBe(200);
  });

  // Value: protects=the dropped pages leave no server route behind; fails_when=a route of a
  // retired page answers again; why_new=the panel cut removed them; seam=none
  it("routes of the dropped pages are gone", async () => {
    const b = await operator();
    for (const path of [
      "/admin/api/requests", "/admin/api/jobs/watch", "/admin/api/timeseries", "/admin/api/graph/hubs",
      "/admin/api/spend/paused", "/admin/api/enrollments", "/admin/api/notifications", "/admin/api/office",
      "/admin/api/chat/threads", "/ingest", "/share/x",
    ]) {
      const res = await b.call(path);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    const resume = await b.call("/admin/api/spend/resume", { path: "x" });
    expect(resume.status).toBe(404);
  });
});
