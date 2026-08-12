/**
 * Tablet craft MDP: blank → rare{S,A,B,Trash} → optional corrupt ladder.
 *
 * Infinite-horizon actions (chaos-until-hit, reforge loops) are solved as a
 * linear system — never by unbounded simulation.
 */
import { TABLET_BASES, TABLET_MOD_WEIGHTS } from "./mod-weights";
import { classifyModCombo, modQualityTier } from "./mod-tiers";
import type { ModQualityTier } from "./strat-types";
import type {
  BlankCraftStrategy,
  RareDispositionStrategy,
} from "./strat-types";
import type { MarketPriceCache } from "./tablet-ev-calculator";
import { dumpFloorEx } from "./market-sanity";

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
  dumpFloor: number;
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
  sales: TierSaleTable;
  /** Blank transition revenue pieces */
  blankOutcomes: TierSlice[];
  note?: string;
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
 */
export function modsToRareTier(modIds: string[]): RareTier {
  return classifyModCombo(modIds).rareTier;
}

/**
 * Default "sensible" policy: list S/A/B, chaos trash (until hit), list corrupt.
 * Reforge/Vaal are available for search, not default.
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
    corrupt: {
      S: "List",
      A: "List",
      B: "List",
      Trash: "Dump",
    },
  };
}

/** Policies we score to pick a recommendation. */
export function candidatePolicies(): CraftPolicy[] {
  const blanks: BlankCraftStrategy[] = [
    "Skip-Blanks",
    "Scour-Alch",
    "Magic-Pipeline",
  ];
  const trashActions: RareAction[] = ["Chaos", "Reforge", "List", "Vaal"];
  const out: CraftPolicy[] = [];
  for (const blank of blanks) {
    if (blank === "Skip-Blanks") {
      out.push(defaultPolicy(blank));
      continue;
    }
    for (const trash of trashActions) {
      out.push({
        blank,
        rare: { S: "List", A: "List", B: "List", Trash: trash },
        corrupt: { S: "List", A: "List", B: "List", Trash: "Dump" },
      });
      // Also: vaal mid/trash then list/dump corrupt (cannot reforge corrupt — PoE2 bench)
      if (trash === "Chaos") {
        out.push({
          blank,
          rare: { S: "List", A: "List", B: "Vaal", Trash: "Chaos" },
          corrupt: { S: "List", A: "List", B: "List", Trash: "Dump" },
        });
        out.push({
          blank,
          rare: { S: "List", A: "List", B: "List", Trash: "Vaal" },
          corrupt: { S: "List", A: "List", B: "List", Trash: "List" },
        });
        out.push({
          blank,
          rare: { S: "List", A: "List", B: "List", Trash: "Vaal" },
          corrupt: { S: "List", A: "List", B: "List", Trash: "Dump" },
        });
      }
    }
  }
  return out;
}

/**
 * Unordered distinct pairs drawn without replacement (weighted).
 * Used for rare 2-prefix / 2-suffix rolls.
 */
function weightedUnorderedPairs(
  pool: string[],
): Array<{ a: string; b: string; prob: number }> {
  const items = pool
    .map((id) => ({ id, w: TABLET_MOD_WEIGHTS[id]?.weight ?? 0 }))
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
) {
  const base = TABLET_BASES[baseId];
  if (!base) return;
  const prefPairs = weightedUnorderedPairs(base.allowedPrefixPool);
  const sufPairs = weightedUnorderedPairs(base.allowedSuffixPool);
  if (!prefPairs.length || !sufPairs.length) {
    // Degenerate tiny pools: fall back to 1p+1s
    const totalP = base.allowedPrefixPool.reduce(
      (s, id) => s + (TABLET_MOD_WEIGHTS[id]?.weight ?? 0),
      0,
    );
    const totalS = base.allowedSuffixPool.reduce(
      (s, id) => s + (TABLET_MOD_WEIGHTS[id]?.weight ?? 0),
      0,
    );
    if (totalP <= 0 || totalS <= 0) return;
    for (const pId of base.allowedPrefixPool) {
      const pw = TABLET_MOD_WEIGHTS[pId]?.weight ?? 0;
      if (pw <= 0) continue;
      for (const sId of base.allowedSuffixPool) {
        const sw = TABLET_MOD_WEIGHTS[sId]?.weight ?? 0;
        if (sw <= 0) continue;
        onTier(modsToRareTier([pId, sId]), (pw / totalP) * (sw / totalS));
      }
    }
    return;
  }
  for (const pp of prefPairs) {
    for (const sp of sufPairs) {
      onTier(
        modsToRareTier([pp.a, pp.b, sp.a, sp.b]),
        pp.prob * sp.prob,
      );
    }
  }
}

