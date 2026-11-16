/**
 * Admin routes for connector accounts: status, OAuth connect,
 * bring-your-own OAuth clients, saving a provider API key (Fireflies), and
 * the Connections page's account actions (sync on/off, disconnect, preview
 * and delete everything, held deletions and held items).
 *
 * `/admin/api/connectors*` is dispatched from handleAdminApi after its gates
 * (admin session, same-origin on writes, post-enroll cooldown), so this file
 * only routes. Connecting and disconnecting answer `connectors_disabled` until
 * MEMRAIN_CONNECTORS_ENABLED is on and the connector key loads; the rest work
 * with connectors off, so an owner can still stop a sync or delete its data.
 * A disconnect, and deleting an account's data, both need the account's name
 * typed back; deleting needs the account disconnected first.
 *
 * The provider sends the owner's browser back with a cross-site redirect, and
 * the admin session cookie is SameSite=Strict, so the callback request carries
 * no session. `/admin/connectors/callback/:provider` therefore only renders a
 * static page holding the returned parameters in a form; the owner's click
 * posts it from our own origin to `/complete`, which arrives with the session
 * and binds the state to it. The page runs no script and is never cached.
 */
import type { Storage } from "../core/storage.ts";
import type { Engine } from "../core/engine/interface.ts";
import { listSources } from "../core/sources.ts";
import { OperationError } from "../core/operation-error.ts";
import type { ConnectorClient, FetchFn } from "../core/connectors/client.ts";
import { credentialMeta, getAccount, listAccounts, setAccountConfig, setAccountEnabled, type ConnectorAccount } from "../core/connectors/accounts.ts";
import { ApiKeyConnectError, connectApiKey } from "../core/connectors/api-key-connect.ts";
import { listAccountStatus, type AccountStatus } from "../core/connectors/account-status.ts";
import { accountRef } from "../core/connectors/model.ts";
import {
  DEFAULT_HISTORY_DAYS,
  GOOGLE_CALENDAR_SERVICE,
  listGoogleCalendars,
  MAX_CALENDARS,
  MAX_HISTORY_DAYS,
  selectedCalendars,
  type GoogleCalendarEntry,
} from "../core/connectors/google/calendar.ts";
import { listOutlookCalendars, OUTLOOK_CALENDAR_SERVICE } from "../core/connectors/microsoft/calendar.ts";
import { connectorRuntime, toSyncAccount } from "../core/connectors/runtime.ts";
import { ReauthRequiredError } from "../core/connectors/types.ts";
import { deleteOAuthClient, listOAuthClients, setOAuthClient } from "../core/connectors/oauth-clients.ts";
import { deleteAllConnectorData, previewConnectorData } from "../core/connectors/retention.ts";
import {
  confirmHeldDeletes,
  forgetSyncState,
  heldDeleteCount,
  heldItemCount,
  listOpenNotices,
  rejectHeldDeletes,
  retryHeldItems,
  type OpenNotice,
} from "../core/connectors/sync-store.ts";
import {
  completeConnect,
  ConnectError,
  connectorCallbackUri,
  disconnectAccount,
  startConnect,
  type ConnectDeps,
} from "../core/connectors/oauth-connect.ts";
import type { ProviderRegistry, ProviderService } from "../core/connectors/providers.ts";
import { builtinProviders } from "../core/connectors/providers.ts";
import { connectorsStatus, loadKek, VaultError, type ConnectorsStatus, type Kek } from "../core/connectors/vault.ts";

export interface AdminConnectorDeps {
  storage: Storage;
  publicUrl?: string;
  /** The live admin session's id; the connect state is bound to it. */
  adminSessionId: (req: Request) => string | null;
  status: () => ConnectorsStatus;
  /** The loaded connector key, or null; read only when `status().enabled`. */
  kek: () => Kek | null;
  providers: ProviderRegistry;
  fetch?: FetchFn;
  env?: NodeJS.ProcessEnv;
}

