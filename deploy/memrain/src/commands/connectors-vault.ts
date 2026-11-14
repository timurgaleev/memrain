/**
 * `memrain connectors rotate-kek --old-file F --new-file F`: re-seal every
 * connector secret under a new key. Both keys are read from files only their
 * owner can read; neither is ever printed. The rotation is one transaction, so
 * a failure leaves every row on the old key.
 */
import { loadConfig } from "../core/config.ts";
import { Storage } from "../core/storage.ts";
import { rotateKek } from "../core/connectors/vault-rotate.ts";
import { loadKek, VaultError } from "../core/connectors/vault.ts";
import { withStorage } from "./with-storage.ts";

export interface RotateKekOptions {
  oldKekFile?: string;
  newKekFile?: string;
  json?: boolean;
  configPath?: string;
}

function fail(message: string, json: boolean | undefined): number {
  if (json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(`memrain connectors rotate-kek: ${message}`);
  return 1;
}

export async function runRotateKek(opts: RotateKekOptions): Promise<number> {
  if (!opts.oldKekFile || !opts.newKekFile) return fail("--old-file and --new-file are required", opts.json);
  const old = loadKek({ MEMRAIN_CONNECTOR_KEK_FILE: opts.oldKekFile });
  if (old.kek === null) return fail(`old key: ${old.reason}`, opts.json);
  const next = loadKek({ MEMRAIN_CONNECTOR_KEK_FILE: opts.newKekFile });
  if (next.kek === null) return fail(`new key: ${next.reason}`, opts.json);
  if (old.kek.id === next.kek.id) return fail("the old and new keys are the same key", opts.json);

  const storage = new Storage(loadConfig(opts.configPath));
  let result;
  try {
    result = await withStorage(storage, () => rotateKek(storage.engine(), old.kek, next.kek));
  } catch (e) {
    if (e instanceof VaultError) return fail(`${e.code}: no row was changed`, opts.json);
    throw e;
  }
  const summary = {
    ok: true,
    from: old.kek.id,
    to: next.kek.id,
    credentials: result.credentials,
    oauth_clients: result.oauthClients,
    oauth_states: result.oauthStates,
  };
  if (opts.json) console.log(JSON.stringify(summary));
  else {
    console.log(`rotated connector key ${summary.from} -> ${summary.to}: ${summary.credentials} credential(s), `
      + `${summary.oauth_clients} oauth client(s), ${summary.oauth_states} pending connect(s)`);
  }
  return 0;
}
