import type { Storage } from "./storage.ts";
import { getPage, validateSlug } from "./pages.ts";
import { makeSlugResolver } from "./slug-canonicalize.ts";
import { resolveSlugs } from "./slug-resolve.ts";
import { OperationError } from "./operation-error.ts";

export interface EntityResolutionFeedback {
  entity_slug?: string;
  entity_resolved_from?: string;
  notice?: "entity_unresolved";
  candidates?: string[];
}

export async function resolveFactEntity(storage: Storage, name: string, opts: {
  sourceIds?: string[]; remote: boolean; allowed?: (slug: string) => boolean;
}): Promise<{ slug: string; feedback: EntityResolutionFeedback }> {
  validateSlug(name);
  if (name.includes("/")) return { slug: name, feedback: {} };
  const permitted = async (slug: string): Promise<boolean> => {
    const page = await getPage(storage, slug, opts.sourceIds);
    if (!page) return false;
    return !opts.remote || (!slug.startsWith("life/diary/") && !["diary", "journal"].includes(page.type.trim().toLowerCase()));
  };
  const resolved = await makeSlugResolver(storage, "", { sourceIds: opts.sourceIds }).resolve(name);
  if (resolved.resolved && await permitted(resolved.slug)) {
    if (opts.allowed && !opts.allowed(resolved.slug)) throw new OperationError("permission_denied",
      "The resolved entity is outside the permitted slug prefixes.", "Use an entity within your credential's slug prefixes.");
    return { slug: resolved.slug, feedback: resolved.slug === name ? {} : { entity_slug: resolved.slug, entity_resolved_from: name } };
  }
  const matches = await resolveSlugs(storage, name, { sourceIds: opts.sourceIds, limit: 5 });
  const candidates: string[] = [];
  for (const match of matches) if ((!opts.allowed || opts.allowed(match.slug)) && await permitted(match.slug)) candidates.push(match.slug);
  return { slug: name, feedback: { entity_slug: name, notice: "entity_unresolved", candidates } };
}
