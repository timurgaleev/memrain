/**
 * OAuth apps their provider refused (migration 168): one row per provider
 * whose token endpoint turned the app itself away, `invalid_client` (a wrong
 * or expired client secret, an unknown app) or `unauthorized_client`.
 *
 * No reconnect fixes that, and every account renewing with the app fails
 * alike, so the accounts are neither parked for a reconnect nor left to ask
 * again every run: the provider's syncs wait until `held_until`, one try an
 * hour, and the owner is told once (notifications kind
 * `oauth_client_rejected`). Saving or removing the provider's app ends the
 * hold, and so does any renewal that succeeds.
 *
 * Only codes are kept: the app's public id, the OAuth error code and the
 * provider's numeric service code. Never a secret or provider text.
 */
import type { Engine } from "../engine/interface.ts";
import type { OAuthClientRejectedError } from "./types.ts";

/** How long a refused app holds its provider's syncs before one more try. */
export const CLIENT_HOLD_MS = 60 * 60_000;

export interface ClientHold {
  provider: string;
  client_id: string;
  reason: OAuthClientRejectedError["code"];
  service_code: number | null;
  /** When the app was first refused in this episode. */
  since: string;
  /** When the provider last refused it. */
  refused_at: string;
  /** Until then no sync of the provider's accounts asks the provider. */
  held_until: string;
}

const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();

/** Record that the provider refused `clientId`, and hold its accounts' syncs for CLIENT_HOLD_MS from `now`. */
export async function recordClientRejection(
  engine: Engine,
  input: { provider: string; clientId: string; error: OAuthClientRejectedError; now: Date },
): Promise<void> {
  const until = new Date(input.now.getTime() + CLIENT_HOLD_MS).toISOString();
  await engine.query(
    `INSERT INTO connector_client_holds (provider, client_id, reason, service_code, created_at, refused_at, held_until)
     VALUES ($1, $2, $3, $4, $5, $5, $6)
     ON CONFLICT (provider) DO UPDATE SET
       client_id = EXCLUDED.client_id, reason = EXCLUDED.reason, service_code = EXCLUDED.service_code,
       refused_at = EXCLUDED.refused_at, held_until = EXCLUDED.held_until`,
    [input.provider, input.clientId, input.error.code, input.error.serviceCode, input.now.toISOString(), until],
  );
}

/** End a provider's hold: its app was saved, removed, or renewed a token. True when there was one. */
export async function clearClientHold(engine: Engine, provider: string): Promise<boolean> {
  const r = await engine.query(`DELETE FROM connector_client_holds WHERE provider = $1 RETURNING provider`, [provider]);
  return r.rows.length > 0;
}

/**
 * Whether the provider's syncs wait: `clientId` (the app they would renew
 * with now) is the refused one and its hold has not run out. Another app,
 * say one the environment names after a restart, is tried at once.
 */
export async function clientHeld(engine: Engine, provider: string, clientId: string | null, now: Date): Promise<boolean> {
  if (clientId === null) return false;
  const r = await engine.query(
    `SELECT 1 FROM connector_client_holds WHERE provider = $1 AND client_id = $2 AND held_until > $3`,
    [provider, clientId, now.toISOString()],
  );
  return r.rows.length > 0;
}

export async function listClientHolds(engine: Engine): Promise<ClientHold[]> {
  const r = await engine.query<{
    provider: string; client_id: string; reason: ClientHold["reason"]; service_code: number | string | null;
    created_at: Date | string; refused_at: Date | string; held_until: Date | string;
  }>(`SELECT provider, client_id, reason, service_code, created_at, refused_at, held_until FROM connector_client_holds ORDER BY provider`);
  return r.rows.map((row) => ({
    provider: row.provider,
    client_id: row.client_id,
    reason: row.reason,
    service_code: row.service_code === null ? null : Number(row.service_code),
    since: iso(row.created_at),
    refused_at: iso(row.refused_at),
    held_until: iso(row.held_until),
  }));
}
