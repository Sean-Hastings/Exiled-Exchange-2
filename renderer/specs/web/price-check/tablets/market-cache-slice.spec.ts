import { describe, expect, it } from "vitest";
import { createEmptyMarketCache } from "@/web/price-check/tablets/default-market";
import { modRollCurveKey } from "@/web/price-check/tablets/mod-roll-price-curve";
import type { ModRollPriceCurve } from "@/web/price-check/tablets/mod-roll-price-curve";
import {
  clearBaseBuySlice,
  clearBaseMarketSlice,
  clearBaseSellSlice,
  cloneMarketCache,
} from "@/web/price-check/tablets/tablet-market-sync";

const BREACH_DUO = "junk_gold_t1+breach_unstable_rare_t1";
const TEMPLE_DUO = "junk_gold_t1+temple_crystal_t1";
const BREACH_SOLO = "__solo__:breach_unstable_rare_t1";
const BREACH_TRIPLE =
  "junk_gold_t1+map_pack_size_t1+breach_unstable_rare_t1";

function fakeCurve(modId: string): ModRollPriceCurve {
  return {
    modId,
    minValue: 1,
    maxValue: 10,
    A: 1,
    k: 0,
    anchors: [
      { roll: 1, sellEx: 10 },
      { roll: 10, sellEx: 20 },
    ],
    expectedSellEx: 15,
  };
}

function seededMarket() {
  const market = createEmptyMarketCache();
  market.basePrices.breach_tablet = 40;
  market.basePrices.temple_tablet = 55;
  market.junkSellByBase = { breach_tablet: 12, temple_tablet: 60 };
  market.junkBuyByBase = { breach_tablet: 18, temple_tablet: 70 };
  market.magicSellByBase = { breach_tablet: 22, temple_tablet: 75 };
  market.magicBuyByBase = { breach_tablet: 28, temple_tablet: 80 };
  market.modValueMap = {
    [BREACH_DUO]: 200,
    [TEMPLE_DUO]: 900,
    [BREACH_SOLO]: 180,
    [BREACH_TRIPLE]: 250,
  };
  market.measuredAffixSamples = [
    { baseId: "breach_tablet", modIds: ["breach_unstable_rare_t1"], sellEx: 180 },
    { baseId: "temple_tablet", modIds: ["temple_crystal_t1"], sellEx: 900 },
  ];
  market.modRollCurves = {
    [modRollCurveKey("breach_tablet", "breach_unstable_rare_t1")]: fakeCurve(
      "breach_unstable_rare_t1",
    ),
    [modRollCurveKey("temple_tablet", "temple_crystal_t1")]: fakeCurve(
      "temple_crystal_t1",
    ),
  };
  market.priceSource = {
    junkSellByBase: {
      breach_tablet: "measured",
      temple_tablet: "measured",
    },
    junkBuyByBase: {
      breach_tablet: "measured",
      temple_tablet: "measured",
    },
    magicSellByBase: {
      breach_tablet: "measured",
      temple_tablet: "measured",
    },
    magicBuyByBase: {
      breach_tablet: "measured",
      temple_tablet: "measured",
    },
    modValueMap: {
      [BREACH_DUO]: "measured",
      [TEMPLE_DUO]: "measured",
      [BREACH_SOLO]: "measured",
      [BREACH_TRIPLE]: "measured",
    },
  };
  return market;
}

