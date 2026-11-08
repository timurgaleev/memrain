import { expect, it } from "bun:test";
import { identifierTokens } from "../src/core/search/identifier-probe.ts";

it("recognizes references, hashes, versions, email, URLs and mixed identifiers", () => {
  expect(identifierTokens("Find #412, abcdef123, v1.9.0, user@example.test, https://example.test/a/42 and INV-2026 or 123456."))
    .toEqual(["#412", "abcdef123", "v1.9.0", "user@example.test", "https://example.test/a/42", "INV-2026", "123456"]);
});

it("ignores ordinary words, short bare numbers and formatted telephone numbers", () => {
  expect(identifierTokens("what did weekly digest 412 say; call +123456789 or 123-456-789"))
    .toEqual([]);
  expect(identifierTokens("Find #412 and #412")).toEqual(["#412"]);
});
