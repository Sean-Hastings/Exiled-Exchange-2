import { TABLET_BASES, TABLET_MOD_WEIGHTS } from "./mod-weights";
import { modQualityTierForBase } from "./mod-tiers";
import { isTradeQueryableStatId } from "./tier-survey-plan";
import {
  buildModRollPriceCurve,
  modRollCurveKey,
  rollSampleProngs,
  type RollPriceAnchor,
} from "./mod-roll-price-curve";
import type { TabletModDefinition } from "./tablet-types";
import type { ModQualityTier } from "./strat-types";
import type { MarketPriceCache } from "./tablet-ev-calculator";

/** S/A/B quality mods — Junk excluded. B demotion / membership bench later. */
const SAB_QUALITIES = new Set<ModQualityTier>(["S", "A", "B"]);

export type SabSyncKind = "solo" | "duo" | "triple" | "quad";

export interface SabTradeStat {
  id: string;
  min?: number;
  /** Exact roll when min===max (solo S prong samples). */
  max?: number;
}

export interface SabSyncWorkItem {
  kind: SabSyncKind;
  /** Canonical mod ids (tradeStatId-collapsed). */
  modIds: string[];
  /** Debug key: `__solo__:id`, `__solo_prong__:id@roll`, or `id+id+…`. */
  comboKey: string;
  /** Deduped trade filters for the search body. */
  stats: SabTradeStat[];
  /** Exact roll for solo S multi-prong sampling. */
  prongRoll?: number;
}

/** Prefer higher minValue, then better (lower) tier number, then valueScore. */
export function preferModForSharedTradeStat(
  a: TabletModDefinition,
  b: TabletModDefinition,
): TabletModDefinition {
  const minA = Number.isFinite(a.minValue) ? a.minValue : 0;
  const minB = Number.isFinite(b.minValue) ? b.minValue : 0;
  if (minA !== minB) return minA > minB ? a : b;
  if (a.tier !== b.tier) return a.tier < b.tier ? a : b;
  return a.valueScore >= b.valueScore ? a : b;
}

function tradeMin(m: TabletModDefinition): number | undefined {
  if (Number.isFinite(m.minValue) && m.minValue > 0) return Math.ceil(m.minValue);
  return undefined;
}

function isRollableRange(m: TabletModDefinition): boolean {
  return (
    Number.isFinite(m.minValue) &&
    Number.isFinite(m.maxValue) &&
    m.maxValue > m.minValue
  );
}

/** Collapse mods that share a tradeStatId; drop unqueryable stats. */
export function collapseModsByTradeStat(
  mods: TabletModDefinition[],
): TabletModDefinition[] {
  const byStat = new Map<string, TabletModDefinition>();
  for (const m of mods) {
    if (!isTradeQueryableStatId(m.tradeStatId)) continue;
    const prev = byStat.get(m.tradeStatId);
    byStat.set(
      m.tradeStatId,
      prev ? preferModForSharedTradeStat(prev, m) : m,
    );
  }
  return [...byStat.values()];
}

function fitsAffixCaps(mods: TabletModDefinition[]): boolean {
  let p = 0;
  let s = 0;
  for (const m of mods) {
    if (m.isPrefix) p++;
    else s++;
  }
  return p <= 2 && s <= 2;
}

function statsSignature(stats: SabTradeStat[]): string {
  return stats
    .map((st) => {
      const lo = st.min ?? "";
      const hi = st.max != null ? `-${st.max}` : "";
      return `${st.id}@${lo}${hi}`;
    })
    .sort()
    .join("|");
}

export function soloProngComboKey(modId: string, roll: number): string {
  return `__solo_prong__:${modId}@${roll}`;
}

export function isSoloSProngItem(item: SabSyncWorkItem): boolean {
  return item.kind === "solo" && item.prongRoll != null;
}

function workItemFromMods(
  mods: TabletModDefinition[],
  opts?: { prongRoll?: number },
): SabSyncWorkItem | null {
  if (!mods.length || !fitsAffixCaps(mods)) return null;
  const collapsed = collapseModsByTradeStat(mods);
  // Shared tradeStatId inside one query cannot be expressed as distinct AND filters
  if (collapsed.length !== mods.length) return null;
  const kind: SabSyncKind =
    mods.length === 1
      ? "solo"
      : mods.length === 2
        ? "duo"
        : mods.length === 3
          ? "triple"
          : "quad";
  const modIds = mods.map((m) => m.id).sort();
  const prongRoll = opts?.prongRoll;
  const comboKey =
    kind === "solo"
      ? prongRoll != null
        ? soloProngComboKey(mods[0]!.id, prongRoll)
        : `__solo__:${mods[0]!.id}`
      : modIds.join("+");
  return {
    kind,
    modIds,
    comboKey,
    prongRoll,
    stats: collapsed.map((m) => {
      if (prongRoll != null) {
        return { id: m.tradeStatId, min: prongRoll, max: prongRoll };
      }
      const min = tradeMin(m);
      return min != null ? { id: m.tradeStatId, min } : { id: m.tradeStatId };
    }),
  };
}

