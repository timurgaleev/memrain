/**
 * OAuth 2.1 authorization-code + PKCE / DCR / revoke over the live HTTP ingress.
 *
 * Exercises the routes wired in http/oauth-endpoints.ts + server.ts against a
 * real PGLite-backed Storage (no external services). Covers the standard
 * MCP-client flow end to end: /authorize → code → /token with a PKCE verifier,
 * plus the negative paths (verifier mismatch, code replay, redirect_uri
 * allowlist), Dynamic Client Registration, and revocation.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Storage } from "../src/core/storage.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";

const PUB_TOKEN = "pub-bearer-oauth-endpoints";
const REDIRECT = "https://client.example/cb";
const ADMIN_TOKEN = "admin-bootstrap-oauth-test";

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe("OAuth 2.1 authorization-code + PKCE / DCR / revoke", () => {
  let tmp: string;
  let storage: Storage;
  let provider: OAuthProvider;
  let server: ServerHandle;
  let url: string;
  // Public PKCE client (token_endpoint_auth_method='none').
  let pubClientId: string;
  // Confidential browser (authorization-code) client: an auto-approving
  // /authorize refuses the public one, so the PKCE flow runs on this.
  let webClientId: string;
  let webClientSecret: string;
  // Confidential client_credentials client.
  let confClientId: string;
  let confClientSecret: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-oauth-ep-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    provider = new OAuthProvider({ engine: storage.raw() });

    const pub = await provider.registerClientManual(
      "pkce-client",
      ["authorization_code", "refresh_token"],
      "read",
      [REDIRECT],
      "default",
      undefined,
      "none",
    );
    pubClientId = pub.clientId;

    const web = await provider.registerClientManual(
      "web-client",
      ["authorization_code", "refresh_token"],
      "read",
      [REDIRECT],
      "default",
    );
    webClientId = web.clientId;
    webClientSecret = web.clientSecret!;

    const conf = await provider.registerClientManual(
      "cc-client",
      ["client_credentials"],
      "read",
      [],
      "default",
    );
    confClientId = conf.clientId;
    confClientSecret = conf.clientSecret!;

    server = startServer({
      host: "127.0.0.1",
      port: 0,
      storage,
      publicBearerToken: PUB_TOKEN,
      oauthProvider: provider,
      adminBootstrapToken: ADMIN_TOKEN,
    });
    url = `http://127.0.0.1:${server.port}`;

    // /authorize is gated on a logged-in operator (the resource owner). Establish
    // an admin session once and reuse its cookie for the authorize happy paths.
    const login = await fetch(`${url}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    const setCookie = login.headers.get("set-cookie") ?? "";
    adminCookie = setCookie.split(";")[0] ?? ""; // name=value only
  });

  let adminCookie = "";

  afterEach(async () => {
    await server.stop();
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** GET /authorize as the logged-in operator (carries the admin session cookie). */
  async function authorize(params: Record<string, string>): Promise<Response> {
    const q = new URLSearchParams(params);
    return fetch(`${url}/authorize?${q}`, {
      redirect: "manual",
      headers: adminCookie ? { Cookie: adminCookie } : {},
    });
  }

  async function tokenForm(body: Record<string, string>): Promise<Response> {
    return fetch(`${url}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
  }

  // DCR is OFF by default; spin a DCR-enabled server for the tests that exercise
  // /register, then tear it down + clear the env. DCR only boots when /authorize
  // enforces operator consent, so pair MEMRAIN_ENABLE_DCR with
  // MEMRAIN_OAUTH_REQUIRE_LOGIN + an admin token (the secure production posture).
  async function withDcr<T>(fn: (base: string) => Promise<T>): Promise<T> {
    process.env.MEMRAIN_ENABLE_DCR = "1";
    process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN = "1";
    const s = startServer({
      host: "127.0.0.1",
      port: 0,
      storage,
      oauthProvider: provider,
      adminBootstrapToken: ADMIN_TOKEN,
    });
    try {
      return await fn(`http://127.0.0.1:${s.port}`);
    } finally {
      await s.stop();
      delete process.env.MEMRAIN_ENABLE_DCR;
      delete process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN;
    }
  }

  it("PKCE happy path: authorize → code → token with the right verifier", async () => {
    const { verifier, challenge } = pkce();
    const authRes = await authorize({
      response_type: "code",
      client_id: webClientId,
      redirect_uri: REDIRECT,
      scope: "read",
      state: "xyz",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(authRes.status).toBe(302);
    const loc = new URL(authRes.headers.get("location")!);
    expect(loc.searchParams.get("state")).toBe("xyz");
    const code = loc.searchParams.get("code")!;
    expect(code).toMatch(/^memrain_code_/);

    const tokRes = await tokenForm({
      grant_type: "authorization_code",
      client_id: webClientId,
      client_secret: webClientSecret,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(tokRes.status).toBe(200);
    const body = (await tokRes.json()) as {
      access_token: string;
      refresh_token?: string;
      token_type: string;
    };
    expect(body.token_type).toBe("bearer");
    expect(body.access_token).toMatch(/^memrain_at_/);
    expect(body.refresh_token).toMatch(/^memrain_rt_/);

    // The minted token resolves to the client + its source scope.
    const info = await provider.verifyAccessToken(body.access_token);
    expect(info.clientId).toBe(webClientId);
    expect(info.scopes).toContain("read");
  });

  it("opt-in: with MEMRAIN_OAUTH_REQUIRE_LOGIN=1, /authorize without a session issues NO code (302 → login)", async () => {
    process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN = "1";
    const gsrv = startServer({
      host: "127.0.0.1",
      port: 0,
      storage,
      oauthProvider: provider,
      adminBootstrapToken: ADMIN_TOKEN,
    });
    try {
      const { challenge } = pkce();
      const q = new URLSearchParams({
        response_type: "code",
        client_id: pubClientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      // Gate ON + no admin cookie → bounce to login, no code minted.
      const res = await fetch(`http://127.0.0.1:${gsrv.port}/authorize?${q}`, {
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      const loc = res.headers.get("location") ?? "";
      expect(loc.startsWith("/admin/login")).toBe(true);
      expect(loc).not.toContain("code=");
    } finally {
      await gsrv.stop();
      delete process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN;
    }
  });

  it("SECURITY: DCR is disabled by default → /register returns 404 (no self-registration)", async () => {
    const res = await fetch(`${url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "stranger",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        scope: "read write",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("SECURITY: when DCR is enabled it clamps an elevated scope request to read/write", async () => {
    process.env.MEMRAIN_ENABLE_DCR = "1";
    process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN = "1";
    const gsrv = startServer({
      host: "127.0.0.1",
      port: 0,
      storage,
      oauthProvider: provider,
      adminBootstrapToken: ADMIN_TOKEN,
    });
    try {
      // A real client copies the whole advertised scope list into its DCR
      // request. We CLAMP (not reject): registration succeeds, elevated dropped.
      const res = await fetch(`http://127.0.0.1:${gsrv.port}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "claude-like",
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "none",
          scope: "admin agent read sources_admin users_admin write",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { client_id: string; scope?: string };
      const granted = (body.scope ?? "").split(/\s+/).filter(Boolean).sort();
      expect(granted).toEqual(["read", "write"]);
      expect(body.scope ?? "").not.toContain("admin");
    } finally {
      await gsrv.stop();
      delete process.env.MEMRAIN_ENABLE_DCR;
      delete process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN;
    }
  });

  it("PKCE mismatch is rejected AND does not consume the code", async () => {
    const { challenge } = pkce();
    const authRes = await authorize({
      response_type: "code",
      client_id: webClientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const code = new URL(authRes.headers.get("location")!).searchParams.get(
      "code",
    )!;

    // Wrong verifier → invalid_grant, code NOT burned.
    const bad = await tokenForm({
      grant_type: "authorization_code",
      client_id: webClientId,
      client_secret: webClientSecret,
      code,
      redirect_uri: REDIRECT,
      code_verifier: "not-the-real-verifier",
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );

    // The genuine verifier still works because the failed attempt didn't
    // consume the code — but we minted the challenge freshly here, so redo with
    // a matching pair to prove the "not consumed" property.
    const p = pkce();
    const a2 = await authorize({
      response_type: "code",
      client_id: webClientId,
      redirect_uri: REDIRECT,
      code_challenge: p.challenge,
      code_challenge_method: "S256",
    });
    const code2 = new URL(a2.headers.get("location")!).searchParams.get(
      "code",
    )!;
    await tokenForm({
      grant_type: "authorization_code",
      client_id: webClientId,
      client_secret: webClientSecret,
      code: code2,
      redirect_uri: REDIRECT,
      code_verifier: "wrong-again",
    });
    const good = await tokenForm({
      grant_type: "authorization_code",
      client_id: webClientId,
      client_secret: webClientSecret,
      code: code2,
      redirect_uri: REDIRECT,
      code_verifier: p.verifier,
    });
    expect(good.status).toBe(200);
  });

  it("authorization code is single-use", async () => {
    const { verifier, challenge } = pkce();
    const authRes = await authorize({
      response_type: "code",
      client_id: webClientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const code = new URL(authRes.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const first = await tokenForm({
      grant_type: "authorization_code",
      client_id: webClientId,
      client_secret: webClientSecret,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(first.status).toBe(200);
    const second = await tokenForm({
      grant_type: "authorization_code",
      client_id: webClientId,
      client_secret: webClientSecret,
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  it("every /authorize redirect carries iss (RFC 9207), success and error", async () => {
    const { challenge } = pkce();
    const ok = await authorize({
      response_type: "code",
      client_id: webClientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(ok.status).toBe(302);
    expect(new URL(ok.headers.get("location")!).searchParams.get("iss")).toBe(url);

    const bad = await authorize({
      response_type: "token",
      client_id: webClientId,
      redirect_uri: REDIRECT,
      state: "s",
    });
    expect(bad.status).toBe(302);
    const loc = new URL(bad.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("unsupported_response_type");
    expect(loc.searchParams.get("iss")).toBe(url);
  });

  describe("loopback redirect URIs (RFC 8252 §7.3)", () => {
    const LOOPBACKS = [
      "http://127.0.0.1/callback",
      "http://localhost/callback",
      "http://[::1]/callback",
    ];
    let cliId: string;
    let cliSecret: string;

    beforeEach(async () => {
      const cli = await provider.registerClientManual(
        "cli-client",
        ["authorization_code", "refresh_token"],
        "read",
        LOOPBACKS,
        "default",
      );
      cliId = cli.clientId;
      cliSecret = cli.clientSecret!;
    });

    it("accepts any port on a registered loopback URI and redeems at /token with it", async () => {
      for (const reg of LOOPBACKS) {
        const withPort = reg.replace("/callback", ":53682/callback");
        const { verifier, challenge } = pkce();
        const res = await authorize({
          response_type: "code",
          client_id: cliId,
          redirect_uri: withPort,
          code_challenge: challenge,
          code_challenge_method: "S256",
        });
        expect(res.status).toBe(302);
        const loc = new URL(res.headers.get("location")!);
        expect(loc.port).toBe("53682");
        const code = loc.searchParams.get("code")!;
        const tok = await tokenForm({
          grant_type: "authorization_code",
          client_id: cliId,
          client_secret: cliSecret,
          code,
          redirect_uri: withPort,
          code_verifier: verifier,
        });
        expect(tok.status).toBe(200);
      }
    });

    it("/token still requires the exact redirect_uri used at /authorize", async () => {
      const { verifier, challenge } = pkce();
      const res = await authorize({
        response_type: "code",
        client_id: cliId,
        redirect_uri: "http://127.0.0.1:40001/callback",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
      const tok = await tokenForm({
        grant_type: "authorization_code",
        client_id: cliId,
        client_secret: cliSecret,
        code,
        redirect_uri: "http://127.0.0.1:40002/callback",
        code_verifier: verifier,
      });
      expect(tok.status).toBe(400);
    });

    it("path, host and scheme still match exactly; non-loopback keeps exact port", async () => {
      const refused = [
        "http://127.0.0.1:5000/other",
        "http://127.0.0.1:5000/callback/x",
        "http://127.0.0.1:5000/callback?x=1",
        "https://127.0.0.1:5000/callback",
        "http://127.0.0.2:5000/callback",
        "http://evil.example:5000/callback",
        "http://user@127.0.0.1:5000/callback",
      ];
      for (const redirect_uri of refused) {
        const { challenge } = pkce();
        const res = await authorize({
          response_type: "code",
          client_id: cliId,
          redirect_uri,
          code_challenge: challenge,
          code_challenge_method: "S256",
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("location")).toBeNull();
      }
      // An https URI is never port-relaxed.
      const { challenge } = pkce();
      const res = await authorize({
        response_type: "code",
        client_id: webClientId,
        redirect_uri: "https://client.example:8443/cb",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      expect(res.status).toBe(400);
    });
  });

  it("redirect_uri allowlist is enforced (unregistered → 400, no redirect)", async () => {
    const { challenge } = pkce();
    const res = await authorize({
      response_type: "code",
      client_id: pubClientId,
      redirect_uri: "https://evil.example/steal",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    // Must NOT redirect to the attacker URI — a direct 400 instead.
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("DCR (when enabled) mints a public client and a confidential client", async () => {
    await withDcr(async (base) => {
      // Public (PKCE) client — no secret in the response.
      const pubRes = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "dcr-public",
          redirect_uris: [REDIRECT],
          grant_types: ["authorization_code"],
          token_endpoint_auth_method: "none",
          scope: "read",
        }),
      });
      expect(pubRes.status).toBe(201);
      const pubBody = (await pubRes.json()) as {
        client_id: string;
        client_secret?: string;
      };
      expect(pubBody.client_id).toMatch(/^memrain_cl_/);
      expect(pubBody.client_secret).toBeUndefined();

      // Confidential client — secret returned exactly once. A self-registered
      // client is held to the consent-bearing authorization_code grant.
      const confRes = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "dcr-conf",
          redirect_uris: [REDIRECT],
          grant_types: ["authorization_code"],
          scope: "read",
        }),
      });
      expect(confRes.status).toBe(201);
      const confBody = (await confRes.json()) as { client_secret?: string };
      expect(confBody.client_secret).toMatch(/^memrain_cs_/);
    });
  });

  it("SECURITY: DCR refuses a client_credentials registration (consent bypass)", async () => {
    await withDcr(async (base) => {
      const res = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "m2m-wannabe",
          redirect_uris: [REDIRECT],
          grant_types: ["client_credentials"],
          scope: "read",
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "invalid_client_metadata",
      );
    });
  });

  it("DCR defaults an omitted grant_types to authorization_code + refresh_token", async () => {
    await withDcr(async (base) => {
      const res = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "dcr-default-grant",
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "none",
          scope: "read",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        client_id: string;
        grant_types: string[];
      };
      expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
      const stored = await provider.getClient(body.client_id);
      expect(stored?.grant_types).toEqual(["authorization_code", "refresh_token"]);
    });
  });

  it("SECURITY: insecure DCR mode permits a client_credentials registration", async () => {
    // MEMRAIN_ENABLE_DCR_INSECURE=1 both opts the provider into the
    // machine-to-machine path and satisfies the DCR consent boot check without
    // MEMRAIN_OAUTH_REQUIRE_LOGIN. Mirror that env with an insecure provider.
    const insecureProvider = new OAuthProvider({
      engine: storage.raw(),
      allowClientCredentialsDcr: true,
    });
    process.env.MEMRAIN_ENABLE_DCR_INSECURE = "1";
    const s = startServer({
      host: "127.0.0.1",
      port: 0,
      storage,
      oauthProvider: insecureProvider,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "m2m-allowed",
          redirect_uris: [REDIRECT],
          grant_types: ["client_credentials"],
          scope: "read",
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        client_secret?: string;
        grant_types: string[];
      };
      expect(body.grant_types).toEqual(["client_credentials"]);
      expect(body.client_secret).toMatch(/^memrain_cs_/);
    } finally {
      await s.stop();
      delete process.env.MEMRAIN_ENABLE_DCR_INSECURE;
    }
  });

  it("registerClient (unit) allows client_credentials when opted in", async () => {
    const insecureProvider = new OAuthProvider({
      engine: storage.raw(),
      allowClientCredentialsDcr: true,
    });
    const client = await insecureProvider.registerClient({
      client_name: "unit-m2m",
      grant_types: ["client_credentials"],
      scope: "read",
    });
    expect(client.grant_types).toEqual(["client_credentials"]);
    expect(client.client_secret).toMatch(/^memrain_cs_/);
  });

  it("SECURITY: refuses to boot with DCR on while /authorize auto-approves", async () => {
    process.env.MEMRAIN_ENABLE_DCR = "1";
    try {
      expect(() =>
        startServer({
          host: "127.0.0.1",
          port: 0,
          storage,
          oauthProvider: provider,
          adminBootstrapToken: ADMIN_TOKEN,
        }),
      ).toThrow(/auto-approve/i);
    } finally {
      delete process.env.MEMRAIN_ENABLE_DCR;
    }
  });

  it("boots with DCR on when MEMRAIN_OAUTH_REQUIRE_LOGIN gates /authorize", async () => {
    process.env.MEMRAIN_ENABLE_DCR = "1";
    process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN = "1";
    let s: ServerHandle | undefined;
    try {
      s = startServer({
        host: "127.0.0.1",
        port: 0,
        storage,
        oauthProvider: provider,
        adminBootstrapToken: ADMIN_TOKEN,
      });
      expect(s.port).toBeGreaterThan(0);
    } finally {
      if (s) await s.stop();
      delete process.env.MEMRAIN_ENABLE_DCR;
      delete process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN;
    }
  });

  it("boots with DCR on when MEMRAIN_ENABLE_DCR_INSECURE acknowledges the risk", async () => {
    process.env.MEMRAIN_ENABLE_DCR_INSECURE = "1";
    let s: ServerHandle | undefined;
    try {
      s = startServer({
        host: "127.0.0.1",
        port: 0,
        storage,
        oauthProvider: provider,
      });
      expect(s.port).toBeGreaterThan(0);
    } finally {
      if (s) await s.stop();
      delete process.env.MEMRAIN_ENABLE_DCR_INSECURE;
    }
  });

  it("DCR (when enabled) rejects a non-loopback http:// redirect_uri", async () => {
    await withDcr(async (base) => {
      const res = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "bad-redirect",
          redirect_uris: ["http://evil.example/cb"],
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "invalid_redirect_uri",
      );
    });
  });

  it("revoke invalidates an access token", async () => {
    // Mint a client_credentials access token for the confidential client.
    const tok = (await (
      await tokenForm({
        grant_type: "client_credentials",
        client_id: confClientId,
        client_secret: confClientSecret,
      })
    ).json()) as { access_token: string };
    // Token verifies before revocation.
    const before = await provider.verifyAccessToken(tok.access_token);
    expect(before.clientId).toBe(confClientId);

    // Revoke it (client-authenticated).
    const revRes = await fetch(`${url}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: tok.access_token,
        client_id: confClientId,
        client_secret: confClientSecret,
      }),
    });
    expect(revRes.status).toBe(200);

    // After revocation the token no longer verifies.
    await expect(
      provider.verifyAccessToken(tok.access_token),
    ).rejects.toThrow();
  });

  it("client_secret_basic credentials are form-urlencoded: '+' is a space", async () => {
    const secret = "a secret+with%20spaces";
    await storage.raw().query("UPDATE oauth_clients SET client_secret_hash = $1 WHERE client_id = $2", [
      createHash("sha256").update(secret, "utf8").digest("hex"),
      confClientId,
    ]);
    const basic = (encodedSecret: string) =>
      fetch(`${url}/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${confClientId}:${encodedSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
      });
    expect((await basic("a+secret%2Bwith%2520spaces")).status).toBe(200);
    expect((await basic("a%20secret%2Bwith%2520spaces")).status).toBe(200);
  });

  it("revoke requires client authentication", async () => {
    const tok = (await (
      await tokenForm({
        grant_type: "client_credentials",
        client_id: confClientId,
        client_secret: confClientSecret,
      })
    ).json()) as { access_token: string };
    // Wrong secret → 401 invalid_client, token stays valid.
    const res = await fetch(`${url}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: tok.access_token,
        client_id: confClientId,
        client_secret: "memex_cs_wrong",
      }),
    });
    expect(res.status).toBe(401);
    const still = await provider.verifyAccessToken(tok.access_token);
    expect(still.clientId).toBe(confClientId);
  });

  it("/authorize is reachable from the public ingress without a bearer and auto-approves (default)", async () => {
    const { challenge } = pkce();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: webClientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    // Public ingress, no bearer: the route is exempt from the public guard and,
    // by default (no MEMRAIN_OAUTH_REQUIRE_LOGIN), auto-approves — issuing a code
    // back to the registered redirect_uri.
    const res = await fetch(`${url}/authorize?${q}`, {
      redirect: "manual",
      headers: { "Cf-Connecting-Ip": "9.9.9.9" },
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("code")).toMatch(/^memrain_code_/);
  });

  it("SECURITY: auto-approve refuses a public client-mode client (its client_id alone would mint tokens)", async () => {
    const { challenge } = pkce();
    const q = new URLSearchParams({
      response_type: "code",
      client_id: pubClientId,
      redirect_uri: REDIRECT,
      state: "st",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const res = await fetch(`${url}/authorize?${q}`, {
      redirect: "manual",
      headers: { "Cf-Connecting-Ip": "9.9.9.9" },
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("error")).toBe("unauthorized_client");
    expect(loc.searchParams.get("code")).toBeNull();
  });

  describe("resource binding (RFC 8707)", () => {
    const sha = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

    async function codeFor(resource?: string): Promise<{ code: string; verifier: string }> {
      const { verifier, challenge } = pkce();
      const res = await authorize({
        response_type: "code",
        client_id: webClientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        ...(resource !== undefined ? { resource } : {}),
      });
      expect(res.status).toBe(302);
      const code = new URL(res.headers.get("location")!).searchParams.get("code");
      expect(code).toMatch(/^memrain_code_/);
      return { code: code!, verifier };
    }

    function exchange(code: string, verifier: string, resource?: string): Promise<Response> {
      return tokenForm({
        grant_type: "authorization_code",
        client_id: webClientId,
        client_secret: webClientSecret,
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        ...(resource !== undefined ? { resource } : {}),
      });
    }

    function refresh(refreshToken: string, resource?: string): Promise<Response> {
      return tokenForm({
        grant_type: "refresh_token",
        client_id: webClientId,
        client_secret: webClientSecret,
        refresh_token: refreshToken,
        ...(resource !== undefined ? { resource } : {}),
      });
    }

    async function storedResource(token: string): Promise<string | null> {
      const r = await storage.raw().query<{ resource: string | null }>(
        "SELECT resource FROM oauth_tokens WHERE token_hash = $1",
        [sha(token)],
      );
      return r.rows[0]?.resource ?? null;
    }

    it("carries the approved resource from the code into access + refresh tokens and across rotation", async () => {
      // Authorized against the bare issuer (what discovery advertised before),
      // redeemed naming /mcp with a trailing slash: one resource, one audience.
      const { code, verifier } = await codeFor(url);
      const tok = await exchange(code, verifier, `${url}/mcp/`);
      expect(tok.status).toBe(200);
      const pair = (await tok.json()) as { access_token: string; refresh_token: string };
      expect(await storedResource(pair.access_token)).toBe(`${url}/mcp`);
      expect(await storedResource(pair.refresh_token)).toBe(`${url}/mcp`);
      expect((await provider.verifyAccessToken(pair.access_token)).resource?.toString()).toBe(
        `${url}/mcp`,
      );

      // A refresh that does not name the resource keeps it.
      const rotated = await refresh(pair.refresh_token);
      expect(rotated.status).toBe(200);
      const next = (await rotated.json()) as { access_token: string; refresh_token: string };
      expect(await storedResource(next.access_token)).toBe(`${url}/mcp`);
      expect(await storedResource(next.refresh_token)).toBe(`${url}/mcp`);
    });

    it("refuses a refresh naming an empty scope list with invalid_scope and leaves the token usable", async () => {
      const { code, verifier } = await codeFor();
      const pair = (await (await exchange(code, verifier)).json()) as { refresh_token: string };
      const refused = await tokenForm({
        grant_type: "refresh_token",
        client_id: webClientId,
        client_secret: webClientSecret,
        refresh_token: pair.refresh_token,
        scope: " ",
      });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toBe("invalid_scope");
      expect((await refresh(pair.refresh_token)).status).toBe(200);
    });

    it("a code approved with no resource still issues unbound tokens", async () => {
      const { code, verifier } = await codeFor();
      const tok = await exchange(code, verifier);
      expect(tok.status).toBe(200);
      const pair = (await tok.json()) as { access_token: string };
      expect(await storedResource(pair.access_token)).toBeNull();
    });

    it("/authorize refuses a resource this server does not serve (invalid_target, no code)", async () => {
      const { challenge } = pkce();
      const res = await authorize({
        response_type: "code",
        client_id: webClientId,
        redirect_uri: REDIRECT,
        state: "st",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: "https://evil.example/mcp",
      });
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.searchParams.get("error")).toBe("invalid_target");
      expect(loc.searchParams.get("state")).toBe("st");
      expect(loc.searchParams.get("code")).toBeNull();
    });

    it("/token refuses a foreign resource without consuming the code", async () => {
      const { code, verifier } = await codeFor(`${url}/mcp`);
      const bad = await exchange(code, verifier, "https://evil.example/mcp");
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toBe("invalid_target");
      expect((await exchange(code, verifier, `${url}/mcp`)).status).toBe(200);
    });

    it("/token refuses a resource that differs from the approved one without consuming the code", async () => {
      const { code, verifier } = await codeFor(`${url}/mcp`);
      // A code approved under another issuer (e.g. before a domain move).
      await storage.raw().query("UPDATE oauth_codes SET resource = $1 WHERE code_hash = $2", [
        "https://old.example/mcp",
        sha(code),
      ]);
      const bad = await exchange(code, verifier, `${url}/mcp`);
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toBe("invalid_target");
      // Naming no resource does not redeem it either: /mcp would refuse every
      // token bound to another server's audience.
      const unnamed = await exchange(code, verifier);
      expect(unnamed.status).toBe(400);
      expect(((await unnamed.json()) as { error: string }).error).toBe("invalid_grant");
      const left = await storage.raw().query("SELECT 1 FROM oauth_codes WHERE code_hash = $1", [sha(code)]);
      expect(left.rows.length).toBe(1);
    });

    it("judges every resource value, not just the first", async () => {
      const { challenge } = pkce();
      const q = new URLSearchParams({
        response_type: "code",
        client_id: webClientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      q.append("resource", `${url}/mcp`);
      q.append("resource", "https://evil.example/mcp");
      const res = await fetch(`${url}/authorize?${q}`, { redirect: "manual" });
      expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");

      const { code, verifier } = await codeFor(`${url}/mcp`);
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: webClientId,
        client_secret: webClientSecret,
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      });
      body.append("resource", `${url}/mcp`);
      body.append("resource", "https://evil.example/mcp");
      const bad = await fetch(`${url}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      expect(((await bad.json()) as { error: string }).error).toBe("invalid_target");
      expect((await exchange(code, verifier, `${url}/mcp`)).status).toBe(200);
    });

    it("client_credentials refuses a foreign resource and stays unbound without one", async () => {
      const cc = (resource?: string) =>
        tokenForm({
          grant_type: "client_credentials",
          client_id: confClientId,
          client_secret: confClientSecret,
          ...(resource !== undefined ? { resource } : {}),
        });
      const bad = await cc("https://evil.example/mcp");
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toBe("invalid_target");
      const ok = await cc();
      expect(ok.status).toBe(200);
      const tok = (await ok.json()) as { access_token: string };
      expect(await storedResource(tok.access_token)).toBeNull();
      expect((await cc(`${url}/mcp`)).status).toBe(200);
    });

    it("refresh refuses a mismatched resource without burning the refresh token", async () => {
      const { code, verifier } = await codeFor(`${url}/mcp`);
      const pair = (await (await exchange(code, verifier)).json()) as { refresh_token: string };
      const foreign = await refresh(pair.refresh_token, "https://evil.example/mcp");
      expect(foreign.status).toBe(400);
      expect(((await foreign.json()) as { error: string }).error).toBe("invalid_target");
      await storage.raw().query("UPDATE oauth_tokens SET resource = $1 WHERE token_hash = $2", [
        "https://old.example/mcp",
        sha(pair.refresh_token),
      ]);
      const mismatched = await refresh(pair.refresh_token, url);
      expect(mismatched.status).toBe(400);
      expect(((await mismatched.json()) as { error: string }).error).toBe("invalid_target");
      const unnamed = await refresh(pair.refresh_token);
      expect(unnamed.status).toBe(400);
      expect(((await unnamed.json()) as { error: string }).error).toBe("invalid_grant");
      await storage.raw().query("UPDATE oauth_tokens SET resource = $1 WHERE token_hash = $2", [
        `${url}/mcp`,
        sha(pair.refresh_token),
      ]);
      expect((await refresh(pair.refresh_token)).status).toBe(200);
    });
  });
});

/**
 * The operator-gated flow, end to end: /authorize bounces an unauthenticated
 * browser to the admin login, the target is parked, and after signing in the
 * operator confirms it and gets the code. Before this the login dropped
 * `return_to` AND the session cookie was scoped to /admin, so `/authorize`
 * could not see the operator at all — the connector never finished, however
 * many times you signed in.
 */
describe("MEMRAIN_OAUTH_REQUIRE_LOGIN with no admin surface fails closed", () => {
  it("refuses to issue a code rather than auto-approving", async () => {
    process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN = "1";
    const tmp = mkdtempSync(join(tmpdir(), "memrain-oauth-noadmin-"));
    const storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    const provider = new OAuthProvider({ engine: storage.raw() });
    const reg = await provider.registerClientManual(
      "no-admin-client", ["authorization_code"], "read", [REDIRECT], "default", undefined, "none",
    );
    // No adminBootstrapToken: the operator asked for a consent gate that cannot
    // be enforced. Auto-approving here would be the exact posture the flag exists
    // to prevent.
    const s = startServer({ host: "127.0.0.1", port: 0, storage, oauthProvider: provider });
    try {
      const res = await fetch(
        `http://127.0.0.1:${s.port}/authorize?response_type=code&client_id=${reg.clientId}`
        + `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=ch&code_challenge_method=S256`,
        { redirect: "manual" },
      );
      expect(res.status).toBe(302);
      const loc = res.headers.get("location")!;
      expect(loc).toStartWith("/admin/login?return_to=");
      expect(loc).not.toContain("code=");
    } finally {
      await s.stop();
      await storage.close();
      rmSync(tmp, { recursive: true, force: true });
      delete process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN;
    }
  });
});

describe("MEMRAIN_OAUTH_REQUIRE_LOGIN — the parked /authorize is resumable after sign-in", () => {
  let tmp: string;
  let storage: Storage;
  let server: ServerHandle;
  let url: string;
  let clientId: string;

  beforeEach(async () => {
    process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN = "1";
    tmp = mkdtempSync(join(tmpdir(), "memrain-oauth-resume-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    const provider = new OAuthProvider({ engine: storage.raw() });
    const reg = await provider.registerClientManual(
      "browser-client",
      ["authorization_code", "refresh_token"],
      "read",
      [REDIRECT],
      "default",
      undefined,
      "none",
    );
    clientId = reg.clientId;
    server = startServer({
      host: "127.0.0.1",
      port: 0,
      storage,
      publicBearerToken: PUB_TOKEN,
      oauthProvider: provider,
      adminBootstrapToken: ADMIN_TOKEN,
    });
    url = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    delete process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN;
    await server.stop();
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("bounce → park → sign in → confirm → code", async () => {
    const { challenge } = pkce();
    const authorizeQuery = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: "read",
      state: "st-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

    // 1. Unauthenticated /authorize → bounced to the admin login.
    const bounced = await fetch(`${url}/authorize?${authorizeQuery}`, { redirect: "manual" });
    expect(bounced.status).toBe(302);
    const loginPath = bounced.headers.get("location")!;
    expect(loginPath).toStartWith("/admin/login?return_to=");

    // 2. The login page parks the flow in a cookie and shows the SPA.
    const parked = await fetch(`${url}${loginPath}`, { redirect: "manual" });
    expect(parked.status).toBe(302);
    expect(parked.headers.get("location")).toBe("/admin/");
    const resumeCookie = parked.headers.getSetCookie()
      .find((c) => c.startsWith("memrain_return_to="))!
      .split(";")[0]!;

    // 3. The magic link signs the operator in — and lands on the dashboard, not
    //    on the parked target: an unattended resume is what a planted cookie
    //    would exploit.
    const mint = await fetch(`${url}/admin/api/issue-magic-link`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const { url: magic } = (await mint.json()) as { url: string };
    const redeemed = await fetch(magic, { redirect: "manual", headers: { Cookie: resumeCookie } });
    expect(redeemed.status).toBe(302);
    expect(redeemed.headers.get("location")).toBe("/admin/");
    const sessionCookie = redeemed.headers.getSetCookie()
      .find((c) => c.startsWith("memrain_admin="))!;
    // Path=/ — scoped to /admin this cookie would never reach /authorize, and
    // the operator could never be recognized there.
    expect(sessionCookie).toContain("Path=/;");
    const session = sessionCookie.split(";")[0]!;

    // 4. The SPA asks what is parked and shows it for confirmation.
    const pending = await fetch(`${url}/admin/api/pending-resume`, {
      headers: { Cookie: `${session}; ${resumeCookie}` },
    });
    const shown = (await pending.json()) as {
      handle: string; redirect_to: string; client_name: string; redirect_uri: string;
    };
    expect(shown.redirect_to).toBe(`/authorize?${authorizeQuery}`);
    expect(shown.client_name).toBe("browser-client");
    expect(shown.redirect_uri).toBe(REDIRECT);

    // 4a. The session ALONE is not consent — replaying the parked request
    //     without the operator's click bounces instead of minting a code.
    const unapproved = await fetch(`${url}${shown.redirect_to}`, {
      redirect: "manual",
      headers: { Cookie: session },
    });
    expect(unapproved.status).toBe(302);
    expect(unapproved.headers.get("location")).toStartWith("/admin/login?return_to=");

    // 5. The click mints a one-time approval bound to this request. The handle
    //    ties it to what the panel rendered.
    const approved = await fetch(`${url}/admin/api/approve-resume`, {
      method: "POST",
      headers: { Cookie: `${session}; ${resumeCookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ handle: shown.handle }),
    });
    const { redirect_to: approvedTarget } = (await approved.json()) as { redirect_to: string };
    expect(approvedTarget).toContain("memrain_approval=");
    // The parked request is retired by the decision.
    expect(approved.headers.getSetCookie().find((c) => c.startsWith("memrain_return_to="))).toContain("Max-Age=0");

    const issued = await fetch(`${url}${approvedTarget}`, {
      redirect: "manual",
      headers: { Cookie: session },
    });
    expect(issued.status).toBe(302);
    const back = new URL(issued.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("st-1");
    expect(back.searchParams.get("code")).toMatch(/^memrain_code_/);

    // 6. The approval is single-use: replaying the very same URL bounces.
    const replay = await fetch(`${url}${approvedTarget}`, {
      redirect: "manual",
      headers: { Cookie: session },
    });
    expect(replay.headers.get("location")).toStartWith("/admin/login?return_to=");
  });

  it("shows the scope that omitting the parameter actually grants", async () => {
    // The provider grants the client's whole registered scope when the request
    // carries none, so a panel echoing the empty query value would understate
    // what is being handed over.
    const noScope = `/authorize?response_type=code&client_id=${clientId}`
      + `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=ch&code_challenge_method=S256`;
    const bounced = await fetch(`${url}${noScope}`, { redirect: "manual" });
    const parked = await fetch(`${url}${bounced.headers.get("location")!}`, { redirect: "manual" });
    const resumeCookie = parked.headers.getSetCookie()
      .find((c) => c.startsWith("memrain_return_to="))!.split(";")[0]!;
    const login = await fetch(`${url}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    const session = login.headers.getSetCookie()
      .find((c) => c.startsWith("memrain_admin="))!.split(";")[0]!;

    const pending = await fetch(`${url}/admin/api/pending-resume`, {
      headers: { Cookie: `${session}; ${resumeCookie}` },
    });
    expect(((await pending.json()) as { scope: string }).scope).toBe("read");
  });

  it("keeps only the local path, and parks nothing for another route", async () => {
    // A foreign host is stripped: what is parked is this server's own
    // /authorize, so the later navigation cannot leave this origin.
    const foreign = `/admin/login?return_to=${encodeURIComponent("https://evil.example/authorize?client_id=x")}`;
    const res = await fetch(`${url}${foreign}`, { redirect: "manual" });
    expect(res.headers.get("location")).toBe("/admin/");
    expect(res.headers.getSetCookie().find((c) => c.startsWith("memrain_return_to=")))
      .toContain("memrain_return_to=%2Fauthorize%3Fclient_id%3Dx");

    // Any other route is not a resumable target at all.
    const other = `/admin/login?return_to=${encodeURIComponent("/admin/api/full-stats")}`;
    const res2 = await fetch(`${url}${other}`, { redirect: "manual" });
    expect(res2.status).not.toBe(302);
    expect(res2.headers.getSetCookie().some((c) => c.startsWith("memrain_return_to="))).toBe(false);
  });
});
