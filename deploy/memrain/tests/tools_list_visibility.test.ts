/**
 * tools/list is honest: for every caller shape, the listed set equals the set
 * of tools the caller can call without a scope or permission refusal.
 *
 * Each tool is called through the real transport + dispatch with one unknown
 * argument. A tool the caller may call gets past every gate and is turned away
 * by the param contract (invalid_params) before any handler runs, so the probe
 * has no side effects; a tool it may not call is refused by a gate first.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { makeMcpHandler, type McpRequestContext } from "../src/mcp/http_transport.ts";
import { RateLimiter } from "../src/mcp/rate_limit.ts";
import { isPublicMcpToolForbidden } from "../src/http/public_guard.ts";
import { TOOL_DEFS } from "../src/mcp/tool_defs.ts";
import { OPERATOR_ONLY_TOOLS } from "../src/mcp/dispatch.ts";
import { WRITE_SCOPED_TOOLS } from "../src/mcp/operations.ts";
import { ADMIN_PANEL_ONLY_TOOLS, dispatchRefusal, SLUG_PARAMS_BY_WRITE_TOOL } from "../src/mcp/visibility.ts";

setDefaultTimeout(60000);

let tmp: string;
let storage: Storage;
let handle: ReturnType<typeof makeMcpHandler>;

const PROBE = { __visibility_probe: true };
const REFUSAL_CODES = new Set(["insufficient_scope", "permission_denied"]);

function token(overrides: Partial<AuthInfo>): AuthInfo {
  return {
    token: "tok",
    clientId: "client-a",
    scopes: ["read"],
    sourceId: "team-a",
    isPublic: false,
    ...overrides,
  };
}

const CALLERS: Record<string, McpRequestContext> = {
  "operator": { isPublic: false, internalAuthOk: true },
  "public bearer": { isPublic: true },
  "anonymous bridge without the internal token": { isPublic: false, internalAuthOk: false },
  "read-only token": { isPublic: false, internalAuthOk: false, authInfo: token({ scopes: ["read"] }) },
  "read+write token": { isPublic: false, internalAuthOk: false, authInfo: token({ scopes: ["read", "write"] }) },
  "admin token": { isPublic: false, authInfo: token({ scopes: ["read", "write", "admin"] }) },
  "agent-only token": { isPublic: false, authInfo: token({ scopes: ["agent"] }) },
  "token over the public ingress": {
    isPublic: true,
    authInfo: token({ scopes: ["read", "write"], isPublic: true }),
  },
  "enrollment tenant": {
    isPublic: false,
    authInfo: token({
      clientId: "shared-connector",
      spendId: "enr-1",
      scopes: ["read", "write"],
      sourceId: "enr-1-src",
      allowedSources: ["enr-1-src"],
      takesHolders: ["world"],
      budgetUsdPerDay: 1,
    }),
  },
  "slug-bound client": {
    isPublic: false,
    authInfo: token({ scopes: ["read", "write"], boundSlugPrefixes: ["notes/a"] }),
  },
};

async function rpc(ctx: McpRequestContext, body: Record<string, unknown>): Promise<any> {
  const res = await handle(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
    }),
    ctx,
  );
  return res.json();
}

async function listed(ctx: McpRequestContext): Promise<string[]> {
  const r = await rpc(ctx, { method: "tools/list" });
  return r.result.tools.map((t: { name: string }) => t.name).sort();
}

/** The refusal a probe call met, or null when it reached the param contract. */
async function refusalOf(ctx: McpRequestContext, name: string): Promise<string | null> {
  const r = await rpc(ctx, { method: "tools/call", params: { name, arguments: PROBE } });
  if (r.error) return `rpc ${r.error.code}: ${r.error.message}`;
  const text: string = r.result.content?.[0]?.text ?? "";
  let code: unknown;
  try {
    code = (JSON.parse(text) as { error?: unknown }).error;
  } catch {
    code = undefined;
  }
  if (typeof code === "string" && REFUSAL_CODES.has(code)) return code;
  if (code !== "invalid_params") throw new Error(`${name}: probe was not stopped by the param contract: ${text.slice(0, 200)}`);
  return null;
}

