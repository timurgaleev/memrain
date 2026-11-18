/**
 * Where provisioning puts a tenant's generated secrets: its database login,
 * its control-plane login and its own internal token. Values are written,
 * never printed or logged.
 *
 *   file  one file per secret under `<dir>/<tenant>/`, mode 0600 in a 0700
 *         directory (the host's secrets tree, and local tests)
 *   aws   `put-secret-value` into `<prefix>/tenants/<tenant>/<name>`; the
 *         secret itself is created by terraform, never here
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { SecretWriter } from "./contract.ts";
import { assertTenantId } from "./tenants.ts";

const SECRET_NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;

function assertSecret(name: string, value: string): void {
  if (!SECRET_NAME_RE.test(name)) throw new Error(`secret name '${name}' is not a lowercase slug`);
  if (value.length === 0 || /[\r\n]/.test(value)) throw new Error(`secret '${name}' must be one non-empty line`);
}

export class FileSecretWriter implements SecretWriter {
  readonly backend = "file" as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(tenantId: string, name: string, value: string): Promise<void> {
    assertTenantId(tenantId);
    assertSecret(name, value);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const dir = join(this.root, tenantId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const target = join(dir, name);
    // Written beside the target and renamed over it, so a reader never sees a
    // half-written value and the file is 0600 from its first byte.
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, `${value}\n`, { mode: 0o600 });
    renameSync(tmp, target);
  }

  /** Where `name` of `tenantId` lives (for the operator's own tooling). */
  pathOf(tenantId: string, name: string): string {
    return join(this.root, tenantId, name);
  }
}

export class AwsSecretWriter implements SecretWriter {
  readonly backend = "aws" as const;

  constructor(
    private readonly prefix: string,
    private readonly client: Pick<SecretsManagerClient, "send"> = new SecretsManagerClient({}),
  ) {
    if (!/^[\w/+=.@-]{1,200}$/.test(prefix)) throw new Error("secret prefix has characters AWS does not allow");
  }

  async put(tenantId: string, name: string, value: string): Promise<void> {
    assertTenantId(tenantId);
    assertSecret(name, value);
    await this.client.send(new PutSecretValueCommand({
      SecretId: `${this.prefix}/tenants/${tenantId}/${name}`,
      SecretString: value,
    }));
  }
}
