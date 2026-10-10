/**
 * Isolation disposition for EVERY MCP operation. `tenant_isolation_matrix.test.ts`
 * fails when an operation is added without a row, so a new read tool cannot
 * ship without saying how it treats another tenant's data.
 *
 *   isolated       seeded tenant-B data is visible to the operator and must never
 *                  reach a tenant-A caller or a caller with no grant
 *   brainwide      carries no tenant content (identity, skills, schema); must
 *                  answer scoped callers without throwing
 *   operator_only  refused to any token caller (OPERATOR_ONLY_TOOLS)
 *   write          mutates (WRITE_SCOPED_TOOLS); write isolation lives in the
 *                  tenant_write_* suites
 *   skip           cannot be seeded hermetically here; `owner` names the suite
 *                  that covers its scoping
 *
 * An isolated row's `own` names the tenant-A token its positive control must
 * return, for reads where other tenant-A tokens would satisfy it without it.
 */
import {
  CODE_SYM, ENTITY_SLUG, GATEWAY, KEYWORD, SHARED_PATH, SHARED_TITLE, WIKI_NAME,
} from "../helpers/tenant_seed.ts";

export type MatrixRow =
  | { name: string; mode: "isolated"; args: Record<string, unknown>; own?: string }
  | { name: string; mode: "brainwide"; args: Record<string, unknown>; rationale: string }
  | { name: string; mode: "operator_only" }
  | { name: string; mode: "write" }
  | { name: string; mode: "skip"; reason: string; owner: string };

const iso = (name: string, args: Record<string, unknown> = {}, own?: string): MatrixRow =>
  ({ name, mode: "isolated", args, ...(own ? { own } : {}) });
const wide = (name: string, rationale: string, args: Record<string, unknown> = {}): MatrixRow => ({ name, mode: "brainwide", args, rationale });
const op = (name: string): MatrixRow => ({ name, mode: "operator_only" });
const write = (name: string): MatrixRow => ({ name, mode: "write" });
const skip = (name: string, reason: string, owner: string): MatrixRow => ({ name, mode: "skip", reason, owner });

export const TENANT_B_TOKENS = [
  "BBB_", "chargeCardBBB", "callerBBB", "KANGA_SECRET_BBB", "doc-b-", "vault-b/", "team-b/", "hub-b", "spoke-b", "claim-b",
  "tenantB", "/tenant-b",
];

// A caller with no grant must not see the operator's view of tenant A either.
export const TENANT_A_TOKENS = [
  "AAA_", "chargeCardAAA", "callerAAA", "KANGA_SECRET_AAA", "doc-a-", "vault-a/", "team-a/", "hub-a", "spoke-a", "claim-a",
  "tenantA", "/tenant-a",
];

