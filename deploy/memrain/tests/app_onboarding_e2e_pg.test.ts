/**
 * Gate 7: from an invite link to the first answer in under five minutes, on
 * a hosted tenant's ingress (MEMRAIN_PUBLIC_AUTH=oauth, MEMRAIN_ASSUME_PUBLIC=1,
 * no static bearer, hosting mode on).
 *
 *   1. the member opens the invite and registers a passkey (software
 *      authenticator, real SimpleWebAuthn verification);
 *   2. connects a client, by both paths, one test each:
 *        OAuth  POST /app/api/connect/enrollment → /authorize with PKCE and
 *               the code → /token → tools/call search, over HTTP;
 *        PAT    POST /app/api/connect/token → tools/call search, over HTTP;
 *   3. pastes a note; 4. asks, and the answer comes back ok.
 *
 * Every wizard step must close, `connected_at` must come from the member's
 * own credential, and the time is read from the database, not a stopwatch:
 * onboarding_state.first_answer_at − member_invites.opened_at. The model is a
 * stub; nothing is spent. Runs on PGLite, and on Postgres under make test-pg.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";
import { storageEngines } from "./helpers/storage-engines.ts";
import { SoftAuthenticator } from "./helpers/soft-authenticator.ts";
import { deterministicEmbedQuery } from "./det-embed.ts";
import type { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import { addMember, type MemberActor } from "../src/core/members.ts";
import { mintMemberInvite } from "../src/core/member-invites.ts";
import { APP_COOKIE } from "../src/core/member-sessions.ts";
import { OAuthProvider, type OAuthClientInfo } from "../src/core/oauth-provider.ts";
import { setTenantPolicySource, SINGLE_TENANT_POLICY } from "../src/control/contract.ts";
import { resetAppAuthState } from "../src/http/app-auth.ts";
import { handleApp } from "../src/http/app.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import { RateLimiter } from "../src/mcp/rate_limit.ts";
import type { SonnetFn } from "../src/core/llm/sonnet.ts";

setDefaultTimeout(120_000);

const ORIGIN = "https://walk.example.test";
const RP_ID = "walk.example.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const INTERNAL = ["walk", "tenant", "internal", "token"].join("-");
const OPS: MemberActor = { actor: "ops", via: "cli" };
const MACHINE_PATH_LIMIT_S = 60;
const ENV: Record<string, string> = {
  MEMRAIN_APP: "1",
  MEMRAIN_TENANT_ID: "walk",
  MEMRAIN_PUBLIC_AUTH: "oauth",
  MEMRAIN_ASSUME_PUBLIC: "1",
  MEMRAIN_REQUIRE_MEMBER: "1",
  MEMRAIN_KEYWORD_ONLY: "1",
  MEMRAIN_CHAT: "1",
  MEMRAIN_DAILY_BUDGET_USD: "5",
};
const saved = Object.fromEntries([...Object.keys(ENV), "MEMRAIN_CHAT_MODELS"].map((k) => [k, process.env[k]]));
const setEnv = () => {
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
  delete process.env["MEMRAIN_CHAT_MODELS"];
};
afterEach(setEnv);
afterAll(() => {
  setTenantPolicySource(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Cites every page it was shown. */
const model: SonnetFn = async (input) => {
  const refs = [...new Set(JSON.stringify(input).match(/page:\/\/[\w./-]+/g) ?? [])];
  return {
    text: JSON.stringify({
      answer: `The tomatoes go in the north bed ${refs.map((r) => `[${r}]`).join(" ")}.`,
      citations: refs.map((ref) => ({ ref, kind: "page" })),
      gaps: [],
    }),
    modelId: "eu.anthropic.claude-haiku-5-5",
    usage: { inputTokens: 800, outputTokens: 100 },
  };
};

/** A browser on /app: keeps the cookies the app sets and sends them back. */
class Browser {
  jar = new Map<string, string>();
  constructor(readonly storage: Storage) {}

