# Security Policy

This policy covers the open-source Memrain software that you install and run
yourself, in your own AWS account. A hosted offer, when it exists, will publish
its own terms.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Instead, report it privately through GitHub's private vulnerability reporting
(this repository's **Security** tab, then **Report a vulnerability**). Include:

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
- Reading a connector credential (a Google refresh token, a Fireflies key, an
  OAuth client secret) out of the database, a log or a response, or using one
  account's connector to read or delete another account's pages.
- Making the notification webhook reach an address it should refuse.

## Out of scope

- Findings that require maintainer-level AWS console access.
- Findings against Amazon Bedrock, Cloudflare, or any AWS service —
  report those to AWS / Cloudflare.

## Hardening defaults

- All secrets live in AWS Secrets Manager, never in code. Terraform
  generates the initial database password, the public bearer and the
  internal token, so those values are also in Terraform state: keep the
  state bucket encrypted and access-restricted.
- The audit gate (`make audit`) blocks pushes that contain
  maintainer-private identifiers.
- The public MCP bearer can rotate daily, but the timer is opt-in —
  install `deploy/systemd/memrain-rotate-bearer.*` by hand (bootstrap does
  not), otherwise the token is static.
- `MEMRAIN_PUBLIC_WRITE` defaults to `0` — a fresh clone cannot accept
  mutating MCP traffic without an explicit opt-in.
- Admin-panel passkeys are bound to the `MEMRAIN_PUBLIC_URL` origin; every
  passkey POST checks `Origin`, and challenges are single-use and expire after
  5 minutes. A passkey added through a setup link or recovery code spends 24
  hours in a cooldown, a link or code can be reserved at most five times, and
  refused sign-ins (401) take a fixed minimum time. Sign-out-everywhere waits
  for in-flight passkey operations, so none of them outlives it.

## Connector credentials and notifications

Connectors (Google Calendar, Gmail, Fireflies) are off until the operator sets a
connector key and `MEMRAIN_CONNECTORS_ENABLED=1`, connects an account from the
admin panel and switches its sync on. With the switch off no credential is
opened and nothing is synced or queued.

- **Token vault.** Refresh and access tokens, Fireflies API keys and
  bring-your-own OAuth client secrets are sealed with AES-256-GCM before they
  reach the database. Each sealed row records only the key's id. Routes and
  logs never return or print a credential; a token a provider echoes into
  synced text is redacted before the page is written.
- **The connector key (KEK)** is 32 random bytes kept in AWS Secrets Manager
  (`<prefix>/memrain-connector-kek`, created empty by terraform so the value
  never sits in terraform state) and fetched into `deploy/.secrets/memrain.env`
  (mode 0400). Without AWS it is read from a file only its owner can read
  (`MEMRAIN_CONNECTOR_KEK_FILE`). It is never stored in the database:
  `memrain config set` refuses it, and with no usable key connectors stay
  closed instead of storing anything in the clear. `memrain connectors
  rotate-kek` reseals every credential under a new key
  (docs/connectors/KEY.md). Losing the key loses the stored credentials, not
  the synced pages: accounts are connected again.
- **Least access.** Google is asked only for `openid email` plus
  `calendar.readonly` for a calendar source and `gmail.readonly` for a mailbox
  source, and a grant that differs is refused and revoked. Google merges the
  scopes a user granted one client, so a connect also asks for the read-only
  scopes the brain's other Google accounts already hold; nothing beyond those
  two read scopes is ever requested. Connector text has credentials redacted
  before it is written, whatever `MEMRAIN_SECRET_SCAN_DISPOSITION` says.
  Fireflies keys carry the owner's full API access (Fireflies offers no scoped
  key); Memrain only sends read queries with one.
- **Outside text.** Everything a connector syncs is stored as untrusted
  outside text, passes the write gate and is read back inside a trust frame;
  nothing in it is acted on.
- **Admin routes** for connectors, notifications, autonomy and approvals sit
  behind the admin passkey session and its same-origin check on writes.
  Disconnect and delete everything need the account's name typed back, and
  delete everything also needs the hash of the preview it deletes.
- **Notification webhook.** `MEMRAIN_NOTIFY_WEBHOOK_URL` must be https to a
  host that is not loopback, private, link-local or `localhost`, with no
  credentials in the URL. A host name is resolved again before each POST and
  refused when any address is one of those (a name that changes its answer
  between that lookup and the connection is not caught); redirects are not
  followed. Each POST is signed
  (HMAC-SHA256 over the timestamp and raw body, secret from
  `<prefix>/memrain-notify-webhook`) and carries only a pointer: kind, id,
  admin link and time.

## Software bill of materials

Every GitHub release from v1.9.1 on carries two CycloneDX 1.7 JSON files,
built by `.github/workflows/sbom.yml` from the release tag:

- `memrain-vX.Y.Z-server.cdx.json`: the server's production Bun dependencies
  (`deploy/memrain/bun.lock`).
- `memrain-vX.Y.Z-admin.cdx.json`: the admin panel's runtime dependencies
  (`deploy/memrain/admin/bun.lock`), which are bundled into the panel.

Each lists the packages of a `bun install --frozen-lockfile --production`,
which is what the image installs, with versions, package URLs and declared
licences. To check a download:

```bash
gh release download vX.Y.Z --pattern 'memrain-vX.Y.Z-*'
sha256sum -c memrain-vX.Y.Z-server.cdx.json.sha256 memrain-vX.Y.Z-admin.cdx.json.sha256
```

The checksum only shows that the file arrived intact; it comes from the same
release. Not covered: build-only tooling (Vite, test and lint packages), the
container base image and its OS packages (the image is built on your host and
not published), the vendored tree-sitter WASM grammars, and Terraform
providers. Licence texts stay in `THIRD_PARTY_NOTICES.md`.

## If a secret reached the brain

Every write path redacts credential-shaped text before it is stored: vendor
key prefixes, Memrain's own tokens, JWTs, PEM private keys, passwords inside
URLs, HTTP Basic and Bearer credentials, and high-entropy `KEY=`/`TOKEN=`/
`PASSWORD=` assignments. The scanner also recognizes bounded, single-layer
Unicode escapes and selected zero-width inserts, percent-encoded URL
separators, and base64 credential assignments that decode to a complete
recognized vendor key. It does not normalize arbitrary prose or decode
arbitrary blobs recursively. Source code is scanned the same way when it is
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
   Jobs are also scanned, including JSON keys, but reported only as aggregate
   counts by status and secret kind: no payloads, job IDs or per-job
   fingerprints. `--kinds jobs` selects that audit alone. Under `--source`,
   jobs are explicitly skipped because payload metadata is not authoritative
   ownership.
   It does not read slugs, document titles and frontmatter, the query cache
   or the ingest log; check those by hand if the value could be there.
3. **Redact them:**

   ```bash
   memrain secrets audit --apply --yes
   ```

   A live page gets a new version written by `secrets-audit` and is mirrored
   into search again. Older versions are rewritten in place and stamped
   `scrubbed_at`, so their `hash_new` no longer matches their body. Every
   other supported row is rewritten in place, and only if it still holds the
   text that was scanned; a row that changed in between is reported, so run
   the audit again. Each rewrite leaves a `secret-audit-redacted` ingest-log row with
   kinds and fingerprints only.
   Jobs remain read-only even with `--apply --yes`: active and terminal
   payloads, keys, authority and status are never rewritten or pruned. Hits
   are reported as withheld, keep the audit unclean and return exit status 1.
   Deploying new scanner rules does not scrub stored data; run a fresh dry
   audit before choosing any corrective action.
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
