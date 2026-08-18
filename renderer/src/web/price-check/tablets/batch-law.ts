/**
 * §3 batch law under fixed weights + policy Y (MC-first).
 */
import type { BatchLawResult } from "./batch-risk-types";
import {
  sampleCraftPath,
  policyUsesReforge,
  type Rng,
} from "./craft-path-sample";
import type { ModWeightOpts } from "./mod-weights";
import {
  buildTierSaleTable,
  entrySpend,
  solveRareValues,
  type CraftPolicy,
} from "./tablet-mdp";
import type { MarketPriceCache } from "./tablet-ev-calculator";

export const RISK_MAX_CHAOS_PER_ITEM = 50;
export const POINT_MC_BATCHES = 20_000;
export const MIXTURE_INNER_MC_BATCHES = 5_000;
/** Yield to UI every N MC batches for point §3 (non-blocking). */
export const POINT_MC_CHUNK = 500;

export interface BatchLawInput {
  baseId: string;
  market: MarketPriceCache;
  policy: CraftPolicy;
  craftCountC: number;
  /** Spend percentile for Z_cap; profit uses 1−percentile for Z_profit. Default 0.95. */
  percentile?: number;
  weightOverrides?: Record<string, number>;
  /** Risk chaos cap; default 50 */
  maxChaosPerItem?: number;
  /** Point §3 default 20_000; mixture inner may use 5_000 */
  mcBatches?: number;
  /** Require sample banks (mixture). Default true when storing samples. */
  retainSamples?: boolean;
  rng?: Rng;
  mode?: "point" | "mixture-draw";
}

export interface BatchLawAsyncInput extends BatchLawInput {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** Batches per yield; default POINT_MC_CHUNK. */
  chunkSize?: number;
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setTimeout === "function") setTimeout(resolve, 0);
    else resolve();
  });
}

