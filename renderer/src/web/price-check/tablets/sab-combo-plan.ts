import { TABLET_BASES, TABLET_MOD_WEIGHTS } from "./mod-weights";
import {
  modComboToRareTier,
  modQualityTierForBase,
  type RareTier,
} from "./mod-tiers";
import { isTradeQueryableStatId } from "./tier-survey-plan";
import {
  buildModRollPriceCurve,
  modRollCurveKey,
  rollAtPercentile65,
  type RollPriceAnchor,
} from "./mod-roll-price-curve";
import type { TabletModDefinition } from "./tablet-types";
import type { ModQualityTier } from "./strat-types";
import type { MarketPriceCache } from "./tablet-ev-calculator";

/** S/A quality mods — Junk and B excluded from the sell worklist. */
const SAB_QUALITIES = new Set<ModQualityTier>(["S", "A"]);

/** RareTier bands deep sync measures as premium pair stamps. */
const DEEP_PREMIUM_RARE = new Set<RareTier>(["SS", "S", "A"]);

export type SabSyncKind = "solo" | "duo" | "triple" | "quad";

export interface SabTradeStat {
  id: string;
  min?: number;
  /** Exact roll when min===max (65th-percentile sample). */
  max?: number;
}

export interface SabSyncWorkItem {
  kind: SabSyncKind;
  /** Canonical mod ids (tradeStatId-collapsed). */
  modIds: string[];
  /** Debug key: `__solo__:id` or `id+id+…`. */
  comboKey: string;
  /** Deduped trade filters for the search body. */
  stats: SabTradeStat[];
  /** Exact 65th-percentile roll for solo queries. */
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

function exactRollStat(m: TabletModDefinition, roll?: number): SabTradeStat {
  const v = roll ?? rollAtPercentile65(m.minValue, m.maxValue);
  if (Number.isFinite(v)) return { id: m.tradeStatId, min: v, max: v };
  return { id: m.tradeStatId };
}

function qualityOf(modId: string, baseId?: string): ModQualityTier {
  return modQualityTierForBase(baseId, modId);
}

function isPremiumQuality(modId: string, baseId?: string): boolean {
  const q = qualityOf(modId, baseId);
  return q === "S" || q === "A";
}

/** SS/SA/AA only. Drop SB, AB, and BB. */
function duoPairAllowed(
  a: TabletModDefinition,
  b: TabletModDefinition,
  baseId?: string,
): boolean {
  return isPremiumQuality(a.id, baseId) && isPremiumQuality(b.id, baseId);
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
  const prongRoll =
    opts?.prongRoll ??
    (kind === "solo"
      ? rollAtPercentile65(mods[0]!.minValue, mods[0]!.maxValue)
      : undefined);
  const comboKey =
    kind === "solo" ? `__solo__:${mods[0]!.id}` : modIds.join("+");
  return {
    kind,
    modIds,
    comboKey,
    prongRoll,
    stats: collapsed.map((m) =>
      exactRollStat(m, kind === "solo" ? prongRoll : undefined),
    ),
  };
}

/**
 * M = quality S/A on this base (Junk and B excluded). Collapse shared tradeStatIds
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
 * Enumerate trade-legal SAB sells among M (Junk and B already excluded).
 *
 * Worklist:
 * - Solos with quality S or A (not B)
 * - Duos: both mods S or A (AA, SA, SS). Drop SB, AB, and BB.
 * - Affix-legal all-S 2p1s / 1p2s / 2p2s only (no mixed triples/quads)
 *
 * Every filter uses the 65th-percentile exact roll `{ min: v, max: v }`.
 * Affix cap ≤2p and ≤2s. Shared tradeStatIds already collapsed in M.
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

  const sMods = M.filter((m) => qualityOf(m.id, baseId) === "S");
  const premiumSolos = M.filter((m) => isPremiumQuality(m.id, baseId));

  for (const m of premiumSolos) push([m]);
  for (const pair of combinations(M, 2)) {
    if (duoPairAllowed(pair[0]!, pair[1]!, baseId)) push(pair);
  }
  for (const trip of combinations(sMods, 3)) push(trip);
  if (sMods.length <= 8) {
    for (const quad of combinations(sMods, 4)) push(quad);
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
 * Closed worklist: S/A solos, SS/SA/AA duos, all-S triples/quads.
 * No Junk, no SB/AB/BB. Affix cap ≤2p and ≤2s.
 */
export function buildSabSyncWorklist(
  baseId: string,
  safetyMax = 40,
): SabSyncWorkItem[] {
  return enumerateSabCombos(sabModsForBase(baseId), safetyMax, baseId);
}

function hasJunkMod(modIds: string[], baseId: string): boolean {
  return modIds.some((id) => qualityOf(id, baseId) === "Junk");
}

function allModsTradeQueryable(mods: TabletModDefinition[]): boolean {
  return mods.every((m) => isTradeQueryableStatId(m.tradeStatId));
}

function isDeepPremiumPair(modIds: string[], baseId: string): boolean {
  if (hasJunkMod(modIds, baseId)) return false;
  return DEEP_PREMIUM_RARE.has(modComboToRareTier(modIds, baseId));
}

/**
 * RareTier-aligned deep worklist: premium SS/S/A pairs (1p×1s + same-side
 * unordered 2p/2s), then single-p65 S/A solos for opposite-pool expand fill.
 * Pairs first so expand fills gaps after pair stamps.
 */
export function buildSabDeepSyncWorklist(baseId: string): SabSyncWorkItem[] {
  const base = TABLET_BASES[baseId];
  if (!base) return [];

  const seenSig = new Set<string>();
  const pairs: SabSyncWorkItem[] = [];
  const solos: SabSyncWorkItem[] = [];

  const push = (
    bucket: SabSyncWorkItem[],
    mods: TabletModDefinition[],
  ) => {
    if (!allModsTradeQueryable(mods)) return;
    const item = workItemFromMods(mods);
    if (!item) return;
    const sig = statsSignature(item.stats);
    if (seenSig.has(sig)) return;
    seenSig.add(sig);
    bucket.push(item);
  };

  const prefixes = base.allowedPrefixPool
    .map((id) => TABLET_MOD_WEIGHTS[id])
    .filter((m): m is TabletModDefinition => !!m);
  const suffixes = base.allowedSuffixPool
    .map((id) => TABLET_MOD_WEIGHTS[id])
    .filter((m): m is TabletModDefinition => !!m);

  // 1) Premium pairs (aligned with enumerateComboTierRows auto filter)
  for (const p of prefixes) {
    for (const s of suffixes) {
      if (!isDeepPremiumPair([p.id, s.id], baseId)) continue;
      push(pairs, [p, s]);
    }
  }
  for (let i = 0; i < suffixes.length; i++) {
    for (let j = i + 1; j < suffixes.length; j++) {
      const a = suffixes[i]!;
      const b = suffixes[j]!;
      if (!isDeepPremiumPair([a.id, b.id], baseId)) continue;
      push(pairs, [a, b]);
    }
  }
  for (let i = 0; i < prefixes.length; i++) {
    for (let j = i + 1; j < prefixes.length; j++) {
      const a = prefixes[i]!;
      const b = prefixes[j]!;
      if (!isDeepPremiumPair([a.id, b.id], baseId)) continue;
      push(pairs, [a, b]);
    }
  }

  // 2) S/A quality solos (single p65) for opposite-pool expand fill
  for (const m of sabModsForBase(baseId)) {
    push(solos, [m]);
  }

  // 3) Pairs/duos first, solos last (expand fills gaps after pair stamps)
  return [...pairs, ...solos];
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
  const stampIfEmpty = (key: string) => {
    const existing = market.modValueMap[key];
    // Pair stamps win — do not clobber finite positive measured entries.
    if (Number.isFinite(existing) && (existing as number) > 0) return;
    stampMeasuredCombo(market, key, price);
  };
  if (!mod.isPrefix) {
    for (const pId of base.allowedPrefixPool) {
      stampIfEmpty(`${pId}+${mod.id}`);
    }
  } else {
    for (const sId of base.allowedSuffixPool) {
      stampIfEmpty(`${mod.id}+${sId}`);
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

/** After deep solo-S prong searches: fit curves or flat-expand best prong. */
export function finalizeDeepSoloSCurves(
  market: MarketPriceCache,
  baseId: string,
  soloSAnchors: Map<string, RollPriceAnchor[]>,
) {
  for (const [modId, anchors] of soloSAnchors) {
    const mod = TABLET_MOD_WEIGHTS[modId];
    if (!mod) continue;
    const ok = finalizeSoloSCurve(market, baseId, mod, anchors);
    if (!ok) {
      const best = bestProngSellEx(anchors);
      if (Number.isFinite(best) && best > 0) {
        expandSoloSAOppositePool(market, baseId, mod, best);
      }
    }
  }
}

/**
 * Write a successful SAB search into cache:
 * - Solo S/A: expand the 65th-pct price across entire opposite pool (1p1s grid).
 * - Solo B: unused no-op (worklist only searches S/A combos).
 * - Cross-side duo: stampMeasuredCombo(p+s).
 * - Same-side duo: stampMeasuredCombo(sorted) + measuredAffixSamples.
 * - Triple / quad: measuredAffixSamples.
 */
export function applySabSyncHit(
  market: MarketPriceCache,
  baseId: string,
  item: SabSyncWorkItem,
  price: number,
  opts?: { soloSAnchors?: Map<string, RollPriceAnchor[]> },
) {
  if (!Number.isFinite(price) || price <= 0) return;

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
      if (q === "S" && opts?.soloSAnchors) {
        const roll =
          item.prongRoll ??
          item.stats[0]?.min ??
          rollAtPercentile65(m.minValue, m.maxValue);
        if (Number.isFinite(roll)) {
          let bucket = opts.soloSAnchors.get(m.id);
          if (!bucket) {
            bucket = [];
            opts.soloSAnchors.set(m.id, bucket);
          }
          bucket.push({ roll, sellEx: price });
        }
        return;
      }
      expandSoloSAOppositePool(market, baseId, m, price);
      return;
    }
    // Solo B — unused no-op (worklist drops B-only combos)
    return;
  }

  if (item.kind === "duo" && isCrossSideDuo(mods)) {
    const p = mods.find((x) => x.isPrefix)!;
    const s = mods.find((x) => !x.isPrefix)!;
    stampMeasuredCombo(market, `${p.id}+${s.id}`, price);
    return;
  }

  if (item.kind === "duo") {
    // Same-side: stamp canonical sorted key so tier-uncertainty / sell UI
    // see the price (samples alone never appear in modValueMap).
    stampMeasuredCombo(market, [...item.modIds].sort().join("+"), price);
    pushMeasuredAffixSample(market, baseId, item.modIds, price);
    return;
  }

  pushMeasuredAffixSample(market, baseId, item.modIds, price);
}
