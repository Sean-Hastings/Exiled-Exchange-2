import {
  TABLET_BASES,
  modWeightForBase,
  weightOptsForBase,
  type ModWeightOpts,
} from "./mod-weights";
import { countTier } from "./mod-tiers";
import {
  buildRareTierJudgementRegexes,
  type TierJudgementRegex,
} from "./tablet-regex-builder";
import {
  formatSplitStrategy,
  type BlankCraftStrategy,
  type RareDispositionStrategy,
} from "./strat-types";
import type { ParsedTabletItem, ParsedTabletMod } from "./tablet-types";
import {
  dumpFloorEx,
  dumpFloorInfo,
  JUNK_DUMP_FRACTION,
  type MarketPriceSource,
  type PriceSource,
} from "./market-sanity";
import { estimateTabletSellPrice } from "./tablet-sell-estimate";
import type { TabletSellBasis } from "./tablet-sell-estimate";
import type { ModRollPriceCurve } from "./mod-roll-price-curve";
import {
  defaultPolicy,
  expectedUnderDist,
  magicOnePOneSBranchProbs,
  policyToLegacyRare,
  recommendPolicy,
  simulatePolicy,
  solvePolicy,
  type CraftPolicy,
  RARE_TIERS,
  type RareTier,
} from "./tablet-mdp";

export { dumpFloorEx, dumpFloorInfo, JUNK_DUMP_FRACTION };

export interface MarketPriceCache {
  basePrices: Record<string, number>;
  /** All orb costs in **exalted orbs** (PoE2 unit of account). Unmeasured = NaN. */
  currencyCosts: {
    alchemy: number;
    scouring: number;
    /** Exalts per Chaos Orb (measured FX) */
    chaos: number;
    /** Always 1 when using exalt-native pricing */
    exalted: number;
    vaal: number;
    transmute: number;
    augmentation: number;
    regal: number;
  };
  /** Sale price for mod combo `pId+sId`, in exalted — measured trade only */
  modValueMap: Record<string, number>;
  modPremiums?: Record<string, number>;
  /**
   * Dump / junk rare sell floor per base (exalted), from a broad trade sample.
   * Used for unmeasured combo outcomes so sparse premium sync doesn't treat
   * the long tail as worth 0ex (which makes EV ≈ −baseCost).
   */
  junkSellByBase?: Record<string, number>;
  /**
   * Same-side / multi-affix / solo-B sell samples (not stamped onto 1p1s grid).
   * Fed into {@link buildTierSaleTable} via modsToRareTier.
   */
  measuredAffixSamples?: Array<{
    baseId: string;
    modIds: string[];
    sellEx: number;
  }>;
  /**
   * Live S-tier roll→price curves keyed by {@link modRollCurveKey} (`baseId/modId`).
   * EV expand uses `expectedSellEx` (mean over discrete rolls), not a single prong.
   */
  modRollCurves?: Record<string, ModRollPriceCurve>;
  /** Listing anchors in exalted — NaN until measured (no invented bands) */
  listingAnchors?: {
    tradeDivine: number;
    merchantHigh: number;
    merchantMid: number;
    merchantLow: number;
  };
  /** Live FX snapshot */
  fx?: {
    exaltPerChaos: number;
    exaltPerDivine: number;
  };
  /**
   * Provenance for dump/combo values. Missing key ⇒ treat as live measured.
   * Fallback sources (survey / 20% blank / cascaded) must be marked in UI.
   */
  priceSource?: MarketPriceSource;
}

/** @deprecated Prefer blankStrategy + rareStrategy */
export type CraftStrategy =
  | BlankCraftStrategy
  | RareDispositionStrategy
  | "Vaal-Or-Sell"
  | "Exalt-Slam";

export interface PathEV {
  strategy: string;
  /** Net exalt EV for one attempt from that path's starting state */
  netEV: number;
  costPerAttempt: number;
  expectedGross: number;
  roiPercentage: number;
}

/** Trash / mid hit / jackpot slice of a roll or strategy revenue model. */
export type OutcomeKind = "jackpot" | "hit" | "trash";

export interface OutcomeSlice {
  kind: OutcomeKind;
  label: string;
  /** Probability mass 0–1 */
  prob: number;
  /** E[sale | this bucket], exalt */
  avgValueEx: number;
  /** Revenue contribution = prob × avgValueEx */
  revenueEx: number;
  priceSource?: PriceSource;
}

export interface StrategyBreakdown {
  strategy: string;
  path: "blank" | "rare";
  /** Expected *revenue* (gross), exalt — not profit */
  expectedRevenueEx: number;
  /** Currency spent for one attempt (excludes sunk base unless noted) */
  costEx: number;
  netEV: number;
  outcomes: OutcomeSlice[];
  note?: string;
  priceSource?: PriceSource;
}

export interface BaseStrategyExplain {
  baseId: string;
  baseName: string;
  baseCost: number;
  dumpFloorEx: number;
  dumpFloorSource: PriceSource;
  /** Live-combo coverage fraction (diagnostic; not used to blend sales) */
  measuredFrac: number;
  /** One alchemy-rare roll: trash/hit/jackpot over the affix joint */
  rollOutcomes: OutcomeSlice[];
  expectedRollRevenueEx: number;
  blank: StrategyBreakdown[];
  rare: StrategyBreakdown[];
  /** Stash triage: S/A regexes; unmatched → Trash. B unused. */
  tierRegexes: TierJudgementRegex[];
}

export interface TabletEVResult {
  baseId: string;
  baseName: string;
  baseCost: number;
  craftingCostPerRoll: number;
  averageRollsToHitTarget: number;
  expectedGrossValue: number;
  netEV: number;
  roiPercentage: number;
  profitPerHour: number;
  successfulOutcomeProb: number;
  blankStrategy: BlankCraftStrategy;
  rareStrategy: RareDispositionStrategy;
  blankNetEV: number;
  rareNetEV: number;
  blankCandidates: PathEV[];
  rareCandidates: PathEV[];
  recommendedStrategy: string;
}

