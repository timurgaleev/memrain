/**
 * Bedrock credentials of a hosted tenant container, read from a file.
 *
 * A tenant container has no instance role (the metadata hop limit keeps it
 * out) and no long-lived key. The host assumes a Bedrock-only role per tenant
 * and writes the short-lived credentials to the tenant's own file before they
 * expire (deploy/tenant/bedrock-credentials.sh, on a systemd timer); the
 * container mounts only its own directory, read-only, and names the file in
 * MEMRAIN_BEDROCK_CREDENTIALS_FILE.
 *
 * The provider reads the file every time the SDK asks. The SDK keeps what it
 * got only until five minutes before its expiration, so nothing is cached past
 * the expiry and a rewritten file is picked up without a restart. An expired,
 * missing or malformed file fails the call at once, before anything is sent,
 * with an error that names the file.
 *
 * Only in hosting mode, and then always: a hosted container with no file named
 * refuses every call rather than use the SDK's own chain. Elsewhere the
 * variable is ignored and the SDK's chain applies, as before.
 */
import { readFileSync } from "node:fs";
import { hostingMode } from "../../control/contract.ts";

export const BEDROCK_CREDENTIALS_FILE_ENV = "MEMRAIN_BEDROCK_CREDENTIALS_FILE";

/** What an AWS SDK credentials provider resolves to. */
export interface AwsCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

/** The file the host writes: the shape `aws sts assume-role` returns, plus `Version`. */
interface CredentialFile {
  AccessKeyId?: unknown;
  SecretAccessKey?: unknown;
  SessionToken?: unknown;
  Expiration?: unknown;
}

function failure(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

export function fileCredentials(path: string, now: () => number = Date.now): () => Promise<AwsCredentialIdentity> {
  return async () => {
    let doc: CredentialFile;
    try {
      doc = JSON.parse(readFileSync(path, "utf8")) as CredentialFile;
    } catch (err) {
      throw failure("CredentialsProviderError",
        `cannot read the Bedrock credentials in ${path} (${err instanceof Error ? err.message : String(err)}); the host refresher writes them`);
    }
    const { AccessKeyId: id, SecretAccessKey: secret, SessionToken: token, Expiration: exp } = doc;
    const expiration = typeof exp === "string" ? new Date(exp) : null;
    if (typeof id !== "string" || !id || typeof secret !== "string" || !secret || !expiration || Number.isNaN(expiration.getTime())) {
      throw failure("CredentialsProviderError", `the Bedrock credentials in ${path} are malformed; the host refresher rewrites them`);
    }
    if (expiration.getTime() <= now()) {
      throw failure("ExpiredTokenException",
        `the Bedrock credentials in ${path} expired at ${expiration.toISOString()}; the host refresher (memrain-tenant-bedrock-credentials.timer) has not rewritten them`);
    }
    return {
      accessKeyId: id,
      secretAccessKey: secret,
      ...(typeof token === "string" && token ? { sessionToken: token } : {}),
      expiration,
    };
  };
}

/**
 * `{ credentials }` for a Bedrock client in a hosted container: its file, or,
 * with none named, a provider that refuses, so a hosted container never falls
 * back to whatever the SDK's own chain finds. Outside hosting mode, nothing.
 */
export function bedrockCredentialsConfig(env: NodeJS.ProcessEnv = process.env): { credentials?: () => Promise<AwsCredentialIdentity> } {
  if (hostingMode(env) === null) return {};
  const path = env[BEDROCK_CREDENTIALS_FILE_ENV]?.trim();
  if (path) return { credentials: fileCredentials(path) };
  return {
    credentials: async () => {
      throw failure("CredentialsProviderError",
        `a hosted brain takes its Bedrock credentials only from a file, and ${BEDROCK_CREDENTIALS_FILE_ENV} names none`);
    },
  };
}
