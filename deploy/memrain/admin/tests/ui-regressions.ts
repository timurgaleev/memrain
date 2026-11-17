import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { chromium, type BrowserContextOptions, type Page } from "playwright";
import { account, automation, automationRoute, MICROSOFT, OWNER, scenario } from "./automation-server.ts";

// Vite's `?url` imports become plain file imports, so model files come out as hashed assets.
const viteUrls: Bun.BunPlugin = {
  name: "vite-url-imports",
  setup(build) {
    build.onResolve({ filter: /\?url$/ }, (args) => ({ path: resolve(dirname(args.importer), args.path.slice(0, -"?url".length)) }));
  },
};
// Split so the 3D scene loads through its dynamic import(), the way the real admin does.
const bundle = await Bun.build({
  entrypoints: [join(import.meta.dir, "ui-fixture.tsx")],
  target: "browser",
  splitting: true,
  publicPath: "/",
  plugins: [viteUrls],
  loader: { ".glb": "file", ".gltf": "file", ".bin": "file" },
  naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" },
});
if (!bundle.success) throw new AggregateError(bundle.logs, "UI fixture build failed");
const built = new Map(bundle.outputs.map((o) => [`/${o.path.replace(/^\.\//, "")}`, o]));
// The Office view sizes its 3D stage with the admin stylesheet.
const stylesheet = await Bun.file(join(import.meta.dir, "../src/index.css")).text();
// The CSP the server sends with the real admin (src/http/admin-static.ts).
const ADMIN_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; "
  + "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const OFFICE_SNAPSHOT = {
  workers: [
    { name: "worker", enabled: true, running: true },
    { name: "connector_sync", enabled: true, running: false },
    { name: "cycle", enabled: false, running: false },
  ],
  clients: [{ id: "client-1", display_name: "Laptop", last_seen: "2026-11-09T11:30:00Z" }],
};
const OFFICE_EVENT = { agent: "client-1", operation: "search", latency_ms: 4, status: "success", timestamp: "2026-11-09T12:00:00Z", kind: "tool", phase: "end" };
let officeCalls = 0;
let officeFailures = 0;
let jobsCalls = 0;
let jobsFail = false;
const historyRequests: number[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = built.get(path);
    if (file) return new Response(file, { headers: { "Content-Type": file.type } });
    if (path === "/admin/api/office") {
      officeCalls += 1;
      if (officeFailures > 0) {
        officeFailures -= 1;
        return Response.json({ error: "office snapshot unavailable" }, { status: 503 });
      }
      return Response.json(OFFICE_SNAPSHOT);
    }
    if (path === "/admin/events") {
      // One live event, then the stream stays open like the real feed.
      const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(OFFICE_EVENT)}\n\n`)); } });
      return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
    }
    const automated = await automationRoute(request);
    if (automated) return automated;
    if (path === "/admin/api/jobs/watch") {
      jobsCalls += 1;
      return jobsFail ? Response.json({ error: "temporary job failure" }, { status: 503 })
        : Response.json({ counts: [{ status: "succeeded", n: 2 }], recent: [] });
    }
    if (path === "/admin/api/tool") {
      const { name, arguments: args } = await request.json() as { name: string; arguments: Record<string, unknown> };
      let data: unknown;
      switch (name) {
        case "page_get": {
          const version = typeof args.version === "number" ? args.version : 2;
          if (args.version !== undefined) historyRequests.push(version);
          data = { version, page: { slug: "notes/history", title: "History fixture", markdown_body: version === 1 ? "Original historical text." : "Current replacement text." } };
          break;
        }
        case "page_versions":
          data = { versions: [{ version_n: 1, written_by: "operator", written_at: "2026-01-01T00:00:00Z" }] };
          break;
        case "get_tags": data = { tags: [] }; break;
        case "get_links": data = { groups: [] }; break;
        case "graph_neighbors": data = { neighbors: [] }; break;
        default: throw new Error(`Unexpected fixture tool: ${name}`);
      }
      return Response.json({ ok: true, data });
    }
    if (path === "/index.css") return new Response(stylesheet, { headers: { "Content-Type": "text/css" } });
    const office = new URL(request.url).searchParams.get("view") === "office";
    const csp: Record<string, string> = office ? { "Content-Security-Policy": ADMIN_CSP } : {};
    const css = office ? '<link rel="stylesheet" href="/index.css">' : "";
    return new Response(`<!doctype html>${css}<div id="root"></div><script type="module" src="/ui-fixture.js"></script>`, { headers: { "Content-Type": "text/html", ...csp } });
  },
});
// Software WebGL, so the Office scene draws without a GPU.
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const failures: string[] = [];
interface CheckOptions {
  // Real timers: the 3D scene needs real animation frames to draw.
  realClock?: boolean;
  viewport?: BrowserContextOptions["viewport"];
  noWebGL?: boolean;
}
// Keeps the drawn frame readable after it reaches the screen, for the paint check only.
const KEEP_FRAME = () => {
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, attrs?: object) {
    return getContext.call(this, type, type.startsWith("webgl") ? { ...attrs, preserveDrawingBuffer: true } : attrs);
  } as typeof getContext;
};
const NO_WEBGL = () => {
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, attrs?: object) {
    return /webgl/.test(type) ? null : getContext.call(this, type, attrs);
  } as typeof getContext;
};
async function check(name: string, view: string, body: (page: Page) => Promise<void>, opts: CheckOptions = {}) {
  const page = await browser.newPage(opts.viewport ? { viewport: opts.viewport } : {});
  page.setDefaultTimeout(2000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await page.addInitScript(opts.noWebGL ? NO_WEBGL : KEEP_FRAME);
    if (!opts.realClock) await page.clock.install({ time: new Date("2026-11-09T12:00:00Z") });
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
// Some part of the middle of the WebGL canvas holds a drawn, non-transparent pixel.
async function waitForPaint(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const c = document.querySelector<HTMLCanvasElement>(".office-canvas-box canvas");
    const gl = c?.getContext("webgl2");
    if (!c || !gl || c.width < 64 || c.height < 64) return false;
    const px = new Uint8Array(64 * 64 * 4);
    gl.readPixels((c.width >> 1) - 32, (c.height >> 1) - 32, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let drawn = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i]! > 0) drawn++;
    return drawn > 64 * 64 * 0.5;
  }, undefined, { polling: 250, timeout: 30_000 });
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
  await check("Jobs Watch pauses while hidden and catches up once", "jobs", async (page) => {
    await page.getByText("succeeded", { exact: true }).waitFor();
    const before = jobsCalls;
    await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await page.clock.runFor(31_000);
    assert.equal(jobsCalls, before, "hidden tabs must not fetch jobs");
    const response = page.waitForResponse((r) => r.url().endsWith("/admin/api/jobs/watch"));
    await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange")); });
    await response;
    assert.equal(jobsCalls, before + 1);
  });
  await check("Jobs Watch preserves data on failure and clears the recovered error", "jobs", async (page) => {
    await page.getByText("succeeded", { exact: true }).waitFor();
    jobsFail = true;
    await page.clock.runFor(15_000);
    await page.getByText("temporary job failure", { exact: true }).waitFor();
    assert.equal(await page.getByText("succeeded", { exact: true }).count(), 1);
    jobsFail = false;
    const response = page.waitForResponse((r) => r.url().endsWith("/admin/api/jobs/watch"));
    await page.clock.runFor(15_000);
    await response;
    await page.waitForFunction(() => !document.querySelector(".warning-bar"));
  });
  await check("Jobs Watch aborts its request signal on unmount", "jobs", async (page) => {
    await page.getByText("succeeded", { exact: true }).waitFor();
    await page.evaluate(() => {
      const original = window.fetch;
      Object.assign(window, { fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        Object.assign(window, { latestRequestSignal: init?.signal });
        return original(input, init);
      } });
    });
    const response = page.waitForResponse((r) => r.url().endsWith("/admin/api/jobs/watch"));
    await page.clock.runFor(15_000);
    await response;
    const aborted = await page.evaluate(() => {
      const fixture = window as typeof window & { unmountFixture: () => void; latestRequestSignal?: AbortSignal };
      fixture.unmountFixture();
      return fixture.latestRequestSignal?.aborted ?? false;
    });
    assert.equal(aborted, true);
  });

  await check("Connections reconnects a needs-reconnect account with its provider, source and services", "connections", async (page) => {
    automation.reset(scenario({ accounts: [account({ status: "needs_reconnect", status_reason: "invalid_grant", enabled: true,
      notices: [{ kind: "needs_reconnect", detail: "The provider refused the stored access.", created_at: "2026-11-09T10:00:00Z" }] })] }));
    await page.getByText("Needs reconnect", { exact: true }).waitFor();
    await page.getByText("The provider refused the stored access.").waitFor();
    await page.route("https://accounts.example.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<p>Provider consent page</p>" }));
    await page.getByRole("button", { name: `Reconnect ${OWNER}` }).click();
    await page.waitForURL("https://accounts.example.test/**");
    assert.deepEqual(automation.posts, [{ path: "/admin/api/connectors/google/start", body: { source_id: "cal", services: ["calendar"], account_id: account().id } }]);
  });
  await check("An API-key account that needs a reconnect is fixed by entering its key again, not by an OAuth start", "connections", async (page) => {
    const fireflies = { id: "fireflies", services: ["fireflies"], service_kinds: { fireflies: ["meeting"] }, auth: "api_key", callback_uri: null, tenant_default: null, can_revoke: false };
    const base = scenario();
    automation.reset(scenario({
      providers: [...base.connectors.providers, fireflies],
      sources: [...base.connectors.sources, { id: "meet", kind: "meeting" }],
      accounts: [account({ provider: "fireflies", services: ["fireflies"], source_id: "meet", status: "needs_reconnect", status_reason: "auth_required",
        credential: { scopes: [], expires_at: null, granted_at: "2026-11-01T12:00:00.000Z" } })],
    }));
    await page.getByText("Needs reconnect", { exact: true }).waitFor();
    await page.getByText("Save the current Fireflies API key again", { exact: false }).waitFor();
    assert.equal(await page.getByRole("button", { name: `Reconnect ${OWNER}` }).count(), 0);
    await page.getByRole("button", { name: `Enter the Fireflies key again: ${OWNER}` }).click();
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.type), "password");
    assert.equal(await page.getByLabel("Fireflies API key").evaluate((el) => el === document.activeElement), true);
    assert.deepEqual(automation.posts, []);
  });
  await check("Disconnect waits for the exact account name, then previews and deletes what it wrote", "connections", async (page) => {
    automation.reset(scenario());
    await page.getByRole("button", { name: `Disconnect ${OWNER}` }).click();
    const dialog = page.getByRole("dialog");
    const go = dialog.getByRole("button", { name: "Disconnect", exact: true });
    assert.equal(await go.isDisabled(), true);
    await dialog.getByLabel("Type the account name to confirm").fill("owner@example");
    assert.equal(await go.isDisabled(), true);
    await dialog.getByLabel("Type the account name to confirm").fill(OWNER);
    await dialog.getByLabel(/delete everything it brought in/i).check();
    await go.click();
    await dialog.getByText("3 pages", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Delete 3 pages" }).click();
    await page.getByText(`Deleted 3 pages from ${OWNER}.`, { exact: false }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.deepEqual(automation.posts.map((p) => p.path), [
      `/admin/api/connectors/accounts/${account().id}/disconnect`,
      `/admin/api/connectors/accounts/${account().id}/delete-data`,
    ]);
    assert.deepEqual(automation.posts[1]!.body, { confirm_label: OWNER, plan_hash: "0123456789abcdef" });
  });
  await check("Escape closes the disconnect dialog and changes nothing", "connections", async (page) => {
    automation.reset(scenario());
    await page.getByRole("button", { name: `Disconnect ${OWNER}` }).click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.deepEqual(automation.posts, []);
  });
  await check("Deletions a sync run held wait for the owner to confirm them", "connections", async (page) => {
    automation.reset(scenario({ accounts: [account({ held_deletes: 2, held_items: 1 })] }));
    await page.getByText("2 deletions held", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Delete the 2 items" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete 2 items" }).click();
    await page.waitForFunction(() => !document.body.textContent?.includes("2 deletions held"));
    assert.deepEqual(automation.posts.map((p) => p.path), [`/admin/api/connectors/accounts/${account().id}/deletions/confirm`]);
  });
  await check("With connectors off, connecting waits while sync switches still work", "connections", async (page) => {
    automation.reset(scenario({ enabled: false, reason: "MEMRAIN_CONNECTORS_ENABLED is not set", accounts: [account({ status: "needs_reconnect" })] }));
    await page.getByText("MEMRAIN_CONNECTORS_ENABLED is not set", { exact: false }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Connect Google" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: `Reconnect ${OWNER}` }).isDisabled(), true);
    await page.getByRole("button", { name: `Turn sync off for ${OWNER}` }).click();
    await page.getByRole("button", { name: `Turn sync on for ${OWNER}` }).waitFor();
    assert.deepEqual(automation.posts.map((p) => p.path), [`/admin/api/connectors/accounts/${account().id}/disable`]);
  });
  await check("Connections says what is missing when nothing is set up, and recovers from a failed load", "connections", async (page) => {
    automation.reset(scenario({ providers: [], accounts: [] }));
    automation.state.failConnectors = 1;
    await page.getByText("temporarily unavailable", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Retry" }).click();
    await page.getByText("No accounts yet", { exact: false }).waitFor();
    await page.getByText("No connector providers are installed", { exact: false }).waitFor();
  });
  await check("A bring-your-own app shows the callback to register and saves its client", "connections", async (page) => {
    automation.reset(scenario({ accounts: [] }));
    await page.getByText("Use your own OAuth app").click();
    assert.equal(await page.getByLabel("Callback URL for Google", { exact: true }).inputValue(), "https://brain.example.test/admin/connectors/callback/google");
    await page.getByLabel("Client ID").fill("byo-client.apps.example.test");
    await page.getByLabel("Client secret").fill("byo-secret");
    await page.getByRole("button", { name: "Save app" }).click();
    await page.getByText("Saved", { exact: false }).waitFor();
    assert.deepEqual(automation.posts, [{ path: "/admin/api/connectors/google/client", body: { client_id: "byo-client.apps.example.test", client_secret: "byo-secret" } }]);
    assert.equal(await page.getByLabel("Client secret").inputValue(), "");
  });
  await check("The calendar picker keeps primary on and saves the chosen calendars and history window", "connections", async (page) => {
    automation.reset(scenario());
    await page.getByRole("button", { name: `Choose calendars for ${OWNER}` }).click();
    const picker = page.getByRole("group", { name: "Calendars to sync" });
    const primary = picker.getByRole("checkbox", { name: new RegExp(`^${OWNER}`) });
    await primary.waitFor();
    assert.equal(await primary.isChecked(), true);
    assert.equal(await primary.isDisabled(), true);
    assert.equal(await picker.getByRole("checkbox", { name: /^Holidays/ }).isChecked(), true);
    await picker.getByRole("checkbox", { name: /^Team/ }).check();
    await picker.getByRole("checkbox", { name: /^Holidays/ }).uncheck();
    const days = page.getByLabel("History window in days");
    assert.equal(await days.inputValue(), "90");
    await days.fill("30");
    await page.getByRole("button", { name: "Save calendars" }).click();
    await page.getByText(`Saved: 2 calendars sync for ${OWNER}`, { exact: false }).waitFor();
    assert.deepEqual(automation.posts, [{
      path: `/admin/api/connectors/accounts/${account().id}/calendars`,
      body: { calendars: ["team@group.calendar.example.test"], history_days: 30 },
    }]);
    assert.equal(await page.getByRole("group", { name: "Calendars to sync" }).count(), 0);
  });
  await check("The calendar picker refuses a history window outside 1 to 3650 days without posting", "connections", async (page) => {
    automation.reset(scenario());
    await page.getByRole("button", { name: `Choose calendars for ${OWNER}` }).click();
    await page.getByLabel("History window in days").fill("0");
    assert.equal(await page.getByRole("button", { name: "Save calendars" }).isDisabled(), true);
    await page.getByRole("button", { name: "Cancel" }).click();
    assert.deepEqual(automation.posts, []);
  });
  await check("No calendar picker while connectors are off or for an account that needs a reconnect", "connections", async (page) => {
    automation.reset(scenario({ enabled: false, reason: "MEMRAIN_CONNECTORS_ENABLED is not set" }));
    await page.getByText("Connectors are off", { exact: false }).waitFor();
    assert.equal(await page.getByRole("button", { name: `Choose calendars for ${OWNER}` }).count(), 0);
    automation.reset(scenario({ accounts: [account({ status: "needs_reconnect", needs_reconnect: true })] }));
    await page.reload();
    await page.getByText("Needs reconnect", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: `Choose calendars for ${OWNER}` }).count(), 0);
    await page.getByRole("button", { name: `Turn sync off for ${OWNER}` }).waitFor();
  });
  await check("An account shows its last run, and a Testing-mode grant near its end asks for a reconnect", "connections", async (page) => {
    automation.reset(scenario({ accounts: [account({
      grant_expiry: { granted_at: "2026-11-04T12:00:00.000Z", expires_at: "2026-11-11T12:00:00.000Z", days: 7, state: "upcoming", due_soon: true },
    })] }));
    await page.getByText("success · 49 items, 49 written", { exact: true }).waitFor();
    await page.getByText("Around 2026-11-11 if the Google app is in Testing", { exact: false }).first().waitFor();
    await page.route("https://accounts.example.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<p>Provider consent page</p>" }));
    await page.getByRole("button", { name: `Reconnect now: ${OWNER}` }).click();
    await page.waitForURL("https://accounts.example.test/**");
    assert.deepEqual(automation.posts, [{ path: "/admin/api/connectors/google/start", body: { source_id: "cal", services: ["calendar"], account_id: account().id } }]);
  });
  await check("A reconnect the Testing-mode limit caused says so", "connections", async (page) => {
    automation.reset(scenario({ accounts: [account({
      status: "needs_reconnect", status_reason: "invalid_grant", needs_reconnect: true,
      grant_expiry: { granted_at: "2026-11-01T12:00:00.000Z", expires_at: "2026-11-08T12:00:00.000Z", days: 7, state: "lapsed", due_soon: false },
    })] }));
    await page.getByText("Needs reconnect", { exact: true }).waitFor();
    await page.getByText("ends a grant 7 days after consent while its OAuth app is in Testing", { exact: false }).waitFor();
    assert.equal(await page.getByRole("button", { name: `Reconnect ${OWNER}`, exact: true }).isEnabled(), true);
  });
  await check("Microsoft offers Outlook mail or Outlook calendar, one at a time, each into a source of its kind", "connections", async (page) => {
    automation.reset(scenario({ providers: [MICROSOFT], accounts: [],
      sources: [{ id: "default", kind: "other" }, { id: "cal", kind: "calendar" }, { id: "me-mail", kind: "mailbox" }] }));
    const panel = page.getByRole("region", { name: "Microsoft" });
    const read = panel.getByRole("group", { name: "Read" });
    const mail = read.getByRole("radio", { name: "Outlook mail" });
    const calendar = read.getByRole("radio", { name: "Outlook calendar" });
    await mail.waitFor();
    assert.equal(await mail.isChecked(), true);
    assert.deepEqual(await panel.getByLabel("Into source").locator("option").allTextContents(), ["me-mail"]);
    await calendar.check();
    assert.equal(await mail.isChecked(), false);
    assert.deepEqual(await panel.getByLabel("Into source").locator("option").allTextContents(), ["cal"]);
    await page.route("https://accounts.example.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<p>Provider consent page</p>" }));
    await panel.getByRole("button", { name: "Connect Microsoft" }).click();
    await page.waitForURL("https://accounts.example.test/**");
    assert.deepEqual(automation.posts, [{ path: "/admin/api/connectors/microsoft/start", body: { source_id: "cal", services: ["outlook_calendar"] } }]);
  });
  await check("Microsoft with no mailbox source says how to register one and let agents read it", "connections", async (page) => {
    automation.reset(scenario({ providers: [MICROSOFT], accounts: [] }));
    const panel = page.getByRole("region", { name: "Microsoft" });
    await panel.getByText("No source can hold mailbox data yet", { exact: false }).waitFor();
    await panel.getByText("--kind mailbox", { exact: false }).waitFor();
    assert.equal(await panel.getByRole("button", { name: "Connect Microsoft" }).isDisabled(), true);
  });
  await check("A Microsoft own app names who can sign in, and refuses a tenant that is not one", "connections", async (page) => {
    automation.reset(scenario({ providers: [MICROSOFT], accounts: [] }));
    const panel = page.getByRole("region", { name: "Microsoft" });
    await panel.getByText("Use your own OAuth app").click();
    assert.equal(await panel.getByLabel("Callback URL for Microsoft", { exact: true }).inputValue(), MICROSOFT.callback_uri);
    await panel.getByRole("button", { name: "Copy Callback URL for Microsoft" }).waitFor();
    const who = panel.getByLabel("Who can sign in");
    assert.equal(await who.inputValue(), "common");
    await panel.getByLabel("Client ID").fill("11111111-2222-3333-4444-a55555555555");
    await panel.getByLabel("Client secret").fill("ms-secret-value");
    await who.selectOption("tenant");
    const dir = panel.getByLabel("Directory (tenant) ID or domain");
    await dir.fill("contoso");
    const save = panel.getByRole("button", { name: "Save app" });
    assert.equal(await save.isDisabled(), true);
    await panel.getByText("a directory ID like", { exact: false }).waitFor();
    await dir.fill("Contoso.onmicrosoft.com");
    await save.click();
    await page.getByText("Saved your Microsoft app", { exact: false }).waitFor();
    assert.deepEqual(automation.posts, [{
      path: "/admin/api/connectors/microsoft/client",
      body: { client_id: "11111111-2222-3333-4444-a55555555555", client_secret: "ms-secret-value", tenant: "contoso.onmicrosoft.com" },
    }]);
  });
  await check("A saved Microsoft app shows its tenant, and an audience saves as itself", "connections", async (page) => {
    automation.reset(scenario({ providers: [MICROSOFT], accounts: [],
      clients: [{ provider: "microsoft", client_id: "app-1", tenant: "organizations", updated_at: "2026-11-08T12:00:00Z" }] }));
    const panel = page.getByRole("region", { name: "Microsoft" });
    await panel.getByText("Use your own OAuth app").click();
    const savedApp = panel.locator("p", { hasText: "app-1" });
    await savedApp.waitFor();
    assert.match((await savedApp.textContent()) ?? "", /Using app-1, work or school accounts only, saved/);
    assert.equal(await panel.getByLabel("Who can sign in").inputValue(), "organizations");
    await panel.getByLabel("Who can sign in").selectOption("consumers");
    await panel.getByLabel("Client ID").fill("app-2");
    await panel.getByLabel("Client secret").fill("ms-secret-value");
    await panel.getByRole("button", { name: "Replace app" }).click();
    await page.getByText("Saved your Microsoft app", { exact: false }).waitFor();
    assert.deepEqual(automation.posts[0]!.body, { client_id: "app-2", client_secret: "ms-secret-value", tenant: "consumers" });
  });
  await check("A Microsoft account with sync off warns before 90 unused days end its access", "connections", async (page) => {
    const idle = account({
      provider: "microsoft", services: ["outlook_mail"], source_id: "me-mail", enabled: false, last_success_at: "2026-08-20T10:00:00Z", last_run: null,
      credential: { scopes: ["Mail.Read"], expires_at: null, granted_at: "2026-08-10T12:00:00.000Z" },
    });
    automation.reset(scenario({ providers: [MICROSOFT], sources: [{ id: "me-mail", kind: "mailbox" }], accounts: [idle] }));
    await page.getByText("Microsoft · Outlook mail · into", { exact: false }).waitFor();
    await page.getByText("Microsoft ends access that goes unused for 90 days", { exact: false }).waitFor();
    await page.getByText("2026-11-18", { exact: false }).first().waitFor();
    await page.route("https://accounts.example.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<p>Provider consent page</p>" }));
    await page.getByRole("button", { name: `Reconnect now: ${OWNER}` }).click();
    await page.waitForURL("https://accounts.example.test/**");
    assert.deepEqual(automation.posts, [{ path: "/admin/api/connectors/microsoft/start", body: { source_id: "me-mail", services: ["outlook_mail"], account_id: idle.id } }]);
  });
  await check("A syncing Microsoft account renews itself and shows no access deadline", "connections", async (page) => {
    automation.reset(scenario({ providers: [MICROSOFT], sources: [{ id: "me-mail", kind: "mailbox" }],
      accounts: [account({ provider: "microsoft", services: ["outlook_mail"], source_id: "me-mail" })] }));
    await page.getByText("Syncing", { exact: true }).waitFor();
    assert.equal(await page.getByText("Access ends", { exact: true }).count(), 0);
    assert.equal(await page.getByText("unused for 90 days", { exact: false }).count(), 0);
  });
  await check("Disconnecting a Microsoft account says where to remove the consent, and to pause with sync off instead", "connections", async (page) => {
    automation.reset(scenario({ providers: [MICROSOFT], sources: [{ id: "me-mail", kind: "mailbox" }],
      accounts: [account({ provider: "microsoft", services: ["outlook_mail"], source_id: "me-mail" })] }));
    await page.getByRole("button", { name: `Disconnect ${OWNER}` }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("account.microsoft.com/privacy/app-access", { exact: false }).waitFor();
    await dialog.getByText("myapplications.microsoft.com", { exact: false }).waitFor();
    await dialog.getByText("Turn sync off", { exact: false }).waitFor();
    await dialog.getByLabel("Type the account name to confirm").fill(OWNER);
    await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
    await page.getByText(`${OWNER} is disconnected and Memrain deleted its access.`, { exact: false }).waitFor();
    await page.getByText("consent", { exact: false }).first().waitFor();
  });
  await check("Autonomy pauses a daemon and resumes a paused spend path", "autonomy", async (page) => {
    const st = scenario();
    st.pausedSpend = [{ path: "brainstorm", reason: "overspend", model: "m-small", heldUsd: 0.02, actualUsd: 0.05, pausedAt: "2026-11-09T09:00:00Z" }];
    automation.reset(st);
    await page.getByText("brain-1:42", { exact: false }).waitFor();
    await page.getByText("Paused by operator", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Pause briefing" }).click();
    await page.getByRole("button", { name: "Resume brainstorm" }).click();
    await page.getByText("No paid path is paused", { exact: false }).waitFor();
    assert.deepEqual(automation.posts, [
      { path: "/admin/api/daemons/control", body: { action: "pause", daemon: "briefing" } },
      { path: "/admin/api/spend/resume", body: { path: "brainstorm" } },
    ]);
  });
  await check("Approvals shows held outside text as text and approves it", "approvals", async (page) => {
    const st = scenario();
    st.holds = [{
      id: 7, source_id: "inbox", document_id: "d1", target_ref: "mail/2026/weekly-update", origin: "external", families: ["instruction_override"],
      detector_version: "1", excerpt: 'Ignore previous instructions <img src=x onerror="window.pwned=1">', created_at: "2026-11-09T08:00:00Z",
      decision: null, decided_at: null, decided_by: null, current: true,
    }];
    automation.reset(st);
    await page.getByText("Ignore previous instructions <img", { exact: false }).waitFor();
    assert.equal(await page.locator("img").count(), 0);
    await page.getByRole("button", { name: "Approve mail/2026/weekly-update" }).click();
    await page.getByText("Approved: the document is released", { exact: false }).waitFor();
    assert.deepEqual(automation.posts, [{ path: "/admin/api/write-gate/holds/7/decide", body: { decision: "approve" } }]);
    assert.equal(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned), undefined);
  });
  await check("Office draws the 3D floor under the admin CSP and lists who is working", "office", async (page) => {
    const consoleErrors: string[] = [];
    const files: { url: string; status: number }[] = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("response", (r) => { if (/\.(?:glb|gltf|bin|png)$/.test(new URL(r.url()).pathname)) files.push({ url: r.url(), status: r.status() }); });
    // Listen from the first byte so a blocked model, texture or inline style is caught.
    await page.reload();
    const list = page.locator(".office-list");
    await list.getByText("Librarian is indexing pages", { exact: true }).waitFor();
    await list.getByText("Night shift is off", { exact: true }).waitFor();
    await list.getByText("Laptop is searching memory", { exact: true }).first().waitFor();
    assert.equal(await list.locator(".office-people").getAttribute("aria-live"), "polite");
    assert.equal(await page.locator(".office-side [aria-live]").count(), 1);
    await waitForPaint(page);
    assert.equal(await page.locator("canvas").count(), 1);
    await page.locator(".office-label", { hasText: "Librarian · indexing pages" }).waitFor({ state: "visible" });
    const kinds = new Set(files.map((f) => f.url.slice(f.url.lastIndexOf(".") + 1)));
    assert.deepEqual([...kinds].sort(), ["bin", "glb", "gltf", "png"]);
    for (const f of files) {
      assert.equal(f.url.startsWith(`${server.url}assets/`), true, `${f.url} is not a same-origin assets/ file`);
      assert.equal(f.status, 200, f.url);
    }
    assert.equal(officeCalls > 0, true);
    assert.deepEqual(consoleErrors, []);
  }, { realClock: true });
  await check("Office without WebGL says so and keeps the list", "office", async (page) => {
    await page.getByText("Your browser cannot show the 3D office. The list on the right shows the same activity.", { exact: true }).waitFor();
    await page.locator(".office-list").getByText("Librarian is indexing pages", { exact: true }).waitFor();
    assert.equal(await page.locator("canvas").count(), 0);
  }, { noWebGL: true });
  await check("Office fits a 390 px phone without sideways scrolling", "office", async (page) => {
    await waitForPaint(page);
    const fit = await page.evaluate(() => ({
      canvas: document.querySelector(".office-canvas-box canvas")!.getBoundingClientRect().width,
      page: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    assert.equal(fit.viewport, 390);
    assert.equal(fit.canvas <= 390, true, `canvas is ${fit.canvas}px wide`);
    assert.equal(fit.page <= 390, true, `page scrolls to ${fit.page}px`);
  }, { realClock: true, viewport: { width: 390, height: 844 } });
  await check("Office retries a failed first snapshot well before the next poll", "office", async (page) => {
    officeFailures = 1;
    await page.reload();
    await page.getByText("office snapshot unavailable", { exact: true }).waitFor();
    await page.clock.runFor(5_000);
    await page.locator(".office-list").getByText("Librarian is indexing pages", { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector(".warning-bar"));
  }, { noWebGL: true });
  await check("Approvals with nothing held says so", "approvals", async (page) => {
    automation.reset(scenario());
    await page.getByText("Nothing is waiting", { exact: false }).waitFor();
  });
} finally {
  await browser.close();
  await server.stop(true);
}
if (failures.length) throw new Error(`${failures.length} UI regressions failed: ${failures.join(", ")}`);
