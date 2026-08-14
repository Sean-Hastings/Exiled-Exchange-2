import { modQualityTierForBase } from "./mod-tiers";
import { TABLET_BASES, modWeightForBase } from "./mod-weights";
import type {
  AffixSide,
  FitWeightOverridesOpts,
  FittedWeightSnapshot,
  ModPosteriorSummary,
  TrashWeightMode,
} from "./roll-seen-types";
import { betaPosterior } from "./weight-posterior";

const EPS_MASS = 1e-6;
const EPS_P = 1e-12;
const EPS_W = 1e-9;
const DEFAULT_MAX_ITERS = 200;

/** Appendix B tolerance for cared mods with MLE p̂ > 0. */
export function withinAppBTolerance(
  implied: number,
  mle: number,
): boolean {
  if (!(mle > 0)) return implied <= 0.001;
  const tol = Math.min(0.001, 0.03 * mle);
  return Math.abs(implied - mle) <= tol;
}

export interface FitRateTarget {
  modId: string;
  side: AffixSide;
  /** MLE p̂ = hits/trials (may be 0). */
  mleRate: number;
  hits: number;
  trials: number;
}

/**
 * IPS rate→weight fitter (§3.4).
 * Init from seed weights; trashMode seed (default) freezes Junk at
 * modWeightForBase; unmeasured non-junk held at seed; zero-hit → emit 0.
 */
