import { describe, expect, it } from "vitest";
import {
  buildManualBreachSteps,
  emptyManualSession,
  manualProgress,
  manualSessionToSurveyDoc,
  recordManualAnswer,
} from "@/web/price-check/tablets/manual-tier-survey";

describe("manual-tier-survey", () => {
  it("keeps the hand-entry queue short (anchors + singles)", () => {
    const steps = buildManualBreachSteps("breach_tablet");
    expect(steps[0]?.kind).toBe("anchor-blank");
    expect(steps[1]?.kind).toBe("anchor-dump");
    expect(steps.every((s) => s.kind !== "pair")).toBe(true);
    expect(steps.length).toBeGreaterThan(10);
    expect(steps.length).toBeLessThanOrEqual(20);
    for (const s of steps) {
      expect(s.regex.startsWith('"')).toBe(true);
      expect(s.regex.length).toBeLessThanOrEqual(50);
    }
  });

  it("records sell price and no-results into a survey doc", () => {
    const steps = buildManualBreachSteps("breach_tablet");
    let session = emptyManualSession();
    session = recordManualAnswer(session, steps[0], { sellEx: 40 });
    session = recordManualAnswer(session, steps[1], { sellEx: 8 });
    session = recordManualAnswer(session, steps[2], { noResults: true });
    const { done, total } = manualProgress(session, steps);
    expect(done).toBe(3);
    expect(total).toBe(steps.length);
    const doc = manualSessionToSurveyDoc(session, steps);
    expect(doc.anchors.blankBuyEx).toBe(40);
    expect(doc.anchors.dumpEx).toBe(8);
    expect(doc.observations[steps[2].key]?.error).toMatch(/no results/);
  });
});
