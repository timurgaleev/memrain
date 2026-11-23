/**
 * This build runs only as itself. An environment meant for a wrapped,
 * multi-tenant deployment (MEMRAIN_TENANT_ID, MEMRAIN_CONTROL_URL) relies on
 * gates this build does not have: a page-count limit inside the page write,
 * an outside spend hold, per-request admission. Starting under it would run
 * with all of those open, so every entry point refuses instead.
 */
const WRAPPED_ONLY_ENV = ["MEMRAIN_TENANT_ID", "MEMRAIN_CONTROL_URL"] as const;

export function assertNotWrapped(env: Readonly<Record<string, string | undefined>> = process.env): void {
  const set = WRAPPED_ONLY_ENV.filter((k) => (env[k] ?? "").trim() !== "");
  if (set.length === 0) return;
  throw new Error(
    `${set.join(" and ")} set, but this build runs no tenant or control-plane extension; refusing to start. ` +
      "Unset them, or run the build that was deployed with them.",
  );
}
