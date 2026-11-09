const NEGATIONS = new Set("no not never neither without cannot can't won't isn't aren't wasn't weren't doesn't don't didn't hasn't haven't hadn't nicht kein keine keinen keinem keiner keines nie ohne \u043d\u0435 \u043d\u0435\u0442 \u043d\u0438\u043a\u043e\u0433\u0434\u0430 \u0431\u0435\u0437".split(" "));
const DATE_WORDS = new Set((
  "january february march april may june july august september october november december " +
  "monday tuesday wednesday thursday friday saturday sunday today yesterday tomorrow " +
  "januar februar märz mai juni juli oktober dezember montag dienstag mittwoch donnerstag freitag samstag sonntag heute gestern morgen"
).split(" "));
const RUSSIAN_DATE = /^(?:\u044f\u043d\u0432\u0430\u0440|\u0444\u0435\u0432\u0440\u0430\u043b|\u043c\u0430\u0440\u0442|\u0430\u043f\u0440\u0435\u043b|\u043c\u0430[\u0439\u044f\u0435]|\u0438\u044e\u043d|\u0438\u044e\u043b|\u0430\u0432\u0433\u0443\u0441\u0442|\u0441\u0435\u043d\u0442\u044f\u0431\u0440|\u043e\u043a\u0442\u044f\u0431\u0440|\u043d\u043e\u044f\u0431\u0440|\u0434\u0435\u043a\u0430\u0431\u0440|\u043f\u043e\u043d\u0435\u0434\u0435\u043b\u044c\u043d\u0438\u043a|\u0432\u0442\u043e\u0440\u043d\u0438\u043a|\u0441\u0440\u0435\u0434[\u0430\u0443\u044b\u0435]|\u0447\u0435\u0442\u0432\u0435\u0440\u0433|\u043f\u044f\u0442\u043d\u0438\u0446|\u0441\u0443\u0431\u0431\u043e\u0442|\u0432\u043e\u0441\u043a\u0440\u0435\u0441\u0435\u043d\u044c|\u0441\u0435\u0433\u043e\u0434\u043d\u044f|\u0432\u0447\u0435\u0440\u0430|\u0437\u0430\u0432\u0442\u0440\u0430)/u;

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
