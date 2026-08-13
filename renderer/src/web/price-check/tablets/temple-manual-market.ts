import { TABLET_BASES, TABLET_MOD_WEIGHTS } from "./mod-weights";
import {
  buildModRollPriceCurve,
  type ModRollPriceCurve,
} from "./mod-roll-price-curve";
import type { MarketPriceCache } from "./tablet-ev-calculator";

/**
 * Manual Temple (Vaal) trade survey — SC, 2026-08-12.
 * Crystal is the only premium; support mods show no combo lift.
 *
 * Crystal asks measured at several rolls (not an invented midpoint):
 *   5%→775, 7%→950, 9%→1450, 10%→2100
 * EV uses E[p] under uniform discrete rolls on [5,10].
 *
 * Blank buy is NOT seeded — leave NaN until live trade sync (or explicit UI).
 */
export const TEMPLE_CRYSTAL_ROLL_ANCHORS = [
  { roll: 5, sellEx: 775 },
  { roll: 7, sellEx: 950 },
  { roll: 9, sellEx: 1450 },
  { roll: 10, sellEx: 2100 },
] as const;

export function templeCrystalRollCurve(): ModRollPriceCurve | null {
  const mod = TABLET_MOD_WEIGHTS.temple_crystal_t1;
  if (!mod) return null;
  return buildModRollPriceCurve({
    modId: mod.id,
    minValue: mod.minValue,
    maxValue: mod.maxValue,
    anchors: [...TEMPLE_CRYSTAL_ROLL_ANCHORS],
  });
}

export const TEMPLE_MANUAL_SURVEY = {
  baseId: "temple_tablet",
  /**
   * Historical survey note (~100ex) — not applied as a market seed.
   * Unknown blank buy stays NaN until live sync.
   */
  blankBuyEx: null as number | null,
  /** Measured junk / soft-trash ask */
  dumpEx: 60,
  /** Soft mid band (pack, rarity, eff, most fillers) */
  midBandEx: 80,
  crystalModId: "temple_crystal_t1",
} as const;

/**
 * Overlay Temple dump/combo sale samples onto a market cache.
 * Does not invent blank base cost — preserves measured basePrices or NaN.
 */
export function applyTempleManualSurveyMarket(
  market: MarketPriceCache,
): MarketPriceCache {
  const base = TABLET_BASES[TEMPLE_MANUAL_SURVEY.baseId];
  if (!base) return market;

  const { baseId, dumpEx, midBandEx, crystalModId } = TEMPLE_MANUAL_SURVEY;

  const crystalCurve = templeCrystalRollCurve();
  const crystalEx = crystalCurve?.expectedSellEx ?? Number.NaN;

  const modValueMap = { ...market.modValueMap };

  const idSet = new Set([
    ...base.allowedPrefixPool,
    ...base.allowedSuffixPool,
  ]);
  for (const key of Object.keys(modValueMap)) {
    const [p, s] = key.split("+");
    if (idSet.has(p) && idSet.has(s)) delete modValueMap[key];
  }

  // Crystal jackpot: EV uses E[p(roll)]; support mods add no lift
  if (Number.isFinite(crystalEx)) {
    for (const pId of base.allowedPrefixPool) {
      modValueMap[`${pId}+${crystalModId}`] = crystalEx;
    }
  }

  modValueMap[`map_pack_size_t2+map_rarity_t1`] = midBandEx;
  modValueMap[`map_pack_size_t2+temple_beacon_pack_t1`] = midBandEx;
  modValueMap[`map_pack_size_t2+temple_chest_rare_t1`] = midBandEx;
  modValueMap[`junk_monster_eff_t1+map_pack_size_t2`] = midBandEx;
  modValueMap[`junk_gold_t1+map_rarity_t1`] = midBandEx;
  modValueMap[`junk_xp_t1+junk_extra_shrine_t1`] = dumpEx;
  modValueMap[`junk_gold_t1+junk_extra_strongbox_t1`] = dumpEx;

  return {
    ...market,
    // Keep live/NaN blank buy — never force a survey default
    basePrices: { ...market.basePrices },
    junkSellByBase: {
      ...market.junkSellByBase,
      [baseId]: dumpEx,
    },
    modValueMap,
    // Leave listing anchors as measured (or NaN); don't invent bands
    listingAnchors: market.listingAnchors ?? {
      tradeDivine: Number.NaN,
      merchantHigh: Number.NaN,
      merchantMid: Number.NaN,
      merchantLow: Number.NaN,
    },
  };
}
