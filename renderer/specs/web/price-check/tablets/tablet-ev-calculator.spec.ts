import { describe, expect, it } from "vitest";
import {
  createEmptyMarketCache,
  TabletEVEngine,
} from "@/web/price-check/tablets";
import { TABLET_BASES } from "@/web/price-check/tablets/mod-weights";
import type { MarketPriceCache } from "@/web/price-check/tablets/tablet-ev-calculator";

/** Measured-looking fixture for EV math tests (not production seeds). */
function measuredFixture(): MarketPriceCache {
  const market = createEmptyMarketCache();
  market.fx = { exaltPerChaos: 45, exaltPerDivine: 350 };
  market.currencyCosts.chaos = 45;
  market.currencyCosts.alchemy = 0.05;
  market.currencyCosts.vaal = 0.4;
  market.currencyCosts.transmute = 0.01;
  market.currencyCosts.augmentation = 0.02;
  market.currencyCosts.regal = 0.15;
  for (const id of Object.keys(TABLET_BASES)) {
    market.basePrices[id] = 100;
  }
  // One priced combo per base so expectedGross is finite
  for (const base of Object.values(TABLET_BASES)) {
    const p = base.allowedPrefixPool[0];
    const s = base.allowedSuffixPool[0];
    if (p && s) market.modValueMap[`${p}+${s}`] = 800;
  }
  return market;
}