export type TabletAction =
  | "SELL_AS_IS"
  | "REROLL"
  | "VAAL_SLAM"
  | "REFORGE"
  | "MERCHANT"
  | "EXALT";

export interface TabletItemEvaluation {
  currentMarketPrice: number;
  rareTier: RareTier;
  sellBasis: TabletSellBasis;
  sellDetail: string;
  sellPriceSource: PriceSource;
  action: TabletAction;
  explanation: string;
  baseEV: TabletEVResult;
  rareStrategy: RareDispositionStrategy;
}

/** Realistic manual craft throughput (throughput assumption, not a price seed) */
const ATTEMPTS_PER_HOUR = 60;

function measured(n: number | undefined | null): number {
  return n != null && Number.isFinite(n) ? n : Number.NaN;
}

function comboKey(prefixId: string, suffixId: string): string {
  return `${prefixId}+${suffixId}`;
}

/** Measured combo sale only — never invents from mod score / anchors. */
function estimateComboValue(
  market: MarketPriceCache,
  prefixId: string,
  suffixId: string,
): number {
  const key = comboKey(prefixId, suffixId);
  return measured(market.modValueMap[key]);
}

function emptyAnchors() {
  return {
    tradeDivine: Number.NaN,
    merchantHigh: Number.NaN,
    merchantMid: Number.NaN,
    merchantLow: Number.NaN,
  };
}

function anchors(market: MarketPriceCache) {
  return { ...emptyAnchors(), ...market.listingAnchors };
}

function emptyResult(baseId: string, baseName: string): TabletEVResult {
  const nan = Number.NaN;
  return {
    baseId,
    baseName,
    baseCost: nan,
    craftingCostPerRoll: nan,
    averageRollsToHitTarget: Infinity,
    expectedGrossValue: nan,
    netEV: nan,
    roiPercentage: nan,
    profitPerHour: nan,
    successfulOutcomeProb: 0,
    blankStrategy: "Skip-Blanks",
    rareStrategy: "Dump-Sell",
    blankNetEV: nan,
    rareNetEV: nan,
    blankCandidates: [],
    rareCandidates: [],
    recommendedStrategy: formatSplitStrategy("Skip-Blanks", "Dump-Sell"),
  };
}

function pickBestPath<T extends string>(
  paths: Array<PathEV & { strategy: T }>,
): PathEV & { strategy: T } {
  return paths.reduce((best, cur) => {
    if (!Number.isFinite(cur.netEV)) return best;
    if (!Number.isFinite(best.netEV)) return cur;
    return cur.netEV > best.netEV ? cur : best;
  });
}

/** Best craft EV for display — includes negatives; excludes Skip-Blanks (always 0). */
function pickBestCraftPath<T extends string>(
  paths: Array<PathEV & { strategy: T }>,
  skipStrategy: T,
): (PathEV & { strategy: T }) | null {
  const crafts = paths.filter((p) => p.strategy !== skipStrategy);
  if (!crafts.length) return null;
  const best = pickBestPath(crafts);
  return Number.isFinite(best.netEV) ? best : null;
}

function pathRoi(net: number, cost: number): number {
  if (!Number.isFinite(net) || !Number.isFinite(cost)) return Number.NaN;
  if (cost <= 0) return net > 0 ? Infinity : 0;
  return (net / cost) * 100;
}

export class TabletEVEngine {
  constructor(
    private marketCache: MarketPriceCache,
    private weightOpts?: ModWeightOpts,
  ) {}

  updateMarket(cache: Partial<MarketPriceCache>) {
    this.marketCache = {
      ...this.marketCache,
      ...cache,
      currencyCosts: {
        ...this.marketCache.currencyCosts,
        ...cache.currencyCosts,
      },
      basePrices: {
        ...this.marketCache.basePrices,
        ...cache.basePrices,
      },
      modValueMap: {
        ...this.marketCache.modValueMap,
        ...cache.modValueMap,
      },
      junkSellByBase: {
        ...this.marketCache.junkSellByBase,
        ...cache.junkSellByBase,
      },
      measuredAffixSamples: cache.measuredAffixSamples
        ? [...cache.measuredAffixSamples]
        : this.marketCache.measuredAffixSamples
          ? [...this.marketCache.measuredAffixSamples]
          : undefined,
      modRollCurves: {
        ...this.marketCache.modRollCurves,
        ...cache.modRollCurves,
      },
      listingAnchors: {
        ...anchors(this.marketCache),
        ...cache.listingAnchors,
      },
      priceSource: {
        junkSellByBase: {
          ...this.marketCache.priceSource?.junkSellByBase,
          ...cache.priceSource?.junkSellByBase,
        },
        modValueMap: {
          ...this.marketCache.priceSource?.modValueMap,
          ...cache.priceSource?.modValueMap,
        },
      },
    };
  }

  setWeightOpts(opts?: ModWeightOpts) {
    this.weightOpts = opts;
  }

