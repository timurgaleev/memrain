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
