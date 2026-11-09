import { afterAll, beforeAll, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { dispatchTool, type DispatchOptions } from "../src/mcp/dispatch.ts";

let db: Awaited<ReturnType<ReturnType<typeof storageEngines>[number]["open"]>>;
let priorMirror: string | undefined;
const authInfo = { clientId: "reason-owner", scopes: ["read", "write"], sourceId: "default", allowedSources: ["default"] } as DispatchOptions["authInfo"];
beforeAll(async () => { db = await storageEngines(undefined)[0]!.open(); priorMirror = process.env.MEMRAIN_PAGE_MIRROR_SYNC; process.env.MEMRAIN_PAGE_MIRROR_SYNC = "0"; });
afterAll(async () => { if (priorMirror === undefined) delete process.env.MEMRAIN_PAGE_MIRROR_SYNC; else process.env.MEMRAIN_PAGE_MIRROR_SYNC = priorMirror; await db.close(); });
async function call(name: string, args: Record<string, unknown>, opts: DispatchOptions = { authInfo }) {
  const result = await dispatchTool(db.storage, { name, arguments: args }, opts);
  expect(result.isError, result.content[0]!.text).toBeFalsy();
  return JSON.parse(result.content[0]!.text);
}
it("records reasons for actual put/edit/revert/delete versions over MCP", async () => {
  const slug = "notes/reason-mcp";
  await call("page_put", { slug, markdown_body: "Body first", reason: "initial" });
  await call("page_edit", { slug, expected_version: 1, edits: [{ old_text: "first", new_text: "second" }], reason: "correction" });
  await call("page_revert", { slug, version: 1, expected_version: 2, reason: "restore source" });
  await call("page_delete", { slug, expected_version: 3, reason: "retire" });
  const history = await call("page_versions", { slug });
  expect(history.versions.map((row: { change_reason: string }) => row.change_reason)).toEqual(["retire", "restore source", "correction", "initial"]);
  expect(history.versions.every((row: Record<string, unknown>) => row.body_snapshot === undefined)).toBe(true);
});
it("withholds free-text reasons on public and quarantined remote history reads", async () => {
  const slug = "notes/reason-private";
  await call("page_put", { slug, markdown_body: "Private source", reason: "confidential history detail" });
  const publicRead = await call("page_versions", { slug }, { isPublic: true });
  expect(JSON.stringify(publicRead)).not.toContain("confidential history detail");
  await db.storage.engine().query("INSERT INTO documents(id,source_path,source_id,frontmatter) VALUES('reason-held',$1,'default','{\"quarantine\":{\"reason\":\"junk_pattern\"}}')", [`page://${slug}`]);
  const held = await call("page_versions", { slug });
  expect(held.versions[0].notice).toBe("page_quarantined");
  expect(held.versions[0].change_reason).toBeUndefined();
  const operator = await call("page_versions", { slug }, {});
  expect(operator.versions[0].change_reason).toBe("confidential history detail");
});
