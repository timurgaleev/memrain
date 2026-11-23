/**
 * Requester scope: on a brain that serves several people (core/caller-access.ts),
 * a remote read must say whose reads it makes. A credential does when it is
 * bound to a member (the owner included) or scoped to a source. Every other
 * remote read — an unbound token or client, the static public bearer — is
 * refused with requester_scope_required before any work. There is no grace
 * period: a credential is refused from the moment the brain serves several.
 *
 * Deny by default: every operation is covered except writes (scope `write`,
 * except `think`, which reads) and the short list below, which reads no page.
 * tests/requester_scope.test.ts fails when a new operation is neither covered
 * nor listed. The trusted operator path never reaches the gate, and
 * MEMRAIN_REQUIRE_MEMBER (core/members.ts) stays the stricter switch: it
 * refuses an unbound credential at verification, on every brain.
 */
import type { Engine } from "./engine/interface.ts";
import { effectiveReadSourceIds, type AuthInfo } from "./auth-info.ts";
import { OperationError } from "./operation-error.ts";
import { readBrainAccess, type BrainAccess, type ServesPolicy } from "./caller-access.ts";

/** Operations that read no page: the caller's own identity and the brain's identity. */
export const REQUESTER_SCOPE_EXEMPT: ReadonlySet<string> = new Set(["whoami", "get_brain_identity"]);

/** Write-scoped operations that still read the brain (a dry run returns the row), so they stay covered. */
export const READING_WRITES: ReadonlySet<string> = new Set(["think", "takes_update", "takes_resolve"]);

export function requiresRequesterScope(op: { name: string; scope?: string } | undefined, name: string): boolean {
  if (REQUESTER_SCOPE_EXEMPT.has(name)) return false;
  if (op?.scope === "write" && !READING_WRITES.has(name)) return false;
  return true;
}

/**
 * The source every OAuth client is registered with unless the operator picks
 * another (dynamic registration, `auth register-client`): a grant of it alone
 * says nothing about whose reads the client makes.
 */
const REGISTRATION_DEFAULT_SOURCE = "default";

/** An OAuth session of a client in client tenant mode (an enrollment spends as its own id). */
function oauthClientMode(auth: AuthInfo): boolean {
  const kind = auth.principal?.kind;
  return (kind === "oauth_family" || kind === "oauth_token") && (auth.spendId === undefined || auth.spendId === auth.clientId);
}

/**
 * The caller names whose reads it makes: a bound member, or a source grant.
 * An OAuth client in client tenant mode whose grant is only the registration
 * default names nobody, so it must be bound to a member.
 */
export function callerIsScoped(auth: AuthInfo | undefined): boolean {
  if (auth === undefined) return false;
  if (typeof auth.memberId === "string" && auth.memberId.length > 0) return true;
  const reads = effectiveReadSourceIds(auth);
  if (reads === undefined) return false;
  return !(oauthClientMode(auth) && reads.every((s) => s === REGISTRATION_DEFAULT_SOURCE));
}

function why(serves: ServesPolicy): string {
  return serves.from === "config" ? "config access.serves is several" : `it has ${serves.enabledMembers} enabled members`;
}

function connection(auth: AuthInfo | undefined, isPublic: boolean): string {
  if (auth === undefined) return isPublic ? "the public bearer" : "this connection";
  return auth.principal?.kind === "pat" ? `token ${auth.clientId}` : `client ${auth.clientId}`;
}

function fix(auth: AuthInfo | undefined): string {
  if (auth?.principal?.kind === "pat") return `memrain auth permissions ${auth.clientId} set-read-sources <source>`;
  if (auth !== undefined) return `memrain auth rescope-client ${auth.clientId} --source <source>`;
  return "memrain auth create <name> --source <source>";
}

/**
 * Refuses a remote read from a connection bound to nobody on a brain that
 * serves several people; returns nothing otherwise. `brain` is null only for
 * the trusted operator path.
 */
