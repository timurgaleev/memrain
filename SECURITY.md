# Security Policy

This policy covers the open-source Memrain software that you install and run
yourself, in your own AWS account. A hosted offer, when it exists, will publish
its own terms.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Instead, email the maintainer at the address listed on the
[GitHub profile](https://github.com/<your-github-username>). Include:

- A short description of the issue.
- A minimal reproduction (steps, code snippet, or commit hash).
- Your assessment of the impact.

Expect a first reply within five business days. Coordinated disclosure
once a fix lands is the norm; if you need a faster path, say so in the
first message.

## Scope

This repo describes a self-hostable stack, single-operator by default, with
optional per-person tenants. Anything that
could let an unauthorized actor read or modify another deploy's data —
even when both deploys are running on different AWS accounts — is in
scope. Examples:

- Secret leakage via committed files.
- Bedrock IAM privilege escalation.
- MCP bearer-token bypass on `brain.<domain>`.
- Cross-tenant data exposure in the Memrain index.
- Cloudflare Tunnel auth bypass.

## Out of scope

- Findings that require maintainer-level AWS console access.
- Findings against Amazon Bedrock, Cloudflare, or any AWS service —
  report those to AWS / Cloudflare.

## Hardening defaults

- All secrets live in AWS Secrets Manager, never in code or terraform
  state.
- The audit gate (`make audit`) blocks pushes that contain
  maintainer-private identifiers.
- The public MCP bearer can rotate daily, but the timer is opt-in —
  install `deploy/systemd/memrain-rotate-bearer.*` by hand (bootstrap does
  not), otherwise the token is static.
- `MEMRAIN_PUBLIC_WRITE` defaults to `0` — a fresh clone cannot accept
  mutating MCP traffic without an explicit opt-in.

## If a secret reached the brain

Every write path redacts credential-shaped text before it is stored: vendor
key prefixes, Memrain's own tokens, JWTs, PEM private keys, passwords inside
URLs, HTTP Basic and Bearer credentials, and high-entropy `KEY=`/`TOKEN=`/
`PASSWORD=` assignments. Source code is scanned the same way when it is
indexed. No pattern set is complete, and text stored before a rule existed
keeps what it carried. If you find a live credential in the brain:

1. **Rotate the credential first.** Anything a connected agent could read is
   exposed, whatever happens to the stored copy.
2. **Find every stored copy**, on the host:

   ```bash
   memrain secrets audit            # dry run; add --json for the full list
   ```

   It rescans pages, page versions, facts, timeline events, synthesis rows,
   chunks and raw data with the current rules and lists each hit by store,
   row, field, kind, fingerprint and line. It never prints the value. The
   fingerprint is the one in the `[REDACTED:<kind>:<fingerprint>]` marker.
   It does not read slugs, document titles and frontmatter, the query cache
   or the ingest log; check those by hand if the value could be there.
3. **Redact them:**

   ```bash
   memrain secrets audit --apply --yes
   ```

   A live page gets a new version written by `secrets-audit` and is mirrored
   into search again. Older versions are rewritten in place and stamped
   `scrubbed_at`, so their `hash_new` no longer matches their body. Every
   other row is rewritten in place, and only if it still holds the text that
   was scanned; a row that changed in between is reported, so run the audit
   again. Each rewrite leaves a `secret-audit-redacted` ingest-log row with
   kinds and fingerprints only.
4. **Rebuild what the audit cannot rewrite.** If code chunks were listed,
   run `memrain reindex --source code --all`. A rewritten chunk keeps the
   embedding computed from its old text until it is embedded again.
5. **Check the other copies.** Database backups and snapshots, the vault or
   repository the text came from (and its git history), and any export
   directory still hold the value.
6. `memrain doctor` reports `secret-exposure`: a warning while the brain has
   never been audited, the last audit used older scanner rules or is more
   than 30 days old, or its hits were never redacted.

Add a fingerprint to `MEMRAIN_SECRET_SCAN_ALLOW` only for a value you have
confirmed is not a credential.

## Known accepted risks

These are documented choices, not bugs — report only if you've found a
way to break the assumed envelope.

- A maintainer who deploys with default settings exposes a read-only
  MCP server at `brain.<domain>/mcp`. The bearer token gates access; the
  optional daily rotation timer (`deploy/systemd/memrain-rotate-bearer.*`,
  installed by hand) bounds the blast radius of a leaked token. Without
  it the bearer is static until rotated manually.
- Public read tools redact note bodies by default
  (`MEMRAIN_PUBLIC_READ_BODIES=1` opts in); write tools are filtered from
  discovery and rejected from the public surface, and require
  `MEMRAIN_INTERNAL_TOKEN` even on the internal path.
