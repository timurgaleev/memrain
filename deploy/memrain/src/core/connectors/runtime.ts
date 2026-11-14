/**
 * The connector runtime: the sync engine wired to the rest of the connector
 * stack. Accounts and their credentials come from the vault (accounts.ts), the
 * OAuth client and token endpoint from the provider registry, a refused
 * refresh parks the account through `markNeedsReconnect`, and a provider-side
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
  markNeedsReconnect,
  readCredential,
  renewCredential,
  type ConnectorAccount,
} from "./accounts.ts";
import { ConnectorClient, type FetchFn } from "./client.ts";
import { accountRef } from "./model.ts";
import { resolveClient } from "./oauth-connect.ts";
import { builtinProviders, type ProviderRegistry } from "./providers.ts";
import type { RenderedConnectorPage } from "./render.ts";
import { hardDeleteConnectorPage } from "./retention.ts";
import type { RenderedSyncItem, SyncAccount, SyncDeps } from "./sync-engine.ts";
import { registerConnectorSync, type ConnectorSyncRuntime } from "./sync-job.ts";
import { createTokenProvider, tokenEndpointRefresh, type CredentialStore } from "./token-provider.ts";
import { ProviderCannotSyncError } from "./types.ts";
import { connectorsStatus, loadKek, type Kek } from "./vault.ts";

const MAX_REASON = 200;
const DEFAULT_REASON = "the provider will not renew the credential; reconnect the account";

export interface ConnectorRuntimeOptions {
  kek: Kek;
  providers: ProviderRegistry;
  fetch?: FetchFn;
  env?: NodeJS.ProcessEnv;
  embedFn?: EmbedFn;
  now?: () => number;
  maxPartBytes?: number;
}

/** A rendered connector page as a sync item; `version` is the provider's item version. */
export function syncItemFromPage(page: RenderedConnectorPage, version: string | null): RenderedSyncItem {
  const dedupe = page.truth["dedupe_key"];
  return {
    externalId: page.externalId,
    version,
    slug: page.slug,
    type: page.type,
    title: page.title,
    body: page.body,
    truth: page.truth,
    dedupeKey: typeof dedupe === "string" ? dedupe : null,
  };
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

export function connectorRuntime(storage: Storage, opts: ConnectorRuntimeOptions): ConnectorSyncRuntime {
  const engine = storage.engine();
  const env = opts.env ?? process.env;
  const fetchFn: FetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
  return {
    env,
    loadAccount: async (id) => {
      const a = await getAccount(engine, id);
      return a === null ? null : toSyncAccount(a);
    },
    runnableAccounts: async (sourceId) =>
      (await listAccounts(engine, { sourceId })).filter(a => a.enabled && a.status === "active").map(toSyncAccount),
    depsFor: (account): SyncDeps => {
      const provider = opts.providers.get(account.provider);
      const sync = provider?.sync;
      if (!provider || !sync) throw new ProviderCannotSyncError(account.provider);
      if (!account.accountLabel) throw new Error(`connector account ${account.id} has no label`);
      const scope = { sourceId: account.sourceId, accountRef: accountRef(account.accountLabel) };
      return {
        adapter: sync.adapter(account),
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
        accounts: {
          markNeedsReconnect: async (id, reason) => {
            // eslint-disable-next-line no-control-regex
            const why = reason.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, MAX_REASON) || DEFAULT_REASON;
            await markNeedsReconnect(engine, id, why);
          },
        },
        onUpstreamDelete: async (st, item) => {
          if (item.pageSlug === null) return;
          // A page that is already gone, or was never this account's, is left alone: nothing to delete.
          await hardDeleteConnectorPage(st, scope, { slug: item.pageSlug, reason: "provider_deleted", externalId: item.externalId });
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