async function callable(ctx: McpRequestContext): Promise<string[]> {
  const out: string[] = [];
  for (const t of TOOL_DEFS) {
    if ((await refusalOf(ctx, t.name)) === null) out.push(t.name);
  }
  return out.sort();
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-tools-visibility-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const roomy = () => new RateLimiter({ capacity: 100_000, refillPerSecond: 1000 });
  handle = makeMcpHandler({
    storage,
    publicRateLimiter: roomy(),
    internalRateLimiter: roomy(),
    forbidPublicTool: isPublicMcpToolForbidden,
  });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env["MEMRAIN_TENANT_FAIL_CLOSED"];
});

describe("tools/list equals the callable set", () => {
  for (const [label, ctx] of Object.entries(CALLERS)) {
    it(label, async () => {
      expect(await listed(ctx)).toEqual(await callable(ctx));
    });
  }

  it("a no-grant token under the fail-closed policy", async () => {
    process.env["MEMRAIN_TENANT_FAIL_CLOSED"] = "1";
    const ctx: McpRequestContext = {
      isPublic: false,
      authInfo: token({ scopes: ["read", "write"], sourceId: undefined }),
    };
    const names = await listed(ctx);
    expect(names).toEqual(await callable(ctx));
    for (const w of WRITE_SCOPED_TOOLS) expect(names).not.toContain(w);
  });
});

describe("what each caller sees", () => {
  it("the operator sees every tool but the admin-panel-only ones", async () => {
    expect(await listed(CALLERS["operator"]!)).toEqual(TOOL_DEFS.map((t) => t.name).filter((n) => !ADMIN_PANEL_ONLY_TOOLS.has(n)).sort());
  });

  it("the public bearer loses exactly the ingress denylist", async () => {
    const expected = TOOL_DEFS.map((t) => t.name).filter((n) => !isPublicMcpToolForbidden(n)).sort();
    expect(await listed(CALLERS["public bearer"]!)).toEqual(expected);
  });

  it("a token never sees operator-only tools", async () => {
    const names = await listed(CALLERS["admin token"]!);
    for (const n of OPERATOR_ONLY_TOOLS) expect(names).not.toContain(n);
    expect(names).toContain("purge_deleted_pages");
  });

  it("a read-only token sees no write tools, a read+write token does", async () => {
    const ro = await listed(CALLERS["read-only token"]!);
    const rw = await listed(CALLERS["read+write token"]!);
    expect(ro).not.toContain("page_put");
    expect(ro).toContain("search");
    expect(rw).toContain("page_put");
    expect(rw).not.toContain("purge_deleted_pages");
  });

  it("a slug-bound client sees only slug-addressed write tools", async () => {
    const names = new Set(await listed(CALLERS["slug-bound client"]!));
    for (const w of WRITE_SCOPED_TOOLS) {
      const slugged = Object.hasOwn(SLUG_PARAMS_BY_WRITE_TOOL, w);
      if (w === "purge_deleted_pages") continue; // admin scope, not granted here
      expect(names.has(w), w).toBe(slugged);
    }
  });
});

describe("refusal before the param contract", () => {
  it("a slug-bound client calling a slug-less write tool with bad params is refused, not told its params are wrong", async () => {
    expect(await refusalOf(CALLERS["slug-bound client"]!, "index")).toBe("permission_denied");
    expect(await refusalOf(CALLERS["read-only token"]!, "index")).toBe("insufficient_scope");
  });
});

describe("dispatchRefusal", () => {
  it("passes the operator on every tool", () => {
    for (const t of TOOL_DEFS) expect(dispatchRefusal(t.name, undefined)).toBeNull();
  });

  it("names the scope a token is missing", () => {
    expect(dispatchRefusal("page_put", token({ scopes: ["read"] }))).toEqual({
      kind: "insufficient_scope",
      requiredScope: "write",
    });
  });
});
