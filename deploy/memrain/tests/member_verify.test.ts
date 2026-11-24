/**
 * A credential bound to a member works only while that member is the brain's
 * enabled owner (config access.owner_member). Any other binding is refused,
 * so a pre-Lite team key never turns back on as an unbound one, and disabling the
 * owner stops the owner's keys too. An unbound credential verifies as before.
 *
 * Driven through the real paths a request takes: verifyAccessToken (what /mcp
 * calls) and the HTTP server.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { InvalidTokenError, OAuthProvider, type OAuthClientInfo } from "../src/core/oauth-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CB = "https://example.invalid/cb";

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-member-verify-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: "team", kind: "other", pathPrefix: "tenant:team" });
  await storage.engine().exec(`
    INSERT INTO members (id, status) VALUES ('ora', 'enabled'), ('bob', 'enabled'), ('carl', 'disabled');
    INSERT INTO config (key, value) VALUES ('access.owner_member', 'ora');
  `);
  provider = new OAuthProvider({ engine: storage.raw() });
}, 30_000);

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
}, 30_000);

async function mintPat(name: string, member: string | null = null) {
  const token = "memrain_" + randomBytes(24).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  const r = await storage.raw().query<{ id: number }>(
    `INSERT INTO access_tokens (name, token_hash, scopes, permissions, member_id) VALUES ($1, $2, ARRAY['read','write'], $3::jsonb, $4) RETURNING id`,
    [name, hash, { source_id: "team" }, member],
  );
  return { token, id: String(r.rows[0]!.id) };
}

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "accepted";
  } catch (e) {
    expect(e).toBeInstanceOf(InvalidTokenError);
    return (e as Error).message;
  }
}

const setOwnerStatus = (status: "enabled" | "disabled") =>
  storage.engine().query(`UPDATE members SET status = $1 WHERE id = 'ora'`, [status]);

describe("personal access tokens", () => {
  // Value: protects=unbound keys keep working unchanged; fails_when=the member check starts
  // querying or refusing credentials that name no member; why_new=the rule changed; seam=none
  it("an unbound token verifies exactly as before", async () => {
    const { token } = await mintPat("plain");
    const info = await provider.verifyAccessToken(token);
    expect(info).toMatchObject({ clientId: "plain", sourceId: "team", allowedSources: ["team"], scopes: ["read", "write"] });
    expect(info.memberId).toBeUndefined();
  });

  // Value: protects=the owner's key reads as the owner and nothing wider; fails_when=the owner
  // binding is refused, or widens the source grant; why_new=groups no longer widen reads; seam=none
  it("a token bound to the enabled owner works, reads as the owner and keeps its own grant", async () => {
    const { token, id } = await mintPat("ora-laptop", "ora");
    const info = await provider.verifyAccessToken(token);
    expect(info).toMatchObject({ clientId: "ora-laptop", memberId: "ora", allowedSources: ["team"] });
  });

  // Value: protects=a pre-Lite team key never verifies; fails_when=a non-owner binding is treated as
  // unbound; why_new=members are gone, so the binding can no longer be checked; seam=none
  it("a token bound to another member is refused, enabled or not", async () => {
    const bob = await mintPat("bob-key", "bob");
    const carl = await mintPat("carl-key", "carl");
    expect(await refused(provider.verifyAccessToken(bob.token))).toContain("credential_unsupported");
    expect(await refused(provider.verifyAccessToken(carl.token))).toContain("credential_unsupported");
  });

  // Value: protects=disabling the owner still stops the owner's keys; fails_when=the owner is
  // read from config without its status; why_new=the owner is the only member a key may name; seam=none
  it("the owner's token is refused while the owner is disabled and works again once enabled", async () => {
    const { token } = await mintPat("ora-phone", "ora");
    await setOwnerStatus("disabled");
    try {
      expect(await refused(provider.verifyAccessToken(token))).toContain("credential_unsupported");
    } finally {
      await setOwnerStatus("enabled");
    }
    expect((await provider.verifyAccessToken(token)).memberId).toBe("ora");
  });

  // Value: protects=a credential issued with a read floor never reads unfiltered text;
  // fails_when=min_trust is ignored again; why_new=no tool filters by tier any more; seam=none
  it("a token with a read floor is refused", async () => {
    const { token } = await mintPat("floored");
    await storage.engine().query(`UPDATE access_tokens SET min_trust = 'member' WHERE name = 'floored'`);
    expect(await refused(provider.verifyAccessToken(token))).toContain("credential_unsupported");
  });
});

describe("OAuth credentials", () => {
  let client: OAuthClientInfo;

  beforeAll(async () => {
    const reg = await provider.registerClientManual("team-connector", ["authorization_code", "refresh_token"], "read write", [CB], "team");
    client = (await provider.getClient(reg.clientId))!;
  });

  async function enroll() {
    const issued = await provider.issueEnrollment({ sourceId: "team", label: "x" });
    const grant = await provider.claimEnrollment(issued.code, client.client_id);
    const { redirectUrl } = await provider.authorize(client, { redirectUri: CB, codeChallenge: CHALLENGE, scopes: ["read", "write"] }, grant);
    const code = new URL(redirectUrl).searchParams.get("code")!;
    return { enrollmentId: issued.id, tokens: await provider.exchangeAuthorizationCode(client, code, undefined, CB) };
  }

  // Value: protects=an enrollment of another person is refused, the owner's keeps working;
  // fails_when=the enrollment binding is skipped; why_new=the rule changed; seam=none
  it("an enrollment bound to the owner works; one bound to another member is refused", async () => {
    const mine = await enroll();
    const theirs = await enroll();
    await storage.engine().query(`UPDATE oauth_enrollments SET member_id = 'ora' WHERE id = $1`, [mine.enrollmentId]);
    await storage.engine().query(`UPDATE oauth_enrollments SET member_id = 'bob' WHERE id = $1`, [theirs.enrollmentId]);
    expect((await provider.verifyAccessToken(mine.tokens.access_token)).memberId).toBe("ora");
    expect(await refused(provider.verifyAccessToken(theirs.tokens.access_token))).toContain("credential_unsupported");
    const rotated = await provider.exchangeRefreshToken(client, mine.tokens.refresh_token!);
    expect((await provider.verifyAccessToken(rotated.access_token)).memberId).toBe("ora");
  });

  // Value: protects=a client bound to another member refuses every token it issued;
  // fails_when=the client binding is skipped; why_new=the rule changed; seam=none
  it("a client bound to another member refuses every token it issued", async () => {
    const reg = await provider.registerClientManual("bob-agent", ["client_credentials"], "read", [], "team");
    const tokens = await provider.exchangeClientCredentials(reg.clientId, reg.clientSecret!);
    expect((await provider.verifyAccessToken(tokens.access_token)).clientId).toBe(reg.clientId);
    await storage.engine().query(`UPDATE oauth_clients SET member_id = 'bob' WHERE client_id = $1`, [reg.clientId]);
    expect(await refused(provider.verifyAccessToken(tokens.access_token))).toContain("credential_unsupported");
  });

  // Value: protects=a client with a read floor is refused; fails_when=min_trust on a client is
  // ignored; why_new=same as the token case; seam=none
  it("a client with a read floor refuses every token it issued", async () => {
    const reg = await provider.registerClientManual("floored-agent", ["client_credentials"], "read", [], "team");
    const tokens = await provider.exchangeClientCredentials(reg.clientId, reg.clientSecret!);
    await storage.engine().query(`UPDATE oauth_clients SET min_trust = 'owner' WHERE client_id = $1`, [reg.clientId]);
    expect(await refused(provider.verifyAccessToken(tokens.access_token))).toContain("credential_unsupported");
  });
});

describe("over HTTP", () => {
  let server: ServerHandle;
  let url: string;

  beforeAll(() => {
    server = startServer({ host: "127.0.0.1", port: 0, storage, publicBearerToken: "pub-bearer-member-test", oauthProvider: provider });
    url = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => { await server.stop(); });

  const listTools = (bearer: string) => fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearer}`,
      "Cf-Connecting-Ip": "9.9.9.9",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

  // Value: protects=the refusal reaches the wire as 401; fails_when=the transport maps the
  // refusal to anything else; why_new=the rule changed; seam=none
  it("a key bound to another member is turned away on /mcp; the owner's is served", async () => {
    const theirs = await mintPat("bob-http", "bob");
    const mine = await mintPat("ora-http", "ora");
    expect((await listTools(theirs.token)).status).toBe(401);
    expect((await listTools(mine.token)).status).toBe(200);
  });
});
