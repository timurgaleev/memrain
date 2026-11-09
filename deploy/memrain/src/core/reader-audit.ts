import type { Storage } from "./storage.ts";
import { OAuthProvider, InvalidTokenError } from "./oauth-provider.ts";
import { getPage } from "./pages.ts";
import { effectiveReadSourceIdsForIngress, tenantFailClosedEnabled, type AuthInfo } from "./auth-info.ts";
import { dispatchTool, isDiaryPage } from "../mcp/dispatch.ts";
import { canonicalResource } from "../http/oauth-metadata.ts";

export interface ReaderVerdict {
  kind: "pat" | "oauth" | "enrollment";
  id: string;
  name: string;
  client_id?: string;
  verdict: "readable" | "readable_redacted" | "denied";
  rule: string;
  credentials: number;
}

const LIMIT = 1000;
const INVALID_RULES: Readonly<Record<string, string>> = {
  "Client revoked": "client_revoked", "Grant revoked": "grant_revoked",
  "Token expired": "token_expired", "Invalid token": "token_invalid_or_revoked",
  "Token holds no scope its client is still granted": "scope_withdrawn",
};

/** Current issued credentials, not a promise about future consent or token issuance. */
export async function inspectPageReaders(storage: Storage, slug: string) {
  const e = storage.engine();
  const provider = new OAuthProvider({ engine: e });
  const page = await getPage(storage, slug, undefined, { includeDeleted: true });
  const pats = await e.query<{ id: number | string; name: string; token_hash: string }>(
    "SELECT id, name, token_hash FROM access_tokens ORDER BY id LIMIT $1", [LIMIT + 1]);
  const oauth = await e.query<{ client_id: string; grant_id: string | null; token_hash: string }>(
    "SELECT client_id, CASE WHEN grant_bound THEN grant_id END AS grant_id, token_hash FROM oauth_tokens WHERE token_type = 'access' ORDER BY client_id, created_at, token_hash LIMIT $1", [LIMIT + 1]);
  const clients = await e.query<{ client_id: string; client_name: string; deleted_at: unknown }>(
    "SELECT client_id, client_name, deleted_at FROM oauth_clients ORDER BY client_id LIMIT $1", [LIMIT + 1]);
  const enrollments = await e.query<{ id: string; label: string | null; client_id: string | null; used_at: unknown; revoked_at: unknown }>(
    "SELECT id, label, client_id, used_at, revoked_at FROM oauth_enrollments ORDER BY id LIMIT $1", [LIMIT + 1]);

  const readers: ReaderVerdict[] = [];
  const clientNames = new Map(clients.rows.map(c => [c.client_id, c.client_name]));
  const enrollmentNames = new Map(enrollments.rows.map(c => [c.id, c.label ?? c.id]));
  const issuer = process.env.MEMRAIN_PUBLIC_URL;
  let audienceUnchecked = false;
  async function check(hash: string): Promise<Pick<ReaderVerdict, "verdict" | "rule">> {
    let info: Awaited<ReturnType<OAuthProvider["inspectAccessTokenHash"]>>;
    try { info = await provider.inspectAccessTokenHash(hash); }
    catch (error) {
      if (!(error instanceof InvalidTokenError)) throw error;
      return { verdict: "denied", rule: INVALID_RULES[error.message] ?? "invalid_credential" };
    }
    if (info.resource) {
      if (issuer && canonicalResource(info.resource.toString(), issuer) === null) return { verdict: "denied", rule: "resource_mismatch" };
      if (!issuer) audienceUnchecked = true;
    }
    const auth: AuthInfo = { ...info, token: "", isPublic: false };
    // The admin read mode suppresses retrieval touches; it grants no authority.
    const response = await dispatchTool(storage, { name: "page_get", arguments: { slug } }, { authInfo: auth, adminPanel: true });
    const data = JSON.parse(response.content[0]!.text);
    if (response.isError || data.ok === false) {
      if (data.error !== "not_found") {
        if (!["insufficient_scope", "permission_denied"].includes(data.error)) throw new Error(`page_get audit failed (${data.error ?? "unknown"})`);
        return { verdict: "denied", rule: data.error };
      }
      const scope = effectiveReadSourceIdsForIngress(auth, { failClosed: tenantFailClosedEnabled() });
      const rule = !page ? "page_not_found" : scope && !scope.includes(page.source_id) ? "source_scope"
        : page.deleted_at ? "page_deleted" : isDiaryPage(page.type, page.slug) ? "diary_fence" : "page_not_visible";
      return { verdict: "denied", rule };
    }
    const redacted = data.notice === "page_quarantined" || Number(data.redacted_secrets) > 0;
    return { verdict: redacted ? "readable_redacted" : "readable",
      rule: data.notice === "page_quarantined" ? "quarantine_redaction" : redacted ? "credential_redaction" : "page_get_allowed" };
  }
  for (const p of pats.rows.slice(0, LIMIT)) {
    readers.push({ kind: "pat", id: String(p.id), name: p.name, credentials: 1, ...await check(p.token_hash) });
  }
  const groups = new Map<string, ReaderVerdict>();
  const rank = { denied: 0, readable_redacted: 1, readable: 2 };
  for (const t of oauth.rows.slice(0, LIMIT)) {
    const kind = t.grant_id ? "enrollment" : "oauth";
    const id = t.grant_id ?? t.client_id;
    const key = `${kind}:${id}:${t.client_id}`;
    const verdict = await check(t.token_hash);
    const previous = groups.get(key);
    const best = previous && rank[previous.verdict] > rank[verdict.verdict] ? previous : verdict;
    groups.set(key, { kind, id, client_id: t.client_id, name: t.grant_id ? enrollmentNames.get(id) ?? id : clientNames.get(id) ?? id,
      credentials: (previous?.credentials ?? 0) + 1, verdict: best.verdict, rule: best.rule });
  }
  readers.push(...groups.values());
  for (const c of clients.rows.slice(0, LIMIT)) {
    if (!readers.some(r => r.client_id === c.client_id)) readers.push({ kind: "oauth", id: c.client_id, name: c.client_name,
      client_id: c.client_id, credentials: 0, verdict: "denied", rule: c.deleted_at ? "client_revoked" : "no_access_token" });
  }
  for (const g of enrollments.rows.slice(0, LIMIT)) {
    if (!readers.some(r => r.kind === "enrollment" && r.id === g.id)) readers.push({ kind: "enrollment", id: g.id, name: g.label ?? g.id,
      ...(g.client_id ? { client_id: g.client_id } : {}), credentials: 0, verdict: "denied",
      rule: g.revoked_at ? "grant_revoked" : g.used_at ? "no_access_token" : "not_redeemed" });
  }
  return { slug, basis: "issued_access_credentials", readers,
    truncated: [pats, oauth, clients, enrollments].some(r => r.rows.length > LIMIT),
    ...(audienceUnchecked ? { audience_unchecked: true, note: "Set MEMRAIN_PUBLIC_URL to check resource-bound token audiences." } : {}),
    note_scope: "Current PATs and issued OAuth access tokens; invitations and clients without access tokens are named separately. Refresh, future grants, and the static public/internal bearers are outside this credential inventory." };
}
