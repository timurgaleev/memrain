/**
 * Credentials pasted into the brain — an env dump, a config file, a transcript
 * that echoed a token — would otherwise be stored, chunked, embedded and served
 * to every grant that reads the source. This finds them before anything is
 * written: by the prefixes their issuers publish (plus memrain's own token
 * shapes and PEM private-key blocks), by wire shape (a JWT, a password inside a
 * URL, an HTTP Basic credential), and by a keyword assignment
 * (`DB_PASSWORD=…`) whose value is random enough to be a secret.
 *
 * There is no bare "high entropy anywhere" rule: it would also catch hashes,
 * UUIDs and ids, which the brain is full of. The entropy gate only ever judges
 * the value of a `secret|token|password|api key` assignment. What is found is
 * reported by kind and a SHA-256 fingerprint — never by value — so an audit row
 * can say what was caught without re-storing it.
 *
 * Every pattern starts with a literal prefix or keyword and bounds its tail,
 * so a scan is linear in the text (tests/secret_scan*.test.ts measure it).
 */
import { createHash } from "node:crypto";
import { OperationError } from "./operation-error.ts";
import type { Engine } from "./engine/interface.ts";
import { logIngest } from "./ingest-log.ts";

/**
 * Bumped whenever the rules change what is caught, so text stored under an
 * older version can be found and scanned again.
 */
export const SECRET_SCAN_VERSION = 2;

export interface SecretFinding {
  kind: string;
  /** First 16 hex of the SHA-256 of the secret. */
  fingerprint: string;
}

export interface SecretScanResult {
  text: string;
  findings: SecretFinding[];
}

/**
 * Values claimed by a keyword-anchored rule (bearer, assignment, URL password,
 * Basic), mapped to the kind that claimed them. A transcript echoes such a
 * value bare — the header in a tool call, the token alone in the reply — so
 * every other occurrence is redacted too. One map per write, shared by its
 * fields.
 */
export type EchoDictionary = Map<string, string>;

export interface ScanOptions {
  /** The write's echo dictionary; `false` turns the echo pass off. Default: a map for this text alone. */
  echo?: EchoDictionary | false;
  /** Replace a key block with its marker plus as many newlines as it spanned, so line numbers hold. */
  preserveLines?: boolean;
  /** The entropy-gated keyword assignment rule. Default on. */
  highEntropy?: boolean;
}

interface Pattern {
  kind: string;
  regex: RegExp;
  /** Group 1 is kept as it is; group 2 is the secret. */
  split?: boolean;
  /** False leaves the match in place. It is consumed either way, never re-tried from inside. */
  validate?: (value: string) => boolean;
  /** The value must carry a digit and a non-digit and clear the entropy floor. */
  entropyGated?: boolean;
  /** Which part of a claimed value joins the echo dictionary, and its length floor. */
  echo?: { min: number; pick?: (value: string) => string };
}

/** Documentation passwords: `<password>`, `${VAR}`, `$VAR`, all `*`, all `x`. */
const PLACEHOLDER = /^(?:<[^<>]*>|\$\{[^{}]*\}|\$[A-Za-z_]\w*|\*+|[xX]+)$/;

/** The password of a `scheme://user:password@` span (the user never holds a `:`). */
function urlPassword(span: string): string {
  const colon = span.indexOf(":", span.indexOf("://") + 3);
  return span.slice(colon + 1, -1);
}

/** Prose after the word "Basic" decodes to binary noise; a credential decodes to printable `user:pass`. */
function decodesToUserPass(value: string): boolean {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 3) return false;
  let colon = false;
  for (const b of bytes) {
    if (b < 0x20 || b > 0x7e) return false;
    if (b === 0x3a) colon = true;
  }
  return colon;
}

/**
 * The key of an assignment: a credential word, up to 64 identifier characters
 * after it (`_ACCESS_KEY`, `_2`), an optional closing quote, `:` or `=`. `_` and
 * `-` count as separators on the left, or `SMTP_PASSWORD` could not match its
 * own word. Every quantifier is bounded, so a run of `_token_token…` does
 * constant work per start.
 */
