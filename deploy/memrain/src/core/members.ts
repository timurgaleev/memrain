/**
 * Members: the people of a team brain.
 *
 * A member is a named person (`alice`). Personal access tokens, OAuth clients
 * and enrollment grants may be bound to one member. The token verifier asks
 * `memberAccess` for every credential that names a member, so one disabled or
 * removed member stops all of that person's keys in one place, on /mcp and
 * /ingest alike, while everyone else keeps working. A brain with no members
 * never reaches that query: unbound credentials verify exactly as before.
 *
 *   enabled ──disable──► disabled ──enable──► enabled
 *      │                    │
 *      └──────remove────────┴──► removed   (tombstone: email cleared, the id is
 *                                          never reused, never enabled again)
 *
 * A credential bound to a removed member stays bound: unbinding or rebinding
 * it would turn a key the operator meant to kill back into a working one, so
 * both are refused and the credential has to be revoked instead.
 *
 * Every change writes one member_audit row. The email is personal data: the
 * audit records that one was set, never the address.
 */
import { effectiveReadSourceIds } from "./auth-info.ts";
import type { Engine } from "./engine/interface.ts";
import { assertMemberRoom } from "./tenant-guard.ts";

export const MEMBER_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export type MemberStatus = "enabled" | "disabled" | "removed";

export interface MemberRecord {
  id: string;
  display_name: string | null;
  email: string | null;
  status: MemberStatus;
  personal_source_id: string | null;
  groups: string[];
  created_at: string | null;
  removed_at: string | null;
}

/** Who changed a member or a group, recorded as data only; it authorizes nothing. */
export interface MemberActor {
  actor: string;
  /** `app`: the member acting on its own credentials from /app. */
  via: "cli" | "admin_api" | "app";
}

export type MemberErrorCode =
  | "member_invalid"
  | "member_exists"
  | "member_retired"
  | "member_not_enabled"
  | "email_taken"
  | "credential_mixed"
  | "not_found"
  | "owner_source"
  | "source_shared";

/** A refused member or group change; `code` maps to an HTTP status in the admin routes. */
export class MemberError extends Error {
  constructor(readonly code: MemberErrorCode, message: string) {
    super(message);
    this.name = "MemberError";
  }
}

export type CredentialKind = "token" | "client" | "enrollment";

export interface CredentialRef {
  kind: CredentialKind;
  /** A token's name, a client's client_id, an enrollment's id. */
  id: string;
}

