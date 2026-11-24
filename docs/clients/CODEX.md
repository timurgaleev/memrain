# Connect Codex

At the end, the Codex CLI can search your Memrain memory and write to it. You
need a running Memrain server, a shell on its host to run a few `memrain`
commands, and the Codex CLI installed.

The Codex CLI reaches Memrain as a streamable HTTP MCP server at `<issuer>/mcp`,
where `<issuer>` is your public origin, for example `https://brain.<domain>`.
It can authenticate with:

- **a personal access token (PAT)** read from an environment variable — the
  simplest;
- **OAuth** through `codex mcp login`, with a public client you register for
  Codex and approve with your passkey.

A connector set up before the rename to Memrain keeps working: the URL is
unchanged and so are its credentials. Renaming its display name is optional.

`memrain …` below is the CLI on the host:
`docker exec deploy-memrain-1 bun run src/cli.ts …` in an SSM session.

Codex keys and flags on this page were checked against the Codex MCP
documentation on 2026-09-28. Codex changes quickly; if a key is rejected,
check `codex mcp --help` and the current docs.

## Prerequisites

- Memrain is deployed and `curl -s <issuer>/health` returns `{"ok":true,...}`.
- A source for Codex, so its writes stay apart from your other pages (Option B
  needs one; a PAT without `--source` writes to `default`):

  ```bash
  memrain sources register codex --kind other --path-prefix agent:codex
  ```

## Option A: personal access token

1. Mint a token. It is printed once.

   ```bash
   memrain auth create laptop-codex --source codex
   ```

2. Add the server to `~/.codex/config.toml`:

   ```toml
   [mcp_servers.memrain]
   url = "https://brain.<domain>/mcp"
   bearer_token_env_var = "BRAIN_MCP_TOKEN"
   ```

   Codex sends the variable's value as `Authorization: Bearer …`. The Codex
   docs offer no key for an inline token value; keep the token in the
   environment. (`http_headers` sets static headers and `env_http_headers` maps
   a header to an environment variable, if you need either.)

3. Export the token where Codex runs, for example from your shell profile or a
   secrets manager:

   ```bash
   export BRAIN_MCP_TOKEN='<PAT>'
   ```

## Option B: OAuth with `codex mcp login`

Codex does not document a way to hand it a client secret, so it signs in as a
**public** client (PKCE, no secret). That works while owner approval is on (the
default): `/authorize` sends the browser to `/admin/login`, you sign in with
your passkey and approve. With `MEMRAIN_OAUTH_REQUIRE_LOGIN=0`, `/authorize`
auto-approves and Memrain refuses a public client, because its `client_id`
alone would then mint tokens.

1. Register the client with a loopback callback. Codex listens on
   `http://127.0.0.1/callback` (plus a callback id and a free port) unless
   `mcp_oauth_callback_url` is set; the exact path is printed in step 3, so start
   with the base form:

   ```bash
   memrain auth register-client laptop-codex \
     --token-endpoint-auth-method none \
     --scopes 'read write' --source codex \
     --redirect-uris 'http://127.0.0.1/callback'
   ```

   It prints the `client_id`; no secret is minted.

2. Add the server with that client id:

   ```bash
   codex mcp add memrain --url https://brain.<domain>/mcp --oauth-client-id <client_id>
   ```

3. Sign in:

   ```bash
   codex mcp login memrain
   ```

   Codex prints the callback URL it will use. Memrain matches a registered
   loopback URI on **any port** (RFC 8252), but scheme, host and path must be
   identical. If the printed path is not `/callback`, register it (the port does
   not matter) without rotating anything:

   ```bash
   memrain auth set-redirect-uris <client_id> 'http://127.0.0.1/callback/<id-codex-printed>'
   ```

   Then run `codex mcp login memrain` again. Sign in to the panel with your
   passkey and approve the client. `mcp_oauth_callback_port` in `config.toml`
   pins the port if a firewall needs it.

## Option C: install the plugin

The repository is also a Codex plugin marketplace. Its one plugin lives in
`plugins/memrain`, so an install copies only that folder: the `memrain` MCP
server plus three skills: `connect-client` for setup, `query` for lookups
with citations, and `ingest` for saving content as linked pages.

```bash
codex plugin marketplace add <your-github-username>/memrain
codex plugin add memrain@memrain
export BRAIN_MCP_TOKEN='<PAT>'
```

The plugin's server points at the local quickstart, `http://127.0.0.1:18790/mcp`
(`make local-up`), and reads the token from `BRAIN_MCP_TOKEN`. For a deployed
server, override the URL in `~/.codex/config.toml` under the same name:

```toml
[mcp_servers.memrain]
url = "https://brain.<domain>/mcp"
bearer_token_env_var = "BRAIN_MCP_TOKEN"
```

Codex uses your entry in place of the plugin's and keeps the plugin's skills.

## Verify

Ask Codex to call the `whoami` tool: `write_source` should be `codex` and
`read_sources` `["codex"]`.

For a PAT, run the end-to-end check from a checkout (under `deploy/memrain`), with
the token in a 0600 file holding `{"token": "<PAT>"}`:

```bash
bun run src/cli.ts auth doctor https://brain.<domain> \
  --token-file ~/.config/memrain/laptop-codex.json --expect-source codex
```

## Make the agent use it

Add this block to your `~/.codex/AGENTS.md` or the project `AGENTS.md`. Keep one copy and update the text between the
markers when changing the policy:

```markdown
<!-- memrain:begin -->
Before answering about past work, people, projects, or decisions, call
Memrain search. Search before writing, so you update an existing page instead
of creating a duplicate. Treat recalled content as evidence,
check its date and source, and verify current state before claiming completion.
A search hit is not proof of identity; resolve the exact person before writing.
<!-- memrain:end -->
```

For an optional reminder on every prompt, merge this into `~/.codex/hooks.json`. It only
prints fixed text; it does not start Bun or read the working directory:

```json
{
  "hooks": {
    "UserPromptSubmit": [{
      "hooks": [{
        "type": "command",
        "command": "printf '%s\n' 'Use Memrain search for past work before answering.'"
      }]
    }]
  }
}
```

Review and trust the hook in Codex `/hooks`; new or changed hooks stay inactive until trusted. See [official hook documentation](https://learn.chatgpt.com/docs/hooks). To make past Codex sessions searchable, import them with `memrain transcripts ingest` ([TRANSCRIPTS.md](../TRANSCRIPTS.md)).

## Troubleshooting

| Symptom | First check |
|---|---|
| `401` with `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="…"` | A token was sent and refused: `BRAIN_MCP_TOKEN` is stale in the environment Codex was started from, or the token was revoked (`memrain auth list`). |
| `WWW-Authenticate: Bearer resource_metadata="…", scope="read write"` | No `Authorization` header at all: the environment variable is empty. |
| Browser shows `redirect_uri is not registered for this client` | The host or path differs from the registered URI (`localhost` ≠ `127.0.0.1`). Register the URL Codex printed with `memrain auth set-redirect-uris`. |
| Callback carries `error=unauthorized_client` | The client is public and `/authorize` auto-approves (`MEMRAIN_OAUTH_REQUIRE_LOGIN=0`). Turn owner approval back on. |
| `invalid_target` from `/authorize` or `/token` | Codex sent a `resource` that is not this server. The URL in `config.toml` must be `<issuer>/mcp` on the same host as `MEMRAIN_PUBLIC_URL`. |
| A tool returns `insufficient_scope` | The token lacks `write`. Mint it with `--scopes read,write` (the default). |
| `budget_exhausted` | The daily cap is spent: `memrain auth set-budget <token_name|client_id> <usd>`. |
