import type { CraftPolicy } from "./tablet-mdp";

export interface BatchRiskKnobs {
  /** Buy count — mean of cheapest B asks → blank unit cost */
  buyCountB: number;
  /** Craft count — batch size for 1a/1b */
  craftCountC: number;
  /** Spend / profit percentile (default 0.95) */
  percentile: number; // 0.95
}

export interface BatchLawResult {
  baseId: string;
  policy: CraftPolicy;
  craftCountC: number;
  /** Point weights used (or one outer draw) */
  mode: "point" | "mixture-draw";
  /** CDF samples or analytic summary */
  spendEx: { mean: number; p95: number; samples?: number[] };
  profitEx: { mean: number; p05: number; samples?: number[] };
  /** 1a: Z_cap = spend p95; 1b: Z_profit = profit p05 (95% sure profit ≥ Z) */
  zCapEx: number;
  zProfitEx: number;
  method: "analytic" | "grid" | "mc";
  /**
   * When policy uses Reforge: always set (v1 always approximates).
   * UI shows “approx” badge; bands are not claimed as exact calibrated 95%.
   */
  reforgeApprox?: boolean;
  note?: string;
}

export interface MixtureRiskResult {
  baseId: string;
  policy: CraftPolicy;
  craftCountC: number;
  /** Successful outer draws used in the pooled CDF. */
  outerDraws: number;
  /** Requested outer draw count (before IPS skips). */
  outerDrawsRequested?: number;
  /** Mixture CDF percentiles (pooled MC samples — see §3.7) */
  zCapEx: number;
  zProfitEx: number;
  /**
   * Mixture band on whiteEV from solvePolicy(fixed Y, draw weights):
   * empirical p05–p95 across outer draws (DEFAULT). Point whiteEV stays separate.
   */
  evMeanEx: number;
  /** [p05, p95] of per-draw whiteEV */
  evBand: [number, number];
  reforgeApprox?: boolean;
  /** IPS skip / mass warning (do not silently shrink D). */
  note?: string;
  inner: BatchLawResult[]; // optional debug; UI may drop
}
