/**
 * Admin routes for members, groups and the grant-profile catalog — the same
 * operations as `memrain member` / `memrain group`, recorded with
 * via='admin_api'.
 *
 * Dispatched from handleAdminApi after its gates (admin session, same-origin
 * on writes, post-enroll cooldown — none of these routes is cooldown-exempt,
 * because each one widens or cuts access).
 *
 *   GET  /admin/api/members[?all=1]
 *   POST /admin/api/members                          {id, display_name?, email?, personal_source?}
 *   GET  /admin/api/members/:id
 *   POST /admin/api/members/:id/disable | enable | remove
 *   POST /admin/api/members/:id/bind | unbind         {kind: token|client|enrollment, id}
 *   GET  /admin/api/groups
 *   POST /admin/api/groups                           {id, display_name?}
 *   GET  /admin/api/groups/:id
 *   POST /admin/api/groups/:id/remove
 *   POST /admin/api/groups/:id/sources               {source_id, allow_owner_source?}
 *   POST /admin/api/groups/:id/sources/:source/revoke
 *   POST /admin/api/groups/:id/members               {member_id}
 *   POST /admin/api/groups/:id/members/:member/remove
 *   GET  /admin/api/grant-profiles
 */
import type { Engine } from "../core/engine/interface.ts";
import {
  addMember,
  bindCredential,
  boundCredentials,
  disableMember,
  enableMember,
  existingMember,
  listMemberAudit,
  listMembers,
  MemberError,
  removeMember,
  type CredentialKind,
  type MemberActor,
  type MemberErrorCode,
} from "../core/members.ts";
import {
  addGroup,
  addGroupMember,
  getGroup,
  grantGroupSource,
  listGroups,
  removeGroup,
  removeGroupMember,
  revokeGroupSource,
} from "../core/groups.ts";
import { GRANT_PROFILE_CATALOG_VERSION, GRANT_PROFILES } from "../core/grant-profiles.ts";
import { OperationError } from "../core/operation-error.ts";

const WHO: MemberActor = { actor: "admin", via: "admin_api" };

const STATUS: Record<MemberErrorCode, number> = {
  member_invalid: 400,
  not_found: 404,
  member_exists: 409,
  member_retired: 409,
  member_not_enabled: 409,
  email_taken: 409,
  credential_mixed: 409,
  owner_source: 409,
  source_shared: 409,
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const bad = (message: string) => json({ error: "member_invalid", message }, 400);

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await req.json();
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

function credential(b: Record<string, unknown>): { kind: CredentialKind; id: string } | null {
  const kind = b.kind;
  const id = str(b.id);
  if ((kind === "token" || kind === "client" || kind === "enrollment") && id !== undefined) return { kind, id };
  return null;
}

async function membersRoute(req: Request, url: URL, engine: Engine): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/admin/api/members") {
    if (req.method === "GET") return json({ members: await listMembers(engine, { includeRemoved: url.searchParams.get("all") === "1" }) });
    if (req.method !== "POST") return null;
    const b = await body(req);
    if (!b) return bad("invalid JSON body");
    const member = await addMember(engine, b.id, {
      ...(str(b.display_name) !== undefined ? { displayName: str(b.display_name) } : {}),
      ...(str(b.email) !== undefined ? { email: str(b.email) } : {}),
      ...(str(b.personal_source) !== undefined ? { personalSource: str(b.personal_source) } : {}),
    }, WHO);
    return json({ member }, 201);
  }
  const m = /^\/admin\/api\/members\/([^/]+)(?:\/(disable|enable|remove|bind|unbind))?$/.exec(p);
  if (!m) return null;
  const id = decodeURIComponent(m[1]!);
  const action = m[2];
  if (action === undefined) {
    if (req.method !== "GET") return null;
    const member = await existingMember(engine, id);
    return json({ member, credentials: await boundCredentials(engine, member.id), audit: await listMemberAudit(engine, { memberId: member.id, limit: 50 }) });
  }
  if (req.method !== "POST") return null;
  if (action === "disable") return json({ member: await disableMember(engine, id, WHO) });
  if (action === "enable") return json({ member: await enableMember(engine, id, WHO) });
  if (action === "remove") return json(await removeMember(engine, id, WHO));
  const b = await body(req);
  const target = b ? credential(b) : null;
  if (!target) return bad("body must be {kind: token|client|enrollment, id}");
  if (action === "bind") return json({ binding: await bindCredential(engine, (await existingMember(engine, id)).id, target, WHO) });
  // Unbinding names the member, checked under the credential's row lock, so a
  // stale page cannot unbind a key that was since rebound to someone else.
  const holder = (await existingMember(engine, id)).id;
  return json({ binding: await bindCredential(engine, null, target, WHO, { expectedMember: holder }) });
}