/** Production wiring: flag and key from the environment, the shipped providers. */
export function defaultConnectorDeps(
  storage: Storage,
  publicUrl: string | undefined,
  adminSessionId: (req: Request) => string | null,
): AdminConnectorDeps {
  return {
    storage,
    ...(publicUrl ? { publicUrl } : {}),
    adminSessionId,
    status: () => connectorsStatus(),
    kek: () => loadKek().kek,
    providers: builtinProviders(),
  };
}

const PROVIDER_RE = /^[a-z][a-z0-9_]{0,31}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_HASH_RE = /^[0-9a-f]{16}$/;
/** Where a finished connect lands: the Connections page, which reads the outcome from the query. */
const DONE_PATH = "/admin/";
const DONE_HASH = "#connections";
const MAX_BODY = 16 * 1024;
const MAX_PARAM = 4096;
const PRINCIPAL = "admin:operator";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const redirect = (location: string) => new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (type.startsWith("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function connectDeps(deps: AdminConnectorDeps): ConnectDeps {
  return {
    engine: deps.storage.engine(),
    kek: deps.status().enabled ? deps.kek() : null,
    providers: deps.providers,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.env ? { env: deps.env } : {}),
  };
}

function disabled(deps: AdminConnectorDeps): Response {
  return json({ error: "connectors_disabled", reason: deps.status().reason }, 403);
}

/** The address a bring-your-own app must allow as its redirect; null until the public URL can receive one. */
function callbackUri(publicUrl: string | undefined, provider: string): string | null {
  if (!publicUrl) return null;
  try {
    return connectorCallbackUri(publicUrl, provider);
  } catch {
    return null;
  }
}

/** The source kinds each service may write into, as the Connections page filters sources by. */
function serviceKinds(services: Readonly<Record<string, ProviderService>>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(services).map(([id, s]) => [id, [...s.sourceKinds]]));
}

/** Everything the Connections page shows about one account; never a secret. */
async function describeAccount(engine: Engine, account: ConnectorAccount, notices: readonly OpenNotice[], status: AccountStatus | undefined) {
  const cred = await credentialMeta(engine, account.id);
  return {
    ...account,
    held_items: await heldItemCount(engine, account.id),
    held_deletes: await heldDeleteCount(engine, account.id),
    notices: notices.filter((n) => n.account_id === account.id).map(({ kind, detail, created_at }) => ({ kind, detail, created_at })),
    credential: cred ? { scopes: cred.scopes, expires_at: cred.expires_at, granted_at: cred.granted_at } : null,
    last_run: status?.last_run ?? null,
    needs_reconnect: status?.needs_reconnect ?? account.status === "needs_reconnect",
    grant_expiry: status?.grant_expiry ?? null,
  };
}

