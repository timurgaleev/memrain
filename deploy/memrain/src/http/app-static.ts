/**
 * Serve the built member app at /app: the second Vite entry of admin/
 * (`bun run build:app` → admin/dist-app, entry app.html), with the admin
 * panel's rules (http/admin-static.ts): same CSP and headers, hashed assets
 * cached for a year, every other path answered with the page itself, and
 * nothing outside the dist. Null when the build is missing.
 */
import { fileURLToPath } from "node:url";
import { serveAdminStatic } from "./admin-static.ts";

const DIST_APP_DIR = fileURLToPath(new URL("../../admin/dist-app", import.meta.url));

export function serveAppStatic(url: URL, distDir: string = DIST_APP_DIR): Promise<Response | null> {
  return serveAdminStatic(url, distDir, { mount: "/app", index: "app.html" });
}
