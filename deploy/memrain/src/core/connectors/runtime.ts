/**
 * The connector runtime: the sync engine wired to the rest of the connector
 * stack. Accounts and their credentials come from the vault (accounts.ts), the
 * OAuth client and token endpoint from the provider registry (an API-key
 * provider sends its sealed key instead, paced by one limiter per account), a
 * refused refresh or key parks the account through `markNeedsReconnect`, and a provider-side
 * deletion is handed to the connector-data hard delete (retention.ts), one
 * item per transaction with a text-free receipt.
 *
 * Serve registers it only with MEMRAIN_CONNECTORS_ENABLED on and a usable
 * connector key; otherwise the `connector_sync` kind stays unregistered and
 * nothing is synced, queued or decrypted.
 */
import type { Storage } from "../storage.ts";
import type { Engine } from "../engine/interface.ts";
import type { EmbedFn } from "../indexer.ts";
import {
  getAccount,
  listAccounts,
  markAccountSynced,
  markNeedsReconnect,
  readCredential,
  renewCredential,
  type ConnectorAccount,
} from "./accounts.ts";
import { recordAccountRun } from "./account-status.ts";
import { ConnectorClient, type FetchFn, type TokenSource } from "./client.ts";
import { enrichConnectorPage } from "./enrich-deterministic.ts";
import { limiterFor } from "./limiter.ts";
import { accountRef, type ConnectorDataKind } from "./model.ts";
import { resolveClient } from "./oauth-connect.ts";
import { builtinProviders, type ProviderRegistry } from "./providers.ts";
import { softDeleteUpstreamPage, sweepRetention } from "./retention.ts";
import type { SyncAccount, SyncDeps } from "./sync-engine.ts";
import { registerConnectorSync, type ConnectorSyncRuntime } from "./sync-job.ts";
import { createTokenProvider, tokenEndpointRefresh, type CredentialStore } from "./token-provider.ts";
import { ProviderCannotSyncError, ReauthRequiredError } from "./types.ts";
import { connectorsStatus, loadKek, type Kek } from "./vault.ts";

const MAX_REASON = 200;
/** Every kind a connector page can be; a sweep finds nothing for kinds the account never wrote. */
const RETENTION_KINDS: readonly ConnectorDataKind[] = ["mail", "calendar", "chat", "meeting"];
const DEFAULT_REASON = "the provider will not renew the credential; reconnect the account";