  public calculateBaseEV(baseId: string): TabletEVResult {
    const base = TABLET_BASES[baseId];
    if (!base) return emptyResult(baseId, baseId);

    const baseCost = measured(this.marketCache.basePrices[baseId]);
    const recommended = recommendPolicy(
      this.marketCache,
      baseId,
      this.weightOpts,
    );

    const blankCandidates: Array<PathEV & { strategy: BlankCraftStrategy }> = [];
    for (const blank of [
      "Skip-Blanks",
      "Scour-Alch",
      "Magic-Pipeline",
    ] as BlankCraftStrategy[]) {
      const rarePolicy = recommended?.policy.rare ?? defaultPolicy().rare;
      const corruptPolicy =
        recommended?.policy.corrupt ?? defaultPolicy().corrupt;
      const hit = solvePolicy(
        this.marketCache,
        baseId,
        {
          blank,
          rare: rarePolicy,
          corrupt: corruptPolicy,
        },
        this.weightOpts,
      );
      if (!hit) continue;
      const orb =
        blank === "Magic-Pipeline"
          ? hit.sales.magicOrbCost
          : blank === "Scour-Alch"
            ? hit.sales.alchOrbCost
            : 0;
      const gross = expectedUnderDist(
        blank === "Magic-Pipeline" ? hit.sales.magicDist : hit.sales.alchDist,
        hit.sales.uncorrupted,
      );
      blankCandidates.push({
        strategy: blank,
        netEV: hit.whiteEV,
        costPerAttempt: orb,
        expectedGross: blank === "Skip-Blanks" ? 0 : gross,
        roiPercentage: pathRoi(
          hit.whiteEV,
          blank === "Skip-Blanks"
            ? 0
            : (Number.isFinite(baseCost) ? baseCost : 0) + orb,
        ),
      });
    }

    const rareCandidates: Array<
      PathEV & { strategy: RareDispositionStrategy }
    > = [];
    const trashActions = [
      ["Chaos", "Chaos-Spam"],
      ["Reforge", "Reforge-3to1"],
      ["List", "Dump-Sell"],
      ["Vaal", "Vaal-Corrupt"],
    ] as const;
    for (const [action, label] of trashActions) {
      const policy: CraftPolicy = {
        blank: "Skip-Blanks",
        rare: { S: "List", A: "List", B: "List", Trash: action },
        corrupt: { S: "List", A: "List", B: "List", Trash: "Dump" },
      };
      const hit = solvePolicy(
        this.marketCache,
        baseId,
        policy,
        this.weightOpts,
      );
      if (!hit) continue;
      rareCandidates.push({
        strategy: label,
        netEV: hit.rareV.Trash,
        costPerAttempt:
          action === "Chaos"
            ? hit.sales.chaosCost
            : action === "Vaal"
              ? hit.sales.vaalCost
              : 0,
        expectedGross: hit.sales.uncorrupted.Trash,
        roiPercentage: pathRoi(hit.rareV.Trash, hit.sales.chaosCost || 1),
      });
    }
    // Merchant-list ≈ list B-tier as-is value
    {
      const hit = solvePolicy(
        this.marketCache,
        baseId,
        defaultPolicy("Skip-Blanks"),
        this.weightOpts,
      );
      if (hit) {
        rareCandidates.push({
          strategy: "Merchant-List",
          netEV: hit.rareV.B,
          costPerAttempt: 0,
          expectedGross: hit.sales.uncorrupted.B,
          roiPercentage: 0,
        });
      }
    }

    const best = recommended;
    const bestCraft = pickBestCraftPath(blankCandidates, "Skip-Blanks");
    const blankStrategy =
      best && Number.isFinite(best.whiteEV) && best.whiteEV > 0
        ? best.policy.blank
        : "Skip-Blanks";
    const rareStrategy = best
      ? policyToLegacyRare(best.policy)
      : "Dump-Sell";
    // Surface craft EV even when recommending Skip (can be negative)
    const blankNetEV =
      blankStrategy === "Skip-Blanks" && bestCraft
        ? bestCraft.netEV
        : (best?.whiteEV ?? Number.NaN);
    const netEV = blankNetEV;
    const costPerRoll =
      bestCraft?.costPerAttempt ?? Number.NaN;

    const rollDist =
      best?.policy.blank === "Magic-Pipeline"
        ? best.sales.magicDist
        : best?.sales.alchDist;
    const pHit = rollDist ? 1 - rollDist.Trash : 0;
    const avgRolls = pHit > 0 ? 1 / pHit : Infinity;
    const expectedGrossValue = bestCraft?.expectedGross ?? Number.NaN;
    const bestRare = pickBestPath(rareCandidates);

    return {
      baseId,
      baseName: base.name,
      baseCost,
      craftingCostPerRoll: costPerRoll,
      averageRollsToHitTarget: Number.isFinite(avgRolls)
        ? Math.round(avgRolls)
        : Infinity,
      expectedGrossValue,
      netEV,
      roiPercentage: pathRoi(
        netEV,
        Number.isFinite(costPerRoll) && Number.isFinite(baseCost)
          ? costPerRoll + baseCost
          : Number.NaN,
      ),
      profitPerHour: Number.isFinite(netEV)
        ? netEV * ATTEMPTS_PER_HOUR
        : Number.NaN,
      successfulOutcomeProb: pHit,
      blankStrategy,
      rareStrategy,
      blankNetEV,
      rareNetEV: bestRare.netEV,
      blankCandidates,
      rareCandidates,
      recommendedStrategy: formatSplitStrategy(blankStrategy, rareStrategy),
    };
  }

  public calculateAllBaseEVs(): TabletEVResult[] {
    return Object.keys(TABLET_BASES)
      .map((id) => this.calculateBaseEV(id))
      .sort((a, b) => {
        const af = Number.isFinite(a.profitPerHour);
        const bf = Number.isFinite(b.profitPerHour);
        if (af && bf) return b.profitPerHour - a.profitPerHour;
        if (af) return -1;
        if (bf) return 1;
        return a.baseName.localeCompare(b.baseName);
      });
  }

