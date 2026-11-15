/**
 * Ready-made grant profiles and the tool surface they set.
 *
 * A profile expands into the scopes a credential already has columns for and
 * never gives more than the equivalent explicit flags. A narrower tool
 * surface hides tools from tools/list AND refuses them on tools/call — the
 * same predicate — and it reaches the HTTP transport through the real
 * verifier, not only through hand-built AuthInfo.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GRANT_PROFILE_CATALOG_VERSION,
  GRANT_PROFILES,
  GrantProfileError,
  resolveGrantProfile,
} from "../src/core/grant-profiles.ts";
import { STARTER_TOOLS, VERB_TOOLS } from "../src/mcp/surface.ts";
import { OPERATIONS } from "../src/mcp/operations.ts";
import { dispatchRefusal, visibleToolDefs } from "../src/mcp/visibility.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";

const reason = (f: () => unknown): string => {
  try {
    f();
    return "ok";
  } catch (e) {
    expect(e).toBeInstanceOf(GrantProfileError);
    return (e as GrantProfileError).reason;
  }
};

describe("the profile catalog", () => {
  it("expands each available profile into scopes and a surface", () => {
    expect(resolveGrantProfile("reader", "token")).toEqual({ profile: "reader", catalogVersion: GRANT_PROFILE_CATALOG_VERSION, scopes: ["read"], toolSurface: "full" });
    expect(resolveGrantProfile("writer", "token").scopes).toEqual(["read", "write"]);
    expect(resolveGrantProfile("coding-agent", "client", { boundSlugPrefixes: ["projects/x/"] }).scopes).toEqual(["read", "write"]);
  });

  it("refuses what a profile cannot safely give", () => {
    expect(reason(() => resolveGrantProfile("coding-agent", "client"))).toBe("needs_prefix");
    expect(reason(() => resolveGrantProfile("coding-agent", "token"))).toBe("wrong_credential");
    expect(reason(() => resolveGrantProfile("proposer", "token"))).toBe("unavailable");
    expect(reason(() => resolveGrantProfile("root", "token"))).toBe("unknown_profile");
    expect(reason(() => resolveGrantProfile("reader", "token", { scopes: ["read", "write"] }))).toBe("conflicting_flags");
  });

  it("never grants admin or agent", () => {
    for (const p of GRANT_PROFILES) for (const s of p.scopes) expect(["read", "write"]).toContain(s);
  });
});

describe("tool surfaces", () => {
  const names = new Set(OPERATIONS.map((o) => o.name));

  it("name only real tools, and verbs sit inside starter", () => {
    for (const t of [...VERB_TOOLS, ...STARTER_TOOLS]) expect(names.has(t)).toBe(true);
    for (const t of VERB_TOOLS) expect(STARTER_TOOLS.has(t)).toBe(true);
  });

  it("hide and refuse the same tools for a narrowed credential", () => {
    const verbs: AuthInfo = { token: "t", clientId: "c", scopes: ["read", "write"], sourceId: "default", isPublic: false, toolSurface: "verbs" };
    expect(dispatchRefusal("page_put", verbs)).toEqual({ kind: "tool_surface", surface: "verbs" });
    expect(dispatchRefusal("recall", verbs)).toBeNull();
    const listed = visibleToolDefs({ isPublic: false, authInfo: verbs }, () => false).map((t) => t.name).sort();
    expect(listed).toEqual([...VERB_TOOLS].sort());
  });
});

describe("over HTTP, through the real verifier", () => {
  let tmp: string;
  let storage: Storage;
  let server: ServerHandle;
  let url: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-surface-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    server = startServer({ host: "127.0.0.1", port: 0, storage, publicBearerToken: "pub-surface", oauthProvider: new OAuthProvider({ engine: storage.raw() }) });
    url = `http://127.0.0.1:${server.port}`;
  }, 30_000);

  afterAll(async () => {
    await server.stop();
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  }, 30_000);

  async function mint(name: string, surface: string): Promise<string> {
    const token = "memrain_" + randomBytes(24).toString("hex");
    await storage.raw().query(
      `INSERT INTO access_tokens (name, token_hash, scopes, tool_surface) VALUES ($1, $2, ARRAY['read','write'], $3)`,
      [name, createHash("sha256").update(token).digest("hex"), surface],
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

  it("a verbs token lists only the verbs and cannot call anything else", async () => {
    const full = await mint("full-key", "full");
    const verbs = await mint("verbs-key", "verbs");
    const fullTools = (await rpc(full, "tools/list", {})).result.tools!.map((t) => t.name);
    const verbTools = (await rpc(verbs, "tools/list", {})).result.tools!.map((t) => t.name);
    expect(fullTools.length).toBeGreaterThan(verbTools.length);
    for (const t of verbTools) expect(VERB_TOOLS.has(t)).toBe(true);
    expect(verbTools).toContain("recall");
    const call = await rpc(verbs, "tools/call", { name: "page_get", arguments: { slug: "x" } });
    expect(call.result.isError).toBe(true);
    expect(call.result.content![0]!.text).toContain("permission_denied");
  });
});
