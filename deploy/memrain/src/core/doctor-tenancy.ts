/**
 * doctor-tenancy.ts — tenancy / auth doctor checks.
 *
 * The two subsystems where a silent misconfig equals a cross-tenant leak or a
 * dead tenant get their own checks:
 *
 *   - federation-health   : per-source embed coverage on a multi-source brain.
 *     One tenant's embedding can break to 0% invisibly inside the whole-brain
 *     average. Fails on the severe fingerprint (coverage < 50% with a large
 *     corpus); warns below 95%. memrain has no federated sync puller (sources
 *     are ingest channels), so document age is not a failure signal and lag is
 *     deliberately omitted.
 *   - oauth-client-health : a confidential OAuth client (auth method other
 *     than 'none') with a NULL/empty secret hash authenticates nobody — or,
 *     worse, whatever the verify path falls back to. Fails on any such row.
 *   - oauth-client-hygiene : idle clients, public clients in client tenant
 *     mode, redirect URIs outside https/loopback, browser connectors scoped
 *     beyond read/write. Warns.
 *   - source-routing-health : registered sources with zero documents (writes
 *     silently collapsed elsewhere) and documents with NULL source_id
 *     (invisible to every scoped reader — the migration-071 class). Warns.
 *   - tenancy-isolation-config : more than one live non-operator credential
 *     while MEMRAIN_TENANT_FAIL_CLOSED is off. Warns.
 *   - document-id-drift : filesystem documents whose id is not the hash of
 *     their source_path (a path rewritten in place, migration 099) and paths
 *     stored under more than one id. Warns; the next local re-read heals both.
 *
 * All of them are read-only, cheap, and turn their own errors into a `warn`
 * verdict so a probe failure never crashes the doctor — and never passes for a
 * clean bill either.
 */
import { couldNotCheck, type CheckStatus } from "./doctor-categories.ts";
import { tenantFailClosedEnabled } from "./auth-info.ts";
import type { Engine } from "./engine/interface.ts";
import { isAllowedRedirectUri } from "./oauth-provider.ts";
import { collectPerSourceHealth } from "./source-health.ts";

/** Same shape as the doctor's internal Check. */
export interface TenancyCheck {
  name: string;
  /** Exit-code driver — false only on `status:"fail"`. */
  ok: boolean;
  /** Three-state verdict; a `warn` is a real signal that must not gate. */
  status: CheckStatus;
  detail: string;
}

function toInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Per-source embed-coverage health on a multi-source brain. Single-source
 * short-circuits to ok. Severe coverage collapse fails; partial coverage and
 * a failed-job burst warn (`status:"warn"`, ok:true — it reports without
 * gating the exit code).
 */
export async function checkFederationHealth(
  engine: Engine,
): Promise<TenancyCheck> {
  const name = "federation-health";
  try {
    const srcCount = await engine.query<{ n: number | string }>(
      `SELECT COUNT(*)::int AS n FROM sources`,
    );
    if (toInt(srcCount.rows[0]?.n) <= 1) {
      return {
        name,
        ok: true,
        status: "ok",
        detail: "single-source brain (no federation to check)",
      };
    }
    // The NULL-source '(unclassified)' bucket is source-routing-health's
    // problem — a reindex hint keyed on it would be bogus.
    const rows = (await collectPerSourceHealth(engine)).filter(
      (m) => m.source_id !== "(unclassified)",
    );
    const fails: string[] = [];
    const warns: string[] = [];
    for (const m of rows) {
      const pct = m.embed_coverage_pct * 100;
      if (pct < 50 && m.embeddable_chunks > 1000) {
        fails.push(
          `${m.source_id}: ${pct.toFixed(1)}% embed coverage ` +
            `(${m.embedded_chunks}/${m.embeddable_chunks}) — run 'memrain reindex --source ${m.source_id}'`,
        );
        continue;
      }
      if (pct < 95 && m.embeddable_chunks > 100) {
        warns.push(
          `${m.source_id}: ${pct.toFixed(1)}% embed coverage ` +
            `(${m.embedded_chunks}/${m.embeddable_chunks})`,
        );
      }
    }
    // Failed-job burst is brain-level (jobs carry no source_id).
    const failedR = await engine.query<{ n: number | string }>(
      `SELECT COUNT(*)::int AS n FROM jobs
        WHERE status = 'failed'
          AND (finished_at IS NULL OR finished_at >= NOW() - INTERVAL '24 hours')`,
    );
    const failed24h = toInt(failedR.rows[0]?.n);
    if (failed24h >= 3) {
      warns.push(`${failed24h} job failure(s) in 24h — check 'memrain jobs list --status failed'`);
    }
    if (fails.length > 0) {
      return {
        name,
        ok: false,
        status: "fail",
        detail: `${fails.length} federation failure(s): ${fails.join("; ")}`,
      };
    }
    if (warns.length > 0) {
      return {
        name,
        ok: true,
        status: "warn",
        detail: `${warns.length} federation warning(s): ${warns.join("; ")}`,
      };
    }
    return { name, ok: true, status: "ok", detail: `${rows.length} source(s) healthy` };
  } catch (e) {
    return couldNotCheck(name, e);
  }
}

