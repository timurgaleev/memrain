/**
 * friction propose-fix — turn a friction logbook into improvement signal.
 *
 * Inputs:
 *   - One or more skill `.md` files (deploy/skills/<slug>.md by default).
 *   - Recent friction_events tagged with `extra.skill` matching the slug.
 *
 * Output:
 *   - For each skill: the current body, a sample of friction examples,
 *     a Claude-Haiku-suggested rewrite, and a one-paragraph rationale.
 *
 * The command is print-only — no `--apply` flag. A human reads the JSON,
 * decides if the suggestion is sensible, and runs `skillify --slug X
 * --out deploy/skills/X.md` (after deleting the old file) to land it.
 * Auto-apply for prompt-engineered text is a higher-trust feature; we'd
 * want a friction-on-friction safeguard before flipping that bit.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { Engine } from "./engine/interface.ts";
import { sanitizeForPrompt } from "./llm/sanitize.ts";
import { parseModelJson } from "./llm/json-output.ts";
import { awsRegion, bedrockClientConfig, chatTimeoutMs, generationFields, responseText, utilityTimeoutMs } from "./llm/gateway.ts";
import { trackedInvoke } from "./budget.ts";

/** Ledger label — the skill-rewrite suggestions behind `friction propose-fix`. */
const SPEND_OP = "friction-propose";

const DEFAULT_MODEL_ID =
  process.env.SKILLIFY_MODEL_ID ?? "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const DEFAULT_REGION = awsRegion();
const DEFAULT_SKILLS_DIR =
  process.env.SKILLIFY_SKILLS_DIR ?? "deploy/skills";

const MAX_OUTPUT_TOKENS = 2500;

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

export interface FrictionExample {
  capturedAt: string;
  kind: string;
  query: string | null;
  reason: string | null;
  sourcePath: string | null;
}

export interface SkillFrictionAggregate {
  skill: string;
  count: number;
  examples: FrictionExample[];
}

export interface FrictionProposeOptions {
  skillsDir?: string;
  /** Cap per-skill examples sent to the model. Default 8. */
  exampleLimit?: number;
  /** Window in hours. Default 168 (one week). */
  sinceHours?: number;
  /** Override Bedrock client (tests). */
  client?: BedrockRuntimeClient;
  /** Override model id. */
  modelId?: string;
}

export interface SkillProposal {
  skill: string;
  skillPath: string;
  currentText: string;
  frictionCount: number;
  examples: FrictionExample[];
  suggestion: string;
  rationale: string;
}

interface RawAggregateRow {
  skill: string;
  c: number;
}

interface RawExampleRow {
  captured_at: string | Date;
  kind: string;
  query: string | null;
  reason: string | null;
  source_path: string | null;
}

/**
 * Aggregate friction events by `extra->>'skill'`, ordered by count desc.
 * Skills without any friction in the window are NOT returned.
 */
export async function findTopFrictionSkills(
  engine: Engine,
  topN: number,
  opts: { sinceHours?: number; exampleLimit?: number } = {},
): Promise<SkillFrictionAggregate[]> {
  if (!Number.isInteger(topN) || topN < 1 || topN > 50) {
    throw new Error(
      `findTopFrictionSkills: topN must be 1-50 (got ${topN})`,
    );
  }
  const sinceHours = opts.sinceHours ?? 168;
  const exampleLimit = opts.exampleLimit ?? 8;

  const aggRows = await engine.query<RawAggregateRow>(
    `SELECT extra->>'skill' AS skill, COUNT(*)::int AS c
       FROM friction_events
      WHERE extra ? 'skill'
        AND captured_at > NOW() - ($1 || ' hours')::interval
      GROUP BY extra->>'skill'
      ORDER BY c DESC
      LIMIT $2`,
    [String(sinceHours), topN],
  );

  const out: SkillFrictionAggregate[] = [];
  for (const a of aggRows.rows) {
    const exRows = await engine.query<RawExampleRow>(
      `SELECT captured_at::text, kind, query, reason, source_path
         FROM friction_events
        WHERE extra->>'skill' = $1
          AND captured_at > NOW() - ($2 || ' hours')::interval
        ORDER BY captured_at DESC, id DESC
        LIMIT $3`,
      [a.skill, String(sinceHours), exampleLimit],
    );
    out.push({
      skill: a.skill,
      count: a.c,
      examples: exRows.rows.map((r) => ({
        capturedAt: typeof r.captured_at === "string"
          ? r.captured_at
          : r.captured_at.toISOString(),
        kind: r.kind,
        query: r.query,
        reason: r.reason,
        sourcePath: r.source_path,
      })),
    });
  }
  return out;
}

const SYSTEM_PROMPT = `You review memrain skill files against the agent's friction log.

You receive:
  1. The full markdown of one skill.
  2. Up to 8 recent "friction" events where the agent got stuck or
     answered wrongly while invoking that skill.

Output STRICTLY this JSON, no surrounding code fences, no commentary:

{
  "rationale": "<1-2 sentences linking the friction events to specific skill text — name the section / phrase that misled the agent>",
  "suggestion": "<the FULL revised skill markdown — preserve frontmatter exactly, only edit the body where the rationale demands it>"
}

Rules:
- Frontmatter (title, description, tags) MUST stay byte-identical.
- Don't invent commands or flags the original skill didn't reference.
- If the friction events don't cleanly trace to skill text, return rationale=
  "no actionable signal — friction looks systemic, not skill-text-related"
  and suggestion = the original markdown unchanged.`;

