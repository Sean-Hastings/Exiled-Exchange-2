import { describe, expect, it } from "vitest";
import { createEmptyMarketCache } from "@/web/price-check/tablets/default-market";
import { modQualityTierForBase } from "@/web/price-check/tablets/mod-tiers";
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
    expect(modQualityTierForBase("temple_tablet", "temple_crystal_t1")).toBe(
      "S",
    );
    expect(
      modQualityTierForBase("temple_tablet", "temple_beacon_pack_t1"),
    ).toBe("Junk");
    expect(
      modQualityTierForBase("temple_tablet", "temple_chest_rare_t1"),
    ).toBe("Junk");
  });

  it("prices A/S from crystal E[p] and Trash from dump (~60); blank buy stays NaN", () => {
    const sales = buildTierSaleTable(templeMarket(), "temple_tablet")!;
    expect(Number.isNaN(sales.baseCost)).toBe(true);
    expect(sales.uncorrupted.Trash).toBe(60);
    // Crystal 1p1s land in S (crystal-presence force); A cascades toward dump
    expect(sales.uncorrupted.S).toBeGreaterThan(900);
    expect(sales.uncorrupted.S).toBeLessThan(2100);
    expect(sales.uncorrupted.A).toBeLessThanOrEqual(sales.uncorrupted.S);
    // B mid-band (~80) is junk filler — priced as dump, not 80
    expect(sales.uncorrupted.B).toBe(sales.uncorrupted.Trash);
    expect(sales.uncorrupted.B).toBe(60);
    expect(sales.dumpFloorSource).toBe("manual-survey");
    expect(sales.uncorruptedSource.Trash).toBe("manual-survey");
    expect(sales.uncorruptedSource.S).toBe("manual-survey");
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

  it("stamps priceSource on dump and crystal/mid combo keys", () => {
    const prior = createEmptyMarketCache();
    prior.junkSellByBase = { breach_tablet: 25 };
    prior.priceSource = {
      junkSellByBase: { breach_tablet: "measured" },
    };
    const market = applyTempleManualSurveyMarket(prior);
    expect(market.priceSource?.junkSellByBase?.temple_tablet).toBe(
      "manual-survey",
    );
    expect(market.priceSource?.junkSellByBase?.breach_tablet).toBe("measured");
    expect(
      market.priceSource?.modValueMap?.["map_pack_size_t2+map_rarity_t1"],
    ).toBe("manual-survey");
    expect(
      market.priceSource?.modValueMap?.["junk_gold_t1+junk_extra_strongbox_t1"],
    ).toBe("manual-survey");
    const crystalKey = Object.keys(market.modValueMap).find((k) =>
      k.endsWith("+temple_crystal_t1"),
    );
    expect(crystalKey).toBeTruthy();
    expect(market.priceSource?.modValueMap?.[crystalKey!]).toBe(
      "manual-survey",
    );
  });

  it("does not overwrite finite live Temple sells or their measured stamps", () => {
    const prior = createEmptyMarketCache();
    const crystalKey = "junk_monster_eff_t1+temple_crystal_t1";
    prior.junkSellByBase = { temple_tablet: 42 };
    prior.modValueMap = {
      [crystalKey]: 1600,
      "map_pack_size_t2+map_rarity_t1": 95,
    };
    prior.priceSource = {
      junkSellByBase: { temple_tablet: "measured" },
      modValueMap: {
        [crystalKey]: "measured",
        "map_pack_size_t2+map_rarity_t1": "measured",
      },
    };

    const market = applyTempleManualSurveyMarket(prior);

    expect(market.junkSellByBase?.temple_tablet).toBe(42);
    expect(market.priceSource?.junkSellByBase?.temple_tablet).toBe("measured");
    expect(market.modValueMap[crystalKey]).toBe(1600);
    expect(market.priceSource?.modValueMap?.[crystalKey]).toBe("measured");
    expect(market.modValueMap["map_pack_size_t2+map_rarity_t1"]).toBe(95);
    expect(
      market.priceSource?.modValueMap?.["map_pack_size_t2+map_rarity_t1"],
    ).toBe("measured");
    // Unmeasured survey keys still seed
    expect(
      market.modValueMap["junk_gold_t1+junk_extra_strongbox_t1"],
    ).toBe(60);
    expect(
      market.priceSource?.modValueMap?.[
        "junk_gold_t1+junk_extra_strongbox_t1"
      ],
    ).toBe("manual-survey");
  });
});
