import { OperationError } from "../core/operation-error.ts";

const SOURCE_FILTER_TOOLS = new Set(["search", "query", "page_list", "context_delta", "quarantine_list", "extraction_review"]);

export function narrowReadSources(tool: string, args: Record<string, unknown>, granted?: string[]): string[] | undefined {
  if (!SOURCE_FILTER_TOOLS.has(tool) || args.source_ids === undefined) return granted;
  const requested = args.source_ids;
  if (!Array.isArray(requested) || requested.length > 100 ||
      requested.some(id => typeof id !== "string" || id.length === 0 || id.length > 200 || id.trim() !== id)) {
    throw new OperationError("invalid_params", "source_ids must contain at most 100 non-empty source IDs",
      "Omit source_ids to use your grant, or pass an array of exact source IDs; [] reads nothing.");
  }
  if (granted !== undefined && requested.some(id => !granted.includes(id))) {
    throw new OperationError("permission_denied", "source_ids includes a source outside your read grant",
      "Choose only sources granted to this credential.");
  }
  return [...new Set(requested as string[])].sort();
}

/** The reads that, unqualified, reach only the default source and the federated ones (core/sources.ts federatedReadScope). */
const FEDERATED_SCOPE_TOOLS = new Set([
  "search", "query", "recall", "think", "context_pack", "volunteer_context", "page_list", "find_experts",
]);

/** search and query filters that ask for code, which lives in sources that are not federated. */
const CODE_FILTERS = ["lang", "near_symbol", "symbol_kind"] as const;

/**
 * True when this call is an unqualified read: a federated-scope tool, no
 * `source_ids`, and no code filter. Dispatch applies it only when the
 * credential's grant names no source; a grant that lists sources is kept as is.
 * A `query` with `refine` does not apply the code filters, so they do not lift
 * federation there.
 */
export function readsFederatedScope(tool: string, args: Record<string, unknown>): boolean {
  if (!FEDERATED_SCOPE_TOOLS.has(tool) || args.source_ids !== undefined) return false;
  if (tool === "query" && typeof args.refine === "string" && args.refine !== "") return true;
  return !CODE_FILTERS.some(k => typeof args[k] === "string" && args[k] !== "");
}
