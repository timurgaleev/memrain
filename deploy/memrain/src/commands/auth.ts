/**
 * `memrain auth <subcommand>` — manage the self-issued OAuth 2.1 provider
 * (client_credentials). The auth surface: register a client, mint a token,
 * present it as `Authorization: Bearer memrain_at_…` on `/mcp`.
 *
 * Subcommands:
 *   register-client <name> [--grant-types G] [--scopes S] [--source SRC]
 *                          [--redirect-uris u1,u2] [--bound-slug-prefixes p1,p2]
 *                          [--access-ttl 1h] [--refresh-ttl 30d]
 *              --redirect-uris makes it an authorization-code (browser) client
 *              — e.g. a hosted MCP connector's callback. Grants then default to
 *              authorization_code,refresh_token unless --grant-types is given.
 *                          [--federated-read a,b,c]
 *              Register a confidential client. Prints client_id (memrain_cl_…) +
 *              client_secret (memrain_cs_…) ONCE — only the SHA-256 hash persists.
 *   list-clients
 *              JSON list of registered clients (no secrets).
 *   revoke-client <client_id> [--purge]
 *              Revoke a client: mark it deleted and delete its tokens and
 *              codes. The row, its grant history and its spend stay. --purge
 *              hard-deletes the row instead (a source it names can then be
 *              removed); the grant history still stays.
 *   set-redirect-uris <client_id> <uri> [uri...] [--expected-revision N]
 *              Replace a client's redirect URIs without touching its secret or
 *              tokens (https, or http on a loopback host). Audited; codes
 *              minted before the change stop redeeming.
 *   enroll <source> [--label NAME] [--client CLIENT_ID] [--ttl 7d] [--federated-read a,b]
 *          [--replaces ENROLLMENT_ID]
 *              Issue a one-time enrollment code bound to <source>. A person
 *              presents it at /authorize on an enrollment-mode client and her
 *              grant is pinned to that source. Printed ONCE. --replaces issues
 *              a new code for the same person: it inherits the old grant's
 *              spend key and daily cap (and its source, read set, label and
 *              client unless given), and redeeming it revokes the old grant.
 *   enrollments [--client CLIENT_ID]
 *              List issued codes (id, label, source, expiry, used/revoked,
 *              spend key, last token) — never the code itself.
 *   revoke-enrollment <enrollment_id>
 *              Kill an unused code.
 *   revoke-grant <enrollment_id>
 *              Cut off one person after she redeemed her code: revokes the
 *              enrollment and deletes every token minted under it. Others on
 *              the same connector keep working.
 *   set-budget <client_id|token_name> <usd-per-day|none>
 *              Set or clear the client's daily USD ceiling, enforced across
 *              every paid op. `none` removes the cap (the default).
 *   rescope-client <client_id> --source SRC [--federated-read a,b]
 *                              [--bound-slug-prefixes p1,p2] [--scopes read,write]
 *              Change an existing client's tenancy grant in place (write
 *              source + federated read set) — no revoke + re-register.
 *              --bound-slug-prefixes also replaces the slug write fence; pass
 *              an empty value ("") to lift it. Omit the flag to leave it as-is.
 *              --scopes replaces the client's scopes; tokens already issued
 *              are held to the narrower set from their next request on.
 *              --access-ttl / --refresh-ttl set the client's token lifetimes
 *              (access 5m..1d, refresh 1h..90d); "default" clears one.
 *   invalidate-tokens <client_id> [--grant ENROLLMENT_ID]
 *              Delete every access token, refresh token and code of the client
 *              (or of one enrollment grant on it). The client stays registered.
 *   grant-token <client_id> <client_secret> [--scopes S]
 *              Exchange client_credentials for an access token locally (for a
 *              handoff / smoke test) — equivalent to POST /token.
 *   create <name> [--takes-holders a,b] [--source SRC] [--federated-read a,b]
 *          [--scopes read,write]
 *              Mint a long-lived personal access token (access_tokens row).
 *              Prints the token ONCE — only the SHA-256 hash persists. Tenant
 *              scope comes from `permissions.source_id`: a scalar is
 *              write+read source, an array is a federated read set anchored on
 *              its first element. --source (a registered source) writes it;
 *              --federated-read adds read sources. --scopes is read and/or
 *              write (default both).
 *   list       Table of personal access tokens (no hashes).
 *   revoke <name>
 *              Soft-revoke a personal access token by name.
 *   permissions <name> set-takes-holders a,b
 *              Replace the token's takes-visibility allow-list.
 *   permissions <name> set-scopes read,write,admin
 *              Replace the token's scopes. Both permissions changes, and
 *              set-budget on a token, are audited as `pat:<id>` in the grant
 *              history.
 *   doctor <base-url> (--client-file F | --token-file F)
 *          [--expect-source ID | --expect-operator] [--expect-version STAMP] [--json]
 *              Client-side end-to-end check of a deployed brain (see
 *              remote-doctor.ts). Credentials come from a 0600 file only.
 */
