/**
 * The transcript lane's extra rules (ScanOptions.transcriptRules). An agent
 * session carries credentials no wire shape names: a session cookie in a
 * pasted curl command, a `.netrc` entry, a key typed on the line after its
 * label. Only transcript ingest and the transcript audit turn these on; every
 * other write keeps the shared rules, because a label or a header name is a
 * much weaker signal than a credential's own shape.
 *
 * - cookie-header: after a `Cookie:` / `Set-Cookie:` header (any case, quoted
 *   or JSON-escaped) or a curl `-b` / `--cookie` argument (only after `curl`
 *   earlier on the line, or on a line that continues a curl command with `\`),
 *   each `name=value` pair separated by `;` is read and only the value is
 *   claimed. After `Set-Cookie:` only the first pair is a cookie; the
 *   attributes stay. Parsing stops at the first segment that is not
 *   `name=value`, so prose is never claimed. Values under 8 characters,
 *   placeholders and masks stay.
 * - netrc-password: `machine host [login u] password <value>` on one line, or
 *   a `password <value>` line inside a multi-line stanza (`machine host` /
 *   `default`, then only login/account/password tokens, blank lines and `#`
 *   comments).
 * - labeled-credential: a key, token or password label that ends its line
 *   (`here is my API key:`, `password:`, `login: alice /`) with the value
 *   alone on the next line, or on the first non-blank line of the next
 *   message (`leadingDangling`). Prose, short words, paths, versions, code
 *   references and stoplisted words are not values.
 *
 * Every quantifier is bounded, so each line costs linear work.
 */
/*
 * The label shapes are assembled from shared fragments that run both case-
 * sensitive and under `i`, and the walk below reads every pattern with a
 * lastIndex loop, so the style rules that want each literal rewritten for its
 * own flags are off here; the linear-time rules stay on.
 */
/* eslint-disable regexp/prefer-w, regexp/no-dupe-characters-character-class, regexp/use-ignore-case, regexp/no-useless-escape, regexp/strict, regexp/negation, regexp/prefer-character-class, regexp/no-useless-flag, regexp/no-contradiction-with-assertion, regexp/no-useless-assertions, regexp/no-trivially-nested-quantifier, regexp/no-empty-alternative */

/** The label form a line leaves for the next one. */
export type DanglingForm = "single" | "pair" | "key" | "netrc";

export interface TranscriptClaim {
  kind: "cookie-header" | "netrc-password" | "labeled-credential";
  start: number;
  value: string;
}

// ---- cookie-header -------------------------------------------------------

