/**
 * Code chunker — splits a source file into one chunk per top-level
 * symbol (function / class / method / arrow-const). Returns lightweight
 * `Symbol` records the indexer can hand to `core/code-entities.ts` for
 * call-graph extraction.
 *
 * Design notes:
 *   - One pass per file. Walk the AST iteratively (no recursion) so we
 *     can break early on large generated files without a stack hit.
 *   - "Top-level symbol" includes:
 *       * function declarations + `export` wrappers around them
 *       * arrow functions assigned to top-level `const/let`
 *       * class declarations (and one chunk per method inside them)
 *       * Python `def` / `async def` / `class` (including methods)
 *   - For nested functions inside a top-level function we DO emit
 *     them as separate chunks (so `code-def innerHelper` resolves),
 *     with `enclosing` set to the outer symbol's name.
 *   - On parse error (`tree.rootNode.hasError`) we still return what we
 *     could extract — partial coverage beats zero coverage. Sweep
 *     escalates parse errors to a per-file warning.
 */
import { getParser, withParsedTree, type CodeLanguage } from "./parsers.ts";

/**
 * Code chunker version (migration 052). Stamped onto `documents.chunker_version`
 * for code documents. BUMP THIS whenever the symbol-splitting logic changes in a
 * way that should re-chunk the existing code corpus. Independent of
 * MARKDOWN_CHUNKER_VERSION — the stale check branches on document kind. Starts at
 * 1 (the grandfather DEFAULT).
 *
 * v2: symbol-less files (re-export barrels, DML-only SQL) now emit windowed
 * fallback chunks instead of a zero-chunk document — bump re-chunks the code
 * corpus so existing zero-chunk docs gain their chunks.
 *
 * v3: call edges now include Go `pkg.Fn()` / receiver calls and member calls
 * that share the enclosing symbol's name (`this.repo.save()` inside `save`);
 * the bump re-extracts the edges of every code document.
 */
export const CODE_CHUNKER_VERSION = 3;
import type { Node as TSNode } from "web-tree-sitter";

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "arrow"
  | "const"
  | "module-import";

export interface CodeSymbol {
  /** Bare identifier name. Lowercased copy lives in entityId(). */
  name: string;
  kind: SymbolKind;
  /** Source slice covering the entire symbol (signature + body). */
  body: string;
  /** 1-based start line in the file. */
  startLine: number;
  /** 1-based end line in the file. */
  endLine: number;
  /** Innermost enclosing function/method/class name; `null` at top level. */
  enclosing: string | null;
  /**
   * Full enclosing scope chain, outermost-first — e.g. a method inside
   * `outer() { class Inner { … } }` carries `["outer", "Inner"]`. Empty at
   * top level. `enclosing` is the last element (or null). Persisted to
   * `chunks.parent_symbol_path` (TEXT[]); keeps the nested-class ancestors
   * that the scalar form dropped.
   */
  parentSymbolPath: string[];
  /**
   * Extracted documentation comment for this symbol — JSDoc/`//` block
   * immediately above it (JS/TS) or the leading docstring (Python). `null`
   * when the symbol has none. Persisted to `chunks.doc_comment` and weighted
   * 'A' in the chunk FTS (migration 032), so a query that uses the prose
   * vocabulary of a function's doc — not its identifier — still ranks the
   * function's chunk above incidental body mentions.
   */
  docComment: string | null;
}

/** Upper bound on a captured doc comment — keeps the FTS weight-'A' segment
 * bounded so a long docstring/JSDoc can't dominate ranking or bloat a row. */
const DOC_COMMENT_MAX = 2000;

function clipDocComment(s: string): string | null {
  const t = s.trim();
  if (t.length === 0) return null;
  return t.length > DOC_COMMENT_MAX ? t.slice(0, DOC_COMMENT_MAX) : t;
}

