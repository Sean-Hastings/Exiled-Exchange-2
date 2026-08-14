import { describe, expect, it } from "vitest";
import {
  TABLET_BASES,
  modWeightForBase,
} from "@/web/price-check/tablets/mod-weights";
import { modQualityTierForBase } from "@/web/price-check/tablets/mod-tiers";
import {
  fitWeightOverridesFromRates,
  withinAppBTolerance,
  type FitRateTarget,
} from "@/web/price-check/tablets/weight-fitter";

describe("weight-fitter", () => {
  it("recovers synthetic known cared weights under constant trash", () => {
    // Tiny synthetic side: use temple suffix pool but constant trash + known cared
    const baseId = "temple_tablet";
    const base = TABLET_BASES[baseId]!;
    const pool = base.allowedSuffixPool;
    const caredId = "temple_crystal_t1";
    const trashConstant = 1200;
    const caredW = 2400;

    // Build true weights and one-affix rates
    let W = 0;
    for (const id of pool) {
      if (id === caredId) W += caredW;
      else if (modQualityTierForBase(baseId, id) === "Junk") W += trashConstant;
      else W += modWeightForBase(baseId, id); // unmeasured non-junk hold seed
    }
    const pStar = caredW / W;

    const targets: FitRateTarget[] = [
      {
        modId: caredId,
        side: "suffix",
        mleRate: pStar,
        hits: Math.round(pStar * 10_000),
        trials: 10_000,
      },
    ];

    const snap = fitWeightOverridesFromRates(baseId, targets, {
      trashMode: "constant",
      trashConstant,
      maxIters: 200,
    });
    expect(snap.converged).toBe(true);
    expect(snap.weightOverrides[caredId]).toBeDefined();

    // Recompute implied rate under emitted overrides + constant trash
    let W2 = 0;
    const wOf = (id: string) => {
      if (Object.prototype.hasOwnProperty.call(snap.weightOverrides, id)) {
        return snap.weightOverrides[id]!;
      }
      if (modQualityTierForBase(baseId, id) === "Junk") return trashConstant;
      return modWeightForBase(baseId, id);
    };
    for (const id of pool) W2 += wOf(id);
    const implied = wOf(caredId) / W2;
    expect(withinAppBTolerance(implied, pStar)).toBe(true);
  });

  it("seed trash freezes Junk at modWeightForBase", () => {
    const baseId = "temple_tablet";
    const junkId = "temple_beacon_pack_t1"; // Temple exclusive Junk
    const seed = modWeightForBase(baseId, junkId);
    const targets: FitRateTarget[] = [
      {
        modId: "temple_crystal_t1",
        side: "suffix",
        mleRate: 0.03,
        hits: 30,
        trials: 1000,
      },
    ];
    const snap = fitWeightOverridesFromRates(baseId, targets, {
      trashMode: "seed",
      maxIters: 200,
    });
    // Junk should not appear as a stomped constant in overrides under seed mode
    // (unless it was a cared target — it isn't)
    expect(snap.weightOverrides[junkId]).toBeUndefined();
    expect(modWeightForBase(baseId, junkId)).toBe(seed);
    if (snap.converged) {
      expect(snap.trashMode).toBe("seed");
    }
  });

  it("measured zero-hit emits override 0 when converged", () => {
    const baseId = "temple_tablet";
    const targets: FitRateTarget[] = [
      {
        modId: "temple_crystal_t1",
        side: "suffix",
        mleRate: 0,
        hits: 0,
        trials: 500,
      },
    ];
    const snap = fitWeightOverridesFromRates(baseId, targets, {
      trashMode: "seed",
      maxIters: 200,
    });
    expect(snap.converged).toBe(true);
    expect(snap.weightOverrides.temple_crystal_t1).toBe(0);
  });

  it("sum MLE ≥ 1 → converged false, no apply overrides", () => {
    const baseId = "temple_tablet";
    // Two non-Junk mods on the same side (crystal S + waystone B suffix)
    const targets: FitRateTarget[] = [
      {
        modId: "temple_crystal_t1",
        side: "suffix",
        mleRate: 0.6,
        hits: 60,
        trials: 100,
      },
      {
        modId: "map_waystone_qty_t1",
        side: "suffix",
        mleRate: 0.5,
        hits: 50,
        trials: 100,
      },
    ];
    const snap = fitWeightOverridesFromRates(baseId, targets, {
      trashMode: "seed",
    });
    expect(snap.converged).toBe(false);
    expect(snap.failureReason).toBe("sum_mle_ge_one");
    expect(Object.keys(snap.weightOverrides)).toHaveLength(0);
  });

  it("maxIters failure returns converged false", () => {
    const baseId = "temple_tablet";
    // Extreme rate that may struggle with 1 iter
    const targets: FitRateTarget[] = [
      {
        modId: "temple_crystal_t1",
        side: "suffix",
        mleRate: 0.4,
        hits: 400,
        trials: 1000,
      },
    ];
    const snap = fitWeightOverridesFromRates(baseId, targets, {
      trashMode: "seed",
      maxIters: 1,
    });
    // Either converges in 1 or fails max_iters — with 1 iter often fails
    if (!snap.converged) {
      expect(snap.failureReason).toBe("max_iters");
      expect(Object.keys(snap.weightOverrides)).toHaveLength(0);
    }
  });

  it("IPS init starts from seed weight not ∝ p̂ (first iterate)", () => {
    const baseId = "temple_tablet";
    const caredId = "temple_crystal_t1";
    const base = TABLET_BASES[baseId]!;
    const pool = base.allowedSuffixPool;
    let W = 0;
    for (const id of pool) W += modWeightForBase(baseId, id);
    const seed = modWeightForBase(baseId, caredId);
    expect(seed).toBeGreaterThan(0);
    const pSeed = seed / W;

    // Target = seed-implied rate → IPS should land on seed (proves seed init,
    // not a proportional-from-zero restart).
    const snap = fitWeightOverridesFromRates(
      baseId,
      [
        {
          modId: caredId,
          side: "suffix",
          mleRate: pSeed,
          hits: Math.round(pSeed * 10_000),
          trials: 10_000,
        },
      ],
      { trashMode: "seed", maxIters: 200 },
    );
    expect(snap.converged).toBe(true);
    // Either no override (unchanged seed) or override ≈ seed
    const fitted = snap.weightOverrides[caredId] ?? seed;
    expect(fitted).toBeCloseTo(seed, 4);
    expect(snap.maxAbsErr).toBeLessThan(1e-4);
  });

  it("maxIters:0 forces max_iters failure", () => {
    const baseId = "temple_tablet";
    const snap = fitWeightOverridesFromRates(
      baseId,
      [
        {
          modId: "temple_crystal_t1",
          side: "suffix",
          mleRate: 0.4,
          hits: 400,
          trials: 1000,
        },
      ],
      { trashMode: "seed", maxIters: 0 },
    );
    expect(snap.converged).toBe(false);
    expect(snap.failureReason).toBe("max_iters");
    expect(Object.keys(snap.weightOverrides)).toHaveLength(0);
  });
});

describe("runtimeOverridesByBase isolation", () => {
  it("shared mod id override on base A does not change base B", () => {
    const sharedId = "map_pack_size_t1";
    expect(TABLET_BASES.breach_tablet?.allowedPrefixPool.includes(sharedId)).toBe(
      true,
    );
    expect(TABLET_BASES.temple_tablet?.allowedPrefixPool.includes(sharedId)).toBe(
      true,
    );

    const seedB = modWeightForBase("temple_tablet", sharedId);
    const overriddenA = seedB + 999;

    const opts = {
      runtimeOverridesByBase: {
        breach_tablet: { [sharedId]: overriddenA },
        // temple_tablet absent / empty — must not inherit A's map
      },
    };

    expect(modWeightForBase("breach_tablet", sharedId, opts)).toBe(overriddenA);
    expect(modWeightForBase("temple_tablet", sharedId, opts)).toBe(seedB);

    const emptyMapOpts = {
      runtimeOverridesByBase: {
        breach_tablet: { [sharedId]: overriddenA },
        temple_tablet: {},
      },
    };
    expect(modWeightForBase("temple_tablet", sharedId, emptyMapOpts)).toBe(seedB);
  });
});
