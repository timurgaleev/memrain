/**
 * Skillify — generate a fully-formed skill `*.md` from a one-line prompt.
 *
 * Two pieces:
 *
 *   1. `draftSkill` calls Bedrock Claude Haiku (Converse API) to produce a
 *      first-pass markdown body. The model is steered with a system prompt
 *      that demands the exact frontmatter contract used by `deploy/skills/`.
 *   2. `lintAndShape` is a deterministic post-processor that guarantees
 *      the pack contract (`name`, `description`, `triggers`, `tools`) holds
 *      even if the model drifts. It rewrites missing/malformed fields, drops
 *      tools that are not MCP operations, anchors the file to a stable slug,
 *      and emits a list of repairs. Its output passes `memrain skillpack lint`.
 *
 * The deterministic linter is what makes the command safe to use unattended.
 * If it had to retry-LLM-on-failure the loop could hide model regressions.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { awsRegion, bedrockClientConfig, chatTimeoutMs, generationFields, responseText, utilityTimeoutMs } from "./llm/gateway.ts";
import { trackedInvoke } from "./budget.ts";
import { OPERATIONS } from "../mcp/operations.ts";
import { parseSkillFrontmatter } from "./skillpack/frontmatter.ts";

/** Ledger label — the one-shot skill drafter behind `memrain skillify`. */
const SPEND_OP = "skillify";

const DEFAULT_MODEL_ID =
  process.env.SKILLIFY_MODEL_ID ?? "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const DEFAULT_REGION = awsRegion();

const MAX_OUTPUT_TOKENS = 1500;

let _defaultClient: BedrockRuntimeClient | null = null;
function getClient(): BedrockRuntimeClient {
  if (_defaultClient === null) {
    _defaultClient = new BedrockRuntimeClient({
      region: DEFAULT_REGION,
      ...bedrockClientConfig(utilityTimeoutMs()),
    });
  }
  return _defaultClient;
}

export interface SkillifyOptions {
  /** Override the Bedrock client (tests pass a stub). */
  client?: BedrockRuntimeClient;
  /** Override the model id; default is Claude Haiku (Bedrock). */
  modelId?: string;
}

export interface SkillDraft {
  /** Final markdown ready to write. */
  markdown: string;
  /** Kebab-case slug, also the file's basename without `.md`. */
  slug: string;
  /** Descriptive issues the linter fixed (empty on a clean pass). */
  issues: string[];
}

/**
 * Convert a free-text prompt into a kebab-case slug.
 *   "Skill that summarises my last 5 workouts!" → "skill-that-summarises-my-last-5-workouts"
 * Caps at 60 chars to keep filenames sane.
 */
export function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    // Measured linear through slugify: 2.0 ms at 2 M chars of `-` plus a
    // rejecting `x`, ratio 2.10 on a doubling. `-` is itself in `[^a-z0-9]`, so
    // the collapse on the line above leaves every hyphen run exactly one char
    // long — the run this quantifier needs to square on cannot reach it.
    // eslint-disable-next-line regexp/no-super-linear-move
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) return "skill";
  // Measured linear through slugify: 12.0 ms at 2 M chars of `a-`, ratio 1.89
  // on a doubling. Same collapse, and the 60-char slice caps it a second time.
  // eslint-disable-next-line regexp/no-super-linear-move
  return cleaned.slice(0, 60).replace(/-+$/g, "") || "skill";
}

/** System prompt — the contract the model must satisfy. */
const SYSTEM_PROMPT = `You write memrain skill files.

OUTPUT FORMAT — strictly markdown, NO surrounding code fences, NO commentary:

---
name: <kebab-case slug, lowercase, hyphens only>
description: <one sentence, present tense, when-to-use>
triggers:
  - "<a phrase a user would say that should route to this skill>"
  - "<another such phrase>"
tools:
  - <an MCP tool the skill calls, only if it calls one>
---

# <Skill Name> — <punchy subtitle>

<2–3 sentences: what this skill does, when to invoke it.>

## When to use

- <bullet 1>
- <bullet 2>
- <bullet 3>

## How

\`\`\`bash
<concrete shell example using /opt/memrain/bin/memrain or similar>
\`\`\`

<short paragraph explaining the call.>

## Edge cases

- <what to do when input is empty / ambiguous>
- <what to do when the call fails>

RULES:
- description must be a single line, ≤ 160 chars.
- 2–4 triggers, each a short quoted phrase.
- Omit tools entirely when the skill calls no MCP tool.
- Use \`/opt/memrain/bin/memrain\` as the canonical CLI path.
- Do not invent flags or commands the user didn't mention.`;

/**
 * Build a draft skill markdown from a user prompt. Returns the raw model
 * output — `lintAndShape` is what guarantees shape compliance.
 */
