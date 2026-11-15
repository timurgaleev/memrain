/**
 * Tool surfaces: how many tools a credential is shown.
 *
 *   full     every tool its scopes allow (the default; nothing changes)
 *   starter  the daily-driver set below
 *   verbs    the seven memory verbs
 *
 * A surface only ever narrows a grant: mcp/visibility.ts refuses a tool off
 * the credential's surface for tools/list and tools/call alike, so a hidden
 * tool is never callable by guessing its name. verbs ⊆ starter ⊆ full.
 */
export type ToolSurface = "full" | "starter" | "verbs";

export const TOOL_SURFACES: readonly ToolSurface[] = ["full", "starter", "verbs"];

export function isToolSurface(v: unknown): v is ToolSurface {
  return v === "full" || v === "starter" || v === "verbs";
}

export const VERB_TOOLS: ReadonlySet<string> = new Set([
  "recall",
  "add_fact",
  "entity_recall",
  "think",
  "forget_fact",
  "context_pack",
  "context_delta",
]);

export const STARTER_TOOLS: ReadonlySet<string> = new Set([
  ...VERB_TOOLS,
  "whoami",
  "search",
  "query",
  "search_exact",
  "page_get",
  "page_list",
  "page_put",
  "page_edit",
  "page_append",
  "get_links",
  "backlinks",
  "resolve_slugs",
  "entity_facts",
  "entity_timeline",
  "volunteer_context",
  "list_skills",
  "get_skill",
  "list_brain_skillpack",
]);

/** True when `name` is on `surface`; every tool is on the full surface. */
export function toolOnSurface(name: string, surface: ToolSurface): boolean {
  if (surface === "full") return true;
  return (surface === "verbs" ? VERB_TOOLS : STARTER_TOOLS).has(name);
}
