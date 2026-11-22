/**
 * Doctor checks for who reads the brain: the owner, unbound credentials on a
 * brain that serves several people, and personal sources left open there.
 * Each turns its own probe failure into a `warn`, and none prints a personal
 * identifier: an email or account never reaches a check's detail.
 */
import { couldNotCheck } from "./doctor-categories.ts";
import type { Engine } from "./engine/interface.ts";
import type { TenancyCheck } from "./doctor-tenancy.ts";
import { ownerView } from "./brain-owner.ts";
import { ownerIdentity } from "./owner-identity.ts";
import { readBrainAccess } from "./caller-access.ts";
import { unscopedConnections } from "./requester-scope.ts";
import { provenanceBackfilled } from "./owner-only.ts";

/** Warns when ownership is ambiguous: an inactive owner setting, a shared brain with no owner, or conflicting identifiers. */
export async function checkOwnerIdentity(engine: Engine, env: string | undefined = process.env["MEMRAIN_OWNER_ENTITY"]): Promise<TenancyCheck> {
  const name = "owner-identity";
  try {
    const view = await ownerView(engine);
    const { serves } = await readBrainAccess(engine);
    const id = await ownerIdentity(engine, { env });
    const problems: string[] = [];
    if (view.inactive) problems.push(`the owner setting names member "${view.inactive.value}", which is not an enabled member, so no credential reads as the owner (memrain member owner <id>)`);
    if (serves.several && view.owner === null && !view.inactive) problems.push("the brain serves several people and names no owner member, so nobody's credential reads private facts (memrain member owner <id>)");
    const shared = id.conflicts.filter((c) => c.kind === "identifier_shared").length;
    const pages = id.conflicts.find((c) => c.kind === "several_pages");
    if (shared > 0) problems.push(`${shared} owner identifier(s) are claimed by more than one member and count for neither`);
    if (pages && pages.kind === "several_pages") problems.push(`${pages.pages.length} person pages carry an owner email, so none is taken as the owner's page`);
    if ((env ?? "").trim() !== "" && id.entity?.basis !== "configured") problems.push("MEMRAIN_OWNER_ENTITY is set but is not a usable entity slug, so first-person claims stay unattributed");
    if (problems.length > 0) {
      return { name, ok: true, status: "warn", detail: `${problems.join("; ")}. Run memrain identity to see every signal.` };
    }
    const owner = view.owner ? `owner member ${view.owner}` : "no owner member (the local operator)";
    const page = id.entity ? `owner page ${id.entity.slug} (${id.entity.basis})` : "no owner page";
    return { name, ok: true, status: "ok", detail: `${owner}; ${page}; ${id.identifiers.length} identifier(s)` };
  } catch (e) {
    return couldNotCheck(name, e);
  }
}

/** Warns per live credential bound to nobody on a brain that serves several people: its reads are refused. */
export async function checkUnscopedSharedReads(engine: Engine): Promise<TenancyCheck> {
  const name = "unscoped-shared-reads";
  try {
    const found = await unscopedConnections(engine);
    if (found === null) return { name, ok: true, status: "ok", detail: "the brain serves one person; unbound credentials read as before" };
    if (found.connections.length === 0) return { name, ok: true, status: "ok", detail: "the brain serves several people and every live credential names a member or a source" };
    const list = found.connections.slice(0, 10).map((c) => `${c.kind} ${c.name} (fix: ${c.fix})`).join("; ");
    const more = found.connections.length > 10 ? `; and ${found.connections.length - 10} more` : "";
    return {
      name, ok: true, status: "warn",
      detail: `the brain serves several people and ${found.connections.length} live credential(s) are bound to nobody, so their reads are refused (requester_scope_required): ${list}${more}`,
    };
  } catch (e) {
    return couldNotCheck(name, e);
  }
}

/** Warns when a mailbox, calendar or transcript source is not owner-only, or owner-only sources have no owner to read them. */
export async function checkOwnerOnlySources(engine: Engine): Promise<TenancyCheck> {
  const name = "owner-only-sources";
  try {
    const { serves, ownerOnlySources, ownerMember } = await readBrainAccess(engine);
    const open = await engine.query<{ id: string }>(
      // scope: operator-only doctor lists personal source kinds
      `SELECT id FROM sources WHERE NOT owner_only AND archived IS NOT TRUE AND kind IN ('mailbox', 'calendar', 'transcript') ORDER BY id`,
    );
    const marked = `${ownerOnlySources.length} owner-only source(s)`;
    if (ownerOnlySources.length > 0 && !(await provenanceBackfilled(engine))) {
      return {
        name, ok: true, status: "warn",
        detail: `${marked}, but the origins of rows derived before this release were never recorded, so those rows stay readable to remote keys. ` +
          "Run memrain sources provenance (dry run), then memrain sources provenance --apply.",
      };
    }
    if (ownerOnlySources.length > 0 && ownerMember === null) {
      return {
        name, ok: true, status: "warn",
        detail: `${marked}, and no owner member is set, so no remote key reads them, only the local operator. ` +
          "Name the owner with memrain member owner <id> and bind the owner's keys to that member.",
      };
    }
    if (open.rows.length === 0) return { name, ok: true, status: "ok", detail: ownerOnlySources.length > 0 ? `${marked}; closed to every remote key but the owner's` : marked };
    const readers = serves.several ? "every member and key they are granted to" : "every remote key they are granted to, the owner's or not";
    return {
      name, ok: true, status: "warn",
      detail: `${open.rows.length} personal source(s) are not owner-only, so ${readers} reads them: ${open.rows.map((r) => r.id).join(", ")}. ` +
        "Mark the owner's own with memrain sources owner-only <id> on, then run memrain sources provenance (dry run) and --apply.",
    };
  } catch (e) {
    return couldNotCheck(name, e);
  }
}
