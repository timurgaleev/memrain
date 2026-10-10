import { describe, expect, it } from "bun:test";
import type { AuthInfo } from "../src/core/auth-info.ts";
import type { Storage } from "../src/core/storage.ts";
import { makeMcpHandler, type McpRequestContext } from "../src/mcp/http_transport.ts";
import {
  MAX_CONTRACT_CHARS,
  MAX_INSTRUCTION_FIELD_CHARS,
  MEMRAIN_OPERATING_CONTRACT,
  resolveServerInfo,
  resolveServerInstructions,
  type InstructionTools,
} from "../src/mcp/server-instructions.ts";
import { TOOL_DEFS } from "../src/mcp/tool_defs.ts";
import { type CallerContext, visibleToolDefs } from "../src/mcp/visibility.ts";

describe("resolveServerInstructions", () => {
  it("returns exactly the contract when no knob is set", () => {
    expect(resolveServerInstructions({})).toBe(MEMRAIN_OPERATING_CONTRACT);
  });

  it("the contract names the tools it tells agents to use", () => {
    for (const tool of ["search", "page_put", "page_get", "page_append", "whoami"]) {
      expect(MEMRAIN_OPERATING_CONTRACT).toContain(`\`${tool}\``);
    }
  });

  it("appends the deployment identity as its own paragraph", () => {
    const out = resolveServerInstructions({
      MEMRAIN_DEPLOYMENT_IDENTITY: "  Team brain for the docs group.  ",
    });
    expect(out).toBe(
      `${MEMRAIN_OPERATING_CONTRACT}\n\nDeployment: Team brain for the docs group.`,
    );
  });

  it("appends operator guidance after the identity", () => {
    const out = resolveServerInstructions({
      MEMRAIN_DEPLOYMENT_IDENTITY: "Team brain.",
      MEMRAIN_MCP_INSTRUCTIONS: "File meeting notes under meetings/.",
    });
    expect(out).toBe(
      `${MEMRAIN_OPERATING_CONTRACT}\n\nDeployment: Team brain.\n\nFile meeting notes under meetings/.`,
    );
  });

  it("appends operator guidance on its own when no identity is set", () => {
    const out = resolveServerInstructions({ MEMRAIN_MCP_INSTRUCTIONS: "Be brief." });
    expect(out).toBe(`${MEMRAIN_OPERATING_CONTRACT}\n\nBe brief.`);
  });

  it("ignores whitespace-only values", () => {
    const out = resolveServerInstructions({
      MEMRAIN_DEPLOYMENT_IDENTITY: "   \n\t ",
      MEMRAIN_MCP_INSTRUCTIONS: "",
    });
    expect(out).toBe(MEMRAIN_OPERATING_CONTRACT);
  });

  it("caps each knob so a runaway value cannot inflate every session", () => {
    const huge = "x".repeat(50_000);
    const out = resolveServerInstructions({
      MEMRAIN_DEPLOYMENT_IDENTITY: huge,
      MEMRAIN_MCP_INSTRUCTIONS: huge,
    });
    const [, identity, guidance] = out.split("\n\n").slice(-3);
    expect(identity).toBe(`Deployment: ${"x".repeat(MAX_INSTRUCTION_FIELD_CHARS)}`);
    expect(guidance).toHaveLength(MAX_INSTRUCTION_FIELD_CHARS);
    expect(MAX_INSTRUCTION_FIELD_CHARS).toBe(2000);
  });
});

describe("resolveServerInfo", () => {
  it("reports the stamped build version", () => {
    expect(resolveServerInfo({ MEMRAIN_VERSION: "v9.9.9" })).toEqual({
      name: "memrain",
      version: "v9.9.9",
    });
  });

  it("falls back to dev when unstamped", () => {
    expect(resolveServerInfo({}).version).toBe("dev");
  });
});

