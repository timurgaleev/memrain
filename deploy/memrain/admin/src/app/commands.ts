// Ready-to-paste setup for the clients a member connects with a key. No DOM.

export interface ClientSetup { client: string; where: string; text: string }

export function keySetups(mcpUrl: string, key: string): ClientSetup[] {
  return [
    {
      client: "Claude Code",
      where: "Run in a terminal",
      text: `claude mcp add --transport http --scope user memrain ${mcpUrl} --header "Authorization: Bearer ${key}"`,
    },
    {
      client: "Codex",
      where: "Add to ~/.codex/config.toml, then set the variable in the shell Codex starts from",
      text: `[mcp_servers.memrain]\nurl = "${mcpUrl}"\nbearer_token_env_var = "BRAIN_MCP_TOKEN"\n\n# shell:\nexport BRAIN_MCP_TOKEN=${key}`,
    },
    {
      client: "Cursor",
      where: "Add to ~/.cursor/mcp.json",
      text: JSON.stringify({ mcpServers: { memrain: { url: mcpUrl, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
    },
  ];
}
