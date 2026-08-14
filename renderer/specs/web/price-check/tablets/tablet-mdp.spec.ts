import { describe, expect, it } from "vitest";
import { createEmptyMarketCache } from "@/web/price-check/tablets/default-market";
import { TABLET_BASES } from "@/web/price-check/tablets/mod-weights";
import type { MarketPriceCache } from "@/web/price-check/tablets/tablet-ev-calculator";
import {
  buildChaosOneAffixTransitions,
  buildTierSaleTable,
  clearChaosTransitionCache,
  defaultPolicy,
  magicOnePOneSBranchProbs,
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
    // Breach exclusives are suffix-only; 1p+1s with S-suffix is MDP A (solo S).
    // Measure A at two prices — monotone / low-end uses min; S cascades from A.
    market.modValueMap[`junk_gold_t1+breach_unstable_rare_t1`] = 2000;
    market.modValueMap[`junk_xp_t1+breach_unstable_rare_t1`] = 9000;

    const sales = buildTierSaleTable(market, "breach_tablet")!;
    expect(sales.measuredFrac).toBeGreaterThan(0);
    expect(sales.measuredFrac).toBeLessThan(1);
    // A measured min 2000; S unmeasured → cascade to A
    expect(sales.uncorrupted.A).toBe(2000);
    expect(sales.uncorrupted.S).toBe(2000);
    expect(sales.uncorrupted.S).toBeGreaterThanOrEqual(sales.uncorrupted.A);
    expect(sales.uncorrupted.Trash).toBeLessThanOrEqual(sales.uncorrupted.B);
    expect(sales.uncorrupted.B).toBeLessThanOrEqual(sales.uncorrupted.A);
  });

  it("tier hit prices use low-end (min) of measured comps, not mean", () => {
    const market = measuredFixture();
    market.junkSellByBase = { breach_tablet: 40 };
    market.modValueMap = {};
    // Solo S (unstable) → A bucket; Domain splinters are Junk (not S/A)
    market.modValueMap[`junk_monster_eff_t1+breach_unstable_rare_t1`] = 15000;
    market.modValueMap[`junk_item_rarity_t1+breach_hiveblood_t1`] = 12000;
    market.modValueMap[`junk_gold_t1+breach_unstable_rare_t1`] = 2500;

    const sales = buildTierSaleTable(market, "breach_tablet")!;
    // A keys (solo S): 15000, 12000, 2500 → min 2500; S cascades
    expect(sales.uncorrupted.A).toBe(2500);
    expect(sales.uncorrupted.S).toBe(2500);
  });

  it("unmeasured better tier inherits worse measured (cascade), not dump crush", () => {
    const market = measuredFixture();
    market.junkSellByBase = { breach_tablet: 40 };
    market.modValueMap = {};
    // Only A-bucket measured (solo S via unstable)
    market.modValueMap[`junk_gold_t1+breach_unstable_rare_t1`] = 5000;
    const sales = buildTierSaleTable(market, "breach_tablet")!;
    expect(sales.uncorrupted.A).toBe(5000);
    expect(sales.uncorrupted.S).toBe(5000); // inherit A, not dump
    expect(sales.uncorrupted.Trash).toBe(40);
    expect(sales.dumpFloorSource).toBe("measured");
    expect(sales.uncorruptedSource.A).toBe("measured");
    expect(sales.uncorruptedSource.S).toBe("cascaded");
    expect(sales.uncorruptedSource.Trash).toBe("cascaded");
  });

  it("junk-heavy 2p+2s pool makes Trash the modal alch outcome", () => {
    const sales = buildTierSaleTable(measuredFixture(), "breach_tablet")!;
    // Shared eff is B; rarity is Junk on Breach; Domain dead — Trash must still beat
    // S and A individually.
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
    expect(sales.dumpFloorSource).toBe("measured");
    expect(sales.uncorruptedSource.Trash).toBe("cascaded");
    expect(sales.uncorruptedSource.S).toBe("cascaded");
  });

  it("magic T+A uses separate prefix/suffix pools (not a combined draw)", () => {
    const branch = magicOnePOneSBranchProbs("temple_tablet");
    expect(branch).not.toBeNull();
    // Temple S-mods are suffix-only (crystal, waystones) — combined-pool
    // (1-pS)^2 understates P(has S) vs true 1p+1s.
    expect(branch!.pHasS).toBeGreaterThan(0.05);
    expect(branch!.pHasS + branch!.pHasAOnly + branch!.pJunk).toBeCloseTo(
      1,
      9,
    );
  });

  it("chaos cache isolates runtime weight fingerprints", () => {
    clearChaosTransitionCache();
    const a = buildChaosOneAffixTransitions("temple_tablet");
    const b = buildChaosOneAffixTransitions("temple_tablet", {
      runtimeOverrides: { temple_crystal_t1: 50_000 },
    });
    const c = buildChaosOneAffixTransitions("temple_tablet");
    // Point path without overrides stays bit-identical to first build
    expect(c.Trash.Trash).toBe(a.Trash.Trash);
    // Runtime override must change chaos transitions (fingerprint isolation)
    const l1 =
      Math.abs(a.Trash.S - b.Trash.S) +
      Math.abs(a.Trash.A - b.Trash.A) +
      Math.abs(a.Trash.B - b.Trash.B) +
      Math.abs(a.Trash.Trash - b.Trash.Trash);
    expect(l1).toBeGreaterThan(1e-6);
  });

  it("point path buildTierSaleTable is unchanged without runtime overrides", () => {
    const market = measuredFixture();
    const a = buildTierSaleTable(market, "breach_tablet");
    const b = buildTierSaleTable(market, "breach_tablet", undefined);
    expect(a!.alchDist.S).toBe(b!.alchDist.S);
    expect(a!.alchDist.Trash).toBe(b!.alchDist.Trash);
    expect(a!.chaosFrom.Trash.S).toBe(b!.chaosFrom.Trash.S);
  });

  it("priced book aliases B sale and policy to Trash/dump", () => {
    const market = measuredFixture();
    market.junkSellByBase = { breach_tablet: 40 };
    market.modValueMap = {};
    // Cross-side B+B would have been a mid-band; skip → dump
    market.modValueMap[`junk_monster_eff_t1+breach_vruun_chance_t1`] = 80;
    const sales = buildTierSaleTable(market, "breach_tablet")!;
    expect(sales.uncorrupted.B).toBe(sales.uncorrupted.Trash);
    expect(sales.uncorrupted.B).toBe(40);
    expect(sales.uncorruptedSource.B).toBe(sales.uncorruptedSource.Trash);

    const policy = defaultPolicy("Scour-Alch");
    expect(policy.rare.B).toBe(policy.rare.Trash);
    expect(policy.rare.B).toBe("Chaos");
    expect(policy.corrupt.B).toBe(policy.corrupt.Trash);
    expect(policy.corrupt.B).toBe("Dump");
  });
});
