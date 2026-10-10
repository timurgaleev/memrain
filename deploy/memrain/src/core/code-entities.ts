/**
 * Code-entity extractor — given a parsed `CodeSymbol` plus its language,
 * emit ExtractedEntity rows for the four code graph types defined in
 * migration 014:
 *
 *   code-def     — definition of <name>            (1 per symbol, by definition)
 *   code-ref     — non-defining reference to <name> (imports, type refs,
 *                                                    bare identifier reads)
 *   code-caller  — keyed by callee name; the chunk's owning symbol is
 *                  the caller, so the surface_form records that
 *   code-callee  — keyed by enclosing symbol; mention recorded per call site
 *
 * Why this asymmetric design:
 *   `memrain code-callers Foo` should answer "who calls Foo?" — that's
 *     a SQL filter `WHERE entity_id = ent_code-caller_foo`, with the
 *     surface_form telling you which file:line:enclosing symbol does it.
 *   `memrain code-callees src/foo.ts:42` resolves the chunk covering
 *     line 42 (its symbol = enclosing), then SELECT entity_id matching
 *     code-callee_<enclosing> — surface_form lists each call target.
 *
 * surface_form convention: "<file>:<line>:<enclosing>" so CLI output
 * is grep-able regardless of which entity type was queried.
 *
 * Identifier resolution is bare-name only by design (Q6=A, symbol-name
 * graph). `obj.method()` records `code-callee` for `method`, not
 * `obj.method`. False-positive collisions are intentional — a future
 * pass can layer module-qualification on top using surface_form.
 */
import type { CodeSymbol } from "./chunkers/code.ts";
import type { CodeLanguage } from "./chunkers/parsers.ts";
import type { ExtractedEntity } from "./entities.ts";
import { getParser, withParsedTree } from "./chunkers/parsers.ts";
import type { Node as TSNode } from "web-tree-sitter";

export interface ExtractCodeEntitiesInput {
  symbol: CodeSymbol;
  /** File path used as the prefix in surface_form. */
  file: string;
  language: CodeLanguage;
}

/**
 * Tree-sitter node types that are *call expressions* (the function being
 * invoked appears as `function`/`callee`/first child depending on grammar).
 */
const CALL_NODE_TYPES: Record<CodeLanguage, ReadonlySet<string>> = {
  typescript: new Set(["call_expression", "new_expression"]),
  tsx: new Set(["call_expression", "new_expression"]),
  python: new Set(["call"]),
  // Go: `foo()` exposes the callee via the `function` field; a package or
  // receiver call (`pkg.Fn()`, `s.repo.Save()`) is a selector_expression keyed
  // by its field name, like a TS member call. bash commands and SQL calls are
  // too noisy / not name-graph edges, so they contribute no call entities.
  go: new Set(["call_expression"]),
  bash: new Set<string>(),
  sql: new Set<string>(),
};

/**
 * Tree-sitter node types that introduce *imports* — extract the imported
 * names as `code-ref` entries so `code-refs Foo` finds the import lines.
 */
const IMPORT_NODE_TYPES: Record<CodeLanguage, ReadonlySet<string>> = {
  typescript: new Set([
    "import_statement",
    "import_clause",
    "named_imports",
    "import_specifier",
  ]),
  tsx: new Set([
    "import_statement",
    "import_clause",
    "named_imports",
    "import_specifier",
  ]),
  python: new Set([
    "import_statement",
    "import_from_statement",
    "aliased_import",
  ]),
  // Go/SQL/bash imports (package paths, `source`) are string literals, not
  // identifier references — no `code-ref` names to extract.
  go: new Set<string>(),
  bash: new Set<string>(),
  sql: new Set<string>(),
};

function surfaceFor(file: string, line: number, enclosing: string | null): string {
  return `${file}:${line}:${enclosing ?? "<top>"}`;
}

/** Node types that continue a member-access chain, per grammar family. */
const MEMBER_CHAIN_TYPES = new Set(["member_expression", "subscript_expression"]);
const PYTHON_MEMBER_CHAIN_TYPES = new Set([...MEMBER_CHAIN_TYPES, "attribute"]);
const GO_MEMBER_CHAIN_TYPES = new Set(["selector_expression"]);

interface CalleeName {
  name: string;
  /** True for `obj.name()` / `pkg.Name()` — the call goes through a receiver. */
  member: boolean;
}

