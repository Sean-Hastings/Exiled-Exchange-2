import { describe, expect, it } from "vitest";
import { createEmptyMarketCache } from "@/web/price-check/tablets/default-market";
import { TABLET_BASES } from "@/web/price-check/tablets/mod-weights";
import type { MarketPriceCache } from "@/web/price-check/tablets/tablet-ev-calculator";
import {
  buildTierSaleTable,
  defaultPolicy,
  recommendPolicy,
  solveOptimalRarePolicy,
  solvePolicy,
  solveRareValues,
} from "@/web/price-check/tablets/tablet-mdp";

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
  for (const base of Object.values(TABLET_BASES)) {
    const p = base.allowedPrefixPool[0];
    const s = base.allowedSuffixPool[0];
    if (p && s) market.modValueMap[`${p}+${s}`] = 800;
  }
  market.junkSellByBase = { breach_tablet: 25 };
  return market;
}

describe("tablet-mdp", () => {
  it("builds alch tier distribution summing to ~1", () => {
    const sales = buildTierSaleTable(measuredFixture(), "breach_tablet");
    expect(sales).toBeTruthy();
    const sum = Object.values(sales!.alchDist).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it("chaos-until-hit has closed-form finite V(Trash) when P(exit)>0", () => {
    const market = measuredFixture();
    market.currencyCosts.chaos = 1; // cheap chaos
    const sales = buildTierSaleTable(market, "breach_tablet")!;
    const policy = defaultPolicy("Scour-Alch"); // Trash→Chaos
    const { rareV, note } = solveRareValues(sales, policy);
    expect(note).toBeUndefined();
    expect(Number.isFinite(rareV.Trash)).toBe(true);
    // With junk-heavy pools, chaos-until-hit may still lose to dump — only require finite solve
  });

  it("chaos with P(stay Trash)=1 is singular → −∞", () => {
    const market = measuredFixture();
    const sales = buildTierSaleTable(market, "breach_tablet")!;
    sales.chaosFrom = {
      S: { S: 1, A: 0, B: 0, Trash: 0 },
      A: { S: 0, A: 1, B: 0, Trash: 0 },
      B: { S: 0, A: 0, B: 1, Trash: 0 },
      Trash: { S: 0, A: 0, B: 0, Trash: 1 },
    };
    const { rareV, note } = solveRareValues(sales, defaultPolicy());
    expect(note).toMatch(/Singular|−∞|Inf/i);
    expect(rareV.Trash).toBe(Number.NEGATIVE_INFINITY);
  });

  it("one-affix chaos from Trash differs from a full alch redraw", () => {
    const sales = buildTierSaleTable(measuredFixture(), "temple_tablet")!;
    const row = sales.chaosFrom.Trash;
    const rowSum = Object.values(row).reduce((a, b) => a + b, 0);
    expect(rowSum).toBeCloseTo(1, 5);
    // Must not treat chaos as an independent full rare redraw
    const redrawL1 =
      Math.abs(row.S - sales.alchDist.S) +
      Math.abs(row.A - sales.alchDist.A) +
      Math.abs(row.B - sales.alchDist.B) +
      Math.abs(row.Trash - sales.alchDist.Trash);
    expect(redrawL1).toBeGreaterThan(0.05);
    // One-slot replace: landing a single S mod is A-tier (solo S), not jackpot S
    expect(row.S).toBeLessThanOrEqual(sales.alchDist.S + 1e-12);
  });

  it("optimal rare policy exposes marginal vs list (dump/sell = 0)", () => {
    const market = measuredFixture();
    market.currencyCosts.chaos = 45;
    market.junkSellByBase = { temple_tablet: 60 };
    const sales = buildTierSaleTable(market, "temple_tablet")!;
    const opt = solveOptimalRarePolicy(sales);
    expect(opt.actionMarginals.Trash.List).toBeCloseTo(0, 5);
    // List is never worse than itself
    for (const t of ["S", "A", "B", "Trash"] as const) {
      expect(opt.actionMarginals[t].List).toBeCloseTo(0, 5);
    }
    // Reroll-worthy iff best action ≠ List
    for (const t of opt.rerollWorthy) {
      expect(opt.rare[t]).not.toBe("List");
      expect(opt.marginalVsList[t]).toBeGreaterThan(0);
    }
  });

  it("recommendPolicy uses optimal per-tier rare actions", () => {
    const hit = recommendPolicy(measuredFixture(), "temple_tablet");
    expect(hit).toBeTruthy();
    expect(hit!.marginalVsList).toBeTruthy();
    expect(hit!.actionMarginals.Trash.List).toBeCloseTo(0, 5);
    expect(Number.isFinite(hit!.whiteEV)).toBe(true);
  });

  it("alch white EV = E[V(rare)] − base − alch", () => {
    const market = measuredFixture();
    const policy = defaultPolicy("Scour-Alch");
    const hit = solvePolicy(market, "breach_tablet", policy)!;
    const cont =
      hit.sales.alchDist.S * hit.rareV.S +
      hit.sales.alchDist.A * hit.rareV.A +
      hit.sales.alchDist.B * hit.rareV.B +
      hit.sales.alchDist.Trash * hit.rareV.Trash;
    expect(hit.whiteEV).toBeCloseTo(
      cont - hit.sales.baseCost - hit.sales.alchOrbCost,
      5,
    );
  });

  it("measured tiers keep low-end sale; no global dump blend", () => {
    const market = measuredFixture();
    market.junkSellByBase = { breach_tablet: 40 };
    market.modValueMap = {};
    const base = TABLET_BASES.breach_tablet;
    const sMod = base.allowedSuffixPool.find((id) =>
      id.includes("splinter_qty_t1"),
    );
    const aPref = base.allowedPrefixPool.find((id) =>
      id.includes("pack_size_t1"),
    );
    if (aPref && sMod) market.modValueMap[`${aPref}+${sMod}`] = 2000; // cross SA → S
    // Solo S → A bucket
    const junkP = "map_quantity_t2";
    if (sMod) market.modValueMap[`${junkP}+${sMod}`] = 9000;

    const sales = buildTierSaleTable(market, "breach_tablet")!;
    expect(sales.measuredFrac).toBeGreaterThan(0);
    expect(sales.measuredFrac).toBeLessThan(1);
    // S measured at 2000, A measured at 9000 → monotone pulls A down to S
    expect(sales.uncorrupted.S).toBe(2000);
    expect(sales.uncorrupted.A).toBe(2000);
    expect(sales.uncorrupted.S).toBeGreaterThanOrEqual(sales.uncorrupted.A);
    expect(sales.uncorrupted.Trash).toBeLessThanOrEqual(sales.uncorrupted.B);
    expect(sales.uncorrupted.B).toBeLessThanOrEqual(sales.uncorrupted.A);
  });

  it("tier hit prices use low-end (min) of measured comps, not mean", () => {
    const market = measuredFixture();
    market.junkSellByBase = { breach_tablet: 40 };
    market.modValueMap = {};
    // S-bucket via shared A-prefix × Domain S-suffix (Breach pack/potency are suffixes)
    market.modValueMap[`junk_monster_eff_t1+breach_splinter_qty_t1`] = 15000;
    market.modValueMap[`junk_item_rarity_t1+breach_splinter_qty_t1`] = 12000;
    market.modValueMap[`junk_gold_t1+breach_splinter_qty_t1`] = 2500; // solo S → A

    const sales = buildTierSaleTable(market, "breach_tablet")!;
    // S keys (cross SA): 15000, 12000 → min 12000
    expect(sales.uncorrupted.S).toBe(12000);
    // A key (solo S): 2500
    expect(sales.uncorrupted.A).toBe(2500);
  });

  it("unmeasured better tier inherits worse measured (cascade), not dump crush", () => {
    const market = measuredFixture();
    market.junkSellByBase = { breach_tablet: 40 };
    market.modValueMap = {};
    // Only A-bucket measured (solo S)
    market.modValueMap[`junk_gold_t1+breach_splinter_qty_t1`] = 5000;
    const sales = buildTierSaleTable(market, "breach_tablet")!;
    expect(sales.uncorrupted.A).toBe(5000);
    expect(sales.uncorrupted.S).toBe(5000); // inherit A, not dump
    expect(sales.uncorrupted.Trash).toBe(40);
  });

  it("junk-heavy 2p+2s pool makes Trash the modal alch outcome", () => {
    const sales = buildTierSaleTable(measuredFixture(), "breach_tablet")!;
    // Shared multipliers (eff/rarity) are A after post-0.5 tier audit, so
    // cross-A boosts S share vs the old filler-only world — Trash must still
    // beat S and A individually.
    expect(sales.alchDist.Trash).toBeGreaterThan(sales.alchDist.S);
    expect(sales.alchDist.Trash).toBeGreaterThan(sales.alchDist.A);
    expect(sales.alchDist.Trash).toBeGreaterThan(0.2);
  });

  it("no dump×N placeholders — empty measured tier falls back to dump", () => {
    const market = measuredFixture();
    market.modValueMap = {}; // nothing measured
    market.junkSellByBase = { breach_tablet: 33 };
    const sales = buildTierSaleTable(market, "breach_tablet")!;
    expect(sales.measuredFrac).toBe(0);
    expect(sales.uncorrupted.S).toBe(33);
    expect(sales.uncorrupted.A).toBe(33);
    expect(sales.uncorrupted.B).toBe(33);
  });
});
