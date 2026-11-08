import { expect, it } from "bun:test";
import { TOOL_DEFS } from "../src/mcp/tool_defs.ts";

it("keeps the tools/list contract within the session context budget", () => {
  expect(Buffer.byteLength(JSON.stringify({ tools: TOOL_DEFS }))).toBeLessThanOrEqual(95000);
  for (const tool of TOOL_DEFS) expect(tool.description.length, tool.name).toBeLessThanOrEqual(2000);
});
