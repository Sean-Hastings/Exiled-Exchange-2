import { describe, expect, it } from "vitest";
import { createEmptyMarketCache } from "@/web/price-check/tablets/default-market";
import { applyTempleManualSurveyMarket } from "@/web/price-check/tablets/temple-manual-market";
import { estimateTabletSellPrice } from "@/web/price-check/tablets/tablet-sell-estimate";
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
    expect(low.rareTier).toBe("S");
    expect(low.basis).toBe("roll-curve");
    expect(low.sellEx).toBeGreaterThan(500);
    expect(high.sellEx).toBeGreaterThan(low.sellEx);
    expect(high.sellEx).toBeGreaterThan(1500);
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
  });
});
