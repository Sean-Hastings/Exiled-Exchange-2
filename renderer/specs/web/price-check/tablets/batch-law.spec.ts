import { describe, expect, it } from "vitest";
import { createEmptyMarketCache } from "@/web/price-check/tablets/default-market";
import { TABLET_BASES } from "@/web/price-check/tablets/mod-weights";
import type { MarketPriceCache } from "@/web/price-check/tablets/tablet-ev-calculator";
import {
  computeBatchLaw,
  computeBatchLawAsync,
  empiricalQuantile,
  RISK_MAX_CHAOS_PER_ITEM,
} from "@/web/price-check/tablets/batch-law";
import {
  sampleCraftPath,
  policyUsesReforge,
} from "@/web/price-check/tablets/craft-path-sample";
import {
  buildTierSaleTable,
  defaultPolicy,
  solveRareValues,
  type CraftPolicy,
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

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("sampleCraftPath / batch-law", () => {
  it("spend never subtracts sales (profit = revenue - spend)", () => {
    const sales = buildTierSaleTable(measuredFixture(), "breach_tablet")!;
    const policy = defaultPolicy("Scour-Alch");
    const { rareV } = solveRareValues(sales, policy);
    const path = sampleCraftPath(sales, policy, mulberry32(1), { rareV });
    expect(path.spend).toBeGreaterThan(0);
    expect(path.profit).toBeCloseTo(path.revenue - path.spend, 10);
    // Spend is blank + orb (+ optional chaos/vaal), not net of sale
    expect(path.spend).toBeGreaterThanOrEqual(sales.baseCost);
  });

  it("Skip-Blanks → computeBatchLaw null (risk N/A)", () => {
    const policy: CraftPolicy = {
      ...defaultPolicy("Skip-Blanks"),
      blank: "Skip-Blanks",
    };
    const hit = computeBatchLaw({
      baseId: "breach_tablet",
      market: measuredFixture(),
      policy,
      craftCountC: 10,
      mcBatches: 100,
      rng: mulberry32(2),
    });
    expect(hit).toBeNull();
  });

  it("NaN baseCost → computeBatchLaw null", () => {
    const market = measuredFixture();
    market.basePrices.breach_tablet = Number.NaN;
    const hit = computeBatchLaw({
      baseId: "breach_tablet",
      market,
      policy: defaultPolicy("Scour-Alch"),
      craftCountC: 5,
      mcBatches: 50,
      rng: mulberry32(3),
    });
    expect(hit).toBeNull();
  });

  it("Reforge policy: forced Trash path revenue === rareV.Trash (MDP 1/3)", () => {
    const sales = buildTierSaleTable(measuredFixture(), "breach_tablet")!;
    const policy: CraftPolicy = {
      blank: "Scour-Alch",
      rare: { SS: "List", S: "List", A: "List", B: "List", Trash: "Reforge" },
      corrupt: { SS: "List", S: "List", A: "List", B: "List", Trash: "Dump" },
    };
    expect(policyUsesReforge(policy)).toBe(true);
    // Degenerate dist: always land on Trash
    const forced = {
      ...sales,
      alchDist: { SS: 0, S: 0, A: 0, B: 0, Trash: 1 },
    };
    const { rareV } = solveRareValues(forced, policy);
    // rng=0.999: with S/A/B mass 0, first positive mass is Trash
    const path = sampleCraftPath(forced, policy, () => 0.999, { rareV });
    expect(path.reforgeApprox).toBe(true);
    expect(path.chaosRolls).toBe(0);
    expect(path.revenue).toBe(rareV.Trash);

    const law = computeBatchLaw({
      baseId: "breach_tablet",
      market: measuredFixture(),
      policy,
      craftCountC: 5,
      mcBatches: 200,
      rng: mulberry32(7),
      retainSamples: true,
    });
    expect(law).toBeTruthy();
    expect(law!.reforgeApprox).toBe(true);
    expect(law!.method).toBe("mc");
    expect(law!.spendEx.samples?.length).toBe(200);
  });

  it("sampleCraftPath fail-closed on non-finite baseCost", () => {
    const sales = buildTierSaleTable(measuredFixture(), "breach_tablet")!;
    const bad = { ...sales, baseCost: Number.NaN };
    const path = sampleCraftPath(bad, defaultPolicy("Scour-Alch"), () => 0.1);
    expect(Number.isFinite(path.spend)).toBe(false);
    expect(Number.isFinite(path.profit)).toBe(false);
  });

  it("computeBatchLawAsync cancels mid-flight via AbortSignal", async () => {
    const ac = new AbortController();
    let sawProgress = false;
    const pending = computeBatchLawAsync({
      baseId: "breach_tablet",
      market: measuredFixture(),
      policy: defaultPolicy("Scour-Alch"),
      craftCountC: 2,
      mcBatches: 5_000,
      chunkSize: 50,
      signal: ac.signal,
      onProgress: (done) => {
        if (done >= 50 && !sawProgress) {
          sawProgress = true;
          ac.abort();
        }
      },
    });
    const hit = await pending;
    expect(sawProgress).toBe(true);
    expect(hit).toBeNull();
  });

  it("chaos cap defaults to 50 for risk", () => {
    expect(RISK_MAX_CHAOS_PER_ITEM).toBe(50);
    const policy = defaultPolicy("Scour-Alch"); // Trash→Chaos
    const law = computeBatchLaw({
      baseId: "breach_tablet",
      market: measuredFixture(),
      policy,
      craftCountC: 2,
      mcBatches: 300,
      maxChaosPerItem: 50,
      rng: mulberry32(9),
    });
    expect(law).toBeTruthy();
    expect(law!.zCapEx).toBeGreaterThan(0);
    expect(law!.zProfitEx).toBeLessThan(law!.spendEx.mean + 1e9);
  });

  it("empiricalQuantile is monotone", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(empiricalQuantile(xs, 0.05)).toBeLessThanOrEqual(
      empiricalQuantile(xs, 0.95),
    );
  });

  it("batch spend is total (no sale offsets) — scales ~with C", () => {
    const market = measuredFixture();
    const policy: CraftPolicy = {
      blank: "Scour-Alch",
      rare: { SS: "List", S: "List", A: "List", B: "List", Trash: "List" },
      corrupt: { SS: "List", S: "List", A: "List", B: "List", Trash: "Dump" },
    };
    const c5 = computeBatchLaw({
      baseId: "breach_tablet",
      market,
      policy,
      craftCountC: 5,
      mcBatches: 2000,
      rng: mulberry32(11),
    })!;
    const c10 = computeBatchLaw({
      baseId: "breach_tablet",
      market,
      policy,
      craftCountC: 10,
      mcBatches: 2000,
      rng: mulberry32(11),
    })!;
    // List-only: spend per craft = base + alch (deterministic)
    expect(c10.spendEx.mean / c5.spendEx.mean).toBeCloseTo(2, 1);
  });
});
