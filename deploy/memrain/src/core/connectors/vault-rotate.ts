/**
 * Re-seal every connector secret under a new key-encryption key.
 *
 * All three tables are rewritten in one transaction: if any row fails to open
 * under the old key (damaged, or sealed by a key that is not loaded) nothing is
 * changed and every row stays readable with the old key. Rows already under
 * the new key are skipped, so a rotation that is run again is a no-op.
 */
import type { Engine } from "../engine/interface.ts";
import { credentialAad, oauthClientAad, oauthStateAad, seal, unseal, type Kek } from "./vault.ts";

export interface RotationResult {
  credentials: number;
  oauthClients: number;
  oauthStates: number;
}

interface SealedRow {
  kek_id: string;
  nonce: string;
  ciphertext: string;
}

export async function rotateKek(engine: Engine, oldKeys: Kek | readonly Kek[], next: Kek): Promise<RotationResult> {
  return engine.transaction(async (tx) => {
    await tx.query(`LOCK TABLE connector_credentials, connector_oauth_clients, connector_oauth_states IN SHARE ROW EXCLUSIVE MODE`);

    // scope: operator-only key rotation reseals every credential in the brain
    const creds = await tx.query<SealedRow & { account_id: string; provider: string }>(
      `SELECT c.account_id, a.provider, c.kek_id, c.nonce, c.ciphertext
         FROM connector_credentials c JOIN connector_accounts a ON a.id = c.account_id
        WHERE c.kek_id <> $1 ORDER BY c.account_id`,
      [next.id],
    );
    for (const row of creds.rows) {
      const plain = unseal(oldKeys, row, credentialAad(row.account_id, row.provider, row.kek_id));
      const sealed = seal(next, plain, credentialAad(row.account_id, row.provider, next.id));
      await tx.query(
        `UPDATE connector_credentials SET kek_id = $2, nonce = $3, ciphertext = $4, rotated_at = NOW(), updated_at = NOW()
          WHERE account_id = $1`,
        [row.account_id, sealed.kek_id, sealed.nonce, sealed.ciphertext],
      );
    }

    const clients = await tx.query<SealedRow & { provider: string; client_id: string }>(
      `SELECT provider, client_id, kek_id, nonce, ciphertext FROM connector_oauth_clients WHERE kek_id <> $1 ORDER BY provider`,
      [next.id],
    );
    for (const row of clients.rows) {
      const plain = unseal(oldKeys, row, oauthClientAad(row.provider, row.client_id, row.kek_id));
      const sealed = seal(next, plain, oauthClientAad(row.provider, row.client_id, next.id));
      await tx.query(
        `UPDATE connector_oauth_clients SET kek_id = $2, nonce = $3, ciphertext = $4, rotated_at = NOW(), updated_at = NOW()
          WHERE provider = $1`,
        [row.provider, sealed.kek_id, sealed.nonce, sealed.ciphertext],
      );
    }

    // scope: operator-only key rotation reseals every pending connect state
    const states = await tx.query<{ state_hash: string; provider: string; kek_id: string; nonce: string; pkce_verifier_enc: string }>(
      `SELECT state_hash, provider, kek_id, nonce, pkce_verifier_enc FROM connector_oauth_states WHERE kek_id <> $1 ORDER BY state_hash`,
      [next.id],
    );
    for (const row of states.rows) {
      const plain = unseal(oldKeys, { kek_id: row.kek_id, nonce: row.nonce, ciphertext: row.pkce_verifier_enc },
        oauthStateAad(row.state_hash, row.provider, row.kek_id));
      const sealed = seal(next, plain, oauthStateAad(row.state_hash, row.provider, next.id));
      await tx.query(
        `UPDATE connector_oauth_states SET kek_id = $2, nonce = $3, pkce_verifier_enc = $4 WHERE state_hash = $1`,
        [row.state_hash, sealed.kek_id, sealed.nonce, sealed.ciphertext],
      );
    }

    return { credentials: creds.rows.length, oauthClients: clients.rows.length, oauthStates: states.rows.length };
  });
}
