import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { OPERATIONS, normalizeOptionalArgs, operationAnnotations } from "../src/mcp/operations.ts";

it("normalizes only declared optional read arguments across the whole contract", () => {
  for (const op of OPERATIONS) {
    for (const [key, def] of Object.entries(op.params)) {
      for (const value of [null, "", [], 0, false, "kept", ["kept"]]) {
        const input = { [key]: value, undeclared: null };
        const drop = operationAnnotations(op).readOnlyHint && !def.required && key !== "source_ids" &&
          (value === null || value === "" || (Array.isArray(value) && value.length === 0) ||
            (value === 0 && def.minimum !== undefined && def.minimum >= 1));
        expect({ name: op.name, key, output: normalizeOptionalArgs(op, input) }).toEqual({ name: op.name, key,
          output: drop ? { undeclared: null } : input });
        expect(input).toEqual({ [key]: value, undeclared: null });
      }
    }
  }
});

for (const { name, open } of storageEngines(undefined)) describe(`optional read arguments (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => { db = await open(); await putPage(db.storage, { slug: "notes/args", markdown_body: "Keep this body" }); });
  afterAll(async () => { await db.close(); });

  it("treats empty optional read filters as omitted", async () => {
    const args = { type: null, slug_prefix: "", limit: 0, cursor: null, include_body: null };
    const clean = await dispatchTool(db.storage, { name: "page_list", arguments: {} });
    const normalized = await dispatchTool(db.storage, { name: "page_list", arguments: args });
    expect(normalized.isError).toBeFalsy();
    expect(normalized.content).toEqual(clean.content);
    expect(args).toEqual({ type: null, slug_prefix: "", limit: 0, cursor: null, include_body: null });
  });

  it("still rejects empty required fields, unknown fields and null write fields", async () => {
    for (const request of [
      { name: "page_get", arguments: { slug: null } },
      { name: "page_list", arguments: { unknown: null } },
      { name: "page_list", arguments: { source_ids: null } },
      { name: "page_put", arguments: { slug: "notes/args", markdown_body: null } },
    ]) {
      const result = await dispatchTool(db.storage, request);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text).error).toBe("invalid_params");
    }
    const read = await dispatchTool(db.storage, { name: "page_get", arguments: { slug: "notes/args" } });
    expect(JSON.parse(read.content[0]!.text).page.markdown_body).toBe("Keep this body");
  });
});
