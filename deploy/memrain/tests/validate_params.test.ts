/**
 * Contract-derived param validation — `validateParams` enforces the declared
 * type / enum / min-max of present params, throwing OperationError. Required-
 * presence is left to the per-handler guards. Unknown params are rejected with a
 * did-you-mean hint unless MEMRAIN_MCP_LENIENT_ARGS=1.
 *
 * The PARITY test is the safety proof: for every operation, a param set built
 * from the contract's own valid boundary values must pass — so enabling
 * validateParams can never reject a well-formed (contract-conformant) call, the
 * exact shape the MCP client sends.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPERATIONS,
  validateParams,
  type Operation,
  type ParamDef,
} from "../src/mcp/operations.ts";
import { isOperationError } from "../src/core/operation-error.ts";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

const opByName = (name: string): Operation => {
  const op = OPERATIONS.find((o) => o.name === name);
  if (!op) throw new Error(`no such op: ${name}`);
  return op;
};

/** A valid value for a ParamDef, drawn from its own declared constraints. */
function validValue(def: ParamDef): unknown {
  if (def.enum) return def.enum[0];
  switch (def.type) {
    case "integer":
    case "number":
      return def.minimum ?? 1;
    case "boolean":
      return true;
    case "object":
      return {};
    case "array":
      return [];
    default:
      return "x";
  }
}