  /**
   * Debug / inspection: S/A/Trash rates + sale, and expected *revenue*
   * for blank + rare policies (MDP continuation values).
   */
  public explainStrategies(baseId: string): BaseStrategyExplain {
    const base = TABLET_BASES[baseId];
    if (!base) {
      return {
        baseId,
        baseName: baseId,
        baseCost: Number.NaN,
        dumpFloorEx: Number.NaN,
        dumpFloorSource: "measured",
        measuredFrac: 0,
        rollOutcomes: [],
        expectedRollRevenueEx: Number.NaN,
        blank: [],
        rare: [],
        tierRegexes: [],
      };
    }

    const baseCost = measured(this.marketCache.basePrices[baseId]);
    const dumpInfo = dumpFloorInfo(this.marketCache, baseId, baseCost);
    const dump = dumpInfo.value;
    const recommended = recommendPolicy(
      this.marketCache,
      baseId,
      this.weightOpts,
    );
    const alch = solvePolicy(
      this.marketCache,
      baseId,
      defaultPolicy("Scour-Alch"),
      this.weightOpts,
    );
    const sales = alch?.sales;
    const measuredFrac = sales?.measuredFrac ?? 0;
    const tierKind = (tier: (typeof RARE_TIERS)[number]): OutcomeKind =>
      tier === "S" ? "jackpot" : tier === "A" ? "hit" : "trash";

    const rollOutcomes: OutcomeSlice[] = sales
      ? (() => {
          const merged: Partial<
            Record<"S" | "A" | "Trash", OutcomeSlice>
          > = {};
          for (const tier of RARE_TIERS) {
            const display = tier === "B" ? "Trash" : tier;
            const prob = sales.alchDist[tier];
            const avgValueEx = sales.uncorrupted[tier];
            const revenueEx = prob * avgValueEx;
            const prev = merged[display];
            if (prev) {
              prev.prob += prob;
              prev.revenueEx += revenueEx;
              prev.avgValueEx =
                prev.prob > 0 ? prev.revenueEx / prev.prob : prev.avgValueEx;
            } else {
              merged[display] = {
                kind: tierKind(display),
                label: display + " rare",
                prob,
                avgValueEx,
                revenueEx,
                priceSource:
                  display === "Trash"
                    ? sales.uncorruptedSource.Trash
                    : sales.uncorruptedSource[tier],
              };
            }
          }
          return (["S", "A", "Trash"] as const)
            .map((k) => merged[k])
            .filter((o): o is OutcomeSlice => !!o && o.prob > 1e-9);
        })()
      : [];
    const expectedRollRevenueEx = rollOutcomes.reduce(
      (s, o) => s + o.revenueEx,
      0,
    );

    const blank: StrategyBreakdown[] = [];
    for (const blankStrat of [
      "Skip-Blanks",
      "Scour-Alch",
      "Magic-Pipeline",
    ] as BlankCraftStrategy[]) {
      const rareSide = recommended?.policy.rare ?? defaultPolicy().rare;
      const corruptSide =
        recommended?.policy.corrupt ?? defaultPolicy().corrupt;
      const hit = solvePolicy(
        this.marketCache,
        baseId,
        {
          blank: blankStrat,
          rare: rareSide,
          corrupt: corruptSide,
        },
        this.weightOpts,
      );
      if (!hit) continue;
      const dist =
        blankStrat === "Magic-Pipeline"
          ? hit.sales.magicDist
          : hit.sales.alchDist;
      const outcomes: OutcomeSlice[] =
        blankStrat === "Skip-Blanks"
          ? [
              {
                kind: "trash",
                label: "skip (no craft)",
                prob: 1,
                avgValueEx: 0,
                revenueEx: 0,
              },
            ]
          : RARE_TIERS.map((tier) => {
              const v = hit.rareV[tier];
              return {
                kind: tierKind(tier),
                label:
                  tier +
                  " → V=" +
                  (Number.isFinite(v) ? v.toFixed(0) : "n/a") +
                  "ex",
                prob: dist[tier],
                avgValueEx: hit.sales.uncorrupted[tier],
                revenueEx: dist[tier] * hit.sales.uncorrupted[tier],
                priceSource: hit.sales.uncorruptedSource[tier],
              };
            }).filter((o) => o.prob > 1e-9);
      const orb =
        blankStrat === "Magic-Pipeline"
          ? hit.sales.magicOrbCost
          : blankStrat === "Scour-Alch"
            ? hit.sales.alchOrbCost
            : 0;
      blank.push({
        strategy: blankStrat,
        path: "blank",
        expectedRevenueEx:
          blankStrat === "Skip-Blanks"
            ? 0
            : outcomes.reduce((s, o) => s + o.revenueEx, 0),
        costEx:
          blankStrat === "Skip-Blanks"
            ? 0
            : (Number.isFinite(baseCost) ? baseCost : 0) + orb,
        netEV: hit.whiteEV,
        outcomes,
        note:
          blankStrat === "Skip-Blanks"
            ? "Do not buy/craft whites"
            : "MDP blank→rare{S,A,Trash}; trash=" +
              rareSide.Trash +
              " (closed-form until-hit)",
      });
    }

    const rare: StrategyBreakdown[] = [];
    const actionToLabel = (
      action: "List" | "Chaos" | "Reforge" | "Vaal",
    ): RareDispositionStrategy => {
      if (action === "Chaos") return "Chaos-Spam";
      if (action === "Reforge") return "Reforge-3to1";
      if (action === "Vaal") return "Vaal-Corrupt";
      return "Dump-Sell";
    };
    if (recommended) {
      for (const tier of RARE_TIERS) {
        const best = recommended.policy.rare[tier];
        const list = recommended.sales.uncorrupted[tier];
        const marg = recommended.marginalVsList[tier];
        const outcomes: OutcomeSlice[] = (
          ["List", "Chaos", "Reforge", "Vaal"] as const
        ).map((action) => {
          const m = recommended.actionMarginals[tier][action];
          return {
            kind:
              action === best
                ? tierKind(tier)
                : ("trash" as OutcomeKind),
            label:
              action +
              (action === best ? " ★" : "") +
              " · Δ" +
              (Number.isFinite(m)
                ? (m >= 0 ? "+" : "") + m.toFixed(0)
                : "n/a"),
            prob: action === best ? 1 : 0,
            avgValueEx: Number.isFinite(m) ? m : Number.NaN,
            revenueEx: Number.isFinite(m) ? m : Number.NaN,
          };
        });
        rare.push({
          strategy: `${tier}:${actionToLabel(best)}`,
          path: "rare",
          expectedRevenueEx: list,
          costEx: 0,
          netEV: marg,
          outcomes,
          priceSource: recommended.sales.uncorruptedSource[tier],
          note:
            `${tier} sell-as-is ${Number.isFinite(list) ? list.toFixed(0) : "n/a"}ex` +
            ` · best ${best}` +
            ` · marginal vs sell ${Number.isFinite(marg) ? ((marg >= 0 ? "+" : "") + marg.toFixed(1)) : "n/a"}ex` +
            (tier === "Trash"
              ? " · reforge=⅓ fresh (residual <3 sell at their tier asks)"
              : ""),
        });
      }
    }

    return {
      baseId,
      baseName: base.name,
      baseCost,
      dumpFloorEx: dump,
      dumpFloorSource: dumpInfo.source,
      measuredFrac,
      rollOutcomes,
      expectedRollRevenueEx,
      blank,
      rare,
      tierRegexes: buildRareTierJudgementRegexes(baseId),
    };
  }

