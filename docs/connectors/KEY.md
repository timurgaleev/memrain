# The connector key

Memrain stores every connector credential (Google refresh tokens, the
Fireflies API key, your own OAuth client secrets) encrypted with one key, the
connector key (KEK, for key-encryption key). This page covers how to create
it, where it lives, how to back it up and how to replace it.

## What it is

- 32 random bytes, written as base64 (44 characters ending in `=`).
- It seals each credential with AES-256-GCM. Each sealed row records only the
  key's id (a hash prefix), never the key.
- It is never written to the database, a log, `/health` or an error message.
  `memrain config set` refuses to store it, and a stored copy would be ignored.
- With no key, or a malformed one, connectors stay closed. Nothing falls back
  to storing a token in the clear.

## Where it lives

| Install | Source of truth | How the process gets it |
|---|---|---|
| AWS stack | Secrets Manager `<secrets_prefix>/memrain-connector-kek` | `deploy/secrets/fetch-secrets.sh` writes `MEMRAIN_CONNECTOR_KEK=...` into `deploy/.secrets/memrain.env` (mode 0400), which compose loads with `env_file` |
| Self-host, no AWS | A file only its owner can read | `MEMRAIN_CONNECTOR_KEK_FILE=/path/to/kek` (mode 0400 or 0600; anything readable by group or others is refused) |

Set `MEMRAIN_CONNECTOR_KEK` or `MEMRAIN_CONNECTOR_KEK_FILE`, never both: with
both set the key is refused.

Never add `MEMRAIN_CONNECTOR_KEK` to the compose `environment:` block. An entry
there, even an empty one, replaces the value from `memrain.env`.

## Create it on an AWS stack

### 1. Create the empty secret with terraform

In your private ops directory, set the opt-in variable in `terraform.tfvars`:

```hcl
enable_connector_kek_secret = true
```

Then plan and read the plan:

```bash
terraform plan -var-file=terraform.tfvars
```

Expect exactly two changes: one `aws_secretsmanager_secret.connector_kek[0]`
to create, and an in-place update of the instance role's inline policy (a
`SecretsReadConnectors` statement that can read that one secret). Anything
destroyed or replaced means something else is wrong: stop there. Apply only
when the plan matches:

```bash
terraform apply -var-file=terraform.tfvars
terraform output secret_arns     # connector_kek = arn:aws:secretsmanager:...
```

Terraform creates the secret empty. It never writes the value, so the key does
not end up in terraform state next to the database it unlocks.

### 2. Generate the key into a private file

On a machine you trust (your laptop or the host), with `openssl`:

```bash
umask 077
openssl rand -base64 32 > kek.b64
wc -c < kek.b64     # 45: 44 characters and a newline
```

Do not paste the key into a terminal command line: it would stay in your shell
history and be visible in the process list.

### 3. Put it in the secret

```bash
aws secretsmanager put-secret-value \
  --secret-id <secrets_prefix>/memrain-connector-kek \
  --secret-string file://kek.b64 \
  --region <region>
```

`file://` makes the AWS CLI read the value from the file, so it never appears
on the command line.

### 4. Back it up, then delete the local file

Copy `kek.b64` into your password manager or another offline store, then
remove it:

```bash
shred -u kek.b64 2>/dev/null || rm -P kek.b64 2>/dev/null || rm -f kek.b64
```

Losing the key loses no pages: everything already synced stays in the brain.
It does lose every stored credential, so every account has to be connected
again and every OAuth client re-entered.

### 5. Fetch it onto the host

```bash
bash deploy/secrets/fetch-secrets.sh     # [secrets] connector key fetched
bash deploy/deploy.sh
```

Then carry on with [ENABLE.md](./ENABLE.md) step 3.

## Create it on a self-hosted install

```bash
umask 077
openssl rand -base64 32 > /etc/memrain/connector-kek
chmod 0400 /etc/memrain/connector-kek
```

Point `MEMRAIN_CONNECTOR_KEK_FILE` at that file in the environment of the
process that runs `memrain serve`, owned by the same user. If you run the
compose stack without AWS, put a `MEMRAIN_CONNECTOR_KEK=<the base64 value>`
line in `deploy/.secrets/memrain.env` (mode 0400) instead, and do not run
`fetch-secrets.sh` there: it rewrites that file from Secrets Manager.

## Replace the key (rotate)

`memrain connectors rotate-kek` reseals every stored credential, OAuth client
secret and pending connect under a new key in one database transaction. If
any row fails to open, nothing changes and the old key keeps working. Rows
already under the new key are skipped, so running it twice is harmless.

