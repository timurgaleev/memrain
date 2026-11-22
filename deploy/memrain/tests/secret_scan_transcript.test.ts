/**
 * The transcript lane's extra rules: cookie values (Cookie / Set-Cookie
 * headers, curl -b, a copy-as-fetch JSON blob), a `.netrc` password (on one
 * line or inside a multi-line stanza), and a key, token or password label whose
 * value sits alone on the next line. Only the transcript lane turns them on;
 * every other write keeps the shared rules.
 *
 * Values are synthetic and assembled from parts.
 */
import { describe, expect, it } from "bun:test";
import { scanSecrets, type ScanOptions } from "../src/core/secret-scan.ts";
import { linearityRatio } from "./helpers/cpu-time.ts";

const SID = ["SYNTH", "cookieA0001fake"].join("");
const CSRF = ["SYNTH", "cookieB0002fake"].join("");
const LANE: ScanOptions = { transcriptRules: true };

/** Markers shortened to `<kind>` so the expected text reads like the input. */
function one(text: string, opts: ScanOptions = LANE): string {
  return scanSecrets(text, new Set(), opts).text.replace(/\[REDACTED:([a-z0-9-]+):[0-9a-f]{16}\]/g, "<$1>");
}

describe("cookie-header: cookie values are redacted, names kept", () => {
  const cases: Array<[string, string, string]> = [
    ["curl -H Cookie with two pairs", `curl -H 'Cookie: sid=${SID}; csrf=${CSRF}' https://app.acme-example.test/`, `curl -H 'Cookie: sid=<cookie-header>; csrf=<cookie-header>' https://app.acme-example.test/`],
    ["curl -H \"cookie:\" lower case", `curl -H "cookie: sid=${SID}" https://app.acme-example.test/`, `curl -H "cookie: sid=<cookie-header>" https://app.acme-example.test/`],
    ["raw request header line", `Cookie: sid=${SID}; lang=en`, `Cookie: sid=<cookie-header>; lang=en`],
    ["Set-Cookie keeps its attributes", `Set-Cookie: sid=${SID}; Path=/; HttpOnly; Secure; Max-Age=3600`, `Set-Cookie: sid=<cookie-header>; Path=/; HttpOnly; Secure; Max-Age=3600`],
    ["quoted cookie value", `Set-Cookie: sid="${SID}"; Path=/`, `Set-Cookie: sid="<cookie-header>"; Path=/`],
    ["curl -b", `curl -b 'sid=${SID}; csrf=${CSRF}' https://app.acme-example.test/`, `curl -b 'sid=<cookie-header>; csrf=<cookie-header>' https://app.acme-example.test/`],
    ["curl --cookie=", `curl --cookie="sid=${SID}" https://app.acme-example.test/`, `curl --cookie="sid=<cookie-header>" https://app.acme-example.test/`],
    ["copy as fetch JSON", `{"headers": {"cookie": "sid=${SID}; csrf=${CSRF}"}}`, `{"headers": {"cookie": "sid=<cookie-header>; csrf=<cookie-header>"}}`],
    ["escaped JSON in a tool call", `{"command": "curl -H \\"Cookie: sid=${SID}\\" https://app.acme-example.test/"}`, `{"command": "curl -H \\"Cookie: sid=<cookie-header>\\" https://app.acme-example.test/"}`],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => {
      const out = one(input);
      expect(out).toBe(expected);
      expect(out).not.toContain(SID);
      expect(out).not.toContain(CSRF);
    });
  }

  it("an apostrophe inside an earlier cookie does not stop parsing", () => {
    expect(one(`Cookie: theme=ab'cd; sid=${SID}`)).toBe("Cookie: theme=ab'cd; sid=<cookie-header>");
  });
  it("a percent-encoded value is redacted, not taken for a placeholder", () => {
    expect(one(`Cookie: sid=%2F${SID}`)).toBe("Cookie: sid=<cookie-header>");
  });
  it("a value holding a comma or a JSON-escaped slash is redacted whole", () => {
    expect(one(`Cookie: sid=${SID},${CSRF}`)).toBe("Cookie: sid=<cookie-header>");
    expect(one(`{"cookie": "sid=abc\\/${SID}"}`)).toBe('{"cookie": "sid=<cookie-header>"}');
  });
  it("curl -b far into a long command line is still a cookie", () => {
    const out = one(`curl -H "X-Trace: ${"t".repeat(600)}" -b 'sid=${SID}' https://app.acme-example.test/`);
    expect(out).not.toContain(SID);
    expect(out).toContain("-b 'sid=<cookie-header>'");
  });
  it("a cookie jar never crowds a later value out of the echo pass", () => {
    const jar = Array.from({ length: 70 }, (_, i) => `c${i}=${["SYNTH", "jarvalue", String(i).padStart(4, "0")].join("")}`).join("; ");
    const pass = ["Synth", "Pass4242Value7"].join("");
    const echo = new Map<string, string>();
    const a = scanSecrets(`Cookie: ${jar}`, new Set(), { ...LANE, echo }).text;
    const b = scanSecrets(`DB_PASSWORD=${pass}`, new Set(), { ...LANE, echo }).text;
    const c = scanSecrets(`I typed ${pass} again`, new Set(), { ...LANE, echo }).text;
    expect(a).not.toContain("SYNTHjarvalue");
    expect(b).not.toContain(pass);
    expect(c).not.toContain(pass);
  });
  it("a cookie value echoed later in the text is scrubbed too", () => {
    expect(one(`Cookie: sid=${SID}\nthe session id is ${SID} right?`)).not.toContain(SID);
  });
  it("a vendor token inside a cookie keeps its own kind and leaves nothing behind", () => {
    const jwt = ["eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"].join("");
    const out = one(`Cookie: token=${jwt}; sid=${SID}`);
    expect(out).toBe("Cookie: token=<jwt>; sid=<cookie-header>");
  });
});

