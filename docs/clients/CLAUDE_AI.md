# Connect claude.ai (Pro or Max)

At the end, Claude on claude.ai can search your Memrain memory and write to it
from any chat. You need a running Memrain server, a shell on its host to
register a client, and a Pro or Max plan.

On a Pro or Max plan you add the custom connector to your own account.
Memrain does not let a client register itself (Dynamic Client Registration is
off), so you register a confidential client and paste its ID and secret into
the connector's Advanced settings.

A connector set up before the rename to Memrain keeps working: the URL is
unchanged and so are its credentials. Renaming its display name is optional.

`memrain …` below is the CLI on the host:
`docker exec deploy-memrain-1 bun run src/cli.ts …` in an SSM session.
`<issuer>` is your public origin, for example `https://brain.<domain>`.

## Prerequisites

- Memrain is deployed, `curl -s <issuer>/health` returns `{"ok":true,...}`, and
  `MEMRAIN_PUBLIC_URL` is set to `<issuer>` so the discovery documents name the
  public host.
- A source for claude.ai, so its writes stay apart from your other pages:

  ```bash
  memrain sources register claude-ai --kind other --path-prefix agent:claude-ai
  ```

## Steps

1. Register a client. Its writes go to the source named by `--source`.

   ```bash
   memrain auth register-client claude-ai \
     --scopes 'read write' --source claude-ai \
     --redirect-uris 'https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback'
   ```

   It prints `client_id` and `client_secret` once. Register both callback
   origins: claude.ai and claude.com are different hosts to the allow-list.
   Anthropic's help article does not list the callback; these are the ones
   claude.ai uses today. If a sign-in fails on the redirect, the browser error
   names the URL it sent, and `memrain auth set-redirect-uris` changes the list
   without rotating the secret.

2. Optional: cap the client's daily spend on paid calls.

   ```bash
   memrain auth set-budget <client_id> 2.00
   ```

3. Keep the client ID and secret private. The secret is a credential: treat it
   like a password and use one client per connector.

4. Add the connector (click-path checked against Anthropic's help center on
   2026-09-28):

   - **Customize → Connectors**, click **+**, then **Add custom connector**.
   - Name it, and set the URL to `<issuer>/mcp`.
   - Open **Advanced settings** and fill **OAuth Client ID** and
     **OAuth Client Secret**.
   - Click **Connect**; the browser goes to Memrain's `/authorize` and back.

### If the admin login page appears

With owner approval on (the default; `MEMRAIN_OAUTH_REQUIRE_LOGIN=0` turns it off),
`/authorize` first sends the browser to `/admin/login`. Sign in with your
passkey (or the bootstrap token), approve the client, and the browser returns
to claude.ai.

## Verify

In a chat, ask Claude to call Memrain's `whoami` tool. `write_source` should be
`claude-ai`, `read_sources` `["claude-ai"]`, and `scopes` `["read","write"]`.

On the host, `memrain auth list-clients` shows the client, its `grant_types`
(`authorization_code`, `refresh_token`) and its `source_id`.

## Troubleshooting

| Symptom | First check |
|---|---|
| Connect fails with `redirect_uri is not registered for this client` | The account uses a callback origin you did not register. `memrain auth set-redirect-uris <client_id> https://claude.ai/api/mcp/auth_callback https://claude.com/api/mcp/auth_callback`. |
| Connect lands on the admin login page | Owner approval is on (the default). Sign in and approve; see [If the admin login page appears](#if-the-admin-login-page-appears). |
| Connect fails with `invalid_client` | The secret was mistyped or the client was revoked (`memrain auth list-clients` no longer shows it). Register a new client. |
| Connect fails with `invalid_target` | claude.ai named a `resource` that is not this server: the connector URL must be `<issuer>/mcp` on the host `MEMRAIN_PUBLIC_URL` names. |
| Callback carries `error=unauthorized_client` | The client has no `authorization_code` grant, or it is a public client in `client` mode. Register it as above (with `--redirect-uris`, without `--token-endpoint-auth-method none`). |
| Tools fail with `401` and `Bearer error="invalid_token"` after working for weeks | The refresh token expired or was revoked (`memrain auth invalidate-tokens`, a rescope). Disconnect and connect again. |
| A tool returns `insufficient_scope` | The client was registered with `--scopes read`. Re-register with `'read write'`. |
| `permission_denied`, "is operator-only and not callable by a tenant token" | Expected for `stats` and `run_doctor` on a scoped client. |
| `budget_exhausted` | The client's daily cap is spent. Raise it or wait for the UTC day. |
