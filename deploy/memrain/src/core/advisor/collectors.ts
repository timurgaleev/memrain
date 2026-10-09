/**
 * advisor/collectors.ts — the deterministic advisor collectors.
 *
 * Each collector is read-only, LLM-free, and reshapes a signal memrain already
 * computes into ranked findings. None of them open Bedrock or write a row. Every
 * collector runs in its OWN try/catch in run.ts, so a missing table or an engine
 * quirk on one never aborts the report.
 *
 * Sources reused (not rebuilt):
 *   - pending migrations  : discoverMigrations() vs the `migrations` table
 *     (same set apply-migrations.ts applies).
 *   - embedding coverage / stalled+failed jobs : brainHealthMetrics()
 *     (the exact primitive doctor.ts + status.ts read).
 *   - version drift       : the version the op passes (package.json) vs the
 *     version the running binary reports — purely local, no network.
 *   - setup smells        : process.env (MEMRAIN_INTERNAL_TOKEN), same warning
 *     surface as the public guard's legacy fall-through.
 */
import { discoverMigrations } from "../migrate.ts";
import { orphanExclusionSql } from "../orphan-policy.ts";
import { brainHealthMetrics } from "../source-health.ts";
import { latestEvalSnapshot } from "../eval-snapshot.ts";
import { gradeMinAgeDays } from "../synthesis/takes.ts";
import { VERSION } from "../../version.ts";
import type { Engine } from "../engine/interface.ts";
import type { AdvisorCollector, AdvisorFinding } from "./types.ts";

/**
 * Every source that owns pages or ontology rows — the operator's whole-brain
 * scope for the chronicle collector when no explicit read scope is supplied.
 * Degrades gracefully: on a pre-ontology brain the UNION falls back to pages
 * alone, and on any failure to an empty scope (the collector then stays silent).
 */
async function resolveWholeBrainScope(engine: Engine): Promise<string[]> {
  const pick = (rows: { source_id: string | null }[]): string[] =>
    rows.map((r) => r.source_id).filter((s): s is string => !!s);
  try {
    const r = await engine.query<{ source_id: string | null }>(
      `SELECT source_id FROM pages WHERE source_id IS NOT NULL
       UNION
       SELECT source_id FROM entity_facts WHERE source_id IS NOT NULL`,
    );
    return pick(r.rows);
  } catch {
    try {
      const r = await engine.query<{ source_id: string | null }>(
        `SELECT DISTINCT source_id FROM pages WHERE source_id IS NOT NULL`,
      );
      return pick(r.rows);
    } catch {
      return [];
    }
  }
}

/**
 * Pending schema migrations — the one high-severity signal. An un-migrated brain
 * can be missing columns/indexes newer code expects. Storage init applies
 * migrations on boot, so this only fires when a just-pulled migration hasn't
 * been applied yet (daemon not bounced). The fix is idempotent.
 */
export const collectMigration: AdvisorCollector = {
  id: "migration",
  collect: async (ctx) => {
    let pending: { id: number; name: string }[] = [];
    try {
      // Discover the shipped set, then subtract what the `migrations` table has
      // already recorded. A brand-new brain with no migrations table yields no
      // rows → every shipped migration counts as pending (correct: it is).
      const files = discoverMigrations();
      const seen = new Set<number>();
      try {
        const r = await ctx.engine.query<{ id: number }>(
          "SELECT id FROM migrations",
        );
        for (const row of r.rows) seen.add(Number(row.id));
      } catch {
        // No migrations table yet → nothing recorded, all files are pending.
      }
      pending = files.filter((f) => !seen.has(f.id)).map((f) => ({ id: f.id, name: f.name }));
    } catch {
      return []; // can't enumerate the migration set → say nothing
    }
    if (pending.length === 0) return [];
    const names = pending.map((p) => `${p.id}_${p.name}`).join(", ");
    return [
      {
        id: "pending_migration",
        severity: "high",
        title: `${pending.length} schema migration${pending.length === 1 ? " is" : "s are"} pending — apply before relying on newer features.`,
        detail: `Newer memrain code assumes the latest schema; an un-migrated brain can fail or under-perform. Pending: ${names}.`,
        fix_command: "memrain apply-migrations",
        collector: "migration",
      },
    ];
  },
};

