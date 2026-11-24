# Memrain — Privacy Policy

**Effective:** see git history of this file
**Operator:** you, the person running this install — `<your-email>`
**Service:** Memrain Lite, a self-hosted memory server for one person's AI agents.

This policy covers the open-source Memrain Lite software that you install and
run yourself, in your own AWS account or on your own machine.

Access is limited to the operator and to the clients and tokens the operator
creates. There are no public sign-ups and no marketing list.

## What data the app touches

Memrain stores only what the operator and the operator's agents write into it:

| Source | What we read |
|---|---|
| Pages written over MCP | The title, body and tags an agent writes with `page_put`, `page_append`, `page_edit` or `index`. |
| Markdown notes | Files the operator imports or indexes from under the configured `MEMRAIN_VAULT_PATHS`. |
| Chat history | ChatGPT, Claude, Codex and Claude Code exports the operator imports with `memrain transcripts ingest`. |

There is no connector, chat, smart-home or other integration: nothing is
fetched from a mail, calendar or chat service. Credentials found in what is
written are cut out before it is stored; the originals are kept encrypted with
AES-256-GCM under the secret-store key, which lives in AWS Secrets Manager or a
file only its owner can read, never in the database (see SECURITY.md).

A pre-Lite brain moved to this build keeps the rows its removed features wrote
(facts, timelines, synced connector pages and their sealed credentials, chat
history). Lite does not read them, except that its hourly housekeeping trims
pre-Lite chat history past `MEMRAIN_CHAT_RETENTION_DAYS` (default 90 days) and
purges a deleted page together with what was derived from it.

## Where the data goes

All processing happens inside the operator's own AWS account in the
configured region:

- **Indexed text excerpts** and their **vector embeddings** are stored
  in **AWS RDS for PostgreSQL** in a private VPC subnet, encrypted at
  rest.
- **AWS Bedrock** is used for embeddings only (Amazon Titan Text Embeddings
  v2, in the configured region). Memrain never calls a chat model and never
  writes answers; that is the MCP client's job. Amazon's standard Bedrock
  data-handling terms apply (no model training on customer prompts). With
  `MEMRAIN_KEYWORD_ONLY=1` nothing is sent to Bedrock at all.

Stored data stays in your AWS account. Query results go to the MCP client you
connect, and with the default Cloudflare Tunnel, requests pass through
Cloudflare. There are no analytics SDKs, no advertising
trackers and no third-party SaaS observability. No vendor analytics or
third-party telemetry; Memrain's own search telemetry, request and spend logs
stay in your account, alongside CloudWatch application logs.

## Who can access the data

The operator, and the agents the operator gives a credential. Access is gated
behind:

- AWS IAM policies scoped to the operator's account.
- A bearer token for the public read API at
  `<subdomain>.<your-domain>`, optionally rotated daily by the
  `memrain-rotate-bearer` systemd timer.
- The ingress in front of the EC2 instance. The host has an Elastic IP;
  with the default Cloudflare Tunnel its security group admits no inbound
  web traffic, and in Caddy mode 80/tcp and 443/tcp+udp are open; SSH (22) opens only when
  `ssh_allowed_cidr` is set.

## Data retention and deletion

The operator may delete all stored data at any time by truncating the
`documents`, `chunks`, and `embeddings` tables in the RDS PostgreSQL
database, or destroying the database (`make destroy`).

The request log (`mcp_request_log`) records each tool call made with an OAuth
or personal access token, and each admin-panel tool call: who called, which
tool, how long it took, whether it worked and a redacted summary of the
arguments. Rows older than 180 days are deleted automatically; the operator
sets the window with `MEMRAIN_REQUEST_LOG_RETENTION_DAYS` (`0` keeps every
row).

A deleted page drops out of search at once and stays restorable with
`page_restore` for 30 days; the hourly housekeeping then purges it, its
history and what was derived from it for good.

There is no support inbox to email — the operator runs the entire
stack.

## Children's privacy

This stack is not intended for use by anyone under 18. No data about
minors is knowingly collected.

## Changes to this policy

The current text lives at `PRIVACY.md` in the GitHub repository.
Updates are committed there with a new date in the **Effective** field
above.

## Contact

For any inquiry: `<your-email>`.
