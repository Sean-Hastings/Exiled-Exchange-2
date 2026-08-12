/**
 * Price acceptance: show whatever live data returns.
 * Only reject non-finite / non-positive — no hard market bands.
 */
export function isFinitePositive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/** Fraction of blank base cost used as dump floor when no junk trade sample. */
export const JUNK_DUMP_FRACTION = 0.2;

type DumpMarket = {
  basePrices: Record<string, number>;
  junkSellByBase?: Record<string, number>;
};

/**
 * Expected sale for an unmeasured (or junk) rare outcome.
 * Prefer live junk sample; else ~20% of blank base; never invent premiums.
 */
export function dumpFloorEx(
  market: DumpMarket,
  baseId: string,
  baseCost?: number,
): number {
  const junk = market.junkSellByBase?.[baseId];
  if (junk != null && Number.isFinite(junk) && junk > 0) return junk;

  const cost =
    baseCost != null && Number.isFinite(baseCost)
      ? baseCost
      : market.basePrices[baseId];
  if (cost != null && Number.isFinite(cost) && cost > 0) {
    return cost * JUNK_DUMP_FRACTION;
  }

  return Number.NaN;
}
