---
name: remote-mcp
version: 1.0.0
description: |
  Make the user's own Memrain reachable over MCP from their other devices,
  desktop apps and cloud agents, without moving the data or putting the
  database on the internet. Picks the reach (loopback, the AWS install's
  Cloudflare Tunnel or Caddy ingress), then registers one least-privilege
  credential per client and verifies the connection from that client.
triggers:
  - "use my brain over mcp"
  - "serve my brain over mcp"
  - "expose my brain over mcp"
  - "remote mcp access to my brain"
  - "reach my brain from my phone"
  - "connect claude desktop to my brain"
  - "put my brain online"
tools:
  - whoami
  - list_skills
mutating: true
---

# Remote MCP — Use Your Brain From Anywhere

> The brain runs on one host. This skill makes it reachable over MCP from the
> user's other devices and the agents they use elsewhere, with one scoped
> credential per client. The database never faces the internet: only the
> server's HTTPS endpoint does, behind its own authentication.

## Contract

This skill guarantees:

- **Reach and authentication are separate choices.** The ingress decides who
  can reach `/mcp`; the credential decides what a caller may do. A public
  endpoint is protected by OAuth or bearer tokens and per-client grants, not
  by the network.
- **Consent before host changes.** Starting a server, changing ingress,
  creating secrets or running terraform changes the host. Show the plan
  (for terraform, the `plan` output) and get a yes first. This skill never
  applies infrastructure itself.
- **Least privilege.** One credential per client, scoped to the source it
  needs, read-only where the client only reads. Broader access only when the
  user asks for it.
- **No secrets in chat.** Tokens go to a file only the user can read
  (`chmod 600`) or to the client's own secret store. The admin bootstrap value
  and setup links are delivered privately and never opened by the agent.
- **A server check is not client activation.** A healthy `/health` or a
  passing `memrain auth doctor` proves the server; only an authenticated call
  from inside the intended client (`whoami`, then `list_skills`) proves the
  client loaded the tools.

## Decision table: who is connecting?

| Client | Reach | Where it is set up |
|---|---|---|
| An agent on the same machine as a local brain (Claude Code, Codex) | loopback `http://127.0.0.1:18790/mcp` | `make local-up` (Docker, keyword-only) or `serve --http` from a checkout (`docs/QUICKSTART.md`) |
| The user's own other devices and desktop apps | the AWS install's public HTTPS name | `docs/DEPLOYMENT.md`: Cloudflare Tunnel (default, no inbound ports) or `ingress_mode = "caddy"` (Let's Encrypt on 80/443) |
| Cloud agents (claude.ai, ChatGPT connectors) | the same public HTTPS name, with OAuth | `docs/clients/CLAUDE_AI.md`, `docs/clients/CHATGPT.md` |
| A whole team through one connector | the same public name, enrollment mode | `docs/TEAM-SETUP.md` |

A loopback server cannot be reached by cloud agents; for them the brain needs
the deployed HTTPS endpoint. Never bind a local server to `0.0.0.0` to
"share" it: without `MEMRAIN_INTERNAL_TOKEN` set, local requests are not
authenticated at all.

## Phase 1: detect

- `whoami` from a client that already connects shows the server, scopes and
  sources.
- On the host: `memrain status` and `memrain engine status` show what runs.
  On PGLite one process owns the database: CLI commands that open it refuse
  while `serve` runs, so token minting either goes through the running
  server's admin panel or stops the server briefly (the local script does).
- Ask which clients should reach the brain. Do not re-ask what the user
  already said.

## Phase 2: publish

Follow the matching guide; do not improvise ingress:

- **Local only:** `make local-up` prints the MCP URL and an operator token;
  `scripts/local-up.sh token <name>` mints a read/write token per client.
- **AWS install:** `docs/DEPLOYMENT.md` sections 3-5 (terraform plan, the
  tunnel token or Caddy, the admin bootstrap secret). Set the admin bootstrap
  secret before anyone but the operator connects, so OAuth consent needs a
  signed-in owner instead of auto-approving.

Verify the server from the operator's machine:

```bash
memrain auth doctor https://<host> --token-file <0600 file> --expect-operator
```

It checks `/health`, OAuth discovery, minting, MCP and the token's scope in
one report.

## Phase 3: one credential per client

Owner actions, on the host or through the admin panel (see `mcp-access` for
the full set):

- A personal access token for a person or machine:
  `memrain sources register <src> --kind <kind> --path-prefix <prefix>`, then
  `memrain auth create <name> --source <src> --scopes read,write` (or `read`).
- An OAuth client for browser connectors and CLI sign-ins:
  `memrain auth register-client <name> --scopes <scopes> --source <src>`, with
  the client's real redirect URI from its guide.
- A team through one connector: `memrain auth enroll <source>` per person
  (`docs/TEAM-SETUP.md`).
- A daily spend cap per credential: `memrain auth set-budget <id> <usd>`.

## Phase 4: connect and verify inside the client

Configure the client from its guide under `docs/clients/` (the `connect-client`
skill walks it). Then, inside that client: `whoami` must show the intended
`write_source`, `read_sources` and scopes, and `list_skills` must answer. A
right connection to the wrong source is not a working setup.

## Output Format

Report the stage reached and the one next action, keeping the stages apart:

```
Reach:      <loopback | tunnel | caddy> at <url>          [server verified: auth doctor ok]
Credential: <pat | oauth client | enrollment> <name> → source <src>, scopes <...>
Client:     <name> — whoami: <write_source>, <scopes>     [verified in client | pending]
Next:       <one action, and who does it>
```

## When it fails

- `insufficient_scope` or `permission_denied` from the client: a grant
  problem only the owner can change. Name the missing scope; do not request
  broader scopes as a retry.
- `auth doctor` fails a stage: fix that stage (its report names it) before
  touching the client.
- A local CLI command refuses because `serve` holds PGLite: stop the server
  briefly or use the panel; never delete the lock.

## Anti-Patterns

- Binding a local server to every interface to share it.
- One shared token for several clients.
- Operator or admin scope for a client that only reads.
- Treating a passing server check as proof the client works.
- Pasting tokens or setup links into chat.
- Running terraform apply without a reviewed plan.

## Dedup (sharp boundaries)

- `mcp-access` owns the owner's administration (panel login, clients, grants,
  revocation); this skill decides the reach and hands credential work there.
- `connect-client` configures one client from its guide.
- `postgres-adopt` moves the engine; concurrency across many clients is often
  the reason to.
