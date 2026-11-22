import { expect, it } from "bun:test";
import { TOOL_DEFS } from "../src/mcp/tool_defs.ts";

const HARD_CAP = 95000;
// Room kept free for the next tool; spending it means trimming text first.
const RESERVE = 1000;

it("keeps the tools/list contract within the session context budget", () => {
  expect(Buffer.byteLength(JSON.stringify({ tools: TOOL_DEFS }))).toBeLessThanOrEqual(HARD_CAP);
  for (const tool of TOOL_DEFS) expect(tool.description.length, tool.name).toBeLessThanOrEqual(2000);
});

// Value: protects=room for the next tool under the hard cap; fails_when=a change eats the reserve silently;
// why_new=the cap check alone passes until the last byte is gone; no_claim=the reserve size itself is a policy choice.
it("keeps a reserve under the hard cap for the next tool", () => {
  expect(Buffer.byteLength(JSON.stringify({ tools: TOOL_DEFS }))).toBeLessThanOrEqual(HARD_CAP - RESERVE);
});
