/**
 * The generated TOOL_DEFS must EXACTLY match the original hand-written defs.
 *
 * `tests/fixtures/tool_defs.snapshot.json` is a frozen copy of the inline
 * schemas as they shipped before the OPERATIONS-contract refactor. Asserting
 * deep equality proves the refactor is a zero-behavior change — the JSON-Schema
 * MCP clients receive is byte-for-byte the same structure.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_DEFS, type ToolDef } from "../src/mcp/tool_defs.ts";
import { OPERATIONS } from "../src/mcp/operations.ts";
import { OPERATOR_ONLY_TOOLS } from "../src/mcp/dispatch.ts";

const snapshot = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures/tool_defs.snapshot.json"), "utf8"),
) as ToolDef[];

describe("TOOL_DEFS generated from OPERATIONS", () => {
  it("exactly matches the original hand-written defs", () => {
    expect(TOOL_DEFS).toEqual(snapshot);
  });

  it("covers the same tools in the same order", () => {
    expect(TOOL_DEFS.map((t) => t.name)).toEqual(snapshot.map((t) => t.name));
    expect(OPERATIONS.map((o) => o.name)).toEqual(snapshot.map((t) => t.name));
  });

  it("no description claims a stdio transport memrain does not have", () => {
    const stale = TOOL_DEFS.filter((t) => t.description.includes("MCP-stdio"));
    expect(stale.map((t) => t.name)).toEqual([]);
  });

  it("the code graph tools take a `lang` filter and wanted_pages caps its limit at 200", () => {
    const props = (name: string) =>
      (TOOL_DEFS.find((t) => t.name === name)?.inputSchema as { properties: Record<string, any> } | undefined)
        ?.properties;
    for (const name of ["code_def", "code_refs", "code_callers", "code_callees", "code_blast", "code_flow"]) {
      expect({ name, lang: props(name)?.["lang"]?.type }).toEqual({ name, lang: "string" });
    }
    expect(props("wanted_pages")?.["limit"]).toEqual({ type: "integer", minimum: 1, maximum: 200 });
  });

  it("every generated inputSchema is a closed object schema", () => {
    for (const t of TOOL_DEFS) {
      const s = t.inputSchema as Record<string, unknown>;
      expect(s.type).toBe("object");
      expect(s.additionalProperties).toBe(false);
      expect(typeof s.properties).toBe("object");
    }
  });
});

describe("tool annotations", () => {
  const scopeOf = (name: string) => OPERATIONS.find((o) => o.name === name)?.scope ?? "read";

  it("every tool carries annotations and none claims an open world", () => {
    for (const t of TOOL_DEFS) {
      expect(typeof t.annotations.readOnlyHint).toBe("boolean");
      expect(t.annotations.openWorldHint).toBe(false);
    }
  });

  it("no write- or admin-scoped tool is advertised as read-only", () => {
    for (const t of TOOL_DEFS) {
      const scope = scopeOf(t.name);
      if (scope === "write" || scope === "admin") {
        expect({ name: t.name, readOnly: t.annotations.readOnlyHint }).toEqual({
          name: t.name,
          readOnly: false,
        });
        expect(typeof t.annotations.destructiveHint).toBe("boolean");
      }
    }
  });

  it("every read-scoped tool is read-only, except the operator-only job mutators", () => {
    // jobs_submit / jobs_cancel sit under the read scope but change state; they
    // stay reachable only by the operator, never by a tenant token.
    const mutatingReads = TOOL_DEFS.filter(
      (t) => scopeOf(t.name) === "read" && !t.annotations.readOnlyHint,
    ).map((t) => t.name);
    expect(mutatingReads.sort()).toEqual(["jobs_cancel", "jobs_submit"]);
    for (const name of mutatingReads) expect(OPERATOR_ONLY_TOOLS.has(name)).toBe(true);
  });

  it("marks the tools that delete or overwrite as destructive", () => {
    const destructive = TOOL_DEFS.filter((t) => t.annotations.destructiveHint).map((t) => t.name);
    for (const name of [
      "page_put",
      "page_delete",
      "page_revert",
      "unlink",
      "remove_tag",
      "forget_fact",
      "purge_deleted_pages",
      "jobs_cancel",
    ]) {
      expect(destructive).toContain(name);
    }
    for (const name of ["add_fact", "add_tag", "link", "page_append", "page_restore"]) {
      expect(destructive).not.toContain(name);
    }
  });
});