/**
 * M = quality S/A/B on this base (Junk excluded). Collapse shared tradeStatIds
 * (e.g. pack_t1/t2) to the preferred representative before enumerating.
 */
export function sabModsForBase(baseId: string): TabletModDefinition[] {
  const base = TABLET_BASES[baseId];
  if (!base) return [];
  const ids = [...base.allowedPrefixPool, ...base.allowedSuffixPool];
  const raw: TabletModDefinition[] = [];
  for (const id of ids) {
    const m = TABLET_MOD_WEIGHTS[id];
    if (!m) continue;
    const q = modQualityTierForBase(baseId, m.id);
    if (!SAB_QUALITIES.has(q)) continue;
    raw.push(m);
  }
  return collapseModsByTradeStat(raw);
}

function combinations<T>(arr: T[], k: number): T[][] {
  if (k <= 0 || k > arr.length) return [];
  if (k === 1) return arr.map((x) => [x]);
  const out: T[][] = [];
  for (let i = 0; i <= arr.length - k; i++) {
    for (const rest of combinations(arr.slice(i + 1), k - 1)) {
      out.push([arr[i]!, ...rest]);
    }
  }
  return out;
}

/**
 * Enumerate trade-legal solos/duos/triples/(small) quads among M.
 * Solo S with a rollable range emits lo/mid/hi prongs (exact min=max).
 * Solo A/B stay flat at ceil(min). Duos+ unchanged (flat at mins).
 * No Junk. Affix cap ≤2p and ≤2s. Shared tradeStatIds already collapsed in M.
 *
 * SS note: no joint 2D roll curve — independent S solos use E[p] expand;
 * SS duos remain flat measured samples.
 */
export function enumerateSabCombos(
  M: TabletModDefinition[],
  safetyMax = 40,
  baseId?: string,
): SabSyncWorkItem[] {
  if (!M.length) return [];

  const seenSig = new Set<string>();
  const out: SabSyncWorkItem[] = [];
  const push = (mods: TabletModDefinition[], opts?: { prongRoll?: number }) => {
    const item = workItemFromMods(mods, opts);
    if (!item) return;
    const sig = statsSignature(item.stats);
    if (seenSig.has(sig)) return;
    seenSig.add(sig);
    out.push(item);
  };

  for (const m of M) {
    const q = baseId ? modQualityTierForBase(baseId, m.id) : undefined;
    if (q === "S" && isRollableRange(m)) {
      for (const v of rollSampleProngs(m.minValue, m.maxValue)) {
        push([m], { prongRoll: v });
      }
    } else {
      push([m]);
    }
  }
  for (const pair of combinations(M, 2)) push(pair);
  for (const trip of combinations(M, 3)) push(trip);
  if (M.length <= 8) {
    for (const quad of combinations(M, 4)) push(quad);
  }

  out.sort((a, b) => {
    if (a.modIds.length !== b.modIds.length) {
      return a.modIds.length - b.modIds.length;
    }
    return a.comboKey.localeCompare(b.comboKey);
  });

  return out.slice(0, Math.max(1, safetyMax));
}

/**
 * Closed worklist: all trade-legal solos/duos/triples/(small) quads among M.
 * No Junk. Affix cap ≤2p and ≤2s.
 */
export function buildSabSyncWorklist(
  baseId: string,
  safetyMax = 40,
): SabSyncWorkItem[] {
  return enumerateSabCombos(sabModsForBase(baseId), safetyMax, baseId);
}

function ensurePriceSource(market: MarketPriceCache) {
  if (!market.priceSource) market.priceSource = {};
  if (!market.priceSource.junkSellByBase) market.priceSource.junkSellByBase = {};
  if (!market.priceSource.modValueMap) market.priceSource.modValueMap = {};
}

export function stampMeasuredCombo(
  market: MarketPriceCache,
  key: string,
  price: number,
) {
  market.modValueMap[key] = price;
  ensurePriceSource(market);
  market.priceSource!.modValueMap![key] = "measured";
}

