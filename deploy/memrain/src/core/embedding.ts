/**
 * Bedrock Titan v2 embedding client.
 *
 * Uses amazon.titan-embed-text-v2:0 from AWS Bedrock to produce 1024-dim
 * normalized vectors. Auth is via the EC2 IAM role (per CLAUDE.md
 * feedback_bedrock_auth: AWS_PROFILE=default + ~/.aws/config with
 * credential_source = Ec2InstanceMetadata; the AWS SDK picks this up).
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { awsRegion, bedrockClientConfig, embedTimeoutMs } from "./llm/gateway.ts";
import { trackedInvoke } from "./budget.ts";

/** Ledger label for the embedding tier. Every stored vector's dollar lands
 *  under this one operation. */
const SPEND_OP = "embedding";

/** Canonical Titan v2 model id — the default for `embedText` and the model
 *  recorded by the embedding backfill, so the two never drift apart. */
export const DEFAULT_MODEL_ID = "amazon.titan-embed-text-v2:0";

/** Width of the stored `vector(N)` column in every embeddings table — a fixed
 *  literal in the schema (migrations/001_initial.sql plus 038/063/065), NOT
 *  templated from config. Titan v2 can emit 256/512/1024, but only 1024 fits
 *  this column, so any other width would boot fine and then fail on the first
 *  DB insert. A provider/model swap to a different width edits THIS constant,
 *  `DEFAULT_MODEL_ID`, and the `vector(...)` column migrations together. */
const STORED_VECTOR_DIM = 1024;

/** The width used when `MEMRAIN_EMBED_DIM` is unset — the stored column width. */
const FALLBACK_DIMENSIONS = STORED_VECTOR_DIM;

/** Resolve the embedding width from `MEMRAIN_EMBED_DIM` (fail-loud) or the
 *  stored-column default. Validated once at module load so a bad env fails the
 *  process, not a silent wrong-width vector deep in the index path. For the
 *  default model the width MUST match the fixed `vector(N)` column; a future
 *  embedder passed explicitly is left to its own coordinated schema swap. */
export function resolveEmbedDimensions(
  raw: string | undefined = process.env.MEMRAIN_EMBED_DIM,
  modelId: string = DEFAULT_MODEL_ID,
): number {
  if (raw === undefined || raw.trim() === "") return FALLBACK_DIMENSIONS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `MEMRAIN_EMBED_DIM must be a positive integer, got: ${JSON.stringify(raw)}`,
    );
  }
  if (modelId === DEFAULT_MODEL_ID && n !== STORED_VECTOR_DIM) {
    throw new Error(
      `MEMRAIN_EMBED_DIM=${n} does not match the stored vector(${STORED_VECTOR_DIM}) ` +
        `column (migrations/001_initial.sql) — a different width needs a schema ` +
        `migration widening the embeddings vector columns first, else every insert fails.`,
    );
  }
  return n;
}

export const EMBED_DIMENSIONS = resolveEmbedDimensions();
const DEFAULT_REGION = awsRegion();

/** Provider tag folded into the embedding signature. Titan is served through
 *  Bedrock; a future provider swap changes this AND the model id together. */
const EMBED_PROVIDER = "bedrock";

/**
 * Provenance signature for a stored embedding: `provider:model:dims`. Stamped
 * on each `embeddings` row at write time (migration 066) so a model or
 * dimension swap is self-describing. The stale/backfill loop compares a row's
 * stored signature to the current one and re-embeds only rows whose signature
 * actually differs — a NULL (legacy, pre-signature) row is left untouched, so
 * turning this on never forces a full re-embed of the existing corpus.
 */
export function embeddingSignature(
  modelId: string = DEFAULT_MODEL_ID,
  dims: number = EMBED_DIMENSIONS,
): string {
  return `${EMBED_PROVIDER}:${modelId}:${dims}`;
}

let _defaultClient: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient {
  if (_defaultClient === null) {
    // Standard retry, not adaptive: this one client serves the bulk backfill and
    // the live search's query embed alike, and adaptive mode's client-side rate
    // limiter would let a throttled backfill slow down interactive search.
    _defaultClient = new BedrockRuntimeClient({
      region: DEFAULT_REGION,
      ...bedrockClientConfig(embedTimeoutMs()),
      retryMode: "standard",
    });
  }
  return _defaultClient;
}

export interface EmbedOptions {
  client?: BedrockRuntimeClient;
  modelId?: string;
  /**
   * Optional abort signal threaded into the Bedrock `send()` call so a caller
   * with a deadline (e.g. the bounded query-embed in search) can cancel the
   * in-flight request instead of leaking it past the budget.
   */
  abortSignal?: AbortSignal;
  /**
   * Per-attempt timeout for this call, overriding the client's. The search path
   * sets it to a fraction of its own budget so a hung attempt ends in time for
   * the SDK to retry inside that budget.
   */
  requestTimeoutMs?: number;
  /** Receives the input tokens Titan billed, as soon as the response reports them. */
  onUsage?: (usage: { inputTokens: number }) => void;
}

interface TitanResponseV2 {
  embedding: number[];
  inputTextTokenCount?: number;
}

/**
 * Embed a single text string, returning a 1024-dim float vector.
 * Throws on empty input or malformed/wrong-dimension response.
 */
export async function embedText(
  text: string,
  opts: EmbedOptions = {},
): Promise<number[]> {
  if (!text || !text.trim()) {
    throw new Error("embedText: input must be a non-empty string");
  }
  const client = opts.client ?? getClient();
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID;

  const command = new InvokeModelCommand({
    modelId,
    body: JSON.stringify({
      inputText: text,
      dimensions: EMBED_DIMENSIONS,
      normalize: true,
    }),
    contentType: "application/json",
    accept: "application/json",
  });

  return trackedInvoke(
    { operation: SPEND_OP, model: modelId, worstCase: { input: text, maxOutputTokens: 0 } },
    async (meter) => {
    const response = await client.send(command, {
      abortSignal: opts.abortSignal,
      ...(opts.requestTimeoutMs ? { requestTimeout: opts.requestTimeoutMs } : {}),
    });
    if (!response.body) {
      throw new Error("embedText: empty response body from Bedrock");
    }
    const decoded = new TextDecoder().decode(response.body);
    const parsed = JSON.parse(decoded) as TitanResponseV2;
    // Report BEFORE the shape checks below: Titan billed those input tokens
    // whether or not the vector it sent back is one we can store.
    meter.report({ inputTokens: parsed.inputTextTokenCount ?? 0, outputTokens: 0 });
    opts.onUsage?.({ inputTokens: parsed.inputTextTokenCount ?? 0 });
    if (!Array.isArray(parsed.embedding)) {
      throw new TypeError("embedText: response missing 'embedding' array");
    }
    if (parsed.embedding.length !== EMBED_DIMENSIONS) {
      throw new Error(
        `embedText: expected ${EMBED_DIMENSIONS}-dim vector, got ${parsed.embedding.length}`,
      );
    }
    return parsed.embedding;
  });
}
