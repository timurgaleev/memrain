import { OperationError } from "./operation-error.ts";

const DEFAULT_MAX_RESULT_BYTES = 4 * 1024 * 1024;
const BOUNDED_TOOLS = new Set(["page_list", "page_versions", "get_chunks", "find_orphans", "search_exact"]);

export function mcpMaxResultBytes(): number {
  const raw = (process.env.MEMRAIN_MCP_MAX_RESULT_BYTES ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_RESULT_BYTES;
}

/** Measure the final tool result, including JSON escaping and optional metadata. */
export function oversizedResultError(tool: string, result: unknown): OperationError | null {
  if (!BOUNDED_TOOLS.has(tool) && !tool.startsWith("graph_")) return null;
  if (Buffer.byteLength(JSON.stringify(result), "utf8") <= mcpMaxResultBytes()) return null;
  return new OperationError(
    "result_too_large",
    "The serialized tool result exceeds MEMRAIN_MCP_MAX_RESULT_BYTES.",
    "Reduce limit or narrow the query. For page_list and page_versions, use include_body:false; read individual pages with page_get body windows.",
  );
}
