import type { MarketPriceCache } from "./tablet-ev-calculator";
import { TABLET_BASES } from "./mod-weights";

const NAN = Number.NaN;

/**
 * Empty market: only known non-price facts are filled.
 * Everything else is NaN until live ninja/trade measurement lands.
 */
export function createEmptyMarketCache(): MarketPriceCache {
  const basePrices: Record<string, number> = {};
  for (const id of Object.keys(TABLET_BASES)) {
    basePrices[id] = NAN;
  }

  return {
    basePrices,
    currencyCosts: {
      exalted: 1, // unit of account (not a quoted seed price)
      chaos: NAN,
      alchemy: NAN,
      scouring: 0, // PoE2 tablet path does not spend scour orbs
      vaal: NAN,
      transmute: NAN,
      augmentation: NAN,
      regal: NAN,
    },
    modValueMap: {},
    modPremiums: {},
    junkSellByBase: {},
    listingAnchors: {
      tradeDivine: NAN,
      merchantHigh: NAN,
      merchantMid: NAN,
      merchantLow: NAN,
    },
    fx: undefined,
  };
}

/** @deprecated Use createEmptyMarketCache — no hard price seeds. */
export function createDefaultMarketCache(): MarketPriceCache {
  return createEmptyMarketCache();
}