/**
 * Confidential OAuth clients (token_endpoint_auth_method other than 'none')
 * MUST carry a secret hash. Public PKCE clients intentionally store NULL —
 * a NULL hash on a confidential row is the silent-misconfig fingerprint.
 */
export async function checkOauthClientHealth(
  engine: Engine,
): Promise<TenancyCheck> {
  const name = "oauth-client-health";
  try {
    const r = await engine.query<{
      client_id: string;
      method: string | null;
      hash: string | null;
    }>(
      `SELECT client_id,
              token_endpoint_auth_method AS method,
              client_secret_hash AS hash
         FROM oauth_clients
        WHERE deleted_at IS NULL`,
    );
    if (r.rows.length === 0) {
      return { name, ok: true, status: "ok", detail: "no OAuth clients registered" };
    }
    const broken = r.rows.filter(
      (row) => row.method !== "none" && (row.hash === null || row.hash === ""),
    );
    if (broken.length > 0) {
      const ids = broken.map((b) => b.client_id).slice(0, 5).join(", ");
      return {
        name,
        ok: false,
        status: "fail",
        detail:
          `${broken.length} confidential OAuth client(s) have a NULL/empty secret hash: ${ids}` +
          (broken.length > 5 ? ` (+${broken.length - 5} more)` : "") +
          " — revoke and re-register each with 'memrain auth register-client'",
      };
    }
    return {
      name,
      ok: true,
      status: "ok",
      detail: `${r.rows.length} OAuth client(s); all auth shapes consistent`,
    };
  } catch (e) {
    return couldNotCheck(name, e);
  }
}

/** At most five names, then a count of the rest. */
function sample(names: string[]): string {
  return names.slice(0, 5).join(", ") + (names.length > 5 ? ` (+${names.length - 5} more)` : "");
}

/**
 * Registration hygiene of the live OAuth clients. Warn-only and read-only:
 * each finding is something an operator should look at, none stops the brain.
 *
 *   - idle        : no MCP request logged in 90 days (a new client counts too
 *                   until its first call) — a credential nobody uses is one
 *                   nobody would notice leaking.
 *   - public      : no secret while the tenant comes from the client row, so
 *                   an auto-approving /authorize mints tokens for anyone who
 *                   knows the client id.
 *   - redirect    : a redirect URI that is neither https nor http on a
 *                   loopback host (registration refuses these today; older
 *                   rows may still hold one).
 *   - wide scope  : a browser connector (authorization_code) registered with a
 *                   scope beyond read/write; a person's chat app has no use
 *                   for admin.
 */
