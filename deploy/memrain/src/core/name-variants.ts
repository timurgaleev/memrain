import type { Engine } from "./engine/interface.ts";
import { andSourceScope } from "./source-scope.ts";
import { liveEndpointSql } from "./links.ts";

const DIMINUTIVES: Readonly<Record<string, readonly string[]>> = {
  саша: ["александр", "александра"], шура: ["александр", "александра"],
  женя: ["евгений", "евгения"], миша: ["михаил"], дима: ["дмитрий"],
  леша: ["алексей"], алеша: ["алексей"], коля: ["николай"],
  петя: ["петр"], ваня: ["иван"], сережа: ["сергей"], андрюша: ["андрей"],
  володя: ["владимир"], вова: ["владимир"], костя: ["константин"],
  катя: ["екатерина"], наташа: ["наталья", "наталия"], лена: ["елена"],
  оля: ["ольга"], маша: ["мария"], таня: ["татьяна"],
  слава: ["вячеслав", "владислав", "святослав", "ярослав"],
};

function words(name: string): string[] {
  if (name.length > 200) return [];
  return name.normalize("NFKC").toLowerCase().replace(/ё/g, "е")
    .replace(/^(?:(?:mr|mrs|ms|dr|prof|г-н|г-жа|доктор)\.?\s+)+/u, "")
    .replace(/[.,]/g, " ").trim().split(/\s+/).filter(Boolean);
}

const expansions = (word: string): readonly string[] => DIMINUTIVES[word] ?? [word];

function oneEdit(a: string, b: string): boolean {
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length <= b.length) j++;
    if (a.length >= b.length) i++;
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function givenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if ((a.length === 1 || b.length === 1) && a[0] === b[0]) return true;
  return expansions(a).some(x => expansions(b).some(y => x === y)) || oneEdit(a, b);
}

/** Strong matches retain a complete surname; a bare nickname is read-only. */
export function nameVariantMatch(query: string, title: string): "strong" | "weak" | null {
  const a = words(query), b = words(title);
  if (b.length < 2 || b.length > 3) return null;
  if (a.length === 1 && DIMINUTIVES[a[0]!]) {
    return expansions(a[0]!).some(w => expansions(b[0]!).includes(w)) ? "weak" : null;
  }
  if (a.length < 2 || a.length > 3 || ![...a, ...b].every(w => /^[\p{L}-]+$/u.test(w))) return null;
  // When both names carry a middle name/patronymic, it must agree too.
  if (a.length === 3 && b.length === 3 && !givenMatch(a[1]!, b[1]!)) return null;
  const endpoints = (w: string[]) => [[w[0]!, w[w.length - 1]!], [w[w.length - 1]!, w[0]!]] as const;
  return endpoints(a).some(([given, surname]) => surname.length > 1 &&
    surname === b[b.length - 1] && givenMatch(given, b[0]!)) ? "strong" : null;
}

export function canMatchPersonName(name: string): boolean {
  const w = words(name);
  return (w.length >= 2 && w.length <= 3) || (w.length === 1 && !!DIMINUTIVES[w[0]!]);
}

export function personNameBucketKeys(name: string): string[] {
  const w = words(name);
  return w.length >= 2 && w.length <= 3 ? [...new Set([w[0]!, w[w.length - 1]!])] : [];
}

export interface PersonName { slug: string; title: string; source_id: string }

/** A partial candidate set must never establish uniqueness on the write path. */
export async function readPersonNames(engine: Engine, sourceIds?: string[]): Promise<{ people: PersonName[]; truncated: boolean }> {
  const params: unknown[] = [];
  const scope = andSourceScope("p.source_id", sourceIds, params);
  const { rows } = await engine.query<PersonName>(
    `SELECT p.slug, p.title, p.source_id FROM pages p
      WHERE p.deleted_at IS NULL AND lower(btrim(p.type)) = 'person' AND p.title IS NOT NULL
        AND p.slug NOT LIKE 'life/diary/%' AND ${liveEndpointSql("p.slug")}${scope}
      ORDER BY p.slug COLLATE "C" LIMIT 2001`, params,
  );
  return { people: rows.slice(0, 2000), truncated: rows.length > 2000 };
}
