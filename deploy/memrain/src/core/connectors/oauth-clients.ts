/**
 * Bring-your-own OAuth clients: an operator's own client id and secret for a
 * provider (their Google Cloud project, Entra app or Slack app). The secret is
 * sealed in the vault and bound to the provider and client id; the client id
 * itself is public and may be listed.
 *
 * Saving a new client replaces the old one in a single statement, so a
 * rotation never leaves both secrets on disk.
 *
 * A client may carry settings (a Microsoft Entra app's tenant). They are
 * sealed with the secret, so the AAD binds them to the provider and client id
 * as well: the sealed text is then a versioned envelope, which no bare secret
 * can be mistaken for, since a secret holds no whitespace.
 */
import type { Engine } from "../engine/interface.ts";
import { assertConnectorName, ConnectorAccountError } from "./accounts.ts";
import { oauthClientAad, seal, unseal, type Kek } from "./vault.ts";

/** OAuth client ids and secrets are printable ASCII with no whitespace. */
const CLIENT_TOKEN_RE = /^[\x21-\x7E]+$/;
const MAX_CLIENT_ID = 512;
const MAX_CLIENT_SECRET = 2048;

/**
 * A directory tenant as it may stand in an endpoint path: a tenant id (GUID),
 * a domain name, or `common`, `organizations` or `consumers`
 * (learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow).
 */
const TENANT_RE = /^(?:common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/i;
const MAX_TENANT = 253;

export function isTenant(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TENANT && TENANT_RE.test(value);
}

function checkToken(value: string, what: string, max: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !CLIENT_TOKEN_RE.test(value)) {
    throw new ConnectorAccountError(`invalid ${what}`);
  }
}

const ENVELOPE = "oauth-client/v1\n";

export interface OAuthClientSettings {
  /** The directory tenant the client signs in through (Microsoft). */
  tenant?: string;
}

export interface OAuthClient extends OAuthClientSettings {
  clientId: string;
  clientSecret: string;
}

function sealedText(secret: string, settings: OAuthClientSettings): string {
  return settings.tenant === undefined ? secret : `${ENVELOPE}${JSON.stringify({ secret, tenant: settings.tenant })}`;
}

function openText(text: string): { clientSecret: string } & OAuthClientSettings {
  if (!text.startsWith(ENVELOPE)) return { clientSecret: text };
  const v = JSON.parse(text.slice(ENVELOPE.length)) as { secret?: unknown; tenant?: unknown };
  if (typeof v.secret !== "string") throw new ConnectorAccountError("stored OAuth client is malformed");
  return { clientSecret: v.secret, ...(typeof v.tenant === "string" ? { tenant: v.tenant } : {}) };
}

export async function setOAuthClient(
  engine: Engine,
  kek: Kek,
  provider: string,
  clientId: string,
  clientSecret: string,
  settings: OAuthClientSettings = {},
): Promise<void> {
  assertConnectorName(provider, "provider");
  checkToken(clientId, "client id", MAX_CLIENT_ID);
  checkToken(clientSecret, "client secret", MAX_CLIENT_SECRET);
  if (settings.tenant !== undefined && !isTenant(settings.tenant)) throw new ConnectorAccountError("invalid tenant");
  const sealed = seal(kek, sealedText(clientSecret, settings), oauthClientAad(provider, clientId, kek.id));
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
): Promise<OAuthClient | null> {
  const r = await engine.query<{ client_id: string; kek_id: string; nonce: string; ciphertext: string }>(
    `SELECT client_id, kek_id, nonce, ciphertext FROM connector_oauth_clients WHERE provider = $1`,
    [provider],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { clientId: row.client_id, ...openText(unseal(keys, row, oauthClientAad(provider, row.client_id, row.kek_id))) };
}

export interface OAuthClientMeta {
  provider: string;
  client_id: string;
  kek_id: string;
  updated_at: string;
  /** The client's tenant, when it has one and `keys` could open it. */
  tenant?: string;
}

/** Client metadata, never a secret. With `keys`, the settings sealed beside the secret are read too. */
export async function listOAuthClients(engine: Engine, keys?: Kek | readonly Kek[]): Promise<OAuthClientMeta[]> {
  const r = await engine.query<{ provider: string; client_id: string; kek_id: string; nonce: string; ciphertext: string; updated_at: Date | string }>(
    `SELECT provider, client_id, kek_id, nonce, ciphertext, updated_at FROM connector_oauth_clients ORDER BY provider`,
  );
  return r.rows.map((row) => {
    let tenant: string | undefined;
    if (keys !== undefined) {
      try {
        tenant = openText(unseal(keys, row, oauthClientAad(row.provider, row.client_id, row.kek_id))).tenant;
      } catch {
        // A client the loaded key cannot open is listed without its settings.
      }
    }
    return {
      provider: row.provider,
      client_id: row.client_id,
      kek_id: row.kek_id,
      updated_at: (row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at)).toISOString(),
      ...(tenant !== undefined ? { tenant } : {}),
    };
  });
}

export async function deleteOAuthClient(engine: Engine, provider: string): Promise<boolean> {
  const r = await engine.query(`DELETE FROM connector_oauth_clients WHERE provider = $1 RETURNING provider`, [provider]);
  return r.rows.length > 0;
}
