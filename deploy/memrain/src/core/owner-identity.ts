/**
 * Who the brain's owner is as a person, worked out from what the brain already
 * stores, with nothing new for the operator to fill in. Read-only and resolved
 * on every call (no cache).
 *
 * Identifiers come from two places: the member's declared email, and the
 * account of each connector source that member owns. A connector source is the
 * owner's when it is the owner member's personal source, or, on a brain where
 * the owner is the only enabled member (or there are none), when no member
 * holds it as a personal source; a shared team mailbox is never anyone's "me".
 * An identifier two members claim counts for neither: two people are never
 * merged.
 *
 * The owner's entity is MEMRAIN_OWNER_ENTITY when it is set (the explicit
 * override, core/facts-owner.ts); otherwise the one live person page whose
 * frontmatter `email` or `emails` names an owner identifier, matched exactly
 * (never by name). Several matching pages are a conflict and name none.
 *
 * Trusted local callers only: identifiers are personal data and no MCP
 * operation reads this.
 */
import type { Engine } from "./engine/interface.ts";
import { ownerMemberId } from "./brain-owner.ts";
import { listMembers } from "./members.ts";
import { resolveOwnerEntity } from "./facts-owner.ts";

export type OwnerIdentifierKind = "member_email" | "connector_account";
export interface OwnerIdentifier { kind: OwnerIdentifierKind; value: string; source_id?: string }
export type OwnerEntityBasis = "configured" | "identifier_page";
export interface OwnerEntity { slug: string; source_id: string | null; basis: OwnerEntityBasis }
export type OwnerIdentityConflict =
  | { kind: "identifier_shared"; value: string; members: string[] }
  | { kind: "several_pages"; pages: Array<{ slug: string; source_id: string }> };
export interface SkippedSource { source_id: string; reason: "personal_source_of_other_member" | "unowned_on_shared_brain" }
export interface OwnerIdentity {
  /** The member this identity is for: the requested member, else the configured owner, else null (the local owner). */
  member: string | null;
  identifiers: OwnerIdentifier[];
  entity: OwnerEntity | null;
  conflicts: OwnerIdentityConflict[];
  skipped_sources: SkippedSource[];
}

const LOCAL_OWNER = "";
const CANDIDATE_CAP = 50;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return v.length <= 254 && /^[^\s@<>]+@[^\s@<>.]+(?:\.[^\s@<>.]+)+$/.test(v) ? v : null;
}

export async function ownerIdentity(engine: Engine, opts: { member?: string; env?: string | undefined } = {}): Promise<OwnerIdentity> {
  const member = opts.member ?? await ownerMemberId(engine);
  const key = member ?? LOCAL_OWNER;
  const people = (await listMembers(engine)).filter((m) => m.status === "enabled");
  const onlyOwner = people.every((m) => m.id === member);

  const claims = new Map<string, Set<string>>();
  const claim = (value: string, who: string) => {
    const set = claims.get(value) ?? new Set<string>();
    set.add(who);
    claims.set(value, set);
  };
  for (const m of people) {
    const e = normalizeEmail(m.email);
    if (e) claim(e, m.id);
  }

  const personalOf = new Map(people.filter((m) => m.personal_source_id).map((m) => [m.personal_source_id!, m.id]));
  const accounts = await engine.query<{ source_id: string; account: string }>(
    // scope: operator-only the local identity command reads connector account labels
    `SELECT ca.source_id, ca.account_label AS account
       FROM connector_accounts ca JOIN sources s ON s.id = ca.source_id
      WHERE ca.status <> 'revoked' AND s.archived IS NOT TRUE
      ORDER BY ca.source_id, ca.account_label`,
  );
  const skipped: SkippedSource[] = [];
  const accountOf = new Map<string, string[]>();
  for (const a of accounts.rows) {
    const account = normalizeEmail(a.account);
    if (!account) continue;
    const holder = personalOf.get(a.source_id);
    const owners = holder !== undefined ? [holder] : onlyOwner ? [key] : [];
    if (!owners.includes(key)) {
      skipped.push({ source_id: a.source_id, reason: holder !== undefined ? "personal_source_of_other_member" : "unowned_on_shared_brain" });
    }
    for (const who of owners) claim(account, who);
    if (owners.includes(key)) accountOf.set(account, [...(accountOf.get(account) ?? []), a.source_id]);
  }

  const conflicts: OwnerIdentityConflict[] = [];
  const own = (value: string) => {
    const who = claims.get(value);
    if (!who?.has(key)) return false;
    if (who.size > 1) {
      conflicts.push({ kind: "identifier_shared", value, members: [...who].map((w) => w || "local owner").sort() });
      return false;
    }
    return true;
  };
  const identifiers: OwnerIdentifier[] = [];
  const selfEmail = normalizeEmail(people.find((m) => m.id === member)?.email);
  if (selfEmail && own(selfEmail)) identifiers.push({ kind: "member_email", value: selfEmail });
  for (const [account, sources] of accountOf) {
    if (account === selfEmail || !own(account)) continue;
    for (const source_id of [...new Set(sources)]) identifiers.push({ kind: "connector_account", value: account, source_id });
  }

  const configured = resolveOwnerEntity(opts.env ?? process.env["MEMRAIN_OWNER_ENTITY"]);
  let entity: OwnerEntity | null = configured ? { slug: configured, source_id: null, basis: "configured" } : null;
  const emails = [...new Set(identifiers.map((i) => i.value))].sort();
  if (emails.length > 0) {
    const pages = await engine.query<{ slug: string; source_id: string }>(
      // scope: operator-only the local identity command matches person pages by exact email
      `SELECT p.slug, p.source_id FROM pages p
        WHERE p.deleted_at IS NULL AND lower(btrim(p.type)) = 'person'
          AND (lower(btrim(p.compiled_truth->>'email')) = ANY($1::text[])
               OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                            CASE WHEN jsonb_typeof(p.compiled_truth->'emails') = 'array' THEN p.compiled_truth->'emails' ELSE '[]'::jsonb END) e
                           WHERE lower(btrim(e)) = ANY($1::text[])))
        ORDER BY p.slug, p.source_id LIMIT ${CANDIDATE_CAP}`,
      [emails],
    );
    if (pages.rows.length > 1) conflicts.push({ kind: "several_pages", pages: pages.rows });
    else if (pages.rows.length === 1 && entity === null) entity = { ...pages.rows[0]!, basis: "identifier_page" };
  }
  return { member, identifiers, entity, conflicts, skipped_sources: skipped };
}

/**
 * Whether `sourceId` is one of the owner's own connector sources, by the rule
 * above: a connector account was ever connected to it, and it is the owner
 * member's personal source, or no enabled member holds it while the owner is
 * the only enabled member. With no owner member named (or none enabled) no
 * source counts as the owner's: nobody has been shown to own it.
 */
export async function isOwnerConnectorSource(engine: Engine, sourceId: string): Promise<boolean> {
  // scope: operator-only whether a source ever had a connector account, by its id
  const r = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM connector_accounts WHERE source_id = $1`, [sourceId]);
  if (!Number(r.rows[0]?.n ?? 0)) return false;
  const owner = await ownerMemberId(engine);
  if (owner === null) return false;
  const people = (await listMembers(engine)).filter((m) => m.status === "enabled");
  const holder = people.find((m) => m.personal_source_id === sourceId);
  if (holder) return holder.id === owner;
  return people.length > 0 && people.every((m) => m.id === owner);
}