Both keys are read from files only their owner can read; neither is printed.

### 1. Close connectors

```bash
docker exec deploy-memrain-1 memrain config set MEMRAIN_CONNECTORS_ENABLED 0
bash deploy/deploy.sh
```

A sync that renews a token while you rotate would seal it under the old key.

### 2. Put both keys in files inside the container

The current key is already in the container's environment. Write it to a file
without printing it:

```bash
docker exec deploy-memrain-1 sh -c 'umask 077; printf %s "$MEMRAIN_CONNECTOR_KEK" > /tmp/kek-old'
```

Generate the new key on the host and copy it in over stdin:

```bash
umask 077
openssl rand -base64 32 > /root/kek-new.b64
docker exec -i deploy-memrain-1 sh -c 'umask 077; cat > /tmp/kek-new' < /root/kek-new.b64
```

### 3. Rotate

```bash
docker exec deploy-memrain-1 memrain connectors rotate-kek --old-file /tmp/kek-old --new-file /tmp/kek-new
# rotated connector key <old id> -> <new id>: N credential(s), N oauth client(s), N pending connect(s)
```

If it prints `vault_wrong_key: no row was changed` or
`vault_tamper: no row was changed`, a row could not be opened with the old key
and nothing was rotated. Check that `--old-file` holds the key the rows were
sealed with; doctor's `connector-accounts` line counts rows sealed by a key
other than the one loaded.

### 4. Store the new key and fetch it

```bash
aws secretsmanager put-secret-value \
  --secret-id <secrets_prefix>/memrain-connector-kek \
  --secret-string file:///root/kek-new.b64 \
  --region <region>
bash deploy/secrets/fetch-secrets.sh
```

Secrets Manager keeps the previous value under the `AWSPREVIOUS` stage, so the
old key is still there if you need it in step 6.

### 5. Clean up and reopen

```bash
docker exec deploy-memrain-1 rm -f /tmp/kek-old /tmp/kek-new
# back up /root/kek-new.b64 offline (as in "Back it up" above), then:
shred -u /root/kek-new.b64
docker exec deploy-memrain-1 memrain config set MEMRAIN_CONNECTORS_ENABLED 1
bash deploy/deploy.sh
docker exec deploy-memrain-1 memrain doctor     # connector-accounts clean
```

### 6. If doctor reports rows sealed by another key

A row written between steps 3 and 4 (or a rotation interrupted half-way) is
still under the old key. Run the rotation again with the old key from
`AWSPREVIOUS`; it only touches those rows:

```bash
aws secretsmanager get-secret-value --secret-id <secrets_prefix>/memrain-connector-kek \
  --version-stage AWSPREVIOUS --query SecretString --output text --region <region> \
  | docker exec -i deploy-memrain-1 sh -c 'umask 077; cat > /tmp/kek-old'
docker exec deploy-memrain-1 sh -c 'umask 077; printf %s "$MEMRAIN_CONNECTOR_KEK" > /tmp/kek-new'
docker exec deploy-memrain-1 memrain connectors rotate-kek --old-file /tmp/kek-old --new-file /tmp/kek-new
docker exec deploy-memrain-1 rm -f /tmp/kek-old /tmp/kek-new
```

## Troubleshooting

| Message | Meaning | Fix |
|---|---|---|
| `MEMRAIN_CONNECTOR_KEK is not base64` / `must decode to 32 bytes` | The value is not a key | Generate one with `openssl rand -base64 32` |
| `MEMRAIN_CONNECTOR_KEK_FILE is readable by group or other; chmod 0400 it` | File mode too open | `chmod 0400` the file |
| `set MEMRAIN_CONNECTOR_KEK or MEMRAIN_CONNECTOR_KEK_FILE, not both` | Both are set | Remove one |
| `rotate-kek: the old and new keys are the same key` | Same file twice, or the new key was already fetched | Use the key the rows are sealed with as `--old-file` |
| `fetch-secrets.sh` prints `connector key not provisioned` | The secret does not exist or has no value yet | Steps 1 and 3 above |

## Related

- [ENABLE.md](./ENABLE.md): the order to switch connectors on.
- [deploy/secrets/README.md](../../deploy/secrets/README.md): every secret the host fetches.
- [CONFIGURATION.md](../CONFIGURATION.md): `MEMRAIN_CONNECTOR_KEK`, `MEMRAIN_CONNECTOR_KEK_FILE`.
