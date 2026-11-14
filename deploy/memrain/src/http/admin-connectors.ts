/**
 * Admin routes for connector accounts: status, OAuth connect and
 * bring-your-own OAuth clients.
 *
 * `/admin/api/connectors*` is dispatched from handleAdminApi after its gates
 * (admin session, same-origin on writes, post-enroll cooldown), so this file
 * only routes. Everything answers `connectors_disabled` until
 * MEMRAIN_CONNECTORS_ENABLED is on and the connector key loads.
 *
 * The provider sends the owner's browser back with a cross-site redirect, and
 * the admin session cookie is SameSite=Strict, so the callback request carries
 * no session. `/admin/connectors/callback/:provider` therefore only renders a
 * static page holding the returned parameters in a form; the owner's click
 * posts it from our own origin to `/complete`, which arrives with the session
 * and binds the state to it. The page runs no script and is never cached.
 */
import type { Storage } from "../core/storage.ts";
import type { FetchFn } from "../core/connectors/client.ts";
import { listAccounts } from "../core/connectors/accounts.ts";
import { listOAuthClients, setOAuthClient } from "../core/connectors/oauth-clients.ts";
import { completeConnect, ConnectError, connectorCallbackUri, startConnect, type ConnectDeps } from "../core/connectors/oauth-connect.ts";
import type { ProviderRegistry } from "../core/connectors/providers.ts";
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

export async function handleAdminConnectors(req: Request, url: URL, deps: AdminConnectorDeps): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/admin/api/connectors" && req.method === "GET") {
    const st = deps.status();
    const engine = deps.storage.engine();
    return json({
      enabled: st.enabled,
      reason: st.reason,
      kek_id: st.kekId,
      providers: deps.providers.list().map((pr) => ({ id: pr.id, services: Object.keys(pr.services) })),
      accounts: await listAccounts(engine),
      clients: await listOAuthClients(engine),
    });
  }

  const m = /^\/admin\/api\/connectors\/([^/]+)\/(start|complete|client)$/.exec(p);
  if (!m || req.method !== "POST") return null;
  const provider = m[1]!;
  const action = m[2]!;
  if (!PROVIDER_RE.test(provider)) return json({ error: "unknown_provider" }, 400);

  if (action === "complete") return complete(req, provider, deps);
  if (!deps.status().enabled || deps.kek() === null) return disabled(deps);
  const body = await readBody(req);
  if (!body) return json({ error: "invalid body" }, 400);

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

async function complete(req: Request, provider: string, deps: AdminConnectorDeps): Promise<Response> {
  const session = deps.adminSessionId(req);
  if (!session) return redirect("/admin/?connector_error=state_session");
  const body = await readBody(req);
  if (!body) return redirect("/admin/?connector_error=state_invalid");
  try {
    await completeConnect(connectDeps(deps), { provider, state: body.state, code: body.code, error: body.error, adminSessionId: session });
    return redirect("/admin/?connector=connected");
  } catch (e) {
    if (e instanceof ConnectError) return redirect(`/admin/?connector_error=${e.code}`);
    if (e instanceof VaultError) return redirect("/admin/?connector_error=vault");
    console.error("[admin-connectors] complete failed:", e instanceof Error ? e.name : "error");
    return redirect("/admin/?connector_error=internal");
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
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}
