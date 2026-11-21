/**
 * `memrain identity [--member <id>] [--json]` — who memrain takes the brain's
 * owner to be and every signal behind it (core/owner-identity.ts). Trusted
 * local CLI only: it prints personal identifiers, so no MCP operation reads it.
 */
import { loadConfig } from "../core/config.ts";
import { Storage } from "../core/storage.ts";
import { listMembers } from "../core/members.ts";
import { ownerView } from "../core/brain-owner.ts";
import { ownerIdentity, type OwnerIdentity } from "../core/owner-identity.ts";
import { withStorage } from "./with-storage.ts";

const BASIS: Record<NonNullable<OwnerIdentity["entity"]>["basis"], string> = {
  configured: "set by MEMRAIN_OWNER_ENTITY",
  identifier_page: "the one person page whose email is an owner identifier",
};

export function renderIdentity(id: OwnerIdentity, inactive?: { value: string; reason: string }): string {
  const lines = [`Owner member: ${id.member ?? "none (the local operator; set one with: memrain member owner <id>)"}`];
  if (inactive) lines.push(`Owner setting: "${inactive.value}" names no enabled member (${inactive.reason}), so no credential reads as the owner.`);
  lines.push(id.entity
    ? `Owner page: ${id.entity.slug}${id.entity.source_id ? ` (source ${id.entity.source_id})` : ""}, ${BASIS[id.entity.basis]}`
    : "Owner page: none (no person page carries an owner identifier, and MEMRAIN_OWNER_ENTITY is unset)");
  lines.push(id.identifiers.length ? "Identifiers:" : "Identifiers: none yet");
  for (const i of id.identifiers) {
    lines.push(`  email ${i.value}  (${i.kind === "member_email" ? "member email" : `connector source ${i.source_id}`})`);
  }
  for (const c of id.conflicts) {
    lines.push(c.kind === "identifier_shared"
      ? `Conflict: ${c.value} is claimed by ${c.members.join(" and ")}, so it counts for neither.`
      : `Conflict: ${c.pages.length} person pages carry an owner email (${c.pages.map((p) => p.slug).join(", ")}), so none is used; keep the email on one page.`);
  }
  for (const s of id.skipped_sources) {
    lines.push(`Not counted: connector source ${s.source_id} (${s.reason === "personal_source_of_other_member"
      ? "it is another member's personal source"
      : "it is nobody's personal source on a brain with several members; set it with memrain member add --personal-source"}).`);
  }
  return lines.join("\n");
}

export async function runIdentity(opts: { member?: string; json?: boolean; configPath?: string }): Promise<number> {
  const storage = new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const engine = storage.engine();
    if (opts.member !== undefined && !(await listMembers(engine, { includeRemoved: true })).some((m) => m.id === opts.member)) {
      console.error(`memrain identity: no member has the id ${opts.member} (memrain member list names them)`);
      return 1;
    }
    const id = await ownerIdentity(engine, opts.member !== undefined ? { member: opts.member } : {});
    const view = opts.member === undefined ? await ownerView(engine) : undefined;
    console.log(opts.json ? JSON.stringify({ ...id, ...(view?.inactive ? { owner_inactive: view.inactive } : {}) }, null, 2) : renderIdentity(id, view?.inactive));
    return 0;
  });
}