  /** Joint affix roll → trash / hit / jackpot slices (probability × value). */
  private rollOutcomeDistribution(baseId: string): {
    slices: OutcomeSlice[];
    expectedRevenue: number;
  } {
    const base = TABLET_BASES[baseId];
    if (!base) return { slices: [], expectedRevenue: Number.NaN };

    const baseCost = measured(this.marketCache.basePrices[baseId]);
    const dumpInfo = dumpFloorInfo(this.marketCache, baseId, baseCost);
    const dump = dumpInfo.value;
    const div = measured(this.marketCache.fx?.exaltPerDivine);
    const jackpotFloor = Number.isFinite(div)
      ? Math.max(div * 0.5, Number.isFinite(dump) ? dump * 8 : 0)
      : Number.isFinite(dump)
        ? dump * 8
        : Number.POSITIVE_INFINITY;

    const totalPrefixWeight = base.allowedPrefixPool.reduce(
      (sum, id) => sum + (modWeightForBase(baseId, id, this.weightOpts)),
      0,
    );
    const totalSuffixWeight = base.allowedSuffixPool.reduce(
      (sum, id) => sum + (modWeightForBase(baseId, id, this.weightOpts)),
      0,
    );

    const acc: Record<
      OutcomeKind,
      { prob: number; valueMass: number; usedDump: boolean; usedSurvey: boolean }
    > = {
      jackpot: { prob: 0, valueMass: 0, usedDump: false, usedSurvey: false },
      hit: { prob: 0, valueMass: 0, usedDump: false, usedSurvey: false },
      trash: { prob: 0, valueMass: 0, usedDump: false, usedSurvey: false },
    };

    if (totalPrefixWeight > 0 && totalSuffixWeight > 0) {
      for (const pId of base.allowedPrefixPool) {
        const pWeight = modWeightForBase(baseId, pId, this.weightOpts);
        if (pWeight <= 0) continue;
        const pProb = pWeight / totalPrefixWeight;
        for (const sId of base.allowedSuffixPool) {
          const sWeight = modWeightForBase(baseId, sId, this.weightOpts);
          if (sWeight <= 0) continue;
          const comboProb = pProb * (sWeight / totalSuffixWeight);
          const measuredSale = estimateComboValue(
            this.marketCache,
            pId,
            sId,
          );
          const sale = Number.isFinite(measuredSale) ? measuredSale : dump;
          if (!Number.isFinite(sale)) continue;

          let kind: OutcomeKind;
          if (
            Number.isFinite(measuredSale) &&
            measuredSale >= jackpotFloor
          ) {
            kind = "jackpot";
          } else if (
            Number.isFinite(measuredSale) &&
            Number.isFinite(dump) &&
            measuredSale > dump * 1.25
          ) {
            kind = "hit";
          } else {
            kind = "trash";
          }
          acc[kind].prob += comboProb;
          acc[kind].valueMass += comboProb * sale;
          if (!Number.isFinite(measuredSale)) acc[kind].usedDump = true;
          else if (
            this.marketCache.priceSource?.modValueMap?.[
              comboKey(pId, sId)
            ] === "manual-survey"
          ) {
            acc[kind].usedSurvey = true;
          }
        }
      }
    }

    const labels: Record<OutcomeKind, string> = {
      jackpot: `jackpot (≥${Number.isFinite(jackpotFloor) ? jackpotFloor.toFixed(0) : "?"}ex)`,
      hit: "hit (measured > dump×1.25)",
      trash: Number.isFinite(dump)
        ? `trash / unmeasured (dump ~${dump.toFixed(0)}ex)`
        : "trash / unmeasured",
    };

    const slices: OutcomeSlice[] = (
      ["jackpot", "hit", "trash"] as OutcomeKind[]
    )
      .map((kind) => {
        const { prob, valueMass, usedDump, usedSurvey } = acc[kind];
        const avgValueEx = prob > 0 ? valueMass / prob : 0;
        const priceSource: PriceSource = usedDump
          ? dumpInfo.source === "fraction-of-base" ||
            dumpInfo.source === "manual-survey"
            ? dumpInfo.source
            : "cascaded"
          : usedSurvey
            ? "manual-survey"
            : "measured";
        return {
          kind,
          label: labels[kind],
          prob,
          avgValueEx,
          revenueEx: valueMass,
          priceSource,
        };
      })
      .filter((s) => s.prob > 0 || s.revenueEx > 0);

    const expectedRevenue = slices.reduce((s, x) => s + x.revenueEx, 0);
    return {
      slices,
      expectedRevenue: slices.length ? expectedRevenue : Number.NaN,
    };
  }