export async function checkOauthClientHygiene(
  engine: Engine,
): Promise<TenancyCheck> {
  const name = "oauth-client-hygiene";
  try {
    const r = await engine.query<{
      client_id: string;
      client_name: string | null;
      grant_types: string[] | null;
      scope: string | null;
      redirect_uris: string[] | null;
      public_client: boolean;
      tenant_mode: string | null;
      idle: boolean;
    }>(
      `SELECT c.client_id, c.client_name, c.grant_types, c.scope, c.redirect_uris,
              c.client_secret_hash IS NULL AS public_client, c.tenant_mode,
              NOT EXISTS (SELECT 1 FROM mcp_request_log l
                           WHERE l.token_name = c.client_id
                             AND l.created_at > now() - interval '90 days') AS idle
         FROM oauth_clients c
        WHERE c.deleted_at IS NULL
        ORDER BY c.client_id`,
    );
    if (r.rows.length === 0) {
      return { name, ok: true, status: "ok", detail: "no OAuth clients registered" };
    }
    const label = (c: { client_id: string; client_name: string | null }) =>
      c.client_name ? `${c.client_name} (${c.client_id})` : c.client_id;
    const idle = r.rows.filter((c) => c.idle).map(label);
    const publicClient = r.rows
      .filter((c) => c.public_client && (c.tenant_mode ?? "client") === "client")
      .map(label);
    const badRedirect = r.rows.flatMap((c) =>
      (c.redirect_uris ?? []).filter((u) => !isAllowedRedirectUri(u)).map((u) => `${label(c)}: ${u}`),
    );
    const wideConnector = r.rows
      .filter((c) => (c.grant_types ?? []).includes("authorization_code"))
      .filter((c) => (c.scope ?? "").split(/\s+/).some((x) => x !== "" && x !== "read" && x !== "write"))
      .map((c) => `${label(c)} [${c.scope}]`);

    const warns: string[] = [];
    if (idle.length > 0) {
      warns.push(
        `${idle.length} client(s) with no call in 90 days: ${sample(idle)} — ` +
          "revoke any nobody uses with 'memrain auth revoke-client <id>'",
      );
    }
    if (publicClient.length > 0) {
      warns.push(
        `${publicClient.length} public client(s) in client tenant mode: ${sample(publicClient)} — ` +
          "anyone with the client id gets that tenant unless MEMRAIN_OAUTH_REQUIRE_LOGIN is set; " +
          "use --tenant-mode enrollment or a confidential client",
      );
    }
    if (badRedirect.length > 0) {
      warns.push(
        `${badRedirect.length} redirect URI(s) neither https nor loopback: ${sample(badRedirect)} — ` +
          "fix with 'memrain auth set-redirect-uris <id> <uri...>'",
      );
    }
    if (wideConnector.length > 0) {
      warns.push(
        `${wideConnector.length} browser connector(s) with scope beyond read/write: ${sample(wideConnector)}`,
      );
    }
    if (warns.length > 0) {
      return { name, ok: true, status: "warn", detail: warns.join("; ") };
    }
    return {
      name,
      ok: true,
      status: "ok",
      detail: `${r.rows.length} OAuth client(s); all used within 90 days, none public, redirect URIs and scopes in bounds`,
    };
  } catch (e) {
    return couldNotCheck(name, e);
  }
}

/**
 * Personal access tokens whose row records no scopes.
 *
 * Until the row became the authority, every `access_tokens` row resolved to
 * read+write+admin whatever the column said. A token with no scopes recorded
 * now resolves to read+write, so anything that leaned on the old grandfather to
 * reach the one admin-scoped tool (`purge_deleted_pages`) stops working — with
 * nothing but a permission error to explain why. Say it here instead, once, at
 * upgrade time.
 */
export async function checkPatScopesRecorded(
  engine: Engine,
): Promise<TenancyCheck> {
  const name = "pat-scopes-recorded";
  try {
    const r = await engine.query<{ name: string }>(
      `SELECT name FROM access_tokens
        WHERE revoked_at IS NULL
          AND (scopes IS NULL OR cardinality(scopes) = 0)`,
    );
    if (r.rows.length === 0) {
      return { name, ok: true, status: "ok", detail: "every live token records its scopes" };
    }
    const names = r.rows.map((x) => x.name).slice(0, 5).join(", ");
    return {
      name,
      ok: true,
      status: "warn",
      detail:
        `${r.rows.length} live personal access token(s) record no scopes: ${names}` +
        (r.rows.length > 5 ? ` (+${r.rows.length - 5} more)` : "") +
        " — each now resolves to read+write. If one needs the admin tool, record it: " +
        "memrain auth permissions <name> set-scopes read,write,admin",
    };
  } catch (e) {
    return couldNotCheck(name, e);
  }
}

/**
 * Source-routing sanity: every non-default source should own documents, and
 * no document should sit at NULL source_id (a scoped read filters
 * `source_id = ANY(...)` and NULL matches nothing — those rows are invisible
 * to every tenant). Warn-level: a just-registered source is legitimately
 * empty mid-import.
 */
