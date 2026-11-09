import { describe, expect, it } from "bun:test";
import { fingerprintSecret, scanSecrets } from "../src/core/secret-scan.ts";
import { linearityRatio } from "./helpers/cpu-time.ts";

const key = ["gh", "p_", "A1b2C3d4".repeat(4), "Zz9Y"].join("");
const unicode = (s: string) => [...s].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
const marker = `[REDACTED:github-token:${fingerprintSecret(key)}]`;

describe("encoded credential bodies", () => {
  it.each([
    ["Unicode key", unicode(key)],
    ["Unicode body", key.slice(0, 4) + unicode(key.slice(4))],
    ["zero-width space", key.slice(0, 12) + "\u200B" + key.slice(12)],
    ["zero-width joiners", [...key].join("\u200D")],
    ["escaped zero-width", key.slice(0, 12) + "\\u200b" + key.slice(12)],
  ])("redacts %s using the decoded fingerprint, preserving surrounding bytes", (_name, encoded) => {
    const text = `before \\u0041\nvalue="${encoded}"\nafter`;
    expect(scanSecrets(text)).toEqual({
      text: `before \\u0041\nvalue="${marker}"\nafter`,
      findings: [{ kind: "github-token", fingerprint: fingerprintSecret(key) }],
    });
  });

  it("maps an escaped assignment value without changing its quotes or separator", () => {
    const password = "p5!Az2#Rq9$Bw8%Ks7";
    const text = `password\\u003a\\u0022${unicode(password)}\\u0022`;
    expect(scanSecrets(text)).toEqual({
      text: `password\\u003a\\u0022[REDACTED:high-entropy-assignment:${fingerprintSecret(password)}]\\u0022`,
      findings: [{ kind: "high-entropy-assignment", fingerprint: fingerprintSecret(password) }],
    });
  });

  it("redacts percent-encoded Slack webhook separators as one credential", () => {
    const url = ["https://hooks.", "slack.com/services/", "T123456789/B987654321/abcDEF0123456789xyz"].join("");
    const encoded = url.replaceAll(":", "%3A").replaceAll("/", "%2f");
    expect(scanSecrets(`link=${encoded}&after=plain`)).toEqual({
      text: `link=[REDACTED:slack-webhook:${fingerprintSecret(url)}]&after=plain`,
      findings: [{ kind: "slack-webhook", fingerprint: fingerprintSecret(url) }],
    });
  });

  it("decodes one base64 layer only in a credential assignment", () => {
    const encoded = Buffer.from(key).toString("base64");
    expect(scanSecrets(`api_key = "${encoded}"`, new Set(), { highEntropy: false })).toEqual({
      text: `api_key = "${marker}"`, findings: [{ kind: "github-token", fingerprint: fingerprintSecret(key) }],
    });
    for (const text of [encoded, `data="${encoded}"`, `api_key="${Buffer.from(encoded).toString("base64")}"`,
      `api_key="${Buffer.from("ordinary printable text").toString("base64")}"`, `api_key="${encoded}!!!!"`]) {
      expect(scanSecrets(text, new Set(), { highEntropy: false })).toEqual({ text, findings: [] });
    }
  });

  it("honors decoded allowlists for Unicode, zero-width and base64 assignments", () => {
    for (const encoded of [unicode(key), [...key].join("\u200C"), Buffer.from(key).toString("base64")]) {
      const text = `api_key="${encoded}"`;
      expect(scanSecrets(text, new Set([fingerprintSecret(key)]))).toEqual({ text, findings: [] });
    }
  });

  it("keeps an existing allowlist entry for the original encoded value valid", () => {
    const encoded = unicode(key);
    const text = `api_key="${encoded}"`;
    expect(scanSecrets(text, new Set([fingerprintSecret(encoded)]))).toEqual({ text, findings: [] });
  });

  it("finds a bounded key inside a long prose line or JSON record", () => {
    for (const prefix of ["ordinary prose ".repeat(1000), `{"padding":"${"x".repeat(14000)}","value":"`]) {
      const text = `${prefix}${unicode(key)}" suffix`;
      expect(scanSecrets(text).text).toBe(`${prefix}${marker}" suffix`);
    }
  });

  it("does not partially redact an allowed key with only its last character encoded", () => {
    const longer = key + "Aa2Z";
    const encoded = longer.slice(0, -1) + unicode(longer.slice(-1));
    const other = key.replaceAll("A", "B");
    const text = `allowed="${encoded}" other=${other}`;
    const r = scanSecrets(text, new Set([fingerprintSecret(longer)]));
    expect(r.text).toContain(`allowed="${encoded}"`);
    expect(r.text).not.toContain(other);
    expect(r.findings).toHaveLength(1);
  });

  it("keeps the original fingerprint of a private-key block containing encoded text", () => {
    const block = ["-----BEGIN PRIVATE KEY-----", unicode(key), "-----END PRIVATE KEY-----"].join("\n");
    expect(scanSecrets(block)).toEqual({
      text: `[REDACTED:private-key:${fingerprintSecret(block)}]`,
      findings: [{ kind: "private-key", fingerprint: fingerprintSecret(block) }],
    });
  });

  it("keeps encoded claims and their plain echoes protected across one write", () => {
    const echo = new Map<string, string>();
    expect(scanSecrets(unicode(key), new Set(), { echo }).text).toBe(marker);
    const bare = scanSecrets(`saved=${key}_old`, new Set(), { echo, highEntropy: false });
    expect(bare.text).not.toContain(key);
    expect(bare.findings.some(f => f.fingerprint === fingerprintSecret(key))).toBe(true);
  });

  it("preserves near misses, invalid encodings and ordinary Unicode prose", () => {
    for (const text of ["word\u200Bword", "\\u0048\\u0069", "value=\\u00GG", "https%3A%2F%2Fexample.test%2Fdocs",
      `blob=${"a".repeat(6000)}\\u0041`, `\\\\u0067hp_not_a_key`, "a%2Fb%2Fc", "x\\uD800y"]) {
      expect(scanSecrets(text)).toEqual({ text, findings: [] });
    }
  });

  it("is idempotent and preserves real newline counts", () => {
    const text = `one\n${unicode(key)}\n${[...key].join("\u200B")}\nend`;
    const first = scanSecrets(text, new Set(), { preserveLines: true });
    expect(first.text.split("\n")).toHaveLength(4);
    expect(scanSecrets(first.text)).toEqual({ text: first.text, findings: [] });
  });

  it("has bounded work on long invalid encoded runs", () => {
    const input = (n: number) => `blob=${"\\u0061".repeat(n)} ${"x%2F".repeat(n)}`;
    const small = input(20000);
    const large = input(40000);
    expect(scanSecrets(large)).toEqual({ text: large, findings: [] });
    expect(linearityRatio(() => { scanSecrets(small); }, () => { scanSecrets(large); })).toBeLessThan(3.2);
  });

  it("scales linearly when many separate encoded keys need redaction", () => {
    const line = `${unicode(key)}\n`;
    const small = line.repeat(8000);
    const large = line.repeat(16000);
    expect(linearityRatio(() => { scanSecrets(small); }, () => { scanSecrets(large); })).toBeLessThan(3.2);
  }, 20000);
});
