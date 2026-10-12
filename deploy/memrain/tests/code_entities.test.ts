/**
 * code-entities tests — verify the four code-* entity types are emitted
 * with the expected surface_form shape.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { chunkCode } from "../src/core/chunkers/code.ts";
import { extractCodeEntities } from "../src/core/code-entities.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";

afterAll(() => _resetParsersForTests());

async function entitiesFor(
  src: string,
  filename: string,
  language: "typescript" | "python" | "tsx",
) {
  const parsed = await chunkCode(src, filename, language);
  const out: Awaited<ReturnType<typeof extractCodeEntities>> = [];
  for (const s of parsed.symbols) {
    out.push(...(await extractCodeEntities({ symbol: s, file: filename, language })));
  }
  return { parsed, entities: out };
}

describe("extractCodeEntities (TypeScript)", () => {
  it("emits a code-def for each symbol", async () => {
    const src = `export function alpha() { return 1; }
function beta() { return alpha(); }
`;
    const { entities } = await entitiesFor(src, "src/x.ts", "typescript");
    const defs = entities.filter((e) => e.type === "code-def").map((e) => e.name).sort();
    expect(defs).toEqual(["alpha", "beta"]);
  });

  it("emits paired code-caller + code-callee for a call site", async () => {
    const src = `function alpha() { return 1; }
function beta() { return alpha(); }
`;
    const { entities } = await entitiesFor(src, "src/x.ts", "typescript");
    // beta calls alpha → code-caller(alpha) keyed by callee name, surface_form = beta
    const callerOfAlpha = entities.find(
      (e) => e.type === "code-caller" && e.name === "alpha",
    );
    expect(callerOfAlpha).toBeDefined();
    expect(callerOfAlpha?.surfaceForm).toContain(":beta");
    expect(callerOfAlpha?.surfaceForm).toContain("src/x.ts");
    // code-callee keyed by enclosing symbol name (beta)
    const calleeOfBeta = entities.find(
      (e) => e.type === "code-callee" && e.name === "beta",
    );
    expect(calleeOfBeta).toBeDefined();
    expect(calleeOfBeta?.surfaceForm.startsWith("alpha@")).toBe(true);
  });

  it("does not emit a self-call as a caller edge", async () => {
    const src = `function recurse(n: number): number { return n <= 0 ? 0 : recurse(n - 1); }
`;
    const { entities } = await entitiesFor(src, "src/r.ts", "typescript");
    const selfCaller = entities.find(
      (e) => e.type === "code-caller" && e.name === "recurse",
    );
    expect(selfCaller).toBeUndefined();
  });

  it("drops this.save() inside save but keeps this.repo.save()", async () => {
    const callersOfSave = async (body: string, lang: "typescript" | "python", file: string) =>
      (await entitiesFor(body, file, lang)).entities.filter(
        (e) => e.type === "code-caller" && e.name === "save",
      );
    expect(await callersOfSave(
      `class Repo { save(x: any): any { return x.id ? x : this.save({ ...x, id: 1 }); } }\n`,
      "typescript", "src/repo.ts",
    )).toHaveLength(0);
    expect(await callersOfSave(
      `class Svc { save(x: any): any { return this.repo.save(x); } }\n`,
      "typescript", "src/svc.ts",
    )).toHaveLength(1);
    expect(await callersOfSave(
      `class Repo:\n    def save(self, x):\n        return self.save(x)\n`,
      "python", "repo.py",
    )).toHaveLength(0);
  });

  it("collapses obj.method() into bare method name (fuzzy by design)", async () => {
    const src = `function caller() { obj.bar(); }
`;
    const { entities } = await entitiesFor(src, "src/c.ts", "typescript");
    const callerOfBar = entities.find(
      (e) => e.type === "code-caller" && e.name === "bar",
    );
    expect(callerOfBar).toBeDefined();
  });

  it("exposes file-level imports via chunkCode.fileImports (indexer-code attaches them)", async () => {
    const src = `import { foo, bar as baz } from "./x";
function alpha() { return foo(); }
`;
    const parsed = await chunkCode(src, "src/y.ts", "typescript");
    const importNames = parsed.fileImports.map((imp) => imp.name);
    // Named import { foo, bar as baz } yields the identifiers
    // we use as code-ref names. We just need foo present.
    expect(importNames).toContain("foo");
  });

  it("surface_form encodes <file>:<line>:<enclosing-symbol> for the inner-most caller", async () => {
    const src = `class C {
  method() { helper(); }
}
`;
    const { entities } = await entitiesFor(src, "src/c.ts", "typescript");
    const callerEntries = entities
      .filter((e) => e.type === "code-caller" && e.name === "helper")
      .map((e) => e.surfaceForm);
    expect(callerEntries.length).toBeGreaterThan(0);
    // The class symbol must NOT claim helper() — only `method` does.
    expect(callerEntries.some((s) => /^src\/c\.ts:\d+:method$/.test(s))).toBe(true);
    expect(callerEntries.some((s) => /^src\/c\.ts:\d+:C$/.test(s))).toBe(false);
  });
});

describe("extractCodeEntities (Python)", () => {
  it("emits caller/callee edges for a Python call site", async () => {
    const src = `def alpha():
    return 1

def beta():
    return alpha()
`;
    const { entities } = await entitiesFor(src, "p.py", "python");
    const callerOfAlpha = entities.find(
      (e) => e.type === "code-caller" && e.name === "alpha",
    );
    expect(callerOfAlpha).toBeDefined();
    expect(callerOfAlpha?.surfaceForm).toContain(":beta");
  });

  it("collapses obj.method() in Python", async () => {
    const src = `def caller():
    obj.work()
`;
    const { entities } = await entitiesFor(src, "p.py", "python");
    const callerOfWork = entities.find(
      (e) => e.type === "code-caller" && e.name === "work",
    );
    expect(callerOfWork).toBeDefined();
  });
});
