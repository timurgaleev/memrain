/**
 * Destructive MCP tools over the token-authenticated ingress.
 *
 * Scope model: delete/restore/revert/unlink/remove_tag/forget_fact are
 * `scope: write`, purge_deleted_pages is `scope: admin`. An authenticated
 * token principal whose grant covers the op may call it (source-scoped); the
 * static public bearer and the bare internal path (no internal token) stay
 * refused exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import { getPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";

const PUB_TOKEN = "pub-bearer-xyz789";
const INT_TOKEN = "internal-shared-token-abcdef";
const ERR_UNAUTHORIZED = -32001;

// Each test does several sequential OAuth mint + /mcp round-trips against an
// in-process pglite; the default 5s is too tight here (pathologically slow
// under local AV load — see CLAUDE.md), so raise the floor.
setDefaultTimeout(120_000);

let tmp: string;
let storage: Storage;
let provider: OAuthProvider;
let server: ServerHandle;
let url: string;

/** client_credentials token for a client registered with `scope`. */
async function mint(scope: string, sourceId = "default"): Promise<string> {
  const reg = await provider.registerClientManual(
    `t-${scope.replace(/ /g, "-")}-${sourceId}`,
    ["client_credentials"],
    scope,
    [],
    sourceId,
  );
  const r = await fetch(`${url}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: reg.clientId,
      client_secret: reg.clientSecret!,
    }),
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { access_token: string }).access_token;
}

async function call(
  name: string,
  args: Record<string, unknown>,
  bearer?: string,
  headers: Record<string, string> = {},
): Promise<any> {
  // A bearer-carrying call models the real ingress (behind Cloudflare →
  // public guard 401 → token verified → authInfo). A bare call models the
  // docker-bridge internal path.
  const r = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer
        ? { Authorization: `Bearer ${bearer}`, "Cf-Connecting-Ip": "1.2.3.4" }
        : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  return r.json();
}

function toolError(rpc: any): string | undefined {
  if (rpc.error) return String(rpc.error.message ?? rpc.error.code);
  if (rpc.result?.isError) {
    try {
      return JSON.parse(rpc.result.content[0].text).error;
    } catch {
      return rpc.result.content[0]?.text;
    }
  }
  return undefined;
}

beforeEach(async () => {
  process.env.MEMRAIN_PUBLIC_WRITE = "1"; // prod posture: constructive writes on
  tmp = mkdtempSync(join(tmpdir(), "memrain-tok-destr-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  // A second source for the cross-source isolation test. `oauth_clients.source_id`
  // has an FK to `sources`, so the row must exist before minting a client for it
  // (Postgres enforces this; PGLite is laxer — this keeps CI + local in step).
  await registerSource(storage.engine(), {
    id: "othersrc",
    kind: "vault",
    pathPrefix: "/other",
  });
  provider = new OAuthProvider({ engine: storage.raw() });
  server = startServer({
    host: "127.0.0.1",
    port: 0,
    storage,
    publicBearerToken: PUB_TOKEN,
    internalToken: INT_TOKEN,
    oauthProvider: provider,
  });
  url = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.stop();
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MEMRAIN_PUBLIC_WRITE;
});

describe("write-scoped token on destructive tools", () => {
  it("page_delete: write token soft-deletes its own source's page", async () => {
    const writer = await mint("read write");
    const put = await call("page_put", { slug: "notes/doomed", type: "note" }, writer);
    expect(toolError(put)).toBeUndefined();

    const del = await call("page_delete", { slug: "notes/doomed" }, writer);
    expect(toolError(del)).toBeUndefined();
    expect(JSON.parse(del.result.content[0].text).ok).toBe(true);

    const page = await getPage(storage, "notes/doomed", undefined, {
      includeDeleted: true,
    });
    expect(page?.deleted_at).toBeTruthy();
  });

  it("page_restore: write token undeletes what it deleted", async () => {
    const writer = await mint("read write");
    await call("page_put", { slug: "notes/phoenix", type: "note" }, writer);
    await call("page_delete", { slug: "notes/phoenix" }, writer);
    const res = await call("page_restore", { slug: "notes/phoenix" }, writer);
    expect(toolError(res)).toBeUndefined();
    const page = await getPage(storage, "notes/phoenix");
    expect(page).toBeTruthy();
    expect(page?.deleted_at ?? null).toBeNull();
  });

  it("read-scoped token is refused with insufficient_scope (not the internal-token wall)", async () => {
    const reader = await mint("read");
    const del = await call("page_delete", { slug: "notes/whatever" }, reader);
    expect(toolError(del)).toBe("insufficient_scope");
    // The refusal carries the step-up challenge: current grant plus `write`.
    expect(del.result._meta["mcp/www_authenticate"]).toBe(
      `Bearer error="insufficient_scope", scope="read write", ` +
        `resource_metadata="${url}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("static public bearer stays forbidden from the public ingress", async () => {
    const del = await call(
      "page_delete",
      { slug: "notes/x" },
      PUB_TOKEN,
      { "Cf-Connecting-Ip": "1.2.3.4" },
    );
    expect(del.error).toBeDefined();
    expect(del.error.message).toMatch(/not callable from the public ingress/);
  });

  it("bare internal path (no token at all) is refused at the ingress", async () => {
    // REWRITTEN: this expected the JSON-RPC internal-token wall (-32001), which
    // only fires once a credential-less request has reached the dispatcher. The
    // guard now demands the internal token from that ingress as well, so the
    // refusal arrives as a plain 401 body before any tool is dispatched.
    const del = await call("page_delete", { slug: "notes/x" });
    expect(del.ok).toBe(false);
    expect(String(del.error)).toMatch(/internal token/);
  });
});

