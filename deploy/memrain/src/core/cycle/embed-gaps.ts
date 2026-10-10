/**
 * embed-gaps — give vectors to chunks that were written without one.
 *
 * A write keeps its text when embedding fails for a reason that passes (a spent
 * budget, a throttle, a Bedrock outage): the chunk lands keyword-searchable
 * with no `embeddings` row. embed-stale only re-embeds rows that already have a
 * vector, and the page-mirror reconcile skips a page whose hash still matches,
 * so without this phase those chunks would stay out of semantic search for good.
 *
 * Paid (one Titan call per chunk), so it is bounded: at most
 * `MEMRAIN_EMBED_GAPS_MAX_PER_CYCLE` chunks per tick (default 200), and
 * `MEMRAIN_EMBED_GAPS=0` turns it off. It runs inside the cycle's phase spend
 * tag, so the cycle daily cap covers it, and in the batch scope, so a failure
 * that would repeat stops it at the first chunk.
 */
import type { Engine } from "../engine/interface.ts";
import { runEmbedBackfill, type EmbedBackfillOptions } from "../embed-backfill.ts";
import { phaseCheckpoint } from "./phase-context.ts";

export const DEFAULT_EMBED_GAPS_MAX_PER_CYCLE = 200;
/** Chunks per backfill call: the phase looks for a stop between calls. */
const STEP = 50;
/** Calls in flight: kept low so the fill never crowds out interactive embeds. */
const CONCURRENCY = 2;

export interface EmbedGapsOptions {
  maxPerCycle?: number;
  /** Test seam; production embeds with Titan. */
  embed?: EmbedBackfillOptions["embed"];
}

export interface EmbedGapsResult {
  ran: boolean;
  reason?: string;
  /** Gap chunks looked at this tick. */
  scanned: number;
  embedded: number;
  /** Embed calls that failed; their chunks stay gaps for the next tick. */
  failed: number;
}

export function embedGapsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MEMRAIN_EMBED_GAPS !== "0";
}

/** Positive integer from the env, else the default. */
export function embedGapsMaxPerCycle(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MEMRAIN_EMBED_GAPS_MAX_PER_CYCLE;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_EMBED_GAPS_MAX_PER_CYCLE;
}

export async function embedGapsPhase(
  engine: Engine,
  opts: EmbedGapsOptions = {},
): Promise<EmbedGapsResult> {
  if (!embedGapsEnabled()) {
    return { ran: false, reason: "MEMRAIN_EMBED_GAPS=0", scanned: 0, embedded: 0, failed: 0 };
  }
  const max = opts.maxPerCycle ?? embedGapsMaxPerCycle();
  const result: EmbedGapsResult = { ran: true, scanned: 0, embedded: 0, failed: 0 };
  let cursor: string | undefined;
  while (result.scanned < max) {
    phaseCheckpoint();
    const r = await runEmbedBackfill(engine, {
      limit: Math.min(STEP, max - result.scanned),
      concurrency: CONCURRENCY,
      // Filling gaps only: a model swap's re-embed stays a deliberate operator run.
      reembedOnSignatureChange: false,
      ...(cursor !== undefined ? { startAfterId: cursor } : {}),
      ...(opts.embed ? { embed: opts.embed } : {}),
    });
    result.scanned += r.candidates;
    result.embedded += r.embedded;
    result.failed += r.failed;
    if (r.lastId === null || r.candidates === 0) break;
    // A step where every call failed means Bedrock is not answering: the rest
    // would only wait out the same failure, so they wait for the next tick.
    if (r.embedded === 0 && r.failed > 0) break;
    cursor = r.lastId;
  }
  return result;
}