/**
 * Extract the bare callee name from a call expression node. Handles:
 *   foo()                  → "foo"
 *   obj.method()           → "method"
 *   obj?.method()          → "method"
 *   ns.cls.bar()           → "bar"
 *   new Foo()              → "Foo"
 *   foo.bar.baz()          → "baz"
 *   x()()                  → null (chained call result, not a name)
 *
 * Python:
 *   foo()                  → "foo"
 *   obj.method()           → "method"
 *   obj.cls.bar()          → "bar"
 *
 * Go:
 *   Fn()                   → "Fn"
 *   pkg.Fn()               → "Fn"
 *   s.repo.Save()          → "Save"
 */
function calleeNameFromCallNode(call: TSNode, language: CodeLanguage): CalleeName | null {
  // TS / TSX: `call_expression` / `new_expression` expose `function` field.
  // Python: `call` exposes `function` field too.
  let target: TSNode | null =
    call.childForFieldName("function") ??
    call.childForFieldName("callee") ??
    null;
  if (!target) {
    // Some grammars don't have explicit field; first non-paren named child.
    target = call.namedChild(0);
  }
  if (!target) return null;

  // Walk member access chains down to the last segment. The set of chain node
  // types is fixed per language, so resolve it once instead of re-testing the
  // language on every hop.
  const chainTypes =
    language === "python"
      ? PYTHON_MEMBER_CHAIN_TYPES
      : language === "go"
        ? GO_MEMBER_CHAIN_TYPES
        : MEMBER_CHAIN_TYPES;
  let member = false;
  while (target && chainTypes.has(target.type)) {
    const right: TSNode | null =
      target.childForFieldName("property") ??
      target.childForFieldName("attribute") ??
      target.childForFieldName("field") ??
      target.namedChild(target.namedChildCount - 1);
    if (!right) break;
    target = right;
    member = true;
  }

  if (!target) return null;
  if (
    target.type === "identifier" ||
    target.type === "property_identifier" ||
    target.type === "field_identifier"
  ) {
    return { name: target.text, member };
  }
  return null;
}

/**
 * Extract identifier names from import nodes — for `code-ref` entries.
 */
function importNamesFromNode(node: TSNode, language: CodeLanguage): string[] {
  const names: string[] = [];
  // Walk all named identifier children — a coarse but safe pass.
  const stack: TSNode[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) break;
    if (cur.type === "identifier" || cur.type === "type_identifier") {
      names.push(cur.text);
      continue;
    }
    if (language === "python" && cur.type === "dotted_name") {
      // Use the last segment of `import a.b.c` → c
      const last = cur.namedChild(cur.namedChildCount - 1);
      if (last) names.push(last.text);
      continue;
    }
    for (let i = 0; i < cur.namedChildCount; i++) {
      const child = cur.namedChild(i);
      if (child) stack.push(child);
    }
  }
  return names;
}

/**
 * Tree-sitter node types that introduce a NEW symbol scope. When walking
 * a symbol's body for entities, we DON'T descend into these — the inner
 * symbol gets its own `extractCodeEntities` call and would double-count
 * the calls otherwise (a class would claim every method's call sites).
 */
const NESTED_SCOPE_TYPES: Record<CodeLanguage, ReadonlySet<string>> = {
  typescript: new Set([
    "function_declaration",
    "method_definition",
    "arrow_function",
    "function_expression",
    "function",
    "function_signature",
    "generator_function_declaration",
    // Class-family scopes — same reasoning. When extracting entities for
    // a class symbol, we descend into the class body once but stop at any
    // nested function/method (each is its own symbol).
    "class_declaration",
    "abstract_class_declaration",
    "interface_declaration",
    "enum_declaration",
  ]),
  tsx: new Set([
    "function_declaration",
    "method_definition",
    "arrow_function",
    "function_expression",
    "function",
    "function_signature",
    "generator_function_declaration",
    "class_declaration",
    "abstract_class_declaration",
    "interface_declaration",
    "enum_declaration",
  ]),
  python: new Set(["function_definition", "class_definition"]),
  // A nested scope inside a symbol's body is its own chunk elsewhere; stop the
  // entity walk at its boundary so calls aren't double-counted.
  go: new Set([
    "function_declaration",
    "method_declaration",
    "func_literal",
    "type_spec",
  ]),
  bash: new Set(["function_definition"]),
  sql: new Set(["statement"]),
};

/**
 * Walk descendants of `root`. Tracks how many scope-introducing nodes
 * we've ENTERED — the first one is the symbol's own body (always
 * descend), subsequent ones are nested functions/methods inside that
 * body which will be processed as their own symbols (skip).
 *
 * We always yield the node itself before deciding whether to descend,
 * so the symbol's own declaration is visible to the caller.
 */
