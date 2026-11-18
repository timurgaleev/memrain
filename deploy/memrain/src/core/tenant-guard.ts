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
 * A path the table does not name is a write. An unknown policy (control
 * unreachable, nothing cached) lets reads through and refuses writes.
 */
import {
  hostingMode,
  tenantPolicy,
  type TenantPolicy,
} from "../control/contract.ts";
import { OperationError } from "./operation-error.ts";
import { OPERATIONS, operationAnnotations } from "../mcp/operations.ts";

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
  { path: "/s/", prefix: true, methods: ["GET", "HEAD", "POST"], cls: "write" },
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
  | { allow: false; status: 403 | 503; error: "tenant_suspended" | "tenant_policy_unavailable" };

const ALLOW: Admission = { allow: true };
const SUSPENDED: Admission = { allow: false, status: 403, error: "tenant_suspended" };
const UNAVAILABLE: Admission = { allow: false, status: 503, error: "tenant_policy_unavailable" };

type Hold = "open" | "read-only" | "block" | "unknown";

function holdOf(policy: TenantPolicy | null): Hold {
  if (policy === null) return "unknown";
  if (policy.status === "active") return "open";
  if (policy.status === "suspended" && policy.mode === "read-only") return "read-only";
  return "block";
}

export function decideRequest(policy: TenantPolicy | null, cls: RouteClass): Admission {
  const hold = holdOf(policy);
  if (hold === "open" || cls === "health") return ALLOW;
  if (hold === "block") return SUSPENDED;
  if (cls === "read" || cls === "mcp") return ALLOW;
  return hold === "unknown" ? UNAVAILABLE : SUSPENDED;
}

const OP_BY_NAME = new Map(OPERATIONS.map((o) => [o.name, o]));

/** An operation the registry does not know is judged as a write. */
function isReadOnlyOperation(name: string): boolean {
  const op = OP_BY_NAME.get(name);
  return op !== undefined && operationAnnotations(op).readOnlyHint;
}

export function decideOperation(policy: TenantPolicy | null, name: string): Admission {
  const hold = holdOf(policy);
  if (hold === "open") return ALLOW;
  if (hold === "block") return SUSPENDED;
  if (isReadOnlyOperation(name)) return ALLOW;
  return hold === "unknown" ? UNAVAILABLE : SUSPENDED;
}

/** Null when the request may proceed; otherwise the refusal to send. */
export async function admitRequest(req: Request, url: URL = new URL(req.url)): Promise<Response | null> {
  if (hostingMode() === null) return null;
  const d = decideRequest(await tenantPolicy(), routeClass(req.method, url.pathname));
  return d.allow ? null : Response.json({ ok: false, error: d.error }, { status: d.status });
}

/** Throws when this tenant may not run the MCP operation `name` now. */
export async function assertTenantAllows(name: string): Promise<void> {
  if (hostingMode() === null) return;
  const d = decideOperation(await tenantPolicy(), name);
  if (d.allow) return;
  if (d.error === "tenant_suspended") {
    throw new OperationError(
      "tenant_suspended",
      `this brain is suspended; '${name}' changes data and is refused`,
      "Reads still work. Ask the operator to resume the brain.",
    );
  }
  throw new OperationError(
    "storage_error",
    `the tenant policy is unavailable; '${name}' changes data and is refused`,
    "Retry shortly.",
  );
}

/** True when a hosted tenant is held (suspended, deleting, or policy unknown). */
export async function tenantPaused(): Promise<boolean> {
  if (hostingMode() === null) return false;
  return holdOf(await tenantPolicy()) !== "open";
}

/** False when the worker must not claim a job now. */
export async function admitJob(): Promise<boolean> {
  return !(await tenantPaused());
}
