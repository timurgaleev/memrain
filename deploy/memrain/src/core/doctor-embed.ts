/**
 * doctor-embed.ts — the embedding backlog.
 *
 * Chunks written while embedding was deferred (a spent budget, a Bedrock
 * outage) are keyword-searchable but invisible to semantic search until the
 * cycle's embed-gaps phase gives them vectors. A small backlog that drains is
 * normal; a large one that has sat for a day means the fill is off, capped
 * below the write rate, or failing every tick.
 */
import type { CheckStatus } from "./doctor-categories.ts";
import type { Engine } from "./engine/interface.ts";
import { embeddableChunkFragment } from "./embed-skip.ts";
import { factSourceEligibleSql } from "./quarantine.ts";
import { embedGapsEnabled } from "./cycle/embed-gaps.ts";
import { CONTEXTUAL_RETRIEVAL_FLAG, contextualRetrievalEnabled } from "./search/contextual-embed.ts";
import { CONTEXTUAL_LLM_FLAG, contextualLlmEnabled } from "./search/contextual-llm.ts";

export interface EmbedBacklogCheck {
  ok: boolean;
  status: CheckStatus;
  detail: string;
}

/** Below this many gap chunks the backlog never warns. */
export const EMBED_BACKLOG_MIN = 1000;
/** Share of the embeddable corpus a backlog must exceed to warn. */
export const EMBED_BACKLOG_SHARE = 0.01;
/** How long the oldest gap must have waited before the backlog warns. */
export const EMBED_BACKLOG_MAX_AGE_HOURS = 24;

interface BacklogRow {
  gaps: number | string;
  total: number | string;
  oldest_age_s: number | string | null;
}

/**
 * Warns when the backlog exceeds max(1000, 1% of embeddable chunks) AND its
 * oldest chunk is over a day old. A gap's age is its document's last write:
 * re-indexing rewrites every chunk, so that is when the chunk was stored.
 */
export async function checkEmbedBacklog(engine: Engine): Promise<EmbedBacklogCheck> {
  const r = await engine.query<BacklogRow>(
    `SELECT count(*) FILTER (WHERE em.chunk_id IS NULL)::int AS gaps,
            count(*)::int AS total,
            EXTRACT(EPOCH FROM now() - min(d.updated_at) FILTER (WHERE em.chunk_id IS NULL))::float8 AS oldest_age_s
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       LEFT JOIN embeddings em ON em.chunk_id = c.id
      WHERE ${embeddableChunkFragment("d", "c")}`,
  );
  const facts = await engine.query<BacklogRow>(
    `SELECT count(*) FILTER (WHERE embedding IS NULL)::int AS gaps,
            count(*)::int AS total,
            EXTRACT(EPOCH FROM now() - min(written_at) FILTER (WHERE embedding IS NULL))::float8 AS oldest_age_s
       FROM entity_facts WHERE forgotten_at IS NULL AND ${factSourceEligibleSql()}`,
  );
  const chunks = describeBacklog(r.rows[0], "embeddable chunk(s)");
  const factBacklog = describeBacklog(facts.rows[0], "eligible live fact(s)");
  const fill = embedGapsEnabled()
    ? "check the cycle's embed-gaps phase or MEMRAIN_EMBED_GAPS_MAX_PER_CYCLE"
    : "MEMRAIN_EMBED_GAPS=0 turns the cycle's fill off";
  return {
    ok: true,
    status: chunks.warn || factBacklog.warn ? "warn" : "ok",
    detail: `${chunks.detail}; ${factBacklog.detail}` +
      (chunks.warn ? `; ${fill}, or run \`memrain embed\`` : "") +
      (factBacklog.warn ? "; inspect or run `memrain cycle --phases embed-facts` within the normal embedding budget" : ""),
  };
}

/** Under contextual retrieval, the share of prose vectors that must carry their document context. */
export const CONTEXTUAL_COVERAGE_MIN = 0.5;

/**
 * Under contextual retrieval, how many stored prose vectors were embedded with
 * their document context. Code documents and fenced-code symbols are embedded
 * raw by design and stay out of the count; a chunk with no tier recorded
 * predates the tier column and counts as uncovered. Off, the share means
 * nothing — every vector is raw on purpose.
 */
export async function checkContextualCoverage(
  engine: Engine,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EmbedBacklogCheck> {
  if (!contextualRetrievalEnabled(env[CONTEXTUAL_RETRIEVAL_FLAG]) && !contextualLlmEnabled(env[CONTEXTUAL_LLM_FLAG])) {
    return { ok: true, status: "ok", detail: `${CONTEXTUAL_RETRIEVAL_FLAG} is off; contextual coverage is not measured` };
  }
  const r = await engine.query<{ covered: number | string; total: number | string; unknown: number | string }>(
    `SELECT count(*) FILTER (WHERE c.contextual_tier IN ('deterministic', 'llm') OR c.contextual_embedded)::int AS covered,
            count(*)::int AS total,
            count(*) FILTER (WHERE c.contextual_tier IS NULL AND NOT c.contextual_embedded)::int AS unknown
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       JOIN embeddings em ON em.chunk_id = c.id
      WHERE ${embeddableChunkFragment("d", "c")}
        AND c.chunk_source IS DISTINCT FROM 'fenced_code'`,
  );
  const covered = Number(r.rows[0]?.covered ?? 0);
  const total = Number(r.rows[0]?.total ?? 0);
  const unknown = Number(r.rows[0]?.unknown ?? 0);
  const share = total === 0 ? 1 : covered / total;
  const warn = share < CONTEXTUAL_COVERAGE_MIN;
  return {
    ok: true,
    status: warn ? "warn" : "ok",
    detail: `${covered} of ${total} prose vector(s) carry document context (${Math.floor(share * 100)}%; ` +
      `warns below ${CONTEXTUAL_COVERAGE_MIN * 100}%); ${unknown} predate the tier record` +
      (warn ? "; `memrain reindex --contextual --dry-run` prices the re-embed" : ""),
  };
}

function describeBacklog(row: BacklogRow | undefined, kind: string): { warn: boolean; detail: string } {
  const gaps = Number(row?.gaps ?? 0);
  const total = Number(row?.total ?? 0);
  const ageHours = Number(row?.oldest_age_s ?? 0) / 3600;
  const threshold = Math.max(EMBED_BACKLOG_MIN, Math.ceil(total * EMBED_BACKLOG_SHARE));
  return {
    warn: gaps > threshold && ageHours > EMBED_BACKLOG_MAX_AGE_HOURS,
    detail: `${gaps} of ${total} ${kind} have no vector; oldest waiting ${ageHours.toFixed(1)}h (warns above ${threshold} and ${EMBED_BACKLOG_MAX_AGE_HOURS}h)`,
  };
}