export async function checkSourceRoutingHealth(
  engine: Engine,
): Promise<TenancyCheck> {
  const name = "source-routing-health";
  try {
    const perSource = await engine.query<{ id: string; n: number | string }>(
      `SELECT s.id, COUNT(d.id)::int AS n
         FROM sources s
         LEFT JOIN documents d ON d.source_id = s.id
        WHERE s.id <> 'default'
        GROUP BY s.id
        ORDER BY s.id`,
    );
    if (perSource.rows.length === 0) {
      return {
        name,
        ok: true,
        status: "ok",
        detail: "single-source brain (no routing to check)",
      };
    }
    const warns: string[] = [];
    const empty = perSource.rows.filter((r) => toInt(r.n) === 0).map((r) => r.id);
    if (empty.length > 0) {
      warns.push(
        `${empty.length} source(s) have zero documents: ${empty.join(", ")} — ` +
          "writes may have silently fallen to another source; verify the ingest path",
      );
    }
    const nullDocs = await engine.query<{ n: number | string }>(
      `SELECT COUNT(*)::int AS n FROM documents WHERE source_id IS NULL`,
    );
    const orphaned = toInt(nullDocs.rows[0]?.n);
    if (orphaned > 0) {
      warns.push(
        `${orphaned} document(s) have NULL source_id — invisible to every scoped reader; ` +
          "backfill by ingest path (see migration 071)",
      );
    }
    if (warns.length > 0) {
      return { name, ok: true, status: "warn", detail: warns.join("; ") };
    }
    return {
      name,
      ok: true,
      status: "ok",
      detail: `${perSource.rows.length} non-default source(s); all populated, no NULL-source documents`,
    };
  } catch (e) {
    return couldNotCheck(name, e);
  }
}

/**
 * Documents a local re-read would write under a different id than the one
 * they carry. The id is `doc_` + the first 16 hex of sha256(source_path);
 * scheme paths (`page://`, `gmail:`) name rows, not files, and are skipped.
 * The index write folds these into the path's own id on the next re-read, so
 * this only reports how much is left.
 */
export async function checkDocumentIdDrift(
  engine: Engine,
): Promise<TenancyCheck> {
  const name = "document-id-drift";
  try {
    const r = await engine.query<{ drifted: number | string; duplicated: number | string }>(
      `SELECT
         (SELECT COUNT(*)::int FROM documents
           WHERE left(source_path, 1) = '/'
             AND id <> 'doc_' || left(encode(sha256(convert_to(source_path, 'UTF8')), 'hex'), 16)
         ) AS drifted,
         (SELECT COUNT(*)::int FROM (
            SELECT source_path FROM documents GROUP BY source_path HAVING COUNT(*) > 1
          ) dup
         ) AS duplicated`,
    );
    const drifted = toInt(r.rows[0]?.drifted);
    const duplicated = toInt(r.rows[0]?.duplicated);
    if (drifted === 0 && duplicated === 0) {
      return { name, ok: true, status: "ok", detail: "every file document carries its path's id" };
    }
    return {
      name,
      ok: true,
      status: "warn",
      detail:
        `${drifted} document(s) carry an id their source_path does not hash to; ` +
        `${duplicated} source_path(s) are stored under more than one id — ` +
        "each heals into one document on its next re-read (vault sweep, embed-stale, rechunk-sweep, reindex)",
    };
  } catch (e) {
    return couldNotCheck(name, e);
  }
}

/**
 * More than one live non-operator credential means more than one tenant may
 * reach the brain. Off, MEMRAIN_TENANT_FAIL_CLOSED lets an authenticated caller
 * with no grant read as unscoped, so that state warns. Warn-level: a single
 * owner with two devices is a legitimate reason to leave it off.
 */
export async function checkTenancyIsolationConfig(engine: Engine): Promise<TenancyCheck> {
  const name = "tenancy-isolation-config";
  try {
    // scope: operator-only doctor counts every credential in the brain
    const r = await engine.query<{ n: number | string }>(
      `SELECT (SELECT COUNT(*) FROM access_tokens WHERE revoked_at IS NULL)
            + (SELECT COUNT(*) FROM oauth_clients WHERE deleted_at IS NULL) AS n`,
    );
    const live = toInt(r.rows[0]?.n);
    if (tenantFailClosedEnabled()) {
      return { name, ok: true, status: "ok", detail: `fail-closed on; ${live} live non-operator credential(s)` };
    }
    if (live <= 1) {
      return { name, ok: true, status: "ok", detail: `${live} live non-operator credential(s); fail-closed not needed yet` };
    }
    return {
      name,
      ok: true,
      status: "warn",
      detail:
        `${live} live non-operator credentials and MEMRAIN_TENANT_FAIL_CLOSED is off: an authenticated ` +
        "caller with no source grant reads the whole brain. Set MEMRAIN_TENANT_FAIL_CLOSED=1 once every " +
        "credential carries a grant.",
    };
  } catch (e) {
    return couldNotCheck(name, e);
  }
}