export function fitWeightOverridesFromRates(
  baseId: string,
  targets: FitRateTarget[],
  opts?: FitWeightOverridesOpts,
): FittedWeightSnapshot {
  const trashMode: TrashWeightMode = opts?.trashMode ?? "seed";
  const maxIters = opts?.maxIters ?? DEFAULT_MAX_ITERS;
  const forceCared = new Set(opts?.forceCaredModIds ?? []);
  const fittedAt = Date.now();
  const base = TABLET_BASES[baseId];

  const empty = (
    extra: Partial<FittedWeightSnapshot>,
  ): FittedWeightSnapshot => ({
    baseId,
    fittedAt,
    weightOverrides: {},
    trashMode,
    trashWeight: trashMode === "constant" ? (opts?.trashConstant ?? null) : null,
    maxAbsErr: Number.POSITIVE_INFINITY,
    maxRelErr: Number.POSITIVE_INFINITY,
    converged: false,
    iterations: 0,
    posteriors: [],
    ...extra,
  });

  if (!base) {
    return empty({ failureReason: "unknown_base" });
  }

  const posteriors: ModPosteriorSummary[] = targets.map((t) => {
    const post = betaPosterior(t.hits, t.trials);
    return {
      baseId,
      side: t.side,
      modId: t.modId,
      alpha: post.alpha,
      beta: post.beta,
      mean: post.mean,
      ci95: post.ci95,
      trials: t.trials,
      hits: t.hits,
      mleRate: t.mleRate,
    };
  });

  // Partition per side
  const sides: AffixSide[] = ["prefix", "suffix"];
  const overrides: Record<string, number> = {};
  let maxAbsErr = 0;
  let maxRelErr = 0;
  let iterations = 0;

  for (const side of sides) {
    const pool =
      side === "prefix" ? base.allowedPrefixPool : base.allowedSuffixPool;
    if (!pool.length) continue;

    const sideTargets = targets.filter((t) => t.side === side);
    const measuredIds = new Set(sideTargets.map((t) => t.modId));

    const cared = sideTargets.filter((t) => {
      if (forceCared.has(t.modId)) return true;
      return (
        modQualityTierForBase(baseId, t.modId) !== "Junk" &&
        Number.isFinite(t.mleRate)
      );
    });

    // Also forceCared that aren't in targets? Spec: forceCared with measured MLE.
    // Only measured finite MLE enter cared set.

    if (!cared.length && trashMode !== "constant") {
      continue;
    }

    const P = cared.reduce((s, t) => s + t.mleRate, 0);
    if (P >= 1 - EPS_MASS) {
      return empty({
        failureReason: "sum_mle_ge_one",
        posteriors,
        maxAbsErr: Number.POSITIVE_INFINITY,
        maxRelErr: Number.POSITIVE_INFINITY,
      });
    }

    const weights = new Map<string, number>();
    for (const id of pool) {
      const isJunk = modQualityTierForBase(baseId, id) === "Junk";
      const isCared = cared.some((t) => t.modId === id);
      if (isJunk) {
        if (trashMode === "constant") {
          const tc = opts?.trashConstant;
          weights.set(
            id,
            tc != null && Number.isFinite(tc) ? Math.max(0, tc) : 1200,
          );
        } else {
          weights.set(id, modWeightForBase(baseId, id));
        }
      } else if (isCared) {
        // Init from seed — NOT ∝ p̂
        weights.set(id, modWeightForBase(baseId, id));
      } else {
        // Unmeasured non-junk: hold seed
        weights.set(id, modWeightForBase(baseId, id));
      }
    }

    const mleById = new Map(cared.map((t) => [t.modId, t.mleRate] as const));
    let convergedSide = cared.length === 0;
    let iters = 0;

    for (; iters < maxIters; iters++) {
      let W = 0;
      for (const id of pool) W += weights.get(id) ?? 0;
      if (!(W > 0)) break;

      let ok = true;
      for (const t of cared) {
        const w = weights.get(t.modId) ?? 0;
        const implied = w / W;
        const mle = t.mleRate;
        if (!withinAppBTolerance(implied, mle)) ok = false;

        if (mle > 0) {
          if (implied > EPS_P) {
            weights.set(t.modId, w * (mle / implied));
          }
        } else {
          // Drive toward 0 with floor during IPS
          const next = Math.max(EPS_W, w * 0.1);
          weights.set(t.modId, next);
        }
      }

      // Re-freeze trash + unmeasured after cared scale
      for (const id of pool) {
        const isJunk = modQualityTierForBase(baseId, id) === "Junk";
        const isCared = mleById.has(id);
        if (isJunk) {
          if (trashMode === "constant") {
            const tc = opts?.trashConstant;
            weights.set(
              id,
              tc != null && Number.isFinite(tc) ? Math.max(0, tc) : 1200,
            );
          } else {
            weights.set(id, modWeightForBase(baseId, id));
          }
        } else if (!isCared) {
          weights.set(id, modWeightForBase(baseId, id));
        }
      }

      if (ok) {
        convergedSide = true;
        iters += 1;
        break;
      }
    }

    iterations = Math.max(iterations, iters);

    if (!convergedSide) {
      // Residuals for diagnostics
      let W = 0;
      for (const id of pool) W += weights.get(id) ?? 0;
      for (const t of cared) {
        const implied = (weights.get(t.modId) ?? 0) / (W || 1);
        const abs = Math.abs(implied - t.mleRate);
        const rel = t.mleRate > 0 ? abs / t.mleRate : abs;
        maxAbsErr = Math.max(maxAbsErr, abs);
        maxRelErr = Math.max(maxRelErr, rel);
      }
      return {
        baseId,
        fittedAt,
        weightOverrides: {},
        trashMode,
        trashWeight:
          trashMode === "constant" ? (opts?.trashConstant ?? null) : null,
        maxAbsErr,
        maxRelErr,
        converged: false,
        failureReason: "max_iters",
        iterations,
        posteriors,
      };
    }

    // Emit overrides for cared that differ / zero-hit
    let W = 0;
    for (const id of pool) W += weights.get(id) ?? 0;
    for (const t of cared) {
      const mle = t.mleRate;
      let w = weights.get(t.modId) ?? 0;
      if (mle === 0) {
        w = 0; // emit 0, not EPS_W
      }
      const seed = modWeightForBase(baseId, t.modId);
      if (mle === 0 || Math.abs(w - seed) > 1e-9) {
        overrides[t.modId] = w;
      }
      const implied = mle === 0 ? 0 : w / (W || 1);
      const abs = Math.abs(implied - mle);
      const rel = mle > 0 ? abs / mle : abs;
      maxAbsErr = Math.max(maxAbsErr, abs);
      maxRelErr = Math.max(maxRelErr, rel);
    }

    if (trashMode === "constant" && opts?.trashConstant != null) {
      for (const id of pool) {
        if (modQualityTierForBase(baseId, id) === "Junk") {
          overrides[id] = opts.trashConstant;
        }
      }
    }

    void measuredIds;
  }

  return {
    baseId,
    fittedAt,
    weightOverrides: overrides,
    trashMode,
    trashWeight:
      trashMode === "constant" ? (opts?.trashConstant ?? null) : null,
    maxAbsErr,
    maxRelErr,
    converged: true,
    iterations,
    posteriors,
  };
}

/** Build FitRateTarget[] from aggregate cells for one base (MLE targets). */
export function fitTargetsFromAggregateCells(
  baseId: string,
  cells: Array<{
    baseId: string;
    side: AffixSide;
    modId: string;
    hits: number;
    trials: number;
  }>,
): FitRateTarget[] {
  return cells
    .filter((c) => c.baseId === baseId && c.trials > 0)
    .map((c) => ({
      modId: c.modId,
      side: c.side,
      mleRate: c.hits / c.trials,
      hits: c.hits,
      trials: c.trials,
    }));
}
