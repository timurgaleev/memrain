/**
 * http/admin-static.ts — serve the built admin SPA at /admin (increment C).
 *
 * memrain runs from source (`bun run`), so it serves the built admin SPA from the
 * Vite `dist/` straight from disk. The dist is
 * produced by `cd admin && bun run build` (the Dockerfile builder stage) and
 * lives at `<repo>/deploy/memrain/admin/dist`, resolved here relative to this
 * module so it works both in the container (`/app/admin/dist`) and locally.
 *
 * Dispatched AFTER the auth routes (A1) and the data API (A2), so those win; any
 * remaining `/admin*` path serves a static asset or falls back to `index.html`
 * (SPA client-side routing via the hash router).
 */
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const DIST_DIR = fileURLToPath(new URL("../../admin/dist", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

// The SPA ships its own scripts and styles and talks only to this origin.
// React `style` props go through CSSOM, which style-src does not govern.
const ADMIN_SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot >= 0 && MIME[path.slice(dot)]) || "application/octet-stream";
}

/**
 * Serve a static asset for an `/admin` path, or the SPA `index.html` fallback.
 * Returns null only when the built dist is missing (so the caller 404s rather
 * than masking a broken build). Never serves outside the dist dir.
 */
export async function serveAdminStatic(url: URL, distDir: string = DIST_DIR): Promise<Response | null> {
  // The asset path under dist. "/admin" or "/admin/" → index.html. A real asset
  // request is "/admin/assets/<file>"; anything else is SPA-routed → index.html.
  let rel = url.pathname.slice("/admin".length).replace(/^\/+/, ""); // strip "/admin/"
  if (rel === "" || !rel.startsWith("assets/")) rel = "index.html";

  // Path-traversal guard: resolve, then check the file is genuinely INSIDE
  // the dist dir via a `relative()` boundary (a bare `startsWith` would admit a
  // sibling-prefix dir like `<dist>-backup`, codex). `../foo` or an absolute
  // result means it escaped.
  const filePath = resolve(distDir, rel);
  const rejoined = relative(distDir, filePath);
  if (rejoined.startsWith("..") || isAbsolute(rejoined)) {
    return new Response("Forbidden", { status: 403, headers: ADMIN_SECURITY_HEADERS });
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    // Asset miss → SPA fallback; index miss → the build is absent.
    if (rel === "index.html") return null;
    const index = Bun.file(resolve(distDir, "index.html"));
    if (!(await index.exists())) return null;
    return new Response(index, { headers: { ...ADMIN_SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" } });
  }
  return new Response(file, { headers: { ...ADMIN_SECURITY_HEADERS, "Content-Type": mimeFor(filePath) } });
}