/**
 * Version drift — the running binary reports a different version than the
 * package.json it was built from. Deterministic + local (NO network: memrain has
 * no update cache; versioning is git tags). A mismatch means the live process is
 * stale relative to the checked-out source — restart to pick up the new build.
 *
 * ponytail: inert under memrain's single baked-image container deploy — `built`
 * (this import) and the running version are the same package.json, so they never
 * differ in production. The comparison is correct + unit-tested, and fires the
 * moment a caller feeds a distinct runtime version (e.g. a future
 * running-vs-on-disk split); retained for that.
 */
export const collectVersion: AdvisorCollector = {
  id: "version",
  collect: async (ctx) => {
    const built = VERSION;
    if (typeof built !== "string" || built.length === 0) return [];
    if (built === ctx.version) return [];
    return [
      {
        id: "version_drift",
        severity: "low",
        title: `Running version ${ctx.version} differs from the built package (${built}).`,
        detail: "The live process predates the current build. Restart the daemon to run the latest code.",
        collector: "version",
      },
    ];
  },
};

/**
 * Stalled / dead jobs + a failed-job signal. memrain's queue uses status
 * 'running' + `lock_until`. A running row whose lock lapsed, or whose
 * stall_count has climbed, is wedged and stops
 * backfill/sync from progressing. Failed jobs in the last 24h are the one
 * unambiguous "something broke" signal — read from brainHealthMetrics so the
 * advisor and the doctor agree.
 */
export const collectStalledJobs: AdvisorCollector = {
  id: "stalled-jobs",
  collect: async (ctx) => {
    const findings: AdvisorFinding[] = [];

    try {
      const r = await ctx.engine.query<{ kind: string; n: number | string }>(
        `SELECT kind, COUNT(*)::int AS n
           FROM jobs
          WHERE status = 'running'
            AND (lock_until < NOW() OR stall_count >= 2)
          GROUP BY kind
          ORDER BY n DESC, kind ASC`,
      );
      for (const row of r.rows) {
        const n = Number(row.n);
        if (!Number.isFinite(n) || n <= 0) continue;
        findings.push({
          id: `stalled_job:${row.kind}`,
          severity: "medium",
          title: `${n} "${row.kind}" job${n === 1 ? "" : "s"} look stalled (lock lapsed / retrying).`,
          detail: "A wedged worker stops backfill / re-index from progressing.",
          fix_command: "memrain jobs list",
          collector: "stalled-jobs",
        });
      }
    } catch {
      /* jobs table absent / engine quirk → no stalled-jobs finding */
    }

    try {
      const h = await brainHealthMetrics(ctx.engine);
      if (h.failed_jobs_24h > 0) {
        findings.push({
          id: "failed_jobs_24h",
          severity: "medium",
          title: `${h.failed_jobs_24h} job${h.failed_jobs_24h === 1 ? "" : "s"} failed in the last 24h.`,
          detail: "Inspect the failures and re-run or cancel them — a failing handler can block dependent work.",
          fix_command: "memrain jobs list",
          collector: "stalled-jobs",
        });
      }
    } catch {
      /* metrics unavailable → skip the failed-jobs finding */
    }

    return findings;
  },
};

/**
 * Embedding coverage — of the chunks that SHOULD carry a vector (non-code),
 * how many actually do. Low coverage means the vector arm of hybrid search is
 * blind to that content (keyword/FTS still sees it). Same metric the doctor's
 * `source-health` check reports; the fix is the embed backfill.
 */
export const collectEmbedCoverage: AdvisorCollector = {
  id: "embed-coverage",
  collect: async (ctx) => {
    let h;
    try {
      h = await brainHealthMetrics(ctx.engine);
    } catch {
      return []; // metrics unavailable → nothing to advise
    }
    // Nothing embeddable yet (empty brain) → not a gap.
    if (h.embeddable_chunks === 0) return [];
    const missing = h.embeddable_chunks - h.embedded_chunks;
    if (missing <= 0 || h.embed_coverage_pct >= 0.7) return [];
    const pct = Math.round(h.embed_coverage_pct * 100);
    return [
      {
        id: "low_embed_coverage",
        severity: "medium",
        title: `Only ${pct}% of embeddable content is embedded — semantic search is degraded.`,
        detail: `${missing} chunk${missing === 1 ? " is" : "s are"} missing an embedding. Backfill to restore the vector arm of hybrid search.`,
        fix_command: "memrain embed",
        collector: "embed-coverage",
      },
    ];
  },
};