import { createHash, randomBytes } from "node:crypto";
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  defaultConfigPath,
  defaultYamlPath,
  loadConfig,
  YAML_NAME,
  type Config,
} from "../core/config.ts";
import { patNameSpendConflict } from "../core/budget.ts";
import {
  OAuthProvider,
  needsOperatorConsent,
  oauthRequireLoginFromEnv,
  parseTenantMode,
  resolvePatGrant,
} from "../core/oauth-provider.ts";
import {
  DoctorUsageError,
  formatDoctorReport,
  readCredentialFile,
  runRemoteDoctor,
  type DoctorOptions,
} from "./remote-doctor.ts";

/** Accepted on a token row. Mirrors core/scope.ts; a typo here would otherwise
 *  be written straight to the column and silently deny everything. */
const KNOWN_TOKEN_SCOPES = [
  "read",
  "write",
  "admin",
  "agent",
];

export type AuthSub =
  | "register-client"
  | "list-clients"
  | "revoke-client"
  | "set-redirect-uris"
  | "rescope-client"
  | "grant-history"
  | "set-budget"
  | "enroll"
  | "enrollments"
  | "revoke-enrollment"
  | "revoke-grant"
  | "invalidate-tokens"
  | "grant-token"
  | "create"
  | "list"
  | "revoke"
  | "permissions"
  | "test"
  | "doctor";

interface ClientRow {
  client_id: string;
  client_name: string;
  grant_types: string[];
  scope: string | null;
  source_id: string | null;
  federated_read: string[] | null;
  tenant_mode: string;
  grant_revision: number;
  client_id_issued_at: number | null;
}

/**
 * `--dry-run` is the one `auth` flag without a value. It parses to "true" (or
 * the literal given with `=`), so a bare `--dry-run` is never mistaken for a
 * flag missing its value.
 */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["dry-run", "expect-operator", "json", "purge"]);

/**
 * Split on the first '=' for `--key=value` (redirect URIs and scope strings
 * carry more of them); every other flag takes the next argument as its value.
 *
 * Exported for tests.
 */
export function parseFlags(args: string[]): {
  positional: string[];
  flags: Record<string, string>;
} {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = "true";
        continue;
      }
      const val = args[i + 1];
      if (val === undefined || val.startsWith("--")) {
        throw new Error(`auth: flag --${key} needs a value`);
      }
      flags[key] = val;
      i++;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/** Read a boolean flag value; refuse anything that is not a clear yes or no. */
export function parseBoolFlag(name: string, raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  throw new Error(`--${name} is a boolean flag, got '${raw}'`);
}

/**
 * The stderr warning for minting a credential the server will not accept:
 * `serve` verifies PATs and OAuth clients only with self-issued auth on.
 */
export function selfIssuedOffWarning(config: Config, configPath: string): string | null {
  if (config.auth?.selfIssued?.enabled === true) return null;
  // Name the overlay that is actually read; a legacy overlay stays the one to edit.
  const read = defaultYamlPath(configPath);
  const yamlPath = existsSync(read) ? read : join(dirname(configPath), YAML_NAME);
  return (
    `[memrain] warning: auth.selfIssued is off, so tokens will not be accepted until ` +
    `auth.selfIssued.enabled: true is set in ${yamlPath}`
  );
}

function warnIfSelfIssuedOff(): void {
  const configPath = defaultConfigPath();
  const warning = selfIssuedOffWarning(loadConfig(configPath), configPath);
  if (warning) console.error(warning);
}

async function withProvider<T>(
  fn: (provider: OAuthProvider, storage: Storage) => Promise<T>,
): Promise<T> {
  const storage = new Storage(loadConfig());
  return withStorage(storage, async () => {
    return await fn(new OAuthProvider({ engine: storage.raw() }), storage);
  });
}

