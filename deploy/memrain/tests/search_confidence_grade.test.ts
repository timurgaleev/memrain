import { afterAll, beforeAll, describe, expect, it, setSystemTime } from "bun:test";
import { gradeConfidence } from "../src/core/search/confidence-grade.ts";
import { publicSearchMeta } from "../src/core/search/search-meta.ts";
import {
  FIXED_NOW,
  clearRankFlags,
  openRankFixture,
  runSearch,
  type RankFixture,
} from "./rank-flags-fixture.ts";

describe("gradeConfidence", () => {
  it("grades on the head hits' evidence", () => {
    expect(gradeConfidence([]).grade).toBe("weak");
    expect(gradeConfidence([{ evidence: "exact_title_match" }]).grade).toBe("strong");
    expect(gradeConfidence([{ evidence: "high_vector_match" }]).grade).toBe("strong");
    expect(gradeConfidence([{ evidence: "alias_hit" }]).grade).toBe("strong");
    expect(gradeConfidence([{ evidence: "keyword_exact" }]).grade).toBe("moderate");
    expect(gradeConfidence([{ evidence: "weak_semantic" }, { evidence: "keyword_exact" }]).grade).toBe("moderate");
    expect(gradeConfidence([{ evidence: "weak_semantic" }, { evidence: "weak_semantic" }]).grade).toBe("weak");
  });

  it("looks no further than the evidence rank band", () => {
    const hits = [
      { evidence: "weak_semantic" as const },
      { evidence: "weak_semantic" as const },
      { evidence: "weak_semantic" as const },
      { evidence: "high_vector_match" as const },
    ];
    expect(gradeConfidence(hits).grade).toBe("weak");
  });
});

describe("confidence on the search meta", () => {
  let fx: RankFixture;
  beforeAll(async () => {
    clearRankFlags();
    setSystemTime(FIXED_NOW);
    fx = await openRankFixture();
  });
  afterAll(async () => {
    setSystemTime();
    await fx.close();
  });

  it("reports the grade to the operator and never to a public caller", async () => {
    const named = await runSearch(fx.storage, "Quandalore");
    expect(named.meta?.confidence?.grade).toBe("strong");
    expect(publicSearchMeta(named.meta!)).not.toHaveProperty("confidence");

    const paraphrase = await runSearch(fx.storage, "automobile servicing");
    expect(paraphrase.meta?.confidence).toEqual({
      grade: "weak",
      reason: "head holds only weak_semantic hits",
    });
  });
});
