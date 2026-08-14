/**
 * Tablet craft MDP: blank → rare{S,A,B,Trash} → optional corrupt ladder.
 *
 * Infinite-horizon actions (chaos-until-hit, reforge loops) are solved as a
 * linear system — never by unbounded simulation.
 *
 * Chaos = PoE2 one-affix replace (random slot → new mod from that side's
 * pool). Reforge still uses a full alchemy-style 2p+2s redraw.
 */
import {
  TABLET_BASES,
  modWeightForBase,
  tabletWeightFingerprint,
  type ModWeightOpts,
} from "./mod-weights";
import {
  SIDE_SCORE,
  classifyModCombo,
  comboScoreToRareTier,
  modQualityTierForBase,
  type SidePattern,
} from "./mod-tiers";
import type { ModQualityTier } from "./strat-types";
import type {
  BlankCraftStrategy,
  RareDispositionStrategy,
} from "./strat-types";
import type { MarketPriceCache } from "./tablet-ev-calculator";
import { dumpFloorInfo, type PriceSource } from "./market-sanity";

export type RareTier = "S" | "A" | "B" | "Trash";

export const RARE_TIERS: RareTier[] = ["S", "A", "B", "Trash"];

export type RareAction = "List" | "Chaos" | "Reforge" | "Vaal";
/**
 * PoE2 Reforging Bench rejects corrupted items — no corrupt→reforge edge.
 * Corrupt ladder is list (keep) or dump only.
 */
export type CorruptAction = "List" | "Dump";

export interface CraftPolicy {
  blank: BlankCraftStrategy;
  /** Action to take in each uncorrupted rare tier */
  rare: Record<RareTier, RareAction>;
  /** Action once corrupted */
  corrupt: Record<RareTier, CorruptAction>;
}

export interface TierSaleTable {
  uncorrupted: Record<RareTier, number>;
  corrupted: Record<RareTier, number>;
  /** P(tier) from a fresh alchemy-style affix roll */
  alchDist: Record<RareTier, number>;
  /** P(tier) from magic-pipeline → rare */
  magicDist: Record<RareTier, number>;
  /**
   * One-affix chaos: P(to | from). Averaged over weighted 2p+2s configs in
   * `from`, then uniform slot pick + weighted replacement on that side.
   */
  chaosFrom: Record<RareTier, Record<RareTier, number>>;
  /**
   * Fraction of 1p×1s pair mass with a live combo sync (diagnostic only).
   * Not used to blend tier sale prices — junk mass is already in alchDist.
   */
  measuredFrac: number;
  /** Expected orb costs for magic blank (excl. base) */
  magicOrbCost: number;
  alchOrbCost: number;
  chaosCost: number;
  vaalCost: number;
  baseCost: number;
  /**
   * Junk-tier calibration floor when Trash has no measured asks (seed only).
   * Sell-as-is for any tier uses uncorrupted/corrupted[tier], never this alone.
   */
  dumpFloor: number;
  dumpFloorSource: PriceSource;
  uncorruptedSource: Record<RareTier, PriceSource>;
}

export interface TierSlice {
  tier: RareTier;
  prob: number;
  saleEx: number;
  revenueEx: number;
}

export interface MdpSolveResult {
  policy: CraftPolicy;
  /** EV from owning one white (Skip → 0) */
  whiteEV: number;
  /** Continuation value of each rare tier (post-craft, before/at decision) */
  rareV: Record<RareTier, number>;
  corruptV: Record<RareTier, number>;
  /**
   * rareV[t] − immediate sell-as-is at tier t (uncorrupted[t]). That baseline
   * is 0 in the UI; positive = worth rerolling vs listing that tier's ask.
   * Not a global junk-dump constant — B uses B's sale, Trash uses Trash's, etc.
   */
  marginalVsList: Record<RareTier, number>;
  /** Per-tier one-step marginal for each action (vs sell-as-is), under optimal V. */
  actionMarginals: Record<RareTier, Record<RareAction, number>>;
  /** Tiers where optimal action ≠ List (reroll-worthy mass). */
  rerollWorthy: RareTier[];
  sales: TierSaleTable;
  /** Blank transition revenue pieces */
  blankOutcomes: TierSlice[];
  note?: string;
}

export const RARE_ACTIONS: RareAction[] = ["List", "Chaos", "Reforge", "Vaal"];

/**
 * Immediate sell-as-is proceeds for a rare tier (that tier's list/ask).
 * Never substitutes a global dump floor for a better-tier sale.
 */
export function listSaleEx(sales: TierSaleTable, tier: RareTier): number {
  return sales.uncorrupted[tier];
}

/** Corrupted sell-as-is at this tier (corrupt ask) — not junk-floor clamped. */
export function corruptSaleEx(sales: TierSaleTable, tier: RareTier): number {
  return sales.corrupted[tier];
}

/**
 * One-step action value using continuation V for next rare/corrupt states.
 * Reforge uses the asymptotic 3→1 share (dump residual &lt;3 in a finite batch).
 */
export function qRareAction(
  sales: TierSaleTable,
  tier: RareTier,
  action: RareAction,
  rareV: Record<RareTier, number>,
  corruptV: Record<RareTier, number>,
): number {
  if (action === "List") return listSaleEx(sales, tier);
  if (action === "Chaos") {
    let s = -sales.chaosCost;
    const dist = sales.chaosFrom[tier];
    for (const t2 of RARE_TIERS) {
      const v = rareV[t2];
      if (!Number.isFinite(v) && dist[t2] > 0) return v;
      s += dist[t2] * (Number.isFinite(v) ? v : 0);
    }
    return s;
  }
  if (action === "Reforge") {
    let s = 0;
    for (const t2 of RARE_TIERS) {
      const v = rareV[t2];
      if (!Number.isFinite(v) && sales.alchDist[t2] > 0) return v;
      s += sales.alchDist[t2] * (Number.isFinite(v) ? v : 0);
    }
    return s / 3;
  }
  const cv = corruptV[tier];
  if (!Number.isFinite(cv)) return cv;
  return -sales.vaalCost + cv;
}