export function pushMeasuredAffixSample(
  market: MarketPriceCache,
  baseId: string,
  modIds: string[],
  sellEx: number,
) {
  if (!Number.isFinite(sellEx) || sellEx <= 0) return;
  const sorted = [...modIds].sort();
  market.measuredAffixSamples = market.measuredAffixSamples ?? [];
  // Refresh: replace same base+mod set
  market.measuredAffixSamples = market.measuredAffixSamples.filter(
    (s) =>
      !(
        s.baseId === baseId &&
        s.modIds.length === sorted.length &&
        s.modIds.every((id, i) => id === sorted[i])
      ),
  );
  market.measuredAffixSamples.push({
    baseId,
    modIds: sorted,
    sellEx,
  });
}

function isCrossSideDuo(mods: TabletModDefinition[]): boolean {
  if (mods.length !== 2) return false;
  return mods[0]!.isPrefix !== mods[1]!.isPrefix;
}

/** Expand solo S/A floor across the entire opposite affix pool (1p1s grid). */
export function expandSoloSAOppositePool(
  market: MarketPriceCache,
  baseId: string,
  mod: TabletModDefinition,
  price: number,
) {
  if (!Number.isFinite(price) || price <= 0) return;
  const base = TABLET_BASES[baseId];
  if (!base) return;
  if (!mod.isPrefix) {
    for (const pId of base.allowedPrefixPool) {
      stampMeasuredCombo(market, `${pId}+${mod.id}`, price);
    }
  } else {
    for (const sId of base.allowedSuffixPool) {
      stampMeasuredCombo(market, `${mod.id}+${sId}`, price);
    }
  }
}

/**
 * After all solo-S prongs for a mod finish: fit roll curve (≥2 anchors),
 * store on market.modRollCurves, expand opposite pool with expectedSellEx.
 * Returns true if a curve was stored and expand used E[p].
 * If &lt;2 anchors, caller should flat-expand the best single hit.
 */
export function finalizeSoloSCurve(
  market: MarketPriceCache,
  baseId: string,
  mod: TabletModDefinition,
  anchors: RollPriceAnchor[],
): boolean {
  const valid = anchors.filter(
    (a) =>
      Number.isFinite(a.roll) &&
      Number.isFinite(a.sellEx) &&
      a.sellEx > 0,
  );
  if (valid.length < 2) return false;
  const curve = buildModRollPriceCurve({
    modId: mod.id,
    minValue: mod.minValue,
    maxValue: mod.maxValue,
    anchors: valid,
  });
  if (!curve) return false;
  market.modRollCurves = market.modRollCurves ?? {};
  market.modRollCurves[modRollCurveKey(baseId, mod.id)] = curve;
  expandSoloSAOppositePool(market, baseId, mod, curve.expectedSellEx);
  return true;
}

/**
 * Best single measured prong sell — flat fallback when curve fit fails.
 */
export function bestProngSellEx(anchors: RollPriceAnchor[]): number {
  let best = Number.NaN;
  for (const a of anchors) {
    if (!(Number.isFinite(a.sellEx) && a.sellEx > 0)) continue;
    if (!Number.isFinite(best) || a.sellEx > best) best = a.sellEx;
  }
  return best;
}

/**
 * Write a successful SAB search into cache:
 * - Solo S/A: expand floor across entire opposite pool (1p1s grid).
 * - Solo B: measuredAffixSamples only (no junk×B pollution).
 * - Cross-side duo: stampMeasuredCombo(p+s).
 * - Same-side / triple / quad: measuredAffixSamples.
 * - Solo S prongs: no-op here — use finalizeSoloSCurve after all prongs.
 */
export function applySabSyncHit(
  market: MarketPriceCache,
  baseId: string,
  item: SabSyncWorkItem,
  price: number,
) {
  if (!Number.isFinite(price) || price <= 0) return;
  // Prongs are buffered and finalized once — do not stamp each onto the grid
  if (isSoloSProngItem(item)) return;

  const base = TABLET_BASES[baseId];
  if (!base) return;

  const mods = item.modIds
    .map((id) => TABLET_MOD_WEIGHTS[id])
    .filter((m): m is TabletModDefinition => !!m);
  if (!mods.length) return;

  if (item.kind === "solo") {
    const m = mods[0]!;
    const q = modQualityTierForBase(baseId, m.id);
    if (q === "S" || q === "A") {
      expandSoloSAOppositePool(market, baseId, m, price);
      return;
    }
    // Solo B — sample only
    pushMeasuredAffixSample(market, baseId, [m.id], price);
    return;
  }

  if (item.kind === "duo" && isCrossSideDuo(mods)) {
    const p = mods.find((x) => x.isPrefix)!;
    const s = mods.find((x) => !x.isPrefix)!;
    stampMeasuredCombo(market, `${p.id}+${s.id}`, price);
    return;
  }

  pushMeasuredAffixSample(market, baseId, item.modIds, price);
}
