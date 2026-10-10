/**
 * Code edges — persists call/import edges between code chunks into
 * `code_edges_symbol` (migration 041) with the target left UNRESOLVED. The
 * `resolve-symbol-edges` cycle phase later writes the defining chunk id into
 * `edge_metadata.resolved_chunk_id`.
 *
 * memrain already extracts callees as `code-caller` entities; this module turns
 * those into typed, chunk-anchored edges so the call graph can resolve to a
 * specific defining chunk rather than aliasing same-named symbols together.
 */
import type { Engine } from "./engine/interface.ts";

/** parent path :: name → the qualified symbol name (or the bare name at top). */
export function qualifiedSymbolName(
  parentSymbolPath: readonly string[] | null | undefined,
  name: string,
): string {
  return parentSymbolPath && parentSymbolPath.length > 0
    ? [...parentSymbolPath, name].join("::")
    : name;
}

export interface CodeEdgeInput {
  fromChunkId: string;
  fromSymbolQualified: string | null;
  toSymbolQualified: string;
  edgeType: string;
}

/**
 * Insert a document's code edges on the caller's transaction. Runs inside
 * writeDocumentTransaction after the document's chunks were replaced — the
 * chunk delete there cascades the old edges away — so a failure here rolls
 * back the whole write instead of leaving fresh chunks with no call graph.
 */
export async function insertCodeEdges(
  tx: Engine,
  edges: readonly CodeEdgeInput[],
): Promise<number> {
  if (edges.length === 0) return 0;
  // One statement for the whole document: a large file has thousands of edges
  // and a round trip each held the document transaction open that long. The
  // edge takes its source from the chunk's document, so a scoped reader walks
  // exactly the graph of the sources it may read.
  const r = await tx.query<{ id: number }>(
    `INSERT INTO code_edges_symbol
       (from_chunk_id, from_symbol_qualified, to_symbol_qualified,
        edge_type, source_id)
     SELECT c.id, i.from_symbol, i.to_symbol, i.edge_type, d.source_id
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
              AS i(from_chunk_id, from_symbol, to_symbol, edge_type)
       JOIN chunks c ON c.id = i.from_chunk_id
       JOIN documents d ON d.id = c.document_id
     ON CONFLICT (from_chunk_id, to_symbol_qualified, edge_type)
       DO NOTHING
     RETURNING id`,
    [
      edges.map((e) => e.fromChunkId),
      edges.map((e) => e.fromSymbolQualified),
      edges.map((e) => e.toSymbolQualified),
      edges.map((e) => e.edgeType),
    ],
  );
  return r.rows.length;
}