const COOKIE_HEAD_RE = /(?:(?:^|[^A-Za-z0-9_-])(set-)?cookie\\?["'`]?\s{0,4}:|(?:^|\s)(-b|--cookie)(?=[\s=]))[\s=]{0,4}\\?["'`]?/gi;
const COOKIE_PAIR_RE = /([!#$%&*+.^_|~0-9A-Za-z-]{1,128})=((?:\\{1,3})?"|)((?:[^\s;"',\\]|[',](?=[^\s;"',\\])|\\\/){0,4096})/y;
const COOKIE_SEP_RE = /\s{0,4};\s{0,4}/y;
const COOKIE_PLACEHOLDER_RE = /^(?:[<${[]|%[A-Za-z_]\w{0,64}%$)/;
const CURL_RE = /(?:^|[^A-Za-z0-9_-])curl(?:\.exe)?(?:\s|$)/i;
const COOKIE_MASK_RE = /^[.*xX•_-]+$/;
const COOKIE_PRECHECK_RE = /cookie|-b\s/i;
export const COOKIE_VALUE_MIN_CHARS = 8;

/** True when the line after `line` still belongs to a curl command (`line` ends in `\`). */
function curlContinues(line: string, inCurl: boolean): boolean {
  return /\\\s{0,4}$/.test(line) && (inCurl || CURL_RE.test(line));
}

function cookieHeaderValues(line: string, inCurl: boolean): Array<{ start: number; value: string }> {
  const out: Array<{ start: number; value: string }> = [];
  let curlAt: number | undefined;
  COOKIE_HEAD_RE.lastIndex = 0;
  for (let head = COOKIE_HEAD_RE.exec(line); head !== null; head = COOKIE_HEAD_RE.exec(line)) {
    const setCookie = head[1] !== undefined;
    let at = COOKIE_HEAD_RE.lastIndex;
    if (head[2] !== undefined && !inCurl) {
      curlAt ??= line.search(CURL_RE);
      if (curlAt < 0 || curlAt >= head.index) continue;
    }
    for (;;) {
      COOKIE_PAIR_RE.lastIndex = at;
      const m = COOKIE_PAIR_RE.exec(line);
      if (m === null) break;
      const quote = m[2]!;
      if (quote !== "" && !line.startsWith(quote, COOKIE_PAIR_RE.lastIndex)) break;
      const value = m[3]!;
      if (value.length >= COOKIE_VALUE_MIN_CHARS && !COOKIE_PLACEHOLDER_RE.test(value) && !COOKIE_MASK_RE.test(value)) {
        out.push({ start: m.index + m[1]!.length + 1 + quote.length, value });
      }
      if (setCookie) break;
      COOKIE_SEP_RE.lastIndex = COOKIE_PAIR_RE.lastIndex + quote.length;
      if (COOKIE_SEP_RE.exec(line) === null) break;
      at = COOKIE_SEP_RE.lastIndex;
    }
    COOKIE_HEAD_RE.lastIndex = Math.max(COOKIE_HEAD_RE.lastIndex, at);
  }
  return out;
}

// ---- labels --------------------------------------------------------------

const LEFT = "(?:^|[^A-Za-z0-9])";
const LABEL_END = "(?![A-Za-z0-9_-])";
const SINGLE_LABEL = "(?:pass(?:word|wd|code|phrase)|pwd)";
const PAIR_LABEL = String.raw`(?:(?:user(?:name)?|login|email)\s{0,2}/\s{0,2}pass(?:word|wd)?|log-?in|credentials?|creds)`;
const DELIM = String.raw`(?:[:=]|：)(?![=>])`;
const QUOTE = "[\"'`]";
const BARE_VALUE = String.raw`[^\s"'\`]{0,255}[^\s"'\`.,;:!?)\]}]`;
const BARE_PASS = String.raw`[^\s"'\`/]{0,255}[^\s"'\`/.,;:!?)\]}]`;
const BARE_END = String.raw`(?=[.,;:!?)\]}]{0,8}(?:\s|$))`;
const QUOTED_VALUE = String.raw`[^"'\`\n]{1,256}`;
const BOLD = "(?:\\*{1,2}|_{2})?";
const PAIR_HEAD = String.raw`${LEFT}${PAIR_LABEL}${LABEL_END}${BOLD}${QUOTE}?\s{0,4}(?:${DELIM}|-(?=\s))?${BOLD}\s{0,4}`;
const PAIR_USER = String.raw`(?:${QUOTE}[^"'\`\n/]{1,128}${QUOTE}|[^\s/:"'\`]{1,128})`;
const LABEL_SUFFIX = "(?:_[A-Za-z0-9]{1,16}){0,2}";
const SINGLE_HEAD = String.raw`${LEFT}[A-Za-z0-9_]{0,32}${SINGLE_LABEL}${LABEL_SUFFIX}${LABEL_END}${BOLD}${QUOTE}?\s{0,4}${DELIM}${BOLD}\s{0,4}`;
const KEY_LABEL = "(?:api[ _-]?key|access[ _-]?key|secret[ _-]?key|client[ _-]?secret|secret|token)s?";
const NETRC_HEAD = String.raw`(?:^|\s)(?:machine\s{1,4}[^\s]{1,253}|default)(?:\s{1,4}(?:login|account)\s{1,4}[^\s]{1,128}){0,2}\s{1,4}password\s{1,4}`;
const NETRC_LINE_HEAD = String.raw`^\s{0,8}(?:(?:login|account)\s{1,4}[^\s]{1,128}\s{1,4}){0,2}password\s{1,4}`;
const NETRC_STANZA_OPEN_RE = /^\s{0,8}(?:machine\s{1,4}\S{1,253}|default)(?:\s{1,4}(?:login|account)\s{1,4}\S{1,128}){0,2}\s{0,4}$/;
const NETRC_STANZA_LINE_RE = /^\s{0,8}(?:(?:(?:login|account|password)\s{1,4}\S{1,255}\s{0,4}){1,3}|#.*|\s*)$/;
const NETRC_PRECHECK_RE = /password/i;

interface LinePattern {
  kind: TranscriptClaim["kind"];
  re: RegExp;
  /** Runs only on a line after one that left this label form dangling; none: on every line. */
  after?: DanglingForm;
  precheck?: RegExp;
  validate: (value: string, head: string) => boolean;
}

// Group 1 = everything before the value, group 2 = the value.
const LINE_PATTERNS: LinePattern[] = [
  { kind: "netrc-password", re: new RegExp(`(${NETRC_HEAD}${QUOTE})(${QUOTED_VALUE})(?=${QUOTE})`, "gi"), precheck: NETRC_PRECHECK_RE, validate: (v, h) => labeledValueIsCredential(v, "single", h) },
  { kind: "netrc-password", re: new RegExp(`(${NETRC_HEAD})(${BARE_VALUE})${BARE_END}`, "gi"), precheck: NETRC_PRECHECK_RE, validate: (v, h) => labeledValueIsCredential(v, "single", h) },
  { kind: "netrc-password", after: "netrc", re: new RegExp(`(${NETRC_LINE_HEAD}${QUOTE})(${QUOTED_VALUE})(?=${QUOTE}\\s{0,8}$)`, "gi"), validate: (v, h) => labeledValueIsCredential(v, "single", h) },
  { kind: "netrc-password", after: "netrc", re: new RegExp(`(${NETRC_LINE_HEAD})([^\\s"'\`]{1,256})(?=\\s{0,8}$)`, "gi"), validate: (v, h) => labeledValueIsCredential(v, "single", h) },
  { kind: "labeled-credential", after: "key", re: new RegExp(`(^\\s{0,8}${QUOTE})(${QUOTED_VALUE})(?=${QUOTE}[,;]?\\s*$)`, "gi"), validate: keyLabelValueIsCredential },
  { kind: "labeled-credential", after: "key", re: new RegExp(`(^\\s{0,8})(${BARE_VALUE})(?=[.,;]?\\s*$)`, "gi"), validate: keyLabelValueIsCredential },
  // The whole next line is the value, so prose under a `Password:` heading is never claimed.
  { kind: "labeled-credential", after: "single", re: new RegExp(`(^\\s{0,8}${QUOTE})(${QUOTED_VALUE})(?=${QUOTE}[,;]?\\s*$)`, "gi"), validate: (v, h) => labeledValueIsCredential(v, "single", h) },
  { kind: "labeled-credential", after: "single", re: new RegExp(`(^\\s{0,8})(${BARE_VALUE})(?=[.,;]?\\s*$)`, "gi"), validate: (v, h) => labeledValueIsCredential(v, "single", h) },
  { kind: "labeled-credential", after: "pair", re: new RegExp(`(^\\s{0,8}${QUOTE}?)(${BARE_PASS})${BARE_END}`, "gi"), validate: (v, h) => labeledValueIsCredential(v, "pair", h) },
];

const KEY_DANGLING_RE = new RegExp(`${LEFT}${KEY_LABEL}${LABEL_END}${BOLD}${QUOTE}?\\s{0,4}${DELIM}${BOLD}\\s{0,4}$`, "i");
const KEY_PRECHECK_RE = /key|secret|token/i;
const LABELED_PRECHECK_RE = /pass|pwd|\bpw\b|log-?in|cred/i;
const PAIR_DANGLING_RE = new RegExp(`${PAIR_HEAD}${PAIR_USER}\\s{0,4}/\\s{0,4}$`, "i");
const SINGLE_DANGLING_RE = new RegExp(`${SINGLE_HEAD}$`, "i");

/** The label form `line` leaves dangling for the next line, or null. Only the last 128 characters are read. */
export function danglingLabel(line: string): DanglingForm | null {
  const tail = line.length > 128 ? line.slice(-128) : line;
  if (LABELED_PRECHECK_RE.test(tail)) {
    if (tail.includes("/") && PAIR_DANGLING_RE.test(tail)) return "pair";
    if (SINGLE_DANGLING_RE.test(tail)) return "single";
  }
  return KEY_PRECHECK_RE.test(tail) && KEY_DANGLING_RE.test(tail) ? "key" : null;
}

/** The label form the last line of `text` leaves dangling, for the next message. */
export function trailingDanglingLabel(text: string): DanglingForm | null {
  const trimmed = text.trimEnd();
  return danglingLabel(trimmed.slice(trimmed.lastIndexOf("\n") + 1));
}

/** Words that follow a credential label in prose or code without being the credential. */
const LABELED_STOPLIST: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "not", "no", "yes", "ok", "okay", "none", "null", "nil", "n/a", "na", "tbd", "todo",
  "empty", "blank", "unknown", "unset", "set", "same", "hidden", "redacted", "masked", "secret", "private",
  "required", "optional", "missing", "invalid", "incorrect", "wrong", "expired", "changed", "change", "reset",
  "forgot", "forgotten", "updated", "update", "new", "old", "current", "default", "see", "below", "above",
  "here", "there", "it", "its", "it's", "is", "was", "be", "this", "that", "these", "those", "my", "your",
  "our", "their", "his", "her", "any", "some", "all", "one", "two", "true", "false", "on", "off", "enabled",
  "disabled", "flow", "page", "form", "field", "screen", "prompt", "dialog", "modal", "button", "link", "email",
  "password", "passwd", "passcode", "passphrase", "pwd", "login", "username", "user", "users", "credentials",
  "creds", "manager", "policy", "rules", "strength", "length", "hint", "protected", "protection", "auth",
  "oauth", "sso", "saml", "ldap", "mfa", "2fa", "otp", "token", "tokens", "key", "keys", "hash", "hashed",
  "salt", "salted", "encrypted", "plaintext", "string", "str", "text", "number", "int", "integer", "bool",
  "boolean", "bytes", "object", "undefined", "varchar", "char", "secretstr", "type", "value", "values",
  "input", "output", "example", "placeholder", "stdin", "env", "environment", "vault", "keychain", "keyring",
  "please", "enter", "provide", "use", "via", "from", "with", "without", "for", "to", "in", "of", "by", "as",
  "at", "if", "when", "then", "only", "also", "just", "still", "again", "later", "now", "needed", "need",
  "works", "working", "failed", "fails", "failing", "error", "errors", "broken", "issue", "issues", "support",
  "supported", "unsupported", "configured", "stored", "saved", "sent", "shared", "rotated", "rotate", "revoked",
  "style", "format", "syntax", "mode", "option", "options", "parameter", "param", "argument", "arg",
  "await", "async", "function", "fn", "lambda", "return", "yield", "typeof", "const", "let", "var", "def",
  "self", "cls", "getpass", "require", "import", "readline", "ask", "read",
]);

const PLACEHOLDER_PREFIX_RE = /^(?:<|\[|\{|\$|%|\\|@\{|#\{|\)|\]|\})/;
const MASK_RE = /^[*xX•·.#_-]+$/;
const URL_RE = /^[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\//;
const PATH_RE = /^(?:\.{1,2}\/|~\/|\/|[A-Za-z]:[\\/])/;
const DOTTED_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const COMPOUND_IDENTIFIER_RE = /[a-z][A-Z]|_[A-Za-z]/;
const LABEL_WORD_RE = /pass|pwd/i;
const VERSION_RE = /^v?\d+(?:\.\d+)+$/;
const PAIR_SYMBOL_RE = /[0-9!@#$%^&*+=?~]/;
const LETTER_RE = /[A-Z]/i;
// eslint-disable-next-line regexp/no-super-linear-move -- run on at most 160 characters (labeledValueIsCredential)
const PAIR_USER_TAIL_RE = /([^\s/:"'`*]+)["'`]?\s*[/:]\s*["'`]?$/;
const FILE_NAME_RE = /^[\w.-]{1,128}(?:\/[\w.-]{1,128}){0,16}\.[A-Za-z][A-Za-z0-9]{0,4}$/;
const KEY_VERSION_RE = /^v?\d{1,6}(?:\.\d{1,6}){1,3}(?:[-+][\w.-]{0,64})?$/;

function isStopword(value: string): boolean {
  return LABELED_STOPLIST.has(value.toLowerCase());
}

/**
 * A labeled value that holds a credential: not a placeholder, mask, URL, path,
 * code reference, identifier or stoplisted word. A pair's password (the weaker
 * label) also needs 4+ characters with a letter and a digit or symbol, and its
 * user half must not be a stoplisted word.
 */
export function labeledValueIsCredential(value: string, form: "single" | "pair", head = ""): boolean {
  if (value.length < 3 || isStopword(value)) return false;
  if (PLACEHOLDER_PREFIX_RE.test(value) || MASK_RE.test(value) || URL_RE.test(value) || PATH_RE.test(value)) return false;
  if (value.includes("(") || DOTTED_IDENTIFIER_RE.test(value)) return false;
  const digitless = !/\d/.test(value);
  if (IDENTIFIER_RE.test(value) && digitless && (LABEL_WORD_RE.test(value) || COMPOUND_IDENTIFIER_RE.test(value))) return false;
  if (form === "single") return true;
  // A head is one label, a user and a separator: the last 160 characters hold all of it.
  const user = PAIR_USER_TAIL_RE.exec(head.slice(-160))?.[1];
  if (user !== undefined && isStopword(user)) return false;
  return value.length >= 4 && LETTER_RE.test(value) && PAIR_SYMBOL_RE.test(value) && !VERSION_RE.test(value);
}

/** A value alone on the line after a key label: one 12+ character token with a letter and a digit, not a file name or version. */
function keyLabelValueIsCredential(value: string, head = ""): boolean {
  if (value.length < 12 || /\s/.test(value) || !LETTER_RE.test(value) || !/\d/.test(value)) return false;
  if (FILE_NAME_RE.test(value) || KEY_VERSION_RE.test(value)) return false;
  return labeledValueIsCredential(value, "single", head);
}

/** Echo floor for a labeled value: long enough, one token, not a common word. */
export function labeledEchoEligible(value: string): boolean {
  return value.length >= 8 && !isStopword(value) && !/\s/.test(value);
}

// ---- the line walk -------------------------------------------------------

/**
 * Every transcript-lane claim in `text`, by line, in text order. `leading` is
 * the label form the previous message left dangling; it reads this text's
 * first non-blank line. Claims may overlap text the shared rules already
 * replaced; the caller keeps those markers.
 */
export function transcriptClaims(text: string, leading: DanglingForm | null = null): TranscriptClaim[] {
  const out: TranscriptClaim[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let netrc = false;
  let inCurl = false;
  let leadingLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineStart = offset;
    offset += line.length + 1;
    if (i > 0) {
      const prev = lines[i - 1]!;
      netrc = NETRC_STANZA_OPEN_RE.test(prev) || (netrc && NETRC_STANZA_LINE_RE.test(prev));
      inCurl = curlContinues(prev, inCurl);
    }
    if (i === leadingLine && leading !== null && line.trim() === "") leadingLine = i + 1;
    const dangling = (i === leadingLine && leading !== null ? leading : i > 0 ? danglingLabel(lines[i - 1]!) : null) ?? (netrc ? "netrc" : null);
    if (line.length === 0) continue;
    for (const p of LINE_PATTERNS) {
      if (p.after !== undefined && p.after !== dangling) continue;
      if (p.precheck && !p.precheck.test(line)) continue;
      p.re.lastIndex = 0;
      for (let m = p.re.exec(line); m !== null; m = p.re.exec(line)) {
        if (m[0].length === 0) p.re.lastIndex++;
        const head = m[1]!;
        const value = m[2]!;
        if (value.length === 0 || !p.validate(value, head)) continue;
        out.push({ kind: p.kind, start: lineStart + m.index + head.length, value });
      }
    }
    if (COOKIE_PRECHECK_RE.test(line)) {
      for (const c of cookieHeaderValues(line, inCurl)) out.push({ kind: "cookie-header", start: lineStart + c.start, value: c.value });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
