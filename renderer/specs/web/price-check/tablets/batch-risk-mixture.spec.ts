import { describe, expect, it } from "vitest";
import { createEmptyMarketCache } from "@/web/price-check/tablets/default-market";
import { TABLET_BASES } from "@/web/price-check/tablets/mod-weights";
import type { MarketPriceCache } from "@/web/price-check/tablets/tablet-ev-calculator";
import { computeBatchLaw } from "@/web/price-check/tablets/batch-law";
import {
  computeMixtureRisk,
  pointFitOverridesFromAggregate,
} from "@/web/price-check/tablets/batch-risk-mixture";
import type { RawSeenAggregate } from "@/web/price-check/tablets/roll-seen-types";
import { ROLL_SEEN_REVISION } from "@/web/price-check/tablets/roll-seen-types";
import { defaultPolicy } from "@/web/price-check/tablets/tablet-mdp";

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
  market.junkSellByBase = { temple_tablet: 50, breach_tablet: 25 };
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

function tinyAggregate(): RawSeenAggregate {
  return {
    revision: ROLL_SEEN_REVISION,
    updatedAt: 1,
    cells: [
      {
        baseId: "temple_tablet",
        side: "suffix",
        modId: "temple_crystal_t1",
        hits: 5,
        trials: 40,
        batchCount: 1,
      },
    ],
    sideTrials: [
      { baseId: "temple_tablet", side: "suffix", sideTrials: 40 },
      { baseId: "temple_tablet", side: "prefix", sideTrials: 40 },
    ],
  };
}

