/**
 * `memrain member …` and `memrain group …` — the people of a team brain and
 * the shared sources their groups read (core/members.ts, core/groups.ts).
 *
 *   member list [--all]
 *   member show <id>
 *   member add <id> [--name N] [--email E] [--personal-source SRC]
 *   member disable|enable|remove <id>
 *   member remove <id> --erase-personal-source [--apply --out DIR]
 *   member invite <id> [--ttl 72h]
 *   member bind <id> --token NAME | --client CLIENT_ID | --enrollment ID
 *   member unbind --token NAME | --client CLIENT_ID | --enrollment ID
 *
 *   group list
 *   group show <id>
 *   group add <id> [--name N]
 *   group remove <id>
 *   group grant-source <id> <source> [--allow-owner-source]
 *   group revoke-source <id> <source>
 *   group add-member <id> <member>
 *   group remove-member <id> <member>
 *
 * Local CLI only; every change is audited with the operator as actor
 * (MEMRAIN_OPERATOR, else $USER). Output is one JSON object.
 */
import { loadConfig } from "../core/config.ts";
import { Storage } from "../core/storage.ts";
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
  type CredentialRef,
  type MemberActor,
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
import { INVITE_DEFAULT_TTL_MS, MemberInviteError, memberInviteUrl, mintMemberInvite } from "../core/member-invites.ts";
import { ErasureUsageError, eraseMemberPersonalSource } from "../core/member-offboarding.ts";
import { cliActor } from "./auth.ts";
import { withStorage } from "./with-storage.ts";
import type { Engine } from "../core/engine/interface.ts";
import { OperationError } from "../core/operation-error.ts";

export const MEMBER_SUBCOMMANDS = ["list", "show", "add", "disable", "enable", "remove", "bind", "unbind", "invite"] as const;
export const GROUP_SUBCOMMANDS = [
  "list", "show", "add", "remove", "grant-source", "revoke-source", "add-member", "remove-member",
] as const;

export interface MemberCmdOptions {
  sub: string;
  args: string[];
  all?: boolean;
  name?: string;
  email?: string;
  personalSource?: string;
  token?: string;
  client?: string;
  enrollment?: string;
  allowOwnerSource?: boolean;
  /** `invite --ttl`: 90m, 72h, 7d. */
  ttl?: string;
  /** `remove --erase-personal-source`: offboard the member's own source too. */
  erasePersonalSource?: boolean;
  apply?: boolean;
  out?: string;
  configPath?: string;
}

