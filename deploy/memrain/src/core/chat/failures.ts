/**
 * The closed vocabulary a chat client is told why a turn failed. The raw
 * provider or database message can name hosts, accounts or request ids, so it
 * goes to the server log; the client gets one of these codes.
 */
import { classifyBedrockError } from "../llm/bedrock-errors.ts";
import { isBudgetRefusal } from "../budget.ts";

export const CHAT_ERROR_CODES = [
  "timeout",
  "rate_limited",
  "network",
  "provider_error",
  "budget_exhausted",
  "chat_disabled",
  "invalid_params",
  "db_busy",
] as const;

export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number];

/** A turn refused before an answer exists; `message` is safe to show. */
export class ChatError extends Error {
  constructor(
    readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

/** Class a thrown model call into the closed vocabulary. */
export function classifyChatFailure(err: unknown): ChatErrorCode {
  if (isBudgetRefusal(err)) return "budget_exhausted";
  const cls = classifyBedrockError(err);
  if (cls === "throttle" || cls === "quota") return "rate_limited";
  if (cls === "timeout") return "timeout";
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/\b429\b|rate.?limit|overloaded/.test(msg)) return "rate_limited";
  if (/timeout|timed.?out|etimedout/.test(msg)) return "timeout";
  if (/econnrefused|econnreset|enotfound|eai_again|network|socket|fetch failed|dns/.test(msg)) return "network";
  return "provider_error";
}

/** What the client reads for each code. */
export function chatErrorMessage(code: ChatErrorCode): string {
  switch (code) {
    case "timeout": return "The model took too long to answer.";
    case "rate_limited": return "Too many requests right now. Wait a moment and ask again.";
    case "network": return "The model could not be reached.";
    case "provider_error": return "The model could not produce a usable answer.";
    case "budget_exhausted": return "The chat spending limit for today is reached. It resets at 00:00 UTC.";
    case "chat_disabled": return "Chat is turned off on this brain.";
    case "invalid_params": return "The request was not valid.";
    case "db_busy": return "The brain's database is busy. Try again.";
  }
}
