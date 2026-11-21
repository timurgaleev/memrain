/**
 * A public client in client tenant mode needs an operator behind /authorize.
 *
 * Such a client has no secret — PKCE alone redeems its codes — and every grant
 * it gets lands in its own row's tenant. While /authorize auto-approves, its
 * client_id is therefore all it takes to mint a token for that tenant. The
 * server refuses it there (RFC 6749 §4.1.2.1 error redirect), refuses to
 * self-register one, and the CLI refuses to create one. Enrollment mode stays
 * open: the one-time code is the credential. Confidential clients are unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider, type OAuthClientInfo, type OAuthTokens } from "../src/core/oauth-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import { handleAuthorizeRoute, handleTokenRoute } from "../src/http/oauth-endpoints.ts";
import { startServer } from "../src/http/server.ts";
import { runAuth } from "../src/commands/auth.ts";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const ORIGIN = "http://brain.example.test";

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;
let publicClient: OAuthClientInfo;
let publicEnrollment: OAuthClientInfo;
let confidential: OAuthClientInfo;

function authorizeUrl(client: OAuthClientInfo): string {
  const q = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "s1",
  });
  return `${ORIGIN}/authorize?${q}`;
}

async function codeCount(): Promise<number> {
  const r = await storage.engine().query<{ n: number }>("SELECT COUNT(*)::int AS n FROM oauth_codes");
  return r.rows[0]?.n ?? 0;
}

async function register(name: string, authMethod: string | undefined, mode: "client" | "enrollment") {
  const reg = await provider.registerClientManual(
    name,
    ["authorization_code", "refresh_token"],
    "read write",
    [REDIRECT],
    "default",
    undefined,
    authMethod,
    undefined,
    mode,
  );
  return (await provider.getClient(reg.clientId))!;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-public-consent-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: "tina", kind: "other", pathPrefix: "tenant:tina" });
  provider = new OAuthProvider({ engine: storage.raw() });
  publicClient = await register("public-client-mode", "none", "client");
  publicEnrollment = await register("public-enrollment", "none", "enrollment");
  confidential = await register("confidential", undefined, "client");
}, 30_000);

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
}, 30_000);

/** A code for `client` as /authorize minted it before it started refusing. */
async function codeMintedBeforeRollout(client: OAuthClientInfo): Promise<string> {
  const { redirectUrl } = await provider.authorize(client, {
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
  });
  return new URL(redirectUrl).searchParams.get("code")!;
}

