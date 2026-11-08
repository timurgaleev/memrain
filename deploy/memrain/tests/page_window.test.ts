import { expect, it } from "bun:test";
import { pageBodyWindow } from "../src/core/page-window.ts";

it("leaves a complete small page alone unless a window is requested", () => {
  expect(pageBodyWindow("small page")).toBeNull();
  expect(pageBodyWindow("small page", { maxBytes: 20 })).toMatchObject({
    body_window: "small page", partial: false, total_bytes: 10, next_offset: null,
  });
});

it("reassembles multibyte text through strictly advancing byte windows", () => {
  const body = "a😀界é\n".repeat(30);
  let offset = 0;
  let result = "";
  for (let i = 0; i < Buffer.byteLength(body); i++) {
    const window = pageBodyWindow(body, { offset, maxBytes: 5 })!;
    expect(Buffer.byteLength(window.body_window)).toBeLessThanOrEqual(5);
    expect(window.body_window).not.toContain("�");
    result += window.body_window;
    if (window.next_offset === null) break;
    expect(window.next_offset).toBeGreaterThan(offset);
    offset = window.next_offset;
  }
  expect(result).toBe(body);
});

it("advances offsets inside a code point and terminates offsets beyond the body", () => {
  expect(pageBodyWindow("😀abc", { offset: 2, maxBytes: 4 })).toMatchObject({ body_window: "abc", offset: 4, next_offset: null });
  expect(pageBodyWindow("😀abc", { offset: 100 })).toMatchObject({ body_window: "", offset: 7, next_offset: null });
});

it("reports UTF-8 heading offsets and ignores headings inside fenced code", () => {
  const prefix = "界\n```markdown\n# Hidden\n```\n";
  const window = pageBodyWindow(prefix + "## Visible\ncontent", { maxBytes: 4 })!;
  expect(window.headings).toEqual([{ text: "Visible", level: 2, offset: Buffer.byteLength(prefix) }]);
});

it("bounds the heading list and each heading even on adversarial input", () => {
  const window = pageBodyWindow(("# " + "x".repeat(500) + "\n").repeat(1000), { maxBytes: 4 })!;
  expect(window.headings).toHaveLength(200);
  expect(window.headings_truncated).toBe(true);
  expect(window.headings.every(h => h.text.length <= 200)).toBe(true);
});