/**
 * JS/TS doc comment = the contiguous run of `comment` nodes immediately above
 * the symbol's statement (climbing past an `export` wrapper and any leading
 * decorators). "Immediately" means no more than one blank line between the
 * comment and what it documents, so a file-level license header separated by
 * imports/blank lines is not mistaken for a symbol's doc. A TRAILING comment on
 * the previous statement's line (`const x = 1; // note`) is rejected — it
 * documents `x`, not the symbol below it.
 */
function jsPrecedingComment(node: TSNode): string | null {
  let stmt: TSNode = node;
  while (stmt.parent && stmt.parent.type === "export_statement") {
    stmt = stmt.parent;
  }
  let adjacentRow = stmt.startPosition.row;
  let sib = stmt.previousNamedSibling;
  // Skip leading decorators (a decorated method's previous sibling is the
  // `decorator`, with the doc comment above it). Track the row so adjacency is
  // measured against the decorator, not the symbol below it.
  while (sib && sib.type === "decorator") {
    adjacentRow = sib.startPosition.row;
    sib = sib.previousNamedSibling;
  }
  const parts: string[] = [];
  while (sib && sib.type === "comment" && adjacentRow - sib.endPosition.row <= 1) {
    const prev = sib.previousNamedSibling;
    // A comment sharing its start line with the end of a preceding node is a
    // trailing comment (code on the same line) — it documents that node, not
    // ours. Stop here.
    if (prev && prev.endPosition.row === sib.startPosition.row) break;
    parts.unshift(sib.text);
    adjacentRow = sib.startPosition.row;
    sib = prev;
  }
  return parts.length > 0 ? clipDocComment(parts.join("\n")) : null;
}

