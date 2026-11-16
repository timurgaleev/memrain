/**
 * Groups: named sets of members that read the same shared sources.
 *
 *   member ──► group_members ──► group ──► group_sources ──► source
 *
 * The token verifier unions a member's group sources into the read set of
 * every credential bound to that member (core/members.ts, memberAccess), on
 * every request, so a membership change takes effect on the next call with
 * no token rotation. A group grants reads only; a credential still writes
 * where its own grant says.
 *
 * The owner's own source (`default`) is the whole private brain. Adding it to
 * a group needs an explicit override, and the audit row says it was used.
 */
import type { Engine } from "./engine/interface.ts";
import { assertMemberId, existingMember, MemberError, writeMemberAudit, type MemberActor } from "./members.ts";

export const OWNER_SOURCE_ID = "default";

export interface GroupRecord {
  id: string;
  display_name: string | null;
  sources: string[];
  members: string[];
  created_at: string | null;
}

function toRecord(row: Record<string, unknown>): GroupRecord {
  const created = row.created_at;
  return {
    id: String(row.id),
    display_name: (row.display_name as string | null) ?? null,
    sources: Array.isArray(row.sources) ? (row.sources as string[]) : [],
    members: Array.isArray(row.members) ? (row.members as string[]) : [],
    created_at: created == null ? null : created instanceof Date ? created.toISOString() : String(created),
  };
}

// scope: operator-only the operator manages groups across every source
const GROUP_SELECT = `SELECT g.id, g.display_name, g.created_at,
  COALESCE((SELECT array_agg(gs.source_id ORDER BY gs.source_id) FROM group_sources gs WHERE gs.group_id = g.id), '{}') AS sources,
  COALESCE((SELECT array_agg(gm.member_id ORDER BY gm.member_id) FROM group_members gm WHERE gm.group_id = g.id), '{}') AS members
  FROM groups g`;

export async function getGroup(engine: Engine, id: string): Promise<GroupRecord | null> {
  // scope: operator-only the operator manages groups across every source
  const r = await engine.query<Record<string, unknown>>(`${GROUP_SELECT} WHERE g.id = $1`, [id]);
  return r.rows[0] ? toRecord(r.rows[0]) : null;
}

export async function listGroups(engine: Engine): Promise<GroupRecord[]> {
  // scope: operator-only the operator manages groups across every source
  const r = await engine.query<Record<string, unknown>>(`${GROUP_SELECT} ORDER BY g.id`);
  return r.rows.map(toRecord);
}

async function existingGroup(engine: Engine, raw: unknown): Promise<GroupRecord> {
  const id = assertMemberId(raw, "group");
  const group = await getGroup(engine, id);
  if (!group) throw new MemberError("not_found", `no group "${id}" (list them with: memrain group list)`);
  return group;
}

export async function addGroup(engine: Engine, rawId: unknown, opts: { displayName?: string }, who: MemberActor): Promise<GroupRecord> {
  const id = assertMemberId(rawId, "group");
  if (await getGroup(engine, id)) throw new MemberError("member_exists", `group "${id}" already exists`);
  await engine.transaction(async (tx) => {
    await tx.query(`INSERT INTO groups (id, display_name) VALUES ($1, $2)`, [id, opts.displayName ?? null]);
    await writeMemberAudit(tx, who, { groupId: id, action: "group_add" });
  });
  return (await getGroup(engine, id))!;
}

export async function removeGroup(engine: Engine, rawId: unknown, who: MemberActor): Promise<GroupRecord> {
  const group = await existingGroup(engine, rawId);
  await engine.transaction(async (tx) => {
    await tx.query(`DELETE FROM groups WHERE id = $1`, [group.id]);
    await writeMemberAudit(tx, who, {
      groupId: group.id,
      action: "group_remove",
      detail: { sources: group.sources, members: group.members },
    });
  });
  return group;
}

export async function grantGroupSource(
  engine: Engine,
  rawGroup: unknown,
  sourceId: string,
  opts: { allowOwnerSource?: boolean },
  who: MemberActor,
): Promise<GroupRecord> {
  const group = await existingGroup(engine, rawGroup);
  const src = await engine.query(`SELECT 1 FROM sources WHERE id = $1`, [sourceId]);
  if (src.rows.length === 0) throw new MemberError("not_found", `unknown source "${sourceId}" (list them with: memrain sources list)`);
  const ownerOverride = sourceId === OWNER_SOURCE_ID;
  if (ownerOverride && opts.allowOwnerSource !== true) {
    throw new MemberError(
      "owner_source",
      `"${OWNER_SOURCE_ID}" is the owner's own brain; adding it lets every member of "${group.id}" read it. ` +
        "Pass --allow-owner-source if that is what you mean",
    );
  }
  if (group.sources.includes(sourceId)) return group;
  await engine.transaction(async (tx) => {
    await tx.query(`INSERT INTO group_sources (group_id, source_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [group.id, sourceId]);
    await writeMemberAudit(tx, who, {
      groupId: group.id,
      action: "group_grant_source",
      detail: { source_id: sourceId, ...(ownerOverride ? { owner_source_override: true } : {}) },
    });
  });
  return (await getGroup(engine, group.id))!;
}

export async function revokeGroupSource(engine: Engine, rawGroup: unknown, sourceId: string, who: MemberActor): Promise<GroupRecord> {
  const group = await existingGroup(engine, rawGroup);
  if (!group.sources.includes(sourceId)) return group;
  await engine.transaction(async (tx) => {
    await tx.query(`DELETE FROM group_sources WHERE group_id = $1 AND source_id = $2`, [group.id, sourceId]);
    await writeMemberAudit(tx, who, { groupId: group.id, action: "group_revoke_source", detail: { source_id: sourceId } });
  });
  return (await getGroup(engine, group.id))!;
}

export async function addGroupMember(engine: Engine, rawGroup: unknown, rawMember: unknown, who: MemberActor): Promise<GroupRecord> {
  const group = await existingGroup(engine, rawGroup);
  const member = await existingMember(engine, rawMember);
  if (member.status === "removed") {
    throw new MemberError("member_retired", `member "${member.id}" was removed and cannot join a group`);
  }
  if (group.members.includes(member.id)) return group;
  await engine.transaction(async (tx) => {
    await tx.query(`INSERT INTO group_members (group_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [group.id, member.id]);
    await writeMemberAudit(tx, who, { groupId: group.id, memberId: member.id, action: "group_add_member" });
  });
  return (await getGroup(engine, group.id))!;
}

export async function removeGroupMember(engine: Engine, rawGroup: unknown, rawMember: unknown, who: MemberActor): Promise<GroupRecord> {
  const group = await existingGroup(engine, rawGroup);
  const memberId = assertMemberId(rawMember);
  if (!group.members.includes(memberId)) return group;
  await engine.transaction(async (tx) => {
    await tx.query(`DELETE FROM group_members WHERE group_id = $1 AND member_id = $2`, [group.id, memberId]);
    await writeMemberAudit(tx, who, { groupId: group.id, memberId, action: "group_remove_member" });
  });
  return (await getGroup(engine, group.id))!;
}