  private magicPipelineOutcomes(
    baseId: string,
    baseCost: number,
    empiricalComboEV: number,
  ): { outcomes: OutcomeSlice[]; note: string } {
    const c = this.marketCache.currencyCosts;
    const alch = measured(c.alchemy);
    const a = anchors(this.marketCache);
    const branch = magicOnePOneSBranchProbs(baseId, this.weightOpts);
    if (
      !branch ||
      !Number.isFinite(a.tradeDivine) ||
      !Number.isFinite(a.merchantHigh) ||
      !Number.isFinite(a.merchantMid) ||
      !Number.isFinite(a.merchantLow) ||
      !Number.isFinite(empiricalComboEV)
    ) {
      return {
        outcomes: [],
        note: "Needs listing anchors (tradeDivine / merchant*) — currently NaN",
      };
    }

    const { pHasS: pMagicHasS, pHasAOnly: pMagicHasAOnly, pJunk: pMagicJunk } =
      branch;

    const divineList = Math.min(
      a.tradeDivine,
      Math.max(empiricalComboEV * 8, a.merchantHigh * 2),
    );
    const merchantHi = Math.min(
      a.merchantHigh,
      Math.max(empiricalComboEV * 3, a.merchantMid),
    );
    const merchantMid = Math.min(
      a.merchantMid,
      Math.max(empiricalComboEV * 1.5, a.merchantLow),
    );
    const merchantLo = Math.min(a.merchantLow, Math.max(empiricalComboEV, 0));
    const reforgeSalvage =
      Number.isFinite(baseCost) && Number.isFinite(alch)
        ? (baseCost + alch) / 3
        : 0;

    let pTrade = pMagicHasS * 0.25;
    let pMerchHi = pMagicHasS * 0.75;
    let pMerchMid = pMagicHasAOnly;
    let pReforge = pMagicJunk * 0.7;
    let pMerchLo = pMagicJunk * 0.3;
    const sum = pTrade + pMerchHi + pMerchMid + pReforge + pMerchLo || 1;
    pTrade /= sum;
    pMerchHi /= sum;
    pMerchMid /= sum;
    pReforge /= sum;
    pMerchLo /= sum;

    const outcomes: OutcomeSlice[] = (
      [
        {
          kind: "jackpot" as const,
          label: "trade list (S-magic)",
          prob: pTrade,
          avgValueEx: divineList,
          revenueEx: pTrade * divineList,
        },
        {
          kind: "hit" as const,
          label: "merchant high (S-magic)",
          prob: pMerchHi,
          avgValueEx: merchantHi,
          revenueEx: pMerchHi * merchantHi,
        },
        {
          kind: "hit" as const,
          label: "merchant mid (A-magic)",
          prob: pMerchMid,
          avgValueEx: merchantMid,
          revenueEx: pMerchMid * merchantMid,
        },
        {
          kind: "trash" as const,
          label: "merchant low (junk magic)",
          prob: pMerchLo,
          avgValueEx: merchantLo,
          revenueEx: pMerchLo * merchantLo,
        },
        {
          kind: "trash" as const,
          label: "reforge salvage (junk)",
          prob: pReforge,
          avgValueEx: reforgeSalvage,
          revenueEx: pReforge * reforgeSalvage,
        },
      ] satisfies OutcomeSlice[]
    ).filter((o) => o.prob > 1e-6);

    return {
      outcomes,
      note: "strat_reco magic→regal/alch branching; anchors required",
    };
  }

  public evaluateCurrentItem(
    parsedTablet: ParsedTabletItem,
  ): TabletItemEvaluation {
    const baseEV = this.calculateBaseEV(parsedTablet.tabletBaseKey);
    const sell = estimateTabletSellPrice(parsedTablet, this.marketCache);
    const currentPrice = sell.sellEx;
    const rareStrategy = baseEV.rareStrategy;
    const modIds = parsedTablet.parsedMods.map((m) => m.id);
    const sCount = countTier(modIds, "S", parsedTablet.tabletBaseKey);
    const aCount = countTier(modIds, "A", parsedTablet.tabletBaseKey);
    const fmt = (n: number) =>
      Number.isFinite(n) ? n.toFixed(2) : "NaN";
    const tierTag = `tier ${sell.rareTier}`;
    const priceTag = `${fmt(currentPrice)}ex (${sell.detail})`;

    const pack = (
      partial: Omit<
        TabletItemEvaluation,
        | "currentMarketPrice"
        | "rareTier"
        | "sellBasis"
        | "sellDetail"
        | "sellPriceSource"
        | "baseEV"
      >,
    ): TabletItemEvaluation => ({
      ...partial,
      currentMarketPrice: currentPrice,
      rareTier: sell.rareTier,
      sellBasis: sell.basis,
      sellDetail: sell.detail,
      sellPriceSource: sell.priceSource,
      baseEV,
    });

    if (parsedTablet.isCorrupted) {
      return pack({
        action: "SELL_AS_IS",
        explanation: `Corrupted ${tierTag} — list as-is ~${priceTag}.`,
        rareStrategy: "Dump-Sell",
      });
    }

    if (sCount >= 2 || (sCount >= 1 && aCount >= 1)) {
      return pack({
        action: "SELL_AS_IS",
        explanation: `S/A synergy (${tierTag}). List ~${priceTag}. (Blanks: ${baseEV.blankStrategy})`,
        rareStrategy: "Merchant-List",
      });
    }

    if (sCount >= 1 || aCount >= 2) {
      return pack({
        action: "MERCHANT",
        explanation: `Solid mid (${tierTag}) — list ~${priceTag}. Rare path default is ${rareStrategy}.`,
        rareStrategy: "Merchant-List",
      });
    }

    const junkThreshold =
      Number.isFinite(baseEV.expectedGrossValue) ||
      Number.isFinite(baseEV.baseCost)
        ? Math.max(
            Number.isFinite(baseEV.expectedGrossValue)
              ? baseEV.expectedGrossValue * 0.5
              : 0,
            Number.isFinite(baseEV.baseCost) ? baseEV.baseCost * 0.5 : 0,
          )
        : Number.NaN;
    if (
      Number.isFinite(currentPrice) &&
      Number.isFinite(junkThreshold) &&
      currentPrice <= junkThreshold
    ) {
      const action = actionForRareStrategy(rareStrategy);
      return pack({
        action,
        explanation: `Junk/under-roll (${tierTag} ~${priceTag}). Rare→${rareStrategy} (${fmt(baseEV.rareNetEV)}ex/attempt). Blanks→${baseEV.blankStrategy}.`,
        rareStrategy,
      });
    }

    if (rareStrategy === "Exalt-Slam" && parsedTablet.parsedMods.length < 4) {
      return pack({
        action: "EXALT",
        explanation: `Mid roll with room to slam (${tierTag} ~${priceTag}). Exalt preferred; blanks still ${baseEV.blankStrategy}.`,
        rareStrategy: "Exalt-Slam",
      });
    }

    return pack({
      action: actionForRareStrategy(rareStrategy),
      explanation: `${tierTag} ~${priceTag}. Rare→${rareStrategy}; Blank→${baseEV.blankStrategy}.`,
      rareStrategy,
    });
  }

