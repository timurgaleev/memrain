import { expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import * as errors from "../src/core/operation-error.ts";
import { OPERATIONS } from "../src/mcp/operations.ts";

const tools = new Set(OPERATIONS.map(op => op.name));
const params = new Set(OPERATIONS.flatMap(op => Object.keys(op.params)));

function inspect(text: string): { codes: string[]; tools: string[] } {
  const file = ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true);
  const structuredRefuse = file.statements.some(n => ts.isFunctionDeclaration(n) && n.name?.text === "refuse" && n.parameters[0]?.type?.getText(file) === "OperationErrorCode");
  const codes: string[] = [];
  const references: string[] = [];
  function visit(node: ts.Node, operationSubclass = false) {
    if (ts.isClassDeclaration(node)) operationSubclass = node.heritageClauses?.some(c => c.types.some(t => t.expression.getText(file) === "OperationError")) ?? false;
    if (operationSubclass && ts.isParameter(node) && node.name.getText(file) === "code" && node.type && ts.isUnionTypeNode(node.type)) {
      for (const t of node.type.types) if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) codes.push(t.literal.text);
    }
    const call = ts.isNewExpression(node) && node.expression.getText(file) === "OperationError"
      || ts.isCallExpression(node) && (structuredRefuse && node.expression.getText(file) === "refuse" || operationSubclass && node.expression.kind === ts.SyntaxKind.SuperKeyword);
    if (call && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
      const [code,,hint] = node.arguments ?? [];
      if (code && ts.isStringLiteralLike(code)) codes.push(code.text);
      if (hint) {
        const fragments: string[] = [];
        const literals = (n: ts.Node) => {
          if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) fragments.push(n.text);
          ts.forEachChild(n, literals);
        };
        literals(hint);
        for (const fragment of fragments) {
          for (const m of fragment.matchAll(/\b(?:page|entity|sources|source|jobs|list|get|find|run|context|fact)_[a-z_]+\b/g)) {
            if (!params.has(m[0]) && m[0] !== "page_slug") references.push(m[0]);
          }
        }
      }
    }
    ts.forEachChild(node, child => visit(child, operationSubclass));
  }
  visit(file);
  return { codes, tools: references };
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? sources(join(dir, e.name))
    : e.name.endsWith(".ts") ? [readFileSync(join(dir, e.name), "utf8")] : []);
}

it("registers every structured error code and keeps static recovery tool names callable", () => {
  const registry: readonly string[] = errors.OPERATION_ERROR_CODES;
  expect(Array.isArray(registry)).toBe(true);
  const found = sources(join(import.meta.dir, "../src")).map(inspect);
  const codes = new Set(found.flatMap(f => f.codes));
  const refs = new Set(found.flatMap(f => f.tools));
  expect(codes.size).toBeGreaterThan(10);
  expect(refs.size).toBeGreaterThan(4);
  expect([...codes].filter(c => !registry.includes(c))).toEqual([]);
  expect([...refs].filter(t => !tools.has(t))).toEqual([]);
});

it("detects a typo in a recovery tool and a subclass code", () => {
  const found = inspect('class X extends OperationError { constructor() { super("typo_code", "m", "Use page_forgett or call entity_facts."); } }');
  expect(found.codes).toEqual(["typo_code"]);
  expect(found.tools.filter(t => !tools.has(t))).toEqual(["page_forgett"]);
});