/**
 * Usage shape — the graph-hygiene link-graph collector. The embedding-coverage
 * finding lives in `collectEmbedCoverage` here, so this collector adds only the
 * two link-graph gaps: islanded pages (no inbound AND no outbound link —
 * invisible to graph traversal) and dead links (a `target_slug` that resolves
 * to no live page).
 *
 * Definitions: orphan = islanded (a hub that only links out is working as
 * intended, not an orphan); dead link = a link whose `target_slug` resolves to
 * no live page. Both counts come from ONE round trip; this scan is heavier than
 * the metric collectors, so it belongs to the explicit `advisor` run, not a hot
 * sync-cadence path.
 *
 * Soft-delete semantics: memrain SOFT-deletes pages (sets `deleted_at`, the link
 * rows survive), so a link to/from a soft-deleted page must count as a NON-edge.
 * Both counts therefore gate every edge on a live page at both ends:
 * orphan = no inbound edge FROM a live page and no outbound edge TO a live page;
 * dead link = a live-source link whose target is not a live page (a link from a
 * dead source is itself unreachable, so it is not a "dead link" to fix). A
 * self-loop reads as non-orphan — the orphan check is satisfied by either
 * direction of any edge, self-loop included.
 */
export const collectUsageShape: AdvisorCollector = {
  id: "usage-shape",
  collect: async (ctx) => {
    let row: { page_count: number; orphan_pages: number; dead_links: number } | undefined;
    try {
      // Same exclusion policy the orphan listing uses — see orphan-policy.ts.
      const orphanExcl = orphanExclusionSql("p.slug", 1);
      const r = await ctx.engine.query<{ page_count: number; orphan_pages: number; dead_links: number }>(
        `SELECT
           (SELECT count(*) FROM pages WHERE deleted_at IS NULL)::int AS page_count,
           (SELECT count(*) FROM pages p
              WHERE p.deleted_at IS NULL
${orphanExcl.sql}
                AND NOT EXISTS (
                  SELECT 1 FROM links l JOIN pages s ON s.slug = l.source_slug AND s.deleted_at IS NULL
                   WHERE l.target_slug = p.slug
                )
                AND NOT EXISTS (
                  SELECT 1 FROM links l JOIN pages t ON t.slug = l.target_slug AND t.deleted_at IS NULL
                   WHERE l.source_slug = p.slug
                )
           )::int AS orphan_pages,
           (SELECT count(*) FROM links l
              WHERE EXISTS (
                SELECT 1 FROM pages s WHERE s.slug = l.source_slug AND s.deleted_at IS NULL
              )
                AND NOT EXISTS (
                  SELECT 1 FROM pages t WHERE t.slug = l.target_slug AND t.deleted_at IS NULL
                )
           )::int AS dead_links`,
        // Same exclusion policy the orphan listing uses — a count from one
        // definition and a listing from another is how a finding ends up
        // describing something nobody can reproduce.
        orphanExcl.params,
      );
      row = r.rows[0];
    } catch {
      return []; // pages/links table absent or engine quirk → say nothing
    }
    if (!row || Number(row.page_count) === 0) return []; // empty brain → no graph to advise on

    const findings: AdvisorFinding[] = [];
    const orphans = Number(row.orphan_pages);
    const dead = Number(row.dead_links);

    if (orphans > 0) {
      findings.push({
        id: "orphan_pages",
        severity: "info",
        title: `${orphans} page${orphans === 1 ? " has" : "s have"} no links in or out.`,
        detail:
          "Islanded pages do not surface through graph traversal — connect or " +
          "review them. Counted as: a live page with no live inbound AND no " +
          "live outbound link. No surface reports exactly that set today — " +
          "`find_orphans` looks only at inbound links and ignores whether the " +
          "linking page still exists, and `memrain orphans` purges orphaned " +
          "database rows rather than pages.",
        collector: "usage-shape",
      });
    }
    if (dead > 0) {
      findings.push({
        id: "dead_links",
        severity: "info",
        title: `${dead} link${dead === 1 ? "" : "s"} point to a page that no longer exists.`,
        detail:
          "A link whose target was deleted or never created clutters the graph " +
          "and misleads traversal. Counted as: a `links` row from a live page " +
          "to a slug with no live page. No surface reports exactly that set " +
          "today — `memrain reconcile-links` checks wikilink entities against " +
          "documents, which is an adjacent but different condition.",
        collector: "usage-shape",
      });
    }
    return findings;
  },
};

