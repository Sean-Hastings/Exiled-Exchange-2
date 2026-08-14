import { describe, expect, it } from "vitest";
import {
  buildModRollPriceCurve,
  expectedSellFromCurve,
  fitExponentialRollCurve,
  priceAtRoll,
  rollAtPercentile65,
  rollSampleProngs,
} from "@/web/price-check/tablets/mod-roll-price-curve";
import {
  TEMPLE_CRYSTAL_ROLL_ANCHORS,
  templeCrystalRollCurve,
} from "@/web/price-check/tablets/temple-manual-market";

describe("mod-roll-price-curve", () => {
  it("rollSampleProngs for crystal [5,10] is lo/mid/hi", () => {
    expect(rollSampleProngs(5, 10)).toEqual([5, 7, 10]);
  });

  it("rollAtPercentile65 uses 1-based ceil(0.65·n)", () => {
    expect(rollAtPercentile65(5, 5)).toBe(5);
    expect(rollAtPercentile65(1, 1)).toBe(1); // n=1 → 1
    expect(rollAtPercentile65(1, 2)).toBe(2); // n=2 → 2
    expect(rollAtPercentile65(1, 3)).toBe(2); // n=3 → 2
    expect(rollAtPercentile65(1, 4)).toBe(3); // n=4 → 3
    expect(rollAtPercentile65(1, 5)).toBe(4); // n=5 → 4
    expect(rollAtPercentile65(1, 6)).toBe(4); // n=6 → 4
    expect(rollAtPercentile65(5, 10)).toBe(8); // crystal
  });

  it("fits exp from measured anchors without inventing a mid", () => {
    const fit = fitExponentialRollCurve([
      { roll: 5, sellEx: 100 },
      { roll: 10, sellEx: 400 },
    ]);
    expect(fit).not.toBeNull();
    expect(priceAtRoll(fit!, 5)).toBeCloseTo(100, 5);
    expect(priceAtRoll(fit!, 10)).toBeCloseTo(400, 5);
    // Midpoint roll is interpolated by the curve — never supplied as a fake sell
    const mid = priceAtRoll(fit!, 7.5);
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(400);
  });

  it("E[p] is discrete uniform average over integer rolls", () => {
    const curve = buildModRollPriceCurve({
      modId: "test",
      minValue: 5,
      maxValue: 7,
      anchors: [
        { roll: 5, sellEx: Math.E ** 5 },
        { roll: 7, sellEx: Math.E ** 7 },
      ],
    });
    expect(curve).not.toBeNull();
    // A≈1, k≈1 → p(v)=e^v; E = (e^5+e^6+e^7)/3
    const expected =
      (Math.exp(5) + Math.exp(6) + Math.exp(7)) / 3;
    expect(curve!.expectedSellEx).toBeCloseTo(expected, 4);
    expect(expectedSellFromCurve(curve!)).toBeCloseTo(expected, 4);
  });

  it("rejects a single invented-looking sample (needs ≥2 anchors)", () => {
    expect(
      buildModRollPriceCurve({
        modId: "x",
        minValue: 5,
        maxValue: 10,
        anchors: [{ roll: 7, sellEx: 775 }],
      }),
    ).toBeNull();
  });

  it("Temple crystal EV uses measured roll asks (not flat 775)", () => {
    const curve = templeCrystalRollCurve();
    expect(curve).not.toBeNull();
    expect(TEMPLE_CRYSTAL_ROLL_ANCHORS.map((a) => a.roll)).toEqual([
      5, 7, 9, 10,
    ]);
    // Jackpot rolls pull E[p] well above the low-roll ask
    expect(curve!.expectedSellEx).toBeGreaterThan(900);
    expect(curve!.expectedSellEx).toBeLessThan(2100);
    expect(priceAtRoll(curve!, 5)).toBeGreaterThan(500);
    expect(priceAtRoll(curve!, 10)).toBeGreaterThan(1500);
  });
});