async function registerClient(name: string, rest: string[]): Promise<void> {
  if (!name) throw new Error("Usage: auth register-client <name> [flags]");
  const { flags } = parseFlags(rest);
  const redirectUris = flags["redirect-uris"]
    ? flags["redirect-uris"].split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  // RFC 7591 token_endpoint_auth_method. The provider already validates and
  // supports 'none' (public client, PKCE-only, NO secret minted) — this flag
  // finally makes it reachable from the CLI. Omitted → provider default.
  const tokenEndpointAuthMethod = flags["token-endpoint-auth-method"];
  // A client with a redirect_uri is an authorization-code (browser) client, so
  // default its grants accordingly when the operator didn't say otherwise.
  // Without a redirect_uri, default to client_credentials.
  const grantTypes = (
    flags["grant-types"] ??
    (redirectUris.length > 0
      ? "authorization_code,refresh_token"
      : "client_credentials")
  )
    .split(/[\s,]+/)
    .filter(Boolean);
  const scopes = flags["scopes"] ?? "read";
  const sourceId = flags["source"] ?? "default";
  const federatedRead = flags["federated-read"]
    ? flags["federated-read"].split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  // Slug-prefix write fence: confines the client's write ops to slugs under
  // these prefixes (deny-by-default for slug-less write tools). Optional.
  const boundSlugPrefixes = flags["bound-slug-prefixes"]
    ? flags["bound-slug-prefixes"].split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const tenantMode = parseTenantMode(flags["tenant-mode"]);
  const accessTtlSeconds = parseClientTtlFlag("access-ttl", flags["access-ttl"]);
  const refreshTtlSeconds = parseClientTtlFlag("refresh-ttl", flags["refresh-ttl"]);
  if (
    tokenEndpointAuthMethod === "none" &&
    needsOperatorConsent({ tenant_mode: tenantMode }) &&
    !oauthRequireLoginFromEnv()
  ) {
    throw new Error(
      "Refusing a public client in client tenant mode: with /authorize " +
        "auto-approving, its client_id alone would mint tokens for source " +
        `'${sourceId}'. Register a confidential client (drop ` +
        "--token-endpoint-auth-method none), use --tenant-mode enrollment, or " +
        "run with MEMRAIN_OAUTH_REQUIRE_LOGIN=1 as the server does.",
    );
  }

  warnIfSelfIssuedOff();
  const { clientId, clientSecret } = await withProvider((p) =>
    p.registerClientManual(
      name,
      grantTypes,
      scopes,
      redirectUris,
      sourceId,
      federatedRead,
      tokenEndpointAuthMethod,
      boundSlugPrefixes,
      tenantMode,
      { accessTtlSeconds, refreshTtlSeconds },
    ),
  );
  // The secret is shown ONCE — only its hash is stored.
  console.log(
    JSON.stringify(
      {
        client_id: clientId,
        client_secret: clientSecret ?? null,
        client_name: name,
        grant_types: grantTypes,
        scope: scopes,
        source_id: sourceId,
        federated_read: federatedRead ?? [sourceId],
        tenant_mode: tenantMode,
        access_ttl_seconds: accessTtlSeconds ?? null,
        refresh_ttl_seconds: refreshTtlSeconds ?? null,
        ...(tokenEndpointAuthMethod
          ? { token_endpoint_auth_method: tokenEndpointAuthMethod }
          : {}),
        note:
          clientSecret === undefined
            ? "Public client (auth method 'none') — no secret minted; PKCE authenticates."
            : "Store client_secret now — it is not recoverable.",
      },
      null,
      2,
    ),
  );
}

async function listClients(): Promise<void> {
  const rows = await withProvider((_p, storage) =>
    storage
      .raw()
      .query<ClientRow>(
        `SELECT client_id, client_name, grant_types, scope, source_id,
                federated_read, tenant_mode, grant_revision, client_id_issued_at
           FROM oauth_clients WHERE deleted_at IS NULL
           ORDER BY client_id_issued_at`,
      )
      .then((r) => r.rows),
  );
  console.log(JSON.stringify(rows, null, 2));
}

async function revokeClient(clientId: string, args: string[]): Promise<void> {
  if (!clientId) throw new Error("Usage: auth revoke-client <client_id> [--purge]");
  const { flags } = parseFlags(args);
  if (parseBoolFlag("purge", flags["purge"])) {
    // The row goes, and its tokens and codes with it (FK cascade). The grant
    // history has no FK and outlives it.
    const deleted = await withProvider((_p, storage) =>
      storage
        .raw()
        .query<{ client_id: string }>(
          "DELETE FROM oauth_clients WHERE client_id = $1 RETURNING client_id",
          [clientId],
        )
        .then((r) => r.rows.length),
    );
    console.log(JSON.stringify({ revoked: deleted > 0, purged: deleted > 0, client_id: clientId }, null, 2));
    return;
  }
  const r = await withProvider((p) => p.revokeClient(clientId, { actor: cliActor(), via: "cli" }));
  console.log(
    JSON.stringify(
      {
        revoked: r.revoked,
        client_id: r.clientId,
        revision: r.revision,
        deleted: {
          access_tokens: r.deleted.accessTokens,
          refresh_tokens: r.deleted.refreshTokens,
          codes: r.deleted.codes,
        },
      },
      null,
      2,
    ),
  );
}

async function setRedirectUris(clientId: string, args: string[]): Promise<void> {
  const usage = "Usage: auth set-redirect-uris <client_id> <uri> [uri...] [--expected-revision N]";
  if (!clientId) throw new Error(usage);
  const { positional, flags } = parseFlags(args);
  // A comma list works too, as for register-client --redirect-uris.
  const uris = positional.flatMap((u) => u.split(",")).map((u) => u.trim()).filter(Boolean);
  if (uris.length === 0) throw new Error(usage);
  const expectedRevision = parseExpectedRevision(flags["expected-revision"]);
  const r = await withProvider((p) =>
    p.setRedirectUris(clientId, uris, { actor: cliActor(), via: "cli", expectedRevision }),
  );
  console.log(
    JSON.stringify(
      { client_id: r.clientId, revision: r.revision, before: r.before, after: r.after, removed: r.removed },
      null,
      2,
    ),
  );
}

/**
 * `--bound-slug-prefixes` is tri-state on rescope: the flag absent leaves the
 * stored fence untouched, an empty value clears it (unbounded), a list replaces
 * it. Exported because that distinction is exactly what a truthiness check on
 * the flag gets wrong — `""` must mean CLEAR, not ABSENT.
 */
export function parseFenceFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Who ran a CLI grant change, recorded in the audit row as data only — it
 * authorizes nothing (the CLI already runs with database access).
 */