export const MATRIX: MatrixRow[] = [
  iso("search", { q: KEYWORD }),
  write("index"),
  iso("backlinks", { name: WIKI_NAME }),
  op("stats"),
  iso("source_health"),
  write("log_friction"),
  write("page_put"),
  write("page_append"),
  write("page_edit"),
  write("page_delete"),
  write("page_restore"),
  write("page_revert"),
  iso("page_get", { slug: "team-b/alice" }),
  iso("page_list"),
  iso("page_versions", { slug: "team-b/alice" }),
  write("link"),
  write("unlink"),
  iso("graph_neighbors", { slug: GATEWAY }, "vault-a/target"),
  iso("graph_query", { type: "mentions", source_slug: GATEWAY }, "vault-a/target"),
  iso("traverse_graph", { start_slug: GATEWAY, direction: "outbound", max_depth: 3 }, "vault-a/target"),
  write("add_fact"),
  write("add_timeline_event"),
  iso("entity_facts", { entity_slug: ENTITY_SLUG }),
  iso("fact_supersessions", { limit: 500 }),
  iso("entity_timeline", { slug: ENTITY_SLUG }),
  iso("entity_recall", { slug: ENTITY_SLUG }),
  op("jobs_submit"),
  op("jobs_cancel"),
  op("jobs_list"),
  op("jobs_get"),
  op("jobs_logs"),
  skip("submit_agent", "runs an agent job under the caller's grant; needs a worker and a scripted model", "tests/agent_tenant.test.ts"),
  skip("get_agent_job", "reads only the caller's own agent jobs; needs a submitted job", "tests/agent_tenant.test.ts"),
  iso("get_chunks", { source_path: SHARED_PATH }),
  iso("resolve_slugs", { query: SHARED_TITLE }, "team-a/alice"),
  write("add_tag"),
  write("remove_tag"),
  iso("get_tags", { slug: "team-b/alice" }),
  skip("relational_recall", "needs typed relation edges between named entities", "tests/tenant_isolation.test.ts"),
  iso("get_links", { slug: GATEWAY }, "vault-a/target"),
  skip("list_link_sources", "returns per-type counts only, no token to observe", "tests/tenant_isolation_contract.test.ts"),
  iso("find_orphans"),
  iso("find_experts", { limit: 5 }, "hub-a"),
  iso("find_contradictions", {}, "claim-a1"),
  iso("find_trajectory", { entity_slug: ENTITY_SLUG }),
  iso("get_recent_salience", { limit: 100 }, "hub-a"),
  iso("find_anomalies", { sigma: 1, limit: 50 }, "hub-a"),
  iso("recall", { id: "$factIdB" }),
  write("forget_fact"),
  wide("get_brain_identity", "brain-level identity card, no tenant content"),
  wide("whoami", "echoes the caller's own grant"),
  write("purge_deleted_pages"),
  iso("query", { q: KEYWORD }),
  iso("code_callers", { name: CODE_SYM }, "callerAAA"),
  iso("code_callees", { target: `${SHARED_PATH}:2` }, "chargeCardAAA"),
  iso("code_def", { name: CODE_SYM }),
  iso("code_refs", { name: CODE_SYM }),
  iso("code_blast", { symbol: CODE_SYM, exact: true }, "callerAAA"),
  iso("code_flow", { symbol: CODE_SYM, exact: true }, "chargeCardAAA"),
  iso("volunteer_context", { window: `talking about ${WIKI_NAME} and ${SHARED_TITLE}` }),
  iso("context_pack", { slugs: [ENTITY_SLUG, "team-b/alice"], window: `talking about ${WIKI_NAME} and ${SHARED_TITLE}` }),
  op("advisor"),
  wide("list_brain_skillpack", "repo skill pack, no tenant content"),
  op("list_concepts"),
  iso("list_takes"),
  write("set_take_status"),
  iso("takes_search", { q: "claim" }),
  skip("get_calibration_profile", "needs graded takes and a computed profile", "tests/synthesis_calibration.test.ts"),
  skip("takes_scorecard", "needs resolved, graded takes", "tests/synthesis_takes_scorecard.test.ts"),
  skip("takes_calibration", "needs resolved, graded takes", "tests/synthesis_takes_scorecard.test.ts"),
  write("extract_facts"),
  wide("list_skills", "repo skill pack, no tenant content"),
  wide("get_skill", "repo skill pack, no tenant content", { name: "memex-search" }),
  iso("get_recent_transcripts", { days: 3650 }),
  write("think"),
  write("put_raw_data"),
  iso("get_raw_data", { slug: "team-b/alice" }),
  write("log_ingest"),
  iso("get_ingest_log"),
  write("retry_job"),
  op("get_job_progress"),
  iso("sources_list"),
  iso("sources_status", { id: "tenantB" }),
  op("get_status_snapshot"),
  op("run_doctor"),
  iso("chronicle_day", { date: "$recentDate" }),
  iso("chronicle_since", { since: "2020-01-01", limit: 500 }),
  iso("chronicle_on_this_day", { date: "$nextYearDate" }),
  skip("chronicle_last_seen", "returns a date only, no token to observe", "tests/chronicle_timeline.test.ts"),
  iso("ontology_get", { entity: ENTITY_SLUG }),
  write("ontology_propose"),
  wide("ontology_dimensions", "dimension vocabulary, no tenant content"),
  skip("ontology_conflicts", "needs two concurrently active values, which a propose supersedes", "tests/ontology_facts.test.ts"),
  iso("volunteer_chronicle", { days: 50 }),
  write("chronicle_backfill"),
];
