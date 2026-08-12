import { describe, expect, it } from "vitest";
import {
  analyzeTierSurvey,
  coarsePattern,
  computeOctave,
} from "@/web/price-check/tablets/tier-survey-analyze";
import {
  appendDoubleFollowUps,
  buildBreachSurveyQueue,
  createSurveyDocument,
  deferUnfinishedSplinters,
  surveyItemTouchesSplinter,
  surveyProgress,
} from "@/web/price-check/tablets/tier-survey-plan";
import type { TierSurveyDocument } from "@/web/price-check/tablets/tier-survey-types";

describe("tier-survey-plan", () => {
  it("queues anchors, singles, and pairs for breach", () => {
    const q = buildBreachSurveyQueue("breach_tablet");
    expect(q.some((x) => x.kind === "anchor-dump")).toBe(true);
    expect(q.some((x) => x.kind === "anchor-blank")).toBe(true);
    expect(q.filter((x) => x.kind === "single").length).toBeGreaterThan(8);
    expect(q.filter((x) => x.kind === "pair").length).toBeGreaterThan(20);
  });

  it("queues non-splinter work before splinter work", () => {
    const q = buildBreachSurveyQueue("breach_tablet");
    const body = q.filter(
      (x) => x.kind !== "anchor-blank" && x.kind !== "anchor-dump",
    );
    const firstSplinter = body.findIndex((x) => surveyItemTouchesSplinter(x));
    let lastNon = -1;
    for (let i = 0; i < body.length; i++) {
      if (!surveyItemTouchesSplinter(body[i])) lastNon = i;
    }
    expect(firstSplinter).toBeGreaterThan(-1);
    expect(lastNon).toBeGreaterThan(-1);
    expect(lastNon).toBeLessThan(firstSplinter);
  });

  it("defers unfinished splinters so pass 1 prefers the rest", () => {
    const doc = createSurveyDocument({
      baseId: "breach_tablet",
      leagueId: "Standard",
      fx: { exaltPerChaos: 50, exaltPerDivine: 700 },
    });
    doc.observations["anchor:blank"] = {
      key: "anchor:blank",
      kind: "anchor-blank",
      label: "blank buy",
      modIds: [],
      sellEx: 40,
      updatedAt: Date.now(),
    };
    doc.observations["anchor:dump"] = {
      key: "anchor:dump",
      kind: "anchor-dump",
      label: "junk/rare dump floor",
      modIds: [],
      sellEx: 8,
      updatedAt: Date.now(),
    };
    const n = deferUnfinishedSplinters(doc);
    expect(n).toBeGreaterThan(0);
    const { pending } = surveyProgress(doc);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((p) => !surveyItemTouchesSplinter(p))).toBe(true);
  });

  it("appends same-side doubles for hot singles only", () => {
    const doc = createSurveyDocument({
      baseId: "breach_tablet",
      leagueId: "Standard",
      fx: { exaltPerChaos: 50, exaltPerDivine: 700 },
    });
    doc.anchors.dumpEx = 30;
    doc.observations["single:breach_splinter_qty_t1"] = {
      key: "single:breach_splinter_qty_t1",
      kind: "single",
      label: "s",
      modIds: ["breach_splinter_qty_t1"],
      sellEx: 2000,
      octave: Math.log2(2000 / 30),
      octaveRound: 6,
      updatedAt: Date.now(),
    };
    doc.observations["single:breach_splinter_qty_t2"] = {
      key: "single:breach_splinter_qty_t2",
      kind: "single",
      label: "s",
      modIds: ["breach_splinter_qty_t2"],
      sellEx: 800,
      octave: Math.log2(800 / 30),
      octaveRound: 5,
      updatedAt: Date.now(),
    };
    // Mark all queue items done so follow-ups are the only pending
    for (const item of doc.queue) {
      if (!doc.observations[item.key]) {
        doc.observations[item.key] = {
          key: item.key,
          kind: item.kind,
          label: item.label,
          modIds: item.modIds,
          sellEx: 30,
          octave: 0,
          octaveRound: 0,
          updatedAt: Date.now(),
        };
      }
    }
    const extras = appendDoubleFollowUps(doc);
    expect(extras.some((x) => x.kind === "double")).toBe(true);
    expect(
      extras.some(
        (x) =>
          x.modIds.includes("breach_splinter_qty_t1") &&
          x.modIds.includes("breach_splinter_qty_t2"),
      ),
    ).toBe(true);
  });

  it("uses tier minValue on survey filters (not blanket min:1)", () => {
    const q = buildBreachSurveyQueue("breach_tablet");
    const splinter = q.find((x) => x.key === "single:breach_splinter_qty_t1");
    expect(splinter?.stats[0]?.min).toBe(23);
    const splinterT2 = q.find((x) => x.key === "single:breach_splinter_qty_t2");
    expect(splinterT2?.stats[0]?.min).toBe(15);
  });
});

describe("tier-survey-analyze", () => {
  it("computes power-of-2 octaves vs dump", () => {
    const { octave, octaveRound } = computeOctave(480, 30);
    expect(octave).toBeCloseTo(4, 5);
    expect(octaveRound).toBe(4);
  });

  it("clusters SA above solo A", () => {
    const doc: TierSurveyDocument = createSurveyDocument({
      baseId: "breach_tablet",
      leagueId: "Standard",
      fx: { exaltPerChaos: 50, exaltPerDivine: 700 },
    });
    doc.anchors.dumpEx = 30;
    doc.status = "complete";
    const add = (
      key: string,
      kind: "single" | "pair",
      modIds: string[],
      sellEx: number,
    ) => {
      const { octave, octaveRound } = computeOctave(sellEx, 30);
      doc.observations[key] = {
        key,
        kind,
        label: key,
        modIds,
        sellEx,
        octave,
        octaveRound,
        updatedAt: Date.now(),
      };
    };
    add("single:a", "single", ["breach_pack_size_t1"], 120);
    add(
      "pair:sa",
      "pair",
      ["breach_pack_size_t1", "breach_splinter_qty_t1"],
      4000,
    );
    expect(coarsePattern(["breach_pack_size_t1", "breach_splinter_qty_t1"])).toBe(
      "SA",
    );
    const analysis = analyzeTierSurvey(doc);
    const sa = analysis.byPattern.find((p) => p.pattern === "SA");
    const soloA = analysis.byPattern.find((p) => p.pattern === "solo_A");
    expect(sa?.medianOctave).toBeGreaterThan(soloA?.medianOctave ?? 0);
  });
});