/** Strip Python string quoting (prefixes r/b/f/u + ' '' ''' " "" """). */
function stripPyStringQuotes(raw: string): string {
  const noPrefix = raw.replace(/^[rbuf]{0,3}/i, "");
  const m = noPrefix.match(/^('''|"""|'|")([\s\S]*?)\1$/);
  return m ? m[2]! : noPrefix;
}

/**
 * Python doc comment = the leading docstring: a string expression that is the
 * first statement in the symbol's body block.
 */
function pythonDocstring(node: TSNode): string | null {
  const body = node.childForFieldName("body");
  if (!body) return null;
  const first = body.namedChild(0);
  if (!first) return null;
  let str: TSNode | null = null;
  if (first.type === "expression_statement") {
    const inner = first.namedChild(0);
    if (inner && inner.type === "string") str = inner;
  } else if (first.type === "string") {
    str = first;
  }
  if (!str) return null;
  // Reject an f-string (a `string` containing an `interpolation` child) — Python
  // does not treat it as `__doc__`, so it is not a docstring.
  for (let i = 0; i < str.namedChildCount; i++) {
    if (str.namedChild(i)?.type === "interpolation") return null;
  }
  // Prefer the grammar's `string_content` segment(s); fall back to a quote strip.
  const contents: string[] = [];
  for (let i = 0; i < str.namedChildCount; i++) {
    const c = str.namedChild(i);
    if (c && c.type === "string_content") contents.push(c.text);
  }
  const text = contents.length > 0 ? contents.join("") : stripPyStringQuotes(str.text);
  return clipDocComment(text);
}

/** Dispatch doc-comment extraction by language. NULL-safe on any miss. */
function extractDocComment(node: TSNode, lang: CodeLanguage): string | null {
  if (lang === "python") return pythonDocstring(node);
  return jsPrecedingComment(node);
}

export interface FileLevelImport {
  /** Imported identifier (`foo` from `import { foo } from …`). */
  name: string;
  /** 1-based line where the import appears. */
  line: number;
}

export interface CodeChunked {
  /** Empty placeholder — kept symmetric with `ChunkedDocument`. */
  frontmatter: Record<string, unknown>;
  /** Conventional title for code files = the basename. */
  title: string | null;
  /** Symbols in document order. */
  symbols: CodeSymbol[];
  /** Imports parsed at file scope — they live outside any symbol body. */
  fileImports: FileLevelImport[];
  /** True if tree-sitter reported syntax errors anywhere in the tree. */
  hasParseError: boolean;
}

/**
 * Tree-sitter node types that correspond to a "symbol" we want to chunk.
 * Per language. The keys are tree-sitter grammar node-type strings.
 */
const SYMBOL_NODE_TYPES: Record<CodeLanguage, ReadonlyMap<string, SymbolKind>> = {
  typescript: new Map<string, SymbolKind>([
    ["function_declaration", "function"],
    ["function_signature", "function"],
    ["generator_function_declaration", "function"],
    ["class_declaration", "class"],
    ["abstract_class_declaration", "class"],
    ["method_definition", "method"],
    ["interface_declaration", "class"],
    ["type_alias_declaration", "const"],
    ["enum_declaration", "class"],
  ]),
  tsx: new Map<string, SymbolKind>([
    ["function_declaration", "function"],
    ["function_signature", "function"],
    ["generator_function_declaration", "function"],
    ["class_declaration", "class"],
    ["abstract_class_declaration", "class"],
    ["method_definition", "method"],
    ["interface_declaration", "class"],
    ["type_alias_declaration", "const"],
    ["enum_declaration", "class"],
  ]),
  python: new Map<string, SymbolKind>([
    ["function_definition", "function"],
    ["class_definition", "class"],
    // Decorated definitions wrap a function_definition / class_definition;
    // we visit children and pick up the inner node.
  ]),
  bash: new Map<string, SymbolKind>([
    // `foo() { … }` and `function foo { … }` both parse to function_definition
    // with a `name` field. A file-level `VAR=…` (variable_assignment) is left
    // out on purpose — it is a config line, not a symbol worth its own chunk.
    ["function_definition", "function"],
  ]),
  go: new Map<string, SymbolKind>([
    ["function_declaration", "function"],
    ["method_declaration", "method"],
    // `type Foo struct/interface { … }` parses to a type_declaration wrapping
    // one type_spec per name; the type_spec carries the `name` field, so we key
    // on it directly (also covers grouped `type ( A …; B … )`).
    ["type_spec", "class"],
  ]),
  // SQL has no fixed node→kind map: every top-level node is a `statement`
  // wrapping the real DDL child, so kind + name are derived per-statement in
  // visitSymbols (sqlSymbolFromStatement). Kept empty to satisfy the record.
  sql: new Map<string, SymbolKind>([]),
};

/**
 * SQL symbol extractor for the DerekStride grammar: a top-level `statement`
 * wraps a single DDL/DML child whose type is the real kind (create_table,
 * create_function, …). We chunk DDL *definitions* only — a table/view/function
 * is a durable schema symbol worth `code-def`; a bare SELECT/INSERT is not.
 * The target name is the first identifier / object_reference child (for
 * create_index that is the index name, ahead of the ON-table reference).
 */
function sqlSymbolFromStatement(
  stmt: TSNode,
): { name: string; kind: SymbolKind } | null {
  const inner = stmt.namedChild(0);
  if (!inner) return null;
  const t = inner.type;
  let kind: SymbolKind | null = null;
  if (/function|procedure|trigger/.test(t)) kind = "function";
  else if (t.includes("index")) kind = "const";
  else if (/^create_(?:table|view|type|schema|database|sequence|materialized)/.test(t)) {
    kind = "class";
  }
  if (!kind) return null;
  for (let i = 0; i < inner.namedChildCount; i++) {
    const c = inner.namedChild(i);
    if (!c) continue;
    if (
      c.type === "object_reference" ||
      c.type === "identifier" ||
      c.type.endsWith("_identifier")
    ) {
      const nm = (c.childForFieldName("name")?.text ?? c.text).trim();
      if (nm) return { name: nm, kind };
    }
  }
  return null;
}

/**
 * Extract a name from a symbol-bearing node. Tree-sitter uses different
 * field names per language; this normalizes them.
 */
function symbolName(node: TSNode, lang: CodeLanguage): string | null {
  // function_declaration / class_declaration / method_definition all expose
  // a `name` field in TS and Python grammars.
  const named = node.childForFieldName("name");
  if (named) return named.text;
  // type_alias_declaration uses the unique TS field name as well.
  if (lang === "typescript" || lang === "tsx") {
    // Some node types (e.g. variable_declarator inside a const) need
    // a different field. We fall back to the first identifier child.
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && child.type === "identifier") return child.text;
    }
  }
  return null;
}

/**
 * Recognize an arrow-function-assigned-to-const pattern like:
 *   const foo = (x: number) => x + 1;
 * Returns the bound name + arrow node, or null if not that shape.
 */
function arrowBindingFromLexicalDecl(node: TSNode): { name: string; arrow: TSNode } | null {
  if (node.type !== "lexical_declaration" && node.type !== "variable_declaration") {
    return null;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const declarator = node.namedChild(i);
    if (!declarator || declarator.type !== "variable_declarator") continue;
    const nameNode = declarator.childForFieldName("name");
    const valueNode = declarator.childForFieldName("value");
    if (!nameNode || !valueNode) continue;
    if (
      valueNode.type === "arrow_function" ||
      valueNode.type === "function_expression" ||
      valueNode.type === "function"
    ) {
      return { name: nameNode.text, arrow: valueNode };
    }
  }
  return null;
}

/**
 * Walk the AST iteratively (BFS via stack) and emit one CodeSymbol per
 * matching node. Tracks the innermost-enclosing function/method/class so
 * each emitted symbol records its parent name.
 */
function* visitSymbols(
  root: TSNode,
  lang: CodeLanguage,
  source: string,
): Generator<CodeSymbol> {
  const symbolTypes = SYMBOL_NODE_TYPES[lang];
  type Frame = { node: TSNode; enclosingPath: string[] };
  const stack: Frame[] = [{ node: root, enclosingPath: [] }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const { node, enclosingPath } = frame;

    let emittedName: string | null = null;
    let emittedKind: SymbolKind | null = null;
    let bodyNode: TSNode = node;

    // Plain matches (function_declaration, class_declaration, etc.)
    const kindMatch = symbolTypes.get(node.type);
    if (kindMatch) {
      const name = symbolName(node, lang);
      if (name) {
        emittedName = name;
        emittedKind = kindMatch;
      }
    }

    // const foo = () => { ... } pattern (TS only).
    if (
      !emittedName &&
      (lang === "typescript" || lang === "tsx") &&
      (node.type === "lexical_declaration" || node.type === "variable_declaration")
    ) {
      const binding = arrowBindingFromLexicalDecl(node);
      if (binding) {
        emittedName = binding.name;
        emittedKind = "arrow";
        bodyNode = node; // keep the whole `const foo = …` in the chunk body
      }
    }

    // SQL: the `statement` wrapper carries no name/kind of its own — both live
    // in its inner DDL child. Keep the whole statement as the chunk body.
    if (!emittedName && lang === "sql" && node.type === "statement") {
      const sqlSym = sqlSymbolFromStatement(node);
      if (sqlSym) {
        emittedName = sqlSym.name;
        emittedKind = sqlSym.kind;
        bodyNode = node;
      }
    }

    if (emittedName && emittedKind) {
      yield {
        name: emittedName,
        kind: emittedKind,
        body: source.slice(bodyNode.startIndex, bodyNode.endIndex),
        // tree-sitter rows are 0-based; convert to 1-based for SQL.
        startLine: bodyNode.startPosition.row + 1,
        endLine: bodyNode.endPosition.row + 1,
        enclosing:
          enclosingPath.length > 0
            ? enclosingPath[enclosingPath.length - 1]!
            : null,
        parentSymbolPath: [...enclosingPath],
        docComment: extractDocComment(bodyNode, lang),
      };
    }

    // Push children in reverse so document order pops first. A named symbol
    // extends the scope chain for everything beneath it.
    const childCount = node.namedChildCount;
    const nextPath = emittedName
      ? [...enclosingPath, emittedName]
      : enclosingPath;
    for (let i = childCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push({ node: child, enclosingPath: nextPath });
    }
  }
}

const IMPORT_NODE_TYPES_PER_LANG: Record<CodeLanguage, ReadonlySet<string>> = {
  typescript: new Set(["import_statement"]),
  tsx: new Set(["import_statement"]),
  python: new Set(["import_statement", "import_from_statement"]),
  // bash `source`/`.` and Go/SQL imports are path strings, not identifier
  // graphs — nothing useful to hang a file-level import entity on.
  bash: new Set<string>(),
  go: new Set<string>(),
  sql: new Set<string>(),
};

/**
 * Walk only the immediate children of root and return file-level
 * imports. Nested imports inside functions are intentionally ignored
 * — their containing symbol's `extractCodeEntities` will pick them up.
 */
function* visitFileImports(
  root: import("web-tree-sitter").Node,
  language: CodeLanguage,
): Generator<FileLevelImport> {
  const importTypes = IMPORT_NODE_TYPES_PER_LANG[language];
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (!child) continue;
    if (!importTypes.has(child.type)) continue;
    const line = child.startPosition.row + 1;
    // Walk imported identifiers — coarse but safe pass.
    const stack: import("web-tree-sitter").Node[] = [child];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur) break;
      if (
        cur.type === "identifier" ||
        cur.type === "type_identifier" ||
        cur.type === "import_specifier"
      ) {
        // For import_specifier, prefer its `name` field (handles `bar as baz`).
        if (cur.type === "import_specifier") {
          const name = cur.childForFieldName("name") ?? cur.namedChild(0);
          if (name) yield { name: name.text, line };
          continue;
        }
        yield { name: cur.text, line };
        continue;
      }
      if (language === "python" && cur.type === "dotted_name") {
        const last = cur.namedChild(cur.namedChildCount - 1);
        if (last) yield { name: last.text, line };
        continue;
      }
      for (let j = 0; j < cur.namedChildCount; j++) {
        const c = cur.namedChild(j);
        if (c) stack.push(c);
      }
    }
  }
}

/**
 * Parse source code, walk the tree, return one CodeSymbol per top-level
 * (and nested-function) definition. Throws only if the parser itself
 * fails to load — syntax errors in the source are surfaced via
 * `hasParseError` so the caller can log + continue.
 */
export async function chunkCode(
  source: string,
  filename: string,
  language: CodeLanguage,
): Promise<CodeChunked> {
  const parser = await getParser(language);
  // withParsedTree throws ParseTimeoutError on a wall-clock overrun; the
  // per-file try/catch in sweep-code records it and skips the file (no
  // partial/lossy reindex). Otherwise it parses, runs the walk, and frees the
  // tree — including when the walk throws, which is the path the indexer's
  // grammar degrade swallows upstream.
  //
  // Everything we keep is a plain string/number sliced out of `source`, so
  // nothing here holds a Node past the tree's lifetime.
  const { symbols, fileImports, hasParseError } = withParsedTree(
    parser,
    source,
    (tree) => ({
      symbols: Array.from(visitSymbols(tree.rootNode, language, source)),
      fileImports: Array.from(visitFileImports(tree.rootNode, language)),
      hasParseError: tree.rootNode.hasError,
    }),
  );
  // Dedup imports by (name, line).
  const seen = new Set<string>();
  const dedup: FileLevelImport[] = [];
  for (const imp of fileImports) {
    const k = `${imp.name}:${imp.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(imp);
  }
  // Sort by start line so document order is stable regardless of stack push order.
  symbols.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  // Title = basename (no path) — lets `memrain search` show a friendly source.
  const slash = filename.lastIndexOf("/");
  const title = slash >= 0 ? filename.slice(slash + 1) : filename;
  return {
    frontmatter: {},
    title,
    symbols,
    fileImports: dedup,
    hasParseError,
  };
}
