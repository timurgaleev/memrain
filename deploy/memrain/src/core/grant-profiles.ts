/**
 * Ready-made grant profiles: pick "reader" instead of listing scopes by hand.
 *
 * A profile is only an expansion into columns a credential already has
 * (scopes, the slug fence, the tool surface). It is recorded on the row with
 * the catalog version for audit, and grants nothing by itself. A profile never
 * gives more than its explicit equivalent, never admin, and refuses to expand
 * where its safety rule does not hold (a coding agent with no slug fence).
 *
 * Bump GRANT_PROFILE_CATALOG_VERSION whenever an entry's expansion changes,
 * so credentials issued from an older expansion can be told apart.
 */
import type { ToolSurface } from "../mcp/surface.ts";

export const GRANT_PROFILE_CATALOG_VERSION = 1;

export type GrantCredentialKind = "token" | "client";

export interface GrantProfile {
  id: string;
  description: string;
  scopes: readonly string[];
  toolSurface: ToolSurface;
  /** Credential kinds the profile can be applied to. */
  kinds: readonly GrantCredentialKind[];
  /** Needs a slug write fence (`--bound-slug-prefixes`), which only clients carry. */
  requiresSlugPrefixes: boolean;
  /** Null when usable; otherwise why not yet. */
  unavailable: string | null;
}

export const GRANT_PROFILES: readonly GrantProfile[] = [
  {
    id: "reader",
    description: "Reads its sources; writes nothing.",
    scopes: ["read"],
    toolSurface: "full",
    kinds: ["token", "client"],
    requiresSlugPrefixes: false,
    unavailable: null,
  },
  {
    id: "writer",
    description: "Reads its sources and writes to its own source.",
    scopes: ["read", "write"],
    toolSurface: "full",
    kinds: ["token", "client"],
    requiresSlugPrefixes: false,
    unavailable: null,
  },
  {
    id: "coding-agent",
    description: "Reads and writes, confined to the slug prefixes it is given.",
    scopes: ["read", "write"],
    toolSurface: "full",
    kinds: ["client"],
    requiresSlugPrefixes: true,
    unavailable: null,
  },
  {
    id: "proposer",
    description: "Reads, and proposes writes for the owner to approve.",
    scopes: ["read", "write"],
    toolSurface: "full",
    kinds: ["token", "client"],
    requiresSlugPrefixes: false,
    unavailable: "owner approval of agent writes is not available yet",
  },
  {
    id: "connector-ingest",
    description: "Only ingests into its own external source.",
    scopes: ["write"],
    toolSurface: "verbs",
    kinds: ["token"],
    requiresSlugPrefixes: false,
    unavailable: "connectors ingest through the server's own sync, not through a key",
  },
];

export type GrantProfileErrorReason =
  | "unknown_profile"
  | "unavailable"
  | "wrong_credential"
  | "needs_prefix"
  | "conflicting_flags";

export class GrantProfileError extends Error {
  constructor(readonly reason: GrantProfileErrorReason, message: string) {
    super(message);
    this.name = "GrantProfileError";
  }
}

export interface ResolvedGrantProfile {
  profile: string;
  catalogVersion: number;
  scopes: string[];
  toolSurface: ToolSurface;
}

export function resolveGrantProfile(
  id: string,
  kind: GrantCredentialKind,
  opts: { boundSlugPrefixes?: readonly string[]; scopes?: readonly string[] } = {},
): ResolvedGrantProfile {
  const profile = GRANT_PROFILES.find((p) => p.id === id);
  if (!profile) {
    throw new GrantProfileError(
      "unknown_profile",
      `unknown profile '${id}' (one of: ${GRANT_PROFILES.filter((p) => p.unavailable === null).map((p) => p.id).join(", ")})`,
    );
  }
  if (profile.unavailable !== null) {
    throw new GrantProfileError("unavailable", `profile '${id}' is not available: ${profile.unavailable}`);
  }
  if (!profile.kinds.includes(kind)) {
    throw new GrantProfileError(
      "wrong_credential",
      `profile '${id}' applies to ${profile.kinds.map((k) => (k === "client" ? "OAuth clients" : "personal access tokens")).join(" and ")} only`,
    );
  }
  if (profile.requiresSlugPrefixes && !(opts.boundSlugPrefixes && opts.boundSlugPrefixes.length > 0)) {
    throw new GrantProfileError("needs_prefix", `profile '${id}' needs --bound-slug-prefixes so its writes stay inside a namespace`);
  }
  if (opts.scopes !== undefined) {
    throw new GrantProfileError("conflicting_flags", "pass either --profile or --scopes, not both");
  }
  return {
    profile: profile.id,
    catalogVersion: GRANT_PROFILE_CATALOG_VERSION,
    scopes: [...profile.scopes],
    toolSurface: profile.toolSurface,
  };
}