function tokenRequest(body: Record<string, string>): Request {
  return new Request(`${ORIGIN}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

describe("/token while /authorize auto-approves", () => {
  it("refuses to refresh a public client-mode token minted before the rollout", async () => {
    const pair: OAuthTokens = await provider.exchangeAuthorizationCode(
      publicClient,
      await codeMintedBeforeRollout(publicClient),
      undefined,
      REDIRECT,
    );
    const body = {
      grant_type: "refresh_token",
      refresh_token: pair.refresh_token!,
      client_id: publicClient.client_id,
    };
    const res = await handleTokenRoute(tokenRequest(body), provider);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unauthorized_client");

    // The refusal did not spend the row: behind an operator gate it rotates.
    const gated = await handleTokenRoute(tokenRequest(body), provider, false);
    expect(gated.status).toBe(200);
  });

  it("refuses a code that was in flight at the rollout", async () => {
    const res = await handleTokenRoute(
      tokenRequest({
        grant_type: "authorization_code",
        code: await codeMintedBeforeRollout(publicClient),
        redirect_uri: REDIRECT,
        code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        client_id: publicClient.client_id,
      }),
      provider,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unauthorized_client");
  });
});

describe("rescoping a client to enrollment mode", () => {
  it("strands its unbound refresh tokens and codes instead of re-admitting them", async () => {
    const client = await register("public-rescoped", "none", "client");
    const pair = await provider.exchangeAuthorizationCode(
      client,
      await codeMintedBeforeRollout(client),
      undefined,
      REDIRECT,
    );
    const inFlight = await codeMintedBeforeRollout(client);
    const body = {
      grant_type: "refresh_token",
      refresh_token: pair.refresh_token!,
      client_id: client.client_id,
    };
    expect((await handleTokenRoute(tokenRequest(body), provider)).status).toBe(400);

    await provider.rescopeClient(
      client.client_id,
      { sourceId: "tina", tenantMode: "enrollment" },
      { actor: "test", via: "cli" },
    );
    const rescoped = (await provider.getClient(client.client_id))!;
    expect(rescoped.tenant_mode).toBe("enrollment");

    // Nothing an enrollment approved: the tenant would come from the client row.
    const res = await handleTokenRoute(tokenRequest(body), provider);
    expect(res.status).toBe(400);
    await expect(
      provider.exchangeAuthorizationCode(rescoped, inFlight, undefined, REDIRECT),
    ).rejects.toThrow(/not found/);
  });
});

describe("/authorize while it auto-approves", () => {
  it("refuses a public client-mode client and mints no code", async () => {
    const before = await codeCount();
    const res = await handleAuthorizeRoute(new Request(authorizeUrl(publicClient)), provider);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("error")).toBe("unauthorized_client");
    expect(loc.searchParams.get("state")).toBe("s1");
    expect(loc.searchParams.get("code")).toBeNull();
    expect(await codeCount()).toBe(before);
  });

  it("issues that client a code once an operator approval gates the request", async () => {
    const res = await handleAuthorizeRoute(
      new Request(authorizeUrl(publicClient)),
      provider,
      () => true,
      false,
    );
    expect(new URL(res.headers.get("location")!).searchParams.get("code")).toMatch(/^memrain_code_/);
  });

  it("still lets a public enrollment-mode client in with a code", async () => {
    const { code } = await provider.issueEnrollment({
      sourceId: "tina",
      clientId: publicEnrollment.client_id,
    });
    const res = await handleAuthorizeRoute(
      new Request(authorizeUrl(publicEnrollment), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: ORIGIN,
          "Sec-Fetch-Site": "same-origin",
        },
        body: new URLSearchParams({ enrollment_code: code }).toString(),
      }),
      provider,
    );
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).searchParams.get("code")).toMatch(/^memrain_code_/);
  });

  it("leaves a confidential client-mode client unchanged", async () => {
    const res = await handleAuthorizeRoute(new Request(authorizeUrl(confidential)), provider);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("code")).toMatch(/^memrain_code_/);
  });

  it("names exactly the refused clients for the boot warning", async () => {
    const listed = (await provider.listClientsNeedingConsent()).map((c) => c.client_id);
    expect(listed).toContain(publicClient.client_id);
    expect(listed).not.toContain(publicEnrollment.client_id);
    expect(listed).not.toContain(confidential.client_id);
  });
});

describe("registration", () => {
  it("DCR on an auto-approving server refuses a public client, not a confidential one", async () => {
    process.env.MEMRAIN_ENABLE_DCR_INSECURE = "1";
    const s = startServer({ host: "127.0.0.1", port: 0, storage, oauthProvider: provider });
    try {
      const reg = (body: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${s.port}/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ redirect_uris: [REDIRECT], scope: "read", ...body }),
        });
      const pub = await reg({ client_name: "dcr-public", token_endpoint_auth_method: "none" });
      expect(pub.status).toBe(400);
      expect(((await pub.json()) as { error: string }).error).toBe("invalid_client_metadata");
      const conf = await reg({ client_name: "dcr-confidential" });
      expect(conf.status).toBe(201);
    } finally {
      await s.stop();
      delete process.env.MEMRAIN_ENABLE_DCR_INSECURE;
    }
  });

  it("the CLI refuses a public client-mode client unless login is required", async () => {
    const prior = process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN;
    process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN = "0";
    try {
      await expect(
        runAuth([
          "register-client",
          "cli-public",
          "--redirect-uris",
          REDIRECT,
          "--token-endpoint-auth-method",
          "none",
        ]),
      ).rejects.toThrow(/public client in client tenant mode/);
    } finally {
      if (prior === undefined) delete process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN;
      else process.env.MEMRAIN_OAUTH_REQUIRE_LOGIN = prior;
    }
  });
});