function defaultCorruptPolicy(): CraftPolicy["corrupt"] {
  return { S: "List", A: "List", B: "List", Trash: "Dump" };
}

function emptyActionMarginals(): Record<RareAction, number> {
  return { List: 0, Chaos: Number.NaN, Reforge: Number.NaN, Vaal: Number.NaN };
}

function measured(n: number | undefined | null): number {
  return n != null && Number.isFinite(n) ? n : Number.NaN;
}

function emptyDist(): Record<RareTier, number> {
  return { S: 0, A: 0, B: 0, Trash: 0 };
}

/** Map mod-quality junk label → MDP Trash. */
export function qualityToRareTier(q: ModQualityTier): RareTier {
  if (q === "Junk") return "Trash";
  return q;
}

/**
 * Classify a rare by full affix set (prefix side × suffix side), not max(mod).
 * See classifyModCombo / strat_reco divine vs merchant bands.
 * Pass baseId for Temple (and future) quality overlays.
 */
export function modsToRareTier(modIds: string[], baseId?: string): RareTier {
  return classifyModCombo(modIds, baseId).rareTier;
}

/**
 * Policy iteration over rare actions (all tiers). List/dump is always an
 * option; Chaos/Reforge/Vaal win a tier only when their Q beats list sale.
 */
export function solveOptimalRarePolicy(sales: TierSaleTable): {
  rare: CraftPolicy["rare"];
  corrupt: CraftPolicy["corrupt"];
  rareV: Record<RareTier, number>;
  corruptV: Record<RareTier, number>;
  marginalVsList: Record<RareTier, number>;
  actionMarginals: Record<RareTier, Record<RareAction, number>>;
  rerollWorthy: RareTier[];
  note?: string;
} {
  const corrupt = defaultCorruptPolicy();
  let rare: CraftPolicy["rare"] = {
    S: "List",
    A: "List",
    B: "List",
    Trash: "List",
  };

  let rareV = emptyDist() as Record<RareTier, number>;
  let corruptV = emptyDist() as Record<RareTier, number>;
  let note: string | undefined;

  for (let iter = 0; iter < 24; iter++) {
    const solved = solveRareValues(sales, {
      blank: "Skip-Blanks",
      rare,
      corrupt,
    });
    rareV = solved.rareV;
    corruptV = solved.corruptV;
    note = solved.note;

    let changed = false;
    const next = { ...rare };
    for (const tier of RARE_TIERS) {
      let best: RareAction = "List";
      let bestQ = qRareAction(sales, tier, "List", rareV, corruptV);
      for (const action of RARE_ACTIONS) {
        if (action === "List") continue;
        const q = qRareAction(sales, tier, action, rareV, corruptV);
        if (Number.isFinite(q) && (!Number.isFinite(bestQ) || q > bestQ + 1e-9)) {
          bestQ = q;
          best = action;
        }
      }
      if (next[tier] !== best) {
        next[tier] = best;
        changed = true;
      }
    }
    rare = next;
    if (!changed) break;
  }

  const final = solveRareValues(sales, {
    blank: "Skip-Blanks",
    rare,
    corrupt,
  });
  rareV = final.rareV;
  corruptV = final.corruptV;
  note = final.note ?? note;

  const marginalVsList = emptyDist() as Record<RareTier, number>;
  const actionMarginals = {
    S: emptyActionMarginals(),
    A: emptyActionMarginals(),
    B: emptyActionMarginals(),
    Trash: emptyActionMarginals(),
  } as Record<RareTier, Record<RareAction, number>>;
  const rerollWorthy: RareTier[] = [];

  for (const tier of RARE_TIERS) {
    const list = listSaleEx(sales, tier);
    const v = rareV[tier];
    marginalVsList[tier] =
      Number.isFinite(v) && Number.isFinite(list) ? v - list : v;
    for (const action of RARE_ACTIONS) {
      const q = qRareAction(sales, tier, action, rareV, corruptV);
      actionMarginals[tier][action] =
        Number.isFinite(q) && Number.isFinite(list) ? q - list : q;
    }
    if (rare[tier] !== "List") rerollWorthy.push(tier);
  }

  return {
    rare,
    corrupt,
    rareV,
    corruptV,
    marginalVsList,
    actionMarginals,
    rerollWorthy,
    note,
  };
}

/**
 * Default "sensible" policy: list S/A/B, chaos trash (until hit), list corrupt.
 * Prefer {@link solveOptimalRarePolicy} for recommendations.
 */
export function defaultPolicy(blank: BlankCraftStrategy = "Scour-Alch"): CraftPolicy {
  return {
    blank,
    rare: {
      S: "List",
      A: "List",
      B: "List",
      Trash: "Chaos",
    },
    corrupt: defaultCorruptPolicy(),
  };
}

/** Blank strategies to score once rare actions are optimized per tier. */
export function candidateBlankStrategies(): BlankCraftStrategy[] {
  return ["Skip-Blanks", "Scour-Alch", "Magic-Pipeline"];
}

/** @deprecated Prefer solveOptimalRarePolicy + candidateBlankStrategies */
export function candidatePolicies(): CraftPolicy[] {
  const out: CraftPolicy[] = [];
  for (const blank of candidateBlankStrategies()) {
    out.push(defaultPolicy(blank));
    if (blank === "Skip-Blanks") continue;
    for (const trash of RARE_ACTIONS) {
      out.push({
        blank,
        rare: { S: "List", A: "List", B: "List", Trash: trash },
        corrupt: defaultCorruptPolicy(),
      });
    }
  }
  return out;
}

/**
 * Unordered distinct pairs drawn without replacement (weighted).
 * Used for rare 2-prefix / 2-suffix rolls.
 */
