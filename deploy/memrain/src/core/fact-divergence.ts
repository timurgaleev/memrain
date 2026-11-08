const NEGATIONS = new Set("no not never neither without cannot can't won't isn't aren't wasn't weren't doesn't don't didn't hasn't haven't hadn't nicht kein keine keinen keinem keiner keines nie ohne не нет никогда без".split(" "));
const DATE_WORDS = new Set((
  "january february march april may june july august september october november december " +
  "monday tuesday wednesday thursday friday saturday sunday today yesterday tomorrow " +
  "januar februar märz mai juni juli oktober dezember montag dienstag mittwoch donnerstag freitag samstag sonntag heute gestern morgen"
).split(" "));
const RUSSIAN_DATE = /^(?:январ|феврал|март|апрел|ма[йяе]|июн|июл|август|сентябр|октябр|ноябр|декабр|понедельник|вторник|сред[ауые]|четверг|пятниц|суббот|воскресень|сегодня|вчера|завтра)/u;

function protectedTerms(text: string): { negated: boolean; numbers: string[]; currency: string[]; dates: string[] } {
  const normalized = text.normalize("NFKC").toLowerCase().replaceAll("’", "'");
  const words = normalized.match(/[\p{L}]+(?:'[\p{L}]+)*/gu) ?? [];
  return {
    negated: words.some(word => NEGATIONS.has(word)),
    numbers: normalized.match(/(?<![\p{L}\p{N}_])[-+]?\d+(?:[.,]\d+)*(?:\s?(?:%|[kmb])(?![\p{L}\p{N}_]))?/gu) ?? [],
    currency: normalized.match(/[$€£¥]|\b(?:usd|eur|chf|gbp|jpy|rub|cad|aud|cny|ct|cents?)\b/gu) ?? [],
    dates: words.filter(word => DATE_WORDS.has(word) || RUSSIAN_DATE.test(word)).sort(),
  };
}

/** Conservative veto: different amounts, dates or polarity must survive dedup. */
export function claimsDiverge(left: string, right: string): boolean {
  const a = protectedTerms(left), b = protectedTerms(right);
  return a.negated !== b.negated || JSON.stringify(a.numbers) !== JSON.stringify(b.numbers)
    || JSON.stringify(a.currency) !== JSON.stringify(b.currency) || JSON.stringify(a.dates) !== JSON.stringify(b.dates);
}
