/**
 * Remove online-meeting credentials from connector text: join links, meeting
 * ids, passcodes, dial-in PINs and one-tap dial strings, in English, German and
 * Russian invitations from Teams, Zoom, Webex and Google Meet, plus a password
 * or card PIN a mail spells out under a label. Pure and idempotent.
 *
 * The general credential scanner (secret-scan.ts) looks for high-entropy
 * tokens and keyword assignments of twelve or more characters, so a six-digit
 * passcode, a grouped meeting id or a `Passwort:` line passes it. These rules
 * are scoped to connector text instead of joining that scanner: its markers
 * carry a fingerprint, and a fingerprint of a short value can be reversed by
 * trying every value. Here the label stays and the value becomes a fixed
 * marker that says nothing about it.
 *
 * Every pattern starts at a literal label or a meeting host and bounds its
 * tail, so the time taken grows linearly with the text. An HTML invitation
 * puts a label and its value in separate cells, which htmlToText turns into
 * separate lines, so a labelled value may sit on the next line.
 */

export const REMOVED = "[removed]";
export const LINK_REMOVED = "[meeting link removed]";

const SP = "[ \\t\\u00A0\\u202F]";
/** The same line, or the next one with one blank line allowed. */
const GAP = `${SP}{0,8}(?:\\r?\\n${SP}{0,8}){0,2}`;
/** An id: 6 to 20 digits, grouped by one space, dot or hyphen, with an optional `#`. */
const ID_DIGITS = `\\d(?:[ \\u00A0\\u202F.-]?\\d){5,19}#?`;
const PIN_DIGITS = `\\d(?:[ \\u00A0\\u202F]?\\d){3,19}#?`;
/** A passcode spelled in digit groups up to the end of its line (Zoom's `1234 5678`). */
const CODE_GROUPS = `\\d{2,10}(?:[ \\u00A0\\u202F]\\d{2,10}){1,3}(?=${SP}*(?:\\r?\\n|$))`;
/** One token; never a marker this module or the scanner wrote, since those start with `[`. */
const TOKEN = `[^\\s[\\]<>()"']{3,64}`;
const PAREN = `(?:${SP}{0,4}\\([^()\\n]{1,40}\\))?`;
const COLON = `${SP}{0,3}[:：]`;
const LINE_END = `${SP}*(?:\\r?\\n|$)`;
const URL_TAIL = `[^\\s"'<>)\\]]`;

const ID_LABELS = [
  "Meeting[ -]?ID", "Meeting number", "Meeting-Kennnummer", "Meetingnummer", "Webinar[ -]ID",
  "Phone conference ID", "Conference ID", "Besprechungs-ID", "Konferenz-ID", "Telefonkonferenz-ID",
  "(?:Meeting|Besprechungs|Konferenz)-?kennung", "Access code", "Zugriffscode",
  "Идентификатор (?:собрания|(?:телефонной )?конференции|встречи|совещания)", "(?:ID|ИД) (?:собрания|конференции|встречи)",
  "Номер (?:конференции|совещания|собрания)", "Код конференции",
].join("|");
/** Labels that only ever name a meeting passcode. */
const CODE_LABELS = ["Numeric passcode", "Passcode", "Kenncode", "Секретный код"].join("|");
/** Labels that name a secret anywhere: the colon is required and the value must end its line. */
const SECRET_LABELS = [
  "Meeting password", "Meeting-Passwort", "Password", "Passwort", "Kennwort", "Zugangscode",
  "Пароль(?: (?:конференции|совещания|собрания))?", "Код доступа",
].join("|");
const PIN_LABELS = ["PIN(?:-Code|-код)?", "ПИН(?:-код)?"].join("|");

type Replace = (match: string, groups: Array<string | undefined>) => string;

interface Rule {
  re: RegExp;
  replace: Replace;
  /** Matched at a label, which must start a word: `Kennung` in `Benutzerkennung` stays. */
  labelled?: true;
}

const link: Replace = () => LINK_REMOVED;
const keepPrefix: Replace = (_m, [prefix]) => `${prefix}${REMOVED}`;
const keepLabel: Replace = (_m, [label, gap]) => `${label}${gap}${REMOVED}`;

/** A value that starts with a date, which digit grouping alone would read as an id: `2026-11-17 10:00`, `17.11.2026`. */
const DATE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{4})(?!\d)/;
/** A label left empty above a sign-off (`Password:` then `Thanks,`) gives the sign-off no value role. */
const signOffBelow = (gap: string | undefined, value: string | undefined) => /\n/.test(gap ?? "") && /^\p{L}+,$/u.test(value ?? "");

