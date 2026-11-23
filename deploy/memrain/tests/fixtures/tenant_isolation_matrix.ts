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
import { GATEWAY, KEYWORD, SHARED_PATH, SHARED_TITLE, WIKI_NAME } from "../helpers/tenant_seed.ts";

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
  iso("search_exact", { phrase: "SECRET_NOTES_BODY" }, "AAA_SECRET_NOTES_BODY"),
  iso("search", { q: KEYWORD }),
  write("index"),
  iso("backlinks", { name: WIKI_NAME }),
  op("stats"),
  write("page_put"),
  write("page_append"),
  write("page_edit"),
  write("page_rename"),
  write("page_delete"),
  write("page_restore"),
  write("page_revert"),
  iso("page_get", { slug: "team-b/alice" }),
  iso("page_list"),
  iso("page_versions", { slug: "team-b/alice" }),
  write("link"),
  write("unlink"),
  iso("get_chunks", { source_path: SHARED_PATH }),
  iso("resolve_slugs", { query: SHARED_TITLE }, "team-a/alice"),
  write("add_tag"),
  write("remove_tag"),
  iso("get_tags", { slug: "team-b/alice" }),
  iso("get_links", { slug: GATEWAY }, "vault-a/target"),
  wide("get_brain_identity", "brain-level identity card, no tenant content"),
  wide("whoami", "echoes the caller's own grant"),
  write("purge_deleted_pages"),
  iso("sources_list"),
  iso("sources_status", { id: "tenantB" }),
  op("run_doctor"),
];