/**
 * Sync coverage + per-tier sale samples from 1p+1s combo keys (what trade sync
 * actually fetches). Coverage mass is probability-weighted over the 1p×1s grid.
 */
function accumulateMeasuredPairSales(
  baseId: string,
  market: MarketPriceCache,
  onMeasured: (tier: RareTier, prob: number, sale: number) => void,
): { globalMeasuredProb: number; globalProb: number } {
  const base = TABLET_BASES[baseId];
  let globalMeasuredProb = 0;
  let globalProb = 0;
  if (!base) return { globalMeasuredProb, globalProb };

  const totalP = base.allowedPrefixPool.reduce(
    (s, id) => s + (TABLET_MOD_WEIGHTS[id]?.weight ?? 0),
    0,
  );
  const totalS = base.allowedSuffixPool.reduce(
    (s, id) => s + (TABLET_MOD_WEIGHTS[id]?.weight ?? 0),
    0,
  );
  if (totalP <= 0 || totalS <= 0) return { globalMeasuredProb, globalProb };

  for (const pId of base.allowedPrefixPool) {
    const pw = TABLET_MOD_WEIGHTS[pId]?.weight ?? 0;
    if (pw <= 0) continue;
    const pProb = pw / totalP;
    for (const sId of base.allowedSuffixPool) {
      const sw = TABLET_MOD_WEIGHTS[sId]?.weight ?? 0;
      if (sw <= 0) continue;
      const prob = pProb * (sw / totalS);
      globalProb += prob;
      const tier = modsToRareTier([pId, sId]);
      const sale = measured(market.modValueMap[`${pId}+${sId}`]);
      if (Number.isFinite(sale)) {
        globalMeasuredProb += prob;
        onMeasured(tier, prob, sale);
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
  out.B = Number.isFinite(raw.B) ? raw.B : out.Trash;
  out.A = Number.isFinite(raw.A) ? raw.A : out.B;
  out.S = Number.isFinite(raw.S) ? raw.S : out.A;

  // Monotone underest: never let a worse tier outprice a better one
  if (Number.isFinite(out.S) && out.A > out.S) out.A = out.S;
  if (Number.isFinite(out.A) && out.B > out.A) out.B = out.A;
  if (Number.isFinite(out.B) && out.Trash > out.B) out.Trash = out.B;

  return out;
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
): TierSaleTable | null {
  const base = TABLET_BASES[baseId];
  if (!base) return null;

  const baseCost = measured(market.basePrices[baseId]);
  const dump = dumpFloorEx(market, baseId, baseCost);
  const c = market.currencyCosts;
  const alchOrbCost = measured(c.alchemy);
  const chaosCost = measured(c.chaos);
  const vaalCost = measured(c.vaal);
  const transmute = measured(c.transmute);
  const aug = measured(c.augmentation);
  const regal = measured(c.regal);

  const alchDist = emptyDist();
  accumulateRare2p2sDist(baseId, (tier, prob) => {
    alchDist[tier] += prob;
  });

  const measuredSales: Record<RareTier, number[]> = {
    S: [],
    A: [],
    B: [],
    Trash: [],
  };

  const { globalMeasuredProb, globalProb } = accumulateMeasuredPairSales(
    baseId,
    market,
    (tier, _prob, sale) => {
      measuredSales[tier].push(sale);
    },
  );

  const measuredFrac =
    globalProb > 0 ? Math.min(1, globalMeasuredProb / globalProb) : 0;

  const uncorrupted = priceTiersFromMeasured(measuredSales, dump);

  // Corrupt book unmeasured — haircut uncorrupted (same structure, still underest)
  const CORRUPT_MULT = 0.85;
  const corrupted = emptyDist() as Record<RareTier, number>;
  for (const t of RARE_TIERS) {
    corrupted[t] = Number.isFinite(uncorrupted[t])
      ? uncorrupted[t] * CORRUPT_MULT
      : Number.NaN;
  }

  // Magic-pipeline → rare tier dist (same labels as alch)
  const pool = [...base.allowedPrefixPool, ...base.allowedSuffixPool];
  const totalW = pool.reduce(
    (s, id) => s + (TABLET_MOD_WEIGHTS[id]?.weight ?? 0),
    0,
  );
  let magicDist = emptyDist();
  let magicOrbCost = Number.NaN;
  if (totalW > 0) {
    const wTier = (q: ModQualityTier) =>
      pool.reduce((s, id) => {
        if (modQualityTier(id) !== q) return s;
        return s + (TABLET_MOD_WEIGHTS[id]?.weight ?? 0);
      }, 0);
    const pS = wTier("S") / totalW;
    const pA = wTier("A") / totalW;
    const pMagicHasS = 1 - (1 - pS) ** 2;
    const pMagicHasAOnly = (1 - pMagicHasS) * (1 - (1 - pA) ** 2);
    const pMagicJunk = Math.max(0, 1 - pMagicHasS - pMagicHasAOnly);

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
        pMagicHasS * regalS[t] +
        pMagicHasAOnly * regalA[t] +
        pMagicJunk * alchDist[t];
    }
    const sum = RARE_TIERS.reduce((s, t) => s + magicDist[t], 0) || 1;
    for (const t of RARE_TIERS) magicDist[t] /= sum;

    magicOrbCost =
      (Number.isFinite(transmute) ? transmute : 0) +
      (Number.isFinite(aug) ? aug : 0) +
      (pMagicHasS + pMagicHasAOnly) *
        (Number.isFinite(regal) ? regal : 0) +
      pMagicJunk * (Number.isFinite(alchOrbCost) ? alchOrbCost : 0);
  } else {
    magicDist = { ...alchDist };
  }

  return {
    uncorrupted,
    corrupted,
    alchDist,
    magicDist,
    measuredFrac,
    magicOrbCost,
    alchOrbCost,
    chaosCost,
    vaalCost,
    baseCost,
    dumpFloor: dump,
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

  const dist = sales.alchDist; // chaos / reforge redraw

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
      // V = -chaos + Σ P_t V_R_t
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
        A[i][j] -= dist[t2] / 3;
      }
    }
  }

  for (const tier of RARE_TIERS) {
    const i = idx.get(`C:${tier}`)!;
    const action = policy.corrupt[tier];
    A[i][i] = 1;
    if (action === "List") b[i] = sales.corrupted[tier];
    else b[i] = Number.isFinite(sales.dumpFloor)
      ? Math.min(sales.corrupted[tier] || sales.dumpFloor, sales.dumpFloor)
      : sales.corrupted[tier];
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
): MdpSolveResult | null {
  const sales = buildTierSaleTable(market, baseId);
  if (!sales) return null;

  const { rareV, corruptV, note } = solveRareValues(sales, policy);

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
    sales,
    blankOutcomes,
    note,
  };
}