describe("cookie-header: prose, placeholders and short preference values stay", () => {
  for (const text of [
    "I cleared my cookies: nothing changed.",
    "Cookie: chocolate chip, oatmeal raisin.",
    "The Set-Cookie header sets Path=/ and HttpOnly by default.",
    "cookie banners: accept=all is the default on most sites",
    "Check the Cookie: header in devtools if login fails.",
    "Cookie: <your session cookie here>",
    "Cookie: sid=...; theme=...",
    "set it as Cookie: sid=$SID; theme=dark in the request",
  ]) {
    it(JSON.stringify(text), () => expect(one(text)).toBe(text));
  }
  it("short preference values (theme=dark) are not claimed", () => {
    expect(one("Cookie: theme=dark; lang=en")).toBe("Cookie: theme=dark; lang=en");
  });
  it("a -b flag outside a curl command is not a cookie", () => {
    expect(one("git checkout -b feature=abcdefgh12345")).toBe("git checkout -b feature=abcdefgh12345");
  });
  it("curl -b with a cookie-jar file name is left alone", () => {
    expect(one("curl -b cookies.txt -c cookies.txt https://app.acme-example.test/")).toBe("curl -b cookies.txt -c cookies.txt https://app.acme-example.test/");
  });
});

describe("continued curl lines and JSON-escaped quoted values", () => {
  it("a -b cookie on its own continued line of a multi-line curl command is redacted", () => {
    const input = [`curl 'https://app.acme-example.test/api' \\`, `  -H 'accept: */*' \\`, `  -b 'sid=${SID}; csrf=${CSRF}' \\`, "  --compressed"].join("\n");
    const out = one(input);
    expect(out).not.toContain(SID);
    expect(out).not.toContain(CSRF);
    expect(out).toContain("  -b 'sid=<cookie-header>; csrf=<cookie-header>' \\");
  });
  it("a JSON-escaped quoted cookie value is redacted", () => {
    expect(one(`{"headers": "Cookie: sid=\\"${SID}\\"; csrf=\\"${CSRF}\\""}`)).toBe('{"headers": "Cookie: sid=\\"<cookie-header>\\"; csrf=\\"<cookie-header>\\""}');
  });
  it("ordinary text near these shapes stays", () => {
    const notCurl = ["make build \\", "  && git checkout -b feature=abcdefgh12345"].join("\n");
    expect(one(notCurl)).toBe(notCurl);
    const ended = ["curl https://app.acme-example.test/ \\", "  --compressed", "git checkout -b feature=abcdefgh12345"].join("\n");
    expect(one(ended)).toBe(ended);
    const prefs = '{"headers": "Cookie: theme=\\"dark\\"; lang=\\"en\\""}';
    expect(one(prefs)).toBe(prefs);
    const prose = '{"msg": "tick the cookie: \\"remember me\\" box"}';
    expect(one(prose)).toBe(prose);
  });
});

