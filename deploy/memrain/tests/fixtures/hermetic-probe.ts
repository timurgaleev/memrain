/**
 * Run with `bun test` by hermetic_env.test.ts: prints, as one JSON line, the
 * AWS variables this test process still sees after the bunfig preload.
 */
import { it } from "bun:test";

it("reports the AWS env it sees", () => {
  console.log(`HERMETIC_PROBE ${JSON.stringify(Object.keys(process.env).filter((k) => k.startsWith("AWS_")).sort())}`);
});