describe("validateParams — unit", () => {
  const search = opByName("search");

  it("accepts valid params", () => {
    expect(() => validateParams(search, { q: "hello", k: 5 })).not.toThrow();
    expect(() => validateParams(search, { q: "hello" })).not.toThrow();
  });

  it("refuses an absent, null or empty required param with the argument list", () => {
    for (const params of [{}, { k: 5 }, { q: null }, { q: "" }]) {
      try {
        validateParams(search, params);
        throw new Error("should have thrown");
      } catch (e) {
        expect(isOperationError(e)).toBe(true);
        expect((e as { code: string }).code).toBe("invalid_params");
        expect((e as Error).message).toBe("search: `q` is required");
        expect((e as { suggestion: string }).suggestion).toMatch(/^Required: `q` \(string\): Natural-language query\. Optional: `k` \(integer\)/);
      }
    }
    // Whitespace is left to the handler: several tools accept it.
    expect(() => validateParams(search, { q: " " })).not.toThrow();
  });

  it("rejects an out-of-range integer with invalid_params", () => {
    try {
      validateParams(search, { q: "x", k: 200 });
      throw new Error("should have thrown");
    } catch (e) {
      expect(isOperationError(e)).toBe(true);
      expect((e as { code: string }).code).toBe("invalid_params");
    }
  });

  it("rejects a below-minimum integer", () => {
    expect(() => validateParams(search, { q: "x", k: 0 })).toThrow();
  });

  it("rejects a non-integer for an integer param", () => {
    expect(() => validateParams(search, { q: "x", k: 2.5 })).toThrow();
    expect(() => validateParams(search, { q: "x", k: "5" })).toThrow();
  });

  it("rejects a bad enum value", () => {
    const backlinks = opByName("backlinks");
    expect(() => validateParams(backlinks, { name: "a", type: "wikilink" })).not.toThrow();
    expect(() => validateParams(backlinks, { name: "a", type: "bogus" })).toThrow();
  });

  const caught = (fn: () => void): { code: string; message: string; suggestion?: string } => {
    try {
      fn();
    } catch (e) {
      expect(isOperationError(e)).toBe(true);
      return e as { code: string; message: string; suggestion?: string };
    }
    throw new Error("should have thrown");
  };

  it("rejects an unknown param by default, naming it in the suggestion only", () => {
    const e = caught(() => validateParams(search, { q: "x", made_up_field: 99 }));
    expect(e.code).toBe("invalid_params");
    // `message` is what the request log persists: the count, never the key.
    expect(e.message).toBe("search: 1 unknown argument(s)");
    expect(e.suggestion).toContain("`made_up_field` is not an argument.");
  });

  it("suggests the declared key a misspelling is one edit from", () => {
    const e = caught(() => validateParams(opByName("page_put"), { slug: "s", markdown_bdy: "b" }));
    expect(e.suggestion).toStartWith("`markdown_bdy`: did you mean `markdown_body`?");
  });

  it("maps the names agents actually use through the op's alias table", () => {
    const cases: [string, Record<string, unknown>, string, string][] = [
      ["search", { query: "x", limit: 5 }, "query", "q"],
      ["search", { query: "x", limit: 5 }, "limit", "k"],
      ["page_append", { slug: "s", markdown: "m" }, "markdown", "content"],
      ["add_timeline_event", { slug: "s", date: "2026-01-01", summary: "e" }, "date", "occurred_at"],
      ["add_timeline_event", { slug: "s", date: "2026-01-01", summary: "e" }, "summary", "event"],
      ["entity_recall", { entity: "people/a" }, "entity", "slug"],
      ["resolve_slugs", { slugs: ["a"] }, "slugs", "query"],
    ];
    for (const [name, params, from, to] of cases) {
      const e = caught(() => validateParams(opByName(name), params));
      expect(e.suggestion).toContain(`\`${from}\`: did you mean \`${to}\`?`);
      expect(e.message).toMatch(new RegExp(`^${name}: \\d+ unknown argument\\(s\\)$`));
    }
  });

  it("does not steer a document id onto get_chunks `slug`", () => {
    const e = caught(() => validateParams(opByName("get_chunks"), { documentId: "doc_0123456789abcdef" }));
    expect(e.suggestion).not.toContain("did you mean `slug`");
  });

  it("every alias names a declared argument of its own op", () => {
    for (const op of OPERATIONS) {
      for (const target of Object.values(op.argAliases ?? {})) {
        if (typeof target === "string") expect(Object.hasOwn(op.params, target)).toBe(true);
      }
    }
  });

  it("points page_list `prefix` at the filters that exist", () => {
    const e = caught(() => validateParams(opByName("page_list"), { prefix: "people/" }));
    expect(e.suggestion).toContain("`prefix`: page_list has no prefix filter");
  });

  it("lists the accepted arguments with the required ones marked", () => {
    const e = caught(() => validateParams(opByName("page_put"), { slug: "s", body: "b" }));
    expect(e.message).not.toContain("body");
    expect(e.suggestion).toContain("`body` is not an argument.");
    expect(e.suggestion).toContain("Accepted arguments:");
    expect(e.suggestion).toContain("`slug` (required)");
    expect(e.suggestion).toContain("markdown_body");
    const s = caught(() => validateParams(search, { query: "x" }));
    expect(s.suggestion).toContain("Accepted arguments: `q` (required), `k`,");
  });

  it("reports at most 5 unknown keys, each truncated to 64 characters", () => {
    const long = "z".repeat(500);
    const params: Record<string, unknown> = { q: "x", [long]: 1 };
    for (let i = 0; i < 8; i++) params[`extra_${i}`] = i;
    const e = caught(() => validateParams(search, params));
    expect(e.message).toBe("search: 9 unknown argument(s)");
    expect(e.suggestion).toContain(`\`${"z".repeat(64)}…\``);
    expect(e.suggestion).not.toContain("z".repeat(65));
    expect(e.suggestion).toContain("(+4 more)");
    expect(e.suggestion).not.toContain("extra_4");
  });

  it("accepts unknown params again with MEMRAIN_MCP_LENIENT_ARGS=1", () => {
    const prev = process.env.MEMRAIN_MCP_LENIENT_ARGS;
    process.env.MEMRAIN_MCP_LENIENT_ARGS = "1";
    try {
      expect(() => validateParams(search, { q: "x", made_up_field: 99 })).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.MEMRAIN_MCP_LENIENT_ARGS;
      else process.env.MEMRAIN_MCP_LENIENT_ARGS = prev;
    }
  });

  it("refuses a huge unknown key in time linear in its length", () => {
    const op = opByName("page_put");
    const time = (len: number): number => {
      const key = "k".repeat(len);
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) {
        expect(() => validateParams(op, { slug: "s", [key]: 1 })).toThrow();
      }
      return performance.now() - t0;
    };
    time(10_000); // warm-up
    const small = Math.max(time(10_000), 0.5);
    const big = time(100_000);
    // 10x the input: a linear path grows ~10x, a quadratic distance ~100x.
    expect(big / small).toBeLessThan(40);
  });

  // Assert the throw is specifically an Operation('invalid_params'), not a raw
  // TypeError that a bare `toThrow` would also accept.
  const expectInvalid = (fn: () => void): void => {
    try {
      fn();
      throw new Error("should have thrown");
    } catch (e) {
      expect(isOperationError(e)).toBe(true);
      expect((e as { code: string }).code).toBe("invalid_params");
    }
  };

  it("rejects non-numeric type mismatches (string/object/array/number)", () => {
    const pagePut = opByName("page_put"); // title:string, compiled_truth:object
    expectInvalid(() => validateParams(pagePut, { slug: "s", markdown_body: "b", title: 5 }));
    // An array is NOT a valid `object` value (it's a jsonb object, not a list).
    expectInvalid(() => validateParams(pagePut, { slug: "s", markdown_body: "b", compiled_truth: [] }));
    const link = opByName("link"); // confidence:number
    expectInvalid(() => validateParams(link, { source: "a", target: "b", type: "t", confidence: "high" }));
  });

  it("rejects a present null (non-nullable contract types), not skips it", () => {
    // typeof null === "object" — the object branch must still reject it.
    const pagePut = opByName("page_put");
    expectInvalid(() => validateParams(pagePut, { slug: "s", markdown_body: "b", compiled_truth: null }));
    // null for a numeric param fails the type check too.
    const link = opByName("link");
    expectInvalid(() => validateParams(link, { source: "a", target: "b", type: "t", confidence: null }));
  });
});