function* walk(root: TSNode, language: CodeLanguage): Generator<TSNode> {
  const scopeTypes = NESTED_SCOPE_TYPES[language];
  const stack: { node: TSNode; depth: number }[] = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    yield frame.node;
    const isScope = scopeTypes.has(frame.node.type);
    // Skip descent only if we're ABOUT to enter the SECOND scope (or deeper).
    // depth counts scopes entered so far on the path from root.
    if (isScope && frame.depth >= 1) continue;
    const childDepth = frame.depth + (isScope ? 1 : 0);
    for (let i = frame.node.namedChildCount - 1; i >= 0; i--) {
      const child = frame.node.namedChild(i);
      if (child) stack.push({ node: child, depth: childDepth });
    }
  }
}

/**
 * Extract the four code-* entity types for one symbol's body. The symbol
 * itself contributes one `code-def`. Calls inside the body contribute
 * paired `code-caller` (keyed by callee) + `code-callee` (keyed by this
 * symbol's name) entries. Imports + identifier references contribute
 * `code-ref`.
 *
 * NOTE: this re-parses the symbol body via tree-sitter. We could avoid
 * the extra parse by walking the original tree and slicing per symbol,
 * but the per-symbol body is small (<10 KB typically) and the API
 * boundary is cleaner this way: chunkCode hands us text + line range,
 * we do our own walk. If perf becomes an issue, fold this into the
 * single-pass visit in chunkers/code.ts.
 */
export async function extractCodeEntities(
  input: ExtractCodeEntitiesInput,
): Promise<ExtractedEntity[]> {
  const { symbol, file, language } = input;
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();
  const push = (e: ExtractedEntity): void => {
    const k = `${e.type}::${e.name}::${e.surfaceForm}`;
    if (seen.has(k)) return;
    seen.add(k);
    entities.push(e);
  };

  // 1. The definition itself.
  push({
    type: "code-def",
    name: symbol.name,
    surfaceForm: surfaceFor(file, symbol.startLine, symbol.enclosing),
  });

  // Re-parse the symbol body so we can walk call sites. The body is a
  // syntactically incomplete fragment for some languages (e.g. a method
  // without its enclosing class), but tree-sitter recovers gracefully —
  // we only need named identifier + call_expression nodes.
  const parser = await getParser(language);
  const callTypes = CALL_NODE_TYPES[language];
  const importTypes = IMPORT_NODE_TYPES[language];

  // withParsedTree throws ParseTimeoutError on overrun. We let it propagate
  // (NOT degrade to a partial entity set): the caller indexCodeDocument runs
  // this BEFORE writeDocumentTransaction, so a throw skips the whole file and
  // preserves the prior chunks/edges — silently overwriting a reindex with a
  // half-parsed symbol's edges would erase good call-graph data. The sub-tree
  // is freed on the way out either way; a sweep allocates one per symbol, so
  // leaking these is what makes the leak grow with the corpus rather than with
  // the file count. Every entity below is a plain string, never a Node.
  withParsedTree(parser, symbol.body, (subTree) => {
    for (const node of walk(subTree.rootNode, language)) {
      const lineInFile = symbol.startLine + node.startPosition.row;

      if (callTypes.has(node.type)) {
        const call = calleeNameFromCallNode(node, language);
        if (call) {
          const callee = call.name;
          // Skip a bare recursive call (a noise edge to itself). A member call
          // with the same name — `this.repo.save()` inside `save` — is a call
          // to ANOTHER object's method and is kept.
          if (call.member || callee !== symbol.name) {
            push({
              type: "code-caller",
              name: callee,
              surfaceForm: surfaceFor(file, lineInFile, symbol.name),
            });
          }
          push({
            type: "code-callee",
            name: symbol.name,
            surfaceForm: `${callee}@${file}:${lineInFile}`,
          });
        }
        continue;
      }

      if (importTypes.has(node.type)) {
        for (const name of importNamesFromNode(node, language)) {
          push({
            type: "code-ref",
            name,
            surfaceForm: surfaceFor(file, lineInFile, symbol.enclosing),
          });
        }
        continue;
      }

      // Bare type-identifier references in TS — e.g. `function f(x: Foo)`.
      if (
        (language === "typescript" || language === "tsx") &&
        node.type === "type_identifier"
      ) {
        push({
          type: "code-ref",
          name: node.text,
          surfaceForm: surfaceFor(file, lineInFile, symbol.name),
        });
      }
    }
  });

  return entities;
}