/** A member or group id, validated. */
export function assertMemberId(raw: unknown, what: "member" | "group" = "member"): string {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (MEMBER_ID_RE.test(id)) return id;
  throw new MemberError(
    "member_invalid",
    `"${String(raw ?? "")}" is not a valid ${what} id: use 2-63 lower-case letters, digits or '-', starting with a letter or digit`,
  );
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;

function assertEmail(raw: unknown): string {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const printable = [...email].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7F);
  if (email.length <= 254 && EMAIL_RE.test(email) && printable) return email;
  throw new MemberError("member_invalid", "not a valid email address (one @, no spaces, at most 254 characters)");
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function toRecord(row: Record<string, unknown>): MemberRecord {
  return {
    id: String(row.id),
    display_name: (row.display_name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    status: row.status as MemberStatus,
    personal_source_id: (row.personal_source_id as string | null) ?? null,
    groups: Array.isArray(row.groups) ? (row.groups as string[]) : [],
    created_at: iso(row.created_at),
    removed_at: iso(row.removed_at),
  };
}

const MEMBER_SELECT = `SELECT m.id, m.display_name, m.email, m.status, m.personal_source_id, m.created_at, m.removed_at,
  COALESCE((SELECT array_agg(gm.group_id ORDER BY gm.group_id) FROM group_members gm WHERE gm.member_id = m.id), '{}') AS groups
  FROM members m`;

export async function getMember(engine: Engine, id: string): Promise<MemberRecord | null> {
  const r = await engine.query<Record<string, unknown>>(`${MEMBER_SELECT} WHERE m.id = $1`, [id]);
  return r.rows[0] ? toRecord(r.rows[0]) : null;
}

export async function listMembers(engine: Engine, opts: { includeRemoved?: boolean } = {}): Promise<MemberRecord[]> {
  const r = await engine.query<Record<string, unknown>>(
    `${MEMBER_SELECT}${opts.includeRemoved ? "" : " WHERE m.status <> 'removed'"} ORDER BY m.id`,
  );
  return r.rows.map(toRecord);
}

export async function existingMember(engine: Engine, raw: unknown): Promise<MemberRecord> {
  const id = assertMemberId(raw);
  const member = await getMember(engine, id);
  if (!member) throw new MemberError("not_found", `no member "${id}" (list them with: memrain member list)`);
  return member;
}

export async function writeMemberAudit(
  engine: Engine,
  who: MemberActor,
  entry: { memberId?: string; groupId?: string; action: string; detail?: Record<string, unknown> },
): Promise<void> {
  await engine.query(
    `INSERT INTO member_audit (member_id, group_id, action, actor, via, detail) VALUES ($1, $2, $3, $4, $5, $6::text::jsonb)`,
    [entry.memberId ?? null, entry.groupId ?? null, entry.action, who.actor, who.via, JSON.stringify(entry.detail ?? {})],
  );
}

async function assertEmailFree(engine: Engine, email: string, memberId: string): Promise<void> {
  const r = await engine.query<{ id: string }>(
    `SELECT id FROM members WHERE lower(email) = $1 AND status <> 'removed' AND id <> $2`,
    [email, memberId],
  );
  if (r.rows[0]) throw new MemberError("email_taken", `member "${r.rows[0].id}" already declares that email`);
}

export async function addMember(
  engine: Engine,
  rawId: unknown,
  opts: { displayName?: string; email?: string; personalSource?: string },
  who: MemberActor,
): Promise<MemberRecord> {
  const id = assertMemberId(rawId);
  const email = opts.email === undefined ? null : assertEmail(opts.email);
  const existing = await getMember(engine, id);
  if (existing?.status === "removed") {
    throw new MemberError("member_retired", `member id "${id}" was removed and can never be reused; choose a new id`);
  }
  if (existing) throw new MemberError("member_exists", `member "${id}" already exists (${existing.status})`);
  if (email !== null) await assertEmailFree(engine, email, id);
  if (opts.personalSource !== undefined) {
    const src = await engine.query(`SELECT 1 FROM sources WHERE id = $1`, [opts.personalSource]);
    if (src.rows.length === 0) throw new MemberError("not_found", `unknown source "${opts.personalSource}"`);
  }
  await assertMemberRoom(engine);
  await engine.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO members (id, display_name, email, personal_source_id) VALUES ($1, $2, $3, $4)`,
      [id, opts.displayName ?? null, email, opts.personalSource ?? null],
    );
    await writeMemberAudit(tx, who, {
      memberId: id,
      action: "add",
      detail: { email_set: email !== null, personal_source_id: opts.personalSource ?? null },
    });
  });
  return (await getMember(engine, id))!;
}

async function setStatus(engine: Engine, rawId: unknown, status: "enabled" | "disabled", who: MemberActor): Promise<MemberRecord> {
  const member = await existingMember(engine, rawId);
  if (member.status === "removed") {
    throw new MemberError("member_retired", `member "${member.id}" was removed; add a new member id instead`);
  }
  if (member.status === status) return member;
  await engine.transaction(async (tx) => {
    await tx.query(`UPDATE members SET status = $2, updated_at = now() WHERE id = $1 AND status <> 'removed'`, [member.id, status]);
    await writeMemberAudit(tx, who, { memberId: member.id, action: status === "disabled" ? "disable" : "enable" });
  });
  return (await getMember(engine, member.id))!;
}

export const disableMember = (engine: Engine, id: unknown, who: MemberActor) => setStatus(engine, id, "disabled", who);
export const enableMember = (engine: Engine, id: unknown, who: MemberActor) => setStatus(engine, id, "enabled", who);

/** Live credentials bound to `memberId`: tokens by name, clients and enrollments by id. */
export async function boundCredentials(engine: Engine, memberId: string): Promise<CredentialRef[]> {
  const r = await engine.query<{ kind: CredentialKind; id: string }>(
    // scope: operator-only lists the credentials of one member for the operator
    `SELECT DISTINCT 'token' AS kind, name AS id FROM access_tokens WHERE member_id = $1 AND revoked_at IS NULL
     UNION ALL
     SELECT 'client' AS kind, client_id AS id FROM oauth_clients WHERE member_id = $1 AND deleted_at IS NULL
     UNION ALL
     SELECT 'enrollment' AS kind, id FROM oauth_enrollments WHERE member_id = $1 AND revoked_at IS NULL
     ORDER BY 1, 2`,
    [memberId],
  );
  return r.rows.map((x) => ({ kind: x.kind, id: x.id }));
}

export interface MemberRemoval {
  member: MemberRecord;
  /** Credentials that stay bound to the tombstone and are refused from now on. */
  bound_credentials: CredentialRef[];
}

export async function removeMember(engine: Engine, rawId: unknown, who: MemberActor): Promise<MemberRemoval> {
  const member = await existingMember(engine, rawId);
  const bound = await boundCredentials(engine, member.id);
  if (member.status === "removed") return { member, bound_credentials: bound };
  await engine.transaction(async (tx) => {
    await tx.query(
      `UPDATE members SET status = 'removed', removed_at = now(), email = NULL, updated_at = now() WHERE id = $1`,
      [member.id],
    );
    await tx.query(`DELETE FROM group_members WHERE member_id = $1`, [member.id]);
    await writeMemberAudit(tx, who, {
      memberId: member.id,
      action: "remove",
      detail: { groups: member.groups, bound_credentials: bound },
    });
  });
  return { member: (await getMember(engine, member.id))!, bound_credentials: bound };
}

const CREDENTIAL_TABLE: Record<CredentialKind, { table: string; key: string; live: string }> = {
  token: { table: "access_tokens", key: "name", live: "revoked_at IS NULL" },
  client: { table: "oauth_clients", key: "client_id", live: "deleted_at IS NULL" },
  enrollment: { table: "oauth_enrollments", key: "id", live: "revoked_at IS NULL" },
};

export interface BindResult {
  kind: CredentialKind;
  id: string;
  member_id: string | null;
  previous_member_id: string | null;
  /** Live rows changed: a token name may cover several. */
  rows: number;
}

/**
 * Bind one credential to `memberId`, or unbind it with null. The member must
 * be enabled. A credential already bound to a removed member is never moved:
 * that would revive a key its removal was meant to kill. `expectedMember`
 * makes the change apply only while the credential is still bound to that
 * member, checked under the row lock, so a stale caller cannot undo a rebind.
 */
export async function bindCredential(
  engine: Engine,
  memberId: string | null,
  target: CredentialRef,
  who: MemberActor,
  opts: { expectedMember?: string } = {},
): Promise<BindResult> {
  const spec = CREDENTIAL_TABLE[target.kind];
  if (!spec) throw new MemberError("member_invalid", `unknown credential kind "${String(target.kind)}"`);
  if (memberId !== null) {
    const member = await existingMember(engine, memberId);
    if (member.status !== "enabled") {
      throw new MemberError("member_not_enabled", `member "${member.id}" is ${member.status}; only an enabled member can be bound`);
    }
  }
  return engine.transaction(async (tx) => {
    const locked = await tx.query<{ member_id: string | null; status: MemberStatus | null }>(
      // scope: operator-only binds a credential the operator names
      `SELECT c.member_id, m.status FROM ${spec.table} c LEFT JOIN members m ON m.id = c.member_id
        WHERE c.${spec.key} = $1 AND c.${spec.live} FOR UPDATE OF c`,
      [target.id],
    );
    if (locked.rows.length === 0) throw new MemberError("not_found", `no live ${target.kind} "${target.id}"`);
    // Each member's audit names the one previous holder; live rows of one
    // token name held by two people would leave the second history silent.
    if (new Set(locked.rows.map((r) => r.member_id).filter((m) => m !== null)).size > 1) {
      throw new MemberError(
        "credential_mixed",
        `the live rows of ${target.kind} "${target.id}" are bound to different members; revoke the extra ones first`,
      );
    }
    const previous = locked.rows.find((r) => r.member_id !== null)?.member_id ?? null;
    if (opts.expectedMember !== undefined && locked.rows.some((r) => r.member_id !== opts.expectedMember)) {
      throw new MemberError("not_found", `${target.kind} "${target.id}" is not bound to member "${opts.expectedMember}"`);
    }
    if (locked.rows.some((r) => r.status === "removed") && memberId !== previous) {
      throw new MemberError(
        "member_retired",
        `${target.kind} "${target.id}" belongs to a removed member; revoke it instead of moving it`,
      );
    }
    const changed = await tx.query<{ n: number }>(
      // scope: operator-only binds a credential the operator names
      `WITH u AS (UPDATE ${spec.table} SET member_id = $2 WHERE ${spec.key} = $1 AND ${spec.live} RETURNING 1)
       SELECT count(*)::int AS n FROM u`,
      [target.id, memberId],
    );
    const auditMember = memberId ?? previous;
    if (auditMember !== null && memberId !== previous) {
      await writeMemberAudit(tx, who, {
        memberId: auditMember,
        action: memberId === null ? "unbind" : "bind",
        detail: { credential: { kind: target.kind, id: target.id }, previous_member_id: previous },
      });
      if (memberId !== null && previous !== null) {
        await writeMemberAudit(tx, who, {
          memberId: previous,
          action: "unbind",
          detail: { credential: { kind: target.kind, id: target.id }, next_member_id: memberId },
        });
      }
    }
    return {
      kind: target.kind,
      id: target.id,
      member_id: memberId,
      previous_member_id: previous,
      rows: Number(changed.rows[0]?.n ?? 0),
    };
  });
}

export interface MemberAuditRow {
  id: number;
  member_id: string | null;
  group_id: string | null;
  action: string;
  actor: string;
  via: string;
  detail: Record<string, unknown>;
  created_at: string | null;
}

export async function listMemberAudit(
  engine: Engine,
  opts: { memberId?: string; groupId?: string; limit?: number } = {},
): Promise<MemberAuditRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.memberId !== undefined) {
    params.push(opts.memberId);
    where.push(`member_id = $${params.length}`);
  }
  if (opts.groupId !== undefined) {
    params.push(opts.groupId);
    where.push(`group_id = $${params.length}`);
  }
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 1000));
  const r = await engine.query<Record<string, unknown>>(
    `SELECT id, member_id, group_id, action, actor, via, detail, created_at FROM member_audit
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    member_id: (row.member_id as string | null) ?? null,
    group_id: (row.group_id as string | null) ?? null,
    action: String(row.action),
    actor: String(row.actor),
    via: String(row.via),
    detail: (typeof row.detail === "string" ? JSON.parse(row.detail) : row.detail ?? {}) as Record<string, unknown>,
    created_at: iso(row.created_at),
  }));
}

