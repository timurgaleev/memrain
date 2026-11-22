/**
 * `memrain connectors facts <account-id>`: the dry run prices an account's
 * pages without a call or a write, `--enable` refuses an unsafe setup,
 * `--disable` turns the account off, and `--forget` withdraws only that
 * account's facts after exporting them.
 *
 * Value: protects=paid extraction is only switched on behind the quarantine gate, a brain budget, a priced model, a
 * non-calendar source and a below-owner tier, and a forget never reaches another account's facts; fails_when=a guard
 * is dropped, the preview writes, or the forget selects by source alone; why_new=the command is new;
 * seam=runConnectorFacts / runConnectors over PGLite with env passed in; no_claim=the live gate configuration is
 * checked by the enable step on the host, not here.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { addFact } from "../src/core/facts.ts";
import { runConnectorFacts } from "../src/commands/connectors-facts.ts";
import { runConnectors } from "../src/commands/connectors.ts";
import { connectorFactsWriter } from "../src/core/cycle/connector-facts.ts";
import { setSpendLedgerEngine } from "../src/core/budget.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const CAL = "00000000-0000-4000-8000-0000000000ca";
const VAULT = "00000000-0000-4000-8000-0000000000fa";
const SAFE_ENV = { MEMRAIN_WRITE_GATE_ROWS: "quarantine", MEMRAIN_DAILY_BUDGET_USD: "3" };
const BODY = "From: Alice Example. Acme Example signs the lease in May and opens a Lisbon office next spring. ".repeat(2);

let tmp: string;
let storage: Storage;
let out: string[] = [];
const realLog = console.log;
const realError = console.error;

beforeAll(() => {
  console.log = (...args: unknown[]) => { out.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { out.push(args.join(" ")); };
});
afterAll(() => {
  console.log = realLog;
  console.error = realError;
  setSpendLedgerEngine(null);
});
beforeEach(async () => {
  out = [];
  tmp = mkdtempSync(join(tmpdir(), "memrain-connfacts-cli-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  await registerSource(e, { id: "mail", kind: "mailbox", pathPrefix: "/mail" });
  await registerSource(e, { id: "cal", kind: "calendar", pathPrefix: "/cal" });
  await registerSource(e, { id: "notes", kind: "vault", pathPrefix: "/notes" });
  for (const [id, source] of [[A, "mail"], [B, "mail"], [CAL, "cal"], [VAULT, "notes"]] as const) {
    await e.query(
      `INSERT INTO connector_accounts (id, source_id, provider, principal_ref, account_label, enabled)
       VALUES ($1, $2, 'google', 'admin:operator', $3, true)`,
      [id, source, `owner-${id.slice(-2)}@example.test`],
    );
  }
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function mailPage(slug: string, accountId: string, type = "connector-mail"): Promise<void> {
  await putPage(storage, { slug, type, allowAdHocType: true, markdown_body: `${BODY}Thread ${slug}.`, source_id: "mail" });
  await storage.engine().query(`INSERT INTO connector_items (account_id, external_id, page_slug) VALUES ($1, $2, $3)`, [accountId, `ext-${slug}`, slug]);
}

async function accountRow(id: string): Promise<{ facts_extraction: boolean; cap: number }> {
  const r = await storage.engine().query<{ facts_extraction: boolean; cap: string | number }>(
    "SELECT facts_extraction, facts_cap_usd_daily AS cap FROM connector_accounts WHERE id = $1", [id]);
  return { facts_extraction: r.rows[0]!.facts_extraction, cap: Number(r.rows[0]!.cap) };
}

const lastJson = (): Record<string, unknown> => JSON.parse(out.at(-1)!);

describe("connectors facts dry run", () => {
  it("prices the account's own mail pages and writes nothing", async () => {
    await mailPage("mail/one", A);
    await mailPage("mail/two", A);
    await mailPage("mail/event", A, "connector-calendar");
    await mailPage("mail/other", B);
    const code = await runConnectors({ sub: "facts", action: A, storage, json: true });
    expect(code).toBe(0);
    const e = lastJson();
    expect(e).toMatchObject({ ok: true, account_id: A, enabled: false, eligible_pages: 2, model: "eu.anthropic.claude-haiku-5-5" });
    expect(e["est_usd_typical"]).toBeGreaterThan(0);
    expect(e["est_usd_worst"] as number).toBeGreaterThan(e["est_usd_typical"] as number);
    expect(await accountRow(A)).toEqual({ facts_extraction: false, cap: 0 });
    expect((await storage.engine().query("SELECT 1 FROM entity_facts")).rows).toHaveLength(0);
  });
});

describe("connectors facts --enable", () => {
  it("refuses unless outside rows are quarantined", async () => {
    for (const env of [{ MEMRAIN_DAILY_BUDGET_USD: "3" }, { ...SAFE_ENV, MEMRAIN_WRITE_GATE_EXTERNAL: "flag" }]) {
      expect(await runConnectorFacts({ accountId: A, enable: true, cap: "1", apply: true, storage, env })).toBe(1);
    }
    expect(out.at(-1)).toContain("MEMRAIN_WRITE_GATE_ROWS=quarantine");
    expect(await accountRow(A)).toEqual({ facts_extraction: false, cap: 0 });
  });

  it("refuses without a brain budget, for a calendar account, and for an owner-tier source", async () => {
    expect(await runConnectorFacts({ accountId: A, enable: true, cap: "1", apply: true, storage, env: { MEMRAIN_WRITE_GATE_ROWS: "quarantine" } })).toBe(1);
    expect(out.at(-1)).toContain("MEMRAIN_DAILY_BUDGET_USD");
    expect(await runConnectorFacts({ accountId: CAL, enable: true, cap: "1", apply: true, storage, env: SAFE_ENV })).toBe(1);
    expect(out.at(-1)).toContain("calendar");
    expect(await runConnectorFacts({ accountId: VAULT, enable: true, cap: "1", apply: true, storage, env: SAFE_ENV })).toBe(1);
    expect(out.at(-1)).toContain("owner tier");
    expect(await accountRow(CAL)).toEqual({ facts_extraction: false, cap: 0 });
    expect(await accountRow(VAULT)).toEqual({ facts_extraction: false, cap: 0 });
  });

  it("refuses a cap outside (0, 20] and an --apply with nothing to apply", async () => {
    for (const cap of ["0", "20.5", "abc"]) {
      expect(await runConnectorFacts({ accountId: A, enable: true, cap, apply: true, storage, env: SAFE_ENV })).toBe(1);
    }
    expect(await runConnectorFacts({ accountId: A, apply: true, storage, env: SAFE_ENV })).toBe(1);
    expect(await accountRow(A)).toEqual({ facts_extraction: false, cap: 0 });
  });

  it("previews without --apply, enables with it, and --disable turns it off", async () => {
    expect(await runConnectorFacts({ accountId: A, enable: true, cap: "1", storage, env: SAFE_ENV, json: true })).toBe(0);
    expect(lastJson()).toMatchObject({ ok: true, applied: false });
    expect(await accountRow(A)).toEqual({ facts_extraction: false, cap: 0 });
    expect(await runConnectorFacts({ accountId: A, enable: true, cap: "1", apply: true, storage, env: SAFE_ENV })).toBe(0);
    expect(await accountRow(A)).toEqual({ facts_extraction: true, cap: 1 });
    expect(await runConnectorFacts({ accountId: A, disable: true, apply: true, storage, env: SAFE_ENV })).toBe(0);
    expect((await accountRow(A)).facts_extraction).toBe(false);
  });
});

describe("connectors facts --forget", () => {
  it("withdraws only this account's facts in its source, after a 0600 export", async () => {
    await mailPage("mail/one", A);
    await mailPage("mail/two", B);
    await addFact(storage, { entity_slug: "companies/acme-example", fact: "Acme Example signs the lease in May", source_slug: "mail/one", source_id: "mail", written_by: connectorFactsWriter(A) });
    await addFact(storage, { entity_slug: "companies/acme-example", fact: "Acme Example opens a Lisbon office", source_slug: "mail/two", source_id: "mail", written_by: connectorFactsWriter(B) });
    await addFact(storage, { entity_slug: "companies/acme-example", fact: "Acme Example hired a CFO", source_slug: "mail/one", source_id: "mail", written_by: "facts-extract" });

    expect(await runConnectorFacts({ accountId: A, forget: true, storage, json: true })).toBe(0);
    expect(lastJson()).toMatchObject({ applied: false, facts: 1 });

    const exportPath = join(tmp, "export.json");
    expect(await runConnectorFacts({ accountId: A, forget: true, apply: true, exportPath, storage, json: true })).toBe(0);
    expect(lastJson()).toMatchObject({ applied: true, facts: 1, forgotten: 1 });
    expect(statSync(exportPath).mode & 0o777).toBe(0o600);
    const exported = JSON.parse(readFileSync(exportPath, "utf8")) as { facts: Array<{ fact: string }> };
    expect(exported.facts.map((f) => f.fact)).toEqual(["Acme Example signs the lease in May"]);

    const live = (await storage.engine().query<{ fact: string }>("SELECT fact FROM entity_facts WHERE forgotten_at IS NULL ORDER BY fact")).rows.map((r) => r.fact);
    expect(live).toEqual(["Acme Example hired a CFO", "Acme Example opens a Lisbon office"]);
  });

  // Value: protects=forgetting one account's facts never withdraws a claim another account or the owner also holds;
  // fails_when=the forget sweeps other copies of the claim or files a withdrawal that blocks their writes;
  // why_new=the operator forget path sweeps every copy of a claim in its source; seam=the CLI over PGLite.
  it("leaves the same claim held by another account and by the owner alone, and withdraws nothing", async () => {
    const CLAIM = "Acme Example signs the lease in May";
    const at = { entity_slug: "companies/acme-example", fact: CLAIM, source_id: "mail" };
    await addFact(storage, { ...at, source_slug: "mail/one", written_by: connectorFactsWriter(A) });
    await addFact(storage, { ...at, source_slug: "mail/two", written_by: connectorFactsWriter(B) });
    await addFact(storage, { ...at, written_by: "operator" });

    expect(await runConnectorFacts({ accountId: A, forget: true, apply: true, exportPath: join(tmp, "a.json"), storage, json: true })).toBe(0);
    expect(lastJson()).toMatchObject({ facts: 1, forgotten: 1 });
    const rows = (await storage.engine().query<{ written_by: string; live: boolean }>(
      "SELECT written_by, forgotten_at IS NULL AS live FROM entity_facts ORDER BY written_by")).rows;
    expect(rows).toEqual([
      { written_by: connectorFactsWriter(A), live: false },
      { written_by: connectorFactsWriter(B), live: true },
      { written_by: "operator", live: true },
    ]);
    expect((await storage.engine().query("SELECT 1 FROM fact_withdrawals")).rows).toHaveLength(0);
    // Both can still write the claim (a third writer stands in for any later write).
    const again = await addFact(storage, { ...at, written_by: "facts-extract" });
    expect(again.withdrawn).toBeUndefined();
    expect(again.inserted).toBe(true);
  });

  it("withdraws a claim only this account held, so its next run does not write it back", async () => {
    const at = { entity_slug: "companies/acme-example", fact: "Acme Example closes the Porto office", source_id: "mail" };
    await addFact(storage, { ...at, source_slug: "mail/one", written_by: connectorFactsWriter(A) });
    expect(await runConnectorFacts({ accountId: A, forget: true, apply: true, exportPath: join(tmp, "a.json"), storage })).toBe(0);
    expect((await storage.engine().query("SELECT 1 FROM fact_withdrawals")).rows).toHaveLength(1);
    expect((await addFact(storage, { ...at, written_by: connectorFactsWriter(A) })).withdrawn).toBe(true);
  });
});