export async function handleAdminConnectors(req: Request, url: URL, deps: AdminConnectorDeps): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/admin/api/connectors" && req.method === "GET") {
    const st = deps.status();
    const engine = deps.storage.engine();
    const notices = await listOpenNotices(engine);
    const accounts = await listAccounts(engine);
    const statuses = new Map((await listAccountStatus(engine)).map((s) => [s.id, s]));
    return json({
      enabled: st.enabled,
      reason: st.reason,
      kek_id: st.kekId,
      providers: [
        ...deps.providers.list().map((pr) => ({
          id: pr.id,
          services: Object.keys(pr.services),
          service_kinds: serviceKinds(pr.services),
          auth: "oauth",
          callback_uri: callbackUri(deps.publicUrl, pr.id),
        })),
        ...deps.providers.listApiKey().map((pr) => ({
          id: pr.id,
          services: Object.keys(pr.services),
          service_kinds: serviceKinds(pr.services),
          auth: "api_key",
          callback_uri: null,
        })),
      ],
      sources: (await listSources(engine)).map((s) => ({ id: s.id, kind: s.kind })),
      accounts: await Promise.all(accounts.map((a) => describeAccount(engine, a, notices, statuses.get(a.id)))),
      clients: await listOAuthClients(engine),
    });
  }

  const acct = /^\/admin\/api\/connectors\/accounts\/([^/]+)\/(enable|disable|disconnect|preview|delete-data|retry-held|deletions\/confirm|deletions\/reject)$/.exec(p);
  if (acct) return accountAction(req, acct[1]!, acct[2]!, deps);

  const calendars = /^\/admin\/api\/connectors\/accounts\/([^/]+)\/calendars$/.exec(p);
  if (calendars) return calendarsAction(req, calendars[1]!, deps);

  const clientDelete = /^\/admin\/api\/connectors\/([^/]+)\/client\/delete$/.exec(p);
  if (clientDelete && req.method === "POST") {
    const provider = clientDelete[1]!;
    if (!PROVIDER_RE.test(provider) || !deps.providers.get(provider)) return json({ error: "unknown_provider" }, 400);
    return json({ ok: true, deleted: await deleteOAuthClient(deps.storage.engine(), provider) });
  }

  const m = /^\/admin\/api\/connectors\/([^/]+)\/(start|complete|client|key)$/.exec(p);
  if (!m || req.method !== "POST") return null;
  const provider = m[1]!;
  const action = m[2]!;
  if (!PROVIDER_RE.test(provider)) return json({ error: "unknown_provider" }, 400);

  if (action === "complete") return complete(req, provider, deps);
  if (!deps.status().enabled || deps.kek() === null) return disabled(deps);
  const body = await readBody(req);
  if (!body) return json({ error: "invalid body" }, 400);

  if (action === "key") return saveKey(provider, body, deps);

  if (action === "client") {
    if (!deps.providers.get(provider)) return json({ error: "unknown_provider" }, 400);
    if (typeof body.client_id !== "string" || typeof body.client_secret !== "string") {
      return json({ error: "client_id and client_secret are required" }, 400);
    }
    try {
      await setOAuthClient(deps.storage.engine(), deps.kek()!, provider, body.client_id, body.client_secret);
    } catch {
      return json({ error: "invalid client" }, 400);
    }
    return json({ ok: true, provider, client_id: body.client_id });
  }

  const session = deps.adminSessionId(req);
  if (!session) return json({ error: "Admin authentication required" }, 401);
  if (!deps.publicUrl) return json({ error: "redirect_uri", reason: "MEMRAIN_PUBLIC_URL is required to connect a provider" }, 400);
  const services = Array.isArray(body.services) && body.services.every((s) => typeof s === "string") ? body.services as string[] : [];
  try {
    const started = await startConnect(connectDeps(deps), {
      provider,
      sourceId: typeof body.source_id === "string" ? body.source_id : "",
      services,
      principalRef: PRINCIPAL,
      adminSessionId: session,
      redirectUri: connectorCallbackUri(deps.publicUrl, provider),
    });
    return json({ authorize_url: started.authorizeUrl, expires_at: started.expiresAt });
  } catch (e) {
    if (e instanceof ConnectError) return e.code === "connectors_disabled" ? disabled(deps) : json({ error: e.code }, 400);
    throw e;
  }
}

/** Save a provider API key: verified with the provider, sealed, never echoed. */
async function saveKey(provider: string, body: Record<string, unknown>, deps: AdminConnectorDeps): Promise<Response> {
  try {
    const { account, reconnected } = await connectApiKey(connectDeps(deps), {
      provider,
      sourceId: typeof body.source_id === "string" ? body.source_id : "",
      apiKey: body.api_key,
      principalRef: PRINCIPAL,
    });
    const { id, source_id, services, account_label, status, enabled } = account;
    return json({ ok: true, reconnected, account: { id, source_id, provider: account.provider, services, account_label, status, enabled } });
  } catch (e) {
    if (!(e instanceof ApiKeyConnectError)) throw e;
    if (e.code === "connectors_disabled") return disabled(deps);
    return json({ error: e.code }, e.code === "provider_unavailable" ? 502 : 400);
  }
}

/** The typed confirmation must name the account exactly (surrounding spaces aside). */
function confirmsAccount(body: Record<string, unknown> | null, account: ConnectorAccount): boolean {
  return typeof body?.confirm_label === "string" && body.confirm_label.trim() === account.account_label;
}