function weightedUnorderedPairs(
  baseId: string,
  pool: string[],
  wOpts?: ModWeightOpts,
): Array<{ a: string; b: string; prob: number }> {
  const items = pool
    .map((id) => ({ id, w: modWeightForBase(baseId, id, wOpts) }))
    .filter((x) => x.w > 0);
  const W = items.reduce((s, x) => s + x.w, 0);
  if (W <= 0 || items.length < 2) return [];
  const out: Array<{ a: string; b: string; prob: number }> = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const wi = items[i].w;
      const wj = items[j].w;
      const p =
        (wi / W) * (wj / (W - wi)) + (wj / W) * (wi / (W - wj));
      out.push({ a: items[i].id, b: items[j].id, prob: p });
    }
  }
  const sum = out.reduce((s, x) => s + x.prob, 0);
  if (sum > 0) {
    for (const x of out) x.prob /= sum;
  }
  return out;
}

/** Full rare: 2 prefixes + 2 suffixes → tier distribution. */
function accumulateRare2p2sDist(
  baseId: string,
  onTier: (tier: RareTier, prob: number) => void,
  wOpts?: ModWeightOpts,
) {
  const base = TABLET_BASES[baseId];
  if (!base) return;
  const prefPairs = weightedUnorderedPairs(
    baseId,
    base.allowedPrefixPool,
    wOpts,
  );
  const sufPairs = weightedUnorderedPairs(
    baseId,
    base.allowedSuffixPool,
    wOpts,
  );
  if (!prefPairs.length || !sufPairs.length) {
    // Degenerate tiny pools: fall back to 1p+1s
    const totalP = base.allowedPrefixPool.reduce(
      (s, id) => s + modWeightForBase(baseId, id, wOpts),
      0,
    );
    const totalS = base.allowedSuffixPool.reduce(
      (s, id) => s + modWeightForBase(baseId, id, wOpts),
      0,
    );
    if (totalP <= 0 || totalS <= 0) return;
    for (const pId of base.allowedPrefixPool) {
      const pw = modWeightForBase(baseId, pId, wOpts);
      if (pw <= 0) continue;
      for (const sId of base.allowedSuffixPool) {
        const sw = modWeightForBase(baseId, sId, wOpts);
        if (sw <= 0) continue;
        onTier(
          modsToRareTier([pId, sId], baseId),
          (pw / totalP) * (sw / totalS),
        );
      }
    }
    return;
  }
  for (const pp of prefPairs) {
    for (const sp of sufPairs) {
      onTier(
        modsToRareTier([pp.a, pp.b, sp.a, sp.b], baseId),
        pp.prob * sp.prob,
      );
    }
  }
}

function emptyChaosFrom(): Record<RareTier, Record<RareTier, number>> {
  return {
    S: emptyDist(),
    A: emptyDist(),
    B: emptyDist(),
    Trash: emptyDist(),
  };
}

/** Identity transition (stay in tier) — unused / zero-mass from-states. */
function identityChaosFrom(): Record<RareTier, Record<RareTier, number>> {
  const out = emptyChaosFrom();
  for (const t of RARE_TIERS) out[t][t] = 1;
  return out;
}

const QUALITY_TIERS: ModQualityTier[] = ["S", "A", "B", "Junk"];

function sideFromQualities(
  q1: ModQualityTier,
  q2: ModQualityTier | null,
): SidePattern {
  const mods: ModQualityTier[] = q2 == null ? [q1] : [q1, q2];
  let nS = 0;
  let nA = 0;
  let nB = 0;
  for (const q of mods) {
    if (q === "S") nS++;
    else if (q === "A") nA++;
    else if (q === "B") nB++;
  }
  if (nS >= 2) return "SS";
  if (nS >= 1 && nA >= 1) return "SA";
  if (nS >= 1) return "S";
  if (nA >= 2) return "AA";
  if (nA >= 1) return "A";
  if (nB >= 1) return "B";
  return "Empty";
}

function rareTierFromSides(
  prefQs: ModQualityTier[],
  sufQs: ModQualityTier[],
  baseId?: string,
): RareTier {
  const p = sideFromQualities(prefQs[0]!, prefQs[1] ?? null);
  const s = sideFromQualities(sufQs[0]!, sufQs[1] ?? null);
  let score = SIDE_SCORE[p] + SIDE_SCORE[s];
  const pS = prefQs.filter((q) => q === "S").length;
  const pA = prefQs.filter((q) => q === "A").length;
  const sS = sufQs.filter((q) => q === "S").length;
  const sA = sufQs.filter((q) => q === "A").length;
  if (pS >= 1 && sS >= 1) score += 25;
  else if ((pS >= 1 && sA >= 1) || (sS >= 1 && pA >= 1)) score += 20;
  else if (pA >= 1 && sA >= 1) score += 20;
  const tier = comboScoreToRareTier(score);
  // Temple: after overlay the only S is crystal — any S quality → rareTier S.
  if (
    baseId === "temple_tablet" &&
    (pS >= 1 || sS >= 1)
  ) {
    return "S";
  }
  return tier;
}

/**
 * Weighted mass of replacement mods by quality tier (remaining side-mate excluded).
 */
function chaosReplacementByQuality(
  baseId: string,
  pool: string[],
  keepId: string,
  wOpts?: ModWeightOpts,
): Record<ModQualityTier, number> {
  const out: Record<ModQualityTier, number> = {
    S: 0,
    A: 0,
    B: 0,
    Junk: 0,
  };
  for (const id of pool) {
    if (id === keepId) continue;
    const w = modWeightForBase(baseId, id, wOpts);
    if (w > 0) out[modQualityTierForBase(baseId, id)] += w;
  }
  return out;
}

const chaosFromCache = new Map<
  string,
  Record<RareTier, Record<RareTier, number>>
>();

/** Test/debug: drop memoized one-affix chaos matrices. */
export function clearChaosTransitionCache() {
  chaosFromCache.clear();
}

/**
 * Magic T+A = one prefix + one suffix from separate pools (independent rolls).
 * Returns branch probs for strat_reco regal/alch routing.
 */
