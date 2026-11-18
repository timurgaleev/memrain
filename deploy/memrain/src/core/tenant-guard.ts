/**
 * Tenant admission: the one gate between a hosted tenant's policy and
 * everything that enters the process — HTTP requests (admitRequest, before
 * routing), MCP operations (assertTenantAllows, in dispatch) and queued jobs
 * (admitJob, before a claim).
 *
 * Outside hosting mode every gate returns at once without reading anything,
 * so a single-tenant brain behaves exactly as it did before the gates existed.
 *
 * Inside it, a request is judged by its route class:
 *   health  always served
 *   read    refused only when the tenant is blocked
 *   mcp     refused when blocked; otherwise judged per operation in dispatch
 *   auth    refused when blocked or read-only (it issues credentials)
 *   write   refused when blocked or read-only
 * A path the table does not name is a write. Only an `active` tenant is open;
 * a `suspended` one held `read-only` serves reads; every other status, known
 * or not, is blocked.
 *
 * The isolation check comes first (503 before 403): until the control plane
 * has answered and its smoke stamp is verified for this container, only health
 * is served, in dispatch as well as at the door. An outage keeps the last good
 * policy for a while (policy.ts); past that, or with none ever read, the policy
 * is unknown and nothing but health is served: an unknown policy carries no
 * verified stamp, so "reads still pass" never bypasses the isolation check.
 */
import { hostingMode, type TenantPolicy } from "../control/contract.ts";
import { hostedPolicy } from "../control/policy.ts";
import { OperationError } from "./operation-error.ts";
import type { Engine } from "./engine/interface.ts";
import { OPERATIONS, operationAnnotations } from "../mcp/operations.ts";
import { assertPageRoom, limitReached } from "./page-room.ts";

export type RouteClass = "health" | "auth" | "read" | "mcp" | "write";

export interface RouteClassEntry {
  /** An exact path, or with `prefix` every path below it (`/admin` covers `/admin/x`). */
  path: string;
  prefix?: true;
  methods: readonly string[];
  cls: RouteClass;
}

const GET = ["GET", "HEAD", "OPTIONS"] as const;

/**
 * First match wins; order specific entries before their prefixes. A CORS
 * preflight (OPTIONS) takes the class of the route it asks about.
 */
export const ROUTE_CLASSES: readonly RouteClassEntry[] = [
  { path: "/health", methods: GET, cls: "health" },
  { path: "/.well-known/", prefix: true, methods: GET, cls: "health" },
  { path: "/authorize", methods: ["GET", "HEAD", "POST", "OPTIONS"], cls: "auth" },
  { path: "/token", methods: ["POST", "OPTIONS"], cls: "auth" },
  { path: "/register", methods: ["POST", "OPTIONS"], cls: "auth" },
  { path: "/revoke", methods: ["POST", "OPTIONS"], cls: "auth" },
  { path: "/app/login", methods: ["GET", "HEAD", "POST"], cls: "auth" },
  { path: "/app/invite", methods: ["GET", "HEAD", "POST"], cls: "auth" },
  { path: "/mcp", methods: ["POST", "OPTIONS"], cls: "mcp" },
  { path: "/ingest", methods: ["POST"], cls: "write" },
  // A one-time sign-in link: a GET that issues an admin session.
  { path: "/admin/auth/", prefix: true, methods: ["GET", "HEAD"], cls: "auth" },
  { path: "/admin", prefix: true, methods: ["GET", "HEAD"], cls: "read" },
  { path: "/app", prefix: true, methods: ["GET", "HEAD"], cls: "read" },
  // A share link: the form, and the password post that shows the answer. It
  // changes nothing but the link's own attempt counter, so a read-only tenant
  // keeps serving its links; a blocked one serves none.
  { path: "/s/", prefix: true, methods: ["GET", "HEAD", "POST"], cls: "read" },
];

function pathMatches(entry: RouteClassEntry, pathname: string): boolean {
  if (pathname === entry.path) return true;
  if (!entry.prefix) return false;
  return entry.path.endsWith("/") ? pathname.startsWith(entry.path) : pathname.startsWith(`${entry.path}/`);
}

export function routeClassEntry(method: string, pathname: string): RouteClassEntry | null {
  const m = method.toUpperCase();
  return ROUTE_CLASSES.find((e) => e.methods.includes(m) && pathMatches(e, pathname)) ?? null;
}

export function routeClass(method: string, pathname: string): RouteClass {
  return routeClassEntry(method, pathname)?.cls ?? "write";
}

export type Admission =
  | { allow: true }
  | { allow: false; status: 403 | 503; error: "tenant_suspended" | "tenant_policy_unavailable" | "isolation_unverified" };

const ALLOW: Admission = { allow: true };
const SUSPENDED: Admission = { allow: false, status: 403, error: "tenant_suspended" };
const UNAVAILABLE: Admission = { allow: false, status: 503, error: "tenant_policy_unavailable" };
const UNVERIFIED: Admission = { allow: false, status: 503, error: "isolation_unverified" };

type Hold = "open" | "read-only" | "block" | "unknown";

function holdOf(policy: TenantPolicy | null): Hold {
  if (policy === null) return "unknown";
  if (policy.status === "active") return "open";
  if (policy.status === "suspended" && policy.mode === "read-only") return "read-only";
  return "block";
}

