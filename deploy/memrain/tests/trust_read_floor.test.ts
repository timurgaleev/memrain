/**
 * Per-credential read floors (migration 186). A credential with `min_trust`
 * reads only rows at or above that tier: the tools that filter by tier apply
 * the stricter of the floor and the call's own min_trust, every other tool
 * that returns stored text is refused (and hidden from tools/list), and
 * text-free tools still answer. No floor, the default, changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { dispatchRefusal, visibleToolDefs } from "../src/mcp/visibility.ts";
import { OPERATIONS } from "../src/mcp/operations.ts";
import { READ_FLOOR_FILTERED, READ_FLOOR_TEXT_FREE } from "../src/mcp/read-floor.ts";
import { setCredentialMinTrust } from "../src/core/token-min-trust.ts";
import { deterministicEmbedQuery } from "./det-embed.ts";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

const auth = (minTrust?: AuthInfo["minTrust"]): AuthInfo => ({
  token: "t", clientId: "reader", scopes: ["read", "write"], isPublic: false, ...(minTrust ? { minTrust } : {}),
});

describe("read floor classification", () => {
  it("names every read tool once, and a floor hides exactly the unfiltered text tools", () => {
    const read = OPERATIONS.filter(o => (o.scope ?? "read") === "read").map(o => o.name);
    for (const name of READ_FLOOR_FILTERED) expect(READ_FLOOR_TEXT_FREE.has(name)).toBe(false);
    for (const name of read) {
      // A tool already refused to every token (operator-only) stays refused for that reason.
      if (dispatchRefusal(name, auth()) !== null) continue;
      const open = READ_FLOOR_FILTERED.has(name) || READ_FLOOR_TEXT_FREE.has(name);
      expect([name, dispatchRefusal(name, auth("owner"))?.kind ?? null]).toEqual([name, open ? null : "trust_floor"]);
    }
    // A write tool is not a read; one that returns what it read is refused.
    expect(dispatchRefusal("page_put", auth("owner"))).toBeNull();
    expect(dispatchRefusal("think", auth("owner"))?.kind).toBe("trust_floor");
    // Writes whose reply quotes stored rows: a dry run's before, an edit diff, a duplicate event.
    for (const name of ["takes_add", "takes_update", "takes_resolve", "page_edit", "add_timeline_event"])
      expect([name, dispatchRefusal(name, auth("owner"))?.kind]).toEqual([name, "trust_floor"]);
    const listed = visibleToolDefs({ isPublic: false, authInfo: auth("owner") }, () => false).map(t => t.name);
    expect(listed).toContain("search");
    expect(listed).not.toContain("page_get");
  });
});

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`read floor in dispatch (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  const page = async (slug: string, body: string, principal: string) => {
    await putPage(db.storage, { slug, markdown_body: body, title: slug, written_by_principal: principal });
    await indexPageIntoSearch(db.storage, { slug, markdown_body: body, title: slug }, { embedFn: deterministicEmbedQuery });
  };
  const call = (tool: string, args: Record<string, unknown>, a?: AuthInfo) =>
    dispatchTool(db.storage, { name: tool, arguments: args }, { embedQuery: deterministicEmbedQuery, ...(a ? { authInfo: a } : {}) });
  const paths = async (args: Record<string, unknown>, a: AuthInfo) => {
    const r = await call("search", { q: "quince ledger", ...args }, a);
    expect(r.isError).toBeFalsy();
    return (JSON.parse(r.content[0]!.text).hits as { sourcePath: string }[]).map(h => h.sourcePath).sort();
  };

  beforeAll(async () => {
    db = await open();
    await page("notes/own", "Quince ledger by the owner", "operator");
    await page("notes/agent", "Quince ledger by an agent", "client:bot");
  });
  afterAll(async () => { await db.close(); });

  it("search applies the floor even when the call asks for less", async () => {
    expect(await paths({}, auth())).toEqual(["page://notes/agent", "page://notes/own"]);
    expect(await paths({}, auth("owner"))).toEqual(["page://notes/own"]);
    expect(await paths({ min_trust: "external" }, auth("owner"))).toEqual(["page://notes/own"]);
    expect(await paths({ min_trust: "owner" }, auth("agent"))).toEqual(["page://notes/own"]);
  });

  it("query and context_pack apply it too", async () => {
    const q = await call("query", { q: "quince ledger" }, auth("owner"));
    expect((JSON.parse(q.content[0]!.text).hits as { sourcePath: string }[]).map(h => h.sourcePath)).toEqual(["page://notes/own"]);
    const pack = await call("context_pack", { slugs: ["notes/own", "notes/agent"], token_budget: 8000 }, auth("owner"));
    expect(JSON.parse(pack.content[0]!.text).cards.map((c: { slug: string }) => c.slug)).toEqual(["notes/own"]);
  });

  it("refuses a tool that cannot filter by tier, and answers text-free ones", async () => {
    const r = await call("page_get", { slug: "notes/agent" }, auth("owner"));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("permission_denied");
    expect(r.content[0]!.text).toContain("trust floor");
    const who = await call("whoami", {}, auth("member"));
    expect(who.isError).toBeFalsy();
    expect(JSON.parse(who.content[0]!.text).min_trust).toBe("member");
    // No floor: the same read goes through.
    expect((await call("page_get", { slug: "notes/agent" }, auth())).isError).toBeFalsy();
  });

  it("sets a floor on a token or a client from the local CLI path only, and clears it", async () => {
    const e = db.storage.engine();
    await e.query(`INSERT INTO access_tokens (name, token_hash, scopes) VALUES ('laptop', 'h1', ARRAY['read'])`);
    await e.query(`INSERT INTO oauth_clients (client_id, client_name, client_secret_hash, redirect_uris, grant_types, scope)
                   VALUES ('memrain_cl_x', 'Bot', 'h', ARRAY[]::text[], ARRAY['client_credentials'], 'read')`);
    expect(await setCredentialMinTrust(e, "laptop", "agent")).toMatchObject({ kind: "token", name: "laptop", before: null, after: "agent" });
    expect(await setCredentialMinTrust(e, "memrain_cl_x", "owner")).toMatchObject({ kind: "oauth_client", before: null, after: "owner" });
    expect(await setCredentialMinTrust(e, "laptop", null)).toMatchObject({ before: "agent", after: null });
    await e.query(`INSERT INTO access_tokens (name, token_hash, scopes) VALUES ('dup', 'h2', ARRAY['read']), ('dup', 'h3', ARRAY['read'])`);
    await expect(setCredentialMinTrust(e, "dup", "owner")).rejects.toThrow("2 active tokens");
    await expect(setCredentialMinTrust(e, "nobody", "owner")).rejects.toThrow("No active");
  });
});

describe("read floor over HTTP, through the real verifier", () => {
  let tmp: string;
  let storage: Storage;
  let server: ServerHandle;
  let url: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-floor-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    server = startServer({ host: "127.0.0.1", port: 0, storage, publicBearerToken: "pub-floor", oauthProvider: new OAuthProvider({ engine: storage.raw() }) });
    url = `http://127.0.0.1:${server.port}`;
  }, 30_000);
  afterAll(async () => {
    await server.stop();
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  }, 30_000);

  async function mint(name: string, floor: string | null): Promise<string> {
    const token = "memrain_" + randomBytes(24).toString("hex");
    await storage.raw().query(
      `INSERT INTO access_tokens (name, token_hash, scopes, min_trust) VALUES ($1, $2, ARRAY['read','write'], $3)`,
      [name, createHash("sha256").update(token).digest("hex"), floor],
    );
    return token;
  }
  const rpc = async (bearer: string, method: string, params: unknown) => {
    const r = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${bearer}`, "Cf-Connecting-Ip": "9.9.9.9" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    expect(r.status).toBe(200);
    return (await r.json()) as { result: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } };
  };

  it("a floored token lists no unfiltered read tool and is refused one; an unfloored token is not", async () => {
    const floored = await mint("floored", "owner");
    const plain = await mint("plain", null);
    expect((await rpc(floored, "tools/list", {})).result.tools!.map(t => t.name)).not.toContain("page_get");
    expect((await rpc(plain, "tools/list", {})).result.tools!.map(t => t.name)).toContain("page_get");
    const refused = await rpc(floored, "tools/call", { name: "page_get", arguments: { slug: "x" } });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content![0]!.text).toContain("permission_denied");
    const who = await rpc(floored, "tools/call", { name: "whoami", arguments: {} });
    expect(JSON.parse(who.result.content![0]!.text).min_trust).toBe("owner");
  });
});