/** `90m`, `72h` or `7d` in milliseconds. */
export function parseTtl(raw: string): number {
  const m = /^(\d{1,5})([mhd])$/.exec(raw.trim());
  if (!m) throw new UsageError(`--ttl takes a number and a unit: 90m, 72h or 7d (got "${raw}")`);
  return Number(m[1]) * { m: 60_000, h: 3600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
}

const MEMBER_USAGE = "Usage: memrain member <list|show|add|disable|enable|remove|bind|unbind|invite> … (see memrain help)";
const GROUP_USAGE = "Usage: memrain group <list|show|add|remove|grant-source|revoke-source|add-member|remove-member> … (see memrain help)";

class UsageError extends Error {}

function need(value: string | undefined, usage: string): string {
  if (!value) throw new UsageError(usage);
  return value;
}

function credentialFrom(opts: MemberCmdOptions): CredentialRef {
  const given = (
    [["token", opts.token], ["client", opts.client], ["enrollment", opts.enrollment]] as const
  ).filter(([, v]) => v !== undefined && v !== "");
  if (given.length !== 1) throw new UsageError("name exactly one credential: --token NAME, --client CLIENT_ID or --enrollment ID");
  const [kind, id] = given[0]!;
  return { kind, id: id! };
}

async function memberCommand(storage: Storage, opts: MemberCmdOptions, who: MemberActor): Promise<unknown> {
  const engine = storage.engine();
  const [id] = opts.args;
  switch (opts.sub) {
    case "invite": {
      const member = await existingMember(engine, need(id, "Usage: memrain member invite <id> [--ttl 72h]"));
      // Checked before minting: a new invite revokes the member's last one.
      const publicUrl = process.env.MEMRAIN_PUBLIC_URL?.trim();
      if (!publicUrl) throw new UsageError("set MEMRAIN_PUBLIC_URL: the invite link is built from the brain's public address");
      const invite = await mintMemberInvite(engine, member.id, opts.ttl !== undefined ? parseTtl(opts.ttl) : INVITE_DEFAULT_TTL_MS, { createdBy: who.actor });
      return {
        member_id: member.id,
        url: memberInviteUrl(publicUrl, invite.token),
        expires_at: invite.expiresAt.toISOString(),
        note: "Send the link to the member only; it works once and is not shown again.",
      };
    }
    case "list":
      return { members: await listMembers(engine, { includeRemoved: opts.all === true }) };
    case "show": {
      const member = await existingMember(engine, need(id, "Usage: memrain member show <id>"));
      return {
        member,
        credentials: await boundCredentials(engine, member.id),
        audit: await listMemberAudit(engine, { memberId: member.id, limit: 20 }),
      };
    }
    case "add":
      return {
        member: await addMember(engine, need(id, "Usage: memrain member add <id> [--name N] [--email E] [--personal-source SRC]"), {
          ...(opts.name !== undefined ? { displayName: opts.name } : {}),
          ...(opts.email !== undefined ? { email: opts.email } : {}),
          ...(opts.personalSource !== undefined ? { personalSource: opts.personalSource } : {}),
        }, who),
      };
    case "disable":
      return {
        member: await disableMember(engine, need(id, "Usage: memrain member disable <id>"), who),
        note: "Every key bound to this member is refused from its next request on.",
      };
    case "enable":
      return { member: await enableMember(engine, need(id, "Usage: memrain member enable <id>"), who) };
    case "remove":
      if (opts.erasePersonalSource) {
        return eraseMemberPersonalSource(storage, need(id, "Usage: memrain member remove <id> --erase-personal-source [--apply --out DIR]"), {
          apply: opts.apply === true,
          ...(opts.out !== undefined ? { outDir: opts.out } : {}),
          actor: who,
        });
      }
      return {
        ...(await removeMember(engine, need(id, "Usage: memrain member remove <id>"), who)),
        note: "Removal is permanent: the id is never reused and its keys stay refused. Revoke them to tidy up.",
      };
    case "bind":
      return { binding: await bindCredential(engine, need(id, "Usage: memrain member bind <id> --token NAME|--client ID|--enrollment ID"), credentialFrom(opts), who) };
    case "unbind":
      return { binding: await bindCredential(engine, null, credentialFrom(opts), who) };
    default:
      throw new UsageError(MEMBER_USAGE);
  }
}

async function groupCommand(engine: Engine, opts: MemberCmdOptions, who: MemberActor): Promise<unknown> {
  const [id, target] = opts.args;
  switch (opts.sub) {
    case "list":
      return { groups: await listGroups(engine) };
    case "show": {
      const groupId = need(id, "Usage: memrain group show <id>");
      const group = await getGroup(engine, groupId);
      if (!group) throw new MemberError("not_found", `no group "${groupId}" (list them with: memrain group list)`);
      return { group, audit: await listMemberAudit(engine, { groupId: group.id, limit: 20 }) };
    }
    case "add":
      return { group: await addGroup(engine, need(id, "Usage: memrain group add <id> [--name N]"), opts.name !== undefined ? { displayName: opts.name } : {}, who) };
    case "remove":
      return { removed: await removeGroup(engine, need(id, "Usage: memrain group remove <id>"), who) };
    case "grant-source":
      return {
        group: await grantGroupSource(
          engine,
          need(id, "Usage: memrain group grant-source <id> <source> [--allow-owner-source]"),
          need(target, "Usage: memrain group grant-source <id> <source> [--allow-owner-source]"),
          { allowOwnerSource: opts.allowOwnerSource === true },
          who,
        ),
        note: "Members of the group read this source from their next request on.",
      };
    case "revoke-source":
      return { group: await revokeGroupSource(engine, need(id, "Usage: memrain group revoke-source <id> <source>"), need(target, "Usage: memrain group revoke-source <id> <source>"), who) };
    case "add-member":
      return { group: await addGroupMember(engine, need(id, "Usage: memrain group add-member <id> <member>"), need(target, "Usage: memrain group add-member <id> <member>"), who) };
    case "remove-member":
      return { group: await removeGroupMember(engine, need(id, "Usage: memrain group remove-member <id> <member>"), need(target, "Usage: memrain group remove-member <id> <member>"), who) };
    default:
      throw new UsageError(GROUP_USAGE);
  }
}

async function run(kind: "member" | "group", opts: MemberCmdOptions): Promise<number> {
  const storage = new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const who: MemberActor = { actor: cliActor(), via: "cli" };
    try {
      const out = kind === "member"
        ? await memberCommand(storage, opts, who)
        : await groupCommand(storage.engine(), opts, who);
      console.log(JSON.stringify(out, null, 2));
      return 0;
    } catch (e) {
      if (e instanceof MemberError || e instanceof UsageError || e instanceof MemberInviteError || e instanceof ErasureUsageError || e instanceof OperationError) {
        console.error(`memrain ${kind}: ${e.message}`);
        return 1;
      }
      throw e;
    }
  });
}

export const runMember = (opts: MemberCmdOptions) => run("member", opts);
export const runGroup = (opts: MemberCmdOptions) => run("group", opts);