export async function draftSkill(
  userPrompt: string,
  opts: SkillifyOptions = {},
): Promise<string> {
  if (!userPrompt || !userPrompt.trim()) {
    throw new Error("draftSkill: prompt must be a non-empty string");
  }
  const client = opts.client ?? getClient();
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID;

  const command = new ConverseCommand({
    modelId,
    system: [{ text: SYSTEM_PROMPT }],
    messages: [
      {
        role: "user",
        content: [
          {
            text: `Generate a skill for this request:\n\n${userPrompt.trim()}`,
          },
        ],
      },
    ],
    ...generationFields(modelId, MAX_OUTPUT_TOKENS, 0.3),
  });

  const text = await trackedInvoke(
    {
      operation: SPEND_OP,
      model: modelId,
      worstCase: {
        input: `${SYSTEM_PROMPT}Generate a skill for this request:\n\n${userPrompt}`,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    },
    async (meter) => {
    const response = await client.send(command, {
      requestTimeout: chatTimeoutMs(utilityTimeoutMs(), MAX_OUTPUT_TOKENS),
    });
    if (response.usage) {
      meter.report({
        inputTokens: response.usage.inputTokens ?? 0,
        outputTokens: response.usage.outputTokens ?? 0,
      });
    }
    return responseText(response.output?.message?.content);
  });
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("draftSkill: empty response from model");
  }
  return text.trim();
}

const MAX_DESCRIPTION = 160;

/**
 * Make a trigger safe to emit as a quoted YAML list item. The shared parser
 * strips only the surrounding quotes, so an inner `"` or a newline would
 * corrupt the entry rather than be escaped.
 */