/** Deleting everything is for an account that can no longer sync it back. */
function isDisconnected(account: ConnectorAccount): boolean {
  return account.status === "revoked" || (account.status === "error" && account.status_reason === "revoke_failed");
}

/**
 * Connector pages name their owner by a hash of the lowercased label, without
 * the provider. Another account in the same source with that label (the same
 * mailbox through another provider, or the address in other case) owns pages
 * the scope cannot tell apart, so deleting by it would take that account's
 * pages too.
 */
async function sharesOwner(engine: Engine, account: ConnectorAccount, ref: string): Promise<boolean> {
  return (await listAccounts(engine, { sourceId: account.source_id }))
    .some((other) => other.id !== account.id && accountRef(other.account_label) === ref);
}

const SHARED_OWNER = {
  error: "shared_owner",
  message: "Another account in this source writes pages under the same name, so they cannot be told apart. Remove that account first.",
};

async function accountAction(req: Request, id: string, action: string, deps: AdminConnectorDeps): Promise<Response | null> {
  if (req.method !== (action === "preview" ? "GET" : "POST")) return null;
  if (!UUID_RE.test(id)) return json({ error: "invalid account id" }, 400);
  const engine = deps.storage.engine();
  const account = await getAccount(engine, id);
  if (!account) return json({ error: "account_not_found" }, 404);
  const scope = { sourceId: account.source_id, accountRef: accountRef(account.account_label) };

  try {
    switch (action) {
      case "enable":
      case "disable":
        // A disconnected account has no credential to sync with; switching it on would read as on while nothing runs.
        if (action === "enable" && isDisconnected(account)) {
          return json({ error: "not_connected", message: "Reconnect the account before switching its sync on." }, 409);
        }
        await setAccountEnabled(engine, id, action === "enable");
        return json({ ok: true, enabled: action === "enable" });
      case "retry-held":
        return json({ ok: true, retried: await retryHeldItems(engine, id) });
      case "deletions/confirm":
        return json({ ok: true, confirmed: await confirmHeldDeletes(engine, id) });
      case "deletions/reject":
        return json({ ok: true, kept: await rejectHeldDeletes(engine, id) });
      case "preview":
        if (await sharesOwner(engine, account, scope.accountRef)) return json(SHARED_OWNER, 409);
        return json(await previewConnectorData(deps.storage, scope));
      case "disconnect": {
        if (!confirmsAccount(await readBody(req), account)) return json({ error: "confirm_mismatch" }, 400);
        if (!deps.status().enabled || deps.kek() === null) return disabled(deps);
        const r = await disconnectAccount(connectDeps(deps), id);
        return json({ ok: true, revoked: r.revoked, credential_kept: r.credentialKept });
      }
      case "delete-data": {
        const body = await readBody(req);
        if (!confirmsAccount(body, account)) return json({ error: "confirm_mismatch" }, 400);
        if (typeof body?.plan_hash !== "string" || !PLAN_HASH_RE.test(body.plan_hash)) return json({ error: "plan_hash is required" }, 400);
        if (!isDisconnected(account)) {
          return json({ error: "still_connected", message: "Disconnect the account first, so a sync cannot bring the pages back." }, 409);
        }
        if (await sharesOwner(engine, account, scope.accountRef)) return json(SHARED_OWNER, 409);
        // The pages go one transaction each, so a run can stop part-way. The
        // sync state is cleared first, in one transaction, while the pages it
        // describes still exist: a failure at any point leaves either every
        // page and its state, or state already gone with the remaining pages
        // still listed by a new preview, so deleting again finishes the job.
        // A disconnected account syncs nothing, so nothing reads the state.
        if ((await previewConnectorData(deps.storage, scope)).plan_hash !== body.plan_hash) {
          return json({ error: "conflict", message: "The account's data changed since the preview." }, 409);
        }
        let r: Awaited<ReturnType<typeof deleteAllConnectorData>>;
        try {
          await forgetSyncState(engine, id);
          r = await deleteAllConnectorData(deps.storage, scope, { expectedPlanHash: body.plan_hash });
        } catch (e) {
          if (e instanceof OperationError) throw e;
          console.error("[admin-connectors] delete-data stopped part-way:", e instanceof Error ? e.name : "error");
          return json({ error: "delete_incomplete", message: "Deleting stopped part-way. Preview again and delete what is left." }, 500);
        }
        return json({ ok: true, deleted: r.deleted.length, changed: r.changed.length });
      }
      default:
        return null;
    }
  } catch (e) {
    if (e instanceof ConnectError) return json({ error: e.code }, e.code === "account_not_found" ? 404 : 409);
    if (e instanceof OperationError) {
      return json({ error: e.code, message: e.message, suggestion: e.suggestion }, e.code === "conflict" ? 409 : 400);
    }
    console.error(`[admin-connectors] ${action} failed:`, e instanceof Error ? e.name : "error");
    return json({ error: "internal error" }, 500);
  }
}

