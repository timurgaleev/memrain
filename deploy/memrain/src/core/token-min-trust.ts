/**
 * Per-credential read floors (migration 186): `access_tokens.min_trust` and
 * `oauth_clients.min_trust` hold the least trusted tier a credential may read.
 * The verifier carries it as `AuthInfo.minTrust`; mcp/read-floor.ts applies
 * it. The local CLI writes it (`memrain auth create --min-trust`,
 * `memrain auth min-trust`), and the admin grant editor writes a client's
 * through `OAuthProvider.rescopeClient`; no MCP tool can change it.
 */
import type { Engine } from "./engine/interface.ts";
import type { TrustTier } from "./trust-tier.ts";
import { clientGrantSnapshot, type GrantActor } from "./oauth-provider.ts";

export interface MinTrustChange {
  kind: "oauth_client" | "token";
  id: string;
  name: string;
  before: TrustTier | null;
  after: TrustTier | null;
}

/**
 * Sets (or with null clears) the floor of one credential, named by OAuth
 * client id or by active token name. Token names are not unique across
 * revocations; two active tokens with one name are refused.
 *
 * A client's floor is part of its grant: the change bumps `grant_revision` and
 * writes an audit row like every other grant writer, so a grant editor that
 * previewed the old floor gets `grant_conflict` instead of overwriting it.
 */
export async function setCredentialMinTrust(
  engine: Pick<Engine, "query" | "transaction">,
  target: string,
  tier: TrustTier | null,
  who: GrantActor = { actor: "unattributed", via: "cli" },
): Promise<MinTrustChange> {
  const client = await engine.transaction(async (tx) => {
    const locked = await tx.query<{
      client_id: string;
      client_name: string | null;
      source_id: string | null;
      federated_read: string[] | null;
      bound_slug_prefixes: string[] | null;
      tenant_mode: string | null;
      scope: string | null;
      tool_surface: string | null;
      budget_usd_per_day: unknown;
      min_trust: TrustTier | null;
    }>(
      // scope: operator-only the local CLI sets one credential's read floor
      `SELECT client_id, client_name, source_id, federated_read, bound_slug_prefixes, tenant_mode, scope,
              tool_surface, budget_usd_per_day, min_trust
         FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [target],
    );
    const row = locked.rows[0];
    if (!row) return null;
    const before = clientGrantSnapshot(row);
    const applied = await tx.query<{ revision: number }>(
      `WITH u AS (
         UPDATE oauth_clients SET min_trust = $2, grant_revision = grant_revision + 1
          WHERE client_id = $1 AND deleted_at IS NULL
          RETURNING grant_revision
       )
       INSERT INTO oauth_grant_audit (client_id, revision, actor, via, before, after)
       SELECT $1, u.grant_revision, $3, $4, $5::text::jsonb, $6::text::jsonb FROM u
       RETURNING revision`,
      [
        row.client_id,
        tier,
        who.actor,
        who.via,
        JSON.stringify(before),
        JSON.stringify({ ...before, action: "set_min_trust", min_trust: tier }),
      ],
    );
    // The row is locked, so the UPDATE cannot miss it.
    if (applied.rows[0]?.revision === undefined) throw new Error(`min_trust write for "${target}" affected no row`);
    return { id: row.client_id, name: row.client_name ?? row.client_id, before: row.min_trust };
  });
  if (client) return { kind: "oauth_client", ...client, after: tier };
  const tokens = await engine.query<{ id: string; name: string; before: TrustTier | null }>(
    `SELECT id::text AS id, name, min_trust AS before FROM access_tokens WHERE name = $1 AND revoked_at IS NULL`,
    [target],
  );
  if (tokens.rows.length > 1) {
    throw new Error(`${tokens.rows.length} active tokens are named "${target}"; revoke the extra one first (memrain auth list).`);
  }
  const t = tokens.rows[0];
  if (!t) throw new Error(`No active OAuth client or token is named "${target}" (memrain auth list-clients, memrain auth list).`);
  await engine.query(`UPDATE access_tokens SET min_trust = $2 WHERE id = $1::bigint`, [t.id, tier]);
  return { kind: "token", id: t.id, name: t.name, before: t.before, after: tier };
}
