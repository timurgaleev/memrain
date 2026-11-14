/**
 * A token source that renews an OAuth access token before it expires and when
 * the provider refuses it.
 *
 * The credential itself is read and written through a CredentialStore: the
 * vault decrypts and encrypts it, this module never sees ciphertext or a key.
 * A decrypted token lives only in memory for the run.
 *
 * Google and Microsoft may rotate the refresh token on every use, so two
 * workers refreshing at once would each spend it and the loser's copy would be
 * dead. Refreshes are serialised twice: within a process by sharing one
 * in-flight promise, and across processes by a `worker_lock` row per account
 * (a plain upsert, not a session advisory lock, so a transaction pooler cannot
 * drop it). A worker that finds the lock taken waits for the holder and then
 * uses the token it stored instead of refreshing again.
 */
import type { Engine } from "../engine/interface.ts";
import { acquireWorkerLock, releaseWorkerLock } from "../jobs/worker-lock.ts";
import type { FetchFn, TokenSource } from "./client.ts";
import { ReauthRequiredError } from "./types.ts";

export interface StoredCredential {
  accessToken: string;
  refreshToken: string | null;
  /** When the access token stops working; null when the provider did not say. */
  expiresAt: Date | null;
}

/** Read and write one account's decrypted credential. The vault implements it. */
export interface CredentialStore {
  read(accountId: string): Promise<StoredCredential | null>;
  write(accountId: string, credential: StoredCredential): Promise<void>;
}

export interface RefreshResult {
  accessToken: string;
  /** A rotated refresh token; absent or null keeps the current one. */
  refreshToken?: string | null;
  expiresInSec?: number | null;
}

/** Exchange a refresh token for a new access token. Throws ReauthRequiredError on `invalid_grant`. */
export type RefreshFn = (refreshToken: string) => Promise<RefreshResult>;

export interface TokenProviderOptions {
  engine: Engine;
  accountId: string;
  store: CredentialStore;
  refresh: RefreshFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Renew this long before the stated expiry. Default 60 s. */
  skewMs?: number;
  /** Identifies this process in the refresh lock. */
  holder?: string;
  /** How long a refresh lock lives if its holder dies. Default 60 s. */
  lockTtlSec?: number;
  /** How long to wait for another worker's refresh before giving up for this run. Default 30 s. */
  waitMs?: number;
}

const DEFAULT_SKEW_MS = 60_000;
const DEFAULT_LOCK_TTL_SEC = 60;
const DEFAULT_WAIT_MS = 30_000;
const POLL_MS = 500;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function refreshLockId(accountId: string): string {
  return `connector-refresh:${accountId}`;
}

export function createTokenProvider(opts: TokenProviderOptions): TokenSource {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const skewMs = opts.skewMs ?? DEFAULT_SKEW_MS;
  const holder = opts.holder ?? `pid-${process.pid}-${crypto.randomUUID()}`;
  const lockId = refreshLockId(opts.accountId);
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  let inFlight: Promise<string> | null = null;

  const expired = (c: StoredCredential): boolean => c.expiresAt !== null && c.expiresAt.getTime() - skewMs <= now();

  const load = async (): Promise<StoredCredential> => {
    const c = await opts.store.read(opts.accountId);
    if (c === null) throw new ReauthRequiredError("no stored credential for this account");
    return c;
  };

  /** Someone else renewed it since `stale` was sent: use theirs. */
  const renewedElsewhere = (c: StoredCredential, stale: string): boolean => c.accessToken !== stale && !expired(c);

  const exchange = async (stale: string): Promise<string> => {
    const c = await load();
    if (renewedElsewhere(c, stale)) return c.accessToken;
    if (c.refreshToken === null || c.refreshToken.length === 0) {
      throw new ReauthRequiredError("the credential has no refresh token");
    }
    const r = await opts.refresh(c.refreshToken);
    if (typeof r.accessToken !== "string" || r.accessToken.length === 0) {
      throw new Error("token endpoint returned no access token");
    }
    const secs = r.expiresInSec;
    await opts.store.write(opts.accountId, {
      accessToken: r.accessToken,
      refreshToken: r.refreshToken ? r.refreshToken : c.refreshToken,
      expiresAt: typeof secs === "number" && Number.isFinite(secs) && secs > 0 ? new Date(now() + secs * 1000) : null,
    });
    return r.accessToken;
  };

  const lockedRefresh = async (stale: string): Promise<string> => {
    for (let waited = 0; ; waited += POLL_MS) {
      if (await acquireWorkerLock(opts.engine, lockId, holder, opts.lockTtlSec ?? DEFAULT_LOCK_TTL_SEC)) {
        try {
          return await exchange(stale);
        } finally {
          await releaseWorkerLock(opts.engine, lockId, holder);
        }
      }
      const c = await load();
      if (renewedElsewhere(c, stale)) return c.accessToken;
      if (waited >= waitMs) throw new Error("another worker is still refreshing this account's token");
      await sleep(POLL_MS);
    }
  };

  const refresh = (stale: string): Promise<string> => {
    inFlight ??= lockedRefresh(stale).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    token: async () => {
      const c = await load();
      return expired(c) ? refresh(c.accessToken) : c.accessToken;
    },
    refresh,
  };
}

export interface TokenEndpointOptions {
  /** The token endpoint's origin, e.g. https://oauth2.googleapis.com. */
  origin: string;
  path: string;
  clientId: string;
  clientSecret: string;
  fetch?: FetchFn;
  timeoutMs?: number;
}

const ERROR_CODE_RE = /^[a-z_]{1,40}$/;
const DEFAULT_TOKEN_TIMEOUT_MS = 30_000;

/**
 * The standard OAuth refresh-token grant against a fixed token endpoint. The
 * response body can carry tokens, so no error ever quotes it: only the status
 * and the provider's `error` code, when it is a plain code.
 */
export function tokenEndpointRefresh(opts: TokenEndpointOptions): RefreshFn {
  const origin = new URL(opts.origin).origin;
  if (!origin.startsWith("https://")) throw new Error(`token endpoint must be https (got ${origin})`);
  if (!opts.path.startsWith("/") || opts.path.startsWith("//")) throw new Error("token endpoint path must be a path");
  const url = new URL(opts.path, origin).toString();
  const fetchFn = opts.fetch ?? ((u, init) => fetch(u, init));

  return async (refreshToken) => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    });
    let res: Response;
    let text: string;
    try {
      res = await fetchFn(url, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: body.toString(),
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS),
      });
      text = await res.text();
    } catch (e) {
      const name = e instanceof Error ? e.name : "error";
      throw new Error(`token endpoint unreachable (${name})`);
    }
    let parsed: Record<string, unknown> = {};
    try {
      const v: unknown = JSON.parse(text);
      if (v !== null && typeof v === "object" && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    } catch {
      // Not JSON; only the status is reported.
    }
    const code = typeof parsed.error === "string" && ERROR_CODE_RE.test(parsed.error) ? parsed.error : null;
    if (res.status === 200) {
      if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
        throw new Error("token endpoint answered 200 without an access token");
      }
      return {
        accessToken: parsed.access_token,
        refreshToken: typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0 ? parsed.refresh_token : null,
        expiresInSec: typeof parsed.expires_in === "number" ? parsed.expires_in : null,
      };
    }
    if ((res.status === 400 || res.status === 401) && code === "invalid_grant") {
      throw new ReauthRequiredError("the provider refused the refresh token (invalid_grant)");
    }
    throw new Error(`token endpoint answered HTTP ${res.status}${code ? ` (${code})` : ""}`);
  };
}
