/**
 * §9 outer mixture over Dirichlet weight draws → pooled MC batch law.
 */
import type { MixtureRiskResult, BatchLawResult } from "./batch-risk-types";
import {
  computeBatchLaw,
  empiricalQuantile,
  meanOf,
  MIXTURE_INNER_MC_BATCHES,
  RISK_MAX_CHAOS_PER_ITEM,
} from "./batch-law";
import { policyUsesReforge, type Rng } from "./craft-path-sample";
import { modQualityTier } from "./mod-tiers";
import { TABLET_BASES } from "./mod-weights";
import type { FitWeightOverridesOpts } from "./roll-seen-types";
import type { RawSeenAggregate } from "./roll-seen-types";
import type { MarketPriceCache } from "./tablet-ev-calculator";
import {
  solvePolicy,
  type CraftPolicy,
} from "./tablet-mdp";
import {
  fitTargetsFromAggregateCells,
  fitWeightOverridesFromRates,
  type FitRateTarget,
} from "./weight-fitter";
import { drawSideRates } from "./weight-posterior";

export const MIXTURE_D_INTERACTIVE = 50;
export const MIXTURE_D_FULL = 200;
/** Retries per outer draw when IPS fails (extreme Dirichlet mass). */
export const MIXTURE_IPS_RETRIES = 3;
/** Fail mixture (N/A) when successful draws fall below this fraction of D. */
export const MIXTURE_MIN_SUCCESS_FRAC = 0.5;

export interface MixtureRiskInput {
  baseId: string;
  market: MarketPriceCache;
  policy: CraftPolicy;
  craftCountC: number;
  aggregate: RawSeenAggregate;
  /** Interactive 50 / full 200 */
  outerDraws?: number;
  percentile?: number;
  maxChaosPerItem?: number;
  /** Inner MC batches per draw; default 5_000 */
  innerMcBatches?: number;
  trashMode?: FitWeightOverridesOpts["trashMode"];
  trashConstant?: number;
  rng?: Rng;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /**
   * Test / debug: skip Dirichlet and use these override maps as outer draws.
   * Length should equal outerDraws (or outerDraws is taken from length).
   * `null` entries count as failed IPS draws (for success-frac tests).
   */
  fixedDrawOverrides?: Array<Record<string, number> | null>;
  /** Yield to event loop every N draws (default 1). */
  chunkSize?: number;
  /** Keep per-draw BatchLawResult[] (debug; default false). */
  retainInner?: boolean;
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setTimeout === "function") setTimeout(resolve, 0);
    else resolve();
  });
}

/** True when aggregate has any roll mass for this base (cells or sideTrials). */
export function aggregateHasRollMass(
  aggregate: RawSeenAggregate,
  baseId: string,
): boolean {
  if (aggregate.sideTrials.some((s) => s.baseId === baseId && s.sideTrials > 0)) {
    return true;
  }
  return aggregate.cells.some((c) => c.baseId === baseId);
}

/**
 * True when Dirichlet has ≥1 cared (non-Junk) measured category for this base.
 * Junk-only / sideTrials-without-cared → false (mixture would draw identical seeds).
 */
export function aggregateHasCaredMeasured(
  aggregate: RawSeenAggregate,
  baseId: string,
): boolean {
  const base = TABLET_BASES[baseId];
  if (!base) return false;
  return aggregate.cells.some((c) => {
    if (c.baseId !== baseId || !(c.trials > 0)) return false;
    if (modQualityTier(c.modId) === "Junk") return false;
    const pool =
      c.side === "prefix" ? base.allowedPrefixPool : base.allowedSuffixPool;
    return pool.includes(c.modId);
  });
}

/** Convert one Dirichlet (or synthetic) rate draw → IPS weight overrides. */
export function overridesFromRateDraw(
  baseId: string,
  targets: FitRateTarget[],
  opts?: FitWeightOverridesOpts,
): Record<string, number> | null {
  // Empty cared targets → N/A (do not treat {} as a successful mixture draw).
  if (!targets.length) return null;
  const snap = fitWeightOverridesFromRates(baseId, targets, opts);
  if (!snap.converged) return null;
  return snap.weightOverrides;
}

function drawOverridesFromAggregate(
  aggregate: RawSeenAggregate,
  baseId: string,
  rng: Rng,
  fitOpts?: FitWeightOverridesOpts,
): Record<string, number> | null {
  const prefix = drawSideRates(aggregate, baseId, "prefix", rng);
  const suffix = drawSideRates(aggregate, baseId, "suffix", rng);
  if (!prefix && !suffix) {
    return null;
  }
  const targets: FitRateTarget[] = [];
  for (const draw of [prefix, suffix]) {
    if (!draw) continue;
    for (const [modId, rate] of Object.entries(draw.caredRates)) {
      // Synthetic hits/trials for posterior bookkeeping only; IPS uses mleRate.
      const trials = 1000;
      targets.push({
        modId,
        side: draw.side,
        mleRate: rate,
        hits: Math.max(0, Math.round(rate * trials)),
        trials,
      });
    }
  }
  return overridesFromRateDraw(baseId, targets, fitOpts);
}

/**
 * §9 mixture: outer Dirichlet→IPS draws, fixed Y, pool inner MC samples (method A).
 * Async/chunked; cancel via signal (base/knob change).
 * Empty roll-seen / cared-empty mass for baseId → null (except fixedDrawOverrides test hook).
 */
