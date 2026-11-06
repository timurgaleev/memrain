import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const AMBIENT = ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN"];

describe("hermetic test env", () => {
  it("removes ambient AWS credentials and profile", () => {
    for (const k of AMBIENT) expect(process.env[k]).toBeUndefined();
    expect(process.env.AWS_EC2_METADATA_DISABLED).toBe("true");
    expect(process.env.AWS_CONFIG_FILE).toBe("/nonexistent/aws-config");
    expect(process.env.AWS_SHARED_CREDENTIALS_FILE).toBe("/nonexistent/aws-credentials");
  });

  // The check above passes vacuously on a machine with no AWS env at all, so
  // plant every variable in a child `bun test` run and read back what it saw.
  it("strips planted AWS credentials from a child bun test run", async () => {
    const planted = Object.fromEntries(AMBIENT.map((k) => [k, `dummy-${k}`]));
    const proc = Bun.spawn(["bun", "test", "./tests/fixtures/hermetic-probe.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, ...planted },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(await proc.exited).toBe(0);
    const line = `${out}\n${err}`.split("\n").find((l) => l.startsWith("HERMETIC_PROBE "));
    expect(line).toBeDefined();
    const seen = JSON.parse(line!.slice("HERMETIC_PROBE ".length)) as string[];
    expect(seen.filter((k) => k in planted)).toEqual([]);
    expect(seen).toContain("AWS_EC2_METADATA_DISABLED");
  });
});
