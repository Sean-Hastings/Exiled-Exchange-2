/** Schema revision for persisted / exported roll logs. */
export const ROLL_SEEN_REVISION = 1 as const;

export type AffixSide = "prefix" | "suffix";

/** Per-mod hit observation. null hits = unmeasured (not zero). */
export interface ModHitObservation {
  modId: string;
  /** Affix appearances of this mod in the side's trial budget. */
  hits: number | null;
}

/**
 * One experiential sentence / batch entry.
 * UI: "Rolled {affixesPerTablet} affixes × {tablets} tablets;
 *      {mod}: {hits} …"
 */
export interface RollSeenBatch {
  id: string; // uuid
  baseId: string;
  createdAt: number;
  updatedAt: number;
  /** Patch / league tags for IDE analysis (optional). */
  leagueId?: string;
  note?: string;
  affixesPerTablet: number; // default 4
  tablets: number;
  /**
   * Optional explicit trial budgets. If omitted:
   *   totalTrials = affixesPerTablet * tablets
   *   prefixTrials = floor(total/2), suffixTrials = total - prefixTrials
   */
  prefixTrials?: number;
  suffixTrials?: number;
  /** Sparse: only cared non-trash mods the user filled. */
  hits: ModHitObservation[];
}

export interface RollSeenDocument {
  revision: typeof ROLL_SEEN_REVISION;
  updatedAt: number;
  batches: RollSeenBatch[];
}

/** Aggregated raw counts for one (baseId × side × modId). */
export interface RawSeenCell {
  baseId: string;
  side: AffixSide;
  modId: string;
  /** Sum of measured hits across batches that recorded this mod. */
  hits: number;
  /**
   * Sum of side trial budgets from batches where this mod was measured
   * (hits !== null). Batches that left the field empty do not contribute.
   */
  trials: number;
  /** Number of batches that measured this mod. */
  batchCount: number;
}

/** Cumulative side trial budget for one (baseId × side) pool — Dirichlet α_trash. */
export interface SidePoolTrials {
  baseId: string;
  side: AffixSide;
  /**
   * Sum of that side's trial budgets across all batches for this base
   * (every log entry contributes, even if no hits were filled for that side).
   */
  sideTrials: number;
}

export interface RawSeenAggregate {
  revision: typeof ROLL_SEEN_REVISION;
  updatedAt: number;
  cells: RawSeenCell[];
  /** One entry per (baseId × side) that has received any batch contribution. */
  sideTrials: SidePoolTrials[];
}

export type TrashWeightMode = "seed" | "constant";

/** Options for `fitWeightOverridesFromRates` / Apply Fit (defaults: seed, maxIters 200). */
export interface FitWeightOverridesOpts {
  trashMode?: TrashWeightMode;
  trashConstant?: number;
  forceCaredModIds?: string[];
  maxIters?: number;
}

export interface ModPosteriorSummary {
  baseId: string;
  side: AffixSide;
  modId: string;
  /** Beta(α, β) with α = hits + α0, β = (trials - hits) + β0 */
  alpha: number;
  beta: number;
  mean: number; // α/(α+β) — DISPLAY ONLY
  /** Equal-tailed 95% CI on appearance rate (side trial basis). */
  ci95: [number, number];
  trials: number;
  hits: number;
  /** MLE rate hits/trials; fitter target when measured. */
  mleRate: number;
}

export interface FittedWeightSnapshot {
  baseId: string;
  fittedAt: number;
  /** Ready to merge into TabletBaseDefinition.weightOverrides */
  weightOverrides: Record<string, number>;
  /** Trash mode used this fit */
  trashMode: TrashWeightMode;
  /**
   * When trashMode === "constant": the uniform trash weight.
   * When trashMode === "seed": omitted / null (per-id frozen seeds).
   */
  trashWeight?: number | null;
  /** Max abs/rel residual among fitted non-trash mods */
  maxAbsErr: number;
  maxRelErr: number;
  /** false ⇒ do not apply overrides; UI shows residuals only */
  converged: boolean;
  /** Human-readable failure reason when !converged */
  failureReason?: string;
  iterations: number;
  posteriors: ModPosteriorSummary[];
}