export function magicOnePOneSBranchProbs(
  baseId: string,
  wOpts?: ModWeightOpts,
): {
  pHasS: number;
  pHasAOnly: number;
  pJunk: number;
  /** Mean single-side S share (prefix+suffix)/2 — for exalt caps etc. */
  pSMean: number;
  pAMean: number;
} | null {
  const base = TABLET_BASES[baseId];
  if (!base) return null;

  const sideShares = (pool: string[]) => {
    const shares: Record<ModQualityTier, number> = {
      S: 0,
      A: 0,
      B: 0,
      Junk: 0,
    };
    let W = 0;
    for (const id of pool) {
      const w = modWeightForBase(baseId, id, wOpts);
      if (w <= 0) continue;
      W += w;
      shares[modQualityTierForBase(baseId, id)] += w;
    }
    if (!(W > 0)) return null;
    for (const q of QUALITY_TIERS) shares[q] /= W;
    return shares;
  };

  const p = sideShares(base.allowedPrefixPool);
  const s = sideShares(base.allowedSuffixPool);
  if (!p || !s) return null;

  const pNoS_p = 1 - p.S;
  const pNoS_s = 1 - s.S;
  const pHasS = 1 - pNoS_p * pNoS_s;
  const pBJunk_p = p.B + p.Junk;
  const pBJunk_s = s.B + s.Junk;
  // P(no S on either side ∧ at least one A)
  const pHasAOnly = Math.max(0, pNoS_p * pNoS_s - pBJunk_p * pBJunk_s);
  const pJunk = Math.max(0, 1 - pHasS - pHasAOnly);
  return {
    pHasS,
    pHasAOnly,
    pJunk,
    pSMean: (p.S + s.S) / 2,
    pAMean: (p.A + s.A) / 2,
  };
}

/**
 * PoE2 Chaos Orb: pick one of 4 affixes uniformly, replace from that side's
 * pool. Tier transitions are averaged over the weighted 2p+2s mass in each
 * from-tier (MDP state is tier-only).
 *
 * Replacement outcomes are bucketed by mod quality (same quality → same
 * rare tier), so we never enumerate every pool id per slot.
 *
 * Cache key: `(baseId, weightFingerprint)` so runtime / mixture overrides
 * do not collide with the committed point path.
 */
export function buildChaosOneAffixTransitions(
  baseId: string,
  wOpts?: ModWeightOpts,
): Record<RareTier, Record<RareTier, number>> {
  const fp = tabletWeightFingerprint(baseId, wOpts);
  const cacheKey = `${baseId}::${fp}`;
  const cached = chaosFromCache.get(cacheKey);
  if (cached) return cached;

  const base = TABLET_BASES[baseId];
  if (!base) return identityChaosFrom();

  const prefPairs = weightedUnorderedPairs(
    baseId,
    base.allowedPrefixPool,
    wOpts,
  );
  const sufPairs = weightedUnorderedPairs(
    baseId,
    base.allowedSuffixPool,
    wOpts,
  );
  const accum = emptyChaosFrom();
  const massFrom = emptyDist();

  const addSlot = (
    from: RareTier,
    configProb: number,
    slotProb: number,
    keepId: string,
    pool: string[],
    applyQuality: (q: ModQualityTier) => RareTier,
  ) => {
    const byQ = chaosReplacementByQuality(baseId, pool, keepId, wOpts);
    const W = QUALITY_TIERS.reduce((s, q) => s + byQ[q], 0);
    if (!(W > 0)) return;
    const share = configProb * slotProb;
    massFrom[from] += share;
    for (const q of QUALITY_TIERS) {
      const w = byQ[q];
      if (!(w > 0)) continue;
      accum[from][applyQuality(q)] += share * (w / W);
    }
  };

  if (!prefPairs.length || !sufPairs.length) {
    const totalP = base.allowedPrefixPool.reduce(
      (s, id) => s + modWeightForBase(baseId, id, wOpts),
      0,
    );
    const totalS = base.allowedSuffixPool.reduce(
      (s, id) => s + modWeightForBase(baseId, id, wOpts),
      0,
    );
    if (!(totalP > 0 && totalS > 0)) {
      const id = identityChaosFrom();
      chaosFromCache.set(cacheKey, id);
      return id;
    }

    for (const pId of base.allowedPrefixPool) {
      const pw = modWeightForBase(baseId, pId, wOpts);
      if (pw <= 0) continue;
      const pQ = modQualityTierForBase(baseId, pId);
      for (const sId of base.allowedSuffixPool) {
        const sw = modWeightForBase(baseId, sId, wOpts);
        if (sw <= 0) continue;
        const sQ = modQualityTierForBase(baseId, sId);
        const configProb = (pw / totalP) * (sw / totalS);
        const from = rareTierFromSides([pQ], [sQ], baseId);
        addSlot(from, configProb, 0.5, "", base.allowedPrefixPool, (nq) =>
          rareTierFromSides([nq], [sQ], baseId),
        );
        addSlot(from, configProb, 0.5, "", base.allowedSuffixPool, (nq) =>
          rareTierFromSides([pQ], [nq], baseId),
        );
      }
    }
  } else {
    const slot = 0.25;
    const qOf = (id: string) => modQualityTierForBase(baseId, id);
    for (const pp of prefPairs) {
      const pq0 = qOf(pp.a);
      const pq1 = qOf(pp.b);
      for (const sp of sufPairs) {
        const sq0 = qOf(sp.a);
        const sq1 = qOf(sp.b);
        const configProb = pp.prob * sp.prob;
        const from = rareTierFromSides([pq0, pq1], [sq0, sq1], baseId);
        addSlot(from, configProb, slot, pp.b, base.allowedPrefixPool, (nq) =>
          rareTierFromSides([nq, pq1], [sq0, sq1], baseId),
        );
        addSlot(from, configProb, slot, pp.a, base.allowedPrefixPool, (nq) =>
          rareTierFromSides([pq0, nq], [sq0, sq1], baseId),
        );
        addSlot(from, configProb, slot, sp.b, base.allowedSuffixPool, (nq) =>
          rareTierFromSides([pq0, pq1], [nq, sq1], baseId),
        );
        addSlot(from, configProb, slot, sp.a, base.allowedSuffixPool, (nq) =>
          rareTierFromSides([pq0, pq1], [sq0, nq], baseId),
        );
      }
    }
  }

  const out = emptyChaosFrom();
  for (const from of RARE_TIERS) {
    const m = massFrom[from];
    if (!(m > 1e-15)) {
      out[from][from] = 1;
      continue;
    }
    for (const to of RARE_TIERS) {
      out[from][to] = accum[from][to] / m;
    }
  }
  chaosFromCache.set(cacheKey, out);
  return out;
}

