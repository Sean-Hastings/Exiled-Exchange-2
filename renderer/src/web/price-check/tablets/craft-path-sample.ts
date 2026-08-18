/**
 * Single-craft path sampler for §3 batch risk (§3.6).
 * Reforge = MDP-consistent 1/3 expected continuation (not simulatePolicy redraw).
 */
import {
  corruptSaleEx,
  entryDist,
  entrySpend,
  RARE_TIERS,
  solveRareValues,
  type CraftPolicy,
  type RareTier,
  type TierSaleTable,
} from "./tablet-mdp";

export type Rng = () => number;

export interface SampleCraftPathOpts {
  /** Risk default 50; Simulate keeps its own higher cap. */
  maxChaosPerItem?: number;
  /**
   * Precomputed rare continuation values (from solveRareValues).
   * Required for cheap MC; if omitted, solved once per call.
   */
  rareV?: Record<RareTier, number>;
}

export interface CraftPathSample {
  /** Liquid currency paid; NEVER subtract sales. */
  spend: number;
  /** Terminal sale (or MDP Reforge continuation value). */
  revenue: number;
  profit: number;
  chaosRolls: number;
  truncated: boolean;
  /** True when this path (or policy) used Reforge ≈ MDP 1/3. */
  reforgeApprox: boolean;
}

export function policyUsesReforge(policy: CraftPolicy): boolean {
  return RARE_TIERS.some((t) => policy.rare[t] === "Reforge");
}

function pickTier(d: Record<RareTier, number>, rng: Rng): RareTier {
  let r = rng();
  for (const t of RARE_TIERS) {
    r -= d[t]!;
    if (r <= 0) return t;
  }
  return "Trash";
}

/**
 * One tablet craft under fixed sales + policy Y.
 * Spend init = baseCost + (Magic? magicOrbCost : alchOrbCost), then chaos/vaal
 * as simulatePolicy economics. Reforge realizes rareV[tier] (MDP 1/3).
 */
export function sampleCraftPath(
  sales: TierSaleTable,
  policy: CraftPolicy,
  rng: Rng,
  opts?: SampleCraftPathOpts,
): CraftPathSample {
  const maxChaos = opts?.maxChaosPerItem ?? 50;
  const usesReforge = policyUsesReforge(policy);

  // Fail closed: non-finite entry spend must not fabricate spend=0 paths.
  const spend0 = entrySpend(sales, policy.blank);
  if (policy.blank === "Skip-Blanks" || !Number.isFinite(spend0)) {
    return {
      spend: Number.NaN,
      revenue: Number.NaN,
      profit: Number.NaN,
      chaosRolls: 0,
      truncated: false,
      reforgeApprox: usesReforge,
    };
  }

  const rareV =
    opts?.rareV ?? solveRareValues(sales, policy).rareV;

  const dist = entryDist(sales, policy.blank);

  let spend = spend0;

  let tier = pickTier(dist, rng);
  let corrupted = false;
  let rolls = 0;
  let done = false;
  let revenue = 0;
  let truncated = false;
  let chaosRolls = 0;
  let reforgeApprox = false;

  while (!done) {
    if (!corrupted) {
      const action = policy.rare[tier];
      if (action === "List") {
        revenue = sales.uncorrupted[tier];
        done = true;
      } else if (action === "Chaos") {
        spend += Number.isFinite(sales.chaosCost) ? sales.chaosCost : 0;
        rolls++;
        chaosRolls++;
        if (rolls >= maxChaos) {
          truncated = true;
          revenue = sales.uncorrupted[tier];
          done = true;
        } else {
          tier = pickTier(sales.chaosFrom[tier], rng);
        }
      } else if (action === "Reforge") {
        // MDP-consistent: V = (1/3) E[rareV under alchDist]; 0 bench fee.
        // Do NOT use simulatePolicy's full-redraw /sale/3 shortcut.
        revenue = rareV[tier];
        reforgeApprox = true;
        done = true;
      } else if (action === "Vaal") {
        spend += Number.isFinite(sales.vaalCost) ? sales.vaalCost : 0;
        corrupted = true;
      }
    } else {
      const action = policy.corrupt[tier];
      if (action === "List") revenue = sales.corrupted[tier];
      else revenue = corruptSaleEx(sales, tier);
      done = true;
    }
  }

  const profit = revenue - spend;
  return {
    spend,
    revenue,
    profit,
    chaosRolls,
    truncated,
    reforgeApprox: reforgeApprox || usesReforge,
  };
}