export function recommendPolicy(
  market: MarketPriceCache,
  baseId: string,
): MdpSolveResult | null {
  let best: MdpSolveResult | null = null;
  for (const policy of candidatePolicies()) {
    const hit = solvePolicy(market, baseId, policy);
    if (!hit) continue;
    if (!Number.isFinite(hit.whiteEV) && hit.policy.blank !== "Skip-Blanks")
      continue;
    if (!best) {
      best = hit;
      continue;
    }
    const bv = best.whiteEV;
    const cv = hit.whiteEV;
    // Prefer finite; among finite prefer higher EV; Skip (0) loses to any +EV craft
    if (!Number.isFinite(bv) && Number.isFinite(cv)) best = hit;
    else if (Number.isFinite(bv) && Number.isFinite(cv) && cv > bv) best = hit;
  }
  // Surface best craft even if negative (Skip still available as policy)
  if (!best) return solvePolicy(market, baseId, defaultPolicy("Skip-Blanks"));
  return best;
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
  opts?: { maxChaosPerItem?: number },
): {
  hits: number;
  hitRate: number;
  averageValue: number;
  netProfit: number;
  avgChaosRolls: number;
  truncated: number;
} {
  const sales = buildTierSaleTable(market, baseId);
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
            tier = pickTier(sales.alchDist);
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
        else
          sale = Number.isFinite(sales.dumpFloor)
            ? Math.min(sales.corrupted[tier], sales.dumpFloor)
            : sales.corrupted[tier];
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