export function cliActor(env: Record<string, string | undefined> = process.env): string {
  const pick = (v: string | undefined) => (v && v.trim().length > 0 ? v.trim() : undefined);
  return pick(env.MEMRAIN_OPERATOR) ?? pick(env.USER) ?? "cli";
}

/** Parse `--expected-revision`; undefined when absent. */
export function parseExpectedRevision(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d{1,9}$/.test(raw)) {
    throw new Error(`--expected-revision must be a non-negative integer, got '${raw}'`);
  }
  return Number(raw);
}

/**
 * Parse `--access-ttl` / `--refresh-ttl` (`1h`, `30d`, seconds). Undefined when
 * the flag is absent; `default` (or `none`) is null, which clears an override
 * on rescope. The provider enforces the bounds.
 */
export function parseClientTtlFlag(name: string, raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === "default" || raw === "none") return null;
  if (raw.trim() === "") throw new Error(`--${name} needs a value like 1h or 30d`);
  try {
    return parseTtl(raw, 0);
  } catch {
    throw new Error(`--${name} must look like 15m, 1h, 30d or 3600s (got '${raw}')`);
  }
}

async function rescopeClient(clientId: string, args: string[]): Promise<void> {
  const usage =
    "Usage: auth rescope-client <client_id> --source SRC [--federated-read a,b] [--bound-slug-prefixes p1,p2] [--tenant-mode client|enrollment] [--scopes read,write] [--access-ttl 1h|default] [--refresh-ttl 30d|default] [--expected-revision N] [--dry-run]";
  if (!clientId) throw new Error(usage);
  const { flags } = parseFlags(args);
  const dryRun = parseBoolFlag("dry-run", flags["dry-run"]);
  const sourceId = flags["source"];
  if (!sourceId) throw new Error(usage);
  const federatedRead = flags["federated-read"]
    ? flags["federated-read"].split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  // Lift an existing fence with:
  //   auth rescope-client <id> --source <src> --bound-slug-prefixes ""
  const boundSlugPrefixes = parseFenceFlag(flags["bound-slug-prefixes"]);
  const tenantMode = flags["tenant-mode"] !== undefined ? parseTenantMode(flags["tenant-mode"]) : undefined;
  // An empty list reaches the provider, which refuses it with invalid_scope.
  const scopes = flags["scopes"] !== undefined
    ? flags["scopes"].split(/[\s,]+/).filter(Boolean)
    : undefined;
  const expectedRevision = parseExpectedRevision(flags["expected-revision"]);
  const accessTtlSeconds = parseClientTtlFlag("access-ttl", flags["access-ttl"]);
  const refreshTtlSeconds = parseClientTtlFlag("refresh-ttl", flags["refresh-ttl"]);
  const result = await withProvider((p) =>
    p.rescopeClient(
      clientId,
      { sourceId, federatedRead, boundSlugPrefixes, tenantMode, scopes, accessTtlSeconds, refreshTtlSeconds },
      { actor: cliActor(), via: "cli", expectedRevision, dryRun },
    ),
  );
  console.log(
    JSON.stringify(
      {
        client_id: result.clientId,
        dry_run: result.dryRun,
        revision: result.revision,
        changed: result.changed,
        before: result.before,
        after: result.after,
        revoked_unbound: {
          access_tokens: result.revokedUnbound.accessTokens,
          refresh_tokens: result.revokedUnbound.refreshTokens,
          codes: result.revokedUnbound.codes,
        },
        access_ttl_seconds: result.ttls.accessTtlSeconds,
        refresh_ttl_seconds: result.ttls.refreshTtlSeconds,
      },
      null,
      2,
    ),
  );
}

async function invalidateTokens(clientId: string, args: string[]): Promise<void> {
  if (!clientId) throw new Error("Usage: auth invalidate-tokens <client_id> [--grant ENROLLMENT_ID]");
  const { flags } = parseFlags(args);
  const r = await withProvider((p) =>
    p.invalidateClientTokens(clientId, {
      actor: cliActor(),
      via: "cli",
      ...(flags["grant"] ? { grantId: flags["grant"] } : {}),
    }),
  );
  console.log(
    JSON.stringify(
      {
        client_id: r.clientId,
        grant_id: r.grantId,
        revision: r.revision,
        deleted: {
          access_tokens: r.deleted.accessTokens,
          refresh_tokens: r.deleted.refreshTokens,
          codes: r.deleted.codes,
        },
      },
      null,
      2,
    ),
  );
}

async function grantHistory(clientId: string, args: string[]): Promise<void> {
  if (!clientId) throw new Error("Usage: auth grant-history <client_id> [--limit N]");
  const { flags } = parseFlags(args);
  const limit = flags["limit"] !== undefined ? Number(flags["limit"]) : 100;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`--limit must be a positive integer, got '${flags["limit"]}'`);
  }
  const rows = await withProvider((p) => p.listGrantAudit(clientId, limit));
  console.log(JSON.stringify(rows, null, 2));
}

/**
 * Set or clear a client's daily USD ceiling. The column existed and was read by
 * every paid op's budget check, but nothing could WRITE it outside of hand-
 * editing the database — so a cap was in practice unsettable.
 */
