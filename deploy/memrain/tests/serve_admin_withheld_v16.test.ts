/**
 * With MEMRAIN_ADMIN_BOOTSTRAP unset and stderr not a terminal, serve withholds
 * the generated bootstrap token, but the /admin routes still mount: the boot
 * line says so, and a link minted by `memrain admin setup-link` (server
 * stopped, as PGLite requires) redeems against the running server.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const PORT = 20000 + Math.floor(Math.random() * 20000);
const ORIGIN = `http://localhost:${PORT}`;
let dir: string;
let env: Record<string, string>;
let server: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "memrain-withheld-v16-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    database: { type: "pglite", path: join(dir, "brain.pglite") },
    embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
    storage: {},
  }));
  env = {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    MEMRAIN_CONFIG_PATH: join(dir, "config.json"),
    MEMRAIN_PUBLIC_URL: ORIGIN,
  };
});
afterAll(async () => {
  if (server) {
    server.kill();
    await server.exited;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("serve with a withheld bootstrap token", () => {
  it("says passkeys and setup links still work, and a CLI-minted link redeems", async () => {
    const mint = Bun.spawnSync(["bun", CLI, "admin", "setup-link", "--json"], { env });
    expect(mint.exitCode).toBe(0);
    const token = (JSON.parse(mint.stdout.toString()) as { url: string }).url.split("#enroll/")[1]!;

    server = Bun.spawn(["bun", CLI, "serve", "--http", "--port", String(PORT)], { env, stdout: "ignore", stderr: "pipe" });
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      await Bun.sleep(250);
      up = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok, () => false);
    }
    expect(up).toBe(true);

    const redeem = await fetch(`http://127.0.0.1:${PORT}/admin/api/passkey/enroll/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ token }),
    });
    expect(redeem.status).toBe(200);
    expect(await redeem.json()).toEqual({ ok: true, expires_in: 900 });

    server.kill();
    await server.exited;
    const stderr = await new Response(server.stderr as ReadableStream).text();
    server = null;
    expect(stderr).toContain(
      "Bootstrap login is unavailable this run; passkey sign-in and setup links minted by `memrain admin setup-link` still work.",
    );
    expect(stderr).not.toContain("The admin surface is unreachable this run");
    expect(stderr).not.toContain(token);
  }, 60_000);
});
