# Connect GitHub Copilot

At the end, GitHub Copilot in VS Code can search your Memrain memory and write
to it. You need a running Memrain server, a shell on its host to run a few
`memrain` commands, and VS Code with GitHub Copilot.

Copilot reaches Memrain as a remote HTTP MCP server at `<issuer>/mcp`, where
`<issuer>` is your public origin, for example `https://brain.<domain>`. This
page uses a personal access token (PAT), which VS Code sends as a header.

`memrain …` below is the CLI on the host:
`docker exec deploy-memrain-1 bun run src/cli.ts …` in an SSM session.

These steps follow the VS Code MCP configuration reference
(<https://code.visualstudio.com/docs/copilot/reference/mcp-configuration>).
They have not been tested end to end with Memrain yet: treat the first
connection as a trial and run the check in [Verify](#verify) before saving
anything. If a key is rejected, check the current VS Code documentation.

## Prerequisites

- Memrain is deployed and `curl -s <issuer>/health` returns `{"ok":true,...}`.
- A source for Copilot, so its writes stay apart from your other pages:

  ```bash
  memrain sources register copilot --kind other --path-prefix agent:copilot
  ```

- On Copilot Business and Enterprise, an organization admin must allow MCP
  servers in the Copilot policy.

## Add the server

1. Mint a token. It is printed once.

   ```bash
   memrain auth create laptop-copilot --source copilot
   ```

2. Add the server to `.vscode/mcp.json` in your workspace, or to your user
   configuration with the `MCP: Open User Configuration` command:

   ```json
   {
     "inputs": [
       {
         "type": "promptString",
         "id": "memrain-token",
         "description": "Memrain personal access token",
         "password": true
       }
     ],
     "servers": {
       "memrain": {
         "type": "http",
         "url": "https://brain.<domain>/mcp",
         "headers": { "Authorization": "Bearer ${input:memrain-token}" }
       }
     }
   }
   ```

   VS Code asks for the token the first time the server starts and keeps it in
   its secret storage, so the token never lands in the file. Do not paste the
   token into `mcp.json` directly: a workspace file is easy to commit.

3. Start the server from the `MCP: List Servers` command, or from the Copilot
   Chat tools picker, and enter the token when asked.

## Verify

Ask Copilot to call the `whoami` tool: `write_source` should be `copilot` and
`read_sources` `["copilot"]`. Then ask it to `search` for a page you know
exists.

## Not covered here

- OAuth sign-in from VS Code. Use a PAT until this guide documents it.
- GitHub Copilot CLI, and Copilot coding agent or code review on GitHub.
- Importing Copilot chat history: connecting gives Copilot the memory tools,
  it does not import past chats.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `401` on every call | The token is wrong or revoked. Mint a new one and restart the server; if VS Code does not ask for the token again, clear the stored input as the VS Code docs describe. |
| Server not offered in Copilot Chat | MCP servers are off in the Copilot policy, or the server is stopped. Check `MCP: List Servers`. |
| Writes refused | The token has no write scope or no write source. Check `whoami`. |
