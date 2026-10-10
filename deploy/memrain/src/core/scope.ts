/**
 * OAuth scope hierarchy + allowlist.
 *
 * Single source of truth for the scope strings used by the auth layer:
 *  - the HTTP ingress (request-time `hasScope` gate),
 *  - the OAuth provider (token issuance, refresh, client registration),
 *  - the admin client-registration CLI.
 *
 * Hierarchy:
 *
 *            admin
 *              │
 *              ▼
 *            write
 *              │
 *              ▼
 *            read
 *
 * `agent` is a standalone sibling — `admin` does NOT imply it, so an admin
 * token must be re-registered with explicit bindings before it can dispatch
 * agent jobs.
 */

export type Scope = 'read' | 'write' | 'admin' | 'agent';

export const ALLOWED_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  'read',
  'write',
  'admin',
  'agent',
]);

/**
 * Sorted list (deterministic for drift-check output). Discovery does not
 * advertise all of these: see `DISCOVERY_SCOPES` in http/oauth-metadata.ts.
 */
export const ALLOWED_SCOPES_LIST: ReadonlyArray<Scope> = Object.freeze([
  'admin',
  'agent',
  'read',
  'write',
]);

/**
 * Scope names that were once accepted but never gated anything. Migration 124
 * strips them from stored grants; DCR drops them from a request instead of
 * refusing it, because discovery listed them until it advertised read/write.
 */
export const RETIRED_SCOPES: ReadonlySet<string> = new Set(['sources_admin', 'users_admin']);

/**
 * Which required scopes are implied by which granted scope.
 * `admin` implies `write` and `read`; `write` implies `read`. `agent` only
 * implies itself.
 */
const IMPLIES: Record<Scope, ReadonlySet<Scope>> = {
  admin: new Set<Scope>(['admin', 'write', 'read']),
  write: new Set<Scope>(['write', 'read']),
  read: new Set<Scope>(['read']),
  agent: new Set<Scope>(['agent']),
};

/**
 * Does the granted scope set include something that satisfies `required`?
 * Unknown scopes in `granted` are ignored (forward-compat — tokens carrying a
 * bogus scope don't crash the gate, they just don't satisfy anything).
 */
export function hasScope(grantedScopes: readonly string[], requiredScope: string): boolean {
  for (const granted of grantedScopes) {
    if (!isScope(granted)) continue;
    const implied = IMPLIES[granted];
    if (implied.has(requiredScope as Scope)) return true;
  }
  return false;
}

/**
 * The scopes a token issued with `issued` holds while its client is granted
 * `current`. Capabilities intersect, not spellings: an `admin` token under a
 * client narrowed to `write` holds `write` (and so `read`), never `admin`. A
 * scope the client gained after issuance is not added — the token keeps at most
 * what it was issued. An empty result means the token holds nothing.
 */
export function intersectGrantedScopes(issued: readonly string[], current: readonly string[]): string[] {
  const effective = issued.filter((s) => isScope(s) && hasScope(current, s));
  for (const s of current) {
    if (isScope(s) && hasScope(issued, s) && !hasScope(effective, s)) effective.push(s);
  }
  return Array.from(new Set(effective));
}

export function isScope(s: string): s is Scope {
  return ALLOWED_SCOPES.has(s as Scope);
}

export class InvalidScopeError extends Error {
  constructor(public readonly invalidScope: string, public readonly allScopes: readonly string[]) {
    super(`Unknown scope "${invalidScope}". Allowed: ${ALLOWED_SCOPES_LIST.join(', ')}.`);
    this.name = 'InvalidScopeError';
  }
}

/**
 * Validate that every scope in the input is allowed. Throws on the first
 * unknown scope. Used at client-registration time.
 */
export function assertAllowedScopes(scopes: readonly string[]): void {
  for (const s of scopes) {
    if (!isScope(s)) throw new InvalidScopeError(s, scopes);
  }
}

/**
 * Parse a space-separated scope string (OAuth wire format) into an array,
 * dropping empty fragments. Does NOT validate — call `assertAllowedScopes`
 * afterward at registration time.
 */
export function parseScopeString(s: string | undefined | null): string[] {
  if (!s) return [];
  return s.split(' ').filter(Boolean);
}

/**
 * Normalize a scopes input (string or string[]) to a sorted, deduped,
 * validated, space-separated string. Two registrations with the same scope
 * set produce identical DB rows.
 *
 * Throws:
 *   - input that is neither string nor array → TypeError
 *   - array element that's not a string → TypeError
 *   - element containing whitespace / empty → Error
 *   - any element not in ALLOWED_SCOPES → InvalidScopeError
 */
export function normalizeScopesInput(raw: unknown): string {
  if (raw == null) return 'read';

  let candidates: string[];

  if (typeof raw === 'string') {
    candidates = raw.split(/\s+/).filter(Boolean);
  } else if (Array.isArray(raw)) {
    for (const el of raw) {
      if (typeof el !== 'string') {
        throw new TypeError(
          `scopes array must contain only strings, got ${el === null ? 'null' : typeof el}`,
        );
      }
      if (el.length === 0) {
        throw new Error('scopes array must not contain empty strings');
      }
      if (/\s/.test(el)) {
        throw new Error(
          `scopes array element "${el}" contains whitespace. Each element must be a single scope name; use ['read', 'write'] not ['read write'].`,
        );
      }
    }
    candidates = raw as string[];
  } else {
    throw new TypeError(`scopes must be a string or array of strings, got ${typeof raw}`);
  }

  const deduped = Array.from(new Set(candidates)).sort();

  if (deduped.length === 0) {
    throw new Error('scopes is empty after normalization');
  }

  assertAllowedScopes(deduped);

  return deduped.join(' ');
}
