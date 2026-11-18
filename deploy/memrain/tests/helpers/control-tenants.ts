/**
 * Provisioning for the hosting tests: a scratch control plane, tenants created
 * by the real `createTenant` with file secrets, and teardown of everything.
 * Member invites are stubbed (the invite step is the only seam).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PostgresEngine } from "../../src/core/engine/postgres.ts";
import { migrateControl } from "../../src/control/migrations.ts";
import { FileSecretWriter } from "../../src/control/secret-writer.ts";
import { TENANT_SECRETS, createTenant, type CreateTenantResult, type ProvisionContext } from "../../src/control/provision.ts";
import { createScratchControl, dropTenantArtifacts, runSuffix } from "./control-pg.ts";

export interface ControlFixture {
  masterUrl: string;
  control: PostgresEngine;
  secretsDir: string;
  ctx: ProvisionContext;
  /** A tenant id unique to this run. */
  tenantId(base: string): string;
  create(id: string, extra?: Partial<Parameters<typeof createTenant>[1]>): Promise<CreateTenantResult>;
  secret(id: string, name: (typeof TENANT_SECRETS)[keyof typeof TENANT_SECRETS]): string;
  close(): Promise<void>;
}

export const stubInvite: NonNullable<ProvisionContext["mintInvite"]> = async (_e, memberId, ttlMs) => ({
  inviteId: randomBytes(8).toString("hex"),
  memberId,
  token: randomBytes(24).toString("base64url"),
  expiresAt: new Date(Date.now() + ttlMs),
});

export async function openControlFixture(pgUrl: string): Promise<ControlFixture> {
  const scratch = await createScratchControl(pgUrl);
  const control = new PostgresEngine({ url: scratch.url, max: 4 });
  await migrateControl(control);
  const secretsDir = mkdtempSync(join(tmpdir(), "memrain-tenant-secrets-"));
  const suffix = runSuffix();
  const made = new Set<string>();
  const ctx: ProvisionContext = {
    masterUrl: scratch.url,
    control,
    secrets: new FileSecretWriter(secretsDir),
    mintInvite: stubInvite,
  };
  return {
    masterUrl: scratch.url,
    control,
    secretsDir,
    ctx,
    tenantId: (base) => {
      const id = `${base}-${suffix}`;
      made.add(id);
      return id;
    },
    create: (id, extra = {}) => {
      made.add(id);
      return createTenant(ctx, { id, hostname: `${id}.example.test`, ...extra });
    },
    secret: (id, name) => readFileSync(join(secretsDir, id, name), "utf8").trim(),
    async close() {
      await control.close();
      await scratch.drop();
      for (const id of made) await dropTenantArtifacts(pgUrl, id);
      rmSync(secretsDir, { recursive: true, force: true });
    },
  };
}