  async call(path: string, method = "GET", body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { origin: ORIGIN };
    if (this.jar.size > 0) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body !== undefined) headers["content-type"] = "application/json";
    const req = new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const res = await handleApp(req, new URL(req.url), {
      storage: this.storage, publicUrl: ORIGIN, oauthProvider: new OAuthProvider({ engine: this.storage.engine() }),
      chatModel: model, embedQuery: deterministicEmbedQuery, sendLimiter: new RateLimiter({ capacity: 5, refillPerSecond: 0 }),
    });
    if (!res) throw new Error(`not handled: ${path}`);
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(";")[0]!;
      const eq = pair.indexOf("=");
      const value = pair.slice(eq + 1);
      if (value === "") this.jar.delete(pair.slice(0, eq));
      else this.jar.set(pair.slice(0, eq), value);
    }
    return res;
  }

  async json<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const res = await this.call(path, method, body);
    expect({ path, status: res.status }).toEqual({ path, status: 200 });
    return (await res.json()) as T;
  }
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`gate 7: invite to first answer (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  let storage: Storage;
  let server: ServerHandle;
  let base: string;
  let connector: OAuthClientInfo;

  beforeAll(async () => {
    setEnv();
    setTenantPolicySource(async () => SINGLE_TENANT_POLICY);
    resetAppAuthState();
    db = await open();
    storage = db.storage;
    const e = storage.engine();
    for (const id of ["walker", "keyholder"]) {
      await registerSource(e, { id: `person-${id}`, kind: "other", pathPrefix: `/person-${id}` });
      await addMember(e, id, { personalSource: `person-${id}`, displayName: id }, OPS);
    }
    const provider = new OAuthProvider({ engine: e });
    const c = await provider.registerClientManual(
      "walk-connector", ["authorization_code", "refresh_token"], "read write", [REDIRECT], "default",
      undefined, "none", undefined, "enrollment",
    );
    connector = (await provider.getClient(c.clientId))!;
    server = startServer({ host: "127.0.0.1", port: 0, storage, internalToken: INTERNAL, oauthProvider: provider, publicUrl: ORIGIN });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => {
    await server?.stop();
    await db?.close();
  });

  /** Invite → passkey → session. Returns the signed-in browser. */
  async function signUp(member: string): Promise<Browser> {
    const { token } = await mintMemberInvite(storage.engine(), member, 3600_000);
    const b = new Browser(storage);
    const soft = new SoftAuthenticator(ORIGIN, RP_ID);
    await b.json("/app/invite/open", "POST", { token });
    const { optionsJSON } = await b.json<{ optionsJSON: PublicKeyCredentialCreationOptionsJSON }>("/app/invite/passkey/options", "POST", { token });
    await b.json("/app/invite/passkey/verify", "POST", { token, response: soft.register(optionsJSON), label: "Laptop" });
    expect(b.jar.has(APP_COOKIE)).toBe(true);
    return b;
  }

  async function searchOverHttp(bearer: string): Promise<void> {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { q: "garden" } } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { isError?: boolean }; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(body.result?.isError ? JSON.stringify(body).slice(0, 600) : "ok").toBe("ok");
  }

  async function fillAndAsk(b: Browser): Promise<void> {
    await b.json("/app/api/onboarding/paste", "POST", { title: "Garden plan", text: "The tomatoes go in the north bed of the garden." });
    // Keyword-only search (no embeddings in the test) needs the note's own words.
    const res = await b.call("/app/api/chat", "POST", { message: "garden plan tomatoes" });
    expect(res.status).toBe(200);
    const block = (await res.text()).split("\n\n").find((x) => x.startsWith("event: answer"));
    if (!block) throw new Error("no answer event");
    const answer = JSON.parse(block.split("\n").slice(1).join("\n").slice("data: ".length)) as { status: string };
    expect(answer.status === "ok" ? "ok" : block.slice(0, 1500)).toBe("ok");
  }

  async function measuredSeconds(member: string): Promise<number> {
    const r = await storage.engine().query<{ s: number | string | null }>(
      `SELECT extract(epoch FROM o.first_answer_at - (SELECT min(i.opened_at) FROM member_invites i WHERE i.member_id = o.member_id))::float8 AS s
         FROM onboarding_state o WHERE o.member_id = $1`,
      [member],
    );
    return Number(r.rows[0]?.s);
  }

  it("OAuth path: code → /authorize (PKCE) → /token → tools/call, then fill and ask", async () => {
    const b = await signUp("walker");
    expect(await b.json("/app/api/onboarding")).toMatchObject({ step: "connect", connected_at: null });

    const { code, client_id } = await b.json<{ code: string; client_id: string }>("/app/api/connect/enrollment", "POST", {});
    expect(client_id).toBe(connector.client_id);
    const authz = await fetch(`${base}/authorize?${new URLSearchParams({
      client_id, redirect_uri: REDIRECT, response_type: "code", code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s",
    })}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ enrollment_code: code }).toString(),
    });
    expect(authz.status).toBe(303);
    const authCode = new URL(authz.headers.get("location")!).searchParams.get("code")!;
    const tok = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: authCode, code_verifier: VERIFIER, client_id, redirect_uri: REDIRECT }).toString(),
    });
    expect(tok.status).toBe(200);
    const { access_token } = (await tok.json()) as { access_token: string };
    await searchOverHttp(access_token);
    expect((await b.json<{ step: string; connected_at: string | null }>("/app/api/onboarding")).connected_at).not.toBeNull();

    await fillAndAsk(b);
    const done = await b.json<Record<string, string | null>>("/app/api/onboarding");
    expect(done).toMatchObject({ step: "done" });
    for (const k of ["connected_at", "first_write_at", "first_answer_at", "opened_at"]) expect(done[k]).not.toBeNull();
    const seconds = await measuredSeconds("walker");
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThan(MACHINE_PATH_LIMIT_S);
  });

  it("PAT path: a member key → tools/call closes connect, then fill and ask", async () => {
    const b = await signUp("keyholder");
    const { token } = await b.json<{ token: string }>("/app/api/connect/token", "POST", { label: "Claude Code" });
    // A key that exists but was never used does not count as connected.
    expect((await b.json<{ connected_at: string | null }>("/app/api/onboarding")).connected_at).toBeNull();
    await searchOverHttp(token);
    expect((await b.json<{ step: string; connected_at: string | null }>("/app/api/onboarding")).connected_at).not.toBeNull();

    await fillAndAsk(b);
    expect(await b.json("/app/api/onboarding")).toMatchObject({ step: "done" });
    const seconds = await measuredSeconds("keyholder");
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThan(MACHINE_PATH_LIMIT_S);
  });

  it("without a credential the hosted ingress answers 401, never 503", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
});
