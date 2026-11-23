/**
 * Prints, as one JSON line, how the server resolves a set of env-driven knobs.
 * The first import is the env shim, exactly as in src/cli.ts, so this process
 * sees the environment the way every entry point does. Used by
 * env_compat_boot.test.ts; never run by the server.
 */
import "../../src/core/env-compat.ts";
import { makeEngine } from "../../src/core/engine/factory.ts";
import type { Config } from "../../src/core/config.ts";
import { oauthRequireLoginFromEnv } from "../../src/core/oauth-provider.ts";
import { tenantFailClosedEnabled } from "../../src/core/auth-info.ts";
import { resolveQuiescence } from "../../src/core/quiescence.ts";
import { resolveIssuer } from "../../src/http/oauth-metadata.ts";
import { isPublicMcpToolForbidden } from "../../src/http/public_guard.ts";

let engine: string;
try {
  engine = makeEngine({ database: { type: "postgres" } } as Config).constructor.name;
} catch {
  engine = "none";
}

console.log(
  JSON.stringify({
    postgresUrl: process.env.MEMRAIN_POSTGRES_URL ?? null,
    engine,
    issuer: resolveIssuer(new URL("http://127.0.0.1:18790/")),
    oauthRequireLogin: oauthRequireLoginFromEnv(),
    publicWrite: !isPublicMcpToolForbidden("page_put"),
    tenantFailClosed: tenantFailClosedEnabled(),
    quiescence: resolveQuiescence(),
  }),
);
