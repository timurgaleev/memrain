/**
 * A hosted tenant through MCP dispatch, with the policy as the control plane
 * would state it:
 *   - with no policy read yet, no paid call goes out, and search still answers
 *     (from the keyword index);
 *   - at the plan's page limit, page_put is refused with tenant_limit_reached
 *     while page_get and editing an existing page still work;
 *   - at the plan's member limit, adding a member is refused;
 *   - the /app demo load, which writes pages outside dispatch, honours the
 *     page limit too.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { deterministicEmbedQuery } from "./det-embed.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { setSpendLedgerEngine } from "../src/core/budget.ts";
import { HOSTING_ENV, setTenantPolicySource, type TenantPolicy } from "../src/control/contract.ts";
import { setHostingSpendBackend } from "../src/control/hosting-spend.ts";
import { addMember } from "../src/core/members.ts";
import { registerSource } from "../src/core/sources.ts";
import { loadDemo } from "../src/core/demo-brain.ts";

const active: TenantPolicy = { status: "active", mode: null, limits: {}, llmOff: false, isolation: "verified" };

let tmp: string;
let storage: Storage;
const saved = new Map<string, string | undefined>();

beforeEach(async () => {
  for (const k of Object.values(HOSTING_ENV)) saved.set(k, process.env[k]);
  tmp = mkdtempSync(join(tmpdir(), "memrain-hosted-dispatch-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const garden = { slug: "notes/garden", markdown_body: "The garden plan is to plant tomatoes in May.", source_id: "default", title: "Garden" };
  await putPage(storage, garden);
  await indexPageIntoSearch(storage, garden, { embedFn: deterministicEmbedQuery });
  process.env["MEMRAIN_TENANT_ID"] = "acme";
  process.env["MEMRAIN_CONTROL_URL"] = "set-by-the-test-source";
  setSpendLedgerEngine(storage.engine());
});

afterEach(async () => {
  setSpendLedgerEngine(null);
  setTenantPolicySource(null);
  setHostingSpendBackend(null);
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function text(r: { content: { type: string; text?: string }[] }): string {
  return r.content.map((c) => c.text ?? "").join("\n");
}

describe("hosted dispatch", () => {
  it("with the control plane silent, no paid call is reserved and search still answers", async () => {
    let reserves = 0;
    setHostingSpendBackend({ reserve: async () => { reserves++; return { ok: true, id: "x" }; }, settle: async () => ({ ok: true }) });
    const r = await dispatchTool(storage, { name: "search", arguments: { q: "garden tomatoes" } });
    expect(r.isError ?? false).toBe(false);
    expect(text(r)).toContain("notes/garden");
    expect(reserves).toBe(0);
  });

  it("at the page limit a new page is refused, while reading and editing work", async () => {
    setTenantPolicySource(async () => ({ ...active, limits: { maxPages: 1 } }));
    const put = await dispatchTool(storage, { name: "page_put", arguments: { slug: "notes/new", markdown_body: "A new page.", title: "New" } });
    expect(put.isError).toBe(true);
    expect(text(put)).toContain("tenant_limit_reached");
    expect(text(put)).not.toMatch(/\d+ of \d+/);
    const get = await dispatchTool(storage, { name: "page_get", arguments: { slug: "notes/garden" } });
    expect(get.isError ?? false).toBe(false);
    const append = await dispatchTool(storage, { name: "page_append", arguments: { slug: "notes/garden", markdown: "Also beans." } });
    expect(text(append)).not.toContain("tenant_limit_reached");
    // Rewriting a page that exists adds no page, so the limit does not apply.
    const rewrite = await dispatchTool(storage, { name: "page_put", arguments: { slug: "notes/garden", markdown_body: "Plant tomatoes in June.", title: "Garden" } });
    expect(text(rewrite)).not.toContain("tenant_limit_reached");
    expect(rewrite.isError ?? false).toBe(false);
  });

  it("at the page limit the demo memory is not loaded", async () => {
    setTenantPolicySource(async () => ({ ...active, limits: { maxPages: 1 } }));
    await registerSource(storage.engine(), { id: "person-carol", kind: "other", pathPrefix: "/person-carol" });
    await addMember(storage.engine(), "carol", { personalSource: "person-carol" }, { actor: "operator", via: "cli" });
    await expect(loadDemo(storage, "carol", { embedFn: deterministicEmbedQuery })).rejects.toMatchObject({ code: "tenant_limit_reached" });
    const n = await storage.engine().query<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL`);
    expect(n.rows[0]!.n).toBe(1);
  });

  it("at the member limit a new member is refused", async () => {
    setTenantPolicySource(async () => ({ ...active, limits: { maxMembers: 1 } }));
    const ops = { actor: "operator", via: "cli" as const };
    await addMember(storage.engine(), "alice", {}, ops);
    await expect(addMember(storage.engine(), "bob", {}, ops)).rejects.toMatchObject({ code: "tenant_limit_reached" });
    const n = await storage.engine().query<{ n: number }>(`SELECT count(*)::int AS n FROM members`);
    expect(n.rows[0]!.n).toBe(1);
  });
});
