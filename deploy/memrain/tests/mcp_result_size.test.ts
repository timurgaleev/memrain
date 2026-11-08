import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

const savedLimit = process.env.MEMRAIN_MCP_MAX_RESULT_BYTES;
afterEach(() => {
  if (savedLimit === undefined) delete process.env.MEMRAIN_MCP_MAX_RESULT_BYTES;
  else process.env.MEMRAIN_MCP_MAX_RESULT_BYTES = savedLimit;
});

describe("MCP result size", () => {
  let db: Awaited<ReturnType<ReturnType<typeof storageEngines>[number]["open"]>>;
  beforeAll(async () => {
    db = await storageEngines(undefined)[0]!.open();
    await putPage(db.storage, { slug: "notes/size", markdown_body: "🙂".repeat(1000) });
  });
  afterAll(async () => { await db.close(); });
  const list = (args = {}, opts = {}) => dispatchTool(db.storage, { name: "page_list", arguments: args }, opts);

  it("accepts the exact serialized UTF-8 boundary and refuses one byte less", async () => {
    delete process.env.MEMRAIN_MCP_MAX_RESULT_BYTES;
    const full = await list();
    const bytes = Buffer.byteLength(JSON.stringify(full));
    expect(bytes).toBeGreaterThan(JSON.stringify(full).length);
    process.env.MEMRAIN_MCP_MAX_RESULT_BYTES = String(bytes);
    expect(await list()).toEqual(full);
    process.env.MEMRAIN_MCP_MAX_RESULT_BYTES = String(bytes - 1);
    const refused = await list();
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0]!.text)).toMatchObject({ error: "result_too_large" });
    expect(refused.content[0]!.text).toContain("include_body");
    expect(refused.content[0]!.text).not.toContain("🙂");
    expect((await list({ include_body: false })).isError).toBeFalsy();
  });

  it("measures after public body redaction", async () => {
    process.env.MEMRAIN_MCP_MAX_RESULT_BYTES = "2000";
    expect((await list()).isError).toBe(true);
    const publicResult = await list({}, { isPublic: true });
    expect(publicResult.isError).toBeFalsy();
    expect(JSON.parse(publicResult.content[0]!.text).pages).toHaveLength(1);
    expect(publicResult.content[0]!.text).not.toContain("🙂");
  });

  it("counts compiled truth at the default ceiling and falls back on invalid settings", async () => {
    const hugeTruth = JSON.stringify({ summary: "x".repeat(4 * 1024 * 1024) });
    await db.storage.engine().query("UPDATE pages SET compiled_truth = $1::jsonb WHERE slug = $2", [hugeTruth, "notes/size"]);
    try {
      for (const value of [undefined, "", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"]) {
        if (value === undefined) delete process.env.MEMRAIN_MCP_MAX_RESULT_BYTES;
        else process.env.MEMRAIN_MCP_MAX_RESULT_BYTES = value;
        const result = await list();
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text).error).toBe("result_too_large");
        expect((await list({ include_body: false })).isError).toBeFalsy();
      }
    } finally {
      await db.storage.engine().query("UPDATE pages SET compiled_truth = '{}'::jsonb WHERE slug = $1", ["notes/size"]);
    }
  });

  it("covers each scoped list family and leaves existing errors intact", async () => {
    process.env.MEMRAIN_MCP_MAX_RESULT_BYTES = "1";
    for (const [name, args] of [
      ["page_versions", { slug: "notes/size", include_body: true }],
      ["get_chunks", { source_path: "missing.md" }],
      ["graph_neighbors", { slug: "notes/size" }],
      ["graph_query", { type: "related", source_slug: "notes/size" }],
      ["find_orphans", {}],
    ] as const) {
      const r = await dispatchTool(db.storage, { name, arguments: args });
      expect(JSON.parse(r.content[0]!.text).error).toBe("result_too_large");
    }
    const invalid = await dispatchTool(db.storage, { name: "page_versions", arguments: {} });
    expect(JSON.parse(invalid.content[0]!.text).error).toBe("invalid_params");
    expect((await dispatchTool(db.storage, { name: "page_get", arguments: { slug: "notes/size" } })).isError).toBeFalsy();
  });
});
