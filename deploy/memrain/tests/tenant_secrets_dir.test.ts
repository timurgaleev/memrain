/**
 * `tenant create` and `purge-deleted` with the file backend run inside the
 * hosting `tenant-ctl` container, which mounts the host's provisioned-secrets
 * directory and names it in MEMRAIN_TENANT_SECRETS_DIR. Writing anywhere else
 * would lose the secrets with the container.
 */
import { describe, expect, it } from "bun:test";
import { tenantSecretsDir } from "../src/commands/tenant.ts";

describe("tenantSecretsDir", () => {
  it("uses the mounted directory the hosting compose names", () => {
    expect(tenantSecretsDir({}, { MEMRAIN_TENANT_SECRETS_DIR: "/provisioned" })).toBe("/provisioned");
  });
  it("lets --secrets-dir win over the environment", () => {
    expect(tenantSecretsDir({ "secrets-dir": "/elsewhere" }, { MEMRAIN_TENANT_SECRETS_DIR: "/provisioned" })).toBe("/elsewhere");
  });
  it("keeps the working-directory default when neither is set", () => {
    expect(tenantSecretsDir({}, {})).toBe("./tenant-secrets");
  });
});
