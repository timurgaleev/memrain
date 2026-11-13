/**
 * Answer and judge prompts for the LongMemEval harness. Any edit here changes
 * PROMPT_HASH, and a ledger written under one hash refuses to resume under
 * another: scores from different prompts must not be mixed.
 */
import { createHash } from "node:crypto";
import type { LmeQuestion } from "./dataset.ts";

export const ANSWER_SYSTEM =
  "You answer a question about the user's own earlier conversations with an assistant. " +
  "Use only the retrieved excerpts you are given; each one is headed by the date of its conversation. " +
  "Work out dates relative to the current date stated with the question. " +
  "When the excerpts do not hold the answer, say that you do not know. " +
  "Answer in at most two sentences.";

export const JUDGE_SYSTEM =
  "You grade a response to a question against the correct answer. Reply with one word: yes or no.";

export interface AnswerExcerpt {
  date: string;
  text: string;
}

export function answerPrompt(question: LmeQuestion, excerpts: readonly AnswerExcerpt[]): string {
  const body = excerpts.length === 0
    ? "(no excerpt was retrieved)"
    : excerpts.map((e) => `<excerpt date="${e.date}">\n${e.text}\n</excerpt>`).join("\n");
  return `Retrieved excerpts, most relevant first:\n${body}\n\n` +
    `Current date: ${question.question_date}\nQuestion: ${question.question}\nAnswer:`;
}

/** Abstention questions are the ones whose id carries the dataset's `_abs` suffix. */
export function isAbstention(question: LmeQuestion): boolean {
  return question.question_id.endsWith("_abs");
}

const RULES: Record<string, string> = {
  default:
    "Answer yes when the response gives the correct answer, even with extra detail or reasoning. " +
    "Answer no when it gives a different answer or only part of what is required.",
  "temporal-reasoning":
    "Answer yes when the response gives the correct answer, even with extra detail or reasoning; " +
    "a count of days, weeks or months that is off by one still counts as correct. " +
    "Answer no when it gives a different answer or only part of what is required.",
  "knowledge-update":
    "Answer yes when the response gives the correct, most recent answer, even if it also mentions " +
    "older information. Answer no when it gives only outdated or different information.",
  "single-session-preference":
    "The correct answer describes what a good, personalised response looks like. Answer yes when " +
    "the response is consistent with that description; it need not cover every point.",
  abstention:
    "The question cannot be answered from the conversations; the correct answer explains why. " +
    "Answer yes when the response says it does not know or that the information is not available.",
};

export function judgePrompt(question: LmeQuestion, response: string): string {
  const rule = isAbstention(question) ? RULES.abstention : RULES[question.question_type] ?? RULES.default;
  // The verdict parser reads single lines, so collapse newlines inside fields.
  const flat = (s: string) => s.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" ");
  return `Question: ${flat(question.question)}\nCorrect answer: ${flat(question.answer)}\n` +
    `Response: ${flat(response)}\n\n${rule}`;
}

/** true for a leading "yes", false for a leading "no", null for anything else. */
export function parseJudgeVerdict(text: string): boolean | null {
  const first = text.trim().toLowerCase().match(/^[a-z]+/)?.[0];
  if (first === "yes") return true;
  if (first === "no") return false;
  return null;
}

// The templates are hashed by rendering a fixed probe question through them,
// so the hash follows what the models are sent, not how the code is written.
const PROBE: LmeQuestion = {
  question_id: "probe", question_type: "probe", question: "Q?", answer: "A", question_date: "D",
  sessions: [], answer_session_ids: [],
};

export const PROMPT_HASH = createHash("sha256")
  .update(JSON.stringify({
    ANSWER_SYSTEM,
    JUDGE_SYSTEM,
    RULES,
    answer: [answerPrompt(PROBE, []), answerPrompt(PROBE, [{ date: "D", text: "T" }])],
    judge: judgePrompt(PROBE, "R\nS"),
  }))
  .digest("hex");