describe("netrc-password", () => {
  const pw = ["Synth", "NetrcMulti4321"].join("");
  it("a one-line entry, bare and quoted", () => {
    expect(one(`machine api.acme-example.test login alice-example password ${pw}`))
      .toBe("machine api.acme-example.test login alice-example password <netrc-password>");
    expect(one(`machine api.acme-example.test login alice-example password "${pw}"`))
      .toBe('machine api.acme-example.test login alice-example password "<netrc-password>"');
  });
  it("an entry written over several lines", () => {
    for (const text of [
      `machine api.acme-example.test\n  login alice-example\n  password ${pw}`,
      `machine api.acme-example.test\nlogin alice-example\npassword "${pw}"`,
      `machine api.acme-example.test login alice-example\n    password ${pw}`,
      `default\n  password ${pw}\n  login alice-example`,
    ]) {
      const out = one(text);
      expect([text, out.includes(pw)]).toEqual([text, false]);
      expect(out).toContain("<netrc-password>");
    }
  });
  it("a blank or comment line inside a stanza does not end it", () => {
    for (const text of [
      `machine api.acme-example.test\nlogin alice-example\n\npassword ${pw}`,
      `machine api.acme-example.test\n# service account\nlogin alice-example\npassword ${pw}`,
      `machine api.acme-example.test\n  login alice-example\n  # rotated monthly\n\n  password "${pw}"`,
    ]) {
      expect([text, one(text).includes(pw)]).toEqual([text, false]);
    }
  });
  it("prose near a .netrc shape is not redacted", () => {
    for (const text of [
      "machine learning\npassword managers are useful",
      "machine api.acme-example.test\nthen we talked\npassword hunter2x",
      "we used the machine api.acme-example.test\npassword Synth4242pw",
    ]) {
      expect(one(text)).toBe(text);
    }
  });
});

describe("labeled-credential: a label at the end of a line, the value alone on the next", () => {
  const KEY = ["Synth3tic", "ApiKeyValue0042"].join("");
  const TOKEN = ["Synth3tic", "Tok3nValue0099"].join("");
  const PW = ["Synth", "-pw-split-9"].join("");
  it("access token label", () => {
    expect(one(`ok, the access token:\n${TOKEN}`)).toBe("ok, the access token:\n<labeled-credential>");
  });
  it("API key label in an env-style note", () => {
    expect(one(`OpenAI api key:\n  ${KEY}`)).toBe("OpenAI api key:\n  <labeled-credential>");
  });
  it("password label", () => {
    expect(one(`password:\n${PW}`)).toBe("password:\n<labeled-credential>");
  });
  it("the joined value is scrubbed where it is echoed later", () => {
    expect(one(`api key:\n${KEY}\nI set it to ${KEY} in the config`)).not.toContain(KEY);
  });
  it("prose, short words, paths, versions and code references stay", () => {
    for (const text of [
      "here is my API key:\nhold on, looking for it",
      "Next token:\nThanks",
      "the secret:\nnothing to see",
      "api key:\nmissing",
      "token:\nabc123",
      "token:\nsrc/core/foo1.ts",
      "the token:\nconfig2024.json",
      "token:\nv2.1.0-rc1-build",
      "the token:\nprocess.env.API_TOKEN_V2",
      "password:\nrequired",
    ]) {
      expect(one(text)).toBe(text);
    }
  });
  it("a value two lines later is not joined", () => {
    expect(one(`password:\none sec\n${PW}`)).toBe(`password:\none sec\n${PW}`);
  });
  it("a dangling label carried in from the previous message reads the first non-blank line", () => {
    expect(one(`\n\n${KEY}\nand the rest`, { ...LANE, leadingDangling: "key" })).toBe("\n\n<labeled-credential>\nand the rest");
    expect(one(`${PW}`, { ...LANE, leadingDangling: "single" })).toBe("<labeled-credential>");
  });
});

