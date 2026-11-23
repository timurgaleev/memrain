/**
 * This build refuses to start in an environment meant for a wrapped,
 * multi-tenant deployment, and refuses any extension. The page writer and the
 * spend chokepoint no longer consult an extension's page-add gate or spend
 * hold, so either would otherwise run with those gates open.
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { assertNotWrapped } from "../src/core/startup-guard.ts";
import { extension, registerExtension } from "../src/core/extension.ts";
import { runServe } from "../src/commands/serve.ts";
import { isEnvOnlyKey, isNeverStoredKey } from "../src/core/runtime-config.ts";

setDefaultTimeout(60_000);

const WRAPPED = [{ MEMRAIN_TENANT_ID: "acme" }, { MEMRAIN_CONTROL_URL: "postgres://control.invalid/x" }];

describe("startup guard", () => {
  // Value: protects=a wrapped deployment's env never boots this build with its gates open;
  // fails_when=either marker is ignored; why_new=the gates it relied on were removed; seam=none
  it("refuses either wrapped-only variable and ignores blank ones", () => {
    for (const env of WRAPPED) expect(() => assertNotWrapped(env)).toThrow(/refusing to start/);
    expect(() => assertNotWrapped({ MEMRAIN_TENANT_ID: "  ", MEMRAIN_CONTROL_URL: "" })).not.toThrow();
    expect(() => assertNotWrapped({})).not.toThrow();
  });

  // Value: protects=no extension can register and expect its hooks to run; fails_when=a
  // registration is accepted again; why_new=same; seam=none
  it("refuses every extension, and every hook stays the default", async () => {
    expect(() => registerExtension({ name: "wrapped", holdSpend: async () => null })).toThrow(/refused/);
    expect(extension().name).toBe("none");
    expect(await extension().holdSpend({ operation: "x", model: "m" } as never, 1, {} as never)).toBeNull();
  });

  // Value: protects=serve refuses before it opens anything; fails_when=runServe drops the
  // guard; why_new=same; seam=none
  it("serve refuses to start under a wrapped environment", async () => {
    const prior = process.env.MEMRAIN_TENANT_ID;
    process.env.MEMRAIN_TENANT_ID = "acme";
    try {
      await expect(runServe({ http: true, host: "127.0.0.1", port: 0 })).rejects.toThrow(/refusing to start/);
    } finally {
      if (prior === undefined) delete process.env.MEMRAIN_TENANT_ID;
      else process.env.MEMRAIN_TENANT_ID = prior;
    }
  });

  // Value: protects=every CLI command refuses, not only serve; fails_when=the CLI entry
  // drops the guard; why_new=same; seam=none
  it("the CLI refuses any command under a wrapped environment", () => {
    for (const env of WRAPPED) {
      const child = Bun.spawnSync([process.execPath, "src/cli.ts", "status"], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(child.stderr) + new TextDecoder().decode(child.stdout)).toContain("refusing to start");
    }
  });

  // Value: protects=the stored config can neither set a marker nor hold the control URL;
  // fails_when=either key leaves the env-only lists; why_new=moved from the hook test; seam=none
  it("the stored config can set neither marker, and never stores the control URL", () => {
    expect(isEnvOnlyKey("MEMRAIN_TENANT_ID")).toBe(true);
    expect(isEnvOnlyKey("MEMRAIN_CONTROL_URL")).toBe(true);
    expect(isNeverStoredKey("MEMRAIN_CONTROL_URL")).toBe(true);
  });
});