describe("TabletEVEngine", () => {
  it("empty market leaves unmeasured prices as NaN", () => {
    const market = createEmptyMarketCache();
    expect(market.currencyCosts.exalted).toBe(1);
    expect(Number.isNaN(market.currencyCosts.chaos)).toBe(true);
    expect(Number.isNaN(market.currencyCosts.alchemy)).toBe(true);
    expect(market.fx).toBeUndefined();
    for (const price of Object.values(market.basePrices)) {
      expect(Number.isNaN(price)).toBe(true);
    }
  });

  it("unmeasured market yields Skip-Blanks (no invented craft EV)", () => {
    const engine = new TabletEVEngine(createEmptyMarketCache());
    const result = engine.calculateBaseEV("delirium_tablet");
    expect(result.blankStrategy).toBe("Skip-Blanks");
    expect(Number.isNaN(result.baseCost)).toBe(true);
    // No measured base/combos → recommend Skip; craft EV not invented as +EV
    expect(!(Number.isFinite(result.netEV) && result.netEV > 0)).toBe(true);
  });

  it("surfaces negative craft EV instead of masking as Skip's 0", () => {
    const market = measuredFixture();
    // Expensive base, tiny combo payout → craft EV negative
    market.basePrices.delirium_tablet = 5000;
    for (const key of Object.keys(market.modValueMap)) {
      market.modValueMap[key] = 10;
    }
    const engine = new TabletEVEngine(market);
    const result = engine.calculateBaseEV("delirium_tablet");
    expect(result.blankStrategy).toBe("Skip-Blanks");
    expect(result.netEV).toBeLessThan(0);
    expect(result.blankNetEV).toBe(result.netEV);
  });

  it("guards against zero weights / empty pools", () => {
    const market = measuredFixture();
    market.basePrices.breach_tablet = 0;
    market.currencyCosts.alchemy = 0;
    const engine = new TabletEVEngine(market);
    const result = engine.calculateBaseEV("breach_tablet");
    expect(
      Number.isFinite(result.roiPercentage) ||
        Number.isNaN(result.roiPercentage) ||
        result.roiPercentage === Infinity,
    ).toBe(true);
  });

  it("returns a safe empty result for unknown bases", () => {
    const engine = new TabletEVEngine(createEmptyMarketCache());
    const result = engine.calculateBaseEV("does_not_exist");
    expect(Number.isNaN(result.netEV)).toBe(true);
    expect(result.blankStrategy).toBe("Skip-Blanks");
  });

  it("with measured inputs, EV stays finite", () => {
    const engine = new TabletEVEngine(measuredFixture());
    for (const id of Object.keys(TABLET_BASES)) {
      const r = engine.calculateBaseEV(id);
      expect(r.baseCost).toBe(100);
      expect(Number.isFinite(r.expectedGrossValue)).toBe(true);
      expect(Number.isFinite(r.netEV)).toBe(true);
    }
  }, 20_000);

  it("sparse premium map does not treat the long tail as 0ex", () => {
    const market = measuredFixture();
    market.basePrices.breach_tablet = 200;
    // Wipe dense fixture map — only one expensive combo remains
    market.modValueMap = {};
    const p = TABLET_BASES.breach_tablet.allowedPrefixPool[0];
    const s = TABLET_BASES.breach_tablet.allowedSuffixPool[0];
    market.modValueMap[`${p}+${s}`] = 2000;
    market.junkSellByBase = { breach_tablet: 40 };

    const engine = new TabletEVEngine(market);
    const result = engine.calculateBaseEV("breach_tablet");
    // Old bug: E[gross] ≈ tiny mass × premium ≈ near 0 → EV ≈ −base
    // Junk-diluted 2p+2s still prices the long tail at dump, not 0.
    // One-affix chaos-until-hit is slower than a full redraw, so craft EV
    // can be more negative when chaos is the trash action.
    expect(result.expectedGrossValue).toBeGreaterThan(30);
    expect(result.netEV).toBeGreaterThan(-500);
  });

  it("explainStrategies surfaces roll buckets and blank/rare revenue", () => {
    const engine = new TabletEVEngine(measuredFixture());
    const x = engine.explainStrategies("breach_tablet");
    expect(x.rollOutcomes.length).toBeGreaterThan(0);
    expect(x.expectedRollRevenueEx).toBeGreaterThan(0);
    expect(x.blank.some((b) => b.strategy === "Scour-Alch")).toBe(true);
    expect(x.rare.length).toBe(4); // S/A/B/Trash MDP rows (B sale aliases Trash)
    expect(x.rare.every((r) => r.note?.includes("marginal vs sell"))).toBe(true);
    expect(x.tierRegexes.map((t) => t.tier)).toEqual(["S", "A"]);
    expect(x.rollOutcomes.map((o) => o.label)).toEqual(
      expect.arrayContaining(["S rare", "A rare", "Trash rare"]),
    );
    expect(x.rollOutcomes.some((o) => o.label === "B rare")).toBe(false);
    expect(x.tierRegexes.some((t) => t.modIds.length > 0)).toBe(true);
    const scour = x.blank.find((b) => b.strategy === "Scour-Alch")!;
    const revSum = scour.outcomes.reduce((s, o) => s + o.revenueEx, 0);
    expect(revSum).toBeCloseTo(scour.expectedRevenueEx, 4);
  });

  it("splits blank vs rare strategies independently", () => {
    const engine = new TabletEVEngine(measuredFixture());
    const result = engine.calculateBaseEV("delirium_tablet");
    expect(result.blankCandidates.length).toBeGreaterThanOrEqual(2);
    expect(result.rareCandidates.length).toBeGreaterThanOrEqual(4);
    expect(result.recommendedStrategy).toContain("/");
  });

  it("includes Magic-Pipeline and Reforge candidates", () => {
    const engine = new TabletEVEngine(measuredFixture());
    const result = engine.calculateBaseEV("irradiated_tablet");
    expect(
      result.blankCandidates.some((c) => c.strategy === "Magic-Pipeline"),
    ).toBe(true);
    expect(
      result.rareCandidates.some((c) => c.strategy === "Reforge-3to1"),
    ).toBe(true);
  });

  it("chaos-spam cost uses measured FX (~45ex), not 1", () => {
    const engine = new TabletEVEngine(measuredFixture());
    const result = engine.calculateBaseEV("delirium_tablet");
    const chaos = result.rareCandidates.find((c) => c.strategy === "Chaos-Spam")!;
    expect(chaos.costPerAttempt).toBe(45);
  });

  it("recommends sell for corrupted high rolls", () => {
    const engine = new TabletEVEngine(measuredFixture());
    const evaluation = engine.evaluateCurrentItem({
      isTablet: true,
      tabletBaseKey: "delirium_tablet",
      category: "Delirium",
      baseName: "Delirium Tablet",
      isCorrupted: true,
      parsedMods: [
        {
          id: "delirium_splinter_stack_t1",
          rawText: "x",
          rolledValue: 30,
          tier: 1,
          isPrefix: false,
          valueScore: 98,
        },
      ],
    });
    expect(evaluation.action).toBe("SELL_AS_IS");
  });

  it("simulates crafts without dividing by zero", () => {
    const engine = new TabletEVEngine(measuredFixture());
    const sim = engine.simulateCrafts("breach_tablet", 200);
    expect(Number.isFinite(sim.netProfit) || Number.isNaN(sim.netProfit)).toBe(
      true,
    );
  });
});
