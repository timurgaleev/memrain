/**
 * A scratch control plane on the test Postgres: a fresh control database per
 * test file, so files never share tenants, plus teardown that drops every
 * tenant database and role the file provisioned. Role names are cluster-wide,
 * so tenant ids carry a per-run suffix.
 */
import { randomBytes } from "node:crypto";
import { PostgresEngine } from "../../src/core/engine/postgres.ts";

export const PG_URL = process.env.MEMRAIN_TEST_POSTGRES_URL;

/** `url` pointing at database `db` instead. */
export function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** `url` logging in as `user` with `password`. */
export function withLogin(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(password);
  return u.toString();
}

/** A short per-run suffix for cluster-wide names. */
export function runSuffix(): string {
  return randomBytes(3).toString("hex").replace(/^[0-9]/, "x");
}

export interface ScratchControl {
  /** Master URL of the scratch control database. */
  url: string;
  dbName: string;
  drop(): Promise<void>;
}

export async function createScratchControl(masterUrl: string): Promise<ScratchControl> {
  const dbName = `memrain_control_t${runSuffix()}`;
  const admin = new PostgresEngine({ url: masterUrl, max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.close();
  }
  return {
    url: withDatabase(masterUrl, dbName),
    dbName,
    async drop() {
      const e = new PostgresEngine({ url: masterUrl, max: 1 });
      try {
        await e.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await e.close();
      }
    },
  };
}

/** Drop every database and login role of tenant `id` (test teardown). */
export async function dropTenantArtifacts(masterUrl: string, id: string): Promise<void> {
  const e = new PostgresEngine({ url: masterUrl, max: 1 });
  const db = `tenant_${id}`;
  try {
    await e.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    for (const role of [`${db}_owner`, `${db}_ctl`]) {
      const has = await e.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
      if (has.rows.length === 0) continue;
      // A role that still owns objects in another database (the control
      // database granted it CONNECT) cannot be dropped until those go.
      await e.query(`DROP OWNED BY "${role}"`).catch(() => undefined);
      await e.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
    }
  } finally {
    await e.close();
  }
}