describe("batch-risk-mixture", () => {
  it("D=1 with fixed point overrides matches §3 on same seed", async () => {
    const market = measuredFixture();
    const policy = {
      blank: "Scour-Alch" as const,
      rare: {
        SS: "List" as const,
        S: "List" as const,
        A: "List" as const,
        B: "List" as const,
        Trash: "List" as const,
      },
      corrupt: {
        SS: "List" as const,
        S: "List" as const,
        A: "List" as const,
        B: "List" as const,
        Trash: "Dump" as const,
      },
    };
    const agg = tinyAggregate();
    const overrides = pointFitOverridesFromAggregate("temple_tablet", agg);

    const point = computeBatchLaw({
      baseId: "temple_tablet",
      market,
      policy,
      craftCountC: 4,
      mcBatches: 400,
      weightOverrides: overrides,
      retainSamples: true,
      rng: mulberry32(42),
    })!;

    const mix = await computeMixtureRisk({
      baseId: "temple_tablet",
      market,
      policy,
      craftCountC: 4,
      aggregate: agg,
      innerMcBatches: 400,
      fixedDrawOverrides: [overrides],
      rng: mulberry32(42),
      retainInner: true,
    });

    expect(mix).toBeTruthy();
    expect(mix!.outerDraws).toBe(1);
    expect(mix!.zCapEx).toBeCloseTo(point.zCapEx, 8);
    expect(mix!.zProfitEx).toBeCloseTo(point.zProfitEx, 8);
    expect(mix!.inner[0]?.spendEx.samples?.length).toBe(400);
  });

  it("pools MC sample banks across outer draws (method A)", async () => {
    const market = measuredFixture();
    const policy = defaultPolicy("Scour-Alch");
    policy.rare = { SS: "List", S: "List", A: "List", B: "List", Trash: "List" };

    const mix = await computeMixtureRisk({
      baseId: "breach_tablet",
      market,
      policy,
      craftCountC: 3,
      aggregate: {
        revision: ROLL_SEEN_REVISION,
        updatedAt: 1,
        cells: [],
        sideTrials: [],
      },
      fixedDrawOverrides: [{}, {}],
      innerMcBatches: 50,
      rng: mulberry32(3),
      retainInner: true,
    });

    expect(mix).toBeTruthy();
    expect(mix!.outerDraws).toBe(2);
    // Pooled CDF uses 2×50 samples; Z defined
    expect(Number.isFinite(mix!.zCapEx)).toBe(true);
    expect(Number.isFinite(mix!.zProfitEx)).toBe(true);
    expect(Number.isFinite(mix!.evBand[0])).toBe(true);
  });

  it("cancel via AbortSignal returns null", async () => {
    const ac = new AbortController();
    ac.abort();
    const mix = await computeMixtureRisk({
      baseId: "breach_tablet",
      market: measuredFixture(),
      policy: defaultPolicy("Scour-Alch"),
      craftCountC: 2,
      aggregate: tinyAggregate(),
      outerDraws: 10,
      fixedDrawOverrides: Array.from({ length: 10 }, () => ({})),
      signal: ac.signal,
      innerMcBatches: 20,
    });
    expect(mix).toBeNull();
  });

  it("mid-flight abort returns null", async () => {
    const ac = new AbortController();
    let saw = false;
    const mix = await computeMixtureRisk({
      baseId: "breach_tablet",
      market: measuredFixture(),
      policy: defaultPolicy("Scour-Alch"),
      craftCountC: 2,
      aggregate: tinyAggregate(),
      fixedDrawOverrides: Array.from({ length: 20 }, () => ({})),
      innerMcBatches: 30,
      chunkSize: 1,
      signal: ac.signal,
      onProgress: (done) => {
        if (done >= 2 && !saw) {
          saw = true;
          ac.abort();
        }
      },
    });
    expect(saw).toBe(true);
    expect(mix).toBeNull();
  });

  it("empty roll-seen without fixedDrawOverrides → null (not fake uncertainty)", async () => {
    const mix = await computeMixtureRisk({
      baseId: "breach_tablet",
      market: measuredFixture(),
      policy: defaultPolicy("Scour-Alch"),
      craftCountC: 3,
      aggregate: {
        revision: ROLL_SEEN_REVISION,
        updatedAt: 1,
        cells: [],
        sideTrials: [],
      },
      outerDraws: 5,
      innerMcBatches: 20,
      rng: mulberry32(3),
    });
    expect(mix).toBeNull();
  });

  it("junk-only / cared-empty mass → null (not D identical seed draws)", async () => {
    const mix = await computeMixtureRisk({
      baseId: "breach_tablet",
      market: measuredFixture(),
      policy: defaultPolicy("Scour-Alch"),
      craftCountC: 3,
      aggregate: {
        revision: ROLL_SEEN_REVISION,
        updatedAt: 1,
        // Junk cell + sideTrials: aggregateHasRollMass true, but no cared Dirichlet categories
        cells: [
          {
            baseId: "breach_tablet",
            side: "suffix",
            modId: "junk_extra_shrine_t1",
            hits: 12,
            trials: 40,
            batchCount: 1,
          },
        ],
        sideTrials: [
          { baseId: "breach_tablet", side: "suffix", sideTrials: 40 },
          { baseId: "breach_tablet", side: "prefix", sideTrials: 40 },
        ],
      },
      outerDraws: 8,
      innerMcBatches: 20,
      rng: mulberry32(7),
    });
    expect(mix).toBeNull();
  });

  it("returns null when successful outer draws < 50% of requested D", async () => {
    // 4 successes + 6 null IPS failures → 0.4 < MIXTURE_MIN_SUCCESS_FRAC
    const draws: Array<Record<string, number> | null> = [
      {},
      {},
      {},
      {},
      null,
      null,
      null,
      null,
      null,
      null,
    ];
    const mix = await computeMixtureRisk({
      baseId: "breach_tablet",
      market: measuredFixture(),
      policy: defaultPolicy("Scour-Alch"),
      craftCountC: 3,
      aggregate: tinyAggregate(),
      fixedDrawOverrides: draws,
      innerMcBatches: 30,
      rng: mulberry32(11),
    });
    expect(mix).toBeNull();
  });

  // Intentionally NO assertion that mixture Z_cap ≥ point Z_cap (flaky).
});
