/**
 * Extension hooks: the points where a build that wraps this server (its own
 * entrypoint calls `registerExtension`, then runs the CLI) adds admission,
 * limits, spend holds, routes and commands.
 *
 * With nothing registered every hook is a no-op and the server behaves as a
 * plain single-brain install.
 *
 * This module imports nothing at runtime: a wrapper registers before any other
 * module of the server is evaluated, so runtime-config and friends see the
 * registered key sets when they load.
 */
import type { Engine } from "./engine/interface.ts";

/** What a spend hook gets to refuse a call with; both throw. */
export interface SpendRefusal {
  /** A spending decision: booked as a refusal, thrown as a daily-cap refusal. */
  refuse(message: string, suggestion: string, rollover?: boolean): Promise<never>;
  /** An outage: booked as a refusal, thrown as a transient storage error. */
  unavailable(message: string): Promise<never>;
}

export interface ExternalHold {
  id: string;
  usd: number;
}

/**
 * How a held call ended: `done` with what it cost, `refused`/`failed` with $0,
 * or `unknown` when it may have billed without reporting usage (the hold must
 * then stay counted until it expires).
 */
export type HoldOutcome =
  | { outcome: "done"; actualUsd: number }
  | { outcome: "failed" }
  | { outcome: "unknown" };

/** The AWS SDK's credential identity, as a Bedrock credentials provider returns it. */
export interface AwsCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

export interface SpendCall {
  operation: string;
  model: string;
}

export interface RouteContext {
  storage: unknown;
  publicUrl?: string;
  oauthProvider?: unknown;
}

export interface Extension {
  /** Name shown in startup errors. */
  name: string;
  /** Throws to refuse startup (after the server's own ingress checks). */
  startupCheck(opts: { publicBearerToken?: string; internalToken?: string }, env: Readonly<Record<string, string | undefined>>): void;
  /** Null to let the request through; otherwise the response to send instead. Runs before routing. */
  admitRequest(req: Request, url: URL): Promise<Response | null>;
  /** Throws an OperationError when the MCP operation `name` may not run now. */
  admitOperation(name: string, engine: () => Pick<Engine, "query">, args: Record<string, unknown> | undefined): Promise<void>;
  /** True while background work (jobs, connector syncs, cycle, daemons) must hold. */
  paused(): Promise<boolean>;
  /** Throws before a member is added when the brain has no room for one. */
  beforeAddMember(engine: Pick<Engine, "query">): Promise<void>;
  /** Inside the transaction about to add a live page; throws when there is no room. */
  beforePageAddInTx(tx: Pick<Engine, "query">): Promise<void>;
  /** A second spend hold taken after the brain's own; null when none applies. */
  holdSpend(call: SpendCall, worstUsd: number | null, refusal: SpendRefusal): Promise<ExternalHold | null>;
  settleSpend(call: SpendCall, hold: ExternalHold, result: HoldOutcome): Promise<void>;
  /** Extra AWS SDK client config for Bedrock (e.g. a credentials provider). */
  bedrockClientConfig(): { credentials?: () => Promise<AwsCredentialIdentity> };
  /** True when authenticated callers get the closed public error text too. */
  withholdErrors(authenticated: boolean): boolean;
  /** True for a path the extension authenticates itself (served before any credential). */
  preCredentialRoute(req: Request, url: URL): boolean;
  /** Routes served before /mcp; null when the path is not the extension's. */
  routes(req: Request, url: URL, ctx: RouteContext): Promise<Response | null>;
  /** Admin API routes, called after the admin session and same-origin checks. */
  adminRoutes(req: Request, url: URL, ctx: { storage: unknown }): Promise<Response | null>;
  /**
   * CLI commands taken before the server's own flag parsing: `(argv)` returns an
   * exit code, or null when this argv is not the extension's.
   */
  command(argv: readonly string[]): Promise<number | null>;
  /** Runtime-config keys that only the environment may set / that are never stored. */
  envOnlyKeys: readonly string[];
  neverStoredKeys: readonly string[];
  /** Usage lines appended to `memrain help`. */
  usage: readonly string[];
}

const NONE: Extension = {
  name: "none",
  startupCheck: () => {},
  admitRequest: async () => null,
  admitOperation: async () => {},
  paused: async () => false,
  beforeAddMember: async () => {},
  beforePageAddInTx: async () => {},
  holdSpend: async () => null,
  settleSpend: async () => {},
  bedrockClientConfig: () => ({}),
  withholdErrors: () => false,
  preCredentialRoute: () => false,
  routes: async () => null,
  adminRoutes: async () => null,
  command: async () => null,
  envOnlyKeys: [],
  neverStoredKeys: [],
  usage: [],
};

/**
 * This build accepts no extension: the gates a wrapped deployment relies on
 * (the page-add limit, the outside spend hold) are gone from its write and
 * spend paths, so a registered extension would run with them silently open.
 * Every hook reads as the defaults above.
 */
export function registerExtension(ext: Partial<Extension> & { name: string }): never {
  throw new Error(`extension '${ext.name}' refused: this build runs no extensions`);
}

export function extension(): Extension {
  return NONE;
}