async function groupsRoute(req: Request, url: URL, engine: Engine): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/admin/api/groups") {
    if (req.method === "GET") return json({ groups: await listGroups(engine) });
    if (req.method !== "POST") return null;
    const b = await body(req);
    if (!b) return bad("invalid JSON body");
    return json({ group: await addGroup(engine, b.id, str(b.display_name) !== undefined ? { displayName: str(b.display_name) } : {}, WHO) }, 201);
  }
  const m = /^\/admin\/api\/groups\/([^/]+)(?:\/(remove|sources|members)(?:\/([^/]+)\/(revoke|remove))?)?$/.exec(p);
  if (!m) return null;
  const id = decodeURIComponent(m[1]!);
  const [, , section, target, verb] = m;
  if (section === undefined) {
    if (req.method !== "GET") return null;
    const group = await getGroup(engine, id);
    if (!group) return json({ error: "not_found", message: `no group "${id}"` }, 404);
    return json({ group, audit: await listMemberAudit(engine, { groupId: group.id, limit: 50 }) });
  }
  if (req.method !== "POST") return null;
  if (section === "remove" && target === undefined) return json({ removed: await removeGroup(engine, id, WHO) });
  if (section === "sources" && target !== undefined && verb === "revoke") {
    return json({ group: await revokeGroupSource(engine, id, decodeURIComponent(target), WHO) });
  }
  if (section === "members" && target !== undefined && verb === "remove") {
    return json({ group: await removeGroupMember(engine, id, decodeURIComponent(target), WHO) });
  }
  if (target !== undefined) return null;
  const b = await body(req);
  if (!b) return bad("invalid JSON body");
  if (section === "sources") {
    const sourceId = str(b.source_id);
    if (sourceId === undefined) return bad("body must name source_id");
    return json({ group: await grantGroupSource(engine, id, sourceId, { allowOwnerSource: b.allow_owner_source === true }, WHO) });
  }
  if (section === "members") return json({ group: await addGroupMember(engine, id, b.member_id, WHO) });
  return null;
}

export async function handleAdminMembers(req: Request, url: URL, engine: Engine): Promise<Response | null> {
  const p = url.pathname;
  try {
    if (p === "/admin/api/grant-profiles") {
      if (req.method !== "GET") return null;
      return json({ catalog_version: GRANT_PROFILE_CATALOG_VERSION, profiles: GRANT_PROFILES });
    }
    if (p === "/admin/api/members" || p.startsWith("/admin/api/members/")) return await membersRoute(req, url, engine);
    if (p === "/admin/api/groups" || p.startsWith("/admin/api/groups/")) return await groupsRoute(req, url, engine);
    return null;
  } catch (e) {
    if (e instanceof MemberError) return json({ error: e.code, message: e.message }, STATUS[e.code]);
    if (e instanceof OperationError && e.code === "tenant_limit_reached") return json({ error: e.code, message: e.message }, 409);
    // A malformed percent-escape in a path segment is the caller's mistake, not ours.
    if (e instanceof URIError) return bad("malformed path segment");
    throw e;
  }
}
