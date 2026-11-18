/**
 * The operator's way into a tenant database. The tenant owns that database, so
 * anything there can be the tenant's: a schema named after whoever connects
 * (first on the default search_path), a view shadowing a table, a trigger, a
 * row policy. Their functions run as the session's user. Were that the master,
 * they would hold every tenant's owner role and the control database, and a
 * `SET ROLE` to the owner is no guard: the function can `RESET ROLE` first.
 *
 * So the master never runs SQL in a tenant database (dropping it, and the
 * fixed DDL of provisioning, aside). Each operator command gets a throwaway
 * login instead: NOINHERIT, a member of the tenant's owner role and nothing
 * else, allowed to CONNECT to this one database, and starting every session as
 * the owner. RESET ROLE lands on the owner, SET ROLE NONE on a role with no
 * rights at all: whatever the tenant planted can do no more than the tenant.
 */
import { randomBytes } from "node:crypto";
import { PostgresEngine } from "../core/engine/postgres.ts";
import { urlForDatabase, urlForLogin } from "./provision.ts";
import { ident, literal, tenantNames } from "./tenants.ts";

export interface TenantSessionOptions {
  max?: number;
  statementTimeoutMs?: number;
}

/**
 * Run `fn` against tenant `id`'s database with the tenant owner's rights and
 * no more. `masterUrl` is the master-role URL of the control database; it is
 * used there only, to make and drop the throwaway login.
 */
export async function asTenantOwner<T>(
  masterUrl: string,
  id: string,
  fn: (brain: PostgresEngine) => Promise<T>,
  opts: TenantSessionOptions = {},
): Promise<T> {
  const n = tenantNames(id);
  const login = `${n.owner}_op_${randomBytes(4).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  const master = new PostgresEngine({ url: masterUrl, max: 1 });
  try {
    // VALID UNTIL bounds a login that a crash left behind.
    const until = new Date(Date.now() + 86_400_000).toISOString();
    await master.query(`CREATE ROLE ${ident(login)} LOGIN NOINHERIT PASSWORD ${literal(password)} VALID UNTIL ${literal(until)}`);
    try {
      await master.query(`GRANT ${ident(n.owner)} TO ${ident(login)}`);
      // Its own CONNECT: under the delete fence the owner has none.
      await master.query(`GRANT CONNECT ON DATABASE ${ident(n.db)} TO ${ident(login)}`);
      const brain = new PostgresEngine({
        url: urlForLogin(urlForDatabase(masterUrl, n.db), login, password),
        max: opts.max ?? 1,
        role: n.owner,
        ...(opts.statementTimeoutMs !== undefined ? { statementTimeoutMs: opts.statementTimeoutMs } : {}),
      });
      try {
        return await fn(brain);
      } finally {
        await brain.close();
      }
    } finally {
      await dropLogin(master, login, n.owner, n.db);
    }
  } finally {
    await master.close();
  }
}

async function dropLogin(master: PostgresEngine, login: string, owner: string, db: string): Promise<void> {
  await master.query(`ALTER ROLE ${ident(login)} NOLOGIN`);
  await master.query(`REVOKE ${ident(owner)} FROM ${ident(login)}`);
  await master.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1`, [login]);
  await master.query(`REVOKE CONNECT ON DATABASE ${ident(db)} FROM ${ident(login)}`);
  try {
    await master.query(`DROP ROLE ${ident(login)}`);
  } catch (err) {
    // Only an object the tenant made this login own keeps it, and by now it
    // can neither log in nor act as the owner.
    throw new Error(`temporary login ${login} is disabled but could not be dropped: ${(err as Error).message}`);
  }
}
