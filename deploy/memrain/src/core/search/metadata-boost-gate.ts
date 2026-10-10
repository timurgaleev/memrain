/**
 * Metadata-boost gate (MEMRAIN_RANK_METADATA_GATE, default off).
 *
 * The post-fusion metadata multipliers (recency, salience, chronicle,
 * mattering, graph signals, backlinks, alias-resolved) are 1.03-2x nudges. On a
 * query only the vector arm answered — no keyword row, no title, no relational
 * edge — the fused list is a pure similarity ranking whose neighbours sit a
 * percent or two apart, so those nudges decide the order on their own and
 * lift well-linked or fresh pages over the page the question was about. With
 * the gate on they are skipped for exactly that shape; any lexical vote keeps
 * them. The exact-match, title-phrase and compiled-truth boosts are relevance
 * signals, not metadata, and always run.
 */

export interface MetadataGateInput {
  enabled: boolean;
  /** The vector arm returned rows. */
  vectorVoted: boolean;
  /** A strict keyword, title-arm or relational row reached fusion. */
  lexicalVoted: boolean;
}

/** True when the metadata boosts should be skipped for this query. */
export function skipMetadataBoosts(input: MetadataGateInput): boolean {
  return input.enabled && input.vectorVoted && !input.lexicalVoted;
}