describe("labeled-credential: the label and its value on one line", () => {
  const PW = ["hunt", "er2"].join("");
  const PW2 = ["Summer", "2024"].join("");
  const PAIR = ["s3", "cret!x"].join("");
  it("a password label with its value", () => {
    expect(one(`password: ${PW}!`)).toBe("password: <labeled-credential>!");
    expect(one(`passwd=${PW2}!`)).toBe("passwd=<labeled-credential>!");
    expect(one(`DB_PASSWORD="${PW} two"`)).toBe('DB_PASSWORD="<labeled-credential>"');
    expect(one(`**Password:** ${PW}`)).toBe("**Password:** <labeled-credential>");
  });
  it("a user/password pair keeps the user", () => {
    expect(one(`login: alice / ${PAIR}`)).toBe("login: alice / <labeled-credential>");
    expect(one(`creds alice:${PAIR}`)).toBe("creds alice:<labeled-credential>");
  });
  it("a password flag and openssl's pass: argument", () => {
    expect(one(`mysql -u root --password ${PW2}x -h db`)).toBe("mysql -u root --password <labeled-credential> -h db");
    expect(one(`tool --db-pass "${PW} two"`)).toBe('tool --db-pass "<labeled-credential>"');
    expect(one(`openssl rsa -in k.pem -passin pass:${PW2}x`)).toBe("openssl rsa -in k.pem -passin pass:<labeled-credential>");
  });
  it("a Markdown password column and a password key cell", () => {
    expect(one(`| user | Password |\n|---|---|\n| alice | ${PW2}x |`)).toBe("| user | Password |\n|---|---|\n| alice | <labeled-credential> |");
    expect(one(`| host | db1 |\n| password | \`${PW2}x\` |`)).toBe("| host | db1 |\n| password | `<labeled-credential>` |");
  });
  it("prose, settings, placeholders, flags and code stay", () => {
    for (const text of [
      "password: required",
      "the password: see below",
      "PASSWORD_FILE=/run/secrets/db",
      "PASSWORD_MIN_LENGTH=12",
      "password: <your-password>",
      "password: ${DB_PASSWORD}",
      "mysql --password --host db",
      "tool --password-file creds.txt",
      "login: Google/Codeberg SSO",
      "credentials: docs/auth.md",
      "set `password=` in the config",
      "join https://zoom.example.test/j/1?pwd=abc123XYZ",
      "| Password | Notes |\n|---|---|\n| required | set on first login |",
    ]) {
      expect(one(text)).toBe(text);
    }
  });
  it("is off outside the transcript lane", () => {
    expect(one(`password: ${PW}!`, {})).toBe(`password: ${PW}!`);
  });
});

describe("the transcript rules are off everywhere else", () => {
  it("a write without transcriptRules keeps cookies, .netrc passwords and split labels", () => {
    const pw = ["Synth", "Netrc98765"].join("");
    for (const text of [
      `Cookie: sid=${SID}`,
      `machine api.acme-example.test login alice-example password ${pw}`,
      `here is my API key:\n${["Synth3tic", "ApiKeyValue0042"].join("")}`,
    ]) {
      expect(one(text, {})).toBe(text);
    }
  });
});

describe("a rejected candidate does not hide the next secret", () => {
  const v = ["Abc123", "Xyz789Q", "k2Lm"].join("");
  it("a path value rejected after token= leaves the later password found", () => {
    const out = one(`token=./run.sh?password=${v}`, {});
    expect(out).not.toContain(v);
    expect(out).toContain("<high-entropy-assignment>");
  });
  it("an encoded URL value rejected after token%3D leaves the later password found", () => {
    const out = one(`token%3Dhttps%3A%2F%2Fexample.org%2Fcb?password=${v}`, {});
    expect(out).not.toContain(v);
  });
});

describe("the transcript rules scan in linear time", () => {
  const seeds = [
    "Cookie: a=bcdefghij; ",
    "cookie:cookie:",
    "curl -b x=abcdefghij \\\n",
    "machine host login u\n",
    "password:\n",
    "here is my API key:\n",
    "login: alice /\n",
    "machine api password ",
    "password: a ",
    "login: a / b ",
    "--password x ",
    "| password | x |\n",
  ];
  for (const seed of seeds) {
    it(`grows linearly on ${JSON.stringify(seed)}`, () => {
      const unit = seed.repeat(Math.ceil(1000 / seed.length));
      const small = unit.repeat(20);
      const large = unit.repeat(200);
      const scan = (text: string) => () => void scanSecrets(text, new Set(), LANE);
      scan(large)();
      // 10x the input costs ~10x when linear, ~100x when quadratic; best of five CPU runs, sides interleaved.
      expect(linearityRatio(scan(small), scan(large), { repeat: 5 })).toBeLessThan(20);
    }, 60_000);
  }
});
