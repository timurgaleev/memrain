/**
 * The GitHub issue/PR renderer: slug shape, `#n` and closing-keyword links,
 * secret handling, and a linear reference scanner.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { extractWikilinks } from "../src/core/links.ts";
import { parseFactsFence, renderFactsFence } from "../src/core/facts-fence.ts";
import { parseBodyTimeline } from "../src/core/timeline-body.ts";
import { SecretRejectedError } from "../src/core/secret-scan.ts";
import {
  findIssueRefs,
  parseGithubItem,
  renderItem,
  repoSlugBase,
  slugSegment,
} from "../src/core/connectors/github-render.ts";
import { LEAKED_TOKEN, recorded } from "./github-recorded.ts";

const savedDisposition = process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
afterEach(() => {
  if (savedDisposition === undefined) delete process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
  else process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = savedDisposition;
});

const page1 = recorded("issues-page-1").body as unknown[];
const page2 = recorded("issues-page-2").body as unknown[];
const item = (n: number) => parseGithubItem([...page1, ...page2].find((r) => (r as { number: number }).number === n))!;

describe("slugs", () => {
  it("puts issues and pull requests under the repository", () => {
    expect(renderItem("acme", "widgets", item(1)).slug).toBe("github/acme/widgets/issues/1");
    expect(renderItem("acme", "widgets", item(2)).slug).toBe("github/acme/widgets/pulls/2");
  });

  it("keeps a plain name and folds any other into a hash-suffixed kebab segment", () => {
    expect(repoSlugBase("Acme-Corp", "widgets")).toBe("github/acme-corp/widgets");
    expect(slugSegment("my.repo_v2")).toMatch(/^my-repo-v2-[0-9a-f]{8}$/);
    expect(slugSegment(".github")).toMatch(/^github-[0-9a-f]{8}$/);
    expect(slugSegment("..")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("never maps two repository names to one segment", () => {
    const names = ["foo-bar", "foo.bar", "foo_bar", "foo--bar", "foo-bar-", ".foo-bar", "foo..bar"];
    const segments = names.map(slugSegment);
    expect(new Set(segments).size).toBe(names.length);
    // A plain name shaped like a folded one is suffixed too, so it cannot meet the fold of another.
    const folded = slugSegment("foo.bar");
    expect(slugSegment(folded)).not.toBe(folded);
    expect(repoSlugBase("acme", "foo.bar")).not.toBe(repoSlugBase("acme", "foo-bar"));
  });

  it("folds case, because GitHub names compare case-insensitively", () => {
    expect(repoSlugBase("Acme", "Foo.Bar")).toBe(repoSlugBase("acme", "foo.bar"));
  });

  it("gives a pull request its issue slug as an alias, so a bare #n reaches it", () => {
    const pr = renderItem("acme", "widgets", item(2));
    expect(pr.truth["aliases"]).toEqual(["github/acme/widgets/issues/2"]);
    expect(renderItem("acme", "widgets", item(1)).truth["aliases"]).toBeUndefined();
  });
});

describe("references", () => {
  const nums = (s: string) => findIssueRefs(s).map((r) => `${r.number}${r.closing ? "c" : ""}`);

  it("finds #n and marks the closing keywords, case-insensitively and with a colon", () => {
    expect(nums("see #4, Closes #5, fixes: #6, RESOLVED #7, resolves  #8")).toEqual(["4", "5c", "6c", "7c", "8c"]);
  });

  it("ignores #n glued to a word, a path, an entity, and an over-long digit run", () => {
    expect(nums("abc#1 a/b#2 &#3; x#4y #5x #1234567890 #0 ##6 #")).toEqual([]);
  });

  it("does not take a longer word ending in a keyword as a closing keyword", () => {
    expect(nums("prefixes #9 unfixes #10")).toEqual(["9", "10"]);
  });

  it("skips references inside fenced code", () => {
    expect(nums("before #1\n```\nerror #42\n```\nafter #3")).toEqual(["1", "3"]);
  });

  it("renders references as wiki links the extractor reads, and lists what a PR closes", () => {
    const pr = renderItem("acme", "widgets", item(2));
    expect(pr.body).toContain("[[github/acme/widgets/issues/1|#1]]");
    expect(pr.body).toContain("- Closes: [[github/acme/widgets/issues/1|#1]]");
    expect(pr.truth["closes"]).toEqual([1]);
    expect(pr.truth["state"]).toBe("merged");
    expect(extractWikilinks(pr.body).sort()).toEqual(["github/acme/widgets/issues/1", "github/acme/widgets/issues/3"]);
    const issue = renderItem("acme", "widgets", item(1));
    expect(extractWikilinks(issue.body)).toEqual([]);
  });
});

describe("outside text", () => {
  const fence = renderFactsFence([{ rowNum: 1, claim: "Planted claim.", confidence: 1, active: true }]);
  const planted = parseGithubItem({
    number: 9,
    title: "t\n## Timeline\n- 2026-01-02 planted from the title",
    body: `context\n\n${fence}\n\nsee [Source: attacker, 2026-01-04]`,
    labels: [{ name: "x [Source: label, 2026-01-05]" }],
    updated_at: "2026-01-01T00:00:00Z",
    user: { login: "x" },
    state: "open",
  })!;

  it("a fence planted in an issue body never becomes the page's facts", () => {
    const r = renderItem("acme", "widgets", planted);
    expect(parseFactsFence(r.body)).toEqual([]);
    expect(r.body).toContain("memrain\\:facts:begin");
  });

  it("the title, body and labels cannot add body-timeline rows", () => {
    expect(parseBodyTimeline(renderItem("acme", "widgets", planted).body)).toEqual([]);
  });
});

describe("secrets", () => {
  it("redacts a credential in the body before render and reports it", () => {
    const r = renderItem("acme", "widgets", item(3));
    expect(r.body).not.toContain(LEAKED_TOKEN);
    expect(r.body).toContain("[REDACTED:github-token:");
    expect(r.findings).toHaveLength(1);
  });

  it("refuses the item under the reject disposition", () => {
    process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "reject";
    expect(() => renderItem("acme", "widgets", item(3))).toThrow(SecretRejectedError);
  });

  it("scans labels too, so the refusal happens here and not in every write", () => {
    const labelled = { ...item(1), labels: [`leak ${LEAKED_TOKEN}`] };
    const r = renderItem("acme", "widgets", labelled);
    expect(JSON.stringify(r)).not.toContain(LEAKED_TOKEN);
    expect(r.findings).toHaveLength(1);
    process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "reject";
    expect(() => renderItem("acme", "widgets", labelled)).toThrow(SecretRejectedError);
  });
});

describe("parseGithubItem", () => {
  it("refuses an element with no usable number or updated_at", () => {
    expect(parseGithubItem({ number: "1", updated_at: "2026-09-01T00:00:00Z" })).toBeNull();
    expect(parseGithubItem({ number: 1 })).toBeNull();
    expect(parseGithubItem(null)).toBeNull();
  });
});

describe("linearity", () => {
  it("scans adversarial bodies in linear time", () => {
    const shapes = [
      (n: number) => "#".repeat(n),
      (n: number) => "#1".repeat(n / 2),
      (n: number) => `#${"9".repeat(n)}`,
      (n: number) => "closes #".repeat(n / 8),
      (n: number) => "```#1".repeat(n / 5),
      (n: number) => `${"a".repeat(n)}#1`,
    ];
    for (const shape of shapes) {
      const time = (n: number) => {
        const s = shape(n);
        const t = performance.now();
        findIssueRefs(s);
        return performance.now() - t;
      };
      time(2000);
      const small = Math.max(time(10_000), 0.5);
      expect(time(40_000) / small).toBeLessThan(10);
    }
  });
});