const ASSIGNMENT_KEY =
  String.raw`(?:^|[^A-Za-z0-9])(?:secret|token|passwd|password|passphrase|credential|api[_-]?key|apikey)[\w-]{0,64}["']?[ \t]{0,16}[:=][ \t]{0,16}`;
/** A dotted member path in code (`process.env.DB_PASSWORD_2`). */
const DOTTED_IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
/** The unquoted value class before password punctuation was admitted: a pure base64-ish run. */
const PLAIN_VALUE = /^[\w+/=-]+$/;

/** An assignment value that names a secret rather than holding one is left alone. */
function assignmentHoldsValue(value: string): boolean {
  if (/^[A-Za-z][\w+.-]{0,31}:\/\//.test(value)) return false;
  if (value.startsWith("./") || value.startsWith("~/") || value.startsWith("${") || value.startsWith("$(")) return false;
  if (value.startsWith("[REDACTED:") || DOTTED_IDENTIFIER.test(value)) return false;
  // An absolute file path; a base64 secret that happens to start with `/` still counts.
  return !(value.startsWith("/") && !PLAIN_VALUE.test(value));
}

const ENTROPY_FLOOR = 3.5;

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Miller-Madow corrected entropy: the raw figure of an n-character string can
 * never pass log2(n), so the raw floor rejected most random 12-16 character
 * passwords — exactly the ones an assignment rule is for.
 */
export function correctedEntropy(s: string): number {
  if (s.length === 0) return 0;
  return shannonEntropy(s) + (new Set(s).size - 1) / (2 * s.length * Math.LN2);
}

/** Machine-minted secrets carry digits; counters and ids are all digits. */
function clearsEntropyGate(value: string): boolean {
  return /\d/.test(value) && /\D/.test(value) && correctedEntropy(value) >= ENTROPY_FLOOR;
}

const VENDOR_PATTERNS: Pattern[] = [
  // AKIA/ASIA only: AIDA, AROA and the rest are IAM unique ids, not secrets.
  { kind: "aws-access-key", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "aws-secret-key", regex: /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s{0,8}[:=]\s{0,8}["']?[A-Za-z0-9/+]{40}/g },
  { kind: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { kind: "github-token", regex: /\bgithub_pat_\w{22,255}\b/g },
  { kind: "slack-token", regex: /\bxox[abeprs]-[A-Za-z0-9-]{10,200}/g },
  { kind: "slack-token", regex: /\bxapp-[A-Za-z0-9-]{10,200}/g },
  { kind: "gitlab-token", regex: /\bglpat-[\w-]{20,100}/g },
  { kind: "stripe-key", regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,200}/g },
  { kind: "stripe-key", regex: /\bwhsec_[A-Za-z0-9]{24,200}/g },
  { kind: "openai-key", regex: /\bsk-(?:proj|svcacct|admin)-[\w-]{20,300}/g },
  { kind: "slack-webhook", regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,200}/g },
  { kind: "anthropic-key", regex: /\bsk-ant-[\w-]{20,300}/g },
  // After the prefixed forms, so those keep their whole key. The right edge
  // keeps `sk-` inside a kebab-case name from reading as a key.
  { kind: "openai-key", regex: /\bsk-[A-Za-z0-9]{20,300}(?![\w-])/g },
  { kind: "google-api-key", regex: /\bAIza[\w-]{35}(?![\w-])/g },
  { kind: "huggingface-token", regex: /\bhf_[A-Za-z0-9]{30,200}/g },
  { kind: "npm-token", regex: /\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g },
  { kind: "sendgrid-key", regex: /\bSG\.[\w-]{16,200}\.[\w-]{16,200}/g },
  // Account and API-key SIDs: 32 hex with a hard right edge, so a longer
  // digest that happens to start with AC or SK is not cut into a "key".
  { kind: "twilio-key", regex: /\b(?:AC|SK)[0-9a-fA-F]{32}(?![0-9A-Za-z])/g },
  // `sb_publishable_` is public by design and stays.
  { kind: "supabase-key", regex: /\bsb_secret_[\w-]{20,200}/g },
  { kind: "supabase-key", regex: /\bsbp_[a-f0-9]{40}(?![0-9A-Za-z])/g },
  { kind: "digitalocean-token", regex: /\bdo[opr]_v1_[a-f0-9]{64}(?![A-Za-z0-9])/g },
  // Our own: OAuth access/refresh tokens, client secrets, authorization and
  // enrollment codes, and PATs, under the current and the pre-rename prefix
  // (tokens minted before the rename keep working).
  // Client ids (`*_cl_`) and enrollment ids (`*_enr_`) are not secrets.
  { kind: "memex-token", regex: /\bmemex_(?:at|rt|cs|code|en)_[\w-]{16,200}/g },
  { kind: "memex-pat", regex: /\bmemex_[0-9a-f]{64}\b/g },
  { kind: "memrain-token", regex: /\bmemrain_(?:at|rt|cs|code|en)_[\w-]{16,200}/g },
  { kind: "memrain-pat", regex: /\bmemrain_[0-9a-f]{64}\b/g },
  // The lookbehind keeps a start from landing mid-run, so a long `-`/`_` run
  // is scanned once, not once per `eyJ` in it.
  { kind: "jwt", regex: /(?<![\w-])eyJ[\w-]{8,4096}\.[\w-]{2,4096}\.[\w-]{8,4096}/g },
];

/** Catch-alls run after every named prefix, so a vendor key or a JWT keeps its own kind. */
const SHAPE_PATTERNS: Pattern[] = [
  {
    kind: "database-url",
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqp|mssql):\/\/[^\s:/@"']{0,128}:[^\s"']{1,256}@/g,
    echo: { min: 8, pick: urlPassword },
  },
  // The password stops at `/`, `?` and `#` too (RFC 3986 escapes them in
  // userinfo), so a dev-server path like `host:3000/@scope/pkg` is not a
  // credential. Only the scheme://user:password@ span is replaced.
  {
    kind: "url-credentials",
    regex: /\bhttps?:\/\/[^\s:/@"']{0,128}:[^\s@"'/?#]{1,256}@/gi,
    validate: (span) => !PLACEHOLDER.test(urlPassword(span)),
    echo: { min: 8, pick: urlPassword },
  },
  // After an Authorization header any length counts (`u:p` encodes to 4);
  // bare `Basic <value>` needs 16. Either way the value must decode to
  // printable `user:pass`, and a longer base64 run is not a credential.
  {
    kind: "basic-auth",
    regex: /(\bauthorization["']?[ \t]{0,16}[:=][ \t]{0,16}["']?basic[ \t]{1,16})([A-Za-z0-9+/=]{4,2048})(?![A-Za-z0-9+/=])/gi,
    split: true,
    validate: decodesToUserPass,
    echo: { min: 12 },
  },
  {
    kind: "basic-auth",
    regex: /(\bbasic[ \t]{1,16})([A-Za-z0-9+/=]{16,2048})(?![A-Za-z0-9+/=])/gi,
    split: true,
    validate: decodesToUserPass,
    echo: { min: 12 },
  },
];

/**
 * Quoted: any non-quote, non-space run. Unquoted: base64 characters plus
 * password punctuation — not `&` (sibling query parameters), not brackets (so
 * `token = getToken(x)` stays), not `,` `;` `:` — and a sentence's closing
 * `.?!` is not part of the value.
 */
const ASSIGNMENT_PATTERNS: Pattern[] = [
  { kind: "high-entropy-assignment", regex: new RegExp(`(${ASSIGNMENT_KEY}["'])([^"'\\s]{12,4096})`, "gi") },
  {
    kind: "high-entropy-assignment",
    regex: new RegExp(`(${ASSIGNMENT_KEY})([\\w+/=\\-!#$%*@^~.?<>]{11,4095}[\\w+/=\\-#$%*@^~<>])`, "gi"),
  },
].map((p) => ({ ...p, split: true, entropyGated: true, validate: assignmentHoldsValue, echo: { min: 12 } }));

// Last, so a vendor token or JWT after `Bearer` keeps its own kind. Only the
// token is replaced; the scheme word stays. Anchored on the header name:
// "Bearer authentication/authorization" is prose, and redacting it would
// rewrite stored text for good.
const BEARER_PATTERN: Pattern = {
  kind: "bearer-token",
  regex: /(?<=\bAuthorization["']?[ \t]{0,4}[:=][ \t]{0,4}["']?Bearer[ \t]{1,8})[\w.~+/=-]{20,}/gi,
  echo: { min: 20 },
};

const PATTERNS = [...VENDOR_PATTERNS, ...SHAPE_PATTERNS, ...ASSIGNMENT_PATTERNS, BEARER_PATTERN];
const PATTERNS_WITHOUT_ASSIGNMENTS = [...VENDOR_PATTERNS, ...SHAPE_PATTERNS, BEARER_PATTERN];

/** A claimed value longer than this is redacted where it was claimed, but its echoes are not looked for. */
const ECHO_MAX_VALUE = 512;
/** The echo pass looks for at most this many values per write: a bounded number of linear sweeps. */
const ECHO_MAX_VALUES = 64;
/** A marker this scanner wrote; the echo pass never matches inside one. */
const MARKER = /\[REDACTED:[a-z0-9-]{1,64}:[0-9a-f]{16}\]/g;

const PEM_OPEN = "-----BEGIN ";
/** A key block is never larger; past this, an unclosed header is not a key. */
const PEM_MAX = 16_384;
/** Base64 body lines and `Name: value` armor headers of a key block. */
const PEM_BODY_LINE = /^(?:[a-z0-9+/=]{0,100}|[\w-]{1,40}: .{0,200})$/i;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fingerprintSecret(value: string): string {
  return sha256Hex(value).slice(0, 16);
}

/** Replace every PEM private-key block, header to footer, with `mark(block)`. */
function replacePemBlocks(text: string, mark: (block: string) => string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = text.indexOf(PEM_OPEN, from);
    if (open === -1) return out + text.slice(from);
    const headerEnd = text.indexOf("-----", open + PEM_OPEN.length);
    // RSA/EC/OPENSSH `PRIVATE KEY` and PGP `PRIVATE KEY BLOCK` headers.
    const header = headerEnd === -1 || headerEnd - open > 80 ? "" : text.slice(open, headerEnd);
    if (!header.includes("PRIVATE KEY")) {
      out += text.slice(from, open + PEM_OPEN.length);
      from = open + PEM_OPEN.length;
      continue;
    }
    const bodyStart = headerEnd + 5;
    const footer = text.indexOf("-----END ", bodyStart);
    const footerEnd = footer === -1 || footer - open > PEM_MAX ? -1 : text.indexOf("-----", footer + 9);
    const end = footerEnd !== -1 ? footerEnd + 5 : unterminatedBlockEnd(text, bodyStart);
    out += text.slice(from, open) + mark(text.slice(open, end));
    from = end;
  }
}

/**
 * Where an unclosed key block ends: after the base64 lines that follow its
 * header, never past PEM_MAX. A truncated key is still a key, but a note that
 * merely quotes the header line must not lose everything after it.
 */
function unterminatedBlockEnd(text: string, bodyStart: number): number {
  const limit = Math.min(text.length, bodyStart + PEM_MAX);
  // `pos` is where the current line starts, on its leading newline if any.
  let pos = bodyStart;
  while (pos < limit) {
    const start = text[pos] === "\n" ? pos + 1 : pos;
    const nl = text.indexOf("\n", start);
    const lineEnd = nl === -1 || nl > limit ? limit : nl;
    if (!PEM_BODY_LINE.test(text.slice(start, lineEnd).replace(/\r$/, ""))) return pos;
    pos = lineEnd;
  }
  return pos;
}

function addEcho(echo: EchoDictionary, value: string, kind: string, min: number): void {
  if (value.length < min || value.length > ECHO_MAX_VALUE || PLACEHOLDER.test(value)) return;
  if (echo.has(value) || echo.size >= ECHO_MAX_VALUES) return;
  echo.set(value, kind);
}

/**
 * Replace every occurrence of a dictionary value outside the markers already
 * in `text`, leftmost first and longest on a tie. Each value keeps the position
 * of its next occurrence and is searched again only once the cursor has passed
 * it, so the pass is O(values × text) and holds O(values) state.
 */
export function sweepEchoes(text: string, echo: EchoDictionary, findings: SecretFinding[]): string {
  const values = [...echo.keys()].sort((a, b) => b.length - a.length);
  const next = values.map((v) => text.indexOf(v));
  if (next.every((p) => p === -1)) return text;
  const parts: string[] = [];
  const emitGap = (from: number, to: number): void => {
    let at = from;
    for (;;) {
      let best = -1;
      let bestPos = to;
      for (let k = 0; k < values.length; k++) {
        let p = next[k]!;
        if (p === -1) continue;
        if (p < at) {
          p = text.indexOf(values[k]!, at);
          next[k] = p;
          if (p === -1) continue;
        }
        if (p >= bestPos || p + values[k]!.length > to) continue;
        best = k;
        bestPos = p;
      }
      if (best === -1) break;
      const value = values[best]!;
      const kind = `${echo.get(value)}-echo`;
      const fingerprint = fingerprintSecret(value);
      findings.push({ kind, fingerprint });
      parts.push(text.slice(at, bestPos), `[REDACTED:${kind}:${fingerprint}]`);
      at = bestPos + value.length;
    }
    parts.push(text.slice(at, to));
  };
  let cur = 0;
  for (const m of text.matchAll(MARKER)) {
    emitGap(cur, m.index);
    parts.push(m[0]);
    cur = m.index + m[0].length;
  }
  emitGap(cur, text.length);
  return parts.join("");
}

const MARKER_WHOLE = /^\[REDACTED:[a-z0-9-]{1,64}:[0-9a-f]{16}\]$/;

/**
 * A marker's own `…-token:<fingerprint>]` tail reads as an assignment, so a
 * match that ends one is never claimed again. Looks back a bounded distance.
 */
function insideMarker(text: string, offset: number, length: number): boolean {
  const end = offset + length;
  if (text[end] !== "]") return false;
  const from = Math.max(0, offset - 80);
  const open = text.slice(from, offset).lastIndexOf("[REDACTED:");
  return open !== -1 && MARKER_WHOLE.test(text.slice(from + open, end + 1));
}

function isAllowed(hex: string, allow: ReadonlySet<string>): boolean {
  for (const prefix of allow) if (prefix.length >= 16 && hex.startsWith(prefix)) return true;
  return false;
}

/**
 * Find credentials in `text` and replace each with a marker naming its kind
 * and fingerprint, then replace bare echoes of the keyword-anchored values.
 * `allow` holds hex prefixes (16 to 64) of the SHA-256 of values to leave in
 * place.
 */
export function scanSecrets(text: string, allow: ReadonlySet<string> = new Set(), opts: ScanOptions = {}): SecretScanResult {
  const findings: SecretFinding[] = [];
  const echo = opts.echo === false ? null : (opts.echo ?? new Map<string, string>());
  /** The marker for a claimed value, or null when it is allowed. */
  const claim = (kind: string, value: string, echoRule?: Pattern["echo"]): string | null => {
    const hex = sha256Hex(value);
    if (isAllowed(hex, allow)) return null;
    const fingerprint = hex.slice(0, 16);
    findings.push({ kind, fingerprint });
    if (echo && echoRule) addEcho(echo, echoRule.pick ? echoRule.pick(value) : value, kind, echoRule.min);
    return `[REDACTED:${kind}:${fingerprint}]`;
  };
  let out = text;
  if (text.includes(PEM_OPEN)) {
    out = replacePemBlocks(text, (block) => {
      const marker = claim("private-key", block);
      if (marker === null) return block;
      return opts.preserveLines ? marker + "\n".repeat(block.split("\n").length - 1) : marker;
    });
  }
  for (const p of opts.highEntropy === false ? PATTERNS_WITHOUT_ASSIGNMENTS : PATTERNS) {
    out = out.replace(p.regex, (match: string, ...groups: unknown[]) => {
      const head = p.split ? (groups[0] as string) : "";
      const value = p.split ? (groups[1] as string) : match;
      if (p.entropyGated && (!clearsEntropyGate(value) || insideMarker(groups.at(-1) as string, groups.at(-2) as number, match.length))) {
        return match;
      }
      if (p.validate && !p.validate(value)) return match;
      const marker = claim(p.kind, value, p.echo);
      return marker === null ? match : head + marker;
    });
  }
  if (echo && echo.size > 0) out = sweepEchoes(out, echo, findings);
  return { text: out, findings };
}

export type SecretDisposition = "redact" | "flag" | "reject";

export function secretDisposition(): SecretDisposition {
  const v = (process.env.MEMRAIN_SECRET_SCAN_DISPOSITION ?? "").trim().toLowerCase();
  return v === "flag" || v === "reject" ? v : "redact";
}

/** On unless the variable says `0`, `false`, `off` or `no`. */
export function switchedOn(name: string): boolean {
  return !["0", "false", "off", "no"].includes((process.env[name] ?? "").trim().toLowerCase());
}

let warnedShortAllow = false;

export function allowedFingerprints(): Set<string> {
  const allow = new Set<string>();
  for (const entry of (process.env.MEMRAIN_SECRET_SCAN_ALLOW ?? "").split(",")) {
    const s = entry.trim().toLowerCase();
    if (/^[0-9a-f]{16,64}$/.test(s)) allow.add(s);
    else if (/^[0-9a-f]{12}$/.test(s) && !warnedShortAllow) {
      warnedShortAllow = true;
      console.warn(
        "MEMRAIN_SECRET_SCAN_ALLOW: 12-hex fingerprints are ignored; allow the 16-hex fingerprint the redaction marker shows instead.",
      );
    }
  }
  return allow;
}

export interface GuardOptions {
  /** The write's echo dictionary, shared by its fields. Default: one for this text alone. */
  echo?: EchoDictionary;
  /** See ScanOptions.preserveLines. */
  preserveLines?: boolean;
}

/**
 * Apply the configured disposition to text about to be stored:
 *   redact (default) — store the marked text;
 *   flag             — store it unchanged, but still report what was found;
 *   reject           — refuse the write.
 */
export function guardSecrets(text: string, where: string, opts: GuardOptions = {}): SecretScanResult {
  const scanned = scanSecrets(text, allowedFingerprints(), {
    echo: switchedOn("MEMRAIN_SECRET_SCAN_ECHO") ? (opts.echo ?? new Map<string, string>()) : false,
    highEntropy: switchedOn("MEMRAIN_SECRET_SCAN_HIGH_ENTROPY"),
    preserveLines: opts.preserveLines === true,
  });
  if (scanned.findings.length === 0) return { text, findings: [] };
  const disposition = secretDisposition();
  if (disposition === "reject") throw new SecretRejectedError(where, scanned.findings);
  return disposition === "flag" ? { text, findings: scanned.findings } : scanned;
}

/**
 * The echo pass alone, over every string in `value` (keys included): for the
 * fields of a write guarded before a later field added to `echo`. Only the
 * redact disposition rewrites; under flag nothing is replaced, and under
 * reject a claim has already refused the write.
 */
export function guardEchoes<T>(value: T, echo: EchoDictionary, findings: SecretFinding[]): T {
  if (echo.size === 0 || secretDisposition() !== "redact") return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return sweepEchoes(v, echo, findings);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[walk(k) as string] = walk(inner);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** A write refused under the reject disposition; carries what was found so the
 *  refusal can be audited like a redaction. */
export class SecretRejectedError extends OperationError {
  constructor(
    where: string,
    public readonly findings: SecretFinding[],
  ) {
    super(
      "invalid_params",
      `${where} contains what looks like a credential (${describeFindings(findings)}); the write was refused`,
      "Remove the credential, or allow its fingerprint in MEMRAIN_SECRET_SCAN_ALLOW if it is not one.",
    );
  }
}

const AUTH_HEADER_KEY = /^(?:proxy-)?authorization$/i;
const AUTH_HEADER_PREFIX = "Authorization: ";

/**
 * A header value stored under its own key, `{"Authorization": "Bearer …"}`:
 * the bearer detector is anchored on the header name, so the value is scanned
 * as the header line it came from.
 */
function guardHeaderValue(value: string, where: string, findings: SecretFinding[], echo: EchoDictionary): string {
  const r = guardSecrets(AUTH_HEADER_PREFIX + value, where, { echo });
  findings.push(...r.findings);
  return r.text.slice(AUTH_HEADER_PREFIX.length);
}

function guardDeep(value: unknown, where: string, findings: SecretFinding[], echo: EchoDictionary): unknown {
  if (typeof value === "string") {
    const r = guardSecrets(value, where, { echo });
    findings.push(...r.findings);
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => guardDeep(v, where, findings, echo));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[guardDeep(k, where, findings, echo) as string] =
        typeof v === "string" && AUTH_HEADER_KEY.test(k) ? guardHeaderValue(v, where, findings, echo) : guardDeep(v, where, findings, echo);
    }
    return out;
  }
  return value;
}

/**
 * Every string in a JSON value through `guardSecrets`, keys included. Given a
 * write's `echo` dictionary, the caller runs `guardEchoes` once every field is
 * guarded; without one, this value's own echoes are swept here.
 */
export function guardSecretsDeep(value: unknown, where: string, findings: SecretFinding[], echo?: EchoDictionary): unknown {
  if (echo) return guardDeep(value, where, findings, echo);
  const own: EchoDictionary = new Map();
  return guardEchoes(guardDeep(value, where, findings, own), own, findings);
}

/**
 * Run a write's scans. A refusal is audited before it propagates, so a
 * rejected credential leaves the same trail a redacted one does.
 */
export async function guardWrite<T>(
  engine: Engine,
  ref: string,
  sourceId: string | null,
  scan: () => T,
): Promise<T> {
  try {
    return scan();
  } catch (e) {
    if (e instanceof SecretRejectedError) await auditRejection(engine, e, ref, sourceId);
    throw e;
  }
}

/**
 * Guard a write's free-text fields and audit what they carried. Each string
 * field comes back redacted (or unchanged under `flag`); a non-string passes
 * through for the caller's own validation. A value claimed in one field is
 * redacted where another field echoes it, in either order.
 */
export async function guardFields<T extends Record<string, unknown>>(
  engine: Engine,
  ref: string,
  sourceId: string | null,
  where: string,
  fields: T,
): Promise<T> {
  const findings: SecretFinding[] = [];
  const echo: EchoDictionary = new Map();
  const out = await guardWrite(engine, ref, sourceId, () => {
    const guarded: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v !== "string") {
        guarded[k] = v;
        continue;
      }
      const r = guardSecrets(v, where, { echo });
      findings.push(...r.findings);
      guarded[k] = r.text;
    }
    return guardEchoes(guarded, echo, findings) as T;
  });
  await auditSecrets(engine, findings, ref, sourceId);
  return out;
}

export async function auditRejection(
  engine: Engine,
  e: SecretRejectedError,
  ref: string,
  sourceId: string | null,
): Promise<void> {
  await logIngest(engine, {
    source_type: "secret-rejected",
    source_ref: ref,
    summary: describeFindings(e.findings),
    ...(sourceId ? { source_id: sourceId } : {}),
  });
}

/** Record what a write carried, by kind and fingerprint — never the value. */
export async function auditSecrets(
  engine: Engine,
  findings: SecretFinding[],
  ref: string,
  sourceId: string | null,
): Promise<void> {
  if (findings.length === 0) return;
  await logIngest(engine, {
    source_type: secretDisposition() === "flag" ? "secret-flagged" : "secret-redacted",
    source_ref: ref,
    summary: describeFindings(findings),
    ...(sourceId ? { source_id: sourceId } : {}),
  });
}

/** `aws-access-key:1a2b3c4d5e6f7a8b, private-key:…` — for audit rows and errors. */
export function describeFindings(findings: SecretFinding[]): string {
  return findings.map((f) => `${f.kind}:${f.fingerprint}`).join(", ");
}
