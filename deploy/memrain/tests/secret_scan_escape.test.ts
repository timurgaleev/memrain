/**
 * Keys whose start is hidden by an escape or glued to an identifier: a JSON
 * string (`\n`, `\t`, `\u001b`, `\"`), a percent-encoded URL (`%22`, `%3D`),
 * or `token_<key>`. Every secret-shaped fixture is built from fragments or a
 * seeded generator, never a literal.
 */
import { describe, expect, it } from "bun:test";
import { scanSecrets } from "../src/core/secret-scan.ts";
import { linearityRatio } from "./helpers/cpu-time.ts";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";
const B64URL = `${ALNUM}_-`;

/** Seeded pseudo-random string: the same fixture on every run. */
function rnd(n: number, seed: number, alphabet = ALNUM): string {
  let x = seed;
  let s = "";
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    s += alphabet[(x >>> 16) % alphabet.length];
  }
  return s;
}

const kinds = (text: string) => scanSecrets(text).findings.map((f) => f.kind);

const fixed: Array<[string, string]> = [
  ["aws-access-key", `${"AK"}IA${rnd(16, 21, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}`],
  ["github-token", `${"gh"}p_${rnd(36, 22)}`],
  ["anthropic-key", `${"sk"}-ant-${rnd(40, 23)}`],
  ["openai-key", `${"sk"}-proj-${rnd(40, 24)}`],
  ["stripe-key", `${"sk"}_live_${rnd(24, 25)}`],
  ["google-api-key", `${"AI"}za${rnd(35, 26)}`],
  ["npm-token", `${"n"}pm_${rnd(36, 27)}`],
  ["memrain-pat", `${"mem"}rain_${rnd(64, 28, HEX)}`],
];

describe.each(fixed)("%s after an escape or glue", (kind, key) => {
  it.each([
    ["json \\n", `{"out":"line\\n${key}"}`],
    ["json \\t", `"\\t${key}"`],
    ["json \\u", `"\\u001b${key}"`],
    ["percent", `q=%22${key}%22`],
    ["glued _", `token_${key}`],
    ["ansi raw ESC[32m", `\x1b[32m${key}\x1b[0m`],
    ["ansi raw ESC[1;32m", `out: \x1b[1;32m${key}`],
    ["ansi written \\e[32m", String.raw`\e[32m` + key],
    ["ansi written \\033[32m", String.raw`\033[32m` + key],
    ["ansi written \\x1b[32m", String.raw`\x1b[32m` + key],
    ["ansi json \\u001b[32m", String.raw`"\u001b[32m` + `${key}"`],
  ])("%s", (_name, text) => {
    const r = scanSecrets(text);
    expect(r.findings.map((f) => f.kind)).toEqual([kind]);
    expect(r.text).not.toContain(key);
  });
});

describe("escaped and glued starts", () => {
  const v = rnd(24, 30);
  const ghp = `${"gh"}p_${rnd(36, 32)}`;
  const ant = `${"sk"}-ant-${rnd(40, 33)}`;
  it.each([
    ["escaped JSON assignment", String.raw`{\"password\":\"${v}\"}`, "high-entropy-assignment", v],
    ["\\u003a separator", String.raw`password\u003a${v}`, "high-entropy-assignment", v],
    ["%3D separator", `token%3D${v}`, "high-entropy-assignment", v],
    ["\\n before ghp_", String.raw`"\n${ghp}"`, "github-token", ghp],
    ["\\t before sk-ant-", String.raw`"\t${ant}"`, "anthropic-key", ant],
    ["%22 before sk-ant-", `%22${ant}%22`, "anthropic-key", ant],
    ["glued after _", `token_${ghp}`, "github-token", ghp],
  ])("%s", (_name, text, kind, secret) => {
    const r = scanSecrets(text);
    expect(r.findings.map((f) => f.kind)).toEqual([kind]);
    expect(r.text).not.toContain(secret);
  });

  it("keeps the escaped quotes of a JSON-escaped assignment around the marker", () => {
    const r = scanSecrets(String.raw`{\"password\":\"${v}\"}`);
    expect(r.text).toMatch(/^\{\\"password\\":\\"\[REDACTED:high-entropy-assignment:[0-9a-f]{16}\]\\"\}$/);
  });

  it("redacts a JSON-escaped assignment after \\n and an escaped bearer header", () => {
    expect(kinds(`{"x":"y\\npassword=${v}"}`)).toEqual(["high-entropy-assignment"]);
    expect(kinds(`{\\"Authorization\\":\\"Bearer ${rnd(32, 31)}\\"}`)).toEqual(["bearer-token"]);
  });

  it("counts a glued open-length key only when it clears the entropy gate", () => {
    const hf = `${"h"}f_${rnd(34, 29)}`;
    expect(kinds(`my_${hf}`)).toEqual(["huggingface-token"]);
    expect(kinds(`prefix_${"xox"}b-not-a-real-token-here-ok`)).toEqual([]);
  });
});

