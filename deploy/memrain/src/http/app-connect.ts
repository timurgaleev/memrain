/**
 * Connect a client to the member's brain from /app. Every route sits behind
 * the member session and the same-origin check (http/app.ts).
 *
 *   GET    /app/api/connect              the MCP URL and the tenant connector's client_id
 *   POST   /app/api/connect/enrollment   a one-time code (24 h) for the connector,
 *                                        for Claude.ai and ChatGPT; a new one revokes
 *                                        the member's last unused one
 *   POST   /app/api/connect/token        {label, surface?} a member PAT for Claude Code,
 *                                        Codex or Cursor; shown once, only its hash kept
 *   GET    /app/api/connect/tokens       the member's live PATs (names and dates)
 *   DELETE /app/api/connect/token/:name  revoke one of the member's own PATs
 *
 * Both credentials are bound to the member and write to its personal source;
 * the verifier widens their reads by the member's groups and refuses them the
 * moment the member is disabled or removed.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Engine } from "../core/engine/interface.ts";
import type { MemberSession } from "../core/member-sessions.ts";
import { writeMemberAudit } from "../core/members.ts";
import { readBodyWithCap } from "./body_limit.ts";
import type { AppDeps } from "./app.ts";

const ENROLLMENT_TTL_S = 24 * 3600;
const BODY_CAP = 4096;
const MAX_LIVE_TOKENS = 10;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

function publicBase(deps: AppDeps, url: URL): string {
  const raw = (deps.publicUrl ?? "").trim() || url.origin;
  let end = raw.length;
  while (end > 0 && raw[end - 1] === "/") end--;
  return raw.slice(0, end);
}

/** The tenant's one enrollment-mode connector, or null when there is not exactly one. */
async function tenantConnector(engine: Engine): Promise<string | null> {
  const r = await engine.query<{ client_id: string }>(
    // scope: operator-only the brain's connector clients, read to name the one a member connects through
    `SELECT client_id FROM oauth_clients WHERE tenant_mode = 'enrollment' AND deleted_at IS NULL ORDER BY client_id LIMIT 2`,
  );
  return r.rows.length === 1 ? r.rows[0]!.client_id : null;
}

async function readJson(req: Request): Promise<Record<string, unknown> | Response> {
  const read = await readBodyWithCap(req, BODY_CAP);
  if (!read.ok) return read.response;
  if (read.buf.length === 0) return {};
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(read.buf));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : json({ error: "invalid_body" }, 400);
  } catch {
    return json({ error: "invalid_body" }, 400);
  }
}

function labelSlug(raw: unknown): string {
  const words = typeof raw === "string" ? raw.toLowerCase().split(/[^a-z0-9]/).filter(Boolean) : [];
  return words.join("-").slice(0, 24) || "key";
}

async function mintToken(engine: Engine, session: MemberSession & { personalSourceId: string }, body: Record<string, unknown>): Promise<Response> {
  const surface = body.surface === undefined ? "starter" : body.surface;
  if (surface !== "starter" && surface !== "full") return json({ error: "invalid_body", message: "`surface` is starter or full." }, 400);
  const token = `memrain_${randomBytes(32).toString("hex")}`;
  const name = `m-${session.memberId}-${labelSlug(body.label)}-${randomBytes(3).toString("hex")}`;
  const refused = await engine.transaction(async (tx) => {
    await tx.query(`SELECT id FROM members WHERE id = $1 FOR UPDATE`, [session.memberId]);
    const live = await tx.query<{ n: number }>(
      // scope: upstream the member's own keys, keyed by the member the session resolved
      `SELECT count(*)::int AS n FROM access_tokens WHERE member_id = $1 AND revoked_at IS NULL`,
      [session.memberId],
    );
    if (Number(live.rows[0]?.n ?? 0) >= MAX_LIVE_TOKENS) return true;
    await tx.query(
      `INSERT INTO access_tokens (name, token_hash, scopes, permissions, member_id, tool_surface)
       VALUES ($1, $2, $3::text[], $4::jsonb, $5, $6)`,
      [
        name,
        createHash("sha256").update(token, "utf8").digest("hex"),
        ["read", "write"],
        { source_id: [session.personalSourceId], takes_holders: ["world"] },
        session.memberId,
        surface,
      ],
    );
    await writeMemberAudit(tx, { actor: `member:${session.memberId}`, via: "app" }, {
      memberId: session.memberId,
      action: "bind",
      detail: { credential: { kind: "token", id: name }, previous_member_id: null },
    });
    return false;
  });
  if (refused) return json({ error: "too_many_keys", message: `Revoke a key first; a member holds at most ${MAX_LIVE_TOKENS}.` }, 409);
  return json({ name, token, surface, note: "Copy the key now; it is not shown again." });
}

