# Memrain for companies

This page is for a platform or AI-enablement team that runs workloads on AWS
and wants to give its engineers' AI agents a shared, searchable memory. It
lists what you get, what you do not get, and how to test it in a week.

Memrain is open source under the MIT licence. You deploy it into your own AWS
account. Nobody operates it for you, so most vendor questions turn into "what
does the software do by default, and what do we have to do ourselves".

## Who it is for

- Teams that already run on AWS and can apply a Terraform stack.
- Teams whose engineers use Claude Code, Codex CLI, claude.ai, Claude Team or
  Enterprise, or ChatGPT, and want those agents to search the same runbooks,
  decisions and code.
- Teams that want to start with a pilot of a few people before deciding more.

It is not a fit if you cannot run anything in AWS (there is no hosted version),
or if you need the identity and availability features listed under
[Limits](#limits).

## What you get

- **It runs in your AWS account.** The Terraform stack is one EC2 instance, RDS
  Postgres 16 with pgvector, EFS and Secrets Manager. Ingress is a Cloudflare
  Tunnel by default, or Caddy on the instance. See
  [ARCHITECTURE.md](../ARCHITECTURE.md).
- **Search with source pointers.** Hybrid search combines meaning and exact
  words. Each passage comes back with the page it came from, and your agent
  writes the answer. The opt-in `think` tool is the one exception that writes a
  cited answer itself. See [HOW-IT-WORKS.md](./HOW-IT-WORKS.md).
- **Code awareness.** A code graph for TypeScript, Python and Go answers who
  calls a function, what it calls, and what breaks if it changes. Facts,
  timelines and links between pages sit next to the notes.
- **One endpoint for every client.** Claude Code, Codex CLI, claude.ai (Pro,
  Max), Claude Team and Enterprise, and ChatGPT all connect to the same `/mcp`
  address. A shared team source can sit in each person's read set, so people on
  different vendors search the same material. Guides are in
  [docs/clients/](./clients/).
- **96 MCP tools.** Each credential sees the subset its scope allows.
- **A credential per person.** Each person gets a personal access token, or a
  one-time enrollment code redeemed through your organisation's connector. You
  can revoke one person without touching anyone else. See
  [TEAM-SETUP.md](./TEAM-SETUP.md).
- **Daily spend caps.** Daily USD caps per connector, token or person, plus an
  optional brain-wide cap. Caps apply to priced model calls, and some costs are
  approximations.
- **Credentials are redacted on the way in.** Vendor keys, JWTs, PEM private
  keys, passwords in URLs, Basic and Bearer credentials and high-entropy
  `KEY=` or `TOKEN=` assignments are redacted before storage. Output to
  non-operator callers is scanned too, and `memrain secrets audit` rescans what
  is already stored. No pattern set is complete; see
  [SECURITY.md](../SECURITY.md).
- **Version history.** Every page keeps its versions and can be reverted. Writes
  can carry an expected version so they do not overwrite someone else's change.
- **An admin panel with its own sign-in.** Overview charts, a brain explorer,
  credentials and members, spend and a request log, served with a strict
  Content-Security-Policy.
- **Import of existing chat history.** ChatGPT and Claude.ai exports, Codex
  rollouts and Claude Code session logs, redacted on the way in. See
  [TRANSCRIPTS.md](./TRANSCRIPTS.md).
- **Export.** `memrain export` writes your pages as markdown files with
  frontmatter. Facts, versions, links and embeddings stay in your own Postgres
  database and are not part of that export.

**Cost.** About $52 a month on AWS for the server and database, plus model
usage. Optional VPC interface endpoints add about $43 a month. Both figures are
approximate, for eu-west-1, as of October 2026; re-price them for your region.

## Limits

Read these before you plan a rollout.

- **No single sign-on.** There is a built-in OAuth 2.1 server with PKCE: one
  connector for the organisation and an enrollment code per person. There is
  no SAML, no OpenID Connect login federation and no user sync through SCIM. MCP
  credentials are bearer tokens with no MFA.
- **Per-person separation is pilot-grade.** Each person can have a private
  space (a source). It needs `MEMRAIN_TENANT_FAIL_CLOSED=1` and Dynamic Client
  Registration left off, and its known limits are listed in
  [TEAM-SETUP.md](./TEAM-SETUP.md#before-you-rely-on-this). Enforcement is in
  the application layer. If you need legally required separation, run one
  stack per team.
- **No high availability.** One EC2 instance. RDS runs single-AZ by default.
- **No restore drill, RTO or RPO is provided.** RDS keeps 7-day automated
  backups with encrypted storage, deletion protection and a final snapshot on
  destroy, and EFS has daily AWS Backup. Testing a restore is your job.
- **No SLA, contract or paid support.** Community support is through GitHub
  issues. Vulnerability reports get a first reply within five business days;
  that is a target, not an SLA.
- **No third-party audit or compliance attestation.** No penetration test
  report and no certification. The code is open for your own review.
- **Logs you have to manage.** The opt-in per-request log has no retention
  limit yet. Host OS patching is yours.
- **Default egress is broad.** The security group allows outbound 80, 443 and
  7844 to any address. Caddy mode exposes the instance directly, with no WAF in
  front.

## Security and data flow

- **Stored data stays in your AWS account.** Pages, chunks, embeddings and logs
  live in your RDS database and EFS volume, encrypted at rest. RDS requires TLS
  and is not publicly reachable.
- **What leaves your account.** Passages your agent retrieves go to that
  agent's model provider, under your agreement with that provider. With the
  default Cloudflare Tunnel, requests pass through Cloudflare; Caddy mode takes
  Cloudflare out of the path.
- **Model calls.** Embeddings come from Amazon Titan v2 on Amazon Bedrock in
  your account. Optional Claude calls (Haiku 5.5, Sonnet 5.5) use EU
  cross-region inference profiles by default, and IAM denies direct Claude
  invocation outside the allowed regions. The default allowed list also
  includes `us-east-1`; narrow it if you need EU-only. See
  [CONFIGURATION.md](./CONFIGURATION.md).
- **Telemetry.** No vendor analytics or third-party telemetry. Memrain's own
  search telemetry, request and spend logs stay in your account, next to
  CloudWatch application logs kept for 14 days.
- **Access paths.** With the Cloudflare Tunnel the instance opens no inbound
  ports. SSH is off unless you allow a CIDR, and SSM Session Manager is the
  default way in. Caddy mode opens HTTPS on the instance.
- **Audit.** Issuing, revoking and replacing enrollments and changing grants
  are recorded. CloudTrail is on by default in the Terraform stack, with 90-day
  S3 retention, and can be turned off.
- **Secrets.** Runtime credentials live in AWS Secrets Manager. Terraform
  generates the initial database password, the public bearer and the internal
  token, so those values are also in Terraform state: keep the state bucket
  encrypted and access-restricted.
- **Who processes your data.** You run the stack, so AWS, Cloudflare (in Tunnel
  mode) and your agent's model provider are your providers. The maintainer
  receives no data from your deployment.

More detail: [ARCHITECTURE.md](../ARCHITECTURE.md),
[PRIVACY.md](../PRIVACY.md), [SECURITY.md](../SECURITY.md) and
[DEPLOYMENT.md](./DEPLOYMENT.md).

## A one-week evaluation

Pick two to five people and one real body of material, such as a service's
runbooks and its repository.

**Day 1. Deploy.** Follow [QUICKSTART.md](./QUICKSTART.md) in a sandbox AWS
account. Submit the Bedrock Anthropic use-case form first if you plan to turn
on Claude features. Done when `/health` answers and one agent connects.

**Day 2. Load material.** Import the runbooks and index the repository. Done
when a search for a known incident returns the right page.

**Day 3. Set up people.** Set `MEMRAIN_TENANT_FAIL_CLOSED=1`, create a shared
team source and a private source per person, issue credentials and set a daily
cap for each person. Done when one person cannot read another's private page.

**Day 4. Daily use.** Each person works with their own agent as usual. Write
down three questions the agent answered well and three it did not.

**Day 5. Security review.** Revoke one person and check the others still work.
Paste a fake API key into a note and confirm it is stored redacted. Read the
open items in [TEAM-SETUP.md](./TEAM-SETUP.md#before-you-rely-on-this).

**Day 6. Restore drill.** Restore the latest RDS snapshot into a scratch
instance and point a test container at it. Restore an EFS recovery point.
Record how long both took, then write down your own RTO and RPO.

**Day 7. Decide.** Compare the AWS bill and the spend log against the caps,
review the notes from day 4, and decide whether to widen the pilot, run one
stack per team, or stop.

## Pilot help

Pilot help: open an issue in this repository titled "Pilot" and the maintainer will follow up privately. No contract, no price. For bugs and questions
anyone can see, open an issue in this repository on GitHub.
