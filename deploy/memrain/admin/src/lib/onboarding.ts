// First-run guide content. The connection steps follow docs/clients in the
// repository (CLAUDE_CODE.md, CLAUDE_AI.md, CHATGPT.md); keep them in step.

import type { OnboardingStatus } from "../admin-types.ts";

export interface Snippets { claudeCode: string; claudeAi: string[]; chatgpt: string[] }

export const CLAUDE_AI_CALLBACKS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
] as const;

export const CHATGPT_CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";

export function buildSnippets(mcpUrl: string): Snippets {
  return {
    claudeCode: `claude mcp add --transport http --scope user memrain ${mcpUrl} \\\n  --header "Authorization: Bearer <PAT>"`,
    claudeAi: [
      `On the Agents page, register an OAuth client with the callback URLs ${CLAUDE_AI_CALLBACKS.join(" and ")}. Copy its client ID and secret; the secret is shown once.`,
      "In claude.ai open Customize → Connectors, click +, then Add custom connector.",
      `Name it and set the URL to ${mcpUrl}.`,
      "Open Advanced settings and fill in OAuth Client ID and OAuth Client Secret.",
      "Click Connect. The browser signs in to this brain and comes back.",
    ],
    chatgpt: [
      `On the Agents page, register an OAuth client with the callback URL ${CHATGPT_CALLBACK}. Copy its client ID and secret; the secret is shown once.`,
      "In ChatGPT open Settings → Security and login and turn on Developer mode.",
      `Create an app for a remote MCP server with the URL ${mcpUrl} and authentication OAuth, and enter the client ID and secret.`,
      "Connect. The browser signs in to this brain and comes back.",
      "If ChatGPT reports an unregistered redirect URI, add the exact URL it shows to the client on the Agents page.",
    ],
  };
}

export function checklistProgress(s: OnboardingStatus): { done: number; total: 4; complete: boolean } {
  const steps = [s.steps.credential.done, s.steps.agent_connected.done, s.steps.first_page.done, s.steps.first_search.done];
  const done = steps.filter(Boolean).length;
  return { done, total: 4, complete: done === 4 };
}
