/**
 * written_by_principal (migration 134): every MCP write records the
 * credential it arrived on, from the resolved grant and never from an
 * argument. page_versions shows it to the operator and admin scope only.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, writerPrincipal, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

setDefaultTimeout(60000);
let tmp: string;
let storage: Storage;

const A = "wbp-a";

function auth(extra: Partial<AuthInfo> = {}): AuthInfo {
  return {
    token: "tok-a",
    clientId: "client-a",
    scopes: ["read", "write"],
    sourceId: A,
    allowedSources: [A],
    isPublic: false,
    ...extra,
  };
}

function payload(result: ToolCallResult): any {
  return JSON.parse(result.content[0]!.text);
}

async function call(name: string, args: Record<string, unknown>, authInfo?: AuthInfo): Promise<any> {
  return payload(await dispatchTool(storage, { name, arguments: args }, authInfo ? { authInfo } : {}));
}

async function principals(table: string, where: string, param: string): Promise<Array<string | null>> {
  const r = await storage.engine().query<{ p: string | null }>(
    `SELECT written_by_principal AS p FROM ${table} WHERE ${where} = $1 ORDER BY 1`,
    [param],
  );
  return r.rows.map((row) => row.p);
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-wbp-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: A, kind: "vault", pathPrefix: "/wbp-a" });
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("the principal", () => {
  it("is the writer identity, plus the enrollment on a shared connector", () => {
    expect(writerPrincipal({})).toBe("operator");
    expect(writerPrincipal({ isPublic: true })).toBe("public");
    expect(writerPrincipal({ authInfo: auth() })).toBe("client:client-a");
    expect(writerPrincipal({ authInfo: auth({ spendId: "client-a" }) })).toBe("client:client-a");
    expect(writerPrincipal({ authInfo: auth({ spendId: "enr-7" }) })).toBe("client:client-a|enrollment:enr-7");
  });
});

describe("stamping", () => {
  it("records the grant on page writes whatever written_by claims", async () => {
    const who = auth({ spendId: "enr-7" });
    await call("page_put", { slug: "wbp/doc", markdown_body: "one", written_by: "operator" }, who);
    await call("page_append", { slug: "wbp/doc", content: "two" }, who);
    await call("page_revert", { slug: "wbp/doc", version: 1 }, who);
    await call("page_delete", { slug: "wbp/doc" }, who);
    await call("page_restore", { slug: "wbp/doc" }, who);
    expect(await principals("page_versions", "slug", "wbp/doc")).toEqual(
      Array.from({ length: 5 }, () => "client:client-a|enrollment:enr-7"),
    );
  });

  it("records the operator on the trusted path and nothing on internal writes", async () => {
    await call("page_put", { slug: "wbp/op", markdown_body: "one" });
    await putPage(storage, { slug: "wbp/op", markdown_body: "two" });
    expect(await principals("page_versions", "slug", "wbp/op")).toEqual(["operator", null]);
  });

  it("records the grant on facts and timeline events", async () => {
    const who = auth();
    await call("page_put", { slug: "wbp/ent", markdown_body: "x" }, who);
    await call("add_fact", { entity_slug: "wbp/ent", fact: "likes tea", written_by: "someone-else" }, who);
    await call("add_timeline_event", { slug: "wbp/ent", occurred_at: "2026-01-02T00:00:00Z", event: "met" }, who);
    expect(await principals("entity_facts", "entity_slug", "wbp/ent")).toEqual(["client:client-a"]);
    expect(await principals("timeline_events", "slug", "wbp/ent")).toEqual(["client:client-a"]);
  });
});

describe("visibility", () => {
  it("page_versions shows it to the operator and admin scope, not to a tenant", async () => {
    await call("page_put", { slug: "wbp/v", markdown_body: "one" }, auth());
    const operator = await call("page_versions", { slug: "wbp/v" });
    expect(operator.versions[0].written_by_principal).toBe("client:client-a");
    const admin = await call("page_versions", { slug: "wbp/v" }, auth({ scopes: ["read", "write", "admin"] }));
    expect(admin.versions[0].written_by_principal).toBe("client:client-a");
    const tenant = await call("page_versions", { slug: "wbp/v" }, auth());
    expect(tenant.versions).toHaveLength(1);
    expect(Object.hasOwn(tenant.versions[0], "written_by_principal")).toBe(false);
  });
});

describe("migration 134", () => {
  it("adds the three columns, reverts cleanly keeping rows, and re-applies", async () => {
    const e = storage.engine();
    const cols = async () => {
      const r = await e.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns
          WHERE column_name = 'written_by_principal' ORDER BY table_name`,
      );
      return r.rows.map((row) => row.table_name);
    };
    await call("page_put", { slug: "wbp/m", markdown_body: "one" });
    expect(await cols()).toEqual(["entity_facts", "page_versions", "timeline_events"]);
    const later = discoverMigrations().map((m) => m.id).filter((id) => id > 134).sort((a, b) => b - a);
    for (const id of later) await revertMigration(e, id);
    await revertMigration(e, 134);
    expect(await cols()).toEqual([]);
    const n = await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM page_versions WHERE slug = 'wbp/m'`);
    expect(n.rows[0]!.n).toBe(1);
    const again = await runMigrations(e);
    expect(again.applied.map((m) => m.id)).toEqual([134, ...later.reverse()]);
    expect(await cols()).toEqual(["entity_facts", "page_versions", "timeline_events"]);
  });
});
