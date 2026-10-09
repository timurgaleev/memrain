/**
 * `memrain serve --http --host H --port N` — starts the HTTP daemon.
 *
 * Loads config (created by `init`), opens PGLite, starts the server,
 * registers SIGINT/SIGTERM for graceful shutdown.
 */
import { randomBytes } from "node:crypto";
import { Storage } from "../core/storage.ts";
import { startServer } from "../http/server.ts";
import { loadConfig, selfIssuedMismatch } from "../core/config.ts";
import { startCycleLoop, type CycleHandle } from "../recipes/cycle.ts";
import { Worker } from "../core/jobs/worker.ts";
import { Queue } from "../core/jobs/queue.ts";
import { registerRemediationHandlers } from "../core/jobs/remediation-handlers.ts";
import { registerChronicleHandler } from "../core/jobs/chronicle-handler.ts";
import { registerPageMirrorHandler } from "../core/jobs/page-mirror-handler.ts";
import { registerSubagentHandlerIfEnabled } from "../core/agent/handler.ts";
import { registerIngestCaptureHandler } from "../http/ingest.ts";
import { registerSource } from "../core/sources.ts";
import { OAuthProvider } from "../core/oauth-provider.ts";
import { sweepCodeRoots } from "../core/sweep-code.ts";
import { installSignalHandlers } from "../core/process-cleanup.ts";
import { legacyEnv, legacyEnvBootLine } from "../core/env-compat.ts";
import {
  quiescenceBootLines,
  resolveQuiescence,
  type Quiescence,
} from "../core/quiescence.ts";
import { basename } from "node:path";

export interface ServeOptions {
  http: boolean;
  host: string;
  port: number;
}

/**
 * Code roots come exclusively from the env var. CSV. Each root becomes
 * its own `sources` row at boot (id = `<basename>-code`).
 */