/** Empirical inverse CDF via linear interpolation on sorted samples. */
export function empiricalQuantile(samples: number[], q: number): number {
  if (!samples.length) return Number.NaN;
  if (q <= 0) return samples[0]!;
  if (q >= 1) return samples[samples.length - 1]!;
  const sorted = [...samples].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  const w = pos - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

export function meanOf(samples: number[]): number {
  if (!samples.length) return Number.NaN;
  let s = 0;
  for (const x of samples) s += x;
  return s / samples.length;
}

function prepareBatchLaw(input: BatchLawInput): {
  sales: NonNullable<ReturnType<typeof buildTierSaleTable>>;
  rareV: ReturnType<typeof solveRareValues>["rareV"];
  mcBatches: number;
  craftCountC: number;
  maxChaosPerItem: number;
  percentile: number;
  retainSamples: boolean;
  rng: Rng;
  mode: "point" | "mixture-draw";
  baseId: string;
  policy: CraftPolicy;
} | null {
  const {
    baseId,
    market,
    policy,
    craftCountC,
    percentile = 0.95,
    weightOverrides,
    maxChaosPerItem = RISK_MAX_CHAOS_PER_ITEM,
    mcBatches = POINT_MC_BATCHES,
    retainSamples = true,
    rng = Math.random,
    mode = "point",
  } = input;

  if (policy.blank === "Skip-Blanks") return null;
  if (!(craftCountC > 0) || !(mcBatches > 0)) return null;

  const wOpts: ModWeightOpts | undefined = weightOverrides
    ? { runtimeOverrides: weightOverrides }
    : undefined;
  const sales = buildTierSaleTable(market, baseId, wOpts);
  if (!sales) return null;
  if (!Number.isFinite(entrySpend(sales, policy.blank))) return null;

  const { rareV } = solveRareValues(sales, policy);
  return {
    sales,
    rareV,
    mcBatches,
    craftCountC,
    maxChaosPerItem,
    percentile,
    retainSamples,
    rng,
    mode,
    baseId,
    policy,
  };
}

function finishBatchLaw(
  prep: NonNullable<ReturnType<typeof prepareBatchLaw>>,
  spendSamples: number[],
  profitSamples: number[],
  truncatedBatches: number,
): BatchLawResult {
  const {
    baseId,
    policy,
    craftCountC,
    percentile,
    retainSamples,
    mode,
    mcBatches,
    maxChaosPerItem,
  } = prep;
  const zCapEx = empiricalQuantile(spendSamples, percentile);
  const zProfitEx = empiricalQuantile(profitSamples, 1 - percentile);
  const reforgeApprox = policyUsesReforge(policy);
  const truncFrac = truncatedBatches / mcBatches;

  return {
    baseId,
    policy,
    craftCountC,
    mode,
    spendEx: {
      mean: meanOf(spendSamples),
      p95: zCapEx,
      ...(retainSamples ? { samples: spendSamples } : {}),
    },
    profitEx: {
      mean: meanOf(profitSamples),
      p05: zProfitEx,
      ...(retainSamples ? { samples: profitSamples } : {}),
    },
    zCapEx,
    zProfitEx,
    method: "mc",
    ...(reforgeApprox ? { reforgeApprox: true } : {}),
    ...(truncFrac > 0.01
      ? {
          note: `chaos-cap truncated ${(truncFrac * 100).toFixed(1)}% of batches (maxChaos=${maxChaosPerItem})`,
        }
      : {}),
  };
}

/**
 * MC batch law: S_C = Σ spend_i, Π_C = Σ profit_i over C i.i.d. crafts.
 * Returns null for Skip-Blanks or non-finite baseCost (risk UI → N/A).
 * Sync — prefer {@link computeBatchLawAsync} for UI point §3 (20k×C).
 */
export function computeBatchLaw(input: BatchLawInput): BatchLawResult | null {
  const prep = prepareBatchLaw(input);
  if (!prep) return null;

  const spendSamples: number[] = [];
  const profitSamples: number[] = [];
  let truncatedBatches = 0;

  for (let b = 0; b < prep.mcBatches; b++) {
    let spendSum = 0;
    let profitSum = 0;
    let anyTrunc = false;
    for (let i = 0; i < prep.craftCountC; i++) {
      const path = sampleCraftPath(prep.sales, prep.policy, prep.rng, {
        maxChaosPerItem: prep.maxChaosPerItem,
        rareV: prep.rareV,
      });
      spendSum += path.spend;
      profitSum += path.profit;
      if (path.truncated) anyTrunc = true;
    }
    spendSamples.push(spendSum);
    profitSamples.push(profitSum);
    if (anyTrunc) truncatedBatches++;
  }

  return finishBatchLaw(prep, spendSamples, profitSamples, truncatedBatches);
}

/**
 * Chunked / cancellable point §3 MC — yields so UI stays responsive.
 * Returns null on abort, Skip-Blanks, or missing baseCost.
 */
export async function computeBatchLawAsync(
  input: BatchLawAsyncInput,
): Promise<BatchLawResult | null> {
  const prep = prepareBatchLaw(input);
  if (!prep) return null;

  const { signal, onProgress, chunkSize = POINT_MC_CHUNK } = input;
  const spendSamples: number[] = [];
  const profitSamples: number[] = [];
  let truncatedBatches = 0;

  for (let b = 0; b < prep.mcBatches; b++) {
    if (signal?.aborted) return null;

    let spendSum = 0;
    let profitSum = 0;
    let anyTrunc = false;
    for (let i = 0; i < prep.craftCountC; i++) {
      const path = sampleCraftPath(prep.sales, prep.policy, prep.rng, {
        maxChaosPerItem: prep.maxChaosPerItem,
        rareV: prep.rareV,
      });
      spendSum += path.spend;
      profitSum += path.profit;
      if (path.truncated) anyTrunc = true;
    }
    spendSamples.push(spendSum);
    profitSamples.push(profitSum);
    if (anyTrunc) truncatedBatches++;

    onProgress?.(b + 1, prep.mcBatches);
    if ((b + 1) % chunkSize === 0) await yieldToUi();
  }

  if (signal?.aborted) return null;
  return finishBatchLaw(prep, spendSamples, profitSamples, truncatedBatches);
}