async function setBudget(clientId: string, amount: string): Promise<void> {
  const usage = "Usage: auth set-budget <client_id|token_name> <usd-per-day|none>";
  if (!clientId || amount === undefined) throw new Error(usage);
  let usdPerDay: number | null;
  if (amount === "none" || amount === "null" || amount === "") {
    usdPerDay = null;
  } else {
    usdPerDay = Number(amount);
    if (!Number.isFinite(usdPerDay)) throw new Error(usage);
  }
  const updated = await withProvider((p) =>
    p.setClientBudget(clientId, usdPerDay, { actor: cliActor(), via: "cli" }),
  );
  if (!updated) throw new Error(`No active client or token "${clientId}".`);
  console.log(
    JSON.stringify(
      { client_id: clientId, budget_usd_per_day: usdPerDay, updated: true },
      null,
      2,
    ),
  );
}

/** Parse `7d`, `24h`, `90m`, `3600s` or a bare number of seconds. */
export function parseTtl(raw: string | undefined, fallbackSeconds: number): number {
  if (raw === undefined || raw === "") return fallbackSeconds;
  const m = /^(\d+)([smhd])?$/.exec(raw.trim());
  if (!m) throw new Error(`--ttl must look like 7d, 24h, 90m or 3600s (got '${raw}')`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  const mult = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  const seconds = n * mult;
  // The provider bounds this too; catching it here gives the operator the flag
  // they typed instead of a RangeError from deep inside a Date constructor.
  if (!Number.isSafeInteger(seconds) || seconds > 365 * 24 * 3600) {
    throw new Error(`--ttl is too large (max 365d), got '${raw}'`);
  }
  return seconds;
}

/**
 * Issue a one-time enrollment code for `source`. Printed ONCE, like a client
 * secret: only its hash is stored. Hand it to the person over a channel you
 * would trust with a password; it dies on first use.
 */
async function enroll(rest: string[]): Promise<void> {
  const usage =
    "Usage: auth enroll <source> [--label NAME] [--client CLIENT_ID] [--ttl 7d] [--federated-read a,b] [--replaces ENROLLMENT_ID]";
  const { positional, flags } = parseFlags(rest);
  const source = positional[0];
  const replaces = flags["replaces"];
  if (!source && !replaces) throw new Error(usage);
  const federatedRead = flags["federated-read"]
    ? flags["federated-read"].split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const issued = await withProvider((p) =>
    p.issueEnrollment(
      {
        ...(source ? { sourceId: source } : {}),
        ...(federatedRead ? { federatedRead } : {}),
        ...(flags["label"] ? { label: flags["label"] } : {}),
        ...(flags["client"] ? { clientId: flags["client"] } : {}),
        ...(replaces ? { replaces } : {}),
        ttlSeconds: parseTtl(flags["ttl"], 7 * 24 * 3600),
      },
      { actor: cliActor(), via: "cli" },
    ),
  );
  console.log(
    JSON.stringify(
      {
        enrollment_id: issued.id,
        code: issued.code,
        source_id: issued.sourceId,
        federated_read: issued.federatedRead,
        ...(issued.label ? { label: issued.label } : {}),
        ...(issued.clientId ? { client_id: issued.clientId } : {}),
        spend_id: issued.spendId,
        ...(issued.replaces ? { replaces: issued.replaces } : {}),
        expires_at: issued.expiresAt,
        note: issued.replaces
          ? "Give this code to the person. It works once; redeeming it revokes the grant it replaces."
          : "Give this code to the person. It works once, then never again.",
      },
      null,
      2,
    ),
  );
}

async function listEnrollments(rest: string[]): Promise<void> {
  const { flags } = parseFlags(rest);
  const rows = await withProvider((p) => p.listEnrollments(flags["client"]));
  console.log(JSON.stringify(rows, null, 2));
}

async function revokeEnrollment(id: string): Promise<void> {
  if (!id) throw new Error("Usage: auth revoke-enrollment <enrollment_id>");
  const ok = await withProvider((p) => p.revokeEnrollment(id, { actor: cliActor(), via: "cli" }));
  if (!ok) throw new Error(`No live enrollment "${id}" (already used, revoked, or unknown).`);
  console.log(JSON.stringify({ enrollment_id: id, revoked: true }, null, 2));
}

async function revokeGrant(id: string): Promise<void> {
  if (!id) throw new Error("Usage: auth revoke-grant <enrollment_id>");
  const r = await withProvider((p) => p.revokeGrant(id, { actor: cliActor(), via: "cli" }));
  if (!r.revoked) throw new Error(`No enrollment "${id}".`);
  console.log(JSON.stringify({ enrollment_id: id, revoked: true, tokens_deleted: r.tokens }, null, 2));
}

async function grantToken(
  clientId: string,
  clientSecret: string,
  rest: string[],
): Promise<void> {
  if (!clientId || !clientSecret) {
    throw new Error("Usage: auth grant-token <client_id> <client_secret> [--scopes S]");
  }
  const { flags } = parseFlags(rest);
  const tokens = await withProvider((p) =>
    p.exchangeClientCredentials(clientId, clientSecret, flags["scopes"]),
  );
  console.log(JSON.stringify(tokens, null, 2));
}

/** A comma list flag as a list; undefined when the flag is absent. */
function listFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function createToken(name: string, rest: string[]): Promise<void> {
  if (!name) {
    throw new Error(
      "Usage: auth create <name> [--takes-holders a,b] [--source SRC] [--federated-read a,b] [--scopes read,write]",
    );
  }
  const nameConflict = patNameSpendConflict(name);
  if (nameConflict !== null) throw new Error(nameConflict);
  const { flags } = parseFlags(rest);
  // Default ['world'] keeps private takes hidden from MCP-bound tokens
  // until the operator explicitly widens the allow-list.
  // A flag that parses to nothing (e.g. --takes-holders ",") falls back the
  // same way — an empty list stays default-deny.
  const parsedHolders = (flags["takes-holders"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const takesHolders = parsedHolders.length > 0 ? parsedHolders : ["world"];
  warnIfSelfIssuedOff();
  const token = "memrain_" + randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");

  const minted = await withProvider(async (_p, storage) => {
    const grant = await resolvePatGrant(storage.raw(), {
      ...(flags["source"] !== undefined ? { sourceId: flags["source"] } : {}),
      ...(flags["scopes"] !== undefined ? { scopes: listFlag(flags["scopes"])! } : {}),
      ...(flags["federated-read"] !== undefined ? { federatedRead: listFlag(flags["federated-read"])! } : {}),
    });
    const existing = await storage
      .raw()
      .query<{ id: number }>(
        "SELECT id FROM access_tokens WHERE name = $1 AND revoked_at IS NULL",
        [name],
      );
    if (existing.rows.length > 0) {
      throw new Error(
        `A token named "${name}" already exists. Revoke it first or use a different name.`,
      );
    }
    // JSONB params must be JS objects, not pre-stringified JSON: postgres.js
    // encodes a string bound to a jsonb position as a jsonb STRING (the
    // "double-encode bug class"), which breaks permissions.source_id scope
    // resolution.
    await storage.raw().query(
      // A re-minted name keeps its predecessor's daily cap: spend is booked
      // under the name, so a new row with no cap would silently uncap it.
      `INSERT INTO access_tokens (name, token_hash, scopes, permissions, budget_usd_per_day)
       VALUES ($1, $2, $3::text[], $4::jsonb,
               (SELECT p.budget_usd_per_day FROM access_tokens p
                 WHERE p.name = $1 ORDER BY p.id DESC LIMIT 1))`,
      [
        name,
        tokenHash,
        grant.scopes,
        {
          takes_holders: takesHolders,
          ...(grant.sourceGrant !== undefined ? { source_id: grant.sourceGrant } : {}),
        },
      ],
    );
    return grant;
  });
  console.log(
    JSON.stringify(
      {
        name,
        token,
        scopes: minted.scopes,
        ...(minted.sourceGrant !== undefined ? { source_id: minted.sourceGrant } : {}),
        takes_holders: takesHolders,
        note: "Store the token now — only its hash persists. Revoke with: memrain auth revoke <name>.",
      },
      null,
      2,
    ),
  );
}

async function listTokens(): Promise<void> {
  const rows = await withProvider((_p, storage) =>
    storage
      .raw()
      .query<{
        name: string;
        created_at: string;
        last_used_at: string | null;
        revoked_at: string | null;
        permissions: unknown;
      }>(
        `SELECT name, created_at, last_used_at, revoked_at, permissions
           FROM access_tokens ORDER BY created_at DESC`,
      )
      .then((r) => r.rows),
  );
  console.log(JSON.stringify(rows, null, 2));
}

async function revokeToken(name: string): Promise<void> {
  if (!name) throw new Error("Usage: auth revoke <name>");
  const revoked = await withProvider((_p, storage) =>
    storage
      .raw()
      .query<{ id: number }>(
        `UPDATE access_tokens SET revoked_at = now()
          WHERE name = $1 AND revoked_at IS NULL RETURNING id`,
        [name],
      )
      .then((r) => r.rows.length),
  );
  if (revoked === 0) {
    throw new Error(`No active token found with name "${name}".`);
  }
  console.log(JSON.stringify({ revoked: true, name }, null, 2));
}

/**
 * Record the scopes a personal access token actually holds.
 *
 * Tokens used to resolve to read+write+admin regardless of this column, so an
 * operator who relied on that grandfather needs a deliberate way to keep the
 * one admin-scoped tool (`purge_deleted_pages`). Naming the scopes is that way:
 * the grant becomes visible in `auth list` instead of implicit in the code.
 */
async function setScopes(name: string, value: string): Promise<void> {
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) {
    throw new Error("scope list cannot be empty");
  }
  const unknown = list.filter((s) => !KNOWN_TOKEN_SCOPES.includes(s));
  if (unknown.length > 0) {
    throw new Error(
      `unknown scope(s): ${unknown.join(", ")} — known: ${KNOWN_TOKEN_SCOPES.join(", ")}`,
    );
  }
  const changed = await withProvider((p) =>
    p.setPatScopes(name, list, { actor: cliActor(), via: "cli" }),
  );
  if (changed.length === 0) {
    throw new Error(`no live token named '${name}'`);
  }
  console.log(
    JSON.stringify({ name, scopes: list, revisions: changed.map((c) => c.revision) }, null, 2),
  );
}

async function setPermissions(
  name: string,
  action: string,
  value: string | undefined,
): Promise<void> {
  if (name && action === "set-scopes" && value) {
    return setScopes(name, value);
  }
  if (!name || action !== "set-takes-holders" || !value) {
    throw new Error(
      "Usage: auth permissions <name> set-takes-holders world,grace,brain\n" +
        "       auth permissions <name> set-scopes read,write,admin",
    );
  }
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) {
    throw new Error(
      'takes-holders list cannot be empty (use "world" for default-deny on private)',
    );
  }
  // The provider merges into permissions, so an operator-set
  // permissions.source_id tenant grant survives.
  const changed = await withProvider((p) =>
    p.setPatTakesHolders(name, list, { actor: cliActor(), via: "cli" }),
  );
  if (changed.length === 0) {
    throw new Error(`Token "${name}" not found.`);
  }
  console.log(
    JSON.stringify(
      { name, takes_holders: list, updated: true, revisions: changed.map((c) => c.revision) },
      null,
      2,
    ),
  );
}

export interface AuthTestStep {
  step: "initialize" | "tools/list" | "tools/call";
  ok: boolean;
  detail?: string;
}

export interface AuthTestResult {
  ok: boolean;
  url: string;
  steps: AuthTestStep[];
  toolCount: number;
  elapsedMs: number;
}

/** Parse an MCP HTTP response body (plain JSON or SSE `data:` lines). */
export function parseMcpBody(text: string): unknown {
  if (text.includes("event:") || text.startsWith("data:")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        return JSON.parse(line.slice(5));
      } catch {
        // non-JSON data line — keep scanning
      }
    }
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Live end-to-end MCP smoke against a deployed brain: initialize handshake,
 * tools/list, then a real tools/call (`stats`). The ship-verify gate in CLI
 * form. Exported with an injectable fetch so tests run hermetic.
 */
export async function runAuthTest(
  url: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<AuthTestResult> {
  // The bearer goes into the Authorization header of every probe — refuse to
  // leak it in cleartext to a non-local plain-http target.
  const parsed = new URL(url);
  const isLocal =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !isLocal) {
    throw new Error(
      `auth test: refusing to send the token over ${parsed.protocol}// to a non-local host — use https://`,
    );
  }
  const started = Date.now();
  const steps: AuthTestStep[] = [];
  const post = (body: Record<string, unknown>) =>
    fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });

  let toolCount = 0;
  // Step 1: initialize handshake.
  try {
    const res = await post({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "memrain-smoke-test", version: "1.0" },
      },
      id: 1,
    });
    if (!res.ok) {
      steps.push({ step: "initialize", ok: false, detail: `${res.status} ${res.statusText}` });
      return { ok: false, url, steps, toolCount, elapsedMs: Date.now() - started };
    }
    steps.push({ step: "initialize", ok: true });
  } catch (e) {
    steps.push({ step: "initialize", ok: false, detail: e instanceof Error ? e.message : String(e) });
    return { ok: false, url, steps, toolCount, elapsedMs: Date.now() - started };
  }

  // Step 2: tools/list.
  try {
    const res = await post({ jsonrpc: "2.0", method: "tools/list", params: {}, id: 2 });
    if (!res.ok) {
      steps.push({ step: "tools/list", ok: false, detail: `${res.status}` });
      return { ok: false, url, steps, toolCount, elapsedMs: Date.now() - started };
    }
    const data = parseMcpBody(await res.text()) as {
      result?: { tools?: unknown[] };
    } | null;
    toolCount = data?.result?.tools?.length ?? 0;
    steps.push({ step: "tools/list", ok: true, detail: `${toolCount} tools` });
  } catch (e) {
    steps.push({ step: "tools/list", ok: false, detail: e instanceof Error ? e.message : String(e) });
    return { ok: false, url, steps, toolCount, elapsedMs: Date.now() - started };
  }

  // Step 3: a REAL tool call — `stats` is the cheap read every scope allows.
  try {
    const res = await post({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "stats", arguments: {} },
      id: 3,
    });
    if (!res.ok) {
      steps.push({ step: "tools/call", ok: false, detail: `${res.status}` });
      return { ok: false, url, steps, toolCount, elapsedMs: Date.now() - started };
    }
    steps.push({ step: "tools/call", ok: true, detail: "stats" });
  } catch (e) {
    steps.push({ step: "tools/call", ok: false, detail: e instanceof Error ? e.message : String(e) });
    return { ok: false, url, steps, toolCount, elapsedMs: Date.now() - started };
  }

  return { ok: true, url, steps, toolCount, elapsedMs: Date.now() - started };
}

