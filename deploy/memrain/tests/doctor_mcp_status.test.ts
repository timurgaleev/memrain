/**
 * The MCP `run_doctor` tool reports the same three-state verdict the CLI does.
 *
 * The tool used to repeat the CLI's bug in miniature: its ops-probe loop caught
 * a throwing probe into `{ok:true, <error text>}`, so an agent asking the brain
 * how it was doing could not tell "checked, healthy" from "could not check".
 * Drives the real dispatchTool over PGLite; hiding a table is what makes the
 * catch arm reachable at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

interface DoctorPayload {
  ok: boolean;
  status: "ok" | "warn" | "fail";
  checks: { name: string; ok: boolean; status: string; detail: string }[];
}

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-doctor-mcp-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function runDoctorTool(): Promise<DoctorPayload> {
  const r = await dispatchTool(storage, { name: "run_doctor", arguments: {} }, {});
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as DoctorPayload;
}

describe("MCP run_doctor", () => {
  it("rolls the worst check up into a status beside ok", async () => {
    const payload = await runDoctorTool();
    expect(payload.ok).toBe(true);
    expect(["ok", "warn", "fail"]).toContain(payload.status);
    for (const c of payload.checks) {
      expect(["ok", "warn", "fail"]).toContain(c.status);
      expect(c.ok).toBe(c.status !== "fail");
    }
  });

  it("runs the connector-health probe the CLI doctor runs", async () => {
    const payload = await runDoctorTool();
    const c = payload.checks.find((x) => x.name === "connector-health");
    expect(c).toMatchObject({ ok: true, status: "ok", detail: "no connector account and no connector has run" });
  });

  it("reports an unreadable ops probe as a warn, not as a pass", async () => {
    await storage.engine().query("ALTER TABLE cycle_locks RENAME TO cycle_locks_hidden");
    const payload = await runDoctorTool();
    const c = payload.checks.find((x) => x.name === "stale-locks")!;
    expect(c.status).toBe("warn");
    expect(c.detail).toStartWith("could not check stale-locks: ");
    // Still ok:true — one unreadable probe must not make a serving brain look
    // broken to the agent — but the roll-up no longer claims an all-clear.
    expect(c.ok).toBe(true);
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe("warn");
  });
});