export interface MemberAccess {
  /** The member whose groups widen the credential's reads. */
  memberId: string;
  /** Set when any member the credential names may not use it. */
  refused: { memberId: string; reason: "disabled" | "removed" | "missing" | "malformed" } | null;
  /** Sources the effective member's groups read. */
  groupSources: string[];
}

/**
 * The verify join. `bound` lists the member ids a credential names, most
 * specific first (an enrollment's member, then its client's); null entries
 * are unbound. Returns null when nothing is bound, without a query, so a
 * brain with no members verifies exactly as before. Any named member that is
 * not enabled refuses the credential; the first one names the groups.
 */
export async function memberAccess(engine: Pick<Engine, "query">, bound: readonly unknown[]): Promise<MemberAccess | null> {
  const named = bound.filter((id) => id !== null && id !== undefined);
  if (named.length === 0) return null;
  const effective = String(named[0]);
  const malformed = named.find((id) => typeof id !== "string" || !MEMBER_ID_RE.test(id));
  if (malformed !== undefined) {
    return { memberId: effective, refused: { memberId: String(malformed), reason: "malformed" }, groupSources: [] };
  }
  const ids = [...new Set(named as string[])];
  const r = await engine.query<{ id: string; status: MemberStatus; group_sources: string[] | null }>(
    // scope: upstream the verifier resolves the grant of the credential being verified
    `SELECT m.id, m.status,
            COALESCE((SELECT array_agg(DISTINCT gs.source_id) FROM group_members gm
                        JOIN group_sources gs ON gs.group_id = gm.group_id
                       WHERE gm.member_id = m.id), '{}') AS group_sources
       FROM members m WHERE m.id = ANY($1::text[])`,
    [ids],
  );
  const byId = new Map(r.rows.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) return { memberId: effective, refused: { memberId: id, reason: "missing" }, groupSources: [] };
    if (row.status !== "enabled") return { memberId: effective, refused: { memberId: id, reason: row.status }, groupSources: [] };
  }
  const sources = byId.get(effective)?.group_sources;
  return { memberId: effective, refused: null, groupSources: Array.isArray(sources) ? [...sources].sort() : [] };
}

/**
 * A grant's read set widened by its member's group sources. Only a grant
 * already scoped to sources is widened; an unscoped grant reads everything
 * already and is returned unchanged, never narrowed. Writes are untouched.
 */
export function widenReadSources<G extends { sourceId?: string; allowedSources?: string[] }>(grant: G, extra: readonly string[]): G {
  if (extra.length === 0) return grant;
  const base = effectiveReadSourceIds(grant);
  if (base === undefined) return grant;
  return { ...grant, allowedSources: [...new Set([...base, ...extra])] };
}