/** How each calendar provider lists the calendars an account can read. */
const CALENDAR_LISTS: Readonly<Record<string, { service: string; name: string; list: (client: ConnectorClient) => Promise<GoogleCalendarEntry[]> }>> = {
  google: { service: GOOGLE_CALENDAR_SERVICE, name: "Google", list: listGoogleCalendars },
  microsoft: { service: OUTLOOK_CALENDAR_SERVICE, name: "Microsoft", list: listOutlookCalendars },
};

/** The calendars a calendar account can read, fetched with its own credential. */
async function readableCalendars(account: ConnectorAccount, deps: AdminConnectorDeps): Promise<GoogleCalendarEntry[]> {
  const runtime = connectorRuntime(deps.storage, {
    kek: deps.kek()!, providers: deps.providers, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.env ? { env: deps.env } : {}),
  });
  const sync = toSyncAccount(account);
  const wiring = runtime.depsFor(sync);
  const client = wiring.client(sync, await wiring.tokenSource(sync, () => {}));
  return CALENDAR_LISTS[account.provider]!.list(client);
}

function historyDays(account: ConnectorAccount): number {
  const v = account.config["history_days"];
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_HISTORY_DAYS ? v : DEFAULT_HISTORY_DAYS;
}

/**
 * The calendar picker: GET lists what the account can read and what syncs;
 * POST saves `calendars` (ids the provider lists for the account; primary always
 * syncs and is not stored) and `history_days` into the account's config.
 * A new window applies to calendars that have not had their first sync.
 */
