/**
 * Disabling a member stops every one of that person's keys.
 *
 * The check lives in the token verifier, so it is driven here through the
 * real paths a request takes: verifyAccessToken (what /mcp and /ingest call),
 * resolvePrincipal (what a queued ingest job re-checks before it writes) and
 * the HTTP server itself with the headers a client really sends. A brain with
 * no members must verify exactly as before.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { InvalidTokenError, OAuthProvider, type OAuthClientInfo } from "../src/core/oauth-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import { addMember, bindCredential, disableMember, enableMember, removeMember, type MemberActor } from "../src/core/members.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";

const OPS: MemberActor = { actor: "ops", via: "cli" };
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
  provider = new OAuthProvider({ engine: storage.raw() });
}, 30_000);

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
}, 30_000);

async function mintPat(name: string, permissions: Record<string, unknown> = { source_id: "team" }) {
  const token = "memrain_" + randomBytes(24).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  const r = await storage.raw().query<{ id: number }>(
    `INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES ($1, $2, ARRAY['read','write'], $3::jsonb) RETURNING id`,
    [name, hash, permissions],
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

describe("a brain with no members", () => {
  it("verifies an unbound token exactly as before", async () => {
    const { token } = await mintPat("plain");
    const info = await provider.verifyAccessToken(token);
    expect(info).toMatchObject({ clientId: "plain", sourceId: "team", allowedSources: ["team"], scopes: ["read", "write"] });
    expect(info.toolSurface).toBeUndefined();
  });
});

describe("personal access tokens", () => {
  it("are refused while their member is disabled and work again once enabled", async () => {
    await addMember(storage.engine(), "alice", {}, OPS);
    const { token, id } = await mintPat("alice-laptop");
    await bindCredential(storage.engine(), "alice", { kind: "token", id: "alice-laptop" }, OPS);
    expect((await provider.verifyAccessToken(token)).clientId).toBe("alice-laptop");

    await disableMember(storage.engine(), "alice", OPS);
    expect(await refused(provider.verifyAccessToken(token))).toContain("member_disabled");
    // A capture queued before the disable must not write after it.
    expect(await refused(provider.resolvePrincipal({ kind: "pat", id }))).toContain("member_disabled");

    await enableMember(storage.engine(), "alice", OPS);
    expect((await provider.verifyAccessToken(token)).clientId).toBe("alice-laptop");
    expect((await provider.resolvePrincipal({ kind: "pat", id })).clientId).toBe("alice-laptop");
  });

  it("are refused for good once their member is removed", async () => {
    await addMember(storage.engine(), "bob", {}, OPS);
    const { token } = await mintPat("bob-key");
    await bindCredential(storage.engine(), "bob", { kind: "token", id: "bob-key" }, OPS);
    await removeMember(storage.engine(), "bob", OPS);
    expect(await refused(provider.verifyAccessToken(token))).toContain("member_disabled");
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

  it("an enrollment bound to a disabled member is refused; the connector's other people keep working", async () => {
    await addMember(storage.engine(), "carol", {}, OPS);
    const carol = await enroll();
    const dave = await enroll();
    await bindCredential(storage.engine(), "carol", { kind: "enrollment", id: carol.enrollmentId }, OPS);
    await disableMember(storage.engine(), "carol", OPS);
    expect(await refused(provider.verifyAccessToken(carol.tokens.access_token))).toContain("member_disabled");
    expect((await provider.verifyAccessToken(dave.tokens.access_token)).spendId).toBe(dave.enrollmentId);
    await enableMember(storage.engine(), "carol", OPS);
  });

  it("a replacement code for a disabled member's enrollment inherits the binding and stays refused", async () => {
    await addMember(storage.engine(), "gina", {}, OPS);
    const gina = await enroll();
    await bindCredential(storage.engine(), "gina", { kind: "enrollment", id: gina.enrollmentId }, OPS);
    await disableMember(storage.engine(), "gina", OPS);
    const issued = await provider.issueEnrollment({ replaces: gina.enrollmentId });
    const grant = await provider.claimEnrollment(issued.code, client.client_id);
    const { redirectUrl } = await provider.authorize(client, { redirectUri: CB, codeChallenge: CHALLENGE, scopes: ["read", "write"] }, grant);
    const code = new URL(redirectUrl).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, CB);
    expect(await refused(provider.verifyAccessToken(tokens.access_token))).toContain("member_disabled");
  });

  it("a client bound to a disabled member refuses every token it issued", async () => {
    await addMember(storage.engine(), "erin", {}, OPS);
    const reg = await provider.registerClientManual("erin-agent", ["client_credentials"], "read", [], "team");
    const tokens = await provider.exchangeClientCredentials(reg.clientId, reg.clientSecret!);
    await bindCredential(storage.engine(), "erin", { kind: "client", id: reg.clientId }, OPS);
    expect((await provider.verifyAccessToken(tokens.access_token)).clientId).toBe(reg.clientId);
    await disableMember(storage.engine(), "erin", OPS);
    expect(await refused(provider.verifyAccessToken(tokens.access_token))).toContain("member_disabled");
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

  const ingest = (bearer: string) => fetch(`${url}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${bearer}`, "Cf-Connecting-Ip": "9.9.9.9" },
    body: "a note",
  });

  it("a disabled member's token is turned away on /mcp and /ingest", async () => {
    await addMember(storage.engine(), "frank", {}, OPS);
    const { token } = await mintPat("frank-key");
    await bindCredential(storage.engine(), "frank", { kind: "token", id: "frank-key" }, OPS);
    expect((await listTools(token)).status).toBe(200);
    await disableMember(storage.engine(), "frank", OPS);
    expect((await listTools(token)).status).toBe(401);
    expect((await ingest(token)).status).toBe(401);
  });
});
