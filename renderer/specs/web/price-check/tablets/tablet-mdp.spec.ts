import { describe, expect, it } from "vitest";
import { createEmptyMarketCache } from "@/web/price-check/tablets/default-market";
import {
  resetComboTierOverridesForTests,
  setSessionComboTier,
} from "@/web/price-check/tablets/combo-tier-overrides";
import {
  clearSessionModTiers,
  setSessionModTier,
} from "@/web/price-check/tablets/mod-tiers";
import { TABLET_BASES } from "@/web/price-check/tablets/mod-weights";
import type { MarketPriceCache } from "@/web/price-check/tablets/tablet-ev-calculator";
import { applyTempleManualSurveyMarket } from "@/web/price-check/tablets/temple-manual-market";
import {
  buildChaosOneAffixTransitions,
  buildTierSaleTable,
  clearChaosTransitionCache,
  defaultPolicy,
  expectedUnderDist,
  magicOnePOneSBranchProbs,
  modsToRareTier,
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
      SS: { SS: 1, S: 0, A: 0, B: 0, Trash: 0 },
      S: { SS: 0, S: 1, A: 0, B: 0, Trash: 0 },
      A: { SS: 0, S: 0, A: 1, B: 0, Trash: 0 },
      B: { SS: 0, S: 0, A: 0, B: 1, Trash: 0 },
      Trash: { SS: 0, S: 0, A: 0, B: 0, Trash: 1 },
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
      Math.abs(row.SS - sales.alchDist.SS) +
      Math.abs(row.S - sales.alchDist.S) +
      Math.abs(row.A - sales.alchDist.A) +
      Math.abs(row.B - sales.alchDist.B) +
      Math.abs(row.Trash - sales.alchDist.Trash);
    expect(redrawL1).toBeGreaterThan(0.05);
    // One-slot replace: landing a single S mod is S-tier (solo S), not jackpot SS
    expect(row.SS).toBeLessThanOrEqual(sales.alchDist.SS + 1e-12);
  });

  it("optimal rare policy exposes marginal vs list (dump/sell = 0)", () => {
    const market = measuredFixture();
    market.currencyCosts.chaos = 45;
    market.junkSellByBase = { temple_tablet: 60 };
    const sales = buildTierSaleTable(market, "temple_tablet")!;
    const opt = solveOptimalRarePolicy(sales);
    expect(opt.actionMarginals.Trash.List).toBeCloseTo(0, 5);
    // List is never worse than itself
    for (const t of ["SS", "S", "A", "B", "Trash"] as const) {
      expect(opt.actionMarginals[t].List).toBeCloseTo(0, 5);
    }
    // Reroll-worthy iff best action ≠ List
    for (const t of opt.rerollWorthy) {
      expect(opt.rare[t]).not.toBe("List");
      expect(opt.marginalVsList[t]).toBeGreaterThan(0);
    }
  });

  it("optimal rare policy always Lists S and SS even when Chaos Q is higher", () => {
    // Inflated SS asks + soft Trash continuation would previously Chaos S.
    const sales = {
      uncorrupted: { SS: 50_000, S: 6_000, A: 400, B: 40, Trash: 40 },
      corrupted: { SS: 45_000, S: 5_000, A: 300, B: 30, Trash: 30 },
      alchDist: { SS: 0.02, S: 0.08, A: 0.15, B: 0.1, Trash: 0.65 },
      magicDist: { SS: 0.02, S: 0.08, A: 0.15, B: 0.1, Trash: 0.65 },
      pMagicPromising: 0.25,
      pMagicTrash: 0.75,
      chaosFrom: {
        SS: { SS: 0.7, S: 0.2, A: 0.05, B: 0.03, Trash: 0.02 },
        // From S: meaningful chance to land SS, bricks soft via Trash V.
        S: { SS: 0.35, S: 0.2, A: 0.1, B: 0.05, Trash: 0.3 },
        A: { SS: 0.05, S: 0.15, A: 0.2, B: 0.1, Trash: 0.5 },
        B: { SS: 0.02, S: 0.08, A: 0.15, B: 0.15, Trash: 0.6 },
        Trash: { SS: 0.02, S: 0.08, A: 0.15, B: 0.1, Trash: 0.65 },
      },
      measuredFrac: 1,
      magicOrbCost: 0.03,
      magicConvertCost: 0.2,
      alchOrbCost: 0.05,
      chaosCost: 1,
      vaalCost: 0.4,
      baseCost: 100,
      magicBuyCost: Number.NaN,
      rareBuyCost: Number.NaN,
      dumpFloor: 40,
      dumpFloorSource: "measured" as const,
      uncorruptedSource: {
        SS: "measured" as const,
        S: "measured" as const,
        A: "measured" as const,
        B: "measured" as const,
        Trash: "measured" as const,
      },
    };
    const opt = solveOptimalRarePolicy(sales);
    expect(opt.rare.SS).toBe("List");
    expect(opt.rare.S).toBe("List");
    expect(opt.rerollWorthy).not.toContain("SS");
    expect(opt.rerollWorthy).not.toContain("S");
    // Chaos one-step Q on S still beats list under soft Trash V — policy ignores it.
    expect(opt.actionMarginals.S.Chaos).toBeGreaterThan(0);
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
      hit.sales.alchDist.SS * hit.rareV.SS +
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
    // Breach exclusives are suffix-only; 1p+1s with S-suffix is MDP S (solo S).
    // Measure S at two prices — monotone / low-end uses min; SS cascades from S.
    market.modValueMap[`junk_gold_t1+breach_unstable_rare_t1`] = 2000;
    market.modValueMap[`junk_xp_t1+breach_unstable_rare_t1`] = 9000;

    const sales = buildTierSaleTable(market, "breach_tablet")!;
    expect(sales.measuredFrac).toBeGreaterThan(0);
    expect(sales.measuredFrac).toBeLessThan(1);
    // S measured min 2000; SS unmeasured → cascade to S
    expect(sales.uncorrupted.S).toBe(2000);
    expect(sales.uncorrupted.SS).toBe(2000);
    expect(sales.uncorrupted.SS).toBeGreaterThanOrEqual(sales.uncorrupted.S);
    expect(sales.uncorrupted.Trash).toBeLessThanOrEqual(sales.uncorrupted.B);
    expect(sales.uncorrupted.B).toBeLessThanOrEqual(sales.uncorrupted.A);
  });

  it("tier hit prices use low-end (min) of measured comps, not mean", () => {
    const market = measuredFixture();
    market.junkSellByBase = { breach_tablet: 40 };
    market.modValueMap = {};
    // Solo S (unstable) → S bucket; Domain splinters are Junk (not S/A)
    market.modValueMap[`junk_monster_eff_t1+breach_unstable_rare_t1`] = 15000;
    market.modValueMap[`junk_item_rarity_t1+breach_hiveblood_t1`] = 12000;
    market.modValueMap[`junk_gold_t1+breach_unstable_rare_t1`] = 2500;

    const sales = buildTierSaleTable(market, "breach_tablet")!;
    // S keys (solo S): 15000, 12000, 2500 → min 2500; SS cascades
    expect(sales.uncorrupted.S).toBe(2500);
    expect(sales.uncorrupted.SS).toBe(2500);
  });

  it("unmeasured better tier inherits worse measured (cascade), not dump crush", () => {
    const market = measuredFixture();
    market.junkSellByBase = { breach_tablet: 40 };
    market.modValueMap = {};
    // Only S-bucket measured (solo S via unstable)
    market.modValueMap[`junk_gold_t1+breach_unstable_rare_t1`] = 5000;
    const sales = buildTierSaleTable(market, "breach_tablet")!;
    expect(sales.uncorrupted.S).toBe(5000);
    expect(sales.uncorrupted.SS).toBe(5000); // inherit S, not dump
    expect(sales.uncorrupted.Trash).toBe(40);
    expect(sales.dumpFloorSource).toBe("measured");
    expect(sales.uncorruptedSource.S).toBe("measured");
    expect(sales.uncorruptedSource.SS).toBe("cascaded");
    expect(sales.uncorruptedSource.Trash).toBe("measured");
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
    expect(sales.uncorrupted.SS).toBe(33);
    expect(sales.uncorrupted.S).toBe(33);
    expect(sales.uncorrupted.A).toBe(33);
    expect(sales.uncorrupted.B).toBe(33);
    expect(sales.dumpFloorSource).toBe("measured");
    expect(sales.uncorruptedSource.Trash).toBe("measured");
    expect(sales.uncorruptedSource.SS).toBe("cascaded");
  });

  it("magic T+A uses separate prefix/suffix pools (not a combined draw)", () => {
    const branch = magicOnePOneSBranchProbs("temple_tablet");
    expect(branch).not.toBeNull();
    // Temple S-mods are suffix-only (crystal, waystones) — combined-pool
    // (1-pS)^2 understates P(has S) vs true 1p+1s.
    expect(branch!.pHasS).toBeGreaterThan(0.05);
    expect(branch!.pPromising).toBeCloseTo(
      branch!.pHasS + branch!.pHasAOnly,
      9,
    );
    expect(branch!.pPromising + branch!.pTrash).toBeCloseTo(1, 9);
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
      Math.abs(a.Trash.SS - b.Trash.SS) +
      Math.abs(a.Trash.S - b.Trash.S) +
      Math.abs(a.Trash.A - b.Trash.A) +
      Math.abs(a.Trash.B - b.Trash.B) +
      Math.abs(a.Trash.Trash - b.Trash.Trash);
    expect(l1).toBeGreaterThan(1e-6);
  });

  it("chaos cache isolates mod-quality session fingerprints", () => {
    clearChaosTransitionCache();
    clearSessionModTiers("temple_tablet");
    const before = buildChaosOneAffixTransitions("temple_tablet");
    setSessionModTier("temple_tablet", "temple_crystal_t1", "Junk");
    const after = buildChaosOneAffixTransitions("temple_tablet");
    const l1 =
      Math.abs(before.Trash.SS - after.Trash.SS) +
      Math.abs(before.Trash.S - after.Trash.S) +
      Math.abs(before.Trash.A - after.Trash.A) +
      Math.abs(before.Trash.B - after.Trash.B) +
      Math.abs(before.Trash.Trash - after.Trash.Trash);
    expect(l1).toBeGreaterThan(1e-6);
    clearSessionModTiers("temple_tablet");
    clearChaosTransitionCache();
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

  it("Buy-Magic is alch-only (bought blues are always trash)", () => {
    const market = measuredFixture();
    market.magicBuyByBase = { breach_tablet: 40 };
    const buyMagic = solvePolicy(
      market,
      "breach_tablet",
      defaultPolicy("Buy-Magic"),
    )!;
    const fromBlank = solvePolicy(
      market,
      "breach_tablet",
      defaultPolicy("Magic-Pipeline"),
    )!;
    expect(buyMagic.sales.pMagicPromising).toBeGreaterThan(0);
    expect(buyMagic.sales.pMagicPromising + buyMagic.sales.pMagicTrash).toBeCloseTo(
      1,
      9,
    );
    const alchCont = expectedUnderDist(buyMagic.sales.alchDist, buyMagic.rareV);
    const pipeCont = expectedUnderDist(
      fromBlank.sales.magicDist,
      fromBlank.rareV,
    );
    expect(buyMagic.whiteEV).toBeCloseTo(
      alchCont - 40 - buyMagic.sales.alchOrbCost,
      5,
    );
    expect(alchCont).toBeLessThan(pipeCont);
  });

  it("Buy-Magic beats Magic-Pipeline when magics are cheaper than blank+T+A", () => {
    const market = measuredFixture();
    market.basePrices.breach_tablet = 200;
    market.magicBuyByBase = { breach_tablet: 20 };
    const buyMagic = solvePolicy(
      market,
      "breach_tablet",
      defaultPolicy("Buy-Magic"),
    )!;
    const fromBlank = solvePolicy(
      market,
      "breach_tablet",
      defaultPolicy("Magic-Pipeline"),
    )!;
    expect(Number.isFinite(buyMagic.whiteEV)).toBe(true);
    expect(buyMagic.whiteEV).toBeGreaterThan(fromBlank.whiteEV);
    const rec = recommendPolicy(market, "breach_tablet");
    expect(rec!.policy.blank).toBe("Buy-Magic");
  });

  it("Magic-Pipeline beats Buy-Magic when trash blues cost about blank+T+A", () => {
    const market = measuredFixture();
    // Trash is the live dump floor (~25), not leaked global combo asks.
    // Cheap blanks keep craft +EV so Skip does not mask the comparison.
    market.basePrices.breach_tablet = 12;
    const fromBlank = solvePolicy(
      market,
      "breach_tablet",
      defaultPolicy("Magic-Pipeline"),
    )!;
    market.magicBuyByBase = {
      breach_tablet: fromBlank.sales.baseCost + fromBlank.sales.magicOrbCost,
    };
    const rec = recommendPolicy(market, "breach_tablet");
    expect(rec!.policy.blank).toBe("Magic-Pipeline");
  });

  it("live junkSellByBase dump is per-base even after Temple survey combos", () => {
    const market = applyTempleManualSurveyMarket(createEmptyMarketCache());
    market.fx = { exaltPerChaos: 45, exaltPerDivine: 350 };
    market.currencyCosts.chaos = 45;
    market.currencyCosts.alchemy = 0.05;
    // Leftover global survey dump keys must not set Trash on other bases
    market.modValueMap["junk_xp_t1+junk_extra_shrine_t1"] = 60;
    market.modValueMap["junk_gold_t1+junk_extra_strongbox_t1"] = 60;
    market.priceSource = {
      ...market.priceSource,
      modValueMap: {
        ...market.priceSource?.modValueMap,
        "junk_xp_t1+junk_extra_shrine_t1": "manual-survey",
        "junk_gold_t1+junk_extra_strongbox_t1": "manual-survey",
      },
      junkSellByBase: {
        ...market.priceSource?.junkSellByBase,
        breach_tablet: "measured",
        temple_tablet: "measured",
      },
    };
    market.junkSellByBase = {
      ...market.junkSellByBase,
      breach_tablet: 22,
      temple_tablet: 18,
    };

    const breach = buildTierSaleTable(market, "breach_tablet")!;
    expect(breach.uncorrupted.Trash).toBe(22);
    expect(breach.uncorruptedSource.Trash).toBe("measured");
    const temple = buildTierSaleTable(market, "temple_tablet")!;
    expect(temple.uncorrupted.Trash).toBe(18);
    expect(temple.uncorruptedSource.Trash).toBe("measured");
  });

  it("Buy-Rare uses Trash continuation minus junk buy", () => {
    const market = measuredFixture();
    market.junkBuyByBase = { breach_tablet: 15 };
    const hit = solvePolicy(
      market,
      "breach_tablet",
      defaultPolicy("Buy-Rare"),
    )!;
    expect(hit.whiteEV).toBeCloseTo(hit.rareV.Trash - 15, 5);
  });

  it("combo tier override re-buckets measured 1p1s sales", () => {
    resetComboTierOverridesForTests();
    const market = measuredFixture();
    const modIds = ["junk_gold_t1", "breach_unstable_rare_t1"];
    const key = "junk_gold_t1+breach_unstable_rare_t1";
    expect(modsToRareTier(modIds, "breach_tablet")).toBe("S");
    market.modValueMap[key] = 8000;

    const before = buildTierSaleTable(market, "breach_tablet")!;
    expect(before.uncorrupted.S).toBe(8000);

    setSessionComboTier("breach_tablet", modIds, "A");
    const after = buildTierSaleTable(market, "breach_tablet")!;
    expect(modsToRareTier(modIds, "breach_tablet")).toBe("A");
    expect(after.uncorrupted.A).toBe(8000);

    resetComboTierOverridesForTests();
  });

  it("combo tier override shifts alchDist mass", () => {
    resetComboTierOverridesForTests();
    const market = measuredFixture();
    const before = buildTierSaleTable(market, "breach_tablet")!;
    const ssBefore = before.alchDist.SS;

    const modIds = [
      "junk_gold_t1",
      "junk_xp_t1",
      "breach_unstable_rare_t1",
      "breach_hiveblood_t1",
    ];
    expect(modsToRareTier(modIds, "breach_tablet")).toBe("SS");
    setSessionComboTier("breach_tablet", modIds, "Trash");

    const after = buildTierSaleTable(market, "breach_tablet")!;
    expect(after.alchDist.SS).toBeLessThan(ssBefore);
    expect(after.alchDist.Trash).toBeGreaterThan(before.alchDist.Trash);

    resetComboTierOverridesForTests();
  });
});
