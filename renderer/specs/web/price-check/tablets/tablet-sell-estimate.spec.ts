import { describe, expect, it } from "vitest";
import { createEmptyMarketCache } from "@/web/price-check/tablets/default-market";
import { applyTempleManualSurveyMarket } from "@/web/price-check/tablets/temple-manual-market";
import { estimateTabletSellPrice } from "@/web/price-check/tablets/tablet-sell-estimate";
import {
  buildModRollPriceCurve,
  modRollCurveKey,
} from "@/web/price-check/tablets/mod-roll-price-curve";
import type { ParsedTabletItem } from "@/web/price-check/tablets/tablet-types";

function templeMarket() {
  const market = applyTempleManualSurveyMarket(createEmptyMarketCache());
  market.fx = { exaltPerChaos: 45, exaltPerDivine: 350 };
  market.currencyCosts.chaos = 45;
  market.currencyCosts.alchemy = 0.05;
  return market;
}

function crystalTablet(roll: number): ParsedTabletItem {
  return {
    isTablet: true,
    tabletBaseKey: "temple_tablet",
    category: "Temple",
    baseName: "Temple Tablet",
    isCorrupted: false,
    parsedMods: [
      {
        id: "junk_gold_t1",
        rawText: "gold",
        rolledValue: 30,
        isPrefix: true,
        valueScore: 20,
      },
      {
        id: "temple_crystal_t1",
        rawText: "crystal",
        rolledValue: roll,
        isPrefix: false,
        valueScore: 95,
      },
    ],
  };
}

describe("estimateTabletSellPrice", () => {
  it("prices high-tier crystal by roll curve", () => {
    const low = estimateTabletSellPrice(crystalTablet(5), templeMarket());
    const high = estimateTabletSellPrice(crystalTablet(10), templeMarket());
    expect(low.rareTier).toBe("SS");
    expect(low.basis).toBe("roll-curve");
    expect(low.sellEx).toBeGreaterThan(500);
    expect(high.sellEx).toBeGreaterThan(low.sellEx);
    expect(high.sellEx).toBeGreaterThan(1500);
    expect(low.priceSource).toBe("manual-survey");
    expect(high.priceSource).toBe("manual-survey");
  });

  it("prefers live measured roll curve over survey", () => {
    const market = templeMarket();
    const live = buildModRollPriceCurve({
      modId: "temple_crystal_t1",
      minValue: 5,
      maxValue: 10,
      anchors: [
        { roll: 5, sellEx: 100 },
        { roll: 10, sellEx: 400 },
      ],
    })!;
    market.modRollCurves = {
      [modRollCurveKey("temple_tablet", "temple_crystal_t1")]: live,
    };
    const est = estimateTabletSellPrice(crystalTablet(5), market);
    expect(est.basis).toBe("roll-curve");
    expect(est.priceSource).toBe("measured");
    expect(est.sellEx).toBeCloseTo(100, 4);
  });

  it("uses Trash tier ask when no premium mods", () => {
    const junk: ParsedTabletItem = {
      isTablet: true,
      tabletBaseKey: "temple_tablet",
      category: "Temple",
      baseName: "Temple Tablet",
      isCorrupted: false,
      parsedMods: [
        {
          id: "junk_gold_t1",
          rawText: "gold",
          rolledValue: 30,
          isPrefix: true,
          valueScore: 20,
        },
        {
          id: "junk_extra_shrine_t1",
          rawText: "shrine",
          rolledValue: 1,
          isPrefix: false,
          valueScore: 15,
        },
      ],
    };
    const est = estimateTabletSellPrice(junk, templeMarket());
    expect(est.rareTier).toBe("Trash");
    expect(est.sellEx).toBe(60);
    expect(est.basis).toBe("tier-ask");
    expect(est.priceSource).toBe("manual-survey");
  });

  it("Trash hover uses dump floor, not leaked survey combo keys", () => {
    const stamped: ParsedTabletItem = {
      isTablet: true,
      tabletBaseKey: "temple_tablet",
      category: "Temple",
      baseName: "Temple Tablet",
      isCorrupted: false,
      parsedMods: [
        {
          id: "junk_gold_t1",
          rawText: "gold",
          rolledValue: 30,
          isPrefix: true,
          valueScore: 20,
        },
        {
          id: "junk_extra_strongbox_t1",
          rawText: "box",
          rolledValue: 1,
          isPrefix: false,
          valueScore: 15,
        },
      ],
    };
    const surveyOnly = estimateTabletSellPrice(stamped, templeMarket());
    expect(surveyOnly.rareTier).toBe("Trash");
    expect(surveyOnly.basis).toBe("tier-ask");
    expect(surveyOnly.sellEx).toBe(60);
    expect(surveyOnly.priceSource).toBe("manual-survey");

    const live = templeMarket();
    live.junkSellByBase = { ...live.junkSellByBase, temple_tablet: 42 };
    live.priceSource = {
      ...live.priceSource,
      junkSellByBase: {
        ...live.priceSource?.junkSellByBase,
        temple_tablet: "measured",
      },
      // Leftover persisted survey dump pairs must not win over live dump
      modValueMap: {
        ...live.priceSource?.modValueMap,
        "junk_gold_t1+junk_extra_strongbox_t1": "manual-survey",
      },
    };
    live.modValueMap = {
      ...live.modValueMap,
      "junk_gold_t1+junk_extra_strongbox_t1": 60,
    };
    const est = estimateTabletSellPrice(stamped, live);
    expect(est.basis).toBe("tier-ask");
    expect(est.sellEx).toBe(42);
    expect(est.priceSource).toBe("measured");
  });
});
