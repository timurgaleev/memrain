/**
 * The skill catalog and whoami over MCP answer for THIS caller: list_skills,
 * list_brain_skillpack and get_skill split each skill's tools by the same
 * predicate tools/list uses, and whoami reports what the caller can call.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

let tmp: string;
let storage: Storage;

const READ_ONLY: AuthInfo = { token: "t", clientId: "reader", scopes: ["read"], sourceId: "default", isPublic: false };

async function call(name: string, args: Record<string, unknown>, opts: { authInfo?: AuthInfo; isPublic?: boolean } = {}) {
  return JSON.parse((await dispatchTool(storage, { name, arguments: args }, opts)).content[0]!.text);
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-catalog-wiring-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterAll(async () => {
  delete process.env["MEMRAIN_PUBLIC_WRITE"];
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("list_skills / list_brain_skillpack", () => {
  for (const tool of ["list_skills", "list_brain_skillpack"]) {
    it(`${tool}: a read-only token sees page_put as unavailable; the operator sees it usable`, async () => {
      const reader = await call(tool, {}, { authInfo: READ_ONLY });
      expect(reader.schema_version).toBe(1);
      const writerSkill = reader.skills.find((s: { tools: string[] }) => s.tools.includes("page_put"));
      expect(writerSkill).toBeDefined();
      expect(writerSkill.unavailable_tools).toContain("page_put");
      expect(writerSkill.usable_tools).not.toContain("page_put");

      const operator = await call(tool, {});
      const same = operator.skills.find((s: { slug: string }) => s.slug === writerSkill.slug);
      expect(same.usable_tools).toContain("page_put");
    });
  }

  it("the public ingress counts its own denylist as unavailable", async () => {
    delete process.env["MEMRAIN_PUBLIC_WRITE"];
    const pub = await call("list_skills", {}, { isPublic: true });
    for (const s of pub.skills as Array<{ usable_tools: string[] }>) expect(s.usable_tools).not.toContain("page_put");
  });
});

describe("get_skill", () => {
  it("returns the frontmatter and the caller's split", async () => {
    const list = await call("list_skills", {}, { authInfo: READ_ONLY });
    const slug = list.skills.find((s: { tools: string[] }) => s.tools.includes("page_put")).slug;
    const r = await call("get_skill", { name: slug }, { authInfo: READ_ONLY });
    expect(r.skill.slug).toBe(slug);
    expect(r.skill.body.length).toBeGreaterThan(0);
    expect(r.skill.frontmatter.tools).toContain("page_put");
    expect(r.skill.unavailable_tools).toContain("page_put");
  });
});

describe("whoami", () => {
  it("keeps its identity fields and adds the caller's capabilities", async () => {
    const reader = await call("whoami", {}, { authInfo: READ_ONLY });
    expect(reader).toMatchObject({ ok: true, client_id: "reader", scopes: ["read"], is_public: false, operator: false });
    expect(reader.callable_tools).toContain("search");
    expect(reader.callable_tools).not.toContain("page_put");
    expect(reader.callable_tools).not.toContain("page_edit");

    const operator = await call("whoami", {});
    expect(operator.operator).toBe(true);
    expect(operator.callable_tools).toContain("page_edit");
    expect(operator.budget_usd_per_day).toBeNull();
  });
});