describe("a bearer token after an escaped separator or quote", () => {
  const t = rnd(32, 37);
  it.each([
    ["escaped quote after :", String.raw`Authorization:\"Bearer ${t}`],
    ["escaped JSON on both sides", String.raw`{\"Authorization\":\"Bearer ${t}\"}`],
    ["plain JSON", `{"Authorization":"Bearer ${t}"}`],
    ["%3D%22", `Authorization%3D%22Bearer ${t}`],
    ["%3A%20 and %20", `Authorization%3A%20Bearer%20${t}`],
    ["\\u003a\\u0022", `Authorization\\u003a\\u0022Bearer ${t}`],
    ["\\u003A", `Authorization\\u003ABearer ${t}`],
  ])("%s", (_name, text) => {
    const r = scanSecrets(text);
    expect(r.findings.map((f) => f.kind)).toEqual(["bearer-token"]);
    expect(r.text).not.toContain(t);
  });
});

describe("fixed-shape keys whose rule was word-anchored", () => {
  const sg = `${"SG"}.${rnd(22, 71, B64URL)}.${rnd(43, 72, B64URL)}`;
  const ac = `${"AC"}${rnd(32, 73, HEX)}`;
  const sk = `${"SK"}${rnd(32, 74, HEX)}`;
  describe.each([["twilio-key", ac], ["twilio-key", sk], ["sendgrid-key", sg]])("%s", (kind, key) => {
    it.each([
      ["json \\n", `"\\n${key}"`],
      ["percent", `q=%22${key}%22`],
      ["glued _", `sid_${key}`],
    ])("%s", (_name, text) => {
      const r = scanSecrets(text);
      expect(r.findings.map((f) => f.kind)).toEqual([kind]);
      expect(r.text).not.toContain(key);
    });
  });

  const aws = rnd(40, 75, `${ALNUM}/+`);
  it.each([
    ["escaped JSON", String.raw`{\"aws_secret_access_key\":\"${aws}\"}`],
    ["\\n before the key", `"\\naws_secret_access_key=${aws}"`],
    ["%3D%22", `aws_secret_access_key%3D%22${aws}`],
    ["\\u003a", `AWS_SECRET_ACCESS_KEY\\u003a${aws}`],
    ["glued _", `my_aws_secret_access_key=${aws}`],
  ])("aws-secret-key: %s", (_name, text) => {
    const r = scanSecrets(text);
    expect(r.findings.map((f) => f.kind)).toEqual(["aws-secret-key"]);
    expect(r.text).not.toContain(aws);
  });

  it("slack-webhook: a JSON-escaped URL", () => {
    const path = `T${rnd(10, 76, HEX)}\\/B${rnd(10, 77, HEX)}\\/${rnd(24, 78)}`;
    const r = scanSecrets(`{"url":"https:\\/\\/hooks.slack.com\\/services\\/${path}"}`);
    expect(r.findings.map((f) => f.kind)).toEqual(["slack-webhook"]);
    expect(r.text).toMatch(/^\{"url":"\[REDACTED:slack-webhook:[0-9a-f]{16}\]"\}$/);
  });

  it.each([
    ["AC inside an alphanumeric identifier", `record7${ac}`],
    ["SK inside an alphanumeric identifier", `record7${sk}`],
    ["SendGrid inside an alphanumeric identifier", `record7${sg}`],
    ["lowercase ac in snake_case", `task_ac${rnd(32, 79, HEX)}`],
    ["SK and 31 hex in snake_case", `risk_SK${rnd(31, 80, HEX)}_total`],
    ["AC and 33 hex", `track_AC${rnd(33, 81, HEX)}`],
    ["40-hex git hash starting AC", `commit_AC${rnd(38, 82, HEX)}`],
    ["40-hex git hash after \\n", `"\\nSK${rnd(38, 83, HEX)}"`],
    ["SG.1.2 version glued", "release_SG.1.2.3"],
    ["SG.1.2 version after \\n", `"\\nSG.1.2"`],
    ["SG.1.2 version after %22", "%22SG.1.2%22"],
  ])("near miss: %s", (_name, text) => {
    expect(scanSecrets(text)).toEqual({ text, findings: [] });
  });
});

describe("a rejected start inside a kebab run does not hide a later key", () => {
  it.each([
    ["task-proj- before sk-proj-", `task-proj-cleanup-script-${"sk"}-proj-${rnd(40, 34)}`, "openai-key"],
    ["helpdesk-admin- before sk-admin-", `helpdesk-admin-portal-config-${"sk"}-admin-${rnd(40, 35)}`, "openai-key"],
    ["risk-ant- before sk-ant-", `risk-ant-colony-model-v2-${"sk"}-ant-${rnd(40, 36)}`, "anthropic-key"],
  ])("%s", (_name, text, kind) => {
    expect(kinds(text)).toEqual([kind]);
  });
});

