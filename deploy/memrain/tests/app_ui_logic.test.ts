/**
 * The member app's DOM-free logic (admin/src/app) and its bundle gate
 * (admin/scripts/check-app-bundle.ts).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAppHash, takeInviteFromUrl } from "../admin/src/app/route.ts";
import { keySetups } from "../admin/src/app/commands.ts";
import { problemsIn } from "../admin/scripts/check-app-bundle.ts";

const TOKEN = "A".repeat(20) + "-_" + "b".repeat(21);
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("invite link", () => {
  it("takes the token from the fragment of /app/invite only", () => {
    expect(takeInviteFromUrl({ pathname: "/app/invite", hash: `#${TOKEN}` })).toBe(TOKEN);
    expect(takeInviteFromUrl({ pathname: "/app/invite/", hash: `#/${TOKEN}` })).toBe(TOKEN);
    expect(takeInviteFromUrl({ pathname: "/app/", hash: `#${TOKEN}` })).toBeNull();
    expect(takeInviteFromUrl({ pathname: "/app/invite", hash: "#short" })).toBeNull();
    expect(takeInviteFromUrl({ pathname: "/app/invite", hash: "" })).toBeNull();
  });
});

describe("hash routes", () => {
  it("knows its own pages and sends anything else to the start page", () => {
    expect(parseAppHash("#ask/abc")).toEqual({ name: "ask", param: "abc" });
    expect(parseAppHash("#data")).toEqual({ name: "data", param: null });
    expect(parseAppHash("#login")).toEqual({ name: "login", param: null });
    expect(parseAppHash("#overview")).toEqual({ name: "start", param: null });
    expect(parseAppHash("")).toEqual({ name: "start", param: null });
    expect(parseAppHash("#ask/%E0%A4%A")).toEqual({ name: "ask", param: null });
  });
});

describe("client setup", () => {
  it("names the URL and the key for every client", () => {
    const key = `memrain_${"ab".repeat(32)}`;
    const setups = keySetups("https://acme.example.test/mcp", key);
    expect(setups.map((s) => s.client)).toEqual(["Claude Code", "Codex", "Cursor"]);
    for (const s of setups) {
      expect(s.text).toContain("https://acme.example.test/mcp");
      expect(s.text).toContain(key);
    }
    expect(JSON.parse(setups[2]!.text).mcpServers.memrain.headers.Authorization).toBe(`Bearer ${key}`);
  });
});

describe("bundle gate", () => {
  function dist(js: string, manifest: Record<string, unknown>): string {
    const d = mkdtempSync(join(tmpdir(), "memrain-dist-check-"));
    dirs.push(d);
    mkdirSync(join(d, "assets"));
    mkdirSync(join(d, ".vite"));
    writeFileSync(join(d, "assets", "app.js"), js);
    writeFileSync(join(d, ".vite", "manifest.json"), JSON.stringify(manifest));
    return d;
  }

  it("passes a member-only bundle", () => {
    expect(problemsIn(dist(`fetch("/app/api/chat")`, { "app.html": { file: "assets/app.js", src: "app.html" } }))).toEqual([]);
  });

  it("refuses an operator route or an operator module", () => {
    expect(problemsIn(dist(`fetch("/admin/api/chat")`, {}))).toEqual(["assets/app.js names /admin/"]);
    expect(problemsIn(dist("", { "src/pages/Overview.tsx": { file: "assets/o.js", src: "src/pages/Overview.tsx" } })))
      .toEqual(["manifest bundles src/pages/Overview.tsx"]);
  });
});
