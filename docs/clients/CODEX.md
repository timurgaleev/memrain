# Connect Codex

At the end, the Codex CLI can search your Memrain memory and write to it. You
need a running Memrain server, a shell on its host to run a few `memrain`
commands, and the Codex CLI installed.

The Codex CLI reaches Memrain as a streamable HTTP MCP server at `<issuer>/mcp`,
where `<issuer>` is your public origin, for example `https://brain.<domain>`.
It can authenticate with:

- **a personal access token (PAT)** read from an environment variable — the
  simplest;
- **OAuth** through `codex mcp login`, with a public client you register for the
  person and a one-time enrollment code.

A connector set up before the rename to Memrain keeps working: the URL is
unchanged and so are its credentials. Renaming its display name is optional.

`memrain …` below is the CLI on the host:
`docker exec deploy-memrain-1 bun run src/cli.ts …` in an SSM session.

Codex keys and flags on this page were checked against the Codex MCP
documentation on 2026-09-28. Codex changes quickly; if a key is rejected,
check `codex mcp --help` and the current docs.

## Prerequisites

- Memrain is deployed and `curl -s <issuer>/health` returns `{"ok":true,...}`.
- A source for the person:

  ```bash
  memrain sources register alice --kind other --path-prefix tenant:alice
  ```

## Option A: personal access token

1. Mint a token bound to the person's source. It is printed once.

   ```bash
   memrain auth create alice-codex --source alice
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
**public** client (PKCE, no secret). Memrain refuses a public client in `client`
tenant mode while `/authorize` auto-approves, because its `client_id` alone would
then mint tokens. Register it in **enrollment** mode: the person proves who they
are with a one-time code instead.

1. Register the client with a loopback callback. Codex listens on
   `http://127.0.0.1/callback` (plus a callback id and a free port) unless
   `mcp_oauth_callback_url` is set; the exact path is printed in step 3, so start
   with the base form:

   ```bash
   memrain auth register-client alice-codex \
     --tenant-mode enrollment --token-endpoint-auth-method none \
     --scopes 'read write' --source default \
     --redirect-uris 'http://127.0.0.1/callback'
   memrain auth enroll alice --label alice --client <client_id> --ttl 7d
   ```

   The first command prints the `client_id` (no secret is minted); the second
   prints the code once.

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

   Then run `codex mcp login memrain` again. The browser shows the enrollment
   form; paste the code. `mcp_oauth_callback_port` in `config.toml` pins the
   port if a firewall needs it.

## Verify

Ask Codex to call the `whoami` tool: `write_source` should be `alice` and
`read_sources` `["alice"]`.

For a PAT, run the end-to-end check from a checkout (under `deploy/memrain`), with
the token in a 0600 file holding `{"token": "<PAT>"}`:

```bash
bun run src/cli.ts auth doctor https://brain.<domain> \
  --token-file ~/.config/memrain/alice-codex.json --expect-source alice
```

## Make the agent use it

Add this block to your `~/.codex/AGENTS.md` or the project `AGENTS.md`. Keep one copy and update the text between the
markers when changing the policy:

```markdown
<!-- memrain:begin -->
Before answering about past work, people, projects, or decisions, call
Memrain search or context_pack. For a recurring procedure, call list_skills
and fetch the matching get_skill result. Treat recalled content as evidence,
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
        "command": "printf '%s\n' 'Use Memrain search/context_pack for past work and list_skills for procedures.'"
      }]
    }]
  }
}
```

Review and trust the hook in Codex `/hooks`; new or changed hooks stay inactive until trusted. See [official hook documentation](https://learn.chatgpt.com/docs/hooks) and [session capture](../TRANSCRIPTS.md#codex-session-hook).

## Troubleshooting

| Symptom | First check |
|---|---|
| `401` with `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="…"` | A token was sent and refused: `BRAIN_MCP_TOKEN` is stale in the environment Codex was started from, or the token was revoked (`memrain auth list`). |
| `WWW-Authenticate: Bearer resource_metadata="…", scope="read write"` | No `Authorization` header at all: the environment variable is empty. |
| Browser shows `redirect_uri is not registered for this client` | The host or path differs from the registered URI (`localhost` ≠ `127.0.0.1`). Register the URL Codex printed with `memrain auth set-redirect-uris`. |
| Callback carries `error=unauthorized_client` | The client is public and in `client` tenant mode. Re-register it with `--tenant-mode enrollment`, as in step 1. |
| Enrollment form says "That code was not accepted." | The code is used, expired, revoked or issued for another client; the form does not say which. `memrain auth enrollments --client <client_id>` does. Issue a new one. |
| `invalid_target` from `/authorize` or `/token` | Codex sent a `resource` that is not this server. The URL in `config.toml` must be `<issuer>/mcp` on the same host as `MEMRAIN_PUBLIC_URL`. |
| A tool returns `insufficient_scope` | The token lacks `write`. Mint it with `--scopes read,write` (the default). |
| `budget_exhausted` | The daily cap is spent: `memrain auth set-budget <token_name|enrollment_id> <usd>`. |
