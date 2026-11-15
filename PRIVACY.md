# Memrain — Privacy Policy

**Effective:** see git history of this file
**Operator:** you, the person running this install — `<your-email>`
**Service:** Memrain, a self-hosted memory server for AI agents.

This policy covers the open-source Memrain software that you install and run
yourself, in your own AWS account. A hosted offer, when it exists, will publish
its own terms.

Access is limited to the operator and to the sources and clients the operator
creates (see docs/TEAM-SETUP.md). There are no public sign-ups and no
marketing list.

## What data the app touches

Memrain indexes only data the operator points it at:

| Source | What we read |
|---|---|
| Markdown notes | Notes the operator indexes from under the configured `MEMRAIN_VAULT_PATHS`. |
| Code corpus | Source files under the configured `MEMRAIN_CODE_PATHS` (graph-only via tree-sitter). |
| Google Calendar (connector, off by default) | Events of the calendars the operator picks, read-only (`calendar.readonly`, plus `openid email` to name the account): title, time, location, organizer, attendees' names and addresses, description, recurrence and occurrences. |
| Fireflies (connector, off by default) | Meeting transcripts the operator's API key can see: title, time, participants, the Fireflies summary and action items, and the transcript as speaker turns. Memrain sends Fireflies read queries only. |

Connectors are off unless the operator sets a connector key, turns on
`MEMRAIN_CONNECTORS_ENABLED`, connects an account from the admin panel and
switches its sync on (docs/connectors/ENABLE.md). There is no email, chat,
smart-home or other integration. A synced event or transcript is written to
the brain as a page marked as outside text: its people are linked to people
pages that already exist (others are only listed as wanted, never created),
an event or meeting gets one chronicle row, and the page is chunked and
embedded like any other. Connector pages are left out of fact extraction, the
contextual LLM tier and deep synthesis, so their text is not sent to a model
for those features.

Connector credentials (Google refresh tokens, the Fireflies API key, an
operator's own OAuth client secret) are stored encrypted with AES-256-GCM
under the connector key, which lives in AWS Secrets Manager and never in the
database (see SECURITY.md).

## Where the data goes

All processing happens inside the operator's own AWS account in the
configured region:

- **Indexed text excerpts** and their **vector embeddings** are stored
  in **AWS RDS for PostgreSQL** in a private VPC subnet, encrypted at
  rest.
- **AWS Bedrock** is used for embeddings (Amazon Titan Text Embeddings
  v2) and lightweight retrieval helpers — intent classification and
  query expansion (Claude Haiku 5.5 on Bedrock by default, overridable via
  `MEMRAIN_UTILITY_MODEL` / `MEMRAIN_INTENT_MODEL` /
  `MEMRAIN_EXPANSION_MODEL`). Memrain does **not** synthesize
  answers, except through the opt-in `think` tool, which writes a cited
  answer with Claude on Bedrock; otherwise that is the MCP client's job. Bedrock requests stay inside
  AWS, though cross-region inference profiles can route them to other
  regions you allow (by default the EU profiles, plus `us-east-1`); Amazon's standard Bedrock data-handling terms apply (no model
  training on customer prompts).

Stored data stays in your AWS account. Query results go to the MCP client you
connect, and with the default Cloudflare Tunnel, requests pass through
Cloudflare. A connected connector calls only its provider's API (Google's
OAuth and Calendar endpoints, Fireflies' GraphQL endpoint) with the stored
credential. Owner notifications, when the operator sets
`MEMRAIN_NOTIFY_WEBHOOK_URL`, send the configured receiver a signed pointer
(kind, id, a link into the admin panel, time) and never the problem's text. There are no analytics SDKs, no advertising
trackers and no third-party SaaS observability. No vendor analytics or
third-party telemetry; Memrain's own search telemetry, request and spend logs
stay in your account, alongside CloudWatch application logs.

## Who can access the data

The operator, and the people the operator gives a credential. Access is gated
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

Connector data has its own rules:

- **Retention.** A connector page is hard-deleted once its last activity is
  older than its window: 365 days for calendar events and meetings by default
  (180 for mail and chat, which no shipped connector reads yet), set per kind
  with `MEMRAIN_CONNECTOR_RETENTION_DAYS_<KIND>`; `0` or `off` keeps pages.
  The sweep runs after each sync run.
- **Deleted at the provider.** An event cancelled in Google or a transcript
  Fireflies no longer has is deleted from the brain with its parts, whatever
  anyone wrote on it, but recoverably: the page is soft-deleted the way
  `page_delete` leaves a page, so it drops out of search at once and its fence
  facts go, while the page and its history stay restorable with
  `page_restore` for 30 days. The purge then removes the page and its history
  for good and retires the facts written on it. A run that would delete more
  than the mass-delete guard allows is held until the operator confirms it in
  the admin panel.
- **Disconnecting** revokes a Google grant at Google and drops the stored
  credential (it is kept for another try if Google does not confirm the
  revoke); a Fireflies key is dropped and stays valid in Fireflies until the
  operator regenerates it there. The synced pages stay. **Delete everything** on the Connections
  page then removes every page that account brought in, after a preview and a
  typed confirmation.
- Every connector deletion leaves a receipt in the ingest log holding counts
  and hashes only, never a title, address or text.

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