export interface ConnectorRuntimeOptions {
  kek: Kek;
  providers: ProviderRegistry;
  fetch?: FetchFn;
  env?: NodeJS.ProcessEnv;
  embedFn?: EmbedFn;
  now?: () => number;
  /** How API-key clients wait between requests; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  maxPartBytes?: number;
}

export { syncItemFromPage } from "./sync-item.ts";

/** Sources whose people pages a connector page may link: its own and the default brain. */
function peopleSources(sourceId: string): string[] {
  return [...new Set([sourceId, "default"])];
}

export function toSyncAccount(a: ConnectorAccount): SyncAccount {
  return {
    id: a.id,
    sourceId: a.source_id,
    provider: a.provider,
    enabled: a.enabled,
    status: a.status,
    itemCapDaily: a.item_cap_daily,
    spendCapUsdDaily: a.spend_cap_usd_daily,
    accountLabel: a.account_label,
    services: a.services,
    config: a.config,
  };
}

/** The token provider's view of a vault credential. */
export function vaultCredentialStore(engine: Engine, kek: Kek): CredentialStore {
  return {
    async read(accountId) {
      const c = await readCredential(engine, kek, accountId);
      if (c === null) return null;
      return {
        accessToken: c.tokens.access_token,
        refreshToken: c.tokens.refresh_token ?? null,
        expiresAt: c.expiresAt === null ? null : new Date(c.expiresAt),
      };
    },
    async write(accountId, credential) {
      const account = await getAccount(engine, accountId);
      const stored = account !== null && await renewCredential(engine, kek, account, {
        access_token: credential.accessToken,
        ...(credential.refreshToken ? { refresh_token: credential.refreshToken } : {}),
      }, { expiresAt: credential.expiresAt });
      // Not a reconnect case: the owner or operator stopped the account while
      // the token was being renewed, and the run ends without storing it.
      if (!stored) throw new Error("the account was disconnected or paused while its token was renewed; the new token was not stored");
    },
  };
}

/**
 * A sealed API key as a token source. Nothing renews a key, so a refusal ends
 * in a reconnect: the owner saves a working key again.
 */
export function apiKeySource(credential: { tokens: { access_token: string } } | null, secret: (value: string) => void): TokenSource {
  // A missing credential is the operator's to look at, not a reconnect.
  if (credential === null) throw new Error("the account has no stored API key");
  const key = credential.tokens.access_token;
  secret(key);
  return {
    token: async () => key,
    refresh: async () => {
      throw new ReauthRequiredError("the provider refused the API key; save a working key to reconnect");
    },
  };
}

export function connectorRuntime(storage: Storage, opts: ConnectorRuntimeOptions): ConnectorSyncRuntime {
  const engine = storage.engine();
  const env = opts.env ?? process.env;
  const fetchFn: FetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? Date.now;

  /** How one account reads its provider: an OAuth token that renews, or a sealed API key. */
  const providerWiring = (account: SyncAccount): Pick<SyncDeps, "adapter" | "tokenSource" | "client"> => {
    const keyed = opts.providers.getApiKey(account.provider);
    if (keyed) {
      const limiter = limiterFor(`${keyed.id}:${account.id}`, { ...keyed.sync.limits, now, ...(opts.sleep ? { sleep: opts.sleep } : {}) });
      return {
        adapter: keyed.sync.adapter(account, { engine, now }),
        tokenSource: async (_account, secret) => apiKeySource(await readCredential(engine, opts.kek, account.id), secret),
        client: (_a, tokenSource) => new ConnectorClient({
          origin: keyed.sync.apiOrigin, tokenSource, fetch: fetchFn, limiter, now, ...(opts.sleep ? { sleep: opts.sleep } : {}),
        }),
      };
    }
    const provider = opts.providers.get(account.provider);
    const sync = provider?.sync;
    if (!provider || !sync) throw new ProviderCannotSyncError(account.provider);
    return {
      adapter: sync.adapter(account, { env, ...(opts.now ? { now: opts.now } : {}) }),
      tokenSource: async (_account, secret) => {
        const client = await resolveClient({ engine, kek: opts.kek, providers: opts.providers, fetch: fetchFn, env }, opts.kek, provider.id);
        const token = new URL(provider.tokenUrl);
        return createTokenProvider({
          engine,
          accountId: account.id,
          store: vaultCredentialStore(engine, opts.kek),
          refresh: tokenEndpointRefresh({ origin: token.origin, path: `${token.pathname}${token.search}`, ...client, fetch: fetchFn }),
          onSecret: secret,
          ...(opts.now ? { now: opts.now } : {}),
        });
      },
      client: (_a, tokenSource) => new ConnectorClient({ origin: sync.apiOrigin, tokenSource, fetch: fetchFn }),
    };
  };

  return {
    env,
    loadAccount: async (id) => {
      const a = await getAccount(engine, id);
      return a === null ? null : toSyncAccount(a);
    },
    runnableAccounts: async (sourceId) =>
      (await listAccounts(engine, { sourceId })).filter(a => a.enabled && a.status === "active").map(toSyncAccount),
    depsFor: (account): SyncDeps => {
      const wiring = providerWiring(account);
      if (!account.accountLabel) throw new Error(`connector account ${account.id} has no label`);
      const scope = { sourceId: account.sourceId, accountRef: accountRef(account.accountLabel) };
      return {
        ...wiring,
        accounts: {
          markNeedsReconnect: async (id, reason) => {
            // eslint-disable-next-line no-control-regex
            const why = reason.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, MAX_REASON) || DEFAULT_REASON;
            await markNeedsReconnect(engine, id, why);
          },
          recordRun: async (id, result) => {
            if (result.status === "success" || result.status === "nothing_new") await markAccountSynced(engine, id);
            await recordAccountRun(engine, id, result, new Date(now()));
          },
        },
        onUpstreamDelete: async (st, item) => {
          if (item.pageSlug === null) return;
          // A page that is already gone, or was never this account's, is left alone: nothing to delete.
          await softDeleteUpstreamPage(st, scope, { slug: item.pageSlug, externalId: item.externalId });
        },
        sweepRetention: async (st) =>
          (await sweepRetention(st, scope, { accountId: account.id, kinds: RETENTION_KINDS, env, ...(opts.now ? { now: opts.now } : {}) })).deleted.length,
        onItemWritten: async (st, item) => {
          await enrichConnectorPage(st, {
            page: { slug: item.slug, title: item.title, externalId: item.externalId, truth: item.truth ?? {}, ...item.enrich },
            sourceId: account.sourceId,
            ownAddresses: [account.accountLabel!],
            peopleSourceIds: peopleSources(account.sourceId),
          });
        },
        env,
        ...(opts.embedFn ? { embedFn: opts.embedFn } : {}),
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.maxPartBytes ? { maxPartBytes: opts.maxPartBytes } : {}),
      };
    },
  };
}

/**
 * Register `connector_sync` in this process when connectors are on and the
 * key loads. Returns whether it did; serve logs the answer.
 */
export function registerConnectorRuntimeIfEnabled(
  storage: Storage,
  env: NodeJS.ProcessEnv = process.env,
  providers: ProviderRegistry = builtinProviders(),
): boolean {
  if (!connectorsStatus(env).enabled) return false;
  const load = loadKek(env);
  if (load.kek === null) return false;
  registerConnectorSync(storage, connectorRuntime(storage, { kek: load.kek, providers, env }));
  return true;
}