/**
 * Sync coverage + per-tier sale samples from 1p+1s combo keys (what trade sync
 * actually fetches). Coverage mass is probability-weighted over the 1p×1s grid.
 */
function accumulateMeasuredPairSales(
  baseId: string,
  market: MarketPriceCache,
  onMeasured: (
    tier: RareTier,
    prob: number,
    sale: number,
    source: PriceSource,
  ) => void,
  wOpts?: ModWeightOpts,
): { globalMeasuredProb: number; globalProb: number } {
  const base = TABLET_BASES[baseId];
  let globalMeasuredProb = 0;
  let globalProb = 0;
  if (!base) return { globalMeasuredProb, globalProb };

  const totalP = base.allowedPrefixPool.reduce(
    (s, id) => s + modWeightForBase(baseId, id, wOpts),
    0,
  );
  const totalS = base.allowedSuffixPool.reduce(
    (s, id) => s + modWeightForBase(baseId, id, wOpts),
    0,
  );
  if (totalP <= 0 || totalS <= 0) return { globalMeasuredProb, globalProb };

  for (const pId of base.allowedPrefixPool) {
    const pw = modWeightForBase(baseId, pId, wOpts);
    if (pw <= 0) continue;
    const pProb = pw / totalP;
    for (const sId of base.allowedSuffixPool) {
      const sw = modWeightForBase(baseId, sId, wOpts);
      if (sw <= 0) continue;
      const prob = pProb * (sw / totalS);
      globalProb += prob;
      const tier = modsToRareTier([pId, sId], baseId);
      const key = `${pId}+${sId}`;
      const sale = measured(market.modValueMap[key]);
      if (Number.isFinite(sale)) {
        globalMeasuredProb += prob;
        onMeasured(
          tier,
          prob,
          sale,
          market.priceSource?.modValueMap?.[key] ?? "measured",
        );
      }
    }
  }
  return { globalMeasuredProb, globalProb };
}

/** Low end of measured sales in a tier (min) — aligns with sell@floor logic. */
function measuredLowEnd(sales: number[]): number {
  if (!sales.length) return Number.NaN;
  let min = sales[0];
  for (let i = 1; i < sales.length; i++) {
    if (sales[i] < min) min = sales[i];
  }
  return min;
}

/**
 * Tier sale prices without global dump-dilution.
 *
 * Junk is already priced via P(Trash) in the roll dist — blending every measured
 * jackpot with (1−g)·dump double-counted the filler pool (g→0 as pools grew).
 *
 * Rules:
 * 1. Measured tier → min(measured combo sells) (sell-floor / low-end)
 * 2. Unmeasured tier → inherit the next-worse priced tier (cascade up from dump)
 * 3. Pull-down monotone S≥A≥B≥Trash: when coverage ranks invert (S cheap, A hot),
 *    deflate the hotter lower tier (underest), never invent dump×N premiums
 */
export function priceTiersFromMeasured(
  measuredSales: Record<RareTier, number[]>,
  dump: number,
): Record<RareTier, number> {
  const raw: Record<RareTier, number> = {
    S: measuredLowEnd(measuredSales.S),
    A: measuredLowEnd(measuredSales.A),
    B: measuredLowEnd(measuredSales.B),
    Trash: measuredLowEnd(measuredSales.Trash),
  };

  const out = emptyDist() as Record<RareTier, number>;
  const dumpOk = Number.isFinite(dump);

  // Cascade up: unmeasured better tiers inherit the worse tier's price
  out.Trash = Number.isFinite(raw.Trash)
    ? raw.Trash
    : dumpOk
      ? dump
      : Number.NaN;
  // BENCH: B inherits Trash when unmeasured (OK for now). Reconsider later —
  // whether B should keep a distinct mid-band seed instead of trash cascade.
  out.B = Number.isFinite(raw.B) ? raw.B : out.Trash;
  out.A = Number.isFinite(raw.A) ? raw.A : out.B;
  out.S = Number.isFinite(raw.S) ? raw.S : out.A;

  // Monotone underest: never let a worse tier outprice a better one
  if (Number.isFinite(out.S) && out.A > out.S) out.A = out.S;
  if (Number.isFinite(out.A) && out.B > out.A) out.B = out.A;
  if (Number.isFinite(out.B) && out.Trash > out.B) out.Trash = out.B;

  return out;
}

function sourceAtLowEnd(
  sales: number[],
  sources: PriceSource[],
): PriceSource {
  if (!sales.length) return "measured";
  let min = sales[0];
  let src: PriceSource = sources[0] ?? "measured";
  for (let i = 1; i < sales.length; i++) {
    const s = sources[i] ?? "measured";
    if (sales[i] < min) {
      min = sales[i];
      src = s;
    } else if (sales[i] === min && s === "manual-survey") {
      src = "manual-survey";
    }
  }
  return src;
}

function priceTierSourcesFromMeasured(
  measuredSales: Record<RareTier, number[]>,
  saleSources: Record<RareTier, PriceSource[]>,
  dump: number,
  dumpSource: PriceSource,
): Record<RareTier, PriceSource> {
  const dumpOk = Number.isFinite(dump);
  const has = (t: RareTier) => measuredSales[t].length > 0;
  const own = (t: RareTier) =>
    sourceAtLowEnd(measuredSales[t], saleSources[t]);

  let trash: PriceSource;
  if (has("Trash")) {
    trash = own("Trash");
  } else if (dumpOk) {
    trash =
      dumpSource === "fraction-of-base" || dumpSource === "manual-survey"
        ? dumpSource
        : "cascaded";
  } else {
    trash = "measured";
  }

  const inherited = dumpOk || has("Trash") || has("B") || has("A");
  const b: PriceSource = has("B")
    ? own("B")
    : dumpOk || has("Trash")
      ? "cascaded"
      : "measured";
  const a: PriceSource = has("A")
    ? own("A")
    : dumpOk || has("Trash") || has("B")
      ? "cascaded"
      : "measured";
  const s: PriceSource = has("S")
    ? own("S")
    : inherited
      ? "cascaded"
      : "measured";

  return { S: s, A: a, B: b, Trash: trash };
}

