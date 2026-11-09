import { getSkillDetail, listSkillCatalog, type SkillCatalogOptions } from "./brain-resident.ts";
import { parseSkillFrontmatter } from "./frontmatter.ts";

export function getSkillPrompt(name: string, opts: SkillCatalogOptions = {}) {
  if (!/^[a-z0-9][\w-]{0,127}$/i.test(name)) return null;
  const skill = getSkillDetail(name, opts);
  if (!skill || skill.unavailable_tools.length) return null;
  const fm = parseSkillFrontmatter(skill.body);
  if (fm?.scalars.prompt !== "true") return null;
  return { description: skill.description.slice(0, 500),
    messages: [{ role: "user" as const, content: { type: "text" as const, text: fm.body } }] };
}

export function listSkillPrompts(opts: SkillCatalogOptions = {}, cursor?: string) {
  const eligible = listSkillCatalog(opts).skills
    .filter(skill => cursor === undefined || skill.slug > cursor)
    .flatMap(skill => {
      const prompt = getSkillPrompt(skill.slug, opts);
      return prompt ? [{ name: skill.slug, description: prompt.description }] : [];
    });
  const prompts = eligible.slice(0, 50);
  return { prompts, ...(eligible.length > 50 ? { nextCursor: prompts.at(-1)!.name } : {}) };
}
