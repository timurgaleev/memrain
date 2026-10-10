/**
 * The scanner's wider net: vendor prefixes, credentials in URLs, HTTP Basic,
 * keyword assignments gated on entropy, and bare echoes of a claimed value.
 *
 * Every secret-shaped fixture is assembled at run time from fragments or a
 * seeded generator, so no literal credential sits in the repository for a
 * scanner to trip on.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  SECRET_SCAN_VERSION,
  correctedEntropy,
  fingerprintSecret,
  guardFields,
  guardSecrets,
  scanSecrets,
  shannonEntropy,
} from "../src/core/secret-scan.ts";

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";

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

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const kinds = (text: string) => scanSecrets(text).findings.map((f) => f.kind);

const ENV = ["MEMRAIN_SECRET_SCAN_HIGH_ENTROPY", "MEMRAIN_SECRET_SCAN_ECHO", "MEMRAIN_SECRET_SCAN_ALLOW", "MEMRAIN_SECRET_SCAN_DISPOSITION"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("vendor prefixes", () => {
  const cases: Array<[string, string]> = [
    ["google-api-key", `${"AI"}za${rnd(35, 1)}`],
    ["huggingface-token", `${"h"}f_${rnd(34, 2)}`],
    ["npm-token", `${"n"}pm_${rnd(36, 3)}`],
    ["sendgrid-key", `${"S"}G.${rnd(22, 4)}.${rnd(43, 5)}`],
    ["twilio-key", `${"S"}K${rnd(32, 6, HEX)}`],
    ["supabase-key", `${"sb"}_secret_${rnd(32, 7)}`],
    ["supabase-key", `${"sb"}p_${rnd(40, 8, HEX)}`],
    ["stripe-key", `${"wh"}sec_${rnd(32, 9)}`],
    ["digitalocean-token", `${"do"}p_v1_${rnd(64, 10, HEX)}`],
    ["openai-key", `${"s"}k-${rnd(48, 11)}`],
  ];
  for (const [kind, secret] of cases) {
    it(`redacts ${kind} ${secret.slice(0, 4)}…`, () => {
      const r = scanSecrets(`key ${secret} end`);
      expect(r.findings.map((f) => f.kind)).toEqual([kind]);
      expect(r.text).toBe(`key [REDACTED:${kind}:${fingerprintSecret(secret)}] end`);
    });
  }

  it("leaves a longer hex digest and a prefix inside an identifier alone", () => {
    const text = [
      `digest ${"S"}K${rnd(40, 12, HEX)}`,
      `npm ${"n"}pm_${rnd(40, 13)}`,
      `task-${rnd(30, 14)} risk-${rnd(30, 15)}`,
      `x${"AI"}za${rnd(35, 16)}`,
    ].join("\n");
    expect(scanSecrets(text)).toEqual({ text, findings: [] });
  });

  it("covers the redis, amqp and mssql connection schemes", () => {
    for (const scheme of ["redis", "rediss", "amqp", "mssql"]) {
      const url = `${scheme}://app:${rnd(16, 17)}@cache.internal:6379/0`;
      const r = scanSecrets(url);
      expect(r.findings.map((f) => f.kind)).toEqual(["database-url"]);
      expect(r.text).toContain("cache.internal:6379/0");
    }
  });
});

describe("url credentials", () => {
  it("redacts the scheme, user and password of an http(s) URL and keeps the host", () => {
    const pw = rnd(14, 20);
    const r = scanSecrets(`clone HTTPS://deploy:${pw}@git.example.test/org/repo.git now`);
    expect(r.findings.map((f) => f.kind)).toEqual(["url-credentials"]);
    expect(r.text).not.toContain(pw);
    expect(r.text).toContain("git.example.test/org/repo.git now");
  });

  it("leaves placeholders, user-only URLs and an @ in a path alone", () => {
    const text = [
      "https://user:<password>@host.test/",
      "https://user:${PASSWORD}@host.test/",
      "https://user:$PASSWORD@host.test/",
      "https://user:****@host.test/",
      "https://user:xxxx@host.test/",
      "https://user@host.test/",
      "http://localhost:3000/@scope/pkg",
    ].join("\n");
    expect(scanSecrets(text)).toEqual({ text, findings: [] });
  });
});

describe("basic auth", () => {
  it("redacts a Basic credential after an Authorization header, short or long", () => {
    const short = b64("u:p");
    const long = b64(`svc:${rnd(18, 21)}`);
    for (const [line, value] of [
      [`Authorization: Basic ${short}`, short],
      [`curl -H "authorization: basic ${long}"`, long],
      [`{"Authorization": "Basic ${long}"}`, long],
      [`send Basic ${long} upstream`, long],
    ] as const) {
      const r = scanSecrets(line);
      expect(r.findings.map((f) => f.kind)).toEqual(["basic-auth"]);
      expect(r.text).toContain(`[REDACTED:basic-auth:${fingerprintSecret(value)}]`);
    }
  });

  it("leaves prose and base64 that is not user:pass alone", () => {
    const text = [
      "a basic understanding of the system",
      `Basic ${b64("just some words here")}`,
      `Basic ${rnd(24, 22)}`,
    ].join("\n");
    expect(scanSecrets(text)).toEqual({ text, findings: [] });
  });
});

describe("high-entropy assignments", () => {
  it("redacts the value of a keyword assignment and keeps the key", () => {
    const v = `${rnd(14, 30)}7q`;
    for (const line of [`DB_PASSWORD=${v}`, `smtp_password: ${v}`, `"api_key": "${v}"`, `export GH_TOKEN='${v}'`, `client-secret = ${v}`]) {
      const r = scanSecrets(line);
      expect(r.findings.map((f) => f.kind)).toEqual(["high-entropy-assignment"]);
      expect(r.text).toBe(line.replace(v, `[REDACTED:high-entropy-assignment:${fingerprintSecret(v)}]`));
    }
  });

  it("leaves references, placeholders, code and low-entropy values alone", () => {
    const sha = rnd(40, 31, HEX);
    const text = [
      "token = getToken(x)",
      "password = process.env.DB_PASSWORD",
      "db_password: config.secrets.dbPassword2",
      `commit: ${sha}`,
      "password: <password>",
      'secret: "${VAULT_SECRET_1}"',
      "api_key = $(cat /run/secrets/key1)",
      'password = "****************"',
      "token_count=1234567890123",
      "token_file: ./secrets/token-file-01.txt",
      "api_key_url=https://keys.example.test/v1",
      "password=aaaaaaaaaaaa1",
      "secretary: DefaultAzureCredential",
    ].join("\n");
    expect(scanSecrets(text)).toEqual({ text, findings: [] });
  });

  it("does not re-redact a value another rule already replaced", () => {
    const gh = `gh${"p"}_${rnd(36, 32)}`;
    expect(kinds(`"token": "${gh}"`)).toEqual(["github-token"]);
  });

  it("is switched off by MEMRAIN_SECRET_SCAN_HIGH_ENTROPY=0", () => {
    const line = `DB_PASSWORD=${rnd(14, 33)}7q`;
    process.env.MEMRAIN_SECRET_SCAN_HIGH_ENTROPY = "0";
    expect(guardSecrets(line, "t").findings).toEqual([]);
    delete process.env.MEMRAIN_SECRET_SCAN_HIGH_ENTROPY;
    expect(guardSecrets(line, "t").findings.map((f) => f.kind)).toEqual(["high-entropy-assignment"]);
  });

  it("bias-corrects entropy so short random passwords clear the floor", () => {
    expect(shannonEntropy("aaaa")).toBe(0);
    const v = "!dcG4Gmw1qGRbR3";
    expect(shannonEntropy(v)).toBeLessThan(3.5);
    expect(correctedEntropy(v)).toBeGreaterThanOrEqual(3.5);
  });
});

describe("echoes", () => {
  const bearer = `tok_${rnd(30, 40)}`;

  it("redacts a bare echo of a bearer token, before and after its claim", () => {
    const r = scanSecrets(`reply had ${bearer}\nAuthorization: Bearer ${bearer}\nand again ${bearer}.`);
    const fp = fingerprintSecret(bearer);
    expect(r.text).toBe(
      `reply had [REDACTED:bearer-token-echo:${fp}]\nAuthorization: Bearer [REDACTED:bearer-token:${fp}]\nand again [REDACTED:bearer-token-echo:${fp}].`,
    );
    expect(r.findings.map((f) => f.kind)).toEqual(["bearer-token", "bearer-token-echo", "bearer-token-echo"]);
  });

  it("redacts echoes of an assignment value and a URL password", () => {
    const v = `${rnd(14, 41)}9z`;
    const pw = rnd(12, 42);
    const r = scanSecrets(`PASSWORD=${v}\nI typed ${v} twice\nhttps://me:${pw}@h.test/ then ${pw}`);
    expect(r.text).not.toContain(v);
    expect(r.text).not.toContain(pw);
    expect(r.findings.map((f) => f.kind)).toEqual(["url-credentials", "high-entropy-assignment", "high-entropy-assignment-echo", "url-credentials-echo"]);
  });

  it("carries the dictionary across the fields of one write, in either order", async () => {
    const out = await guardFields({ query: async () => ({ rows: [] }) } as never, "ref", null, "test", {
      first: `bare ${bearer} here`,
      second: `Authorization: Bearer ${bearer}`,
      third: `and ${bearer}`,
    });
    for (const v of Object.values(out)) expect(v).not.toContain(bearer);
  });

  it("is switched off by MEMRAIN_SECRET_SCAN_ECHO=0", () => {
    process.env.MEMRAIN_SECRET_SCAN_ECHO = "0";
    expect(guardSecrets(`Authorization: Bearer ${bearer} then ${bearer}`, "t").text).toContain(`then ${bearer}`);
  });

  it("looks for at most 64 values, none longer than 512 characters", () => {
    const values = Array.from({ length: 65 }, (_, i) => `tok_${rnd(24, 100 + i)}`);
    const long = `tok_${rnd(600, 7)}`;
    const claims = [...values, long].map((v) => `Authorization: Bearer ${v}`).join("\n");
    const r = scanSecrets(`${claims}\n${values[0]} ${values[64]} ${long}`);
    expect(r.text).not.toContain(`${values[0]} `);
    expect(r.text).toContain(`${values[64]} ${long}`);
  });

  it("never matches inside a marker it wrote", () => {
    const r = scanSecrets(`Authorization: Bearer ${bearer}\n${bearer}`);
    expect(r.text.match(/\[REDACTED:/g)).toHaveLength(2);
  });
});

describe("format and options", () => {
  it("fingerprints with 16 hex and names the scanner version", () => {
    expect(fingerprintSecret("x")).toMatch(/^[0-9a-f]{16}$/);
    expect(SECRET_SCAN_VERSION).toBe(2);
  });

  it("allows a 16-to-64 hex prefix of the SHA-256 and ignores a 12-hex entry", () => {
    const npm = `${"n"}pm_${rnd(36, 50)}`;
    const full = new Bun.CryptoHasher("sha256").update(npm).digest("hex");
    for (const entry of [full.slice(0, 16), full.slice(0, 40), full]) {
      process.env.MEMRAIN_SECRET_SCAN_ALLOW = `zz, ${entry.toUpperCase()}`;
      expect(guardSecrets(npm, "t").text).toBe(npm);
    }
    process.env.MEMRAIN_SECRET_SCAN_ALLOW = full.slice(0, 12);
    expect(guardSecrets(npm, "t").findings).toHaveLength(1);
  });

  it("keeps the line count of a key block when asked to", () => {
    const pem = [`-----BEGIN ${"EC "}PRIVATE KEY-----`, rnd(64, 51), rnd(64, 52), "-----END EC PRIVATE KEY-----"].join("\n");
    const text = `line 1\n${pem}\nline 6`;
    const kept = scanSecrets(text, new Set(), { preserveLines: true }).text;
    expect(kept.split("\n")).toHaveLength(6);
    expect(kept.split("\n")[5]).toBe("line 6");
    expect(scanSecrets(text).text.split("\n")).toHaveLength(3);
  });
});

describe("linear time", () => {
  /** Best-of-5 wall time of one scan, floored so sub-ms noise cannot fake a ratio. */
  const time = (s: string) => {
    Bun.gc(true);
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      scanSecrets(s);
      best = Math.min(best, performance.now() - t);
    }
    return Math.max(best, 2);
  };
  const fill = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const families: Record<string, (n: number) => string> = {
    vendor: (n) => fill(`${"AI"}za${"a".repeat(34)}-${"h"}f_${"b".repeat(29)} ${"S"}G.${"c".repeat(15)}.${"sb"}_secret_ ${"do"}p_v1_${"e".repeat(63)} sk-`, n),
    "url-credentials": (n) => fill(`http://${"u".repeat(127)}:${"p".repeat(255)}`, n),
    "url-colons": (n) => `https://${":".repeat(n)}`,
    "basic-header": (n) => fill(`authorization: basic ${"QUJD".repeat(600)}`, n),
    "basic-bare": (n) => fill("basic ", n),
    "basic-run": (n) => `Basic ${"A".repeat(n)}`,
    "assignment-underscore": (n) => fill("_token", n),
    "assignment-dash": (n) => fill("-apikey", n),
    "assignment-run": (n) => fill(`token=${"!".repeat(5000)} `, n),
    "assignment-long": (n) => `password=${"a1".repeat(n / 2)}`,
    "assignment-spaces": (n) => fill(`secret${" ".repeat(40)}`, n),
    echo: (n) => {
      const claims = Array.from({ length: 64 }, (_, i) => `Authorization: Bearer ${"A".repeat(400 + i)}${i}`).join("\n");
      return `${claims}\n${"A".repeat(n)}`;
    },
  };
  for (const [name, make] of Object.entries(families)) {
    // Linear is 2x per doubling, quadratic 4x. The rate is taken over two
    // doublings (100 KB -> 400 KB) so one noisy sample cannot decide it.
    it(`grows at most ~2.5x per doubling: ${name}`, () => {
      time(make(20_000));
      const [a, , c] = [100_000, 200_000, 400_000].map((n) => time(make(n)));
      expect(Math.sqrt(c! / a!)).toBeLessThan(2.5);
    });
  }
});
