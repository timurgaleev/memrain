/**
 * Doctor check over the OAuth clients a brain has registered.
 */
import { couldNotCheck, type CheckVerdict } from "./doctor-categories.ts";
import type { Engine } from "./engine/interface.ts";
import { isAllowedRedirectUri } from "./oauth-provider.ts";

/** At most five names, then a count of the rest. */
function sample(names: string[]): string {
  return names.slice(0, 5).join(", ") + (names.length > 5 ? ` (+${names.length - 5} more)` : "");
}

/**
 * Registration hygiene of the live OAuth clients. Warn-only and read-only:
 * each finding is something an operator should look at, none stops the brain.
 *
 *   - idle        : no MCP request logged in 90 days (a new client counts too
 *                   until its first call) — a credential nobody uses is one
 *                   nobody would notice leaking.
 *   - public      : no secret while the tenant comes from the client row, so
 *                   an auto-approving /authorize mints tokens for anyone who
 *                   knows the client id.
 *   - redirect    : a redirect URI that is neither https nor http on a
 *                   loopback host (registration refuses these today; older
 *                   rows may still hold one).
 *   - wide scope  : a browser connector (authorization_code) registered with a
 *                   scope beyond read/write; a person's chat app has no use
 *                   for admin.
 */
export async function checkOauthClientHygiene(
  engine: Engine,
): Promise<CheckVerdict> {
  const name = "oauth-client-hygiene";
  try {
    const r = await engine.query<{
      client_id: string;
      client_name: string | null;
      grant_types: string[] | null;
      scope: string | null;
      redirect_uris: string[] | null;
      public_client: boolean;
      tenant_mode: string | null;
      idle: boolean;
    }>(
      `SELECT c.client_id, c.client_name, c.grant_types, c.scope, c.redirect_uris,
              c.client_secret_hash IS NULL AS public_client, c.tenant_mode,
              NOT EXISTS (SELECT 1 FROM mcp_request_log l
                           WHERE l.token_name = c.client_id
                             AND l.created_at > now() - interval '90 days') AS idle
         FROM oauth_clients c
        WHERE c.deleted_at IS NULL
        ORDER BY c.client_id`,
    );
    if (r.rows.length === 0) {
      return { name, ok: true, status: "ok", detail: "no OAuth clients registered" };
    }
    const label = (c: { client_id: string; client_name: string | null }) =>
      c.client_name ? `${c.client_name} (${c.client_id})` : c.client_id;
    const idle = r.rows.filter((c) => c.idle).map(label);
    const publicClient = r.rows
      .filter((c) => c.public_client && (c.tenant_mode ?? "client") === "client")
      .map(label);
    const badRedirect = r.rows.flatMap((c) =>
      (c.redirect_uris ?? []).filter((u) => !isAllowedRedirectUri(u)).map((u) => `${label(c)}: ${u}`),
    );
    const wideConnector = r.rows
      .filter((c) => (c.grant_types ?? []).includes("authorization_code"))
      .filter((c) => (c.scope ?? "").split(/\s+/).some((x) => x !== "" && x !== "read" && x !== "write"))
      .map((c) => `${label(c)} [${c.scope}]`);

    const warns: string[] = [];
    if (idle.length > 0) {
      warns.push(
        `${idle.length} client(s) with no call in 90 days: ${sample(idle)} — ` +
          "revoke any nobody uses with 'memrain auth revoke-client <id>'",
      );
    }
    if (publicClient.length > 0) {
      warns.push(
        `${publicClient.length} public client(s) in client tenant mode: ${sample(publicClient)} — ` +
          "anyone with the client id gets that tenant if MEMRAIN_OAUTH_REQUIRE_LOGIN=0; " +
          "use --tenant-mode enrollment or a confidential client",
      );
    }
    if (badRedirect.length > 0) {
      warns.push(
        `${badRedirect.length} redirect URI(s) neither https nor loopback: ${sample(badRedirect)} — ` +
          "fix with 'memrain auth set-redirect-uris <id> <uri...>'",
      );
    }
    if (wideConnector.length > 0) {
      warns.push(
        `${wideConnector.length} browser connector(s) with scope beyond read/write: ${sample(wideConnector)}`,
      );
    }
    if (warns.length > 0) {
      return { name, ok: true, status: "warn", detail: warns.join("; ") };
    }
    return {
      name,
      ok: true,
      status: "ok",
      detail: `${r.rows.length} OAuth client(s); all used within 90 days, none public, redirect URIs and scopes in bounds`,
    };
  } catch (e) {
    return couldNotCheck(name, e);
  }
}