const RULES: readonly Rule[] = [
  // Join links: the link itself carries the meeting id, and often the passcode.
  // A Teams link that names the meeting thread goes too: behind the web client
  // or launcher, and the organizer's "Meeting options" link, whose organizer,
  // tenant and thread ids are all a join link is built from.
  {
    re: new RegExp(`https?:\\/\\/teams\\.(?:microsoft|live)\\.com\\/(?:meet\\/|${URL_TAIL}{0,512}?(?:meetup-join|meetingOptions))${URL_TAIL}{0,2048}`, "gi"),
    replace: link,
  },
  { re: new RegExp(`https?:\\/\\/(?:[\\w-]{1,63}\\.){0,4}zoom(?:gov)?\\.us\\/(?:[jsw]|wc\\/join|my|skype)\\/${URL_TAIL}{1,2048}`, "gi"), replace: link },
  { re: new RegExp(`https?:\\/\\/(?:[\\w-]{1,63}\\.){1,4}webex\\.com\\/${URL_TAIL}{0,512}(?:MTID=|\\/j\\.php|\\/meet\\/)${URL_TAIL}{0,2048}`, "gi"), replace: link },
  { re: new RegExp(`(?:https?:\\/\\/)?(?:meet\\.google\\.com|tel\\.meet)\\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[?#]${URL_TAIL}{0,512})?`, "gi"), replace: link },
  // The same links wrapped by a mail gateway (Outlook Safe Links), percent-encoded.
  {
    re: new RegExp(`https?:\\/\\/${URL_TAIL}{0,512}?(?:teams\\.(?:microsoft|live)\\.com|zoom(?:gov)?\\.us)(?:%2F|\\/)(?:l(?:%2F|\\/)meetup-join|meetingOptions|meet|j|w|wc(?:%2F|\\/)join|skype)(?:%2F|\\/)${URL_TAIL}{0,2048}`, "gi"),
    replace: link,
  },
  // A wrapped Meet code or Webex meeting key, wherever the gateway put it.
  { re: /((?:meet\.google\.com|tel\.meet)%2F)[a-z]{3}-[a-z]{4}-[a-z]{3}/gi, replace: keepPrefix },
  { re: /(MTID(?:=|%3D))[0-9a-z]{8,128}/gi, replace: keepPrefix },
  // Teams dial-in pages ("Find a local number", VTC instructions) carry the conference id.
  { re: new RegExp(`(dialin\\.teams\\.microsoft\\.com\\/${URL_TAIL}{0,200}?[?&]id=)\\d{5,20}`, "gi"), replace: keepPrefix },
  // SIP addresses: Zoom's `<id>[.<passcode>]@zoomcrc.com`, a Webex video system's `<number>@<site>.webex.com`.
  { re: /(?<![\w.])\d{9,11}(?:\.{1,2}[\w-]{1,64}){0,2}(@zoomcrc\.com)/gi, replace: (_m, [host]) => `${REMOVED}${host}` },
  { re: /(?<![\w.])\d{9,12}(@(?:[\w-]{1,63}\.){1,4}webex\.com)/gi, replace: (_m, [host]) => `${REMOVED}${host}` },
  // A passcode or PIN in any other link, an account login link too.
  { re: /([?&;]pwd=)[^\s&#"'<>()[\]]{1,256}/gi, replace: keepPrefix },
  { re: /([?&;]pin=)\d{3,20}/gi, replace: keepPrefix },
  // One-tap dial strings: the bridge number stays; `,,<id>#`, Webex's `<password>#`
  // straight after it and Zoom's `,,,,*<passcode>#` go.
  { re: /(\d)(,{2,8}\d{3,20}#(?:\*?\d{3,20}#)?(?:,{1,8}\*?\d{3,20}#?){0,2})/g, replace: (_m, [digit]) => `${digit},,${REMOVED}` },
  // Labelled meeting ids, digits only.
  {
    re: new RegExp(`(${ID_LABELS})(${PAREN}(?:${COLON})?${GAP})(${ID_DIGITS})`, "gi"),
    replace: (m, [label, gap, value]) => (DATE.test(value ?? "") ? m : `${label}${gap}${REMOVED}`),
    labelled: true,
  },
  // Meeting passcodes. Without a digit the value counts only after a colon and
  // when it ends its line, so "Passcode protected meeting" stays prose.
  {
    re: new RegExp(`(${CODE_LABELS})(${PAREN}(${COLON})?${GAP})(${CODE_GROUPS}|${TOKEN})(?=(${LINE_END})|\\s)`, "gi"),
    replace: (m, [label, gap, colon, value, lineEnd]) =>
      !signOffBelow(gap, value) && (/\d/.test(value ?? "") || (colon !== undefined && lineEnd !== undefined)) ? `${label}${gap}${REMOVED}` : m,
    labelled: true,
  },
  // A labelled password; Webex adds the phone passcode in brackets after it.
  {
    re: new RegExp(`(${SECRET_LABELS})(${PAREN}${COLON}${GAP})(${TOKEN})(${SP}{1,4}\\(\\d{4,16}[^()\\n]{0,60}\\))?(?=${LINE_END}|${SP}{1,4}\\()`, "gi"),
    replace: (m, [label, gap, value, phone]) =>
      signOffBelow(gap, value) ? m : `${label}${gap}${REMOVED}${phone === undefined ? "" : phone.replace(/\d+/, REMOVED)}`,
    labelled: true,
  },
  // A labelled PIN. Case-sensitive, so "pin" in a word or in prose stays.
  { re: new RegExp(`(${PIN_LABELS})(${COLON}${GAP})(${PIN_DIGITS})`, "g"), replace: keepLabel, labelled: true },
];

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * `text` with every meeting credential replaced, and how many were. The count
 * is the only thing reported about them: no value, length or fingerprint.
 */
export function redactMeetingCredentials(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (...args: unknown[]) => {
      const match = args[0] as string;
      const named = typeof args.at(-1) === "object";
      const whole = args.at(named ? -2 : -1) as string;
      const offset = args.at(named ? -3 : -2) as number;
      if (rule.labelled && WORD_CHAR.test(whole[offset - 1] ?? "")) return match;
      const groups = args.slice(1, named ? -3 : -2) as Array<string | undefined>;
      const next = rule.replace(match, groups);
      if (next !== match) count++;
      return next;
    });
  }
  return { text: out, count };
}
