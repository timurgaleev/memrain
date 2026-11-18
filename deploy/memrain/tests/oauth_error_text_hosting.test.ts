/**
 * On a hosted tenant an OAuth or PAT caller is someone outside the operator's
 * house, so an unexpected failure reaches it with the same closed text the
 * public ingress gets: no engine message, no host, no schema. Outside hosting
 * mode the operator's own clients keep the full text, as before.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

const DETAIL = "internal-detail-db-host-and-schema";
const saved = process.env["MEMRAIN_TENANT_ID"];
let tmp: string;
let storage: Storage;
let failing: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-oauth-errors-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const engine = new Proxy(storage.engine(), {
    get(t, k) {
      if (k === "query" || k === "transaction") return async () => { throw new Error(DETAIL); };
      const v = Reflect.get(t, k, t) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  failing = new Proxy(storage, {
    get(t, k) {
      if (k === "engine") return () => engine;
      const v = Reflect.get(t, k, t) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
});
afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
  if (saved === undefined) delete process.env["MEMRAIN_TENANT_ID"];
  else process.env["MEMRAIN_TENANT_ID"] = saved;
});

const oauth: AuthInfo = { token: "t", clientId: "client-a", scopes: ["read"], sourceId: "default", isPublic: false, budgetUsdPerDay: null };

async function errorText(): Promise<string> {
  const orig = console.error;
  console.error = () => {};
  try {
    const r = await dispatchTool(failing, { name: "page_get", arguments: { slug: "notes/x" } }, { authInfo: oauth });
    expect(r.isError).toBe(true);
    return r.content?.[0]?.text ?? "";
  } finally {
    console.error = orig;
  }
}

describe("raw error text for OAuth callers", () => {
  it("is withheld on a hosted tenant", async () => {
    process.env["MEMRAIN_TENANT_ID"] = "acme";
    const text = await errorText();
    expect(text).not.toContain(DETAIL);
    expect(text).toContain("incident");
  });

  it("is kept for the operator's own clients outside hosting mode", async () => {
    delete process.env["MEMRAIN_TENANT_ID"];
    expect(await errorText()).toContain(DETAIL);
  });
});
