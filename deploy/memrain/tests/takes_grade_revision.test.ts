import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { runTakeMutation } from "../src/core/synthesis/takes-write-page.ts";
import { gradeTakesPhase } from "../src/core/synthesis/takes.ts";
import { getTakesScorecard, getTakesCalibration } from "../src/core/synthesis/reads.ts";
import { calibrationProfilePhase } from "../src/core/synthesis/calibration.ts";

for (const spec of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`canonical grade revision (${spec.name})`, () => {
  it("retains historical grades without attributing them to a changed claim or preventing regrading", async () => {
    const db = await spec.open();
    try {
      const e = db.storage.engine();
      const slug = "notes/grade-revision";
      const actor = { principal: "operator" };
      await putPage(db.storage, { slug, markdown_body: "Synthetic grade fixture." });
      await runTakeMutation(db.storage, { slug, expectedVersion: 1, actor,
        mutation: { op: "add", claim: "The result is 100", kind: "prediction", holder: "world" } });
      let calls = 0;
      const grade = () => gradeTakesPhase(e, { minAgeDays: 0, promptVersion: "revision-v1", autoResolve: false,
        evidenceFn: async () => "The result is 100",
        llmFn: async () => { calls++; return { text: JSON.stringify({ verdict: calls === 1 ? "correct" : "incorrect", confidence: 0.9, reasoning: "Measured result" }), modelId: "fixture" }; } });
      expect((await grade()).gradesWritten).toBe(1);
      const old = (await e.query("SELECT * FROM synth_take_grades ORDER BY id")).rows;
      expect((await getTakesScorecard(e)).correct).toBe(1);
      await runTakeMutation(db.storage, { slug, expectedVersion: 2, actor,
        mutation: { op: "update", rowNum: 1, claim: "The result is 999" } });
      const revised = await getTakesScorecard(e);
      expect(revised).toMatchObject({ correct: 0, resolved: 0, graded: 0 });
      expect(await getTakesCalibration(e)).toEqual([]);
      const profile = await calibrationProfilePhase(e, { minGraded: 1, llmFn: async () => { throw new Error("No current grades to summarize"); } });
      expect(profile.totalGraded).toBe(0);
      expect((await e.query("SELECT * FROM synth_take_grades ORDER BY id")).rows).toEqual(old);
      expect((await grade()).gradesWritten).toBe(1);
      expect(calls).toBe(2);
      expect((await getTakesScorecard(e)).incorrect).toBe(1);
      expect((await e.query("SELECT * FROM synth_take_grades ORDER BY id")).rows.slice(0, 1)).toEqual(old);
      expect((await grade()).takesScanned).toBe(0);
      expect(calls).toBe(2);
    } finally { await db.close(); }
  });
});
