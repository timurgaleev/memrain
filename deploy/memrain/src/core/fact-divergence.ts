const NEGATIONS = new Set("no not never neither without cannot can't won't isn't aren't wasn't weren't doesn't don't didn't hasn't haven't hadn't nicht kein keine keinen keinem keiner keines nie ohne \u043D\u0435 \u043D\u0435\u0442 \u043D\u0438\u043A\u043E\u0433\u0434\u0430 \u0431\u0435\u0437".split(" "));
const DATE_WORDS = new Set((
  "january february march april may june july august september october november december " +
  "monday tuesday wednesday thursday friday saturday sunday today yesterday tomorrow " +
  "januar februar märz mai juni juli oktober dezember montag dienstag mittwoch donnerstag freitag samstag sonntag heute gestern morgen"
).split(" "));
const RUSSIAN_DATE = /^(?:\u044F\u043D\u0432\u0430\u0440|\u0444\u0435\u0432\u0440\u0430\u043B|\u043C\u0430\u0440\u0442|\u0430\u043F\u0440\u0435\u043B|\u043C\u0430[\u0439\u044F\u0435]|\u0438\u044E\u043D|\u0438\u044E\u043B|\u0430\u0432\u0433\u0443\u0441\u0442|\u0441\u0435\u043D\u0442\u044F\u0431\u0440|\u043E\u043A\u0442\u044F\u0431\u0440|\u043D\u043E\u044F\u0431\u0440|\u0434\u0435\u043A\u0430\u0431\u0440|\u043F\u043E\u043D\u0435\u0434\u0435\u043B\u044C\u043D\u0438\u043A|\u0432\u0442\u043E\u0440\u043D\u0438\u043A|\u0441\u0440\u0435\u0434[\u0430\u0443\u044B\u0435]|\u0447\u0435\u0442\u0432\u0435\u0440\u0433|\u043F\u044F\u0442\u043D\u0438\u0446|\u0441\u0443\u0431\u0431\u043E\u0442|\u0432\u043E\u0441\u043A\u0440\u0435\u0441\u0435\u043D\u044C|\u0441\u0435\u0433\u043E\u0434\u043D\u044F|\u0432\u0447\u0435\u0440\u0430|\u0437\u0430\u0432\u0442\u0440\u0430)/u;

function protectedTerms(text: string): { negated: boolean; numbers: string[]; currency: string[]; dates: string[] } {
  const normalized = text.normalize("NFKC").toLowerCase().replaceAll("’", "'");
  const words = normalized.match(/\p{L}+(?:'\p{L}+)*/gu) ?? [];
  return {
    negated: words.some(word => NEGATIONS.has(word)),
    numbers: normalized.match(/(?<![\p{L}\p{N}_])[-+]?\d+(?:[.,]\d+)*(?:\s?[%kmb](?![\p{L}\p{N}_]))?/gu) ?? [],
    currency: normalized.match(/[$€£¥]|\b(?:usd|eur|chf|gbp|jpy|rub|cad|aud|cny|ct|cents?)\b/gu) ?? [],
    dates: words.filter(word => DATE_WORDS.has(word) || RUSSIAN_DATE.test(word)).sort(),
  };
}

/** Conservative veto: different amounts, dates or polarity must survive dedup. */
export function claimsDiverge(left: string, right: string): boolean {
  const a = protectedTerms(left); const b = protectedTerms(right);
  return a.negated !== b.negated || JSON.stringify(a.numbers) !== JSON.stringify(b.numbers)
    || JSON.stringify(a.currency) !== JSON.stringify(b.currency) || JSON.stringify(a.dates) !== JSON.stringify(b.dates);
}