function codePaths(): string[] {
  const raw = process.env.MEMRAIN_CODE_PATHS;
  if (!raw || raw.length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function codeSourceId(path: string): string {
  const base = basename(path).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `${base || "root"}-code`;
}

/**
 * Whether the freshly generated admin bootstrap token may be echoed at boot.
 * The raw value is only ever allowed onto an interactive terminal: under
 * docker/systemd stderr is a log sink, so printing there turns a live admin
 * credential into a standing plaintext secret in centralized log storage.
 * An env-sourced token is never echoed — the operator already holds it.
 *
 * There is deliberately no override. A "print it anyway" switch reopens the
 * hole it closes, because the setups that would reach for one are exactly the
 * ones whose stderr is the log collector. The headless path is the operator
 * supplying their own token via MEMRAIN_ADMIN_BOOTSTRAP.
 */
export function shouldPrintAdminToken(opts: {
  fromEnv: boolean;
  isTty: boolean;
}): boolean {
  if (opts.fromEnv) return false;
  return opts.isTty;
}

function envNum(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Sweep expired access/refresh tokens + auth codes at startup — the tables
 * otherwise grow until a verify happens to hit the expired row. Skipped in
 * maintenance mode: the sweep deletes rows, and a maintenance boot must write
 * nothing. The first boot after maintenance sweeps as usual.
 * Best-effort: a sweep failure must never block serve.
 */
export async function bootTokenSweep(
  provider: Pick<OAuthProvider, "sweepExpiredTokens">,
  quiescence: Quiescence,
): Promise<void> {
  if (quiescence.maintenance) return;
  try {
    const swept = await provider.sweepExpiredTokens();
    if (swept > 0) console.error(`[memrain] swept ${swept} expired OAuth tokens/codes`);
  } catch (e) {
    console.error(
      "[memrain] token sweep failed (non-blocking):",
      e instanceof Error ? e.message : e,
    );
  }
}

export async function runServe(opts: ServeOptions): Promise<void> {
  if (!opts.http) {
    throw new Error(
      "memrain serve: --http is required. (stdio MCP not yet supported.)",
    );
  }

  // Abnormal-termination net: release a held cycle lock (and any other
  // registered cleanup) on SIGHUP/SIGPIPE/uncaughtException/unhandledRejection.
  // It deliberately does NOT touch SIGINT/SIGTERM — those are owned by the
  // graceful `shutdown()` below, which releases the lock via `cycle.stop()`
  // before `storage.close()`. (A competing SIGTERM handler here would race that
  // drain and exit early.)
  installSignalHandlers();

  const legacyEnvLine = legacyEnvBootLine(legacyEnv);
  if (legacyEnvLine) console.error(legacyEnvLine);
  const quiescence = resolveQuiescence(process.env);
  for (const line of quiescenceBootLines(quiescence)) console.error(line);

  const config = loadConfig();
  // Pass the full Config so the factory picks the right engine
  // (pglite vs postgres) per database.type. The legacy { dbPath: ... }
  // shape forced PGLite even when config said postgres.
  const storage = new Storage(config);
  await storage.init();

  // A Postgres brain with OAuth clients but the provider off almost always
  // means init wrote a fresh config.json (moved or missing data dir). Loud,
  // never fatal: the operator may have turned OAuth off on purpose.
  if (storage.engine().kind === "postgres") {
    try {
      const mismatch = selfIssuedMismatch(config, await storage.liveOauthClientCount());
      if (mismatch) console.error(`[memrain] ERROR: ${mismatch}`);
    } catch (e) {
      console.error(
        "[memrain] OAuth config check failed (non-blocking):",
        e instanceof Error ? e.message : e,
      );
    }
  }

  // Startup zombie-index sweep. memrain gates it default-OFF per its no-surprise-
  // mutation posture — an aborted CONCURRENTLY leaving an invalid index is rare,
  // and `doctor`'s invalid-indexes check already surfaces it. Flip
  // MEMRAIN_HNSW_ZOMBIE_SWEEP=1 to auto-drop invalid indexes at boot (postgres
  // only; best-effort, never fails startup).
  if (process.env.MEMRAIN_HNSW_ZOMBIE_SWEEP === "1") {
    try {
      const { dropZombieIndexes } = await import("../core/vector-index.ts");
      const { dropped } = await dropZombieIndexes(storage.engine());
      if (dropped.length > 0) {
        console.error(
          `[hnsw] startup sweep dropped ${dropped.length} invalid index(es): ${dropped.join(", ")}`,
        );
      }
    } catch (err) {
      console.error(`[hnsw] startup sweep failed: ${(err as Error).message}`);
    }
  }

  const serverOpts: Parameters<typeof startServer>[0] = {
    host: opts.host,
    port: opts.port,
    storage,
  };
  if (quiescence.maintenance) serverOpts.maintenance = true;
  if (config.mcp?.enabled === false) {
    serverOpts.mcpEnabled = false;
  }
  if (config.mcp?.rate_limit_per_minute !== undefined) {
    serverOpts.mcpRateLimitPerMinute = config.mcp.rate_limit_per_minute;
  }
  // Per-token-id cap (post-auth) — defeats IP rotation by an authed client.
  const perToken = Number.parseInt(
    process.env.MEMRAIN_MCP_RATE_LIMIT_PER_TOKEN_PER_MINUTE ?? "",
    10,
  );
  if (Number.isInteger(perToken) && perToken > 0) {
    serverOpts.mcpRateLimitPerTokenPerMinute = perToken;
  }
  // follow-up: public Cloudflare Tunnel ingress. When the
  // bearer token is present (via MEMRAIN_PUBLIC_BEARER env populated
  // by fetch-secrets.sh) we accept authenticated read requests; the
  // server.ts guard rejects internal-only routes regardless.
  // The external origin this brain answers on. The OAuth discovery document
  // reads MEMRAIN_PUBLIC_URL from the env on its own, but every other absolute
  // URL the server builds (admin magic links above all) derives from
  // `serverOpts.publicUrl` — so leaving it unset behind a TLS-terminating
  // proxy emits `http://…` links that bounce off the HTTPS redirect.
  // Trailing slashes stripped with the same guarded pattern resolveIssuer uses,
  // so the issuer and every other absolute URL agree on the origin's spelling.
  const publicUrl = (process.env.MEMRAIN_PUBLIC_URL ?? "").trim();
  if (publicUrl.length > 0) {
    serverOpts.publicUrl = publicUrl.replace(/(?<!\/)\/+$/, "");
  }

  const publicBearer = process.env.MEMRAIN_PUBLIC_BEARER;
  if (publicBearer && publicBearer.length > 0) {
    serverOpts.publicBearerToken = publicBearer;
    // Public-request detection keys on the Cf-Connecting-Ip header (set by
    // the Cloudflare edge). Behind any other ingress that does not inject
    // it, every request classifies as internal and the bearer is never
    // checked — a silent full auth bypass. Warn once at startup so a
    // non-Cloudflare operator finds the flag before an attacker does.
    const assumePublic = (process.env.MEMRAIN_ASSUME_PUBLIC ?? "")
      .trim()
      .toLowerCase();
    if (assumePublic !== "1" && assumePublic !== "true") {
      console.error(
        "[memrain] caution: public bearer is configured, but public-request " +
          "detection relies on the Cf-Connecting-Ip header. If your ingress " +
          "is NOT a Cloudflare Tunnel, either inject that header at the " +
          "proxy or set MEMRAIN_ASSUME_PUBLIC=1 — otherwise /mcp is served " +
          "without auth. Verify: an unauthenticated POST to /mcp must " +
          "return 401.",
      );
    }
  }
  // Shared bearer authenticating peer containers on the docker bridge
  // to /index and /friction. When unset, the server emits a startup
  // warning and stays open (legacy single-node behaviour) — operators
  // are urged to set <secrets_prefix>/memrain-internal-token.
  const internalToken = process.env.MEMRAIN_INTERNAL_TOKEN;
  if (internalToken && internalToken.length > 0) {
    serverOpts.internalToken = internalToken;
  }
  // memrain's own OAuth 2.1 provider (client_credentials). When enabled, mounts
  // POST /token and verifies self-issued `memrain_at_…` tokens on /mcp. Shares the
  // engine with the brain — the oauth_clients/oauth_tokens tables (migration
  // 046) already exist.
  if (config.auth?.selfIssued?.enabled === true) {
    // MEMRAIN_ENABLE_DCR_INSECURE lets self-registered (DCR) clients request the
    // consent-bypassing client_credentials grant; default off keeps them on the
    // authorization_code grant. The route-level DCR gate lives in server.ts.
    const dcrInsecure =
      (process.env.MEMRAIN_ENABLE_DCR_INSECURE ?? "").trim().toLowerCase() === "1" ||
      (process.env.MEMRAIN_ENABLE_DCR_INSECURE ?? "").trim().toLowerCase() === "true";
    const provider = new OAuthProvider({
      engine: storage.raw(),
      allowClientCredentialsDcr: dcrInsecure,
    });
    serverOpts.oauthProvider = provider;
    if (serverOpts.publicUrl === undefined) {
      console.error(
        "[memrain] caution: OAuth is on but MEMRAIN_PUBLIC_URL is unset, so the " +
          "issuer is taken from each request. Behind a TLS-terminating proxy " +
          "that origin is http://, and a client naming its https:// connector " +
          "URL as `resource` is refused with invalid_target. Set " +
          "MEMRAIN_PUBLIC_URL to the external https:// origin.",
      );
    }
    await bootTokenSweep(provider, quiescence);
  }
  // Admin surface bootstrap token (A1). Stable when MEMRAIN_ADMIN_BOOTSTRAP is
  // set; otherwise an ephemeral per-run token echoed to an interactive stderr
  // (lives only in the operator's terminal — never in a URL, never in a
  // container log). The `/admin` auth routes mount either way.
  const adminBootstrap = process.env.MEMRAIN_ADMIN_BOOTSTRAP?.trim();
  // The admin surface provisions the whole brain (sources, tenant grants), so an
  // operator-set bootstrap token must meet a minimum entropy floor — reject a weak
  // value at boot rather than lean on the login rate limiter alone.
  if (adminBootstrap && adminBootstrap.length > 0 && !/^[\w-]{32,}$/.test(adminBootstrap)) {
    throw new Error(
      "MEMRAIN_ADMIN_BOOTSTRAP is too weak: use 32+ chars from [A-Za-z0-9_-] " +
        "(e.g. `openssl rand -hex 32`), or unset it for an ephemeral per-run token.",
    );
  }
  const adminToken = adminBootstrap && adminBootstrap.length > 0 ? adminBootstrap : randomBytes(24).toString("hex");
  serverOpts.adminBootstrapToken = adminToken;
  const fromEnv = Boolean(adminBootstrap && adminBootstrap.length > 0);
  if (shouldPrintAdminToken({ fromEnv, isTty: process.stderr.isTTY === true })) {
    console.error(`[memrain] admin bootstrap token (ephemeral, this run only): ${adminToken}`);
  } else if (!fromEnv) {
    console.error(
      "[memrain] admin bootstrap token generated but withheld: stderr is not a TTY, so the " +
        "value would persist in the log sink. The admin surface is unreachable this run. " +
        "To use it headlessly, generate a token yourself and pass it in: " +
        "MEMRAIN_ADMIN_BOOTSTRAP=$(openssl rand -hex 32) — never have the " +
        "server print a generated one into the logs.",
    );
  }
  const server = startServer(serverOpts);
  const { worker, cycle } = startBackgroundWork(storage, config, quiescence);

  // Graceful shutdown on SIGINT / SIGTERM.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[memrain] received ${signal}, shutting down`);
    await worker.stop();
    if (cycle) await cycle.stop();
    await server.stop();
    await storage.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the process alive — Bun.serve already does this, but make it explicit.
  await new Promise(() => {});
}

/** What serve's background work calls at boot; tests swap in spies. */
export interface BackgroundDeps {
  registerSource: typeof registerSource;
  sweepCodeRoots: typeof sweepCodeRoots;
  startCycleLoop: typeof startCycleLoop;
  startWorker: (worker: Worker) => void;
  workerIntervalMs: number;
}

const defaultBackgroundDeps: BackgroundDeps = {
  registerSource,
  sweepCodeRoots,
  startCycleLoop,
  startWorker: (worker) => worker.start(),
  workerIntervalMs: 5000,
};

/**
 * Start the boot code sweep, the jobs worker and the cycle loop, each only
 * when its quiescence switch allows it. Job handlers are registered either
 * way, so submits keep enqueueing while the worker is off. The worker is
 * always constructed so shutdown can stop it unconditionally.
 */
export function startBackgroundWork(
  storage: Storage,
  config: ReturnType<typeof loadConfig>,
  quiescence: Quiescence,
  deps: BackgroundDeps = defaultBackgroundDeps,
): { worker: Worker; cycle: CycleHandle | null } {
  // Markdown ingest is on-demand only: there is no boot-time file watcher.
  // Content enters the brain via the MCP `index` tool / the `memrain reindex`
  // CLI (both go through core/sweep.ts → indexer), or via MCP `page_put`.
  // No filesystem vault is watched at startup.

  // code chunkers (graph-only, see TODO External-dep roadmap).
  // Register one source row per MEMRAIN_CODE_PATHS entry, then run a
  // boot sweep. Both are best-effort: registration errors are warned,
  // sweep errors are logged but do NOT abort serve startup.
  const codeRoots = codePaths();
  if (!quiescence.bootCodeSweep) {
    // Off by switch or maintenance; the boot line already says so.
  } else if (codeRoots.length === 0) {
    console.log(
      "[memrain] no code roots configured (set MEMRAIN_CODE_PATHS=/path/to/repo[,...] to enable code chunkers)",
    );
  } else {
    for (const root of codeRoots) {
      const sourceId = codeSourceId(root);
      deps.registerSource(storage.engine(), {
        id: sourceId,
        kind: "code",
        pathPrefix: root.endsWith("/") ? root : root + "/",
        syncPolicy: "local-only",
        indexedPolicy: "hashed-only",
        rateLimitPerMinute: 0,
        respectQuietHours: false,
        boostWeight: 1.2,
        description: `Code corpus rooted at ${root} (graph-only via tree-sitter)`,
      }).catch((e) =>
        console.warn(
          `[code] source registration failed for ${sourceId}:`,
          e instanceof Error ? e.message : e,
        ),
      );
    }
    const codeDelayMs = envNum("MEMRAIN_CODE_SWEEP_DELAY_MS") ?? 0;
    void (async () => {
      try {
        const sweepOpts: Parameters<typeof sweepCodeRoots>[1] = { paths: codeRoots };
        if (codeDelayMs > 0) sweepOpts.perFileDelayMs = codeDelayMs;
        const r = await deps.sweepCodeRoots(storage, sweepOpts);
        for (const pr of r.perRoot) {
          if (pr.missing) {
            console.warn(
              `[code] root '${pr.root}' does not exist on disk — bind-mount or git clone missing?`,
            );
          } else if (pr.files === 0) {
            console.warn(
              `[code] root '${pr.root}' contains 0 indexable files (.ts/.tsx/.py) — is the directory mounted and populated?`,
            );
          }
        }
        console.log(
          `[code] boot sweep: scanned=${r.scanned} reindexed=${r.reindexed} skipped=${r.skipped} parseErrors=${r.parseErrors} errors=${r.errors.length}`,
        );
        // The count alone is undiagnosable — print the failing files. Capped so a
        // broken mount (every file failing) can't flood the boot log.
        const SWEEP_ERROR_LOG_CAP = 10;
        for (const err of r.errors.slice(0, SWEEP_ERROR_LOG_CAP)) {
          console.warn(`[code] sweep error: ${err.path}: ${err.message}`);
        }
        if (r.errors.length > SWEEP_ERROR_LOG_CAP) {
          console.warn(
            `[code] sweep error: ... and ${r.errors.length - SWEEP_ERROR_LOG_CAP} more`,
          );
        }
      } catch (e) {
        console.warn(
          "[code] boot sweep failed:",
          e instanceof Error ? e.message : e,
        );
      }
    })();
  }

  // Start the durable jobs worker. Single-concurrency for v1. (The legacy
  // ingest recipes were removed — markdown enters via on-demand reindex /
  // MCP, code via the boot sweep; jobs remain for future handlers.)
  // A default per-job wall-clock cap is OFF unless MEMRAIN_JOB_TIMEOUT_MS is set
  // (a blanket cap could dead-letter a legitimately-slow Bedrock phase); a job
  // can still set its own timeoutMs at enqueue.
  const workerOpts: ConstructorParameters<typeof Worker>[1] = {
    intervalMs: deps.workerIntervalMs,
    // Single-active-worker guard: a double-start / second container / restart
    // overlap elects ONE active worker via the worker_lock row; the rest idle
    // until the holder's heartbeat lapses (migration 042).
    engine: storage.engine(),
  };
  const jobTimeoutRaw = process.env.MEMRAIN_JOB_TIMEOUT_MS?.trim();
  // Strict: digits only (reject "100abc" -> 100, "1e9" -> 1, negatives, blanks),
  // matching enqueue's positive-integer validation.
  if (jobTimeoutRaw !== undefined && /^\d+$/.test(jobTimeoutRaw)) {
    const parsed = Number.parseInt(jobTimeoutRaw, 10);
    if (parsed > 0) workerOpts.jobTimeoutMs = parsed;
  }
  // How long shutdown lets a running job finish before handing it back to the
  // queue. Same strict digits-only parse; 0 hands back at once.
  const drainRaw = process.env.MEMRAIN_WORKER_DRAIN_MS?.trim();
  if (drainRaw !== undefined && /^\d+$/.test(drainRaw)) {
    workerOpts.drainMs = Number.parseInt(drainRaw, 10);
  }
  // Register the `remediation` handler so `doctor --remediate` jobs actually
  // run instead of dead-lettering with "no handler registered".
  registerRemediationHandlers(storage);
  // Register the `ingest_capture` handler so POST /ingest submissions land
  // as inbox pages instead of dead-lettering.
  registerIngestCaptureHandler(storage);
  // Register the `chronicle_extract` handler so timeline extraction runs off
  // the write path instead of dead-lettering with "no handler registered".
  registerChronicleHandler(storage);
  // Register the `page_mirror` handler: with MEMRAIN_PAGE_MIRROR_SYNC=0 the write
  // path queues the search mirror instead of running it inline.
  registerPageMirrorHandler(storage);
  // The operator's agent loop runs only when opted in: without the handler a
  // `subagent` submit is refused as an unknown kind.
  if (registerSubagentHandlerIfEnabled(storage)) {
    console.log("[memrain] agent loop enabled (subagent jobs, read-only tools)");
  }
  const worker = new Worker(new Queue(storage.engine()), workerOpts);
  if (quiescence.jobsWorker) {
    deps.startWorker(worker);
    console.log(
      `[memrain] jobs worker started (intervalMs=${deps.workerIntervalMs}${
        workerOpts.jobTimeoutMs ? `, jobTimeoutMs=${workerOpts.jobTimeoutMs}` : ""
      })`,
    );
  }

  // Cycle loop. Off by default; opt in via env or memrain.yml. The
  // `dream.*` config keys drive the cycle's embed-stale phase.
  // Threshold for enabling stays at >=60 s to avoid
  // accidental tight loops.
  const cycleIntervalS = envNum("MEMRAIN_DREAM_INTERVAL_S")
    ?? config.dream?.interval_s
    ?? 0;
  const cycleStaleDays = envNum("MEMRAIN_DREAM_STALE_DAYS")
    ?? config.dream?.stale_days
    ?? 30;
  let cycle: CycleHandle | null = null;
  if (quiescence.cycle && Number.isFinite(cycleIntervalS) && cycleIntervalS >= 60) {
    console.log(
      `[memrain] starting cycle loop: every ${cycleIntervalS}s, embed-stale at >${cycleStaleDays}d`,
    );
    cycle = deps.startCycleLoop(storage, {
      intervalMs: cycleIntervalS * 1000,
      staleDays: cycleStaleDays,
    });
  }
  return { worker, cycle };
}
