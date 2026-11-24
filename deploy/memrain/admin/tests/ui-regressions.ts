import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const bundle = await Bun.build({
  entrypoints: [join(import.meta.dir, "ui-fixture.tsx")],
  target: "browser",
  publicPath: "/",
  naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" },
});
if (!bundle.success) throw new AggregateError(bundle.logs, "UI fixture build failed");
const built = new Map(bundle.outputs.map((o) => [`/${o.path.replace(/^\.\//, "")}`, o]));
// The palette and the page view render with the admin stylesheet.
const stylesheet = await Bun.file(join(import.meta.dir, "../src/index.css")).text();
// The CSP the server sends with the real admin (src/http/admin-static.ts).
const ADMIN_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; "
  + "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const GRANT = {
  client_id: "client-1", client_name: "Laptop", profile: "writer", revision: 3, source_id: "default",
  federated_read: ["default"], bound_slug_prefixes: null, tenant_mode: "client", scopes: ["read", "write"],
  tool_surface: "starter", budget_usd_per_day: 2, min_trust: "member",
};
// A source name that would run script if the editor rendered it as HTML.
const HOSTILE_SOURCE = "<img src=x onerror=alert(1)>";
const GRANT_FIELD: Record<string, string> = {
  source: "source_id", read: "federated_read", bound_slug_prefixes: "bound_slug_prefixes", scopes: "scopes",
  tool_surface: "tool_surface", budget_usd_per_day: "budget_usd_per_day", min_trust: "min_trust",
};
const grantApplies: Record<string, unknown>[] = [];
const historyRequests: number[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = built.get(path);
    if (file) return new Response(file, { headers: { "Content-Type": file.type } });
    if (path === "/admin/api/client-grant") {
      return Response.json({ grant: GRANT, sources: [{ id: "default", name: "default", federated: true }, { id: "acme", name: HOSTILE_SOURCE, federated: false }] });
    }
    if (path === "/admin/api/rescope-client") {
      const body = await request.json() as Record<string, unknown>;
      if (body.dry_run !== true) {
        grantApplies.push(body);
        return Response.json({ error: "grant_conflict", expected: 3, actual: 4 }, { status: 409 });
      }
      const after: Record<string, unknown> = { ...GRANT };
      const changed: string[] = [];
      for (const [k, field] of Object.entries(GRANT_FIELD)) {
        if (k in body) { after[field] = body[k]; changed.push(field); }
      }
      return Response.json({
        ok: true, dry_run: true, revision: 3, plan_hash: "f".repeat(64), before: GRANT, after, changed,
        widens: changed.includes("tool_surface") ? ["tool_surface"] : [],
        revoked_unbound: { access_tokens: 0, refresh_tokens: 0, codes: 0 },
      });
    }
    if (path === "/admin/api/tool") {
      const { name, arguments: args } = await request.json() as { name: string; arguments: Record<string, unknown> };
      let data: unknown;
      switch (name) {
        case "page_get": {
          const version = typeof args.version === "number" ? args.version : 2;
          if (args.version !== undefined) historyRequests.push(version);
          if (args.slug === "notes/blocks") {
            data = { version, page: { slug: "notes/blocks", title: "Blocks", markdown_body: "The first paragraph ends **here**\n\nand the second one starts." } };
            break;
          }
          data = { version, page: { slug: "notes/history", title: "History fixture", markdown_body: version === 1 ? "Original historical text." : "Current replacement text." } };
          break;
        }
        case "page_versions":
          data = { versions: [{ version_n: 1, written_by: "operator", written_at: "2026-01-01T00:00:00Z" }] };
          break;
        case "get_tags": data = { tags: [] }; break;
        case "get_links": data = { groups: [] }; break;
        case "resolve_slugs": data = { hits: [] }; break;
        case "search": data = { hits: [] }; break;
        default: throw new Error(`Unexpected fixture tool: ${name}`);
      }
      return Response.json({ ok: true, data });
    }
    if (path === "/index.css") return new Response(stylesheet, { headers: { "Content-Type": "text/css" } });
    const styled = ["page", "palette"].includes(new URL(request.url).searchParams.get("view") ?? "");
    const csp: Record<string, string> = styled ? { "Content-Security-Policy": ADMIN_CSP } : {};
    const css = styled ? '<link rel="stylesheet" href="/index.css">' : "";
    return new Response(`<!doctype html>${css}<div id="root"></div><script type="module" src="/ui-fixture.js"></script>`, { headers: { "Content-Type": "text/html", ...csp } });
  },
});
const browser = await chromium.launch();
const failures: string[] = [];
// UI_FILTER=<text> runs only the checks whose name contains it.
const only = process.env.UI_FILTER ?? "";
async function check(name: string, view: string, body: (page: Page) => Promise<void>) {
  if (only !== "" && !name.includes(only)) return;
  const page = await browser.newPage();
  page.setDefaultTimeout(2000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.clock.install({ time: new Date("2026-11-09T12:00:00Z") });
    await page.goto(`${server.url}?view=${view}`);
    await body(page);
    assert.deepEqual(pageErrors, []);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await page.close();
  }
}
try {
  await check("View loads the selected historical body without requesting all snapshots", "history", async (page) => {
    await page.getByText("Current replacement text.").waitFor();
    assert.deepEqual(historyRequests, []);
    await page.getByRole("button", { name: "View", exact: true }).click();
    await page.locator(".version-body").getByText("Original historical text.").waitFor();
    assert.deepEqual(historyRequests, [1]);
    await page.getByRole("button", { name: "Hide", exact: true }).click();
    assert.equal(await page.locator(".version-body").count(), 0);
  });
  await check("A quoted passage that runs across two paragraphs is highlighted across both", "page#page/notes%2Fblocks?q=paragraph%20ends%20here%20and%20the%20second", async (page) => {
    await page.getByText("and the second one starts.").waitFor();
    const marked = await page.waitForFunction(() => {
      const h = CSS.highlights.get("cite-quote");
      return h && h.size === 1 ? [...h][0]!.toString() : null;
    });
    assert.equal(await marked.jsonValue(), "paragraph ends hereand the second");
  });
  await check("With no hits, Enter in the palette still opens full search", "palette", async (page) => {
    const input = page.getByRole("dialog").getByRole("combobox");
    await input.fill("offsite dates");
    await page.getByText("No other hits.").waitFor();
    assert.equal(await page.locator(".cmdk-row.active").count(), 0);
    await input.press("Enter");
    await page.waitForFunction(() => location.hash === "#search/offsite%20dates");
  });
  await check("Grant editor previews only changed rows, drops the preview on edit and locks after a 409", "grant", async (page) => {
    await page.getByLabel("Tool surface").selectOption("full");
    await page.getByRole("button", { name: "Preview changes" }).click();
    const rows = page.locator("tbody tr");
    await rows.first().waitFor();
    assert.equal(await rows.count(), 1);
    assert.deepEqual(await rows.first().locator("th, td").allTextContents(), ["Tool surface", "starter", "full"]);
    await page.getByText("applying needs passkey confirmation", { exact: false }).waitFor();
    // Any edit after a preview discards it.
    await page.getByLabel("Daily budget (USD)").fill("3");
    assert.equal(await page.locator("tbody tr").count(), 0);
    await page.getByRole("button", { name: "Preview changes" }).click();
    await page.getByRole("button", { name: "Apply reviewed changes" }).click();
    await page.getByRole("button", { name: "Reload current grant" }).waitFor();
    assert.equal(await page.getByLabel("Tool surface").isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Preview changes" }).isDisabled(), true);
    // The apply sends the partial change, the revision and the hash; never a snapshot.
    assert.deepEqual(grantApplies, [{ client_id: "client-1", tool_surface: "full", budget_usd_per_day: 3, expected_revision: 3, plan_hash: "f".repeat(64) }]);
    // Names render as text.
    await page.getByText(HOSTILE_SOURCE, { exact: true }).waitFor();
    assert.equal(await page.locator("img").count(), 0);
    const source = await Bun.file(join(import.meta.dir, "../src/components/ClientGrant.tsx")).text();
    assert.equal(source.includes("dangerouslySetInnerHTML"), false);
  });
} finally {
  await browser.close();
  await server.stop(true);
}
if (failures.length) throw new Error(`${failures.length} UI regressions failed: ${failures.join(", ")}`);