export function assertRequesterScope(
  op: { name: string; scope?: string } | undefined,
  name: string,
  auth: AuthInfo | undefined,
  isPublic: boolean,
  brain: BrainAccess | null,
): void {
  if (brain === null || !brain.serves.several) return;
  if (!requiresRequesterScope(op, name)) return;
  if (!isPublic && callerIsScoped(auth)) return;
  throw new OperationError(
    "requester_scope_required",
    `This brain serves several people (${why(brain.serves)}) and ${connection(auth, isPublic)} is bound to nobody, so ${name} was refused and nothing was read.`,
    `On the brain host, scope it to a source: ${fix(auth)}, or bind it to the brain's owner.`,
  );
}

/** whoami's view of the gate for the calling connection. */
export function requesterScopeState(auth: AuthInfo | undefined, isPublic: boolean, brain: BrainAccess | null): "not_required" | "scoped" | "refused" {
  if (brain === null || !brain.serves.several) return "not_required";
  return !isPublic && callerIsScoped(auth) ? "scoped" : "refused";
}

/**
 * Creating a credential bound to nobody on a brain that serves several people
 * is refused: it names a member or a source, or it is not created.
 */
export async function assertCredentialScoped(
  engine: Pick<Engine, "query">,
  grant: { memberId?: string | null; sourceId?: string | readonly string[] | null },
  kind: "token" | "client",
  name: string,
): Promise<void> {
  const sources = (Array.isArray(grant.sourceId) ? grant.sourceId : [grant.sourceId]).filter((s): s is string => !!s);
  // A client's grant of only the registration default names nobody (callerIsScoped).
  const sourced = kind === "client" ? sources.some((s) => s !== REGISTRATION_DEFAULT_SOURCE) : sources.length > 0;
  if (grant.memberId || sourced) return;
  const { serves } = await readBrainAccess(engine);
  if (!serves.several) return;
  throw new OperationError(
    "requester_scope_required",
    `This brain serves several people (${why(serves)}), so the ${kind} ${name} was not created bound to nobody; nothing was created.`,
    kind === "token"
      ? `Scope it with --source <source>, or bind it to the brain's owner: memrain auth create ${name} --member <owner>.`
      : `Scope it to a source with --source <source>.`,
  );
}

/** One live credential bound to nobody, as doctor lists it. */
export interface UnscopedConnection { kind: "token" | "client"; name: string; fix: string }

/** Every live credential with no member and no source on a brain that serves several people; null otherwise. */
export async function unscopedConnections(engine: Pick<Engine, "query">): Promise<{ serves: ServesPolicy; connections: UnscopedConnection[] } | null> {
  const { serves } = await readBrainAccess(engine);
  if (!serves.several) return null;
  const tokens = await engine.query<{ name: string }>(
    // scope: operator-only lists unbound credentials for the doctor
    `SELECT DISTINCT name FROM access_tokens
      WHERE revoked_at IS NULL AND member_id IS NULL
        AND COALESCE(NULLIF(permissions->>'source_id', ''), '[]') = '[]'
      ORDER BY name`,
  );
  const clients = await engine.query<{ client_id: string }>(
    // scope: operator-only lists unbound credentials for the doctor
    // A client-mode client whose grant is only the registration default is as unbound as one with none.
    `SELECT client_id FROM oauth_clients
      WHERE deleted_at IS NULL AND member_id IS NULL AND tenant_mode = 'client'
        AND COALESCE(source_id, $1) = $1 AND COALESCE(federated_read, '{}') <@ ARRAY[$1]::text[]
      ORDER BY client_id`,
    [REGISTRATION_DEFAULT_SOURCE],
  );
  return {
    serves,
    connections: [
      ...tokens.rows.map((t) => ({ kind: "token" as const, name: t.name, fix: `memrain auth permissions ${t.name} set-read-sources <source>` })),
      ...clients.rows.map((c) => ({ kind: "client" as const, name: c.client_id, fix: `memrain auth rescope-client ${c.client_id} --source <source>` })),
    ],
  };
}