async function calendarsAction(req: Request, id: string, deps: AdminConnectorDeps): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "POST") return null;
  if (!UUID_RE.test(id)) return json({ error: "invalid account id" }, 400);
  if (!deps.status().enabled || deps.kek() === null) return disabled(deps);
  const engine = deps.storage.engine();
  const account = await getAccount(engine, id);
  if (!account) return json({ error: "account_not_found" }, 404);
  const calendarProvider = Object.hasOwn(CALENDAR_LISTS, account.provider) ? CALENDAR_LISTS[account.provider]! : null;
  if (calendarProvider === null || !account.services.includes(calendarProvider.service) || !deps.providers.get(account.provider)) {
    return json({ error: "no_calendars", message: "Only a Google or Outlook calendar account has calendars to pick." }, 400);
  }
  if (account.status !== "active") return json({ error: "not_connected", message: "Reconnect the account before picking its calendars." }, 409);

  const body = req.method === "POST" ? await readBody(req) : null;
  if (req.method === "POST") {
    if (!body) return json({ error: "invalid body" }, 400);
    if (body.calendars !== undefined && (!Array.isArray(body.calendars) || !body.calendars.every((c) => typeof c === "string"))) {
      return json({ error: "calendars must be a list of calendar ids" }, 400);
    }
    const days = body.history_days;
    if (days !== undefined && !(typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= MAX_HISTORY_DAYS)) {
      return json({ error: "invalid_history_days", message: `history_days is a whole number from 1 to ${MAX_HISTORY_DAYS}.` }, 400);
    }
  }

  let listed: GoogleCalendarEntry[];
  try {
    listed = await readableCalendars(account, deps);
  } catch (e) {
    if (e instanceof ReauthRequiredError) return json({ error: "not_connected", message: `${calendarProvider.name} refused the account's access; reconnect it.` }, 409);
    console.error("[admin-connectors] calendar list failed:", e instanceof Error ? e.name : "error");
    return json({ error: "provider_unavailable" }, 502);
  }

  if (req.method === "GET") {
    const selected = new Set(selectedCalendars(toSyncAccount(account)));
    return json({
      calendars: listed.map((c) => ({ id: c.id, summary: c.summary, primary: c.primary, access_role: c.accessRole, selected: c.primary || selected.has(c.id) })),
      history_days: historyDays(account),
    });
  }

  const patch: Record<string, unknown> = {};
  if (Array.isArray(body!.calendars)) {
    const readable = new Map(listed.map((c) => [c.id, c]));
    const chosen = [...new Set(body!.calendars as string[])];
    if (chosen.some((c) => !readable.has(c))) return json({ error: "unknown_calendar", message: "Pick calendars from the list this account can read." }, 400);
    const secondary = chosen.filter((c) => !readable.get(c)!.primary);
    if (secondary.length > MAX_CALENDARS - 1) return json({ error: "too_many_calendars", message: `At most ${MAX_CALENDARS - 1} calendars besides primary.` }, 400);
    patch.calendars = secondary;
  }
  if (body!.history_days !== undefined) patch.history_days = body!.history_days;
  await setAccountConfig(engine, id, patch);
  const saved = (await getAccount(engine, id))!;
  return json({ ok: true, calendars: Array.isArray(saved.config["calendars"]) ? saved.config["calendars"] : [], history_days: historyDays(saved) });
}

async function complete(req: Request, provider: string, deps: AdminConnectorDeps): Promise<Response> {
  const session = deps.adminSessionId(req);
  if (!session) return redirect(`${DONE_PATH}?connector_error=state_session${DONE_HASH}`);
  const body = await readBody(req);
  if (!body) return redirect(`${DONE_PATH}?connector_error=state_invalid${DONE_HASH}`);
  try {
    await completeConnect(connectDeps(deps), { provider, state: body.state, code: body.code, error: body.error, adminSessionId: session });
    return redirect(`${DONE_PATH}?connector=connected${DONE_HASH}`);
  } catch (e) {
    if (e instanceof ConnectError) return redirect(`${DONE_PATH}?connector_error=${e.code}${DONE_HASH}`);
    if (e instanceof VaultError) return redirect(`${DONE_PATH}?connector_error=vault${DONE_HASH}`);
    console.error("[admin-connectors] complete failed:", e instanceof Error ? e.name : "error");
    return redirect(`${DONE_PATH}?connector_error=internal${DONE_HASH}`);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function param(url: URL, name: string): string {
  const v = url.searchParams.get(name) ?? "";
  return v.length <= MAX_PARAM ? v : "";
}

/** The landing page of a provider redirect: a form that posts back same-origin. */
export function handleConnectorCallbackPage(req: Request, url: URL): Response | null {
  const m = /^\/admin\/connectors\/callback\/([^/]+)$/.exec(url.pathname);
  if (!m) return null;
  if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
  let provider: string;
  try {
    provider = decodeURIComponent(m[1]!);
  } catch {
    return new Response("Not Found", { status: 404 });
  }
  if (!PROVIDER_RE.test(provider)) return new Response("Not Found", { status: 404 });
  const fields = (["state", "code", "error"] as const)
    .map((k) => [k, param(url, k)] as const)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Finish connecting</title></head><body>`
    + `<form method="post" action="/admin/api/connectors/${provider}/complete">${fields}`
    + `<p>Finish connecting your ${escapeHtml(provider)} account to Memrain.</p>`
    + `<button type="submit">Finish connecting</button></form></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // Not no-referrer: under that policy browsers send `Origin: null` on the
      // form post, and the same-origin check on /complete refuses it.
      // strict-origin still keeps the code out of Referer (origin only).
      "referrer-policy": "strict-origin",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}
