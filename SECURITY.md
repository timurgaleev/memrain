# Security Policy

This policy covers the open-source Memrain Lite software that you install and
run yourself, in your own AWS account or on your own machine.

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

This repo describes a self-hostable stack for one person. Anything that
could let an unauthorized actor read or modify another deploy's data —
even when both deploys are running on different AWS accounts — is in
scope. Examples:

- Secret leakage via committed files.
- Bedrock IAM privilege escalation.
- MCP bearer-token bypass on `brain.<domain>`.
- A credential reading or writing outside its sources, or seeing an
  owner-only source it should not.
- Cloudflare Tunnel auth bypass.
- Reading a kept secret original out of the database, a log or a response
  without the admin passkey session.
- A credential refused by this build (bound to a non-owner member, or carrying
  a trust floor) being accepted.

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

## The secret-store key

Redacted originals are sealed with AES-256-GCM under one key, the secret-store
key (KEK). It keeps its 2.x name, the connector key: `MEMRAIN_CONNECTOR_KEK`,
`MEMRAIN_CONNECTOR_KEK_FILE`, the Secrets Manager secret
`<prefix>/memrain-connector-kek` and the Terraform resource `connector_kek`.

- It is 32 random bytes written as base64. Each sealed row records only the
  key's id, never the key. It is never stored in the database (`memrain config
  set` refuses it), a log, `/health` or an error message.
- Without a usable key no original is kept and the write goes ahead with the
  marker; nothing is ever stored in the clear.
- On AWS, set `enable_connector_kek_secret = true` in `terraform.tfvars`;
  Terraform creates the secret empty, so the value never sits in Terraform
  state. Generate the key into a private file and put it in from that file:

  ```bash
  umask 077
  openssl rand -base64 32 > kek.b64
  aws secretsmanager put-secret-value --secret-id <prefix>/memrain-connector-kek \
    --secret-string file://kek.b64 --region <region>
  ```

  Back `kek.b64` up offline, delete it, then run
  `bash deploy/secrets/fetch-secrets.sh` and `bash deploy/deploy.sh`.
  `fetch-secrets.sh` writes it into `deploy/.secrets/memrain.env` (mode 0400).
  Never add it to the compose `environment:` block: an entry there, even an
  empty one, replaces the fetched value.
- Without AWS, point `MEMRAIN_CONNECTOR_KEK_FILE` at a file only its owner can
  read (mode 0400 or 0600). Set one of the two variables, never both.
- Losing the key loses the kept originals, not the pages: every page keeps its
  markers.

A 2.x brain's sealed connector credentials stay in the database under the
same key; this build never opens them.

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
not published), and Terraform providers. Licence texts stay in `THIRD_PARTY_NOTICES.md`.

## If a secret reached the brain

Every write path redacts credential-shaped text before it is stored: vendor
key prefixes, Memrain's own tokens, JWTs, PEM private keys, passwords inside
URLs, HTTP Basic and Bearer credentials, and high-entropy `KEY=`/`TOKEN=`/
`PASSWORD=` assignments. The scanner also recognizes bounded, single-layer
Unicode escapes and selected zero-width inserts, percent-encoded URL
separators, and base64 credential assignments that decode to a complete
recognized vendor key. It does not normalize arbitrary prose or decode
arbitrary blobs recursively. Agent transcripts (`memrain transcripts ingest`) also get
rules no other write runs, because a header name or a label is a much
weaker signal than a credential's own shape: cookie values after a `Cookie:`
or `Set-Cookie:` header or a curl `-b`/`--cookie` argument (names, attributes
and values under 8 characters stay), a `.netrc` password (one line, or a
`password` line inside a multi-line `machine` stanza), a password label with
its value on the same line (`password: hunter2`), the password half of a
user/password pair (`login: alice / s3cret!`), a password flag (`--password
X`, openssl `-passin pass:X`), a cell under a password column or after a
password key cell in a Markdown table, and a key, token or password label
that ends a line or a message with the value alone on the next one.
Placeholders, setting names such as `PASSWORD_FILE=`, code references and
common words after a label stay. No pattern set is complete, and text stored before a rule existed
keeps what it carried. If you find a live credential in the brain:

1. **Rotate the credential first.** Anything a connected agent could read is
   exposed, whatever happens to the stored copy.
2. **Find every stored copy**, on the host:

   ```bash
   memrain secrets audit            # dry run; add --json for the full list
   ```

   It rescans pages, page versions, chunks, and the facts, timeline events,
   synthesis rows and raw data a 2.x brain left, with the current rules and lists each hit by store,
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

   To rescan stored agent transcripts with the transcript rules, run
   `memrain secrets audit --transcripts` (add `--slug-prefixes P/,Q/` for
   other agent-written prefixes; connector pages are skipped whatever the
   prefix). It reports counts by kind and the page slugs, nothing else. Its
   `--apply --yes` refuses without the secret-store key: every value it redacts
   is kept in the secret store in the same transaction that writes the new
   version, and a page is rewritten only when putting each original back over
   its marker gives the stored text exactly. Older versions of those pages
   keep what they held.

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
4. **Re-embed what the audit rewrote.** A rewritten chunk keeps the embedding
   computed from its old text until it is embedded again (`memrain reindex`).
5. **Check the other copies.** Database backups and snapshots, the vault or
   repository the text came from (and its git history), and any export
   directory still hold the value.
6. `memrain doctor` reports `secret-exposure`: a warning while the brain has
   never been audited, the last audit used older scanner rules or is more
   than 30 days old, or its hits were never redacted.

Add a fingerprint to `MEMRAIN_SECRET_SCAN_ALLOW` only for a value you have
confirmed is not a credential.

### Kept originals (the secret store)

When a page write (`page_put`, `page_append`, `page_edit`, the CLI) replaces
a credential with its marker, the value it removed is kept in the
`secret_store` table, sealed with AES-256-GCM under the secret-store key
(see above) and bound to its source and fingerprint. Without that key nothing
is kept and the write goes ahead. Transcript ingest keeps them too. Values
redacted before the store existed, and anything the whole-brain `memrain
secrets audit --apply` redacts, were not kept and cannot be recovered; the
transcript audit (`--transcripts --apply`) keeps what it redacts. Only a
page's body, title and compiled truth are kept: a value redacted in a version's
change reason, a timeline entry, a fact, a take, raw data or a link's context
is gone for good. No log, receipt, response or ingest-log row
carries a value; only `reveal` does.

On the host:

```bash
memrain secrets originals [--slug S]           # kinds, fingerprints and pages, never a value
memrain secrets reveal <slug> <fingerprint>    # the original behind a marker on that page
memrain secrets restore <slug> <fingerprint>   # preview putting a false positive back
memrain secrets restore <slug> <fingerprint> --apply --plan-hash <hash>
memrain secrets backup                         # encrypted export, see below
memrain secrets restore-backup <file>
```

The MCP tool `reveal_secret` runs only from the admin panel session. No MCP
client lists or calls it, the internal token included, so an agent steered by
text it read cannot pull a kept credential back out; every OAuth or personal
token and the public ingress are refused too. Every reveal and restore leaves a
`secret-revealed` / `secret-restored` ingest-log row (kind, fingerprint,
actor) and, with `MEMRAIN_AUDIT_DIR` set, a line in the 0600 audit file.

A restore acts only on the page the redaction wrote the marker to, and only
while that live page still holds it: a marker copied into another page binds
to nothing. It writes a new page version, and from then on the value is
allowed in that source, so later edits leave it in place. Purging a page
removes its places in the store and every original no other page holds.
A page rename takes its places with it. A backup opens only under the key it
was sealed with.

The database backup already carries the store. `memrain secrets backup`
also writes one encrypted export to `<config dir>/secret-store/backups/`
(on a Docker install, the persistent config mount): every entry as stored
plus where it occurs, sealed again under the secret-store key, so no slug,
fingerprint or kind is in clear. It restores only where the same key is
loaded, and only for originals whose page is live and still holds the
marker, so a restore never brings back what a purge removed. `memrain
doctor` reports `secret-store`: a warning when kept originals cannot be read
with the loaded key, when no page holds an entry any more, or when the store
changed since the last backup.

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
