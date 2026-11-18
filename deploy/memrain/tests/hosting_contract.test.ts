/**
 * The hosting contract every lane writes against: hosting-mode detection, the
 * tenant policy (a constant outside hosting), the route classes, and the
 * admission decisions per class and per MCP operation.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOSTING_ENV,
  SINGLE_TENANT_POLICY,
  hostingFlags,
  hostingMode,
  renderTenantListJson,
  setTenantPolicySource,
  tenantPolicy,
  type TenantPolicy,
} from "../src/control/contract.ts";
import {
  ROUTE_CLASSES,
  admitJob,
  admitRequest,
  assertTenantAllows,
  decideOperation,
  decideRequest,
  routeClass,
  routeClassEntry,
  tenantPaused,
} from "../src/core/tenant-guard.ts";
import { isOperationError } from "../src/core/operation-error.ts";
import { OPERATIONS, operationAnnotations } from "../src/mcp/operations.ts";

const ENV_NAMES = Object.values(HOSTING_ENV);
let saved: Map<string, string | undefined>;

beforeEach(() => {
  saved = new Map(ENV_NAMES.map((n) => [n, process.env[n]]));
  for (const n of ENV_NAMES) delete process.env[n];
  setTenantPolicySource(null);
});

afterEach(() => {
  setTenantPolicySource(null);
  for (const [n, v] of saved) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
});

function hostingOn(): void {
  process.env["MEMRAIN_TENANT_ID"] = "acme";
  process.env["MEMRAIN_CONTROL_URL"] = "control-url-from-secret-file";
}

const active: TenantPolicy = { status: "active", mode: null, limits: {}, llmOff: false };
const readOnly: TenantPolicy = { status: "suspended", mode: "read-only", limits: {}, llmOff: false };
const blocked: TenantPolicy = { status: "suspended", mode: "block", limits: {}, llmOff: false };
const deleting: TenantPolicy = { status: "deleting", mode: null, limits: {}, llmOff: false };

describe("hostingMode", () => {
  it("is off when neither variable is set, or both are blank", () => {
    expect(hostingMode({})).toBeNull();
    expect(hostingMode({ MEMRAIN_TENANT_ID: " ", MEMRAIN_CONTROL_URL: "" })).toBeNull();
  });

  it("is on when either variable is set, so a half-configured tenant fails closed", () => {
    expect(hostingMode({ MEMRAIN_TENANT_ID: "acme" })).toEqual({ tenantId: "acme", controlUrl: null });
    expect(hostingMode({ MEMRAIN_CONTROL_URL: "x" })).toEqual({ tenantId: null, controlUrl: "x" });
  });
});

describe("hostingFlags", () => {
  it("reads every flag off by default", () => {
    expect(hostingFlags({})).toEqual({ llmOff: false, publicAuth: null, app: false, requireMember: false });
  });

  it("parses the switches", () => {
    expect(hostingFlags({
      MEMRAIN_HOSTING_LLM_OFF: "1",
      MEMRAIN_PUBLIC_AUTH: "oauth",
      MEMRAIN_APP: "true",
      MEMRAIN_REQUIRE_MEMBER: "on",
    })).toEqual({ llmOff: true, publicAuth: "oauth", app: true, requireMember: true });
  });

  it("refuses an unknown MEMRAIN_PUBLIC_AUTH value instead of guessing", () => {
    expect(() => hostingFlags({ MEMRAIN_PUBLIC_AUTH: "bearer" })).toThrow(/MEMRAIN_PUBLIC_AUTH/);
  });
});

describe("tenantPolicy", () => {
  it("outside hosting is the frozen constant and never consults the policy source", async () => {
    let calls = 0;
    setTenantPolicySource(async () => { calls++; return blocked; });
    const p = await tenantPolicy();
    expect(p).toBe(SINGLE_TENANT_POLICY);
    expect(p).toEqual({ status: "active", mode: null, limits: {}, llmOff: false });
    expect(Object.isFrozen(SINGLE_TENANT_POLICY)).toBe(true);
    expect(Object.isFrozen(SINGLE_TENANT_POLICY.limits)).toBe(true);
    expect(calls).toBe(0);
  });

  it("in hosting mode with no source is unknown (null)", async () => {
    hostingOn();
    expect(await tenantPolicy()).toBeNull();
  });

  it("in hosting mode returns the source's policy, and null when the source fails", async () => {
    hostingOn();
    setTenantPolicySource(async () => readOnly);
    expect(await tenantPolicy()).toEqual(readOnly);
    setTenantPolicySource(async () => { throw new Error("control unreachable"); });
    expect(await tenantPolicy()).toBeNull();
  });

  it("the local MEMRAIN_HOSTING_LLM_OFF switch turns paid calls off on top of control", async () => {
    hostingOn();
    process.env["MEMRAIN_HOSTING_LLM_OFF"] = "1";
    setTenantPolicySource(async () => active);
    expect((await tenantPolicy())?.llmOff).toBe(true);
  });
});

describe("ROUTE_CLASSES", () => {
  it("classifies the known routes", () => {
    expect(routeClass("GET", "/health")).toBe("health");
    expect(routeClass("GET", "/.well-known/oauth-authorization-server")).toBe("health");
    for (const p of ["/token", "/register", "/revoke"]) expect(routeClass("POST", p)).toBe("auth");
    expect(routeClass("GET", "/authorize")).toBe("auth");
    expect(routeClass("POST", "/authorize")).toBe("auth");
    expect(routeClass("POST", "/app/login")).toBe("auth");
    expect(routeClass("GET", "/app/invite")).toBe("auth");
    expect(routeClass("POST", "/mcp")).toBe("mcp");
    expect(routeClass("POST", "/ingest")).toBe("write");
    expect(routeClass("GET", "/admin/api/pages")).toBe("read");
    expect(routeClass("POST", "/admin/api/pages")).toBe("write");
    expect(routeClass("POST", "/app/api/chat")).toBe("write");
    expect(routeClass("GET", "/s/abc")).toBe("write");
  });

  it("an unknown path or method is write (fail closed)", () => {
    expect(routeClassEntry("GET", "/nowhere")).toBeNull();
    expect(routeClass("GET", "/nowhere")).toBe("write");
    expect(routeClass("DELETE", "/health")).toBe("write");
    expect(routeClass("GET", "/healthz")).toBe("write");
    expect(routeClass("GET", "/adminx")).toBe("write");
  });

  it("names every literal route the server dispatches", () => {
    const server = readFileSync(join(import.meta.dir, "../src/http/server.ts"), "utf8");
    const paths = new Set(
      [...server.matchAll(/pathname(?: ===|\.startsWith\() ?"(\/[^"]*)"/g)].map((m) => m[1]!),
    );
    expect(paths.size).toBeGreaterThan(5);
    const unlisted = [...paths].filter(
      (p) => !ROUTE_CLASSES.some((e) => e.methods.some((m) => routeClassEntry(m, p) === e)),
    );
    expect(unlisted).toEqual([]);
  });
});

describe("decideRequest", () => {
  const classes = ["health", "auth", "read", "mcp", "write"] as const;

  it("an active tenant passes every class", () => {
    for (const c of classes) expect(decideRequest(active, c)).toEqual({ allow: true });
  });

  it("block refuses everything but health", () => {
    for (const p of [blocked, deleting]) {
      expect(decideRequest(p, "health")).toEqual({ allow: true });
      for (const c of ["auth", "read", "mcp", "write"] as const) {
        expect(decideRequest(p, c)).toEqual({ allow: false, status: 403, error: "tenant_suspended" });
      }
    }
  });

  it("read-only passes health, read and mcp (decided per operation), refuses auth and write", () => {
    for (const c of ["health", "read", "mcp"] as const) expect(decideRequest(readOnly, c)).toEqual({ allow: true });
    for (const c of ["auth", "write"] as const) {
      expect(decideRequest(readOnly, c)).toEqual({ allow: false, status: 403, error: "tenant_suspended" });
    }
  });

  it("an unknown policy allows reading and refuses writes", () => {
    for (const c of ["health", "read", "mcp"] as const) expect(decideRequest(null, c)).toEqual({ allow: true });
    for (const c of ["auth", "write"] as const) {
      expect(decideRequest(null, c)).toEqual({ allow: false, status: 503, error: "tenant_policy_unavailable" });
    }
  });
});

describe("decideOperation", () => {
  it("read-only refuses every mutating operation and passes every read-only one", () => {
    for (const op of OPERATIONS) {
      expect({ op: op.name, allow: decideOperation(readOnly, op.name).allow })
        .toEqual({ op: op.name, allow: operationAnnotations(op).readOnlyHint });
    }
    for (const op of ["page_put", "add_fact", "page_delete", "jobs_submit"]) {
      expect(decideOperation(readOnly, op)).toEqual({ allow: false, status: 403, error: "tenant_suspended" });
    }
    for (const op of ["search", "page_get", "query"]) expect(decideOperation(readOnly, op)).toEqual({ allow: true });
  });

  it("an unknown operation counts as a write", () => {
    expect(decideOperation(readOnly, "no_such_tool").allow).toBe(false);
    expect(decideOperation(active, "no_such_tool").allow).toBe(true);
  });

  it("an unknown policy refuses writes but not reads", () => {
    expect(decideOperation(null, "search").allow).toBe(true);
    expect(decideOperation(null, "page_put").allow).toBe(false);
  });
});

describe("admission outside hosting mode", () => {
  it("admitRequest, assertTenantAllows and admitJob pass everything without consulting a source", async () => {
    let calls = 0;
    setTenantPolicySource(async () => { calls++; return blocked; });
    for (const [method, path] of [["POST", "/mcp"], ["POST", "/ingest"], ["GET", "/nowhere"]] as const) {
      expect(await admitRequest(new Request(`http://h${path}`, { method }))).toBeNull();
    }
    await assertTenantAllows("page_put");
    await assertTenantAllows("no_such_tool");
    expect(await admitJob()).toBe(true);
    expect(await tenantPaused()).toBe(false);
    expect(calls).toBe(0);
  });
});

describe("admission in hosting mode", () => {
  it("a blocked tenant answers 403 tenant_suspended except on /health", async () => {
    hostingOn();
    setTenantPolicySource(async () => blocked);
    expect(await admitRequest(new Request("http://h/health"))).toBeNull();
    const res = await admitRequest(new Request("http://h/mcp", { method: "POST" }));
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ ok: false, error: "tenant_suspended" });
    expect(await admitJob()).toBe(false);
    expect(await tenantPaused()).toBe(true);
  });

  it("read-only lets /mcp through and refuses a write operation with tenant_suspended", async () => {
    hostingOn();
    setTenantPolicySource(async () => readOnly);
    expect(await admitRequest(new Request("http://h/mcp", { method: "POST" }))).toBeNull();
    await assertTenantAllows("search");
    let err: unknown;
    try { await assertTenantAllows("page_put"); } catch (e) { err = e; }
    expect(isOperationError(err) && err.code).toBe("tenant_suspended");
    expect(await admitJob()).toBe(false);
  });

  it("an active tenant is admitted everywhere", async () => {
    hostingOn();
    setTenantPolicySource(async () => active);
    expect(await admitRequest(new Request("http://h/ingest", { method: "POST" }))).toBeNull();
    await assertTenantAllows("page_put");
    expect(await admitJob()).toBe(true);
    expect(await tenantPaused()).toBe(false);
  });

  it("no policy yet: jobs do not run and writes are refused", async () => {
    hostingOn();
    expect((await admitRequest(new Request("http://h/ingest", { method: "POST" })))?.status).toBe(503);
    expect(await admitRequest(new Request("http://h/mcp", { method: "POST" }))).toBeNull();
    expect(await admitJob()).toBe(false);
  });
});

describe("tenant list --json", () => {
  it("renders one object with the tenants sorted by id", () => {
    const out = renderTenantListJson([
      { id: "beta", status: "suspended", mode: "read-only", hostname: "beta.example.test" },
      { id: "acme", status: "active", mode: null, hostname: "acme.example.test" },
    ]);
    expect(JSON.parse(out)).toEqual({
      ok: true,
      tenants: [
        { id: "acme", status: "active", mode: null, hostname: "acme.example.test" },
        { id: "beta", status: "suspended", mode: "read-only", hostname: "beta.example.test" },
      ],
    });
  });
});
