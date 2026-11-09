import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout, spyOn } from "bun:test";
import { auditStoredSecrets } from "../src/core/secret-audit.ts";
import { runSecretsAudit } from "../src/commands/secrets.ts";
import { fingerprintSecret } from "../src/core/secret-scan.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

setDefaultTimeout(60000);
const key = ["gh", "p_", "A1b2C3d4".repeat(4), "Zz9Y"].join("");
const statuses = ["pending", "running", "succeeded", "failed", "cancelled"];

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`job payload secret audit (${name})`, () => {
    let db: Awaited<ReturnType<typeof open>>;
    beforeAll(async () => {
      db = await open();
      for (let i = 0; i < 205; i++) {
        await db.storage.engine().query(
          `INSERT INTO jobs(id, kind, status, payload, authority) VALUES($1, $2, $3, $4::text::jsonb, $5::text::jsonb)`,
          [`private-job-${i.toString().padStart(3, "0")}`, "private-handler", statuses[i % 5],
            JSON.stringify({ [key]: "keep", nested: { value: key }, source_id: "default", spendBy: "private-client" }),
            JSON.stringify({ private_grant: "unchanged", payload_hash: "original" })],
        );
      }
    });
    afterAll(async () => { await db.close(); });

    it("counts keys and values across keyset batches without disclosing any row details", async () => {
      const before = (await db.storage.engine().query("SELECT * FROM jobs ORDER BY id")).rows;
      const r = await auditStoredSecrets(db.storage, { kinds: ["jobs"], limit: 1 });
      expect(r).toMatchObject({ rows_scanned: 205, rows_affected: 205, hits_total: 410,
        by_kind: { jobs: 410 }, by_secret_kind: { "github-token": 410 }, hits: [], key_collisions: [],
        jobs: { rows_scanned: 205, rows_affected: 205, hits_total: 410,
          by_secret_kind: { "github-token": 410 },
          by_status: { pending: 82, running: 82, succeeded: 82, failed: 82, cancelled: 82 } } });
      for (const privateValue of [key, fingerprintSecret(key), "private-job", "private-handler", "private-client", "private_grant"]) {
        expect(JSON.stringify(r)).not.toContain(privateValue);
      }
      expect((await db.storage.engine().query("SELECT * FROM jobs ORDER BY id")).rows).toEqual(before);
    });

    it("skips jobs for a source scope rather than trusting payload.source_id", async () => {
      const r = await auditStoredSecrets(db.storage, { kinds: ["jobs"], sourceId: "default" });
      expect(r).toMatchObject({ skipped_kinds: ["jobs"], kinds: [], rows_scanned: 0, hits_total: 0 });
    });

    it("withholds every job rewrite under apply and keeps CLI unsuccessful while hits remain", async () => {
      const before = (await db.storage.engine().query("SELECT * FROM jobs ORDER BY id")).rows;
      const out = spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(await runSecretsAudit({ storage: db.storage, kinds: ["jobs"], apply: true, yes: true, json: true })).toBe(1);
        const r = JSON.parse(String(out.mock.calls[0]?.[0]));
        expect(r).toMatchObject({ rows_rewritten: 0, jobs: { hits_withheld: 410 } });
        const saved = await db.storage.engine().query<{ errors_total: number }>("SELECT errors_total FROM secret_audit_runs WHERE id = $1", [r.run_id]);
        expect(Number(saved.rows[0]?.errors_total)).toBeGreaterThan(0);
        out.mockClear();
        expect(await runSecretsAudit({ storage: db.storage, kinds: ["jobs"], apply: true, yes: true })).toBe(1);
        const printed = out.mock.calls.map(a => a.join(" ")).join("\n");
        expect(printed).toContain("count-only");
        for (const value of [key, fingerprintSecret(key), "private-job", "private-handler"]) expect(printed).not.toContain(value);
        expect((await db.storage.engine().query("SELECT * FROM jobs ORDER BY id")).rows).toEqual(before);
      } finally { out.mockRestore(); }
    });
  });
}
