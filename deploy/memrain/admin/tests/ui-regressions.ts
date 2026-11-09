import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "ui-fixture.tsx")], target: "browser" });
if (!bundle.success) throw new AggregateError(bundle.logs, "UI fixture build failed");
const script = await bundle.outputs[0]!.text();
let jobsCalls = 0;
let jobsFail = false;
const historyRequests: number[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/fixture.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
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
    return new Response('<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>', { headers: { "Content-Type": "text/html" } });
  },
});
const browser = await chromium.launch();
const failures: string[] = [];
async function check(name: string, view: string, body: (page: Page) => Promise<void>) {
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
} finally {
  await browser.close();
  await server.stop(true);
}
if (failures.length) throw new Error(`${failures.length} UI regressions failed: ${failures.join(", ")}`);
