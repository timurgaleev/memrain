/**
 * Bring-your-own OAuth clients: an operator's own client id and secret for a
 * provider (their Google Cloud project, Entra app or Slack app). The secret is
 * sealed in the vault and bound to the provider and client id; the client id
 * itself is public and may be listed.
 *
 * Saving a new client replaces the old one in a single statement, so a
 * rotation never leaves both secrets on disk.
 */
import type { Engine } from "../engine/interface.ts";
import { assertConnectorName, ConnectorAccountError } from "./accounts.ts";
import { oauthClientAad, seal, unseal, type Kek } from "./vault.ts";

/** OAuth client ids and secrets are printable ASCII with no whitespace. */
const CLIENT_TOKEN_RE = /^[\x21-\x7E]+$/;
const MAX_CLIENT_ID = 512;
const MAX_CLIENT_SECRET = 2048;

function checkToken(value: string, what: string, max: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !CLIENT_TOKEN_RE.test(value)) {
    throw new ConnectorAccountError(`invalid ${what}`);
  }
}

export async function setOAuthClient(
  engine: Engine,
  kek: Kek,
  provider: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  assertConnectorName(provider, "provider");
  checkToken(clientId, "client id", MAX_CLIENT_ID);
  checkToken(clientSecret, "client secret", MAX_CLIENT_SECRET);
  const sealed = seal(kek, clientSecret, oauthClientAad(provider, clientId, kek.id));
  await engine.query(
    `INSERT INTO connector_oauth_clients (provider, client_id, kek_id, nonce, ciphertext)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider) DO UPDATE SET
       client_id = EXCLUDED.client_id, kek_id = EXCLUDED.kek_id, nonce = EXCLUDED.nonce,
       ciphertext = EXCLUDED.ciphertext, updated_at = NOW()`,
    [provider, clientId, sealed.kek_id, sealed.nonce, sealed.ciphertext],
  );
}

export async function getOAuthClient(
  engine: Engine,
  keys: Kek | readonly Kek[],
  provider: string,
): Promise<{ clientId: string; clientSecret: string } | null> {
  const r = await engine.query<{ client_id: string; kek_id: string; nonce: string; ciphertext: string }>(
    `SELECT client_id, kek_id, nonce, ciphertext FROM connector_oauth_clients WHERE provider = $1`,
    [provider],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { clientId: row.client_id, clientSecret: unseal(keys, row, oauthClientAad(provider, row.client_id, row.kek_id)) };
}

export interface OAuthClientMeta {
  provider: string;
  client_id: string;
  kek_id: string;
  updated_at: string;
}

export async function listOAuthClients(engine: Engine): Promise<OAuthClientMeta[]> {
  const r = await engine.query<{ provider: string; client_id: string; kek_id: string; updated_at: Date | string }>(
    `SELECT provider, client_id, kek_id, updated_at FROM connector_oauth_clients ORDER BY provider`,
  );
  return r.rows.map((row) => ({
    provider: row.provider,
    client_id: row.client_id,
    kek_id: row.kek_id,
    updated_at: (row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at)).toISOString(),
  }));
}

export async function deleteOAuthClient(engine: Engine, provider: string): Promise<boolean> {
  const r = await engine.query(`DELETE FROM connector_oauth_clients WHERE provider = $1 RETURNING provider`, [provider]);
  return r.rows.length > 0;
}