describe("validateParams — code graph and wanted_pages params", () => {
  const expectInvalid = (fn: () => void): void => {
    expect(fn).toThrow();
    try {
      fn();
    } catch (e) {
      expect((e as { code: string }).code).toBe("invalid_params");
    }
  };

  it("accepts `lang` on every code graph tool and refuses a non-string one", () => {
    const required: Record<string, Record<string, unknown>> = {
      code_def: { name: "f" },
      code_refs: { name: "f" },
      code_callers: { name: "f" },
      code_callees: { target: "f" },
      code_blast: { symbol: "f" },
      code_flow: { symbol: "f" },
    };
    for (const [name, base] of Object.entries(required)) {
      const op = opByName(name);
      expect(() => validateParams(op, { ...base, lang: "go" }), name).not.toThrow();
      expectInvalid(() => validateParams(op, { ...base, lang: 3 }));
    }
  });

  it("bounds wanted_pages.limit to 1..200", () => {
    const op = opByName("wanted_pages");
    expect(() => validateParams(op, {})).not.toThrow();
    expect(() => validateParams(op, { limit: 200 })).not.toThrow();
    expectInvalid(() => validateParams(op, { limit: 201 }));
    expectInvalid(() => validateParams(op, { limit: 0 }));
  });
});

describe("validateParams — contract parity (no well-formed call is rejected)", () => {
  it("every operation accepts a param set built from its own valid boundaries", () => {
    for (const op of OPERATIONS) {
      const params: Record<string, unknown> = {};
      for (const [key, def] of Object.entries(op.params)) {
        params[key] = validValue(def);
      }
      expect(() => validateParams(op, params), `op ${op.name}`).not.toThrow();
      // The maximum boundary must also pass for numeric params.
      for (const [key, def] of Object.entries(op.params)) {
        if ((def.type === "integer" || def.type === "number") && def.maximum !== undefined) {
          const atMax = { ...params, [key]: def.maximum };
          expect(() => validateParams(op, atMax), `op ${op.name} ${key}=max`).not.toThrow();
        }
      }
    }
  });
});

describe("validateParams — dispatch integration", () => {
  let tmp: string;
  let storage: Storage;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-vparams-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });
  afterAll(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("an out-of-contract param returns the invalid_params envelope before the handler runs", async () => {
    const res = await dispatchTool(storage, { name: "search", arguments: { q: "x", k: 9999 } }, {
      isPublic: false,
    });
    expect(res.isError).toBe(true);
    const env = JSON.parse(res.content[0]!.text);
    expect(env.error).toBe("invalid_params");
    expect(env.message).toContain("k");
  });
});