  public simulateCrafts(
    baseId: string,
    iterations = 1000,
  ): {
    hits: number;
    hitRate: number;
    averageValue: number;
    netProfit: number;
    avgChaosRolls: number;
    truncated: number;
    policyLabel: string;
  } {
    const recommended = recommendPolicy(
      this.marketCache,
      baseId,
      this.weightOpts,
    );
    const policy =
      recommended?.policy ?? defaultPolicy("Skip-Blanks");
    // Prefer the craft policy even when EV says Skip — sim the best craft path
    // when user clicks Simulate (Skip is boring). Use recommended if +EV else Alch+chaos.
    const simPolicy: CraftPolicy =
      policy.blank !== "Skip-Blanks"
        ? policy
        : defaultPolicy("Scour-Alch");

    const result = simulatePolicy(
      this.marketCache,
      baseId,
      simPolicy,
      iterations,
      weightOptsForBase(baseId, this.weightOpts),
    );
    return {
      ...result,
      policyLabel: formatSplitStrategy(
        simPolicy.blank,
        policyToLegacyRare(simPolicy),
      ),
    };
  }

  private comboStats(baseId: string) {
    const base = TABLET_BASES[baseId]!;
    const baseCost = measured(this.marketCache.basePrices[baseId]);
    const dump = dumpFloorEx(this.marketCache, baseId, baseCost);
    const totalPrefixWeight = base.allowedPrefixPool.reduce(
      (sum, id) => sum + (modWeightForBase(baseId, id, this.weightOpts)),
      0,
    );
    const totalSuffixWeight = base.allowedSuffixPool.reduce(
      (sum, id) => sum + (modWeightForBase(baseId, id, this.weightOpts)),
      0,
    );

    let expectedGrossValue = 0;
    let successfulOutcomeProb = 0;
    let valuedProbMass = 0;

    if (totalPrefixWeight > 0 && totalSuffixWeight > 0) {
      for (const pId of base.allowedPrefixPool) {
        const pWeight = modWeightForBase(baseId, pId, this.weightOpts);
        if (pWeight <= 0) continue;
        const pProb = pWeight / totalPrefixWeight;
        for (const sId of base.allowedSuffixPool) {
          const sWeight = modWeightForBase(baseId, sId, this.weightOpts);
          if (sWeight <= 0) continue;
          const comboProb = pProb * (sWeight / totalSuffixWeight);
          const measuredSale = estimateComboValue(
            this.marketCache,
            pId,
            sId,
          );
          // Unmeasured ≠ 0ex: use dump floor so sparse premium samples don't
          // collapse E[gross] toward 0 and net EV toward −baseCost.
          const sale = Number.isFinite(measuredSale) ? measuredSale : dump;
          if (!Number.isFinite(sale)) continue;
          valuedProbMass += comboProb;
          expectedGrossValue += comboProb * sale;
          if (
            Number.isFinite(measuredSale) &&
            measuredSale > (Number.isFinite(dump) ? dump : 0)
          ) {
            successfulOutcomeProb += comboProb;
          }
        }
      }
    }

    if (valuedProbMass <= 0) expectedGrossValue = Number.NaN;

    const avgRolls =
      successfulOutcomeProb > 0 ? 1 / successfulOutcomeProb : Infinity;
    return { expectedGrossValue, successfulOutcomeProb, avgRolls };
  }

  /**
   * Blank-path EV is always **per white base consumed** (one craft cycle).
   * Never mixes "until first hit" costs with single-roll revenue.
   */
  private evaluateBlankPaths(
    baseId: string,
    baseCost: number,
    expectedGross: number,
  ): Array<PathEV & { strategy: BlankCraftStrategy }> {
    const c = this.marketCache.currencyCosts;
    const alch = measured(c.alchemy);
    const scour = measured(c.scouring);
    const transmute = measured(c.transmute);
    const aug = measured(c.augmentation);
    const regal = measured(c.regal);
    const exalt = measured(c.exalted);
    const a = anchors(this.marketCache);

    // White → Alchemy → rare (one shot). Revenue = E[sale of that rare].
    const alchCost = baseCost + alch + scour;
    const scourAlchNet = expectedGross - alchCost;

    const magic = this.estimateMagicPipeline(
      baseId,
      transmute,
      aug,
      regal,
      alch,
      exalt,
      a,
      baseCost,
      expectedGross,
    );

    const skip: PathEV & { strategy: BlankCraftStrategy } = {
      strategy: "Skip-Blanks",
      netEV: 0,
      costPerAttempt: 0,
      expectedGross: 0,
      roiPercentage: 0,
    };

    const scourAlch: PathEV & { strategy: BlankCraftStrategy } = {
      strategy: "Scour-Alch",
      netEV: scourAlchNet,
      costPerAttempt: alch + scour,
      expectedGross,
      roiPercentage: pathRoi(scourAlchNet, alchCost),
    };

    return [scourAlch, magic, skip];
  }

