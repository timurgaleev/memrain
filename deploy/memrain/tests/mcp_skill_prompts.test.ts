import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMcpHandler, type McpRequestContext } from "../src/mcp/http_transport.ts";
import type { Storage } from "../src/core/storage.ts";
import { getSkillPrompt, listSkillPrompts } from "../src/core/skillpack/prompts.ts";
import { parseSkillFrontmatter } from "../src/core/skillpack/frontmatter.ts";

const PACK = join(import.meta.dir, "..", "..", "skills");
const PACK_PROMPTS = ["connect-client", "cross-modal-review", "daily-task-prep", "query"];
const WRITE_TOOLS = /`(page_put|page_append|page_edit|page_delete|page_rename|page_revert|page_restore|link|unlink|add_tag|remove_tag|add_fact|forget_fact|add_timeline_event|put_raw_data|takes_add|takes_update|takes_resolve|jobs_submit|log_ingest|extract_facts|ontology_propose)`/;

const dir = mkdtempSync(join(tmpdir(), "memrain-prompts-"));
const previous = process.env.MEMRAIN_SKILLS_DIR;
beforeAll(() => {
  process.env.MEMRAIN_SKILLS_DIR = dir;
  for (const [name, fm] of [["read", "prompt: true\ntools: [page_get]"], ["write", "prompt: true\ntools: [page_put]"],
    ["ordinary", "tools: [page_get]"], ["unknown", "prompt: true\ntools: [absent_tool]"]]) {
    writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${name} procedure\n${fm}\n---\nLiteral {{argument}} procedure.\n`);
  }
  writeFileSync(join(dir, "oversize.md"), "---\nprompt: true\n---\n" + "x".repeat(256 * 1024));
  symlinkSync("/etc/hosts", join(dir, "escape.md"));
});
afterAll(() => {
  if (previous === undefined) delete process.env.MEMRAIN_SKILLS_DIR;
  else process.env.MEMRAIN_SKILLS_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});
const handler = makeMcpHandler({ storage: {} as Storage });
const reader: McpRequestContext = { isPublic: false, authInfo: { token: "fixture", clientId: "reader", scopes: ["read"], sourceId: "default", allowedSources: ["default"], isPublic: false } };
async function rpc(method: string, params: Record<string, unknown> = {}, ctx: McpRequestContext = reader) {
  const response = await handler(new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), ctx);
  return await response.json() as { result?: any; error?: { code: number; message: string } };
}
it("advertises and lists only opted-in prompts whose entire tool set is callable", async () => {
  expect((await rpc("initialize")).result.capabilities.prompts).toEqual({});
  expect((await rpc("prompts/list")).result.prompts).toEqual([{ name: "read", description: "read procedure" }]);
  const operator = await rpc("prompts/list", {}, { isPublic: false });
  expect(operator.result.prompts.map((p: { name: string }) => p.name)).toEqual(["read", "write"]);
});
it("gets literal text without interpolation and hides denied, absent and unsafe names identically", async () => {
  const result = await rpc("prompts/get", { name: "read" });
  expect(result.result?.messages).toEqual([{ role: "user", content: { type: "text", text: "Literal {{argument}} procedure.\n" } }]);
  const absent = (await rpc("prompts/get", { name: "missing" })).error;
  expect(absent?.code).toBe(-32602);
  for (const name of ["write", "ordinary", "unknown", "oversize", "escape", "../read"]) {
    expect((await rpc("prompts/get", { name })).error).toEqual(absent);
  }
  expect((await rpc("prompts/get", { name: "read", arguments: { argument: "replacement" } })).error?.code).toBe(-32602);
});
it("gives public callers neither a capability nor list/get access", async () => {
  for (const ctx of [{ isPublic: true }, { ...reader, authInfo: { ...reader.authInfo!, isPublic: true } }]) {
    expect((await rpc("initialize", {}, ctx)).result.capabilities.prompts).toBeUndefined();
    expect((await rpc("prompts/list", {}, ctx)).error?.code).toBe(-32601);
    expect((await rpc("prompts/get", { name: "read" }, ctx)).error?.code).toBe(-32601);
  }
});
it("paginates eligible prompts after filtering and stays off for an empty opt-in pack", async () => {
  const names = Array.from({ length: 52 }, (_, i) => `batch-${String(i).padStart(2, "0")}`);
  for (const name of names) writeFileSync(join(dir, `${name}.md`), `---\nprompt: true\ntools: [page_get]\n---\n${name}\n`);
  try {
    const first = (await rpc("prompts/list")).result;
    expect(first.prompts).toHaveLength(50);
    expect(first.nextCursor).toBe("batch-49");
    const second = (await rpc("prompts/list", { cursor: first.nextCursor })).result;
    expect(second.prompts.map((p: { name: string }) => p.name)).toEqual(["batch-50", "batch-51", "read"]);
    expect(second.nextCursor).toBeUndefined();
  } finally { for (const name of names) unlinkSync(join(dir, `${name}.md`)); }
  const prior = process.env.MEMRAIN_SKILLS_DIR;
  process.env.MEMRAIN_SKILLS_DIR = join(dir, "absent");
  try { expect((await rpc("initialize")).result.capabilities.prompts).toBeUndefined(); }
  finally { process.env.MEMRAIN_SKILLS_DIR = prior!; }
});
it("offers the shipped read-only skills as prompts to a reader", async () => {
  const prior = process.env.MEMRAIN_SKILLS_DIR;
  process.env.MEMRAIN_SKILLS_DIR = PACK;
  try {
    expect((await rpc("initialize")).result.capabilities.prompts).toEqual({});
    const names = (await rpc("prompts/list")).result.prompts.map((p: { name: string }) => p.name);
    expect(names).toEqual(PACK_PROMPTS);
    for (const name of PACK_PROMPTS) {
      const text = (await rpc("prompts/get", { name })).result?.messages?.[0]?.content?.text as string;
      expect(text.length).toBeGreaterThan(100);
    }
  } finally { process.env.MEMRAIN_SKILLS_DIR = prior!; }
});
it("opts in only pack skills that neither declare nor describe a write", () => {
  for (const name of PACK_PROMPTS) {
    const fm = parseSkillFrontmatter(readFileSync(join(PACK, name, "SKILL.md"), "utf8"))!;
    expect(fm.scalars.prompt).toBe("true");
    expect(fm.scalars.mutating).toBe("false");
    expect(fm.body).not.toMatch(WRITE_TOOLS);
  }
});
it("hides a pack prompt from a caller that cannot call one of its tools", () => {
  const options = { skillsDir: PACK, callable: (tool: string) => tool !== "entity_timeline" };
  expect(listSkillPrompts(options).prompts.map(p => p.name)).toEqual(["connect-client", "cross-modal-review"]);
  expect(getSkillPrompt("query", options)).toBeNull();
  expect(getSkillPrompt("daily-task-prep", options)).toBeNull();
  expect(getSkillPrompt("query", { skillsDir: PACK, callable: () => true })).not.toBeNull();
});
