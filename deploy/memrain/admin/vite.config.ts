import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base '/admin/' so the built asset URLs resolve under the server's /admin mount.
export default defineConfig({
  plugins: [react()],
  base: "/admin/",
  // assetsInlineLimit 0: the CSP (img-src 'self') rejects data: URIs, so the favicon must be a file.
  // manifest: the server reads dist/.vite/manifest.json to know which files carry a content hash.
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    manifest: true,
  },
});
