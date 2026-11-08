import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

let db: Awaited<ReturnType<ReturnType<typeof storageEngines>[number]["open"]>>;
beforeAll(async () => { db = await storageEngines(undefined)[0]!.open(); });
afterAll(async () => { await db.close(); });

describe("MCP reader database failures", () => {
  for (const [name, table, args] of [
    ["list_concepts", "synth_concepts", {}],
    ["list_takes", "synth_takes", {}],
    ["takes_search", "synth_takes", { q: "claim" }],
    ["takes_scorecard", "synth_takes", {}],
    ["takes_calibration", "synth_takes", {}],
    ["get_calibration_profile", "synth_calibration_profile", {}],
    ["find_contradictions", "synth_contradictions", {}],
    ["get_recent_transcripts", "FROM pages", {}],
  ] as const) {
    it(`${name} reports timeout instead of a clean empty result`, async () => {
      const e = db.storage.engine();
      const original = e.query.bind(e);
      const query = spyOn(e, "query").mockImplementation(async (sql, params) => {
        if (sql.includes(table)) throw Object.assign(new Error("sensitive database detail"), { code: "57014" });
        return original(sql, params);
      });
      try {
        const r = await dispatchTool(db.storage, { name, arguments: args });
        expect(r.isError).toBe(true);
        expect(JSON.parse(r.content[0]!.text)).toMatchObject({ error: "db_timeout", sqlstate: "57014", retryable: true });
        expect(r.content[0]!.text).not.toContain("sensitive database detail");
      } finally { query.mockRestore(); }
    });
  }

  for (const code of ["55P03", "40P01", "40001", "53300", "08006"]) {
    it(`returns retryable db_busy for SQLSTATE ${code}, including public ingress`, async () => {
      const e = db.storage.engine();
      const original = e.query.bind(e);
      const query = spyOn(e, "query").mockImplementation(async (sql, params) => {
        if (sql.includes("FROM pages")) throw Object.assign(new Error("sensitive database detail"), { code });
        return original(sql, params);
      });
      try {
        const r = await dispatchTool(db.storage, { name: "page_list", arguments: {} }, { isPublic: true });
        expect(r.isError).toBe(true);
        expect(JSON.parse(r.content[0]!.text)).toMatchObject({ error: "db_busy", sqlstate: code, retryable: true });
        expect(r.content[0]!.text).not.toContain("sensitive database detail");
      } finally { query.mockRestore(); }
    });
  }
});