describe("token principal reaches the rest of the walled surface", () => {
  // Before this, the internal-token wall exempted only the destructive set, so
  // a token client was advertised every tool in tools/list (that filter keys on
  // isPublic, which a token request is not) and then refused at call time with
  // "requires the internal token" — the mobile/web clients' phantom-tool bug.
  async function listedTools(bearer: string): Promise<string[]> {
    const r = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        "Cf-Connecting-Ip": "1.2.3.4",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = (await r.json()) as { result: { tools: { name: string }[] } };
    return body.result.tools.map((t) => t.name);
  }

  it("resolve_slugs: a read token gets results, not the internal-token wall", async () => {
    const reader = await mint("read write");
    await call("page_put", { slug: "notes/findable", type: "note" }, reader);

    const r = await call("resolve_slugs", { query: "notes/findable" }, reader);
    expect(r.error?.code).not.toBe(ERR_UNAUTHORIZED);
    expect(toolError(r)).toBeUndefined();
    const parsed = JSON.parse(r.result.content[0].text);
    expect(parsed.hits?.[0]?.slug).toBe("notes/findable");
  });

  it("page_put: a write token writes the page", async () => {
    const writer = await mint("read write");
    const r = await call(
      "page_put",
      { slug: "notes/probe", markdown_body: "regression probe" },
      writer,
    );
    expect(r.error?.code).not.toBe(ERR_UNAUTHORIZED);
    expect(toolError(r)).toBeUndefined();
  });

  it("page_put: a read token is refused with insufficient_scope", async () => {
    const reader = await mint("read");
    const r = await call(
      "page_put",
      { slug: "notes/probe", markdown_body: "read token probe" },
      reader,
    );
    // The refusal must come from the per-op scope gate, not the transport wall:
    // a read token reaches dispatch and is turned away for lacking `write`.
    expect(r.error?.code).not.toBe(ERR_UNAUTHORIZED);
    expect(toolError(r)).toBe("insufficient_scope");
  });

  it("listed walled tools no longer answer with the internal-token wall", async () => {
    const admin = await mint("read write admin");
    const names = await listedTools(admin);

    // Cheap, LLM-free members of FORBIDDEN_MCP_TOOLS_FROM_PUBLIC, plus the two
    // the mobile client actually tripped over. Whatever they answer
    // (invalid_params, operator-only, an empty result) proves the transport let
    // them reach dispatch.
    const probes = [
      "resolve_slugs",
      "get_links",
      "get_tags",
      "sources_status",
    ];
    for (const name of probes) expect(names).toContain(name);

    const walled: string[] = [];
    for (const name of probes) {
      const r = await call(name, {}, admin);
      if (r.error?.code === ERR_UNAUTHORIZED) walled.push(name);
    }
    expect(walled).toEqual([]);
  });
});

