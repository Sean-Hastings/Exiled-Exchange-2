import { describe, expect, it } from "vitest";
import { createEmptyMarketCache } from "@/web/price-check/tablets/default-market";
import { modQualityTier } from "@/web/price-check/tablets/mod-tiers";
import {
  buildTierSaleTable,
  recommendPolicy,
} from "@/web/price-check/tablets/tablet-mdp";
import { applyTempleManualSurveyMarket } from "@/web/price-check/tablets/temple-manual-market";
import { TabletEVEngine } from "@/web/price-check/tablets/tablet-ev-calculator";

function templeMarket() {
  const market = applyTempleManualSurveyMarket(createEmptyMarketCache());
  market.fx = { exaltPerChaos: 45, exaltPerDivine: 350 };
  market.currencyCosts.chaos = 45;
  market.currencyCosts.alchemy = 0.05;
  market.currencyCosts.vaal = 0.4;
  market.currencyCosts.transmute = 0.01;
  market.currencyCosts.augmentation = 0.02;
  market.currencyCosts.regal = 0.15;
  return market;
}

describe("temple manual survey market", () => {
  it("tags crystal as S and fillers as Junk", () => {
    expect(modQualityTier("temple_crystal_t1")).toBe("S");
    expect(modQualityTier("temple_beacon_pack_t1")).toBe("Junk");
    expect(modQualityTier("temple_chest_rare_t1")).toBe("Junk");
  });

  it("prices A/S from crystal E[p] and Trash from dump (~60); blank buy stays NaN", () => {
    const sales = buildTierSaleTable(templeMarket(), "temple_tablet")!;
    expect(Number.isNaN(sales.baseCost)).toBe(true);
    expect(sales.uncorrupted.Trash).toBe(60);
    // Crystal 1p1s land in A (solo S); S cascades from A — curve E[p] not flat 775
    expect(sales.uncorrupted.A).toBeGreaterThan(900);
    expect(sales.uncorrupted.A).toBeLessThan(2100);
    expect(sales.uncorrupted.S).toBe(sales.uncorrupted.A);
    expect(sales.uncorrupted.B).toBeGreaterThanOrEqual(60);
    expect(sales.uncorrupted.B).toBeLessThanOrEqual(80);
  });

  it("without measured blank buy, Temple craft EV is NaN and Skip wins", () => {
    const market = templeMarket();
    const hit = recommendPolicy(market, "temple_tablet");
    expect(hit).toBeTruthy();
    expect(Number.isNaN(hit!.sales.baseCost)).toBe(true);
    // Scour whiteEV is NaN without base → recommend Skip (0)
    expect(hit!.policy.blank).toBe("Skip-Blanks");
    expect(hit!.whiteEV).toBe(0);
    const row = new TabletEVEngine(market).calculateBaseEV("temple_tablet");
    expect(Number.isNaN(row.baseCost)).toBe(true);
  });
});
