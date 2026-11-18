import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The member app at /app: a second entry (app.html) built into dist-app, with
// none of the operator's pages. It reuses the Ask page's components from
// src/chat as they are; at build time their calls are pointed at the member's
// own routes: every "/admin/api/" in a src/chat module becomes "/app/api/"
// (the /app router serves the same chat paths under the member's grant), and
// the operator's tool client they import is replaced by src/app/chat-tool.ts.
const CHAT_DIR = fileURLToPath(new URL("./src/chat/", import.meta.url));
const OPERATOR_API = fileURLToPath(new URL("./src/api.ts", import.meta.url));
const MEMBER_TOOL = fileURLToPath(new URL("./src/app/chat-tool.ts", import.meta.url));

function memberChat(): Plugin {
  return {
    name: "memrain-member-chat",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || !importer.startsWith(CHAT_DIR)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved?.id === OPERATOR_API ? MEMBER_TOOL : null;
    },
    transform(code, id) {
      if (!id.startsWith(CHAT_DIR)) return null;
      return code.includes("/admin/api/") ? { code: code.replaceAll("/admin/api/", "/app/api/"), map: null } : null;
    },
  };
}

export default defineConfig({
  plugins: [memberChat(), react()],
  base: "/app/",
  build: {
    outDir: "dist-app",
    emptyOutDir: true,
    // The CSP (img-src 'self') rejects data: URIs, as in the admin build.
    assetsInlineLimit: 0,
    manifest: true,
    rollupOptions: { input: fileURLToPath(new URL("./app.html", import.meta.url)) },
  },
});
