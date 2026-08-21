/**
 * §3.8 tier uncertainty ranking — which mods are least sure to tier.
 */
import { TABLET_BASES, TABLET_MOD_WEIGHTS } from "./mod-weights";
import {
  hasExplicitTier,
  hasSessionModTier,
  modQualityTierForBase,
  tierRank,
} from "./mod-tiers";
import type { ModQualityTier } from "./strat-types";
import type { MarketPriceCache } from "./tablet-ev-calculator";
import type { TierSurveyDocument } from "./tier-survey-types";

export interface TierUncertaintyReasons {
  noExplicitTier: boolean;
  notSaleTouching: boolean;
  valueScoreFallback: boolean;
  noAutoSurvey: boolean;
}

export interface TierUncertaintyRow {
  modId: string;
  name: string;
  side: "prefix" | "suffix";
  tier: ModQualityTier;
  score: number;
  reasons: TierUncertaintyReasons;
  /** Session-set tier via uncertainty panel (hasSessionModTier). */
  isMarked: boolean;
}

/** Sort: marked first (tier high→low), then unmarked (score high→low). */
export function compareTierUncertaintyRows(
  a: TierUncertaintyRow,
  b: TierUncertaintyRow,
): number {
  if (a.isMarked !== b.isMarked) return a.isMarked ? -1 : 1;
  if (a.isMarked) {
    const tierDiff = tierRank(b.tier) - tierRank(a.tier);
    if (tierDiff !== 0) return tierDiff;
    return a.modId.localeCompare(b.modId);
  }
  if (b.score !== a.score) return b.score - a.score;
  return a.modId.localeCompare(b.modId);
}

/**
 * saleTouching(m): true if any modValueMap key (split on '+') has m as an
 * exact token, or listingAnchors (when present) mention m.
 * When `baseId` is set, only keys whose tokens all lie in that base's pools count
 * (shared mod ids from other bases' combos do not falsely touch).
 */
export function saleTouching(
  modId: string,
  market: MarketPriceCache,
  baseId?: string,
): boolean {
  const pools =
    baseId && TABLET_BASES[baseId]
      ? new Set([
          ...TABLET_BASES[baseId]!.allowedPrefixPool,
          ...TABLET_BASES[baseId]!.allowedSuffixPool,
        ])
      : null;

  for (const key of Object.keys(market.modValueMap ?? {})) {
    const tokens = key.split("+");
    if (!tokens.includes(modId)) continue;
    if (pools && !tokens.every((t) => pools.has(t))) continue;
    return true;
  }
  const anchors = market.listingAnchors as
    | Record<string, unknown>
    | undefined;
  if (!anchors) return false;
  for (const v of Object.values(anchors)) {
    if (v === modId) return true;
    if (Array.isArray(v) && v.some((x) => x === modId)) return true;
    if (
      v &&
      typeof v === "object" &&
      "modId" in v &&
      (v as { modId: unknown }).modId === modId
    ) {
      return true;
    }
  }
  return false;
}

/** True if automated Breach / tier-survey-* doc has an observation for m. */
export function hasAutoSurveyObservation(
  modId: string,
  survey?: TierSurveyDocument | null,
): boolean {
  if (!survey?.observations) return false;
  const keys = Object.keys(survey.observations);
  if (keys.includes(`single:${modId}`)) return true;
  for (const key of keys) {
    // combo / pair keys often embed mod ids
    if (key === modId) return true;
    const parts = key.split(/[:|+]/);
    if (parts.includes(modId)) return true;
  }
  return false;
}

/**
 * Ordinal uncertainty score (§3.8) — not a calibrated probability.
 * Session-set tiers count as explicit for ranking so the panel updates live.
 */
export function tierUncertaintyScore(
  modId: string,
  market: MarketPriceCache,
  survey?: TierSurveyDocument | null,
  baseId?: string,
): { score: number; reasons: TierUncertaintyReasons } {
  const explicit =
    hasExplicitTier(modId, baseId) || hasSessionModTier(modId, baseId);
  const touching = saleTouching(modId, market, baseId);
  // valueScore fallback ≡ no explicit map entry (session still "fallback" for
  // the third bit until committed — but we treat session as resolved above).
  const valueScoreFallback =
    !hasExplicitTier(modId, baseId) && !hasSessionModTier(modId, baseId);
  const noAuto = !hasAutoSurveyObservation(modId, survey);

  const reasons: TierUncertaintyReasons = {
    noExplicitTier: !explicit,
    notSaleTouching: !touching,
    valueScoreFallback,
    noAutoSurvey: noAuto,
  };

  const score =
    2 * (reasons.noExplicitTier ? 1 : 0) +
    2 * (reasons.notSaleTouching ? 1 : 0) +
    1 * (reasons.valueScoreFallback ? 1 : 0) +
    1 * (reasons.noAutoSurvey ? 1 : 0);

  return { score, reasons };
}

export function rankTierUncertainty(
  baseId: string,
  market: MarketPriceCache,
  survey?: TierSurveyDocument | null,
): TierUncertaintyRow[] {
  const base = TABLET_BASES[baseId];
  if (!base) return [];

  const rows: TierUncertaintyRow[] = [];
  const push = (modId: string, side: "prefix" | "suffix") => {
    const { score, reasons } = tierUncertaintyScore(
      modId,
      market,
      survey,
      baseId,
    );
    const def = TABLET_MOD_WEIGHTS[modId];
    rows.push({
      modId,
      name: def?.name ?? modId,
      side,
      tier: modQualityTierForBase(baseId, modId),
      score,
      reasons,
      isMarked: hasSessionModTier(modId, baseId),
    });
  };

  for (const id of base.allowedPrefixPool) push(id, "prefix");
  for (const id of base.allowedSuffixPool) push(id, "suffix");

  rows.sort(compareTierUncertaintyRows);
  return rows;
}
