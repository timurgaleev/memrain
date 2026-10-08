/**
 * Multi-turn Bedrock Converse with tools — the primitive the agent loop
 * (`core/agent/runner.ts`) drives. `callSonnet`/`callHaiku` send one user
 * message and read one text block; this sends a whole conversation plus a
 * `toolConfig`, and hands back the assistant message as Bedrock produced it
 * (text and toolUse blocks) with the stop reason the caller must act on.
 *
 * Every call goes through `trackedInvoke`, so it is booked in the spend ledger
 * under the caller's operation label, and under the per-process inflight cap.
 * The per-job dollar cap is the caller's business: it knows what the job has
 * already spent.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import { resolveModel } from "./resolve-model.ts";
import {
  awsRegion,
  bedrockClientConfig,
  chatTimeoutMs,
  generationFields,
  reasoningTimeoutMs,
  withInflightCap,
} from "./gateway.ts";
import { trackedInvoke, type ReportedUsage } from "../budget.ts";

/** A tool the model may call: name, description and a JSON-Schema input. */
export interface ConverseToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ConverseTurnInput {
  system: string;
  messages: Message[];
  tools: ConverseToolSpec[];
  maxTokens: number;
  /** Ledger label for the call — the feature the dollar is spent on. */
  operation: string;
  modelId?: string;
  region?: string;
  /** Transport seam: exercise the real request shape without a network. */
  client?: BedrockRuntimeClient;
}

export interface ConverseTurnResult {
  message: Message;
  /** Converse's stopReason: end_turn, tool_use, max_tokens, … */
  stopReason: string;
  usage: ReportedUsage;
  modelId: string;
}

/** Injectable seam — production wires `converseTurn`; tests script turns. */
export type ConverseFn = (input: ConverseTurnInput) => Promise<ConverseTurnResult>;

/** Stop reasons after which the loop must not continue. */
export const TERMINAL_STOP_REASONS: ReadonlySet<string> = new Set([
  "max_tokens",
  "guardrail_intervened",
  "content_filtered",
]);

const _clients = new Map<string, BedrockRuntimeClient>();
function client(region: string): BedrockRuntimeClient {
  let c = _clients.get(region);
  if (!c) {
    c = new BedrockRuntimeClient({ region, ...bedrockClientConfig(reasoningTimeoutMs()) });
    _clients.set(region, c);
  }
  return c;
}

function toBedrockTools(tools: ConverseToolSpec[]): Tool[] {
  return tools.map((t) => ({
    toolSpec: {
      name: t.name,
      description: t.description,
      // The SDK types `json` as a DocumentType; a JSON-Schema object is one.
      inputSchema: { json: t.inputSchema as never },
    },
  }));
}

/** One Converse round trip: the conversation so far in, the next assistant message out. */
export async function converseTurn(input: ConverseTurnInput): Promise<ConverseTurnResult> {
  const region = input.region ?? awsRegion();
  const modelId = resolveModel("reasoning", input.modelId);
  const c = input.client ?? client(region);
  const messages = repairToolPairing(input.messages);
  const tools = toBedrockTools(input.tools);
  return trackedInvoke(
    {
      operation: input.operation,
      model: modelId,
      worstCase: {
        input: JSON.stringify({ system: input.system, messages, tools }),
        maxOutputTokens: input.maxTokens,
      },
    },
    async (meter) => {
      const resp = await withInflightCap(() =>
        c.send(
          new ConverseCommand({
            modelId,
            system: [{ text: input.system }],
            messages,
            ...(tools.length > 0 ? { toolConfig: { tools } } : {}),
            ...generationFields(modelId, input.maxTokens, 0),
          }),
          { requestTimeout: chatTimeoutMs(reasoningTimeoutMs(), input.maxTokens) },
        ),
      );
      const usage: ReportedUsage = {
        inputTokens: resp.usage?.inputTokens ?? 0,
        outputTokens: resp.usage?.outputTokens ?? 0,
        ...(resp.usage?.cacheReadInputTokens
          ? { cacheReadInputTokens: resp.usage.cacheReadInputTokens }
          : {}),
        ...(resp.usage?.cacheWriteInputTokens
          ? { cacheWriteInputTokens: resp.usage.cacheWriteInputTokens }
          : {}),
      };
      meter.report(usage);
      const message: Message = resp.output?.message ?? { role: "assistant", content: [] };
      return { message, stopReason: resp.stopReason ?? "end_turn", usage, modelId };
    },
  );
}

/** Result text a toolUse gets when nothing answered it. */
export const UNANSWERED_TOOL_RESULT = "tool call was not answered; it did not run";

function toolUseIds(content: ContentBlock[] | undefined): string[] {
  const ids: string[] = [];
  for (const block of content ?? []) {
    const id = block.toolUse?.toolUseId;
    if (id) ids.push(id);
  }
  return ids;
}

function answeredIds(content: ContentBlock[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const block of content ?? []) {
    const id = block.toolResult?.toolUseId;
    if (id) ids.add(id);
  }
  return ids;
}

function syntheticResult(toolUseId: string): ContentBlock {
  return {
    toolResult: {
      toolUseId,
      content: [{ text: UNANSWERED_TOOL_RESULT }],
      status: "error",
    },
  };
}

/**
 * Converse rejects a conversation in which an assistant toolUse is not
 * answered by a toolResult in the very next user message. A conversation
 * rebuilt from a ledger an interrupted attempt left behind can end up that
 * way, so every unanswered toolUse gets a synthetic error result — the model
 * is told the call did not run rather than the request failing. Returns a new
 * array; the input is not modified.
 */
export function repairToolPairing(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    out.push(msg);
    if (msg.role !== "assistant") continue;
    const ids = toolUseIds(msg.content);
    if (ids.length === 0) continue;
    const next = messages[i + 1];
    if (next && next.role === "user") {
      const answered = answeredIds(next.content);
      const missing = ids.filter((id) => !answered.has(id));
      if (missing.length > 0) {
        out.push({
          ...next,
          content: [...missing.map(syntheticResult), ...(next.content ?? [])],
        });
        i++;
      }
      continue;
    }
    out.push({ role: "user", content: ids.map(syntheticResult) });
  }
  return out;
}