function cleanTrigger(raw: string): string {
  const flat = raw.replace(/["\n\r]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > MAX_DESCRIPTION ? flat.slice(0, MAX_DESCRIPTION).trimEnd() : flat;
}

/**
 * Take a (possibly drifted) draft and return a skill markdown that holds the
 * pack contract, so a drafted skill committed to `deploy/skills` passes the
 * same `memrain skillpack lint` the shipped pack does. Always succeeds; reports
 * what it had to repair via `issues`.
 */
export function lintAndShape(
  draft: string,
  slug: string,
  fallbackPrompt: string,
): { markdown: string; issues: string[] } {
  const issues: string[] = [];
  const fm = parseSkillFrontmatter(draft);

  let description = "";
  let triggers: string[] = [];
  let tools: string[] = [];
  let body = "";

  if (!fm) {
    issues.push("frontmatter-missing");
    body = draft;
    description = fallbackDescription(fallbackPrompt);
  } else {
    body = fm.body.trim();
    // A legacy `title` is the name a drifted model most often writes.
    const fmName = fm.name ?? fm.scalars["title"] ?? null;
    if (fmName !== null && fmName !== slug) issues.push("name-mismatch-corrected");

    description = (fm.description ?? "").replace(/\s+/g, " ").trim();
    if (description.length === 0) {
      issues.push("description-missing");
      description = fallbackDescription(fallbackPrompt);
    } else if (description.length > MAX_DESCRIPTION) {
      issues.push("description-truncated");
      description = description.slice(0, MAX_DESCRIPTION - 1).trimEnd() + "…";
    }

    triggers = [...new Set(fm.triggers.map(cleanTrigger).filter((t) => t.length > 0))];

    const opNames = new Set(OPERATIONS.map((o) => o.name));
    tools = [...new Set(fm.tools)].filter((t) => opNames.has(t));
    if (tools.length < new Set(fm.tools).size) issues.push("tools-unknown-dropped");
  }

  if (triggers.length === 0) {
    if (fm) issues.push("triggers-fallback");
    triggers = [cleanTrigger(fallbackDescription(fallbackPrompt))];
  }

  if (!body || body.length < 30) {
    issues.push("body-too-short");
    body = bodyScaffold(slug, fallbackPrompt);
  } else if (!/^#\s+\S/.test(body)) {
    issues.push("body-missing-heading");
    body = `# ${slug}\n\n${body}`;
  }

  const lines = [
    "---",
    `name: ${slug}`,
    `description: ${description}`,
    "triggers:",
    ...triggers.map((t) => `  - "${t}"`),
  ];
  if (tools.length > 0) lines.push("tools:", ...tools.map((t) => `  - ${t}`));
  lines.push("---", "", "");

  return { markdown: lines.join("\n") + body.trim() + "\n", issues };
}

export interface SkillValidationIssue {
  rule: string;
  severity: "error" | "warning";
  message: string;
}

export interface SkillValidationReport {
  ok: boolean;
  slug: string;
  issues: SkillValidationIssue[];
}

/**
 * Pure validator for an existing skill markdown. No LLM, no rewrite —
 * the inverse of `lintAndShape`. Returns errors (contract violations)
 * and warnings (advisory). `--strict` mode in the CLI flips warnings
 * into a non-zero exit too; the function itself stays neutral.
 *
 * Reads the pack contract through the shared skill frontmatter parser:
 * `name` (legacy `title` accepted), `description`, `triggers` (legacy
 * `tags` accepted) and `tools`.
 *
 * Rules:
 *   error  | frontmatter-missing       — leading `---` block absent
 *   error  | name-missing              — neither name nor title set
 *   error  | name-mismatch             — name ≠ <slug>
 *   error  | description-missing       — frontmatter.description empty
 *   warning| description-too-long      — description > 160 chars
 *   error  | triggers-missing          — neither triggers nor tags set
 *   warning| tags-non-canonical        — legacy tags with mixed case / spaces
 *   warning| tools-unknown             — a `tools:` entry is not an MCP operation
 *   warning| body-missing-heading      — first body line is not `# …`
 *   warning| body-too-short            — body shorter than 30 chars
 */
export function validateSkill(
  markdown: string,
  slug: string,
): SkillValidationReport {
  const issues: SkillValidationIssue[] = [];
  const fm = parseSkillFrontmatter(markdown);
  if (!fm) {
    issues.push({
      rule: "frontmatter-missing",
      severity: "error",
      message: "skill markdown must start with a `---` frontmatter block",
    });
    return { ok: false, slug, issues };
  }

  const name = fm.name ?? fm.scalars["title"] ?? "";
  if (!name) {
    issues.push({
      rule: "name-missing",
      severity: "error",
      message: "frontmatter.name is required",
    });
  } else if (name !== slug) {
    issues.push({
      rule: "name-mismatch",
      severity: "error",
      message: `frontmatter.name='${name}' does not match expected slug='${slug}'`,
    });
  }

  const desc = (fm.description ?? "").trim();
  if (desc.length === 0) {
    issues.push({
      rule: "description-missing",
      severity: "error",
      message: "frontmatter.description is required",
    });
  } else if (desc.length > MAX_DESCRIPTION) {
    issues.push({
      rule: "description-too-long",
      severity: "warning",
      message: `frontmatter.description is ${desc.length} chars (max ${MAX_DESCRIPTION})`,
    });
  }

  const legacyTags = fm.lists["tags"] ?? [];
  if (fm.triggers.length === 0 && legacyTags.length === 0) {
    issues.push({
      rule: "triggers-missing",
      severity: "error",
      message: "frontmatter.triggers is required (the phrases that route to this skill)",
    });
  } else if (fm.triggers.length === 0) {
    const normalised = legacyTags
      .map((t) => t.toLowerCase())
      .filter((t) => /^[a-z0-9][a-z0-9-]*$/.test(t));
    if (legacyTags.some((t, i) => normalised[i] !== t)) {
      issues.push({
        rule: "tags-non-canonical",
        severity: "warning",
        message: `tags contain non-canonical tokens (lowercase, [a-z0-9-]+): ${legacyTags.join(", ")}`,
      });
    }
  }

  const opNames = new Set(OPERATIONS.map((o) => o.name));
  for (const tool of fm.tools) {
    if (opNames.has(tool)) continue;
    issues.push({
      rule: "tools-unknown",
      severity: "warning",
      message: `tools lists '${tool}', which is not an MCP operation`,
    });
  }

  const body = fm.body.trim();
  if (body.length < 30) {
    issues.push({
      rule: "body-too-short",
      severity: "warning",
      message: `body is ${body.length} chars (minimum 30)`,
    });
  } else if (!/^#\s+\S/.test(body)) {
    issues.push({
      rule: "body-missing-heading",
      severity: "warning",
      message: "body should start with a `# Heading` line",
    });
  }

  const ok = !issues.some((i) => i.severity === "error");
  return { ok, slug, issues };
}

function fallbackDescription(prompt: string): string {
  const trimmed = prompt.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return "TODO: describe when to use this skill";
  return trimmed.length > MAX_DESCRIPTION
    ? trimmed.slice(0, MAX_DESCRIPTION - 1) + "…"
    : trimmed;
}

function bodyScaffold(slug: string, prompt: string): string {
  return `# ${slug}

TODO: ${prompt}

## When to use

- TODO: describe the trigger
- TODO: describe a second trigger

## How

\`\`\`bash
/opt/memrain/bin/memrain --help
\`\`\`

TODO: replace with the real call.

## Edge cases

- TODO: empty / missing input
- TODO: external call fails`;
}

/**
 * End-to-end: prompt → drafted markdown → linted markdown.
 * `prompt` is the user's free-text request; `slug` defaults to a
 * slugified prompt but can be overridden.
 */
export async function skillify(
  prompt: string,
  opts: SkillifyOptions & { slug?: string } = {},
): Promise<SkillDraft> {
  const slug = opts.slug ?? slugify(prompt);
  const draft = await draftSkill(prompt, opts);
  const { markdown, issues } = lintAndShape(draft, slug, prompt);
  return { markdown, slug, issues };
}