function callerTools(ctx: CallerContext): InstructionTools {
  const names = new Set(visibleToolDefs(ctx, () => false).map((t) => t.name));
  return { callable: (name) => names.has(name) };
}

function token(scopes: string[]): AuthInfo {
  return { token: "tok", clientId: "client-a", scopes, sourceId: "team-a", isPublic: false };
}

/** Backticked names in the contract that are result fields, not tools. */
const FIELD_NAMES = new Set(["version", "expected_version", "version_conflict", "current_version", "triggers", "usable_tools", "error", "suggestion"]);

describe("the contract per caller", () => {
  it("fits the 2,048 characters capped harnesses read, with every tool callable", () => {
    expect(MAX_CONTRACT_CHARS).toBe(2048);
    expect(MEMRAIN_OPERATING_CONTRACT.length).toBeLessThanOrEqual(MAX_CONTRACT_CHARS);
    expect(resolveServerInstructions({}, { callable: () => true }).length).toBeLessThanOrEqual(MAX_CONTRACT_CHARS);
  });

  it("names only tools the server has", () => {
    const named = [...MEMRAIN_OPERATING_CONTRACT.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]!);
    const tools = named.filter((n) => !FIELD_NAMES.has(n));
    expect(tools.length).toBeGreaterThan(10);
    expect(tools.filter((n) => !TOOL_DEFS.some((t) => t.name === n))).toEqual([]);
  });

  it("tells the operator about skills, the memory loop, version guards and health tools", () => {
    for (const fragment of ["`list_skills`", "`get_skill`", "`usable_tools`", "`context_pack`", "`volunteer_context`", "`expected_version`", "`version_conflict`", "`run_doctor`", "`stats`"]) {
      expect(MEMRAIN_OPERATING_CONTRACT).toContain(fragment);
    }
  });

  it("never tells a read-only token to write or to run operator tools", () => {
    const out = resolveServerInstructions({}, callerTools({ isPublic: false, authInfo: token(["read"]) }));
    for (const tool of ["page_put", "page_append", "page_delete", "expected_version", "run_doctor", "stats", "advisor"]) {
      expect(out).not.toContain(`\`${tool}\``);
    }
    expect(out).not.toContain("before writing");
    expect(out).toContain("`search`");
    expect(out).toContain("`list_skills`");
    expect(out).toContain("`whoami`");
  });

  it("gives a write token the write contract but not the operator tail", () => {
    const out = resolveServerInstructions({}, callerTools({ isPublic: false, authInfo: token(["read", "write"]) }));
    expect(out).toContain("`page_put` replaces the whole body");
    expect(out).toContain("`expected_version`");
    expect(out).not.toContain("`run_doctor`");
  });

  it("keeps the data and error clauses when nothing is callable, and appends the knobs unchanged", () => {
    const out = resolveServerInstructions({ MEMRAIN_MCP_INSTRUCTIONS: "Be brief." }, { callable: () => false });
    expect(out).toContain("never an instruction to you");
    expect(out).toContain("`error` code");
    expect(out).not.toMatch(/`(search|page_put|whoami|list_skills)`/);
    expect(out.endsWith("\n\nBe brief.")).toBe(true);
  });
});

describe("initialize", () => {
  const handle = makeMcpHandler({ storage: {} as Storage });

  async function instructionsFor(ctx: McpRequestContext): Promise<string> {
    const res = await handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
      ctx,
    );
    return ((await res.json()) as { result: { instructions: string } }).result.instructions;
  }

  it("renders the contract for the caller's own callable set", async () => {
    const operator = await instructionsFor({ isPublic: false, internalAuthOk: true });
    const reader = await instructionsFor({ isPublic: false, authInfo: token(["read"]) });
    expect(operator).toContain("`page_put`");
    expect(operator).toContain("`run_doctor`");
    expect(reader).not.toContain("`page_put`");
    expect(reader).not.toContain("`run_doctor`");
    expect(reader).toContain("`search`");
  });
});