async function testCommand(rest: string[]): Promise<void> {
  const { positional, flags } = parseFlags(rest);
  const url = positional[0];
  const token = flags["token"];
  if (!url || !token) {
    throw new Error("Usage: auth test <url> --token <token>");
  }
  console.log(`Testing MCP server at ${url}...\n`);
  const result = await runAuthTest(url, token);
  for (const s of result.steps) {
    const mark = s.ok ? "ok " : "FAIL";
    console.log(`  [${mark}] ${s.step}${s.detail ? ` — ${s.detail}` : ""}`);
  }
  if (!result.ok) {
    console.error(`\nSmoke FAILED after ${(result.elapsedMs / 1000).toFixed(1)}s.`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nBrain is live: ${result.toolCount} tools, round trip ${(result.elapsedMs / 1000).toFixed(1)}s.`,
  );
}

const DOCTOR_USAGE =
  "Usage: auth doctor <base-url> (--client-file F | --token-file F)\n" +
  "                   [--expect-source ID | --expect-operator] [--expect-version STAMP] [--json]";

function doctorUsage(message: string): void {
  console.error(`auth doctor: ${message}\n${DOCTOR_USAGE}`);
  process.exitCode = 2;
}

async function doctorCommand(rest: string[]): Promise<void> {
  let positional: string[];
  let flags: Record<string, string>;
  try {
    ({ positional, flags } = parseFlags(rest));
  } catch (e) {
    return doctorUsage(e instanceof Error ? e.message : String(e));
  }
  const baseUrl = positional[0];
  if (!baseUrl) return doctorUsage("a base URL is required");
  // A secret on argv lands in shell history and `ps` — only files are accepted.
  if (flags["token"] !== undefined) {
    return doctorUsage("refusing a secret on the command line — put it in a 0600 file and pass --token-file");
  }
  const clientFile = flags["client-file"];
  const tokenFile = flags["token-file"];
  if ((clientFile === undefined) === (tokenFile === undefined)) {
    return doctorUsage("pass exactly one of --client-file or --token-file");
  }
  const expectOperator = flags["expect-operator"] === "true";
  const expectSource = flags["expect-source"];
  if (expectOperator && expectSource !== undefined) {
    return doctorUsage("--expect-source and --expect-operator are mutually exclusive");
  }
  const opts: DoctorOptions = { expectOperator };
  if (expectSource !== undefined) opts.expectSource = expectSource;
  const expectVersion = flags["expect-version"];
  if (expectVersion !== undefined) opts.expectVersion = expectVersion;

  let result;
  try {
    const path = (clientFile ?? tokenFile)!;
    const creds = readCredentialFile(path);
    if (clientFile !== undefined && creds.kind !== "client") {
      return doctorUsage(`${path} holds a token — pass it with --token-file`);
    }
    if (tokenFile !== undefined && creds.kind !== "token") {
      return doctorUsage(`${path} holds client credentials — pass it with --client-file`);
    }
    result = await runRemoteDoctor(baseUrl, creds, opts);
  } catch (e) {
    if (e instanceof DoctorUsageError) return doctorUsage(e.message);
    throw e;
  }

  if (flags["json"] === "true") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatDoctorReport(result));
  }
  if (!result.ok) process.exitCode = 1;
}

export async function runAuth(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  // Only rescope-client can preview. Every other subcommand would ignore the
  // flag and mutate, which is the opposite of what it asks for.
  if (sub !== "rescope-client" && rest.some((a) => a === "--dry-run" || a.startsWith("--dry-run="))) {
    throw new Error(`auth ${sub ?? ""}: --dry-run is supported only by rescope-client`);
  }
  switch (sub as AuthSub) {
    case "register-client":
      return registerClient(rest[0]!, rest.slice(1));
    case "list-clients":
      return listClients();
    case "revoke-client":
      return revokeClient(rest[0]!, rest.slice(1));
    case "set-redirect-uris":
      return setRedirectUris(rest[0]!, rest.slice(1));
    case "rescope-client":
      return rescopeClient(rest[0]!, rest.slice(1));
    case "grant-history":
      return grantHistory(rest[0]!, rest.slice(1));
    case "set-budget":
      return setBudget(rest[0]!, rest[1]!);
    case "enroll":
      return enroll(rest);
    case "enrollments":
      return listEnrollments(rest);
    case "revoke-enrollment":
      return revokeEnrollment(rest[0]!);
    case "revoke-grant":
      return revokeGrant(rest[0]!);
    case "invalidate-tokens":
      return invalidateTokens(rest[0]!, rest.slice(1));
    case "grant-token":
      return grantToken(rest[0]!, rest[1]!, rest.slice(2));
    case "create":
      return createToken(rest[0]!, rest.slice(1));
    case "list":
      return listTokens();
    case "revoke":
      return revokeToken(rest[0]!);
    case "permissions":
      return setPermissions(rest[0]!, rest[1]!, rest[2]);
    case "test":
      return testCommand(rest);
    case "doctor":
      return doctorCommand(rest);
    default:
      console.error(
        "Usage: memrain auth <register-client|list-clients|revoke-client|set-redirect-uris|rescope-client|grant-history|set-budget|enroll|enrollments|revoke-enrollment|revoke-grant|invalidate-tokens|grant-token|create|list|revoke|permissions|test|doctor>",
      );
      process.exitCode = 1;
  }
}
