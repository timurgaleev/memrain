/**
 * Admin SPA static serve (increment C). Serves the built admin/dist at /admin
 * with an index.html SPA fallback. Relies on the dist produced by
 * `cd admin && bun run build` (run in CI/local before this test).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveAdminStatic } from "../src/http/admin-static.ts";

const distExists = existsSync(fileURLToPath(new URL("../admin/dist/index.html", import.meta.url)));

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
  "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function expectSecurityHeaders(r: Response | null): void {
  expect(r).not.toBeNull();
  expect(r!.headers.get("Content-Security-Policy")).toBe(CSP);
  expect(r!.headers.get("X-Frame-Options")).toBe("DENY");
  expect(r!.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(r!.headers.get("Referrer-Policy")).toBe("no-referrer");
}

describe.if(distExists)("serveAdminStatic (dist built)", () => {
  it("serves index.html for /admin/ and the bare /admin", async () => {
    for (const p of ["/admin/", "/admin"]) {
      const r = await serveAdminStatic(new URL(`http://h${p}`));
      expect(r?.status).toBe(200);
      expect(r!.headers.get("Content-Type")).toContain("text/html");
      expect(await r!.text()).toContain("<div id=\"root\">");
    }
  });

  it("falls back to index.html for an unknown SPA route (client-side routing)", async () => {
    const r = await serveAdminStatic(new URL("http://h/admin/dashboard"));
    expect(r?.status).toBe(200);
    expect(r!.headers.get("Content-Type")).toContain("text/html");
  });

  it("serves a real built asset with the right mime", async () => {
    // Discover a hashed asset from the built index.html.
    const index = await (await serveAdminStatic(new URL("http://h/admin/")))!.text();
    const m = index.match(/\/admin\/(assets\/[^"']+\.css)/);
    expect(m).not.toBeNull();
    const r = await serveAdminStatic(new URL(`http://h/admin/${m![1]}`));
    expect(r?.status).toBe(200);
    expect(r!.headers.get("Content-Type")).toContain("text/css");
  });

  it("blocks path traversal out of dist", async () => {
    const r = await serveAdminStatic(new URL("http://h/admin/assets/..%2f..%2f..%2fetc%2fpasswd"));
    // Either a 403 (traversal guard) or the SPA fallback — never the host file.
    if (r && r.status !== 403) {
      expect(r.headers.get("Content-Type")).toContain("text/html");
    } else {
      expect(r?.status).toBe(403);
    }
  });
});

// Runs against a throwaway dist so the headers stay covered in a checkout
// that has never built the SPA.
describe("serveAdminStatic security headers", () => {
  let dist = "";
  const serve = (path: string) => serveAdminStatic(new URL(`http://h${path}`), dist);

  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), "admin-dist-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><div id=\"root\"></div>");
    writeFileSync(join(dist, "assets", "app.css"), "body{}");
    writeFileSync(join(dist, "assets", "app.js"), "void 0;");
  });
  afterAll(() => rmSync(dist, { recursive: true, force: true }));

  it("sets the CSP and framing headers on every response path", async () => {
    for (const p of ["/admin", "/admin/dashboard", "/admin/assets/missing-asset.js", "/admin/assets/app.css", "/admin/assets/app.js"]) {
      const r = await serve(p);
      expect(r?.status).toBe(200);
      expectSecurityHeaders(r);
    }
  });

  it("sets the headers on the traversal refusal too", async () => {
    const r = await serve("/admin/assets/..%2f..%2f..%2fetc%2fpasswd");
    expectSecurityHeaders(r);
  });

  it("allows passkey ceremonies in this document only, and leaves the CSP as it was", async () => {
    for (const p of ["/admin/", "/admin/assets/app.js"]) {
      const r = await serve(p);
      expect(r!.headers.get("Permissions-Policy")).toBe(
        "publickey-credentials-get=(self), publickey-credentials-create=(self)",
      );
      expect(r!.headers.get("Content-Security-Policy")).toBe(CSP);
    }
  });
});

describe.if(distExists)("serveAdminStatic built index.html", () => {
  it("built index.html loads no third-party fonts and no inline script", async () => {
    const html = await (await serveAdminStatic(new URL("http://h/admin/")))!.text();
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("fonts.gstatic.com");
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag).toMatch(/\ssrc=/);
  });
});

describe.if(!distExists)("serveAdminStatic (dist NOT built)", () => {
  it("returns null when the dist is absent (caller 404s)", async () => {
    expect(await serveAdminStatic(new URL("http://h/admin/"))).toBeNull();
  });
});