export function decideRequest(policy: TenantPolicy | null, cls: RouteClass): Admission {
  if (cls === "health") return ALLOW;
  if (policy === null) return UNAVAILABLE;
  if (policy.isolation === "unverified") return UNVERIFIED;
  const hold = holdOf(policy);
  if (hold === "open") return ALLOW;
  if (hold === "block") return SUSPENDED;
  return cls === "read" || cls === "mcp" ? ALLOW : SUSPENDED;
}

const OP_BY_NAME = new Map(OPERATIONS.map((o) => [o.name, o]));

/** An operation the registry does not know is judged as a write. */
function isReadOnlyOperation(name: string): boolean {
  const op = OP_BY_NAME.get(name);
  return op !== undefined && operationAnnotations(op).readOnlyHint;
}

export function decideOperation(policy: TenantPolicy | null, name: string): Admission {
  if (policy === null) return UNAVAILABLE;
  if (policy.isolation === "unverified") return UNVERIFIED;
  const hold = holdOf(policy);
  if (hold === "open") return ALLOW;
  if (hold === "block") return SUSPENDED;
  return isReadOnlyOperation(name) ? ALLOW : SUSPENDED;
}

/** Null when the request may proceed; otherwise the refusal to send. */
export async function admitRequest(req: Request, url: URL = new URL(req.url)): Promise<Response | null> {
  if (hostingMode() === null) return null;
  const d = decideRequest(await hostedPolicy(), routeClass(req.method, url.pathname));
  return d.allow ? null : Response.json({ ok: false, error: d.error }, { status: d.status });
}

/** Operations that can add a page; refused once the plan's page limit is reached. */
const PAGE_ADDING_OPERATIONS: ReadonlySet<string> = new Set(["index", "page_put", "page_restore"]);

export { assertPageRoom };

/**
 * Throws `tenant_limit_reached` when a hosted brain already has its plan's
 * maximum of members (removed members do not count). For the member-adding
 * paths; outside hosting mode it does nothing.
 */
export async function assertMemberRoom(engine: Pick<Engine, "query">): Promise<void> {
  if (hostingMode() === null) return;
  const max = (await hostedPolicy())?.limits.maxMembers;
  if (max === undefined) return;
  const r = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.members WHERE status <> 'removed'`);
  if ((r.rows[0]?.n ?? 0) >= max) throw limitReached("member");
}

/**
 * Throws `tenant_limit_reached` when the pages a write will add would take a
 * hosted brain past its plan's page limit. For the paths that write many pages
 * outside MCP dispatch (the /app import and demo); `adding` is counted only
 * when there is a limit. Outside hosting mode it does nothing.
 */
export async function assertHostedPageRoom(engine: Pick<Engine, "query">, adding: () => number | Promise<number>): Promise<void> {
  if (hostingMode() === null) return;
  const max = (await hostedPolicy())?.limits.maxPages;
  if (max === undefined) return;
  await assertPageRoom(engine, max, await adding());
}

/** A page_put that rewrites a live page adds none, so the page limit does not stop it. */
async function rewritesLivePage(engine: Pick<Engine, "query">, name: string, args: Record<string, unknown> | undefined): Promise<boolean> {
  const slug = args?.["slug"];
  if (name !== "page_put" || typeof slug !== "string") return false;
  // scope: operator-only slugs are global, so a live slug anywhere means the write adds no page; only a yes/no leaves here
  const r = await engine.query(`SELECT 1 FROM public.pages WHERE slug = $1 AND deleted_at IS NULL`, [slug]);
  return r.rows.length > 0;
}

/**
 * Throws when this tenant may not run the MCP operation `name` now: held, or
 * (given the brain's engine, opened only then) an operation that adds a page
 * at the page limit.
 */
export async function assertTenantAllows(name: string, engine?: () => Pick<Engine, "query">, args?: Record<string, unknown>): Promise<void> {
  if (hostingMode() === null) return;
  const policy = await hostedPolicy();
  const d = decideOperation(policy, name);
  if (d.allow) {
    if (engine && policy && policy.limits.maxPages !== undefined && PAGE_ADDING_OPERATIONS.has(name)
      && !(await rewritesLivePage(engine(), name, args))) {
      await assertPageRoom(engine(), policy.limits.maxPages);
    }
    return;
  }
  if (d.error === "isolation_unverified") {
    throw new OperationError(
      "storage_error",
      `this brain's isolation check has not passed since it started; '${name}' is refused`,
      "Retry shortly; the operator runs the isolation smoke after every start.",
    );
  }
  if (d.error === "tenant_suspended") {
    throw new OperationError(
      "tenant_suspended",
      `this brain is suspended; '${name}' changes data and is refused`,
      "Reads still work. Ask the operator to resume the brain.",
    );
  }
  throw new OperationError(
    "storage_error",
    `the tenant policy is unavailable; '${name}' is refused`,
    "Retry shortly.",
  );
}

/** True when a hosted tenant is held (any status but active, or policy unknown). */
export async function tenantPaused(): Promise<boolean> {
  if (hostingMode() === null) return false;
  return holdOf(await hostedPolicy()) !== "open";
}

/** False when the worker must not claim a job now. */
export async function admitJob(): Promise<boolean> {
  return !(await tenantPaused());
}