  /**
   * Magic-Pipeline EV per white. Listing tiers require measured anchors;
   * otherwise netEV stays NaN (visible gap, not invented divines).
   */
  private estimateMagicPipeline(
    baseId: string,
    transmute: number,
    aug: number,
    regal: number,
    alch: number,
    exalt: number,
    a: ReturnType<typeof emptyAnchors>,
    baseCost: number,
    empiricalComboEV: number,
  ): PathEV & { strategy: BlankCraftStrategy } {
    const setup = transmute + aug;
    const branch = magicOnePOneSBranchProbs(baseId, this.weightOpts);
    if (!branch) {
      return {
        strategy: "Magic-Pipeline",
        netEV: -(baseCost + setup),
        costPerAttempt: setup,
        expectedGross: 0,
        roiPercentage: 0,
      };
    }

    const {
      pHasS: pMagicHasS,
      pHasAOnly: pMagicHasAOnly,
      pJunk: pMagicJunk,
      pSMean,
      pAMean,
    } = branch;

    // Cap exalt spend probability — only slam when magic already showed S
    const pExalt = pMagicHasS * Math.min(0.35, pSMean + pAMean);

    const expectedCost =
      baseCost +
      setup +
      pMagicHasS * regal +
      pMagicHasAOnly * regal +
      pMagicJunk * alch +
      pExalt * exalt;

    if (
      !Number.isFinite(a.tradeDivine) ||
      !Number.isFinite(a.merchantHigh) ||
      !Number.isFinite(a.merchantMid) ||
      !Number.isFinite(a.merchantLow) ||
      !Number.isFinite(empiricalComboEV)
    ) {
      return {
        strategy: "Magic-Pipeline",
        netEV: Number.NaN,
        costPerAttempt: setup + regal,
        expectedGross: Number.NaN,
        roiPercentage: Number.NaN,
      };
    }

    const divineList = Math.min(
      a.tradeDivine,
      Math.max(empiricalComboEV * 8, a.merchantHigh * 2),
    );
    const merchantHi = Math.min(
      a.merchantHigh,
      Math.max(empiricalComboEV * 3, a.merchantMid),
    );
    const merchantMid = Math.min(
      a.merchantMid,
      Math.max(empiricalComboEV * 1.5, a.merchantLow),
    );
    const merchantLo = Math.min(a.merchantLow, Math.max(empiricalComboEV, 0));
    const reforgeSalvage = (baseCost + alch) / 3;

    // Outcome probs from strat_reco (re-normalized)
    let pTrade = pMagicHasS * 0.25;
    let pMerchHi = pMagicHasS * 0.75;
    let pMerchMid = pMagicHasAOnly;
    let pReforge = pMagicJunk * 0.7;
    let pMerchLo = pMagicJunk * 0.3;
    const sum = pTrade + pMerchHi + pMerchMid + pReforge + pMerchLo || 1;
    pTrade /= sum;
    pMerchHi /= sum;
    pMerchMid /= sum;
    pReforge /= sum;
    pMerchLo /= sum;

    const expectedGross =
      pTrade * divineList +
      pMerchHi * merchantHi +
      pMerchMid * merchantMid +
      pMerchLo * merchantLo +
      pReforge * reforgeSalvage;

    const netEV = expectedGross - expectedCost;
    return {
      strategy: "Magic-Pipeline",
      netEV,
      costPerAttempt: setup + regal,
      expectedGross,
      roiPercentage: pathRoi(netEV, expectedCost),
    };
  }

  /**
   * Rare-path EV is **per junk rare you already own** (sunk base cost).
   */
  private evaluateRarePaths(
    baseCost: number,
    expectedGross: number,
  ): Array<PathEV & { strategy: RareDispositionStrategy }> {
    const c = this.marketCache.currencyCosts;
    const chaos = measured(c.chaos);
    const exalt = measured(c.exalted);
    const vaal = measured(c.vaal);
    const alch = measured(c.alchemy);

    const chaosNet = expectedGross - chaos;
    const exaltNet = expectedGross * 0.15 + baseCost * 0.1 - exalt;
    const vaalNet =
      0.45 * expectedGross * 1.2 + 0.55 * ((baseCost + alch) / 3) - vaal;
    const merchantNet = Math.min(expectedGross * 0.25, baseCost * 0.3);
    const reforgeNet = expectedGross / 3;
    const dumpNet = Math.min(baseCost * 0.2, expectedGross * 0.1);

    return [
      {
        strategy: "Chaos-Spam",
        netEV: chaosNet,
        costPerAttempt: chaos,
        expectedGross,
        roiPercentage: pathRoi(chaosNet, chaos),
      },
      {
        strategy: "Exalt-Slam",
        netEV: exaltNet,
        costPerAttempt: exalt,
        expectedGross: expectedGross * 0.15,
        roiPercentage: pathRoi(exaltNet, exalt),
      },
      {
        strategy: "Vaal-Corrupt",
        netEV: vaalNet,
        costPerAttempt: vaal,
        expectedGross: expectedGross * 0.6,
        roiPercentage: pathRoi(vaalNet, vaal),
      },
      {
        strategy: "Merchant-List",
        netEV: merchantNet,
        costPerAttempt: 0,
        expectedGross: merchantNet,
        roiPercentage: 0,
      },
      {
        strategy: "Reforge-3to1",
        netEV: reforgeNet,
        costPerAttempt: 0,
        expectedGross: reforgeNet,
        roiPercentage: 0,
      },
      {
        strategy: "Dump-Sell",
        netEV: dumpNet,
        costPerAttempt: 0,
        expectedGross: dumpNet,
        roiPercentage: 0,
      },
    ];
  }

  private lookupCurrentModPrice(mods: ParsedTabletMod[]): number {
    if (!mods.length) return Number.NaN;
    const prefixes = mods.filter((m) => m.isPrefix);
    const suffixes = mods.filter((m) => !m.isPrefix);

    let best = Number.NaN;
    if (prefixes.length && suffixes.length) {
      for (const p of prefixes) {
        for (const s of suffixes) {
          const v = estimateComboValue(this.marketCache, p.id, s.id);
          if (!Number.isFinite(v)) continue;
          best = Number.isFinite(best) ? Math.max(best, v) : v;
        }
      }
    }
    return best;
  }
}

function actionForRareStrategy(strat: RareDispositionStrategy): TabletAction {
  switch (strat) {
    case "Chaos-Spam":
      return "REROLL";
    case "Exalt-Slam":
      return "EXALT";
    case "Vaal-Corrupt":
      return "VAAL_SLAM";
    case "Merchant-List":
      return "MERCHANT";
    case "Reforge-3to1":
      return "REFORGE";
    case "Dump-Sell":
      return "SELL_AS_IS";
  }
}

function scaleOutcomeRevenue(
  slices: OutcomeSlice[],
  factor: number,
  labelSuffix: string,
): OutcomeSlice[] {
  return slices.map((s) => ({
    ...s,
    label: `${s.label} (${labelSuffix})`,
    avgValueEx: s.avgValueEx * factor,
    revenueEx: s.revenueEx * factor,
  }));
}
