/**
 * Price acceptance: show whatever live data returns.
 * Only reject non-finite / non-positive — no hard market bands.
 */
export function isFinitePositive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/** Fraction of blank base cost used as dump floor when no junk trade sample. */
export const JUNK_DUMP_FRACTION = 0.2;

export type PriceSource =
  | "measured"
  | "manual-survey"
  | "fraction-of-base"
  | "cascaded";

export interface MarketPriceSource {
  junkSellByBase?: Record<string, PriceSource>;
  junkBuyByBase?: Record<string, PriceSource>;
  magicSellByBase?: Record<string, PriceSource>;
  magicBuyByBase?: Record<string, PriceSource>;
  modValueMap?: Record<string, PriceSource>;
}

export function isFallbackPriceSource(
  src: PriceSource | undefined,
): boolean {
  return (
    src === "manual-survey" ||
    src === "fraction-of-base" ||
    src === "cascaded"
  );
}

export function fallbackPriceTag(src: PriceSource | undefined): string {
  switch (src) {
    case "manual-survey":
      return "survey";
    case "fraction-of-base":
      return "20% blank";
    case "cascaded":
      return "cascaded";
    default:
      return "";
  }
}

export function fallbackPriceTitle(src: PriceSource | undefined): string {
  switch (src) {
    case "manual-survey":
      return "Hardcoded Temple trade survey — not a live listing sample";
    case "fraction-of-base":
      return "No junk sell sample — 20% of blank base cost";
    case "cascaded":
      return "Unmeasured tier inherited dump or the next-worse tier ask";
    default:
      return "";
  }
}

export function fallbackPriceClass(src: PriceSource | undefined): string {
  return isFallbackPriceSource(src)
    ? "text-fuchsia-300 bg-fuchsia-900/70 px-0.5 rounded ring-1 ring-fuchsia-500/60"
    : "";
}

type DumpMarket = {
  basePrices: Record<string, number>;
  junkSellByBase?: Record<string, number>;
  priceSource?: MarketPriceSource;
};

/**
 * Expected sale for an unmeasured (or junk) rare outcome, plus whether the
 * number is a live junk sample or a hardcoded/fraction fallback.
 */
export function dumpFloorInfo(
  market: DumpMarket,
  baseId: string,
  baseCost?: number,
): { value: number; source: PriceSource } {
  const junk = market.junkSellByBase?.[baseId];
  if (junk != null && Number.isFinite(junk) && junk > 0) {
    return {
      value: junk,
      source: market.priceSource?.junkSellByBase?.[baseId] ?? "measured",
    };
  }

  const cost =
    baseCost != null && Number.isFinite(baseCost)
      ? baseCost
      : market.basePrices[baseId];
  if (cost != null && Number.isFinite(cost) && cost > 0) {
    return {
      value: cost * JUNK_DUMP_FRACTION,
      source: "fraction-of-base",
    };
  }

  return { value: Number.NaN, source: "measured" };
}

/**
 * Expected sale for an unmeasured (or junk) rare outcome.
 * Prefer live junk sample; else ~20% of blank base; never invent premiums.
 */
export function dumpFloorEx(
  market: DumpMarket,
  baseId: string,
  baseCost?: number,
): number {
  return dumpFloorInfo(market, baseId, baseCost).value;
}