describe("purge_deleted_pages needs the admin scope", () => {
  it("a write-only token is refused with insufficient_scope", async () => {
    const writer = await mint("read write");
    const r = await call("purge_deleted_pages", {}, writer);
    expect(toolError(r)).toBe("insufficient_scope");
  });

  it("an admin-scoped token hard-purges its own source only", async () => {
    const admin = await mint("read write admin");
    await call("page_put", { slug: "notes/reapme", type: "note" }, admin);
    await call("page_delete", { slug: "notes/reapme" }, admin);

    const r = await call("purge_deleted_pages", { older_than_hours: 0 }, admin);
    expect(toolError(r)).toBeUndefined();
    expect(JSON.parse(r.result.content[0].text).ok).toBe(true);

    const gone = await getPage(storage, "notes/reapme", undefined, {
      includeDeleted: true,
    });
    expect(gone).toBeNull();
  });

  it("the static public bearer stays forbidden from purge", async () => {
    const r = await call(
      "purge_deleted_pages",
      {},
      PUB_TOKEN,
      { "Cf-Connecting-Ip": "1.2.3.4" },
    );
    expect(r.error).toBeDefined();
    expect(r.error.message).toMatch(/not callable from the public ingress/);
  });
});

describe("slug-prefix write fence (bound_slug_prefixes)", () => {
  /** client_credentials token for a client bound to slug prefixes. */
  async function mintBound(prefixes: string[]): Promise<string> {
    const reg = await provider.registerClientManual(
      `t-bound-${prefixes.join("-").replace(/\//g, "_")}`,
      ["client_credentials"],
      "read write",
      [],
      "default",
      undefined,
      undefined,
      prefixes,
    );
    const r = await fetch(`${url}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: reg.clientId,
        client_secret: reg.clientSecret!,
      }),
    });
    expect(r.status).toBe(200);
    return ((await r.json()) as { access_token: string }).access_token;
  }

  it("a bound client writes inside its prefix", async () => {
    const t = await mintBound(["inbox"]);
    const r = await call(
      "page_put",
      { slug: "inbox/note-1", title: "n", markdown_body: "hello" },
      t,
    );
    expect(toolError(r)).toBeUndefined();
  });

  it("a bound client is refused outside its prefix", async () => {
    const t = await mintBound(["inbox"]);
    const r = await call(
      "page_put",
      { slug: "people/alice", title: "a", markdown_body: "x" },
      t,
    );
    expect(toolError(r)).toBe("permission_denied");
  });

  it("a slug-less write tool is refused for a bound client (deny-by-default)", async () => {
    const t = await mintBound(["inbox"]);
    const r = await call("index", {}, t);
    expect(toolError(r)).toBe("permission_denied");
  });

  it("an unbounded client is unaffected", async () => {
    const t = await mint("read write");
    const r = await call(
      "page_put",
      { slug: "people/unbound", title: "u", markdown_body: "y" },
      t,
    );
    expect(toolError(r)).toBeUndefined();
  });

  it("both link endpoints are fenced", async () => {
    const t = await mintBound(["inbox"]);
    const bad = await call(
      "link",
      { source_slug: "inbox/note-1", target_slug: "people/alice", type: "mentions" },
      t,
    );
    expect(toolError(bad)).toBe("permission_denied");
  });

  it("link is fenced on the STORED (slugified) value, not the raw input", async () => {
    // "проект/evil" ASCII-folds to "evil" in addLink's slugifier — the fence
    // must judge that folded value, or a mixed-script input escapes the prefix.
    const t = await mintBound(["inbox"]);
    const bad = await call(
      "link",
      { source_slug: "inbox/note-1", target_slug: "проект/evil", type: "mentions" },
      t,
    );
    expect(toolError(bad)).toBe("permission_denied");
  });

});