/**
 * Build a single proposal by calling Claude Haiku. Pure-ish: takes a stub
 * client when testing offline.
 */
export async function proposeForSkill(
  skill: string,
  skillPath: string,
  currentText: string,
  examples: FrictionExample[],
  count: number,
  opts: FrictionProposeOptions = {},
): Promise<SkillProposal> {
  const client = opts.client ?? getClient();
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID;
  // Skill text + friction queries/reasons are untrusted (search-miss content
  // can be attacker-influenced) — strip injection phrases before the LLM sees
  // them. The skill markdown the model rewrites stays structurally intact.
  const safeText = sanitizeForPrompt(currentText).text;
  const userPrompt =
    `Skill: ${skill}\n` +
    `Friction count (last window): ${count}\n\n` +
    `--- skill markdown ---\n${safeText}\n--- end skill ---\n\n` +
    `--- friction events (most recent first) ---\n` +
    examples
      .map(
        (e, i) =>
          `${i + 1}. [${e.kind}] query=${JSON.stringify(sanitizeForPrompt(String(e.query)).text)} reason=${JSON.stringify(sanitizeForPrompt(String(e.reason)).text)}`,
      )
      .join("\n") +
    `\n--- end events ---`;

  const command = new ConverseCommand({
    modelId,
    system: [{ text: SYSTEM_PROMPT }],
    messages: [{ role: "user", content: [{ text: userPrompt }] }],
    ...generationFields(modelId, MAX_OUTPUT_TOKENS, 0.2),
  });
  const text = await trackedInvoke(
    {
      operation: SPEND_OP,
      model: modelId,
      worstCase: { input: SYSTEM_PROMPT + userPrompt, maxOutputTokens: MAX_OUTPUT_TOKENS },
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
    throw new Error("proposeForSkill: empty response from model");
  }

  const value = parseModelJson(text, "{");
  if (typeof value !== "object" || value === null) {
    throw new Error("proposeForSkill: the model's reply held no JSON object");
  }
  const parsed = value as { rationale?: unknown; suggestion?: unknown };
  const rationale =
    typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
  const suggestion =
    typeof parsed.suggestion === "string" ? parsed.suggestion.trim() : "";
  if (!rationale || !suggestion) {
    throw new Error("proposeForSkill: model returned missing fields");
  }
  return {
    skill,
    skillPath,
    currentText,
    frictionCount: count,
    examples,
    suggestion,
    rationale,
  };
}

/**
 * High-level: load skills directory + aggregate + per-skill propose.
 * `targetSkill` runs against one slug; otherwise pick top-N by friction.
 */
export async function proposeFixes(
  engine: Engine,
  cfg:
    | { mode: "skill"; skill: string }
    | { mode: "top"; topSkills: number },
  opts: FrictionProposeOptions = {},
): Promise<SkillProposal[]> {
  const dir = resolve(opts.skillsDir ?? DEFAULT_SKILLS_DIR);
  if (!existsSync(dir)) {
    throw new Error(`proposeFixes: skills dir not found: ${dir}`);
  }
  const sinceHours = opts.sinceHours ?? 168;
  const exampleLimit = opts.exampleLimit ?? 8;

  let aggregates: SkillFrictionAggregate[];
  if (cfg.mode === "skill") {
    const exRows = await engine.query<RawExampleRow>(
      `SELECT captured_at::text, kind, query, reason, source_path
         FROM friction_events
        WHERE extra->>'skill' = $1
          AND captured_at > NOW() - ($2 || ' hours')::interval
        ORDER BY captured_at DESC, id DESC
        LIMIT $3`,
      [cfg.skill, String(sinceHours), exampleLimit],
    );
    aggregates = [
      {
        skill: cfg.skill,
        count: exRows.rows.length,
        examples: exRows.rows.map((r) => ({
          capturedAt: typeof r.captured_at === "string"
            ? r.captured_at
            : r.captured_at.toISOString(),
          kind: r.kind,
          query: r.query,
          reason: r.reason,
          sourcePath: r.source_path,
        })),
      },
    ];
  } else {
    aggregates = await findTopFrictionSkills(engine, cfg.topSkills, {
      sinceHours,
      exampleLimit,
    });
  }

  const skillFiles = new Set(
    readdirSync(dir).filter((f) => f.endsWith(".md")),
  );
  const proposals: SkillProposal[] = [];
  for (const a of aggregates) {
    const filename = `${a.skill}.md`;
    if (!skillFiles.has(filename)) {
      // Don't error — surface a stub proposal noting the missing file
      // so the report still shows the friction signal.
      proposals.push({
        skill: a.skill,
        skillPath: join(dir, filename),
        currentText: "",
        frictionCount: a.count,
        examples: a.examples,
        suggestion: "",
        rationale: `skill file ${filename} not found in ${dir}`,
      });
      continue;
    }
    const skillPath = join(dir, filename);
    const currentText = readFileSync(skillPath, "utf8");
    const proposal = await proposeForSkill(
      a.skill,
      skillPath,
      currentText,
      a.examples,
      a.count,
      opts,
    );
    proposals.push(proposal);
  }
  return proposals;
}