async function listTokens(engine: Engine, memberId: string): Promise<Response> {
  const r = await engine.query<{ name: string; created_at: unknown; last_used_at: unknown; tool_surface: string | null }>(
    // scope: upstream the member's own keys, keyed by the member the session resolved
    `SELECT name, created_at, last_used_at, tool_surface FROM access_tokens
      WHERE member_id = $1 AND revoked_at IS NULL ORDER BY created_at, name`,
    [memberId],
  );
  const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
  return json({
    tokens: r.rows.map((t) => ({ name: t.name, created_at: iso(t.created_at), last_used_at: iso(t.last_used_at), surface: t.tool_surface ?? "full" })),
  });
}

async function revokeToken(engine: Engine, memberId: string, name: string): Promise<Response> {
  const r = await engine.query(
    // scope: upstream only the member's own key; another member's name matches nothing
    `UPDATE access_tokens SET revoked_at = now() WHERE name = $1 AND member_id = $2 AND revoked_at IS NULL RETURNING id`,
    [name, memberId],
  );
  return r.rows.length > 0 ? json({ ok: true }) : json({ error: "not_found" }, 404);
}

/** Null when `url` is not a connect route. */
export async function handleAppConnect(req: Request, url: URL, session: MemberSession, deps: AppDeps): Promise<Response | null> {
  const p = url.pathname;
  if (p !== "/app/api/connect" && !p.startsWith("/app/api/connect/")) return null;
  const engine = deps.storage.engine();
  if (session.personalSourceId === null) {
    return json({ error: "member_not_ready", message: "Your account has no personal space yet. Ask the brain operator to finish setting it up." }, 409);
  }
  const ready = session as MemberSession & { personalSourceId: string };
  try {
    if (p === "/app/api/connect" && req.method === "GET") {
      return json({ mcp_url: `${publicBase(deps, url)}/mcp`, client_id: await tenantConnector(engine) });
    }
    if (p === "/app/api/connect/enrollment" && req.method === "POST") {
      if (!deps.oauthProvider) return json({ error: "connect_unavailable" }, 503);
      const clientId = await tenantConnector(engine);
      if (clientId === null) return json({ error: "connector_not_configured" }, 503);
      const issued = await deps.oauthProvider.issueMemberEnrollment({
        memberId: ready.memberId, sourceId: ready.personalSourceId, clientId, ttlSeconds: ENROLLMENT_TTL_S,
      });
      return json({ code: issued.code, client_id: issued.clientId, expires_at: issued.expiresAt, mcp_url: `${publicBase(deps, url)}/mcp` });
    }
    if (p === "/app/api/connect/token" && req.method === "POST") {
      const body = await readJson(req);
      if (body instanceof Response) return body;
      return await mintToken(engine, ready, body);
    }
    if (p === "/app/api/connect/tokens" && req.method === "GET") return await listTokens(engine, ready.memberId);
    const one = /^\/app\/api\/connect\/token\/([^/]{1,200})$/.exec(p);
    if (one && req.method === "DELETE") return await revokeToken(engine, ready.memberId, decodeURIComponent(one[1]!));
  } catch (e) {
    console.error("[app] connect failed:", e instanceof Error ? e.message : e);
    return json({ error: "internal_error" }, 500);
  }
  return json({ error: "not_found" }, 404);
}
