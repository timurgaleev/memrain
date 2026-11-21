/**
 * Per-credential read floors (migration 186): `access_tokens.min_trust` and
 * `oauth_clients.min_trust` hold the least trusted tier a credential may read.
 * The verifier carries it as `AuthInfo.minTrust`; mcp/read-floor.ts applies
 * it. Only the local CLI writes it (`memrain auth create --min-trust`,
 * `memrain auth min-trust`): no MCP tool or admin route can change it.
 */
import type { Engine } from "./engine/interface.ts";
import type { TrustTier } from "./trust-tier.ts";

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
 */
export async function setCredentialMinTrust(engine: Pick<Engine, "query">, target: string, tier: TrustTier | null): Promise<MinTrustChange> {
  const client = await engine.query<{ id: string; name: string | null; before: TrustTier | null }>(
    // scope: operator-only the local CLI sets one credential's read floor
    `UPDATE oauth_clients c SET min_trust = $2
       FROM (SELECT client_id, min_trust FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL FOR UPDATE) prior
      WHERE c.client_id = prior.client_id
      RETURNING c.client_id AS id, c.client_name AS name, prior.min_trust AS before`,
    [target, tier],
  );
  const c = client.rows[0];
  if (c) return { kind: "oauth_client", id: c.id, name: c.name ?? c.id, before: c.before, after: tier };
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
