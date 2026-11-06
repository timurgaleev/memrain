/**
 * patches/postgres@3.4.9.patch must reach both copies of the driver: Bun
 * loads the ESM build, but anything that `require`s postgres gets the CJS
 * one, and a fix applied to only one copy silently comes back in the other.
 * Reads the installed files, so a hunk dropped from the patch fails here.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const COPIES = ["src/connection.js", "cjs/src/connection.js"];
const read = (rel: string) =>
  readFileSync(join(import.meta.dir, "../node_modules/postgres", rel), "utf8");

const FIXES: Record<string, string> = {
  "row counter reset on ReadyForQuery":
    "    result = new Result()\n" +
    "    // A query that failed after DataRow left the counter past its rows; the next result would open with holes.\n" +
    "    rows = 0\n",
  "unbuilt pipelined query kept out of the reply order":
    "      if (query !== q && sent.remove(q)) {\n" +
    "        queryError(q, error)\n" +
    "        return true\n" +
    "      }\n",
};

describe("postgres driver patch", () => {
  for (const [fix, snippet] of Object.entries(FIXES)) {
    it(`applies the ${fix} to both driver copies`, () => {
      expect(COPIES.filter((c) => !read(c).includes(snippet))).toEqual([]);
    });
  }
});