/**
 * Chronicle health — two Life-Chronicle signals, both source-scoped to the
 * caller's read scope (never whole-brain: an entity slug is tenant-owned). With
 * no scope the collector stays silent (fail-closed). Each signal runs in its own
 * try/catch so a pre-migration brain (no ontology columns / no event_slug)
 * contributes nothing rather than aborting the report.
 *
 *   (a) unresolved ontology conflicts — an entity/dimension whose currently-open
 *       observations disagree (>=2 values from >=2 sources). A forward
 *       supersession closes the prior, so this is genuine standing disagreement,
 *       not a resolved change. Medium: it degrades entity-context resolution.
 *   (b) coverage gap — a recent (30d) conversation-shape page with no projected
 *       timeline events. Info: sweepable with the chronicle_backfill op (or by
 *       enabling MEMRAIN_AUTO_CHRONICLE). The eligible type/prefix shape mirrors
 *       chronicle/eligibility.ts (diary + event pages excluded).
 *
 * Scope resolution: an explicit `ctx.sourceIds` (a future scoped caller) always
 * wins. When it is absent the advisor is the operator (the `advisor` op is
 * operator-only), whose scope IS the whole brain — so we resolve every source
 * that owns pages or ontology rows. An empty brain resolves to no scope and the
 * collector stays silent.
 */
export const collectChronicle: AdvisorCollector = {
  id: "chronicle",
  collect: async (ctx) => {
    // An explicit `[]` is a caller with no grant — it stays empty and advises
    // nothing, never widening to the whole brain.
    let scope: string[] | null =
      ctx.sourceIds !== undefined ? [...ctx.sourceIds] : null;
    if (!scope) {
      scope = await resolveWholeBrainScope(ctx.engine);
    }
    if (!scope || scope.length === 0) return []; // no data in scope → nothing to advise
    const findings: AdvisorFinding[] = [];

    try {
      const r = await ctx.engine.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM (
           SELECT entity_slug, dimension
             FROM entity_facts
            WHERE dimension IS NOT NULL AND forgotten_at IS NULL AND valid_until IS NULL
              AND (dim_status IS NULL OR dim_status = 'active')
              AND confidence >= 0.5 AND source_id = ANY($1::text[])
            GROUP BY entity_slug, dimension
           HAVING count(DISTINCT value) >= 2 AND count(DISTINCT source_slug) >= 2
         ) t`,
        [scope],
      );
      const n = Number(r.rows[0]?.n ?? 0);
      if (n > 0) {
        findings.push({
          id: "ontology_conflicts",
          severity: "medium",
          title: `${n} entity dimension(s) have conflicting current values from multiple sources.`,
          detail:
            "Two or more open observations disagree, so entity context can't resolve to one value. Review the disagreements with the ontology_conflicts op.",
          fix_command: "ontology_conflicts",
          collector: "chronicle",
        });
      }
    } catch {
      /* entity_facts ontology columns absent (pre-migration) → no conflict finding */
    }

    try {
      const r = await ctx.engine.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pages p
          WHERE p.deleted_at IS NULL
            AND p.source_id = ANY($1::text[])
            AND p.updated_at > now() - interval '30 days'
            AND (p.type IN ('meeting','conversation','calendar-event')
                 OR p.slug LIKE 'meetings/%' OR p.slug LIKE 'conversations/%'
                 OR p.slug LIKE 'cal/%' OR p.slug LIKE 'calendar/%')
            AND p.type NOT IN ('diary','journal','event')
            AND p.slug NOT LIKE 'life/diary/%' AND p.slug NOT LIKE 'life/events/%'
            AND NOT EXISTS (
              SELECT 1 FROM timeline_events te
               WHERE te.slug = p.slug AND te.event_slug IS NOT NULL
                 AND te.source_id = ANY($1::text[])
            )`,
        [scope],
      );
      const gap = Number(r.rows[0]?.n ?? 0);
      if (gap > 0) {
        findings.push({
          id: "chronicle_coverage_gap",
          severity: "info",
          title: `${gap} recent conversation page(s) have no timeline events yet.`,
          detail:
            "Sweep them into the chronicle with the chronicle_backfill op, or enable MEMRAIN_AUTO_CHRONICLE so new pages project automatically.",
          fix_command: "chronicle_backfill",
          collector: "chronicle",
        });
      }
    } catch {
      /* timeline_events.event_slug absent (pre-migration) → no coverage finding */
    }

    return findings;
  },
};

