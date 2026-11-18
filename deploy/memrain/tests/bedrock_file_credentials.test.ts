/**
 * Bedrock credentials of a hosted tenant container come from a file the host
 * rewrites before they expire (deploy/tenant/bedrock-credentials.sh). The
 * client reads the file again whenever the SDK asks, which it does once the
 * credentials it holds are within five minutes of expiring, so a rotation is
 * picked up without a restart; an expired file fails at once with a clear
 * error instead of hanging. Outside hosting mode nothing changes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { bedrockClientConfig } from "../src/core/llm/gateway.ts";
import { BEDROCK_CREDENTIALS_FILE_ENV, fileCredentials } from "../src/core/llm/bedrock-credentials.ts";
import { HOSTING_ENV } from "../src/control/contract.ts";

const NAMES = [...Object.values(HOSTING_ENV), BEDROCK_CREDENTIALS_FILE_ENV];
let saved: Map<string, string | undefined>;
let dir: string;
let file: string;

beforeEach(() => {
  saved = new Map(NAMES.map((n) => [n, process.env[n]]));
  for (const n of NAMES) delete process.env[n];
  dir = mkdtempSync(join(tmpdir(), "memrain-bedrock-creds-"));
  file = join(dir, "credentials.json");
});
afterEach(() => {
  for (const [n, v] of saved) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Written the way the host refresher writes it: beside the target, then renamed over it. */
function write(key: string, expiresInMs: number): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({
    Version: 1, AccessKeyId: key, SecretAccessKey: `secret-${key}`, SessionToken: `token-${key}`,
    Expiration: new Date(Date.now() + expiresInMs).toISOString(),
  }));
  renameSync(tmp, file);
}

function hosted(): void {
  process.env["MEMRAIN_TENANT_ID"] = "acme";
  process.env[BEDROCK_CREDENTIALS_FILE_ENV] = file;
}

/** A client that signs, records the access key it signed with, and sends nothing. */
function recordingClient(seen: string[]): BedrockRuntimeClient {
  return new BedrockRuntimeClient({
    region: "eu-west-1",
    ...bedrockClientConfig(5_000),
    maxAttempts: 1,
    requestHandler: {
      handle: async (req: { headers: Record<string, string> }) => {
        const auth = req.headers["authorization"] ?? "";
        seen.push(/Credential=([^/]+)\//.exec(auth)?.[1] ?? "none");
        throw Object.assign(new Error("stop after signing"), { name: "StopAfterSigning" });
      },
    } as never,
  });
}

const call = (c: BedrockRuntimeClient) =>
  c.send(new ConverseCommand({ modelId: "m", messages: [{ role: "user", content: [{ text: "hi" }] }] })).catch((e: Error) => e);

describe("Bedrock credentials from a file", () => {
  it("outside hosting mode the client config is untouched, even with the variable set", () => {
    process.env[BEDROCK_CREDENTIALS_FILE_ENV] = file;
    expect("credentials" in bedrockClientConfig(1_000)).toBe(false);
  });

  it("a hosted container without the variable fails closed instead of using the SDK's own chain", async () => {
    process.env["MEMRAIN_TENANT_ID"] = "acme";
    process.env["AWS_ACCESS_KEY_ID"] = "AKIAFROMENV";
    process.env["AWS_SECRET_ACCESS_KEY"] = "secret-from-env";
    try {
      const seen: string[] = [];
      const err = await call(recordingClient(seen));
      expect(String((err as Error).message)).toContain(BEDROCK_CREDENTIALS_FILE_ENV);
      expect(seen).toEqual([]);
    } finally {
      delete process.env["AWS_ACCESS_KEY_ID"];
      delete process.env["AWS_SECRET_ACCESS_KEY"];
    }
  });

  it("picks up a rotated file without a restart", async () => {
    hosted();
    const seen: string[] = [];
    const client = recordingClient(seen);
    write("AKIAFIRST", 4 * 60_000);
    await call(client);
    write("AKIASECOND", 60 * 60_000);
    await call(client);
    expect(seen).toEqual(["AKIAFIRST", "AKIASECOND"]);
  });

  it("an expired or missing file fails at once with a clear error, before anything is sent", async () => {
    hosted();
    const seen: string[] = [];
    const client = recordingClient(seen);
    write("AKIAOLD", -60_000);
    const started = Date.now();
    const err = await call(client);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(String((err as Error).message)).toMatch(/expired.*credentials\.json|credentials\.json.*expired/i);
    expect((err as Error).name).toBe("ExpiredTokenException");
    rmSync(file);
    const missing = await call(client);
    expect(String((missing as Error).message)).toContain("credentials.json");
    expect(seen).toEqual([]);
  });

  it("reads the file on every request for credentials", async () => {
    write("AKIAONE", 60 * 60_000);
    const provider = fileCredentials(file);
    expect((await provider()).accessKeyId).toBe("AKIAONE");
    write("AKIATWO", 60 * 60_000);
    const second = await provider();
    expect(second.accessKeyId).toBe("AKIATWO");
    expect(second.expiration?.getTime()).toBeGreaterThan(Date.now());
  });
});