describe("cloneMarketCache", () => {
  it("copies maps/arrays so mutations do not leak to the source", () => {
    const src = seededMarket();
    const clone = cloneMarketCache(src);

    clone.basePrices.breach_tablet = 99;
    clone.modValueMap[BREACH_DUO] = 1;
    clone.junkSellByBase!.breach_tablet = 1;
    clone.junkBuyByBase!.breach_tablet = 1;
    clone.magicBuyByBase!.breach_tablet = 1;
    clone.measuredAffixSamples![0]!.sellEx = 1;
    clone.measuredAffixSamples![0]!.modIds.push("extra");
    clone.modRollCurves![
      modRollCurveKey("breach_tablet", "breach_unstable_rare_t1")
    ]!.A = 99;
    clone.priceSource!.modValueMap![BREACH_DUO] = "manual-survey";

    expect(src.basePrices.breach_tablet).toBe(40);
    expect(src.modValueMap[BREACH_DUO]).toBe(200);
    expect(src.junkSellByBase!.breach_tablet).toBe(12);
    expect(src.junkBuyByBase!.breach_tablet).toBe(18);
    expect(src.magicBuyByBase!.breach_tablet).toBe(28);
    expect(src.measuredAffixSamples![0]!.sellEx).toBe(180);
    expect(src.measuredAffixSamples![0]!.modIds).toEqual([
      "breach_unstable_rare_t1",
    ]);
    expect(
      src.modRollCurves![
        modRollCurveKey("breach_tablet", "breach_unstable_rare_t1")
      ]!.A,
    ).toBe(1);
    expect(src.priceSource!.modValueMap![BREACH_DUO]).toBe("measured");
  });
});

describe("clearBaseBuySlice / clearBaseSellSlice", () => {
  it("buy wipe blanks that base only and leaves sells", () => {
    const market = seededMarket();
    clearBaseBuySlice(market, "breach_tablet");

    expect(Number.isNaN(market.basePrices.breach_tablet)).toBe(true);
    expect(market.junkBuyByBase!.breach_tablet).toBeUndefined();
    expect(market.magicBuyByBase!.breach_tablet).toBeUndefined();
    expect(market.basePrices.temple_tablet).toBe(55);
    expect(market.junkSellByBase!.breach_tablet).toBe(12);
    expect(market.junkBuyByBase!.temple_tablet).toBe(70);
    expect(market.modValueMap[BREACH_DUO]).toBe(200);
    expect(market.modValueMap[BREACH_SOLO]).toBe(180);
    expect(market.modValueMap[BREACH_TRIPLE]).toBe(250);
  });

  it("sell wipe drops junk, p+s, solo, 3+ keys, samples, and curves for that base", () => {
    const market = seededMarket();
    clearBaseSellSlice(market, "breach_tablet");

    expect(market.basePrices.breach_tablet).toBe(40);
    expect(market.junkSellByBase!.breach_tablet).toBeUndefined();
    expect(market.magicSellByBase!.breach_tablet).toBeUndefined();
    expect(market.junkBuyByBase!.breach_tablet).toBe(18);
    expect(market.magicBuyByBase!.breach_tablet).toBe(28);
    expect(market.junkSellByBase!.temple_tablet).toBe(60);
    expect(market.modValueMap[BREACH_DUO]).toBeUndefined();
    expect(market.modValueMap[BREACH_SOLO]).toBeUndefined();
    expect(market.modValueMap[BREACH_TRIPLE]).toBeUndefined();
    expect(market.modValueMap[TEMPLE_DUO]).toBe(900);
    expect(market.priceSource!.junkSellByBase!.breach_tablet).toBeUndefined();
    expect(market.priceSource!.modValueMap![TEMPLE_DUO]).toBe("measured");
    expect(market.measuredAffixSamples).toEqual([
      { baseId: "temple_tablet", modIds: ["temple_crystal_t1"], sellEx: 900 },
    ]);
    expect(
      market.modRollCurves![
        modRollCurveKey("breach_tablet", "breach_unstable_rare_t1")
      ],
    ).toBeUndefined();
    expect(
      market.modRollCurves![
        modRollCurveKey("temple_tablet", "temple_crystal_t1")
      ]!.expectedSellEx,
    ).toBe(15);
  });

  it("combined helper wipes buy and sells", () => {
    const market = seededMarket();
    clearBaseMarketSlice(market, "breach_tablet");
    expect(Number.isNaN(market.basePrices.breach_tablet)).toBe(true);
    expect(market.modValueMap[BREACH_DUO]).toBeUndefined();
    expect(market.basePrices.temple_tablet).toBe(55);
    expect(market.modValueMap[TEMPLE_DUO]).toBe(900);
  });
});