/**
 * A retrieval-quality probe that measures nothing.
 *
 * The nightly probe replays `eval_queries`. When that set is empty it still
 * records a snapshot — by design, so "no eval set" stays distinguishable from
 * "probe never ran" — and the row reads `mean_rr=0 hit_rate=0 scored 0/0`
 * under `ok:true`. A passing run reporting zeros is the trap: it reads as a
 * measurement that came back empty-handed, when nothing was measured at all.
 *
 * A probe that throws records a `status = 'error'` row whose zeros measure
 * nothing; those rows are skipped here, so among the rest a recorded zero
 * means the eval set was empty, never that the probe broke.
 *
 * Silent when the probe has never run at all: `doctor` already reports that
 * case, and an advisor finding about a probe the owner has not set up yet is
 * noise, not a gap.
 */
export const collectEvalBlind: AdvisorCollector = {
  id: "eval-blind",
  collect: async (ctx) => {
    const snap = await latestEvalSnapshot(ctx.engine);
    if (!snap || snap.total_queries > 0 || snap.status === "error") return [];

    // How long we have been blind: zero-query snapshots newer than the last
    // probe that had queries to replay. The streak resets on `total_queries`,
    // not on `scored` — a run that replayed five queries and scored none did
    // measure; it just found nothing. That is a retrieval problem, and a
    // different finding from having no eval set at all.
    let nights = 0;
    try {
      const r = await ctx.engine.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM eval_snapshots
          WHERE total_queries = 0
            AND status <> 'error'
            AND ran_at > COALESCE(
                  (SELECT max(ran_at) FROM eval_snapshots WHERE total_queries > 0),
                  '-infinity'::timestamptz)`,
      );
      nights = Number(r.rows[0]?.n ?? 0);
    } catch {
      /* pre-migration brain → report the single snapshot we already read */
      nights = 1;
    }

    return [
      {
        id: "eval_set_empty",
        severity: "medium",
        title:
          `Retrieval quality is unmeasured — the nightly probe has recorded ` +
          `${nights} snapshot(s) over an empty eval set.`,
        detail:
          "The probe replays eval_queries; with none registered it scores 0/0 and still reports ok, so a run that measured nothing is filed as a run that passed. Register a handful of real questions with the document each one should surface, and the trend in doctor starts meaning something.",
        fix_command:
          'memrain eval-replay capture <id> --query "<a real question>" --tag good --expected-doc <document-id>',
        collector: "eval-blind",
      },
    ];
  },
};

/**
 * A take pipeline whose second half cannot fire yet.
 *
 * `propose-takes` writes on every synthesis tick; `grade-takes` only considers
 * takes older than the maturity bar (`MEMRAIN_GRADE_MIN_AGE_DAYS`, default 182 —
 * a claim about the future needs time to come true before judging it is worth
 * anything). On a brain younger than that bar, the producer runs nightly and
 * the grader selects nothing, silently, for months. Nothing said so: the phase
 * reports ok with zero grades written, which is indistinguishable from "there
 * was nothing new to grade".
 *
 * Fires only when the bar is what blocks it — takes exist and are otherwise
 * eligible, but not one is old enough. A brain with zero takes, or one where
 * at least one take has reached the bar, stays silent. It does NOT distinguish
 * already-graded takes: `graded` is an eligible status on purpose (a take
 * graded under an older prompt version is re-graded under the current one), so
 * an age-blocked pipeline is the only thing this reports.
 */
export const collectTakesUngradeable: AdvisorCollector = {
  id: "takes-ungradeable",
  collect: async (ctx) => {
    // A bar of 0 means "grade immediately, maturity is not a gate" — then an
    // age-blocked warning is meaningless by definition. Guard explicitly rather
    // than leaning on the SQL: a take dated in the future (clock skew, an
    // operator-authored row) fails `generated_at <= now()` even at 0, which
    // would fire this finding on a brain where age blocks nothing.
    const minAgeDays = gradeMinAgeDays();
    if (minAgeDays <= 0) return [];

    let pending = 0;
    let mature = 0;
    let daysUntilFirst = 0;
    try {
      const r = await ctx.engine.query<{
        pending: number;
        mature: number;
        days_until_first: number | null;
      }>(
        `SELECT count(*)::int AS pending,
                count(*) FILTER (
                  WHERE generated_at <= now() - ($1 * interval '1 day')
                )::int AS mature,
                -- The OLDEST take is the one that reaches the bar first, so it
                -- dates when grading resumes. max() would report the longest
                -- wait, not the next event.
                CEIL(
                  $1 - EXTRACT(EPOCH FROM (now() - min(generated_at))) / 86400
                )::int AS days_until_first
           FROM synth_takes
          WHERE status IN ('queued', 'graded', 'accepted')
            AND active
            AND resolved_at IS NULL`,
        [minAgeDays],
      );
      const row = r.rows[0];
      pending = Number(row?.pending ?? 0);
      mature = Number(row?.mature ?? 0);
      daysUntilFirst = Math.max(0, Number(row?.days_until_first ?? 0));
    } catch {
      /* pre-synthesis brain (no synth_takes table) → nothing to report */
      return [];
    }

    // Silent unless the age bar is the sole blocker: takes waiting, none mature.
    if (pending === 0 || mature > 0) return [];

    return [
      {
        id: "takes_ungradeable",
        severity: "medium",
        title:
          `${pending} unresolved take(s) and not one is old enough to grade — ` +
          `the oldest reaches the ${minAgeDays}-day bar in ${daysUntilFirst} day(s).`,
        detail:
          "propose-takes writes on every synthesis tick, but grade-takes only looks at takes past MEMRAIN_GRADE_MIN_AGE_DAYS, so the paid producer keeps running while the grader selects nothing and calibration keeps reading whatever stale grades already exist. Either lower the bar to match this brain's age, or stop proposing until grading can fire.",
        fix_command:
          "memrain (set MEMRAIN_GRADE_MIN_AGE_DAYS below the age of the oldest take, or drop propose-takes from the synthesis phases)",
        collector: "takes-ungradeable",
      },
    ];
  },
};

/**
 * Setup smells — config/env misconfigurations the owner usually wants to know
 * about. memrain has no DB config-key plane, so the one deterministic, security-
 * relevant smell is the internal-auth token being unset: with no
 * MEMRAIN_INTERNAL_TOKEN, any peer on the docker bridge can call write tools
 * unauthenticated (the public_guard's documented legacy fall-through).
 */
export const collectSetupSmells: AdvisorCollector = {
  id: "setup-smells",
  collect: async () => {
    const findings: AdvisorFinding[] = [];
    const internalToken = (process.env["MEMRAIN_INTERNAL_TOKEN"] ?? "").trim();
    if (internalToken.length === 0) {
      findings.push({
        id: "internal_token_unset",
        severity: "medium",
        title: "MEMRAIN_INTERNAL_TOKEN is unset — internal write tools are open on the bridge.",
        detail: "Without the shared token any peer on the docker bridge can call write tools with no auth. Set the secret and restart so the internal endpoint fails closed.",
        fix_command: "memrain (set MEMRAIN_INTERNAL_TOKEN from <secrets_prefix>/memrain-internal-token (legacy: memex-internal-token), then restart)",
        collector: "setup-smells",
      });
    }
    return findings;
  },
};
