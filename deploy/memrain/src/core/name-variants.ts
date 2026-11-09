import type { Engine } from "./engine/interface.ts";
import { andSourceScope } from "./source-scope.ts";
import { liveEndpointSql } from "./links.ts";

const DIMINUTIVES: Readonly<Record<string, readonly string[]>> = {
  \u0441\u0430\u0448\u0430: ["\u0430\u043B\u0435\u043A\u0441\u0430\u043D\u0434\u0440", "\u0430\u043B\u0435\u043A\u0441\u0430\u043D\u0434\u0440\u0430"], \u0448\u0443\u0440\u0430: ["\u0430\u043B\u0435\u043A\u0441\u0430\u043D\u0434\u0440", "\u0430\u043B\u0435\u043A\u0441\u0430\u043D\u0434\u0440\u0430"],
  \u0436\u0435\u043d\u044f: ["\u0435\u0432\u0433\u0435\u043D\u0438\u0439", "\u0435\u0432\u0433\u0435\u043D\u0438\u044F"], \u043c\u0438\u0448\u0430: ["\u043C\u0438\u0445\u0430\u0438\u043B"], \u0434\u0438\u043c\u0430: ["\u0434\u043C\u0438\u0442\u0440\u0438\u0439"],
  \u043b\u0435\u0448\u0430: ["\u0430\u043B\u0435\u043A\u0441\u0435\u0439"], \u0430\u043b\u0435\u0448\u0430: ["\u0430\u043B\u0435\u043A\u0441\u0435\u0439"], \u043a\u043e\u043b\u044f: ["\u043D\u0438\u043A\u043E\u043B\u0430\u0439"],
  \u043f\u0435\u0442\u044f: ["\u043F\u0435\u0442\u0440"], \u0432\u0430\u043d\u044f: ["\u0438\u0432\u0430\u043D"], \u0441\u0435\u0440\u0435\u0436\u0430: ["\u0441\u0435\u0440\u0433\u0435\u0439"], \u0430\u043d\u0434\u0440\u044e\u0448\u0430: ["\u0430\u043D\u0434\u0440\u0435\u0439"],
  \u0432\u043e\u043b\u043e\u0434\u044f: ["\u0432\u043B\u0430\u0434\u0438\u043C\u0438\u0440"], \u0432\u043e\u0432\u0430: ["\u0432\u043B\u0430\u0434\u0438\u043C\u0438\u0440"], \u043a\u043e\u0441\u0442\u044f: ["\u043A\u043E\u043D\u0441\u0442\u0430\u043D\u0442\u0438\u043D"],
  \u043a\u0430\u0442\u044f: ["\u0435\u043A\u0430\u0442\u0435\u0440\u0438\u043D\u0430"], \u043d\u0430\u0442\u0430\u0448\u0430: ["\u043D\u0430\u0442\u0430\u043B\u044C\u044F", "\u043D\u0430\u0442\u0430\u043B\u0438\u044F"], \u043b\u0435\u043d\u0430: ["\u0435\u043B\u0435\u043D\u0430"],
  \u043e\u043b\u044f: ["\u043E\u043B\u044C\u0433\u0430"], \u043c\u0430\u0448\u0430: ["\u043C\u0430\u0440\u0438\u044F"], \u0442\u0430\u043d\u044f: ["\u0442\u0430\u0442\u044C\u044F\u043D\u0430"],
  \u0441\u043b\u0430\u0432\u0430: ["\u0432\u044F\u0447\u0435\u0441\u043B\u0430\u0432", "\u0432\u043B\u0430\u0434\u0438\u0441\u043B\u0430\u0432", "\u0441\u0432\u044F\u0442\u043E\u0441\u043B\u0430\u0432", "\u044F\u0440\u043E\u0441\u043B\u0430\u0432"],
};

function words(name: string): string[] {
  if (name.length > 200) return [];
  return name.normalize("NFKC").toLowerCase().replace(/\u0451/g, "\u0435")
    .replace(/^(?:(?:mr|mrs|ms|dr|prof|\u0433-\u043D|\u0433-\u0436\u0430|\u0434\u043E\u043A\u0442\u043E\u0440)\.?\s+)+/u, "")
    .replace(/[.,]/g, " ").trim().split(/\s+/).filter(Boolean);
}

const expansions = (word: string): readonly string[] => DIMINUTIVES[word] ?? [word];

function oneEdit(a: string, b: string): boolean {
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
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
  return expansions(a).some(x => expansions(b).includes(x)) || oneEdit(a, b);
}

/** Strong matches retain a complete surname; a bare nickname is read-only. */
export function nameVariantMatch(query: string, title: string): "strong" | "weak" | null {
  const a = words(query); const b = words(title);
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