/**
 * Build sale + transition tables from market + affix weights.
 *
 * Tier sale prices use measured low-ends (and monotone cascade) — not global
 * dump dilution. Affix rolls are full rares: 2 prefixes + 2 suffixes; craft
 * decisions stay tier-label based.
 */
export function buildTierSaleTable(
  market: MarketPriceCache,
  baseId: string,
  opts?: ModWeightOpts,
): TierSaleTable | null {
  const base = TABLET_BASES[baseId];
  if (!base) return null;

  const baseCost = measured(market.basePrices[baseId]);
  const dumpInfo = dumpFloorInfo(market, baseId, baseCost);
  const dump = dumpInfo.value;
  const c = market.currencyCosts;
  const alchOrbCost = measured(c.alchemy);
  const chaosCost = measured(c.chaos);
  const vaalCost = measured(c.vaal);
  const transmute = measured(c.transmute);
  const aug = measured(c.augmentation);
  const regal = measured(c.regal);

  const alchDist = emptyDist();
  accumulateRare2p2sDist(
    baseId,
    (tier, prob) => {
      alchDist[tier] += prob;
    },
    opts,
  );
  const chaosFrom = buildChaosOneAffixTransitions(baseId, opts);

  const measuredSales: Record<RareTier, number[]> = {
    S: [],
    A: [],
    B: [],
    Trash: [],
  };
  const measuredSaleSources: Record<RareTier, PriceSource[]> = {
    S: [],
    A: [],
    B: [],
    Trash: [],
  };

  const { globalMeasuredProb, globalProb } = accumulateMeasuredPairSales(
    baseId,
    market,
    (tier, _prob, sale, source) => {
      measuredSales[tier].push(sale);
      measuredSaleSources[tier].push(source);
    },
    opts,
  );

  // Same-side / multi / solo-B samples → tier measured sales (alongside 1p1s)
  for (const sample of market.measuredAffixSamples ?? []) {
    if (sample.baseId !== baseId) continue;
    if (!Number.isFinite(sample.sellEx) || sample.sellEx <= 0) continue;
    if (!sample.modIds?.length) continue;
    const tier = modsToRareTier(sample.modIds, baseId);
    measuredSales[tier].push(sample.sellEx);
    measuredSaleSources[tier].push("measured");
  }

  const measuredFrac =
    globalProb > 0 ? Math.min(1, globalMeasuredProb / globalProb) : 0;

  const uncorrupted = priceTiersFromMeasured(measuredSales, dump);
  const uncorruptedSource = priceTierSourcesFromMeasured(
    measuredSales,
    measuredSaleSources,
    dump,
    dumpInfo.source,
  );

  // Corrupt book unmeasured — haircut uncorrupted (same structure, still underest)
  const CORRUPT_MULT = 0.85;
  const corrupted = emptyDist() as Record<RareTier, number>;
  for (const t of RARE_TIERS) {
    corrupted[t] = Number.isFinite(uncorrupted[t])
      ? uncorrupted[t] * CORRUPT_MULT
      : Number.NaN;
  }

  // Magic-pipeline → rare tier dist (T+A = 1 prefix + 1 suffix, separate pools)
  let magicDist = emptyDist();
  let magicOrbCost = Number.NaN;
  const magicBranch = magicOnePOneSBranchProbs(baseId, opts);
  if (magicBranch) {
    const { pHasS, pHasAOnly, pJunk } = magicBranch;

    const regalS: Record<RareTier, number> = {
      S: 0.55,
      A: 0.3,
      B: 0.1,
      Trash: 0.05,
    };
    const regalA: Record<RareTier, number> = {
      S: 0.1,
      A: 0.45,
      B: 0.3,
      Trash: 0.15,
    };
    for (const t of RARE_TIERS) {
      magicDist[t] =
        pHasS * regalS[t] + pHasAOnly * regalA[t] + pJunk * alchDist[t];
    }
    const sum = RARE_TIERS.reduce((s, t) => s + magicDist[t], 0) || 1;
    for (const t of RARE_TIERS) magicDist[t] /= sum;

    const regalSpend =
      (pHasS + pHasAOnly) * regal + pJunk * alchOrbCost;
    magicOrbCost =
      Number.isFinite(transmute) &&
      Number.isFinite(aug) &&
      Number.isFinite(regalSpend)
        ? transmute + aug + regalSpend
        : Number.NaN;
  } else {
    magicDist = { ...alchDist };
  }

  return {
    uncorrupted,
    corrupted,
    alchDist,
    magicDist,
    chaosFrom,
    measuredFrac,
    magicOrbCost,
    alchOrbCost,
    chaosCost,
    vaalCost,
    baseCost,
    dumpFloor: dump,
    dumpFloorSource: dumpInfo.source,
    uncorruptedSource,
  };
}

type StateId =
  | `R:${RareTier}`
  | `C:${RareTier}`;

const STATE_IDS: StateId[] = [
  ...RARE_TIERS.map((t) => `R:${t}` as StateId),
  ...RARE_TIERS.map((t) => `C:${t}` as StateId),
];

/**
 * Solve continuation values under a fixed rare/corrupt policy.
 * Linear system; singular “never exits” → -Infinity for those states.
 */
