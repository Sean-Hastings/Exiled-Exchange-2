import { describe, expect, it } from "vitest";
import {
  MANUAL_SURVEY_BASE_ID,
  buildManualSurveySteps,
  emptyManualSession,
  filterCopyText,
  manualProgress,
  manualSessionToSurveyDoc,
  recordManualAnswer,
} from "@/web/price-check/tablets/manual-tier-survey";

describe("manual-tier-survey", () => {
  it("builds Temple steps as trade type + filter name/range (no regex)", () => {
    const steps = buildManualSurveySteps(MANUAL_SURVEY_BASE_ID);
    expect(steps[0]?.kind).toBe("anchor-blank");
    expect(steps[1]?.kind).toBe("anchor-dump");
    expect(steps[0]?.typeName).toMatch(/Temple/i);
    expect(steps[0]?.filterName).toBeNull();
    expect(filterCopyText(steps[0]!)).toMatch(/Temple/i);
    expect(steps.every((s) => s.kind !== "pair")).toBe(true);
    expect(steps.length).toBeGreaterThan(8);
    expect(steps.length).toBeLessThanOrEqual(20);

    const singles = steps.filter((s) => s.kind === "single");
    expect(singles.length).toBeGreaterThan(0);
    for (const s of singles) {
      expect(s.filterName).toBeTruthy();
      expect(s.filterName!.includes('"')).toBe(false);
      expect(s.filterMin).toBeTypeOf("number");
      expect(s.filterRangeLabel).toMatch(/min /);
      expect(filterCopyText(s)).toBe(s.filterName);
    }
  });

  it("records sell price and no-results into a survey doc", () => {
    const steps = buildManualSurveySteps(MANUAL_SURVEY_BASE_ID);
    let session = emptyManualSession();
    session = recordManualAnswer(session, steps[0], { sellEx: 40 });
    session = recordManualAnswer(session, steps[1], { sellEx: 8 });
    session = recordManualAnswer(session, steps[2], { noResults: true });
    const { done, total } = manualProgress(session, steps);
    expect(done).toBe(3);
    expect(total).toBe(steps.length);
    const doc = manualSessionToSurveyDoc(session, steps);
    expect(doc.baseId).toBe("temple_tablet");
    expect(doc.baseName).toMatch(/Temple/i);
    expect(doc.anchors.blankBuyEx).toBe(40);
    expect(doc.anchors.dumpEx).toBe(8);
    expect(doc.observations[steps[2].key]?.error).toMatch(/no results/);
  });
});
