/**
 * The member app's built page (admin/dist-app) served under /app with the
 * admin panel's headers: the same CSP, no framing, passkeys only in this
 * document. Any non-asset path is the SPA (the invite link included), only
 * manifest-listed files are cached for a year, and nothing outside the dist
 * is ever served. Off (MEMRAIN_APP unset) every /app path is 404.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveAppStatic } from "../src/http/app-static.ts";
import { handleApp } from "../src/http/app.ts";
import { Storage } from "../src/core/storage.ts";

let dist: string;
let tmp: string;
let storage: Storage;
const savedApp = process.env["MEMRAIN_APP"];

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), "memrain-dist-app-"));
  mkdirSync(join(dist, "assets"));
  mkdirSync(join(dist, ".vite"));
  writeFileSync(join(dist, "app.html"), "<!doctype html><title>memrain</title><div id=root></div>");
  writeFileSync(join(dist, "assets", "app-abc123.js"), "console.log(1)");
  writeFileSync(join(dist, "assets", "loose.js"), "console.log(2)");
  writeFileSync(join(dist, ".vite", "manifest.json"), JSON.stringify({ "app.html": { file: "assets/app-abc123.js" } }));
  tmp = mkdtempSync(join(tmpdir(), "memrain-app-static-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterAll(async () => {
  await storage.close();
  rmSync(dist, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => {
  if (savedApp === undefined) delete process.env["MEMRAIN_APP"];
  else process.env["MEMRAIN_APP"] = savedApp;
});

const get = (path: string) => serveAppStatic(new URL(`https://acme.example.test${path}`), dist);

describe("serveAppStatic", () => {
  it("serves the page for /app, /app/ and any route, the invite link included", async () => {
    for (const p of ["/app", "/app/", "/app/invite", "/app/login"]) {
      const r = (await get(p))!;
      expect({ p, status: r.status }).toEqual({ p, status: 200 });
      expect(await r.text()).toContain('<div id=root>');
      expect(r.headers.get("cache-control")).toBe("no-cache");
    }
  });

  it("carries the admin panel's security headers", async () => {
    const r = (await get("/app"))!;
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("permissions-policy")).toContain("publickey-credentials-get=(self)");
  });

  it("caches only the hashed assets the manifest lists", async () => {
    expect((await get("/app/assets/app-abc123.js"))!.headers.get("cache-control")).toContain("immutable");
    expect((await get("/app/assets/loose.js"))!.headers.get("cache-control")).toBe("no-cache");
  });

  it("never serves outside the dist", async () => {
    const r = (await get("/app/assets/..%2f..%2f..%2fetc%2fpasswd"))!;
    expect(r.status === 403 || (await r.text()).includes("<div id=root>")).toBe(true);
    expect(await serveAppStatic(new URL("https://acme.example.test/app"), join(dist, "missing"))).toBeNull();
  });
});

describe("through the /app router", () => {
  it("is 404 while MEMRAIN_APP is off", async () => {
    delete process.env["MEMRAIN_APP"];
    const req = new Request("https://acme.example.test/app/");
    expect((await handleApp(req, new URL(req.url), { storage }))!.status).toBe(404);
  });

  it("answers a page GET without a session, and an API GET still needs one", async () => {
    process.env["MEMRAIN_APP"] = "1";
    const page = new Request("https://acme.example.test/app/");
    const res = (await handleApp(page, new URL(page.url), { storage }))!;
    // 200 with a built dist-app, 404 without one: never 401, the page signs in itself.
    expect([200, 404]).toContain(res.status);
    const api = new Request("https://acme.example.test/app/api/onboarding");
    expect((await handleApp(api, new URL(api.url), { storage }))!.status).toBe(401);
    const post = new Request("https://acme.example.test/app/", { method: "POST" });
    expect((await handleApp(post, new URL(post.url), { storage }))!.status).toBe(404);
  });
});