export async function computeMixtureRisk(
  input: MixtureRiskInput,
): Promise<MixtureRiskResult | null> {
  const {
    baseId,
    market,
    policy,
    craftCountC,
    aggregate,
    percentile = 0.95,
    maxChaosPerItem = RISK_MAX_CHAOS_PER_ITEM,
    innerMcBatches = MIXTURE_INNER_MC_BATCHES,
    trashMode = "seed",
    trashConstant,
    rng = Math.random,
    signal,
    onProgress,
    fixedDrawOverrides,
    chunkSize = 1,
    retainInner = false,
  } = input;

  if (policy.blank === "Skip-Blanks") return null;
  const baseCost = market.basePrices[baseId];
  if (!Number.isFinite(baseCost)) return null;

  const D =
    fixedDrawOverrides?.length ??
    input.outerDraws ??
    MIXTURE_D_INTERACTIVE;
  if (!(D > 0)) return null;

  // No roll-seen / no cared measured categories → N/A
  // (do not run D copies of identical seed weights as "uncertainty")
  if (
    !fixedDrawOverrides &&
    (!aggregateHasRollMass(aggregate, baseId) ||
      !aggregateHasCaredMeasured(aggregate, baseId))
  ) {
    return null;
  }

  const fitOpts: FitWeightOverridesOpts = {
    trashMode,
    ...(trashConstant != null ? { trashConstant } : {}),
  };

  const pooledSpend: number[] = [];
  const pooledProfit: number[] = [];
  const whiteEVs: number[] = [];
  const inner: BatchLawResult[] = [];
  let usedDraws = 0;
  let failedDraws = 0;

  for (let d = 0; d < D; d++) {
    if (signal?.aborted) return null;

    let overrides: Record<string, number> | null = null;
    if (fixedDrawOverrides) {
      overrides = fixedDrawOverrides[d] ?? null;
    } else {
      for (let attempt = 0; attempt < MIXTURE_IPS_RETRIES; attempt++) {
        overrides = drawOverridesFromAggregate(aggregate, baseId, rng, fitOpts);
        if (overrides != null) break;
      }
    }

    if (overrides == null) {
      failedDraws++;
      onProgress?.(d + 1, D);
      if ((d + 1) % chunkSize === 0) await yieldToUi();
      continue;
    }

    const law = computeBatchLaw({
      baseId,
      market,
      policy,
      craftCountC,
      percentile,
      weightOverrides: overrides,
      maxChaosPerItem,
      mcBatches: innerMcBatches,
      retainSamples: true,
      rng,
      mode: "mixture-draw",
    });
    if (!law?.spendEx.samples || !law.profitEx.samples) {
      failedDraws++;
      onProgress?.(d + 1, D);
      if ((d + 1) % chunkSize === 0) await yieldToUi();
      continue;
    }

    for (const s of law.spendEx.samples) pooledSpend.push(s);
    for (const p of law.profitEx.samples) pooledProfit.push(p);

    const solved = solvePolicy(market, baseId, policy, {
      runtimeOverrides: overrides,
    });
    if (solved && Number.isFinite(solved.whiteEV)) {
      whiteEVs.push(solved.whiteEV);
    }

    usedDraws++;
    if (retainInner) inner.push(law);

    onProgress?.(d + 1, D);
    if ((d + 1) % chunkSize === 0) await yieldToUi();
  }

  if (signal?.aborted) return null;
  if (!pooledSpend.length || !pooledProfit.length || usedDraws === 0) {
    return null;
  }

  const successFrac = usedDraws / D;
  if (successFrac < MIXTURE_MIN_SUCCESS_FRAC) {
    // Too many IPS/law failures → biased bands; treat as N/A
    return null;
  }

  const zCapEx = empiricalQuantile(pooledSpend, percentile);
  const zProfitEx = empiricalQuantile(pooledProfit, 1 - percentile);
  const evBand: [number, number] = whiteEVs.length
    ? [
        empiricalQuantile(whiteEVs, 0.05),
        empiricalQuantile(whiteEVs, 0.95),
      ]
    : [Number.NaN, Number.NaN];

  const skipNote =
    failedDraws > 0
      ? `IPS/law used ${usedDraws}/${D} outer draws (${failedDraws} skipped after retries)`
      : undefined;

  return {
    baseId,
    policy,
    craftCountC,
    outerDraws: usedDraws,
    outerDrawsRequested: D,
    zCapEx,
    zProfitEx,
    evMeanEx: meanOf(whiteEVs),
    evBand,
    ...(policyUsesReforge(policy) ? { reforgeApprox: true } : {}),
    ...(skipNote ? { note: skipNote } : {}),
    ...(retainInner ? { inner } : { inner: [] }),
  };
}

/** Point-fit overrides from aggregate (helper for D=1≡§3 tests). */
export function pointFitOverridesFromAggregate(
  baseId: string,
  aggregate: RawSeenAggregate,
  opts?: FitWeightOverridesOpts,
): Record<string, number> {
  const cells = aggregate.cells.filter((c) => c.baseId === baseId);
  const targets = fitTargetsFromAggregateCells(baseId, cells);
  const snap = fitWeightOverridesFromRates(baseId, targets, opts);
  return snap.converged ? snap.weightOverrides : {};
}
