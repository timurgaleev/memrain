/**
 * docs/TOOLS.md, rendered from the same OPERATIONS contract that tools/list
 * serves (written by scripts/gen-catalogs.ts, pinned by
 * tests/tool_catalog.test.ts). Nothing here is hand-kept: a tool's scope,
 * effect, parameters and operator-only status all come from the code, so the
 * page cannot describe a tool the server does not have.
 */
import { OPERATIONS, operationAnnotations, type Operation, type ParamDef } from "./operations.ts";
import { OPERATOR_ONLY_TOOLS } from "./visibility.ts";

type Scope = NonNullable<Operation["scope"]>;

const SCOPE_ORDER: readonly Scope[] = ["read", "write", "admin", "agent"];

const SCOPE_HEADING: Record<Scope, string> = {
  read: "Read tools",
  write: "Write tools",
  admin: "Admin tools",
  agent: "Agent tools",
};

const SCOPE_MEANING: Record<Scope, string> = {
  read: "Any caller that can see the brain; results are limited to the sources the credential may read.",
  write: "A credential with a write source; changes land only in sources it may write.",
  admin: "A credential granted the `admin` scope.",
  agent: "A credential granted the `agent` scope; these queue background work that may spend.",
};

/** Table cells hold one line, and a pipe would end the cell. */
function cell(text: string): string {
  return text.split("\n").map((l) => l.trim()).filter((l) => l !== "").join(" ").replace(/\|/g, "\\|");
}

function effect(op: Operation): string {
  const a = operationAnnotations(op);
  if (a.readOnlyHint) return "read-only";
  const parts = [a.destructiveHint ? "writes, destructive" : "writes"];
  if (a.idempotentHint) parts.push("idempotent");
  return parts.join(", ");
}

function paramType(def: ParamDef): string {
  let t: string = def.type;
  if (def.type === "array" && def.items && typeof def.items["type"] === "string") t = `${def.items["type"]}[]`;
  const notes: string[] = [];
  if (def.enum) notes.push(`one of ${def.enum.map((v) => `\`${v}\``).join(", ")}`);
  if (def.minimum !== undefined && def.maximum !== undefined) notes.push(`${def.minimum}–${def.maximum}`);
  else if (def.minimum !== undefined) notes.push(`≥ ${def.minimum}`);
  else if (def.maximum !== undefined) notes.push(`≤ ${def.maximum}`);
  return notes.length > 0 ? `${t} (${notes.join("; ")})` : t;
}

function scopeOf(op: Operation): Scope {
  return op.scope ?? "read";
}

function operatorOnly(op: Operation): string {
  return OPERATOR_ONLY_TOOLS.has(op.name) ? "yes" : "no";
}

function toolSection(op: Operation): string[] {
  const lines = [
    "",
    `### ${op.name}`,
    "",
    `Scope: ${scopeOf(op)}. Effect: ${effect(op)}.${OPERATOR_ONLY_TOOLS.has(op.name) ? " Operator only." : ""}`,
    "",
    cell(op.description),
  ];
  if (op.callShape) lines.push("", `Call shape: \`${op.callShape}\``);
  const params = Object.entries(op.params);
  if (params.length === 0) {
    lines.push("", "No parameters.");
    return lines;
  }
  lines.push("", "| Parameter | Type | Required | Description |", "|---|---|---|---|");
  for (const [name, def] of params) {
    lines.push(`| \`${name}\` | ${cell(paramType(def))} | ${def.required ? "yes" : "no"} | ${cell(def.description ?? "")} |`);
  }
  return lines;
}

export function renderToolCatalog(): string {
  const out: string[] = [
    "# MCP tools",
    "",
    "<!-- Generated from deploy/memrain/src/mcp/operations.ts.",
    "     Do not edit by hand: run `bun scripts/gen-catalogs.ts` in deploy/memrain. -->",
    "",
    `Memrain serves ${OPERATIONS.length} tools over MCP. This page lists each one with the`,
    "parameters it accepts — the same definitions clients receive from `tools/list`.",
    "A client only sees the tools its credential may call, so a token may list",
    "fewer. From a shell, `memrain call <tool> --args '<json>'` runs any of them",
    "locally. Errors are described in [ERRORS.md](ERRORS.md).",
    "",
    "- **Scope** is what the credential needs.",
    "- **Effect** is `read-only`, `writes`, or `writes, destructive` when the tool",
    "  can overwrite or delete; `idempotent` means repeating the same call changes",
    "  nothing more.",
    "- **Operator only** tools expose brain-wide state and are refused to tenant",
    "  credentials.",
    "",
    "| Scope | Who may call |",
    "|---|---|",
    ...SCOPE_ORDER.map((s) => `| ${s} | ${SCOPE_MEANING[s]} |`),
    "",
    "## All tools",
    "",
    "| Tool | Scope | Effect | Operator only |",
    "|---|---|---|---|",
    ...OPERATIONS.map((op) => `| [\`${op.name}\`](#${op.name}) | ${scopeOf(op)} | ${effect(op)} | ${operatorOnly(op)} |`),
  ];
  for (const scope of SCOPE_ORDER) {
    const ops = OPERATIONS.filter((op) => scopeOf(op) === scope);
    if (ops.length === 0) continue;
    out.push("", `## ${SCOPE_HEADING[scope]}`);
    for (const op of ops) out.push(...toolSection(op));
  }
  return `${out.join("\n")}\n`;
}
