/**
 * `memrain admin setup-link` — mint a one-time link that lets the panel's owner
 * create their first (or a replacement) passkey.
 *
 * The token goes to stdout only, once; the database keeps its hash. Minting a
 * link revokes every unused one and is audited like the panel and API paths.
 *
 * PGLite is single-process, so on a PGLite install this works only while the
 * server is stopped. A running server answers the same request at
 * `POST /admin/api/setup-links` with the bootstrap token.
 */
import { loadConfig } from "../core/config.ts";
import { Storage } from "../core/storage.ts";
import { mintSetupLink } from "../core/admin-passkey-store.ts";
import { PgliteLockedError } from "../core/engine/pglite-lock.ts";
import { withStorage } from "./with-storage.ts";

const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 72;

export interface SetupLinkOptions {
  ttl?: string;
  json?: boolean;
}

/** Exit status: 0 minted, 1 bad input, 2 brain locked by the running server. */
export async function runAdminSetupLink(opts: SetupLinkOptions): Promise<number> {
  let hours = DEFAULT_TTL_HOURS;
  if (opts.ttl !== undefined) {
    if (!/^\d+$/.test(opts.ttl) || Number(opts.ttl) < 1 || Number(opts.ttl) > MAX_TTL_HOURS) {
      console.error(`memrain admin setup-link: --ttl must be a whole number of hours from 1 to ${MAX_TTL_HOURS}`);
      return 1;
    }
    hours = Number(opts.ttl);
  }
  const base = (process.env.MEMRAIN_PUBLIC_URL ?? "").trim().replace(/(?<!\/)\/+$/, "");
  let link: { token: string; expiresAt: number };
  try {
    const storage = new Storage(loadConfig());
    link = await withStorage(storage, () => mintSetupLink(storage.engine(), { ttlMs: hours * 3_600_000, via: "cli" }));
  } catch (e) {
    if (e instanceof PgliteLockedError || /open in another process/.test(e instanceof Error ? e.message : "")) {
      console.error(
        "memrain admin setup-link: the brain is open in the running server. Use the bootstrap API instead: " +
          "`curl -X POST -H 'Authorization: Bearer <bootstrap-token>' <url>/admin/api/setup-links`, or stop the server.",
      );
      return 2;
    }
    throw e;
  }
  const url = `${base}/admin/#enroll/${link.token}`;
  const expiresAt = new Date(link.expiresAt).toISOString();
  if (base.length === 0) {
    console.error(
      "memrain admin setup-link: MEMRAIN_PUBLIC_URL is unset, so the link below has no host. " +
        "Prepend the panel's https:// origin; passkey sign-in stays unavailable until MEMRAIN_PUBLIC_URL is set.",
    );
  }
  if (opts.json) {
    console.log(JSON.stringify({ url, expires_at: expiresAt }));
  } else {
    console.log(url);
    console.log(`expires ${expiresAt}`);
  }
  return 0;
}