describe("near misses survive byte-identical", () => {
  const blob = `${rnd(80, 60, B64URL)}_${"h"}f_${rnd(30, 61)}${rnd(86, 62, B64URL)}`;
  it("the blob is 200 characters", () => expect(blob).toHaveLength(200));
  it.each([
    ["base64url blob embedding _hf_", blob],
    ["snake_case github_pat_ identifier", `my_${"github"}_pat_helper_function_name_long_enough`],
    ["Windows path", String.raw`C:\new\file`],
    ["Windows path with \\n and npm_", String.raw`C:\new\table\npm_cache_dir`],
    ["URL with %2F", `https://x.test/a%2Fb%2Fc?next=%2Fhome%2F${rnd(20, 63)}`],
    ["%2F before a short sk-ant-", `https://x.test/a%2F${"sk"}-ant-short`],
    ["snake_case after hf_", `my_${"h"}f_token_name_is_long_enough_to_be_thirty_chars`],
    ["snake_case after xox", `my_${"xox"}b_slack_bot_token_config_value_name`],
    ["40-hex git hash", `commit ${rnd(40, 64, HEX)}`],
    ["UUID", `id 3f2b8c1e-9a4d-4e7b-8c2f-1d6a5b9e0c7f`],
  ])("%s", (_name, text) => {
    expect(scanSecrets(text)).toEqual({ text, findings: [] });
  });
});

describe("five more vendors", () => {
  // kind, exact key, one character longer (must not match)
  const vendors: Array<[string, string, string]> = [
    ["openrouter-key", `${"sk"}-or-v1-${rnd(64, 41, HEX)}`, `${"sk"}-or-v1-${rnd(65, 41, HEX)}`],
    ["groq-key", `${"g"}sk_${rnd(52, 42)}`, `${"g"}sk_${rnd(53, 42)}`],
    ["xai-key", `${"x"}ai-${rnd(80, 43)}`, `${"x"}ai-${rnd(81, 43)}`],
    ["perplexity-key", `${"pp"}lx-${rnd(48, 44)}`, `${"pp"}lx-${rnd(49, 44)}`],
    ["replicate-key", `${"r"}8_${rnd(37, 45)}`, `${"r"}8_${rnd(38, 45)}`],
  ];
  it.each(vendors)("%s: exact length only, escaped and glued too", (kind, key, longer) => {
    expect(kinds(`key: ${key}`)).toEqual([kind]);
    expect(kinds(`token_${key}`)).toEqual([kind]);
    expect(kinds(`"\\n${key}"`)).toEqual([kind]);
    expect(kinds(`key: ${longer}`)).toEqual([]);
    expect(kinds(`key: ${key.slice(0, -1)}`)).toEqual([]);
  });
});

describe("echoes of fixed-length vendor keys", () => {
  it("redacts a claimed key where its right edge breaks the rule", () => {
    const key = `${"AK"}IA${rnd(16, 51, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}`;
    const r = scanSecrets(`${key} rotated to ${key}_old and ${key}123`);
    expect(r.text).not.toContain(key);
    expect(r.findings.map((f) => f.kind)).toEqual(["aws-access-key", "aws-access-key-echo", "aws-access-key-echo"]);
  });

  it("covers the five newer vendors too", () => {
    const key = `${"pp"}lx-${rnd(48, 53)}`;
    expect(kinds(`${key} then ${key}x`)).toEqual(["perplexity-key", "perplexity-key-echo"]);
  });

  it("leaves open-length keys out of the dictionary", () => {
    const hf = `${"h"}f_${rnd(34, 52)}`;
    expect(kinds(`${hf}\n${hf}x_y`)).toEqual(["huggingface-token", "huggingface-token"]);
  });
});

describe("linear time", () => {
  const cases: Record<string, (n: number) => string> = {
    "_eyJ repeats": (n) => "_eyJ".repeat(n / 4),
    "escaped vendor prefixes": (n) => String.raw`\nghp_\tAKIA%22sk-ant-`.repeat(n / 20),
    "glued open-length prefixes": (n) => "_hf_-xoxb-_glpat-_sb_secret_-sk-".repeat(n / 32),
    "escaped assignment keys": (n) => String.raw`\"password\":\"\u003a%3D\ntoken%3D`.repeat(n / 36),
    "escaped bearer headers": (n) => String.raw`Authorization\":\"Bearer `.repeat(n / 24),
    "encoded bearer headers": (n) => `Authorization%3D%22Bearer%20\\u003a%20`.repeat(n / 38),
    "five vendor prefixes": (n) => "sk-or-v1-gsk_xai-pplx-r8_".repeat(n / 25),
    "glued and escaped SG. AC SK": (n) => String.raw`_SG.\nAC%22SK_AC`.repeat(n / 18),
    "escaped aws assignments": (n) => String.raw`\naws_secret_access_key\":\"%3D`.repeat(n / 31),
    "escaped slack webhooks": (n) => String.raw`https:\/\/hooks.slack.com\/services\/`.repeat(n / 38),
  };
  for (const [name, make] of Object.entries(cases)) {
    it(`grows linearly: ${name}`, () => {
      const small = make(100_000);
      const large = make(200_000);
      expect(linearityRatio(() => scanSecrets(small), () => scanSecrets(large))).toBeLessThan(3);
    });
  }
});