export function solveRareValues(
  sales: TierSaleTable,
  policy: CraftPolicy,
): {
  rareV: Record<RareTier, number>;
  corruptV: Record<RareTier, number>;
  note?: string;
} {
  const idx = new Map<StateId, number>();
  STATE_IDS.forEach((id, i) => idx.set(id, i));
  const n = STATE_IDS.length;
  // A x = b  for unknowns; absorbing List/Dump bake into b and zero row
  const A: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  const b: number[] = Array(n).fill(0);

  const reforgeDist = sales.alchDist; // reforge = full rare redraw

  for (const tier of RARE_TIERS) {
    const i = idx.get(`R:${tier}`)!;
    const action = policy.rare[tier];
    if (action === "List") {
      A[i][i] = 1;
      b[i] = sales.uncorrupted[tier];
    } else if (action === "Vaal") {
      // V_R = -vaal + V_C(same tier)
      A[i][i] = 1;
      const j = idx.get(`C:${tier}`)!;
      A[i][j] = -1;
      b[i] = -sales.vaalCost;
    } else if (action === "Chaos") {
      // One-affix replace: V = -chaos + Σ P(to|from) V_to
      const dist = sales.chaosFrom[tier];
      A[i][i] = 1;
      b[i] = -sales.chaosCost;
      for (const t2 of RARE_TIERS) {
        const j = idx.get(`R:${t2}`)!;
        A[i][j] -= dist[t2];
      }
    } else if (action === "Reforge") {
      // One trash's share of 3→1: V = (1/3) Σ P_t V_R_t
      A[i][i] = 1;
      b[i] = 0;
      for (const t2 of RARE_TIERS) {
        const j = idx.get(`R:${t2}`)!;
        A[i][j] -= reforgeDist[t2] / 3;
      }
    }
  }

  for (const tier of RARE_TIERS) {
    const i = idx.get(`C:${tier}`)!;
    A[i][i] = 1;
    // Corrupt List/Dump both realize this tier's ask — never a flat junk floor.
    b[i] = corruptSaleEx(sales, tier);
  }

  const x = solveLinear(A, b);
  const rareV = emptyDist() as Record<RareTier, number>;
  const corruptV = emptyDist() as Record<RareTier, number>;
  let note: string | undefined;

  if (!x) {
    note = "Singular policy (no exit from a loop) — EV → −∞";
    for (const t of RARE_TIERS) {
      rareV[t] = Number.NEGATIVE_INFINITY;
      corruptV[t] = sales.corrupted[t];
    }
    return { rareV, corruptV, note };
  }

  for (const t of RARE_TIERS) {
    rareV[t] = x[idx.get(`R:${t}`)!]!;
    corruptV[t] = x[idx.get(`C:${t}`)!]!;
  }
  return { rareV, corruptV };
}

