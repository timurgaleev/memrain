/**
 * An unexpected exception on a public MCP call reaches the caller as a generic
 * error plus an incident id; the operator log carries the same id next to the
 * real detail, so a report from a caller can be matched to the log line.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { makeMcpHandler } from "../src/mcp/http_transport.ts";

let db: Awaited<ReturnType<ReturnType<typeof storageEngines>[number]["open"]>>;
beforeAll(async () => { db = await storageEngines(undefined)[0]!.open(); });
afterAll(async () => { await db.close(); });

describe("public MCP incident id", () => {
  it("returns only an incident id and logs the detail under the same id", async () => {
    const e = db.storage.engine();
    const original = e.query.bind(e);
    // Assembled at runtime so the source never holds a credential-shaped URL.
    const dsn = ["postgres://memrain", "fixture-pw"].join(":") + "@db.internal:5432/brain";
    const detail = `relation "pages" broke at ${dsn}\n    at Object.query (engine.ts:42)`;
    const query = spyOn(e, "query").mockImplementation(async (sql, params) => {
      if (sql.includes("FROM pages")) throw new Error(detail);
      return original(sql, params);
    });
    const logged: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
    try {
      const handler = makeMcpHandler({ storage: db.storage });
      const res = await handler(new Request("http://x/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "page_list", arguments: {} } }),
      }), { isPublic: true });
      const body = await res.text();
      const reply = (JSON.parse(body) as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
      expect(reply.isError).toBe(true);
      const id = /\(incident ([0-9a-f]{16})\)/.exec(reply.content[0]!.text)?.[1];
      expect(id).toBeDefined();
      for (const leak of ["pages", "postgres://", "fixture-pw", "db.internal", "engine.ts", "at Object"]) expect(body).not.toContain(leak);
      const line = logged.find((l) => l.includes(`incident ${id}`));
      expect(line).toBeDefined();
      expect(line).toContain("relation \"pages\" broke");
      expect(line).not.toContain("fixture-pw");
    } finally {
      errSpy.mockRestore();
      query.mockRestore();
    }
  });
});
