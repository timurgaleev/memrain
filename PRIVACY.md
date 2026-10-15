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

Memrain indexes only data the operator points it at inside their own
infrastructure:

| Source | What we read |
|---|---|
| Markdown notes | Notes the operator indexes from under the configured `MEMRAIN_VAULT_PATHS`. |
| Code corpus | Source files under the configured `MEMRAIN_CODE_PATHS` (graph-only via tree-sitter). |

There is **no third-party data integration** — no Google, no email, no
calendar, no smart-home, no OAuth to any external provider. The stack
reads only the operator's own files.

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
  answers; that is the MCP client's job. Bedrock requests stay inside
  AWS; Amazon's standard Bedrock data-handling terms apply (no model
  training on customer prompts).

Stored data stays in your AWS account. Query results go to the MCP client you
connect, and with the default Cloudflare Tunnel, requests pass through
Cloudflare. There are no analytics SDKs, no advertising
trackers, no third-party SaaS observability, and no telemetry beyond
CloudWatch logs scoped to the operator's account.

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