/** Gaussian elimination with partial pivot; null if singular / non-finite. */
function solveLinear(A0: number[][], b0: number[]): number[] | null {
  const n = b0.length;
  const M = A0.map((row, i) => [...row, b0[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(M[pivot]![col]!) < 1e-12) return null;
    if (pivot !== col) {
      const tmp = M[col]!;
      M[col] = M[pivot]!;
      M[pivot] = tmp;
    }
    const div = M[col]![col]!;
    for (let c = col; c <= n; c++) M[col]![c]! /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]!;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  const x = M.map((row) => row[n]!);
  if (x.some((v) => !Number.isFinite(v))) return null;
  return x;
}

export function expectedUnderDist(
  dist: Record<RareTier, number>,
  values: Record<RareTier, number>,
): number {
  let s = 0;
  for (const t of RARE_TIERS) {
    const v = values[t];
    if (!Number.isFinite(v) && dist[t] > 0) return v; // ±Inf
    s += dist[t] * (Number.isFinite(v) ? v : 0);
  }
  return s;
}

export function solvePolicy(
  market: MarketPriceCache,
  baseId: string,
  policy: CraftPolicy,
  wOpts?: ModWeightOpts,
): MdpSolveResult | null {
  const sales = buildTierSaleTable(market, baseId, wOpts);
  if (!sales) return null;

  const { rareV, corruptV, note } = solveRareValues(sales, policy);

  const actionMarginals = {
    S: emptyActionMarginals(),
    A: emptyActionMarginals(),
    B: emptyActionMarginals(),
    Trash: emptyActionMarginals(),
  } as Record<RareTier, Record<RareAction, number>>;
  const marginalVsList = emptyDist() as Record<RareTier, number>;
  const rerollWorthy: RareTier[] = [];
  for (const tier of RARE_TIERS) {
    const list = listSaleEx(sales, tier);
    const v = rareV[tier];
    marginalVsList[tier] =
      Number.isFinite(v) && Number.isFinite(list) ? v - list : v;
    for (const action of RARE_ACTIONS) {
      const q = qRareAction(sales, tier, action, rareV, corruptV);
      actionMarginals[tier][action] =
        Number.isFinite(q) && Number.isFinite(list) ? q - list : q;
    }
    if (policy.rare[tier] !== "List") rerollWorthy.push(tier);
  }

  const dist =
    policy.blank === "Magic-Pipeline" ? sales.magicDist : sales.alchDist;
  const blankOutcomes: TierSlice[] = RARE_TIERS.map((tier) => ({
    tier,
    prob: dist[tier],
    saleEx: sales.uncorrupted[tier],
    revenueEx: dist[tier] * sales.uncorrupted[tier],
  })).filter((s) => s.prob > 1e-9);

  let whiteEV = 0;
  if (policy.blank === "Skip-Blanks") {
    whiteEV = 0;
  } else {
    const cont = expectedUnderDist(dist, rareV);
    const orb =
      policy.blank === "Magic-Pipeline"
        ? sales.magicOrbCost
        : sales.alchOrbCost;
    const base = sales.baseCost;
    if (!Number.isFinite(cont)) whiteEV = cont;
    else if (!Number.isFinite(orb) || !Number.isFinite(base))
      whiteEV = Number.NaN;
    else whiteEV = cont - base - orb;
  }

  return {
    policy,
    whiteEV,
    rareV,
    corruptV,
    marginalVsList,
    actionMarginals,
    rerollWorthy,
    sales,
    blankOutcomes,
    note,
  };
}

/**
 * Optimize rare actions per tier (marginal vs sell-as-is at that tier), then
 * pick the best blank strategy under that rare policy.
 */
export function recommendPolicy(
  market: MarketPriceCache,
  baseId: string,
  wOpts?: ModWeightOpts,
): MdpSolveResult | null {
  const sales = buildTierSaleTable(market, baseId, wOpts);
  if (!sales) return null;

  const opt = solveOptimalRarePolicy(sales);
  let best: MdpSolveResult | null = null;
  for (const blank of candidateBlankStrategies()) {
    const hit = solvePolicy(
      market,
      baseId,
      {
        blank,
        rare: opt.rare,
        corrupt: opt.corrupt,
      },
      wOpts,
    );
    if (!hit) continue;
    if (!Number.isFinite(hit.whiteEV) && blank !== "Skip-Blanks") continue;
    if (!best) {
      best = hit;
      continue;
    }
    const bv = best.whiteEV;
    const cv = hit.whiteEV;
    if (!Number.isFinite(bv) && Number.isFinite(cv)) best = hit;
    else if (Number.isFinite(bv) && Number.isFinite(cv) && cv > bv) best = hit;
  }
  if (!best) {
    return solvePolicy(market, baseId, {
      blank: "Skip-Blanks",
      rare: opt.rare,
      corrupt: opt.corrupt,
    });
  }
  // Prefer optimal rare solve's marginal tables (same rare policy)
  return {
    ...best,
    marginalVsList: opt.marginalVsList,
    actionMarginals: opt.actionMarginals,
    rerollWorthy: opt.rerollWorthy,
    note: [best.note, opt.note].filter(Boolean).join(" · ") || undefined,
  };
}

/** Map MDP rare trash action → legacy rare strategy label for UI. */
export function policyToLegacyRare(
  policy: CraftPolicy,
): RareDispositionStrategy {
  switch (policy.rare.Trash) {
    case "Chaos":
      return "Chaos-Spam";
    case "Reforge":
      return "Reforge-3to1";
    case "Vaal":
      return "Vaal-Corrupt";
    case "List":
      return "Dump-Sell";
  }
}

export function simulatePolicy(
  market: MarketPriceCache,
  baseId: string,
  policy: CraftPolicy,
  iterations = 1000,
  opts?: { maxChaosPerItem?: number; runtimeOverrides?: Record<string, number> },
): {
  hits: number;
  hitRate: number;
  averageValue: number;
  netProfit: number;
  avgChaosRolls: number;
  truncated: number;
} {
  const wOpts: ModWeightOpts | undefined = opts?.runtimeOverrides
    ? { runtimeOverrides: opts.runtimeOverrides }
    : undefined;
  const sales = buildTierSaleTable(market, baseId, wOpts);
  if (!sales || policy.blank === "Skip-Blanks") {
    return {
      hits: 0,
      hitRate: 0,
      averageValue: 0,
      netProfit: 0,
      avgChaosRolls: 0,
      truncated: 0,
    };
  }

  const maxChaos = opts?.maxChaosPerItem ?? 10_000;
  const dist =
    policy.blank === "Magic-Pipeline" ? sales.magicDist : sales.alchDist;
  const orbCost =
    policy.blank === "Magic-Pipeline"
      ? sales.magicOrbCost
      : sales.alchOrbCost;
  const baseCost = sales.baseCost;

  const pickTier = (d: Record<RareTier, number>): RareTier => {
    let r = Math.random();
    for (const t of RARE_TIERS) {
      r -= d[t];
      if (r <= 0) return t;
    }
    return "Trash";
  };

  let hits = 0;
  let valueSum = 0;
  let costSum = 0;
  let chaosRolls = 0;
  let truncated = 0;

  for (let i = 0; i < iterations; i++) {
    let cost =
      (Number.isFinite(baseCost) ? baseCost : 0) +
      (Number.isFinite(orbCost) ? orbCost : 0);
    let tier = pickTier(dist);
    let corrupted = false;
    let rolls = 0;
    let done = false;
    let sale = 0;

    while (!done) {
      if (!corrupted) {
        const action = policy.rare[tier];
        if (action === "List") {
          sale = sales.uncorrupted[tier];
          if (tier !== "Trash") hits++;
          done = true;
        } else if (action === "Chaos") {
          cost += Number.isFinite(sales.chaosCost) ? sales.chaosCost : 0;
          rolls++;
          chaosRolls++;
          if (rolls >= maxChaos) {
            truncated++;
            sale = sales.uncorrupted[tier];
            done = true;
          } else {
            tier = pickTier(sales.chaosFrom[tier]);
          }
        } else if (action === "Reforge") {
          // Approximate one item's share: pay nothing, redraw once at 1/3 value path
          // Sim: every 3rd reforge "succeeds" as a fresh rare — here per-item: redraw once
          tier = pickTier(sales.alchDist);
          // Only count 1/3 of resulting sale to this item
          const action2 = policy.rare[tier];
          if (action2 === "List" || tier !== "Trash") {
            sale = sales.uncorrupted[tier] / 3;
            if (tier !== "Trash") hits++;
            done = true;
          } else {
            // Nested trash→reforge: take dump/3 to avoid long chains in MC
            sale = sales.uncorrupted.Trash / 3;
            done = true;
          }
        } else if (action === "Vaal") {
          cost += Number.isFinite(sales.vaalCost) ? sales.vaalCost : 0;
          corrupted = true;
        }
      } else {
        const action = policy.corrupt[tier];
        if (action === "List") sale = sales.corrupted[tier];
        else sale = corruptSaleEx(sales, tier);
        if (tier !== "Trash") hits++;
        done = true;
      }
    }

    valueSum += sale;
    costSum += cost;
  }

  return {
    hits,
    hitRate: iterations > 0 ? hits / iterations : 0,
    averageValue: iterations > 0 ? valueSum / iterations : 0,
    netProfit: valueSum - costSum,
    avgChaosRolls: iterations > 0 ? chaosRolls / iterations : 0,
    truncated,
  };
}
